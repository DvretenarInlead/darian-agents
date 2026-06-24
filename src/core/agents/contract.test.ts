import { describe, it, expect } from 'vitest';
import { parseVerdict, MAX_ISSUES } from './contract.js';

const valid = {
  agent: 'security',
  subject_id: 'task-1',
  domain: 'security',
  disposition: 'pass',
  confidence: 0.9,
  issues: [],
};

describe('parseVerdict', () => {
  it('accepts a well-formed verdict and applies defaults', () => {
    const r = parseVerdict(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.proposed_fix).toBeNull();
      expect(r.verdict.context).toBeNull();
    }
  });

  it('rejects an unknown agent', () => {
    const r = parseVerdict({ ...valid, agent: 'orchestrator' });
    expect(r.ok).toBe(false);
  });

  it('rejects unexpected keys (strict) — blocks smuggled directives', () => {
    const r = parseVerdict({ ...valid, run_tool: 'rm -rf /' });
    expect(r.ok).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    expect(parseVerdict({ ...valid, confidence: 1.5 }).ok).toBe(false);
  });

  it('rejects too many issues', () => {
    const issues = Array.from({ length: MAX_ISSUES + 1 }, () => ({
      code: 'x',
      message: 'y',
      severity: 'low',
    }));
    expect(parseVerdict({ ...valid, issues }).ok).toBe(false);
  });

  it('returns a readable error for malformed input (quarantine path)', () => {
    const r = parseVerdict({ nonsense: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
