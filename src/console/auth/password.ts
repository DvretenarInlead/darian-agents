import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** Promisified scrypt that preserves the options-object overload. */
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing + strength policy (build-order step 7).
 *
 * The hasher is behind a `PasswordHasher` port. The default `ScryptHasher` uses
 * Node's built-in scrypt (a strong memory-hard KDF) so the project carries **no
 * native dependency** and CI stays clean. The brief specifies **argon2id** for
 * production; swapping in an `Argon2idHasher` that implements this same port is a
 * one-line change, and the stored hash is self-describing (algo prefix) so a
 * migration can detect and re-hash on next login.
 */

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
}

const SCRYPT_N = 16_384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;

export class ScryptHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scryptAsync(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p })) as Buffer;
    return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${derived.toString('base64')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(hashB64!, 'base64');
    const derived = (await scryptAsync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    })) as Buffer;
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  }
}

export interface StrengthResult {
  ok: boolean;
  reasons: string[];
}

const COMMON = new Set(['password', 'qwerty', '12345678', 'letmein', 'admin', 'welcome', 'iloveyou']);

/**
 * Lightweight, dependency-free strength check (length + character variety +
 * common-password reject). The brief's production target is **zxcvbn**; this is
 * a deliberately conservative stand-in that callers can replace, kept here so
 * the policy is enforced even before zxcvbn is wired in.
 */
export function checkPasswordStrength(password: string): StrengthResult {
  const reasons: string[] = [];
  if (password.length < 12) reasons.push('must be at least 12 characters');
  if (!/[a-z]/.test(password)) reasons.push('needs a lowercase letter');
  if (!/[A-Z]/.test(password)) reasons.push('needs an uppercase letter');
  if (!/[0-9]/.test(password)) reasons.push('needs a digit');
  if (!/[^A-Za-z0-9]/.test(password)) reasons.push('needs a symbol');
  if (COMMON.has(password.toLowerCase())) reasons.push('is a commonly-used password');
  return { ok: reasons.length === 0, reasons };
}
