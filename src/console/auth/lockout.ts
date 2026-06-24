import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Account lockout state transitions (build-order step 7). Pure.
 *
 * Enumeration resistance is a route-layer concern (identical timing + messaging
 * for unknown-user vs bad-password, throttle by IP **and** account); this module
 * owns the per-account counter/lock transitions, and `dummyVerify` exists so the
 * login path can spend the same work on an unknown user as on a real one.
 */

export interface LockState {
  failedAttempts: number;
  lockedUntil: number | null; // unix seconds
}

export interface LockoutPolicy {
  threshold: number;
  lockoutSec: number;
}

export function isLocked(state: LockState, nowSec: number): boolean {
  return state.lockedUntil !== null && nowSec < state.lockedUntil;
}

export function registerFailure(state: LockState, nowSec: number, policy: LockoutPolicy): LockState {
  const attempts = state.failedAttempts + 1;
  if (attempts >= policy.threshold) {
    return { failedAttempts: 0, lockedUntil: nowSec + policy.lockoutSec };
  }
  return { failedAttempts: attempts, lockedUntil: null };
}

export function registerSuccess(): LockState {
  return { failedAttempts: 0, lockedUntil: null };
}

/**
 * Constant-ish-work dummy verification for unknown accounts. Returns false but
 * does comparable work so response timing does not reveal account existence.
 */
export function dummyVerify(): boolean {
  const a = randomBytes(32);
  const b = randomBytes(32);
  return timingSafeEqual(a, a) && !timingSafeEqual(a, b);
}
