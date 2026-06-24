import type { Pool } from 'pg';
import type { RateLimiter, RateLimitOptions, RateLimitVerdict } from './rateLimiter.js';

/**
 * Postgres-backed fixed-window rate limiter (code-review P1) — shared across all
 * web instances. Each key is bucketed by window; an atomic upsert increments the
 * counter (resetting when the window rolls over) and returns the new count.
 * Denies if any key is over budget. The SQL is covered by the integration suite.
 *
 * Trade-off: one upsert per key per request. Fine at moderate volume; for very
 * high QPS put Redis behind the same RateLimiter interface.
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly opts: RateLimitOptions,
  ) {}

  async consume(keys: string[], nowMs: number): Promise<RateLimitVerdict> {
    const windowStart = Math.floor(nowMs / this.opts.windowMs) * this.opts.windowMs;
    const resetAtMs = windowStart + this.opts.windowMs;
    let minRemaining = Infinity;

    for (const key of keys) {
      const { rows } = await this.pool.query<{ count: number }>(
        `INSERT INTO rate_limits (key, window_start, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.window_start = EXCLUDED.window_start
                        THEN rate_limits.count + 1 ELSE 1 END,
           window_start = EXCLUDED.window_start
         RETURNING count`,
        [key, windowStart],
      );
      const count = rows[0]?.count ?? 1;
      if (count > this.opts.max) {
        return { allowed: false, remaining: 0, resetAtMs };
      }
      minRemaining = Math.min(minRemaining, this.opts.max - count);
    }
    return { allowed: true, remaining: minRemaining === Infinity ? this.opts.max : minRemaining, resetAtMs };
  }
}
