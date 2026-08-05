import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { PasswordHasher } from '../auth/password.js';
import { generateSessionToken, hashToken } from '../auth/session.js';
import { generateCsrfToken, verifyCsrf } from '../auth/csrf.js';
import type { Keyring } from '../../core/crypto/envelope.js';
import type { UsersRepo, SessionsRepo } from './repos.js';

/** Everything the console routes depend on; injectable for tests. */
export interface ConsoleDeps {
  pool: Pool;
  users: UsersRepo;
  sessions: SessionsRepo;
  hasher: PasswordHasher;
  keyring?: Keyring; // to decrypt MFA seeds
  now: () => Date;
  secureCookies: boolean;
  ttls: { idleSec: number; absoluteSec: number; sudoWindowSec: number };
}

export interface CurrentUser {
  id: string;
  email: string;
  permissions: string[];
  sessionId: string;
  sudoActive: boolean;
}

const SID = 'sid';
const CSRF = 'csrf';

export function can(user: CurrentUser, permission: string): boolean {
  return user.permissions.includes('*') || user.permissions.includes(permission);
}

export function setSessionCookie(reply: FastifyReply, token: string, deps: ConsoleDeps): void {
  reply.setCookie(SID, token, {
    httpOnly: true,
    secure: deps.secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: deps.ttls.absoluteSec,
  });
}

export function clearSessionCookie(reply: FastifyReply, deps: ConsoleDeps): void {
  reply.clearCookie(SID, { path: '/', secure: deps.secureCookies, httpOnly: true, sameSite: 'lax' });
}

/** Issue a session token + DB row and set the cookie. */
export async function startSession(reply: FastifyReply, userId: string, deps: ConsoleDeps): Promise<void> {
  const token = generateSessionToken();
  const now = deps.now();
  await deps.sessions.create({
    userId,
    refreshHash: hashToken(token),
    idleExpires: new Date(now.getTime() + deps.ttls.idleSec * 1000),
    absExpires: new Date(now.getTime() + deps.ttls.absoluteSec * 1000),
  });
  setSessionCookie(reply, token, deps);
}

/** Resolve the current user from the session cookie, sliding the idle window. */
export async function resolveUser(req: FastifyRequest, deps: ConsoleDeps): Promise<CurrentUser | null> {
  const token = req.cookies?.[SID];
  if (!token) return null;
  const now = deps.now();
  const session = await deps.sessions.findActiveByHash(hashToken(token), now);
  if (!session) return null;
  const user = await deps.users.findById(session.userId);
  if (!user || user.status !== 'active') return null;
  const roles = await deps.users.getRoles(user.id);
  // Slide idle window forward, capped at the absolute expiry.
  const slid = new Date(Math.min(now.getTime() + deps.ttls.idleSec * 1000, session.absExpires.getTime()));
  await deps.sessions.touch(session.id, slid);
  return {
    id: user.id,
    email: user.email,
    permissions: roles.flatMap((r) => r.permissions),
    sessionId: session.id,
    sudoActive: session.sudoUntil !== null && session.sudoUntil.getTime() > now.getTime(),
  };
}

/** Ensure a CSRF cookie exists; return its token for embedding in forms. */
export function ensureCsrf(req: FastifyRequest, reply: FastifyReply, deps: ConsoleDeps): string {
  let token = req.cookies?.[CSRF];
  if (!token) {
    token = generateCsrfToken();
    reply.setCookie(CSRF, token, { httpOnly: true, secure: deps.secureCookies, sameSite: 'lax', path: '/' });
  }
  return token;
}

/** Validate the submitted CSRF token against the cookie (double-submit). */
export function csrfOk(req: FastifyRequest): boolean {
  const cookie = req.cookies?.[CSRF];
  const submitted = (req.body as { _csrf?: string } | undefined)?._csrf;
  return verifyCsrf(cookie, submitted);
}
