import { describe, it, expect } from 'vitest';
import { aggregate, buildSummary, DimensionScore } from './score.js';
import type { IngestedFile } from './ingest.js';

describe('buildSummary', () => {
  it('caps the sample size and labels files', () => {
    const files: IngestedFile[] = [
      { path: 'a.ts', content: 'a'.repeat(100), bytes: 100 },
      { path: 'b.ts', content: 'b'.repeat(100), bytes: 100 },
    ];
    const s = buildSummary('r', files, 50);
    expect(s.fileCount).toBe(2);
    expect(s.sample).toContain('// a.ts');
    expect(s.sample.length).toBeLessThan(120); // sample bounded
  });
});

describe('aggregate', () => {
  it('averages dimension scores (rounded)', () => {
    const dims: DimensionScore[] = [
      { reviewer: 'dev', score: 80, findings: [] },
      { reviewer: 'security', score: 60, findings: [] },
      { reviewer: 'cto', score: 71, findings: [] },
    ];
    expect(aggregate('r', dims).overall).toBe(70);
  });
  it('handles an empty board', () => {
    expect(aggregate('r', []).overall).toBe(0);
  });
});

describe('DimensionScore schema', () => {
  it('rejects out-of-range scores', () => {
    expect(() => DimensionScore.parse({ reviewer: 'dev', score: 101, findings: [] })).toThrow();
  });
});
