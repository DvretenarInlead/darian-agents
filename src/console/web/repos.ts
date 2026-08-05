import type { Pool } from 'pg';
import type { Role } from '../rbac/permissions.js';

/**
 * Console data access behind interfaces so route handlers are testable with
 * in-memory fakes (no DB). PG implementations back them in production.
 */

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  status: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  mfaSecretEnc: Buffer | null;
  mfaEnabled: boolean;
}

export interface UsersRepo {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  recordLoginFailure(id: string, failedAttempts: number, lockedUntil: Date | null): Promise<void>;
  recordLoginSuccess(id: string): Promise<void>;
  getRoles(userId: string): Promise<Role[]>;
  list(): Promise<Array<{ id: string; email: string; status: string; mfaEnabled: boolean }>>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  idleExpires: Date;
  absExpires: Date;
  revokedAt: Date | null;
  sudoUntil: Date | null;
}

export interface SessionsRepo {
  create(input: { userId: string; refreshHash: string; idleExpires: Date; absExpires: Date }): Promise<string>;
  findActiveByHash(refreshHash: string, now: Date): Promise<SessionRecord | null>;
  touch(id: string, idleExpires: Date): Promise<void>;
  revoke(id: string): Promise<void>;
  grantSudo(id: string, sudoUntil: Date): Promise<void>;
  listForUser(userId: string): Promise<SessionRecord[]>;
  revokeAllForUser(userId: string): Promise<void>;
}

export class PgUsersRepo implements UsersRepo {
  constructor(private readonly pool: Pool) {}

  private map(r: Record<string, unknown>): UserRecord {
    return {
      id: r.id as string,
      email: r.email as string,
      passwordHash: r.password_hash as string,
      status: r.status as string,
      failedAttempts: r.failed_attempts as number,
      lockedUntil: (r.locked_until as Date | null) ?? null,
      mfaSecretEnc: (r.mfa_secret_enc as Buffer | null) ?? null,
      mfaEnabled: r.mfa_enabled as boolean,
    };
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? this.map(rows[0]) : null;
  }
  async findById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? this.map(rows[0]) : null;
  }
  async recordLoginFailure(id: string, failedAttempts: number, lockedUntil: Date | null): Promise<void> {
    await this.pool.query('UPDATE users SET failed_attempts = $2, locked_until = $3, updated_at = now() WHERE id = $1', [id, failedAttempts, lockedUntil]);
  }
  async recordLoginSuccess(id: string): Promise<void> {
    await this.pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [id]);
  }
  async getRoles(userId: string): Promise<Role[]> {
    const { rows } = await this.pool.query<{ name: string; permissions: string[] }>(
      `SELECT r.name, r.permissions FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
      [userId],
    );
    return rows.map((r) => ({ name: r.name, permissions: r.permissions ?? [] }));
  }
  async list(): Promise<Array<{ id: string; email: string; status: string; mfaEnabled: boolean }>> {
    const { rows } = await this.pool.query('SELECT id, email, status, mfa_enabled FROM users ORDER BY email');
    return rows.map((r) => ({ id: r.id, email: r.email, status: r.status, mfaEnabled: r.mfa_enabled }));
  }
}

export class PgSessionsRepo implements SessionsRepo {
  constructor(private readonly pool: Pool) {}

  private map(r: Record<string, unknown>): SessionRecord {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      idleExpires: r.idle_expires as Date,
      absExpires: r.abs_expires as Date,
      revokedAt: (r.revoked_at as Date | null) ?? null,
      sudoUntil: (r.sudo_until as Date | null) ?? null,
    };
  }

  async create(input: { userId: string; refreshHash: string; idleExpires: Date; absExpires: Date }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO sessions (user_id, refresh_hash, idle_expires, abs_expires) VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.userId, input.refreshHash, input.idleExpires, input.absExpires],
    );
    return rows[0]!.id;
  }
  async findActiveByHash(refreshHash: string, now: Date): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM sessions WHERE refresh_hash = $1 AND revoked_at IS NULL AND idle_expires > $2 AND abs_expires > $2`,
      [refreshHash, now],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }
  async touch(id: string, idleExpires: Date): Promise<void> {
    await this.pool.query('UPDATE sessions SET idle_expires = $2 WHERE id = $1', [id, idleExpires]);
  }
  async revoke(id: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [id]);
  }
  async grantSudo(id: string, sudoUntil: Date): Promise<void> {
    await this.pool.query('UPDATE sessions SET sudo_until = $2 WHERE id = $1', [id, sudoUntil]);
  }
  async listForUser(userId: string): Promise<SessionRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE user_id = $1 ORDER BY issued_at DESC', [userId]);
    return rows.map((r) => this.map(r));
  }
  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }
}
