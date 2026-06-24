import { describe, it, expect } from 'vitest';
import { ScryptHasher, checkPasswordStrength } from './password.js';

describe('checkPasswordStrength', () => {
  it('accepts a strong password', () => {
    expect(checkPasswordStrength('Tr0ub4dour&3xtra').ok).toBe(true);
  });
  it('rejects short passwords with reasons', () => {
    const r = checkPasswordStrength('aB3!');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('12 characters');
  });
  it('rejects a common password', () => {
    expect(checkPasswordStrength('password').ok).toBe(false);
  });
});

describe('ScryptHasher', () => {
  const hasher = new ScryptHasher();

  it('verifies a correct password', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await hasher.verify('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('wrong password', stored)).toBe(false);
  });

  it('rejects a malformed stored value', async () => {
    expect(await hasher.verify('x', 'not-a-valid-hash')).toBe(false);
  });
});
