import { describe, it, expect } from 'vitest';
import { canApprove, assertCanApprove, SeparationOfDutiesError, type SodEntry } from './sod.js';

const history: SodEntry[] = [
  { subjectId: 's1', action: 'configured', actorId: 'alice' },
];

describe('separation of duties', () => {
  it('forbids the configurer from approving their own subject', () => {
    expect(canApprove('alice', 's1', history)).toBe(false);
    expect(() => assertCanApprove('alice', 's1', history)).toThrow(SeparationOfDutiesError);
  });

  it('allows a different actor to approve', () => {
    expect(canApprove('bob', 's1', history)).toBe(true);
  });

  it('allows approval of an unrelated subject', () => {
    expect(canApprove('alice', 's2', history)).toBe(true);
  });
});

describe('csrf', () => {
  it('matches identical tokens and rejects mismatches/empties', async () => {
    const { generateCsrfToken, verifyCsrf } = await import('../auth/csrf.js');
    const tok = generateCsrfToken();
    expect(verifyCsrf(tok, tok)).toBe(true);
    expect(verifyCsrf(tok, 'other')).toBe(false);
    expect(verifyCsrf(undefined, tok)).toBe(false);
  });
});
