import { describe, it, expect } from 'vitest';
import { FixedWindowRateLimiter, checkAll } from './rateLimiter.js';

describe('FixedWindowRateLimiter', () => {
  it('allows up to max then denies within the window', () => {
    const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 2 });
    expect(rl.check('k', 0).allowed).toBe(true);
    expect(rl.check('k', 100).allowed).toBe(true);
    expect(rl.check('k', 200).allowed).toBe(false);
  });

  it('resets after the window elapses', () => {
    const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
    expect(rl.check('k', 0).allowed).toBe(true);
    expect(rl.check('k', 500).allowed).toBe(false);
    expect(rl.check('k', 1000).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
    expect(rl.check('a', 0).allowed).toBe(true);
    expect(rl.check('b', 0).allowed).toBe(true);
  });

  it('sweep drops expired buckets', () => {
    const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
    rl.check('a', 0);
    rl.sweep(2000);
    // After sweep the key is fresh again.
    expect(rl.check('a', 2001).allowed).toBe(true);
  });
});

describe('checkAll', () => {
  it('denies if any key is over budget', () => {
    const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 1 });
    rl.check('ip:1', 0); // exhaust the ip budget
    const v = checkAll(rl, ['ip:1', 'src:fireflies'], 0);
    expect(v.allowed).toBe(false);
  });

  it('allows when all keys are under budget', () => {
    const rl = new FixedWindowRateLimiter({ windowMs: 1000, max: 5 });
    expect(checkAll(rl, ['ip:1', 'src:fireflies'], 0).allowed).toBe(true);
  });
});
