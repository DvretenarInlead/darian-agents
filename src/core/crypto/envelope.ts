import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../../config/index.js';

/**
 * App-level envelope encryption (brief §5, build-order step 8) for the most
 * sensitive columns (raw transcripts/repo content, TOTP seeds), layered above
 * DigitalOcean's at-rest disk encryption.
 *
 * Scheme: a fresh 256-bit data key (DEK) per record encrypts the plaintext with
 * AES-256-GCM; the DEK is then wrapped (encrypted) with the master key (KEK)
 * under its own GCM nonce. The stored blob is self-describing and carries the
 * key version, so the KEK can be rotated while old records remain decryptable
 * (the keyring holds prior versions). The plaintext is never encrypted directly
 * with the long-lived KEK.
 */

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export interface KeyringEntry {
  version: number;
  key: Buffer; // 32 bytes
}

export interface Keyring {
  current: KeyringEntry;
  byVersion: Map<number, Buffer>;
}

export class EnvelopeError extends Error {}

/** Build a keyring from config (single current key; extend for rotation). */
export function keyringFromConfig(): Keyring {
  const cfg = config();
  if (!cfg.envelope.masterKey) {
    throw new EnvelopeError('ENVELOPE_MASTER_KEY is not configured');
  }
  const key = Buffer.from(cfg.envelope.masterKey, 'base64');
  if (key.length !== KEY_LEN) {
    throw new EnvelopeError('ENVELOPE_MASTER_KEY must be 32 bytes (base64-encoded)');
  }
  const entry: KeyringEntry = { version: cfg.envelope.keyVersion, key };
  return { current: entry, byVersion: new Map([[entry.version, key]]) };
}

function gcmEncrypt(key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Encrypt plaintext into a self-describing blob:
 *   [version:1][keyVersion:1][wrapIv:12][wrapTag:16][wrappedDek:32][dataIv:12][dataTag:16][ciphertext:…]
 */
export function encrypt(plaintext: Buffer | string, keyring: Keyring): Buffer {
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const dek = randomBytes(KEY_LEN);
  const data = gcmEncrypt(dek, pt);
  const wrap = gcmEncrypt(keyring.current.key, dek);
  return Buffer.concat([
    Buffer.from([VERSION, keyring.current.version]),
    wrap.iv,
    wrap.tag,
    wrap.ct, // wrapped DEK (32 bytes)
    data.iv,
    data.tag,
    data.ct,
  ]);
}

export function decrypt(blob: Buffer, keyring: Keyring): Buffer {
  if (blob.length < 2 + IV_LEN + TAG_LEN + KEY_LEN + IV_LEN + TAG_LEN) {
    throw new EnvelopeError('envelope blob too short');
  }
  let o = 0;
  const version = blob[o++]!;
  if (version !== VERSION) throw new EnvelopeError(`unsupported envelope version ${version}`);
  const keyVersion = blob[o++]!;
  const kek = keyring.byVersion.get(keyVersion);
  if (!kek) throw new EnvelopeError(`no key for version ${keyVersion}`);

  const wrapIv = blob.subarray(o, (o += IV_LEN));
  const wrapTag = blob.subarray(o, (o += TAG_LEN));
  const wrappedDek = blob.subarray(o, (o += KEY_LEN));
  const dataIv = blob.subarray(o, (o += IV_LEN));
  const dataTag = blob.subarray(o, (o += TAG_LEN));
  const ct = blob.subarray(o);

  const dek = gcmDecrypt(kek, wrapIv, wrapTag, wrappedDek);
  return gcmDecrypt(dek, dataIv, dataTag, ct);
}
