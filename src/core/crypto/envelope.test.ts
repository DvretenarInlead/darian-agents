import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, EnvelopeError, type Keyring } from './envelope.js';
import { randomBytes } from 'node:crypto';

function keyring(version = 1): Keyring {
  const key = randomBytes(32);
  return { current: { version, key }, byVersion: new Map([[version, key]]) };
}

describe('envelope encryption', () => {
  it('round-trips a string', () => {
    const kr = keyring();
    const blob = encrypt('sensitive transcript', kr);
    expect(decrypt(blob, kr).toString('utf8')).toBe('sensitive transcript');
  });

  it('produces different ciphertext each time (random DEK/IV)', () => {
    const kr = keyring();
    expect(encrypt('x', kr).equals(encrypt('x', kr))).toBe(false);
  });

  it('fails to decrypt under a different key', () => {
    const blob = encrypt('secret', keyring());
    expect(() => decrypt(blob, keyring())).toThrow(); // GCM auth fails / no key version
  });

  it('detects tampering (GCM auth tag)', () => {
    const kr = keyring();
    const blob = encrypt('secret', kr);
    const last = blob.length - 1;
    blob[last] = (blob[last] ?? 0) ^ 0xff; // flip a ciphertext byte
    expect(() => decrypt(blob, kr)).toThrow();
  });

  it('rejects an unknown key version', () => {
    const kr = keyring(1);
    const blob = encrypt('secret', kr);
    const other: Keyring = { current: kr.current, byVersion: new Map([[2, kr.current.key]]) };
    expect(() => decrypt(blob, other)).toThrow(EnvelopeError);
  });

  it('supports decrypting an old version from the keyring', () => {
    const v1 = randomBytes(32);
    const v2 = randomBytes(32);
    const krV1: Keyring = { current: { version: 1, key: v1 }, byVersion: new Map([[1, v1]]) };
    const blob = encrypt('legacy', krV1);
    // After rotation, current is v2 but the keyring still holds v1 for reads.
    const rotated: Keyring = {
      current: { version: 2, key: v2 },
      byVersion: new Map([
        [1, v1],
        [2, v2],
      ]),
    };
    expect(decrypt(blob, rotated).toString('utf8')).toBe('legacy');
  });
});
