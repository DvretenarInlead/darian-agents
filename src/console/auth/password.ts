import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { dictionary, adjacencyGraphs } from '@zxcvbn-ts/language-common';

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

/**
 * Production hasher: argon2id (the brief's target). verify() also accepts legacy
 * `scrypt$` hashes and delegates to ScryptHasher, so accounts created before the
 * swap keep working and can be transparently re-hashed on next login.
 */
export class Argon2idHasher implements PasswordHasher {
  private readonly scrypt = new ScryptHasher();

  async hash(password: string): Promise<string> {
    return argon2Hash(password, { algorithm: Algorithm.Argon2id });
  }

  async verify(password: string, stored: string): Promise<boolean> {
    if (stored.startsWith('scrypt$')) return this.scrypt.verify(password, stored);
    try {
      return await argon2Verify(stored, password);
    } catch {
      return false;
    }
  }

  /** True if a stored hash should be upgraded to argon2id on next successful login. */
  needsRehash(stored: string): boolean {
    return !stored.startsWith('$argon2id$');
  }
}

/** The default production hasher. */
export function defaultHasher(): PasswordHasher {
  return new Argon2idHasher();
}

export interface StrengthResult {
  ok: boolean;
  reasons: string[];
}

/**
 * zxcvbn-based strength check (the brief's production target). Requires a
 * minimum length plus a zxcvbn score of ≥ 3 (0–4 scale), and surfaces zxcvbn's
 * own feedback as reasons. zxcvbn catches weak-but-"complex" passwords that a
 * character-class rule misses (e.g. "P@ssw0rd123").
 */
let zxcvbnInstance: ZxcvbnFactory | undefined;
function zxcvbn(): ZxcvbnFactory {
  if (!zxcvbnInstance) {
    zxcvbnInstance = new ZxcvbnFactory({ dictionary, graphs: adjacencyGraphs });
  }
  return zxcvbnInstance;
}

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_ZXCVBN_SCORE = 3;

export function checkPasswordStrength(password: string): StrengthResult {
  const reasons: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) reasons.push(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const result = zxcvbn().check(password);
  if (result.score < MIN_ZXCVBN_SCORE) {
    reasons.push(result.feedback.warning || 'is too weak or guessable');
    for (const s of result.feedback.suggestions) reasons.push(s);
  }
  return { ok: reasons.length === 0, reasons };
}
