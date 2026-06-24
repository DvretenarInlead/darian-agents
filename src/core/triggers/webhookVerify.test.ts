import { describe, it, expect } from 'vitest';
import { computeSignature, constantTimeEqualHex, verifyWebhook } from './webhookVerify.js';

const secret = 'shhh';
const body = '{"hello":"world"}';
const ts = 1_700_000_000;

describe('constantTimeEqualHex', () => {
  it('matches equal hex', () => {
    expect(constantTimeEqualHex('abcd', 'abcd')).toBe(true);
  });
  it('is case-insensitive on hex', () => {
    expect(constantTimeEqualHex('ABCD', 'abcd')).toBe(true);
  });
  it('rejects different lengths', () => {
    expect(constantTimeEqualHex('abcd', 'ab')).toBe(false);
  });
  it('rejects non-hex without throwing', () => {
    expect(constantTimeEqualHex('zzzz', 'abcd')).toBe(false);
  });
  it('rejects empty', () => {
    expect(constantTimeEqualHex('', '')).toBe(false);
  });
});

describe('verifyWebhook', () => {
  it('accepts a valid, in-window signature', () => {
    const sig = computeSignature(secret, ts, body);
    const r = verifyWebhook({ rawBody: body, signatureHeader: sig, timestamp: ts, secret, toleranceSec: 300, nowSec: ts + 10 });
    expect(r).toEqual({ signatureOk: true, tsInWindow: true, ok: true });
  });

  it('rejects a tampered body (signature mismatch)', () => {
    const sig = computeSignature(secret, ts, body);
    const r = verifyWebhook({ rawBody: body + 'x', signatureHeader: sig, timestamp: ts, secret, toleranceSec: 300, nowSec: ts });
    expect(r.signatureOk).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('rejects a stale timestamp even with a valid signature (replay window)', () => {
    const sig = computeSignature(secret, ts, body);
    const r = verifyWebhook({ rawBody: body, signatureHeader: sig, timestamp: ts, secret, toleranceSec: 300, nowSec: ts + 600 });
    expect(r.signatureOk).toBe(true);
    expect(r.tsInWindow).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('rejects a signature computed for a different timestamp', () => {
    const sig = computeSignature(secret, ts, body);
    const r = verifyWebhook({ rawBody: body, signatureHeader: sig, timestamp: ts + 1, secret, toleranceSec: 300, nowSec: ts + 1 });
    expect(r.signatureOk).toBe(false);
  });
});
