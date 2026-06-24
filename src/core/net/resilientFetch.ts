/**
 * Resilient fetch wrapper (code-review P1): timeout + retry-with-jitter +
 * per-host circuit breaker. Every outbound adapter (Anthropic, HubSpot, HIBP)
 * funnels through this instead of calling `fetch` directly, so transient 429/5xx
 * and network blips don't fail a run, and a persistently-failing dependency is
 * shed fast rather than hammered.
 *
 * Pure-by-injection: the clock, sleep, jitter source, and fetch impl are all
 * injectable so the retry/backoff/breaker logic is deterministically testable.
 */

export class CircuitOpenError extends Error {
  constructor(host: string) {
    super(`circuit open for ${host}`);
  }
}

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now: () => number;
}

type BreakerState = { failures: number; openedAt: number | null };

/** Per-key (host) circuit breaker: closed → open (after N fails) → half-open. */
export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();
  constructor(private readonly opts: BreakerOptions) {}

  canRequest(key: string): boolean {
    const s = this.states.get(key);
    if (!s || s.openedAt === null) return true;
    // Open: allow a single trial once the cooldown has elapsed (half-open).
    return this.opts.now() - s.openedAt >= this.opts.cooldownMs;
  }

  onSuccess(key: string): void {
    this.states.set(key, { failures: 0, openedAt: null });
  }

  onFailure(key: string): void {
    const s = this.states.get(key) ?? { failures: 0, openedAt: null };
    const failures = s.failures + 1;
    const openedAt = failures >= this.opts.failureThreshold ? this.opts.now() : s.openedAt;
    this.states.set(key, { failures, openedAt });
  }
}

export interface ResilientOptions {
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Injectables (tests / customisation):
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  breaker?: CircuitBreaker;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Process-wide breaker so all calls to a host share trip state. */
export const defaultBreaker = new CircuitBreaker({
  failureThreshold: 5,
  cooldownMs: 30_000,
  now: () => Date.now(),
});

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function backoffMs(attempt: number, base: number, max: number, random: () => number): number {
  const exp = Math.min(max, base * 2 ** attempt);
  // Full jitter: random in [0, exp].
  return Math.floor(random() * exp);
}

export async function resilientFetch(
  url: string,
  init: RequestInit = {},
  opts: ResilientOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const base = opts.baseDelayMs ?? 200;
  const max = opts.maxDelayMs ?? 5_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const breaker = opts.breaker ?? defaultBreaker;
  const host = hostOf(url);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (!breaker.canRequest(host)) throw new CircuitOpenError(host);
    try {
      const res = await doFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
      if (isRetriableStatus(res.status) && attempt < retries) {
        breaker.onFailure(host);
        await sleep(backoffMs(attempt, base, max, random));
        continue;
      }
      // Non-retriable status (incl. 4xx) or final attempt: settle the breaker.
      if (res.ok) breaker.onSuccess(host);
      else breaker.onFailure(host);
      return res;
    } catch (err) {
      lastErr = err;
      breaker.onFailure(host);
      if (attempt >= retries) break;
      await sleep(backoffMs(attempt, base, max, random));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`request to ${host} failed`);
}
