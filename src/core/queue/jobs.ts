import type { Pool } from 'pg';

/**
 * Durable job queue over Postgres (code-review P0). Web enqueues; workers claim
 * with FOR UPDATE SKIP LOCKED so the queue drains concurrently and safely.
 * The retry/backoff decision (`retryDelaySec`) is pure and tested; the claim SQL
 * is covered by the Postgres integration suite.
 */

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueInput {
  kind: string;
  payload: unknown;
  /** Idempotency key — a duplicate enqueue is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface EnqueueResult {
  enqueued: boolean;
  id: string | null;
}

export async function enqueueJob(pool: Pool, input: EnqueueInput): Promise<EnqueueResult> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO jobs (kind, payload, dedupe_key, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, 5))
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.kind, JSON.stringify(input.payload), input.dedupeKey ?? null, input.maxAttempts ?? null],
  );
  const row = res.rows[0];
  return { enqueued: Boolean(row), id: row?.id ?? null };
}

/**
 * Claim the next runnable job atomically. SKIP LOCKED lets concurrent workers
 * each grab a different job. Marks it running and increments attempts.
 */
export async function claimJob(pool: Pool): Promise<Job | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query<{
      id: string;
      kind: string;
      payload: unknown;
      attempts: number;
      max_attempts: number;
    }>(
      `SELECT id, kind, payload, attempts, max_attempts
         FROM jobs
        WHERE status = 'pending' AND run_after <= now()
        ORDER BY run_after
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const row = sel.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    await client.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
       WHERE id = $1`,
      [row.id],
    );
    await client.query('COMMIT');
    return {
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function completeJob(pool: Pool, id: string): Promise<void> {
  await pool.query(`UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`, [id]);
}

/** Full-jitter backoff in seconds for the next attempt. Pure. */
export function retryDelaySec(attempt: number, baseSec = 5, maxSec = 3600, random: () => number = Math.random): number {
  const exp = Math.min(maxSec, baseSec * 2 ** attempt);
  return Math.max(1, Math.floor(random() * exp));
}

/**
 * Mark a job failed. If attempts remain, re-queue with a backoff delay;
 * otherwise dead-letter it (status='failed').
 */
export async function failJob(pool: Pool, job: Job, error: string, delaySec: number): Promise<void> {
  const dead = job.attempts >= job.maxAttempts;
  await pool.query(
    `UPDATE jobs
        SET status = $2,
            last_error = $3,
            run_after = now() + ($4 || ' seconds')::interval,
            updated_at = now()
      WHERE id = $1`,
    [job.id, dead ? 'failed' : 'pending', error.slice(0, 2000), dead ? 0 : delaySec],
  );
}
