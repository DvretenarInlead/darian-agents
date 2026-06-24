import { describe, it, expect } from 'vitest';
import { ScryptHasher, Argon2idHasher, defaultHasher, checkPasswordStrength } from './password.js';

describe('checkPasswordStrength (zxcvbn)', () => {
  it('accepts a strong, long password', () => {
    expect(checkPasswordStrength('z7$Kq9!mWp2&Lx4r').ok).toBe(true);
  });
  it('rejects short passwords on length', () => {
    const r = checkPasswordStrength('aB3!');
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('12 characters');
  });
  it('rejects a long-but-guessable password that passes character rules', () => {
    // 13 chars, mixed classes, but a dictionary word + sequence — zxcvbn flags it.
    const r = checkPasswordStrength('Password1234!');
    expect(r.ok).toBe(false);
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

describe('Argon2idHasher', () => {
  const hasher = new Argon2idHasher();

  it('hashes to an argon2id PHC string and verifies', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify('correct horse battery staple', stored)).toBe(true);
    expect(await hasher.verify('nope', stored)).toBe(false);
  });

  it('verifies legacy scrypt hashes (migration path)', async () => {
    const legacy = await new ScryptHasher().hash('old-password-value');
    expect(await hasher.verify('old-password-value', legacy)).toBe(true);
    expect(hasher.needsRehash(legacy)).toBe(true);
  });

  it('does not flag an argon2 hash for rehash', async () => {
    const stored = await hasher.hash('x9$Kq2!mWp4&Lz');
    expect(hasher.needsRehash(stored)).toBe(false);
  });

  it('defaultHasher() produces argon2id', async () => {
    const stored = await defaultHasher().hash('another-strong-one!');
    expect(stored.startsWith('$argon2id$')).toBe(true);
  });
});
