import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (build-order step 7) — MFA for privileged console accounts.
 *
 * Pure, dependency-free, clock-injected so it is deterministic and testable.
 * Verification checks a small window of steps to tolerate clock skew and compares
 * in constant time. Secrets are base32 (standard authenticator-app encoding) and
 * stored envelope-encrypted (users.mfa_secret_enc).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  stepSec?: number;
  digits?: number;
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secret: Buffer, timeSec: number, opts: TotpOptions = {}): string {
  const step = opts.stepSec ?? 30;
  return hotp(secret, Math.floor(timeSec / step), opts.digits ?? 6);
}

function constantTimeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a token against a base32 secret at a given time, tolerating ±`window`
 * steps of clock skew. Returns false on any malformed input (never throws).
 */
export function verifyTotp(
  token: string,
  secretBase32: string,
  timeSec: number,
  window = 1,
  opts: TotpOptions = {},
): boolean {
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const step = opts.stepSec ?? 30;
  for (let w = -window; w <= window; w++) {
    const candidate = totp(secret, timeSec + w * step, opts);
    if (constantTimeStrEqual(token, candidate)) return true;
  }
  return false;
}
