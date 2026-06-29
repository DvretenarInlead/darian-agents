import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createConsole } from './plugin.js';
import type { ConsoleDeps } from './context.js';
import type { UsersRepo, SessionsRepo, UserRecord, SessionRecord } from './repos.js';
import { hashToken } from '../auth/session.js';
import type { PasswordHasher } from '../auth/password.js';

const future = () => new Date(Date.now() + 3_600_000);

class FakeUsers implements UsersRepo {
  failures: Array<{ id: string; attempts: number }> = [];
  constructor(private readonly user: UserRecord | null, private readonly roles: { name: string; permissions: string[] }[]) {}
  async findByEmail(email: string) { return this.user && this.user.email === email ? this.user : null; }
  async findById(id: string) { return this.user && this.user.id === id ? this.user : null; }
  async recordLoginFailure(id: string, attempts: number) { this.failures.push({ id, attempts }); }
  async recordLoginSuccess() {}
  async getRoles() { return this.roles; }
  async list() { return this.user ? [{ id: this.user.id, email: this.user.email, status: this.user.status, mfaEnabled: this.user.mfaEnabled }] : []; }
}

class FakeSessions implements SessionsRepo {
  rows: SessionRecord[] = [];
  add(s: SessionRecord) { this.rows.push(s); }
  async create(input: { userId: string; refreshHash: string; idleExpires: Date; absExpires: Date }) {
    const id = `s${this.rows.length + 1}`;
    this.rows.push({ id, userId: input.userId, idleExpires: input.idleExpires, absExpires: input.absExpires, revokedAt: null, sudoUntil: null });
    (this.rows[this.rows.length - 1] as SessionRecord & { hash: string }).hash = input.refreshHash;
    return id;
  }
  async findActiveByHash(hash: string, now: Date) {
    return this.rows.find((r) => (r as SessionRecord & { hash?: string }).hash === hash && !r.revokedAt && r.idleExpires > now && r.absExpires > now) ?? null;
  }
  async touch() {}
  async revoke(id: string) { const s = this.rows.find((r) => r.id === id); if (s) s.revokedAt = new Date(); }
  async grantSudo(id: string, until: Date) { const s = this.rows.find((r) => r.id === id); if (s) s.sudoUntil = until; }
  async listForUser() { return this.rows; }
  async revokeAllForUser() {}
}

const plainHasher: PasswordHasher = {
  async hash(p) { return p; },
  async verify(p, stored) { return p === stored; },
};

const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: 'u1', email: 'admin@x.com', passwordHash: 'pw-correct', status: 'active',
  failedAttempts: 0, lockedUntil: null, mfaSecretEnc: null, mfaEnabled: false, ...over,
});

