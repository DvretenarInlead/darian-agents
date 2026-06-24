import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session lifecycle (build-order step 7). Pure, clock-injected (unix seconds).
 *
 * Enforces idle + absolute timeouts and server-side revocation. Access tokens
 * are short-lived; the refresh token is stored only as a hash (refresh_hash) so
 * a DB read cannot reconstruct a live token. Privilege changes rotate the
 * session id (handled by the caller persisting a new row). Sudo is a short
 * re-auth window required before high-impact actions.
 */

export interface SessionTimes {
  issuedAt: number;
  idleExpires: number;
  absExpires: number;
  revokedAt: number | null;
  sudoUntil: number | null;
}

export interface SessionTtls {
  idleSec: number;
  absoluteSec: number;
}

export function createSession(nowSec: number, ttls: SessionTtls): SessionTimes {
  return {
    issuedAt: nowSec,
    idleExpires: nowSec + ttls.idleSec,
    absExpires: nowSec + ttls.absoluteSec,
    revokedAt: null,
    sudoUntil: null,
  };
}

export function isActive(s: SessionTimes, nowSec: number): boolean {
  if (s.revokedAt !== null && nowSec >= s.revokedAt) return false;
  return nowSec < s.idleExpires && nowSec < s.absExpires;
}

/** Slide the idle window forward on activity, never past the absolute expiry. */
export function touch(s: SessionTimes, nowSec: number, idleSec: number): SessionTimes {
  return { ...s, idleExpires: Math.min(nowSec + idleSec, s.absExpires) };
}

export function revoke(s: SessionTimes, nowSec: number): SessionTimes {
  return { ...s, revokedAt: nowSec };
}

export function grantSudo(s: SessionTimes, nowSec: number, windowSec: number): SessionTimes {
  return { ...s, sudoUntil: nowSec + windowSec };
}

export function isSudoActive(s: SessionTimes, nowSec: number): boolean {
  return isActive(s, nowSec) && s.sudoUntil !== null && nowSec < s.sudoUntil;
}

/** Opaque session/refresh token (URL-safe). Stored only as a hash. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time check of a presented token against a stored hash. */
export function verifyToken(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
