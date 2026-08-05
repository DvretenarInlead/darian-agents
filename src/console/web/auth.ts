import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../../core/audit/writer.js';
import { isLocked, registerFailure, dummyVerify, type LockState, type LockoutPolicy } from '../auth/lockout.js';
import { verifyTotp } from '../auth/totp.js';
import { decrypt } from '../../core/crypto/envelope.js';
import { layout, csrfField, esc } from './views.js';
import { resolveUser, startSession, ensureCsrf, csrfOk, clearSessionCookie, type ConsoleDeps } from './context.js';

const LOCKOUT: LockoutPolicy = { threshold: 5, lockoutSec: 900 };
const GENERIC = 'Invalid email, password, or authentication code.';

function loginPage(csrf: string, error?: string): string {
  return layout({
    title: 'Sign in',
    ...(error ? { flash: { kind: 'err' as const, msg: error } } : {}),
    body: `<div class="card"><h1>Sign in</h1>
      <form method="post" action="/console/login">${csrfField(csrf)}
        <label>Email</label><input name="email" type="email" autocomplete="username" required>
        <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
        <label>Authenticator code <span class="muted">(if enabled)</span></label><input name="totp" inputmode="numeric" autocomplete="one-time-code">
        <p><button type="submit">Sign in</button></p>
      </form></div>`,
  });
}

function lockStateOf(u: { failedAttempts: number; lockedUntil: Date | null }): LockState {
  return { failedAttempts: u.failedAttempts, lockedUntil: u.lockedUntil ? Math.floor(u.lockedUntil.getTime() / 1000) : null };
}

export function registerAuthRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  app.get('/console/login', async (req, reply) => {
    if (await resolveUser(req, deps)) return reply.redirect('/console');
    const csrf = ensureCsrf(req, reply, deps);
    return reply.type('text/html').send(loginPage(csrf));
  });

  app.post('/console/login', async (req, reply) => {
    const csrf = ensureCsrf(req, reply, deps);
    if (!csrfOk(req)) return reply.code(403).type('text/html').send(loginPage(csrf, 'Invalid form token, please retry.'));

    const { email, password, totp } = (req.body ?? {}) as { email?: string; password?: string; totp?: string };
    const nowSec = Math.floor(deps.now().getTime() / 1000);
    const fail = () => reply.code(401).type('text/html').send(loginPage(csrf, GENERIC));

    const user = email ? await deps.users.findByEmail(email) : null;
    if (!user) {
      dummyVerify(); // equalise timing vs a real verify for unknown accounts
      return fail();
    }

    const state = lockStateOf(user);
    if (isLocked(state, nowSec)) return fail(); // generic message — no lockout disclosure

    const passwordOk = await deps.hasher.verify(password ?? '', user.passwordHash);
    let mfaOk = true;
    if (passwordOk && user.mfaEnabled) {
      const secret = user.mfaSecretEnc && deps.keyring ? decrypt(user.mfaSecretEnc, deps.keyring).toString('utf8') : '';
      mfaOk = Boolean(secret) && verifyTotp(totp ?? '', secret, nowSec);
    }

    if (!passwordOk || !mfaOk) {
      const next = registerFailure(state, nowSec, LOCKOUT);
      await deps.users.recordLoginFailure(user.id, next.failedAttempts, next.lockedUntil ? new Date(next.lockedUntil * 1000) : null);
      await appendAudit(deps.pool, { eventType: 'auth_event', product: 'console', actorId: user.id, subjectId: user.id, payload: { event: 'login_failed' } }, deps.now().toISOString());
      return fail();
    }

    await deps.users.recordLoginSuccess(user.id);
    await startSession(reply, user.id, deps);
    await appendAudit(deps.pool, { eventType: 'auth_event', product: 'console', actorId: user.id, subjectId: user.id, payload: { event: 'login_ok' } }, deps.now().toISOString());
    return reply.redirect('/console');
  });

  app.get('/console/logout', async (req, reply) => {
    const user = await resolveUser(req, deps);
    if (user) {
      await deps.sessions.revoke(user.sessionId);
      await appendAudit(deps.pool, { eventType: 'auth_event', product: 'console', actorId: user.id, subjectId: user.id, payload: { event: 'logout' } }, deps.now().toISOString());
    }
    clearSessionCookie(reply, deps);
    return reply.redirect('/console/login');
  });

  // Sudo re-authentication for high-impact actions.
  app.get('/console/sudo', async (req, reply) => {
    const user = await resolveUser(req, deps);
    if (!user) return reply.redirect('/console/login');
    const csrf = ensureCsrf(req, reply, deps);
    const ret = esc((req.query as { return?: string }).return ?? '/console');
    return reply.type('text/html').send(
      layout({
        title: 'Confirm identity',
        user,
        body: `<div class="card"><h1>Confirm your identity</h1><p class="muted">This action requires re-authentication.</p>
          <form method="post" action="/console/sudo">${csrfField(csrf)}
            <input type="hidden" name="return" value="${ret}">
            <label>Password</label><input name="password" type="password" required>
            <label>Authenticator code <span class="muted">(if enabled)</span></label><input name="totp" inputmode="numeric">
            <p><button type="submit">Confirm</button></p>
          </form></div>`,
      }),
    );
  });

  app.post('/console/sudo', async (req, reply) => {
    const user = await resolveUser(req, deps);
    if (!user) return reply.redirect('/console/login');
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    const { password, totp, return: ret } = (req.body ?? {}) as { password?: string; totp?: string; return?: string };
    const record = await deps.users.findById(user.id);
    const nowSec = Math.floor(deps.now().getTime() / 1000);
    let ok = record ? await deps.hasher.verify(password ?? '', record.passwordHash) : false;
    if (ok && record?.mfaEnabled) {
      const secret = record.mfaSecretEnc && deps.keyring ? decrypt(record.mfaSecretEnc, deps.keyring).toString('utf8') : '';
      ok = Boolean(secret) && verifyTotp(totp ?? '', secret, nowSec);
    }
    if (!ok) return reply.redirect('/console/sudo?return=' + encodeURIComponent(ret ?? '/console'));
    await deps.sessions.grantSudo(user.sessionId, new Date(deps.now().getTime() + deps.ttls.sudoWindowSec * 1000));
    return reply.redirect(ret && ret.startsWith('/console') ? ret : '/console');
  });
}