function fakePool(opts: { escalationSubject?: string; sodConfiguredBy?: string } = {}): Pool {
  const auditClient = { query: async (sql: string) => (sql.includes('INSERT INTO audit_log') ? { rows: [{ id: '1' }], rowCount: 1 } : { rows: [], rowCount: 0 }), release: () => {} };
  return {
    connect: async () => auditClient,
    query: async (sql: string) => {
      if (sql.includes('count(*) n FROM escalation_queue')) return { rows: [{ n: '1' }], rowCount: 1 };
      if (sql.includes('FROM kill_switch')) return { rows: [{ engaged: false }], rowCount: 1 };
      if (sql.includes("FROM escalation_queue WHERE status='pending' ORDER")) return { rows: [{ id: 'e1', product: 'meeting', subject_id: opts.escalationSubject ?? 'subj-1', reason: 'r', created_at: new Date() }], rowCount: 1 };
      if (sql.includes('SELECT subject_id FROM escalation_queue WHERE id')) return { rows: [{ subject_id: opts.escalationSubject ?? 'subj-1' }], rowCount: 1 };
      if (sql.includes('FROM sod_action_log WHERE subject_id')) return { rows: opts.sodConfiguredBy ? [{ subject_id: opts.escalationSubject ?? 'subj-1', action: 'configured', actor_id: opts.sodConfiguredBy }] : [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
}

async function build(over: Partial<ConsoleDeps> & { users: UsersRepo; sessions: SessionsRepo; pool: Pool }): Promise<FastifyInstance> {
  const deps: ConsoleDeps = {
    hasher: plainHasher, now: () => new Date(), secureCookies: false,
    ttls: { idleSec: 1800, absoluteSec: 43200, sudoWindowSec: 300 }, ...over,
  } as ConsoleDeps;
  const app = Fastify();
  await app.register(createConsole(deps));
  await app.ready();
  return app;
}

/** Build an authenticated session cookie set; optionally with sudo active. */
function authed(sessions: FakeSessions, sudo = false): Record<string, string> {
  const token = 'tok-1';
  sessions.add({ id: 's-auth', userId: 'u1', idleExpires: future(), absExpires: future(), revokedAt: null, sudoUntil: sudo ? future() : null });
  (sessions.rows[sessions.rows.length - 1] as SessionRecord & { hash: string }).hash = hashToken(token);
  return { sid: token, csrf: 'csrf-1' };
}

describe('console auth', () => {
  it('redirects unauthenticated users to login', async () => {
    const app = await build({ users: new FakeUsers(user(), []), sessions: new FakeSessions(), pool: fakePool() });
    const res = await app.inject({ method: 'GET', url: '/console' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/console/login');
    await app.close();
  });

  it('renders the login form and sets a csrf cookie', async () => {
    const app = await build({ users: new FakeUsers(user(), []), sessions: new FakeSessions(), pool: fakePool() });
    const res = await app.inject({ method: 'GET', url: '/console/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Sign in');
    expect(String(res.headers['set-cookie'])).toContain('csrf=');
    await app.close();
  });

  it('rejects a wrong password generically and records a failure', async () => {
    const users = new FakeUsers(user(), []);
    const app = await build({ users, sessions: new FakeSessions(), pool: fakePool() });
    const res = await app.inject({ method: 'POST', url: '/console/login', headers: { cookie: 'csrf=c1' }, payload: { _csrf: 'c1', email: 'admin@x.com', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid email, password');
    expect(users.failures).toHaveLength(1);
    await app.close();
  });

  it('rejects an unknown user generically', async () => {
    const app = await build({ users: new FakeUsers(user(), []), sessions: new FakeSessions(), pool: fakePool() });
    const res = await app.inject({ method: 'POST', url: '/console/login', headers: { cookie: 'csrf=c1' }, payload: { _csrf: 'c1', email: 'nobody@x.com', password: 'x' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('logs in with the correct password and sets a session cookie', async () => {
    const sessions = new FakeSessions();
    const app = await build({ users: new FakeUsers(user(), []), sessions, pool: fakePool() });
    const res = await app.inject({ method: 'POST', url: '/console/login', headers: { cookie: 'csrf=c1' }, payload: { _csrf: 'c1', email: 'admin@x.com', password: 'pw-correct' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/console');
    expect(String(res.headers['set-cookie'])).toContain('sid=');
    expect(sessions.rows).toHaveLength(1);
    await app.close();
  });

  it('rejects a login POST with a bad CSRF token', async () => {
    const app = await build({ users: new FakeUsers(user(), []), sessions: new FakeSessions(), pool: fakePool() });
    const res = await app.inject({ method: 'POST', url: '/console/login', headers: { cookie: 'csrf=c1' }, payload: { _csrf: 'WRONG', email: 'admin@x.com', password: 'pw-correct' } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('console RBAC + sudo + SoD', () => {
  it('denies the escalations panel without escalation:approve', async () => {
    const sessions = new FakeSessions();
    const cookies = authed(sessions);
    const app = await build({ users: new FakeUsers(user(), [{ name: 'viewer', permissions: ['audit:read'] }]), sessions, pool: fakePool() });
    const res = await app.inject({ method: 'GET', url: '/console/escalations', headers: { cookie: `sid=${cookies.sid}` } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows the escalations panel for an approver', async () => {
    const sessions = new FakeSessions();
    const cookies = authed(sessions);
    const app = await build({ users: new FakeUsers(user(), [{ name: 'approver', permissions: ['escalation:approve'] }]), sessions, pool: fakePool() });
    const res = await app.inject({ method: 'GET', url: '/console/escalations', headers: { cookie: `sid=${cookies.sid}` } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Escalation queue');
    await app.close();
  });

  it('requires sudo to approve (redirects to re-auth)', async () => {
    const sessions = new FakeSessions();
    const cookies = authed(sessions, false); // no sudo
    const app = await build({ users: new FakeUsers(user(), [{ name: 'approver', permissions: ['escalation:approve'] }]), sessions, pool: fakePool() });
    const res = await app.inject({ method: 'POST', url: '/console/escalations/e1/approve', headers: { cookie: `sid=${cookies.sid}; csrf=c1` }, payload: { _csrf: 'c1' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/console/sudo');
    await app.close();
  });

  it('blocks self-approval via separation of duties', async () => {
    const sessions = new FakeSessions();
    const cookies = authed(sessions, true); // sudo active
    const app = await build({
      users: new FakeUsers(user(), [{ name: 'approver', permissions: ['escalation:approve'] }]),
      sessions,
      pool: fakePool({ escalationSubject: 'subj-1', sodConfiguredBy: 'u1' }), // u1 configured subj-1
    });
    const res = await app.inject({ method: 'POST', url: '/console/escalations/e1/approve', headers: { cookie: `sid=${cookies.sid}; csrf=c1` }, payload: { _csrf: 'c1' } });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('cannot self-approve');
    await app.close();
  });

  it('approves when a different actor configured the subject', async () => {
    const sessions = new FakeSessions();
    const cookies = authed(sessions, true);
    const app = await build({
      users: new FakeUsers(user(), [{ name: 'approver', permissions: ['escalation:approve'] }]),
      sessions,
      pool: fakePool({ escalationSubject: 'subj-1', sodConfiguredBy: 'someone-else' }),
    });
    const res = await app.inject({ method: 'POST', url: '/console/escalations/e1/approve', headers: { cookie: `sid=${cookies.sid}; csrf=c1` }, payload: { _csrf: 'c1' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/console/escalations');
    await app.close();
  });
});
