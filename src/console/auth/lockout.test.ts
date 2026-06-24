import { describe, it, expect } from 'vitest';
import { isLocked, registerFailure, registerSuccess } from './lockout.js';

const policy = { threshold: 3, lockoutSec: 900 };

describe('lockout transitions', () => {
  it('increments failures below the threshold', () => {
    const s = registerFailure({ failedAttempts: 0, lockedUntil: null }, 100, policy);
    expect(s.failedAttempts).toBe(1);
    expect(s.lockedUntil).toBeNull();
  });

  it('locks at the threshold', () => {
    let s = { failedAttempts: 2, lockedUntil: null as number | null };
    s = registerFailure(s, 100, policy);
    expect(s.lockedUntil).toBe(1000);
    expect(isLocked(s, 500)).toBe(true);
    expect(isLocked(s, 1001)).toBe(false);
  });

  it('success resets state', () => {
    expect(registerSuccess()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});
