import { describe, it, expect } from 'vitest';
import { base32Decode, totp, verifyTotp } from './totp.js';

const SECRET = 'JBSWY3DPEHPK3PXP';

describe('base32Decode', () => {
  it('decodes a known base32 string', () => {
    expect(base32Decode('JBSWY3DP').toString()).toBe('Hello');
  });
  it('throws on invalid characters', () => {
    expect(() => base32Decode('0189!')).toThrow();
  });
});

describe('TOTP', () => {
  const t = 59; // fixed time

  it('verifies a freshly generated token', () => {
    const token = totp(base32Decode(SECRET), t);
    expect(verifyTotp(token, SECRET, t)).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(verifyTotp('000000', SECRET, t)).toBe(false);
  });

  it('tolerates one step of clock skew within the window', () => {
    const token = totp(base32Decode(SECRET), t);
    expect(verifyTotp(token, SECRET, t + 30)).toBe(true);
  });

  it('rejects beyond the window', () => {
    const token = totp(base32Decode(SECRET), t);
    expect(verifyTotp(token, SECRET, t + 120, 1)).toBe(false);
  });

  it('returns false (no throw) on a malformed secret', () => {
    expect(verifyTotp('123456', '!!!!', t)).toBe(false);
  });
});
