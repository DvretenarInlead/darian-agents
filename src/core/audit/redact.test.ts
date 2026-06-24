import { describe, it, expect } from 'vitest';
import { redact, REDACTED } from './redact.js';

describe('redact', () => {
  it('masks values under sensitive keys', () => {
    const out = redact({ email: 'a@b.com', password: 'hunter2', apiKey: 'whatever' }) as Record<string, unknown>;
    expect(out.email).toBe('a@b.com');
    expect(out.password).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
  });

  it('masks secret-shaped values under innocuous keys', () => {
    const out = redact({ note: 'use sk-abcdefghijklmnopqrstuv to call' }) as Record<string, string>;
    expect(out.note).toContain(REDACTED);
    expect(out.note).not.toContain('sk-abcdefghijklmnopqrstuv');
  });

  it('masks bearer tokens and JWTs in free text', () => {
    const out = redact('Authorization header was Bearer abcdef123456789') as string;
    expect(out).toContain(REDACTED);
  });

  it('recurses into nested structures and arrays', () => {
    const out = redact({ items: [{ token: 'x' }, { ok: 1 }] }) as { items: Record<string, unknown>[] };
    expect(out.items[0]!.token).toBe(REDACTED);
    expect(out.items[1]!.ok).toBe(1);
  });

  it('leaves primitives untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
  });
});
