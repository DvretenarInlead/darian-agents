import { describe, it, expect } from 'vitest';
import { resilientFetch, CircuitBreaker, CircuitOpenError } from './resilientFetch.js';

const ok = () => new Response('ok', { status: 200 });
const err500 = () => new Response('err', { status: 500 });
const bad400 = () => new Response('bad', { status: 400 });

/** A fetch impl that yields the given responses/throws in sequence. */
function seqFetch(steps: Array<() => Response | never>) {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i++;
    return step();
  };
}

const noSleep = async () => {};
const zeroJitter = () => 0;

describe('resilientFetch', () => {
  it('returns immediately on success', async () => {
    let calls = 0;
    const res = await resilientFetch('https://x.test/a', {}, {
      fetchImpl: async () => {
        calls++;
        return ok();
      },
      sleep: noSleep,
      random: zeroJitter,
      breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1, now: () => 0 }),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('retries on 500 then succeeds', async () => {
    const res = await resilientFetch('https://x.test/a', {}, {
      fetchImpl: seqFetch([err500, err500, ok]),
      sleep: noSleep,
      random: zeroJitter,
      breaker: new CircuitBreaker({ failureThreshold: 99, cooldownMs: 1, now: () => 0 }),
    });
    expect(res.status).toBe(200);
  });

  it('does not retry a 4xx', async () => {
    let calls = 0;
    const res = await resilientFetch('https://x.test/a', {}, {
      fetchImpl: async () => {
        calls++;
        return bad400();
      },
      sleep: noSleep,
      random: zeroJitter,
      breaker: new CircuitBreaker({ failureThreshold: 99, cooldownMs: 1, now: () => 0 }),
    });
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('retries on thrown network errors and eventually throws', async () => {
    let calls = 0;
    await expect(
      resilientFetch('https://x.test/a', {}, {
        retries: 2,
        fetchImpl: async () => {
          calls++;
          throw new Error('ECONNRESET');
        },
        sleep: noSleep,
        random: zeroJitter,
        breaker: new CircuitBreaker({ failureThreshold: 99, cooldownMs: 1, now: () => 0 }),
      }),
    ).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('opens the circuit after the failure threshold and sheds fast', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    const opts = { retries: 0, fetchImpl: async () => err500(), sleep: noSleep, random: zeroJitter, breaker };
    await resilientFetch('https://y.test/a', {}, opts); // failure 1
    await resilientFetch('https://y.test/a', {}, opts); // failure 2 → opens
    await expect(resilientFetch('https://y.test/a', {}, opts)).rejects.toThrow(CircuitOpenError);
    // After cooldown, half-open allows a trial again.
    now = 1001;
    await expect(resilientFetch('https://y.test/a', {}, opts)).resolves.toBeInstanceOf(Response);
  });
});
