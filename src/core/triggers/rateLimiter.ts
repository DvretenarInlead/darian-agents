/**
 * Fixed-window rate limiter (brief §1, build-order step 4).
 *
 * In-memory, clock-injected so it is deterministic and unit-testable. The
 * webhook receiver throttles by IP **and** account (two independent keys); a
 * request is rejected if either key is over budget. For a single web instance
 * this is sufficient; a multi-instance deploy would back this with a shared
 * store (e.g. Postgres/Redis) — the interface stays the same.
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
}

/**
 * Limiter abstraction the webhook receiver depends on. `consume` charges all the
 * given keys (e.g. ip + source) and denies if ANY is over budget. In-memory and
 * Postgres-backed implementations both satisfy it; the receiver doesn't care.
 */
export interface RateLimiter {
  consume(keys: string[], nowMs: number): Promise<RateLimitVerdict>;
}

/** In-memory limiter (single instance). Wraps FixedWindowRateLimiter. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly impl: FixedWindowRateLimiter;
  constructor(opts: RateLimitOptions) {
    this.impl = new FixedWindowRateLimiter(opts);
  }
  async consume(keys: string[], nowMs: number): Promise<RateLimitVerdict> {
    return checkAll(this.impl, keys, nowMs);
  }
}

interface Bucket {
  count: number;
  resetAtMs: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly opts: RateLimitOptions) {}

  check(key: string, nowMs: number): RateLimitVerdict {
    const existing = this.buckets.get(key);
    if (!existing || nowMs >= existing.resetAtMs) {
      const resetAtMs = nowMs + this.opts.windowMs;
      this.buckets.set(key, { count: 1, resetAtMs });
      return { allowed: true, remaining: this.opts.max - 1, resetAtMs };
    }
    if (existing.count >= this.opts.max) {
      return { allowed: false, remaining: 0, resetAtMs: existing.resetAtMs };
    }
    existing.count += 1;
    return { allowed: true, remaining: this.opts.max - existing.count, resetAtMs: existing.resetAtMs };
  }

  /** Drop expired buckets so the map doesn't grow unbounded. */
  sweep(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.resetAtMs) this.buckets.delete(key);
    }
  }
}

/** Throttle by several keys at once; denied if any key is over budget. */
export function checkAll(
  limiter: FixedWindowRateLimiter,
  keys: string[],
  nowMs: number,
): RateLimitVerdict {
  let worst: RateLimitVerdict = { allowed: true, remaining: Infinity, resetAtMs: nowMs };
  for (const key of keys) {
    const verdict = limiter.check(key, nowMs);
    if (!verdict.allowed) return verdict;
    if (verdict.remaining < worst.remaining) worst = verdict;
  }
  return worst;
}
