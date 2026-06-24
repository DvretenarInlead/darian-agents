import { describe, it, expect } from 'vitest';
import {
  createSession,
  isActive,
  touch,
  revoke,
  grantSudo,
  isSudoActive,
  generateSessionToken,
  hashToken,
  verifyToken,
} from './session.js';

const ttls = { idleSec: 100, absoluteSec: 1000 };

describe('session lifecycle', () => {
  it('is active within both windows', () => {
    const s = createSession(0, ttls);
    expect(isActive(s, 50)).toBe(true);
  });

  it('expires on idle timeout', () => {
    const s = createSession(0, ttls);
    expect(isActive(s, 150)).toBe(false);
  });

  it('expires on absolute timeout even with activity', () => {
    let s = createSession(0, ttls);
    // Keep touching, but absolute expiry caps idle extension.
    for (let t = 0; t < 1000; t += 50) s = touch(s, t, ttls.idleSec);
    expect(isActive(s, 1001)).toBe(false);
  });

  it('touch never extends past absolute expiry', () => {
    const s = touch(createSession(0, ttls), 950, ttls.idleSec);
    expect(s.idleExpires).toBe(1000); // capped, not 1050
  });

  it('revocation takes effect', () => {
    const s = revoke(createSession(0, ttls), 10);
    expect(isActive(s, 20)).toBe(false);
  });

  it('sudo is active only within its window and while the session is active', () => {
    const s = grantSudo(createSession(0, ttls), 0, 30);
    expect(isSudoActive(s, 10)).toBe(true);
    expect(isSudoActive(s, 40)).toBe(false);
  });
});

describe('tokens', () => {
  it('verifies a token against its stored hash', () => {
    const token = generateSessionToken();
    expect(verifyToken(token, hashToken(token))).toBe(true);
  });
  it('rejects a different token', () => {
    expect(verifyToken(generateSessionToken(), hashToken(generateSessionToken()))).toBe(false);
  });
});
