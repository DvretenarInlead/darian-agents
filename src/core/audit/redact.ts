/**
 * Secret redaction for audit payloads and structured logs (brief §5).
 *
 * We log extractions and payloads that may contain secrets, so redaction happens
 * *before* the value is written/hashed. Two strategies, applied together:
 *  - key-based: any object key whose name looks sensitive has its value masked,
 *    regardless of the value's shape.
 *  - value-based: string values matching high-signal secret patterns are masked
 *    even under innocuous keys.
 *
 * Pure and recursive; returns a deep copy with secrets replaced by REDACTED.
 */

export const REDACTED = '«redacted»';

const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[_-]?key|auth(orization)?|cookie|mfa|credential|private[_-]?key|access[_-]?key|refresh)/i;

const VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/i, // bearer tokens
  /\bsk-[A-Za-z0-9-]{16,}\b/, // anthropic/openai-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bpat-[a-z]{2}\d-[A-Za-z0-9-]{16,}\b/i, // HubSpot private-app tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/, // JWTs
];

function maskString(value: string): string {
  let out = value;
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/** Recursively redact secrets from an arbitrary JSON-serialisable value. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val);
      }
    }
    return out;
  }
  return value;
}
