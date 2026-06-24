import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature & replay verification (brief §1, build-order step 4).
 *
 * Pure functions — the DB-backed nonce dedupe lives in dedupe.ts and the HTTP
 * wiring in src/web/webhookReceiver.ts. Signature verification alone does not
 * stop replay, so we bind the timestamp into the signed payload AND enforce a
 * tolerance window here; the delivery-ID dedupe table is the third leg.
 *
 * Scheme (Stripe-style): signature = HMAC-SHA256(secret, `${timestamp}.${body}`)
 * hex-encoded. Binding the timestamp means a captured signature cannot be
 * replayed with a fresh timestamp — the signature would no longer match.
 */

export interface WebhookVerifyInput {
  rawBody: string;
  /** Hex signature from the provider header. */
  signatureHeader: string;
  /** Unix seconds parsed from the provider header. */
  timestamp: number;
  secret: string;
  toleranceSec: number;
  nowSec: number;
}

export interface WebhookVerifyResult {
  signatureOk: boolean;
  tsInWindow: boolean;
  ok: boolean;
}

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Constant-time comparison of two hex strings. Never use `===` on HMACs — it
 * short-circuits on the first differing byte and leaks timing. Length mismatch
 * or non-hex input returns false without throwing.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  let ab: Buffer;
  let bb: Buffer;
  try {
    ab = Buffer.from(a, 'hex');
    bb = Buffer.from(b, 'hex');
  } catch {
    return false;
  }
  // Buffer.from with odd/invalid hex silently truncates; guard on length and
  // that re-encoding round-trips to the original input.
  if (ab.length === 0 || ab.length !== bb.length) return false;
  if (ab.toString('hex') !== a.toLowerCase() || bb.toString('hex') !== b.toLowerCase()) return false;
  return timingSafeEqual(ab, bb);
}

export function verifyWebhook(input: WebhookVerifyInput): WebhookVerifyResult {
  const expected = computeSignature(input.secret, input.timestamp, input.rawBody);
  const signatureOk = constantTimeEqualHex(expected, input.signatureHeader);
  const tsInWindow = Number.isFinite(input.timestamp)
    ? Math.abs(input.nowSec - input.timestamp) <= input.toleranceSec
    : false;
  return { signatureOk, tsInWindow, ok: signatureOk && tsInWindow };
}
