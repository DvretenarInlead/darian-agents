import { describe, it, expect } from 'vitest';
import { computeRowHash, nextLink, verifyChain, canonicalize, type AuditEntryInput } from './hashChain.js';

const entry = (overrides: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  eventType: 'verdict',
  product: 'meeting',
  actorId: null,
  subjectId: 'task-1',
  payload: { disposition: 'pass' },
  createdAt: '2026-06-24T00:00:00.000Z',
  ...overrides,
});

describe('canonicalize', () => {
  it('is stable across key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });
});

describe('hash chain', () => {
  it('genesis row chains from null', () => {
    const link = nextLink(entry(), null);
    expect(link.prevHash).toBeNull();
    expect(link.rowHash).toHaveLength(64);
  });

  it('changing payload changes the row hash', () => {
    const a = computeRowHash(entry({ payload: { x: 1 } }), null);
    const b = computeRowHash(entry({ payload: { x: 2 } }), null);
    expect(a).not.toBe(b);
  });

  it('verifies an intact chain', () => {
    const rows: Array<AuditEntryInput & { prevHash: string | null; rowHash: string }> = [];
    let prev: string | null = null;
    for (let i = 0; i < 3; i++) {
      const e = entry({ subjectId: `task-${i}` });
      const link = nextLink(e, prev);
      rows.push({ ...e, ...link });
      prev = link.rowHash;
    }
    expect(verifyChain(rows)).toEqual({ valid: true, brokenAt: -1 });
  });

  it('detects a tampered middle row', () => {
    const rows: Array<AuditEntryInput & { prevHash: string | null; rowHash: string }> = [];
    let prev: string | null = null;
    for (let i = 0; i < 3; i++) {
      const e = entry({ subjectId: `task-${i}` });
      const link = nextLink(e, prev);
      rows.push({ ...e, ...link });
      prev = link.rowHash;
    }
    // Mutate the payload of row 1 without recomputing its hash.
    rows[1] = { ...rows[1]!, payload: { disposition: 'fail' } };
    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});
