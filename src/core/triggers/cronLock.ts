import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Idempotent cron execution via Postgres advisory locks (brief: "idempotent/
 * locking scheduler").
 *
 * Multiple worker instances may each have the same cron schedule. withCronLock
 * ensures only one instance runs a given job at a time: it takes a session-level
 * try-lock keyed by a stable hash of the job key, runs the body if acquired, and
 * always releases. If the lock is already held, the body is skipped (ran=false)
 * — no double-fire, no blocking.
 */

/** Map an arbitrary job key to a stable signed 64-bit-safe lock id. */
export function lockIdForKey(jobKey: string): number {
  const digest = createHash('sha256').update(jobKey).digest();
  // Use 6 bytes (48 bits) to stay well within JS safe-integer range.
  const value =
    digest[0]! * 2 ** 40 +
    digest[1]! * 2 ** 32 +
    digest[2]! * 2 ** 24 +
    digest[3]! * 2 ** 16 +
    digest[4]! * 2 ** 8 +
    digest[5]!;
  return value;
}

export interface CronRunResult<T> {
  ran: boolean;
  result?: T;
}

export async function withCronLock<T>(
  pool: Pool,
  jobKey: string,
  fn: () => Promise<T>,
): Promise<CronRunResult<T>> {
  const lockId = lockIdForKey(jobKey);
  const client = await pool.connect();
  try {
    const got = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
    if (!got.rows[0]?.locked) return { ran: false };
    try {
      const result = await fn();
      return { ran: true, result };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
