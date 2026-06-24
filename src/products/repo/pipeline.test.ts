import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { scoreRepo } from './pipeline.js';
import type { RepoReviewClient, RepoReviewer, DimensionScore, RepoSummary } from './score.js';

function fakePool() {
  const audits: unknown[][] = [];
  const client = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO audit_log')) {
        audits.push(params);
        return { rows: [{ id: '1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
  return { pool: pool as unknown as Pool, audits };
}

class StubReviewer implements RepoReviewClient {
  async review(reviewer: RepoReviewer, _summary: RepoSummary): Promise<DimensionScore> {
    const score = reviewer === 'security' ? 50 : 80;
    return { reviewer, score, findings: [] };
  }
}

describe('scoreRepo', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'repo-score-'));
    await writeFile(join(root, 'index.ts'), 'export const x = 1;');
    await writeFile(join(root, 'leak.txt'), '-----BEGIN PRIVATE KEY-----\nabc');
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('ingests, pre-scans, scores, and audits', async () => {
    const { pool, audits } = fakePool();
    const result = await scoreRepo(
      { pool, reviewer: new StubReviewer(), now: () => '2026-06-24T00:00:00.000Z' },
      { repo: 'acme/widget', rootDir: root },
    );
    expect(result.filesScanned).toBe(2);
    expect(result.prescanFindings).toBeGreaterThanOrEqual(1); // the private key
    // overall = (80 + 50 + 80) / 3 = 70
    expect(result.scorecard.overall).toBe(70);
    expect(result.scorecard.dimensions).toHaveLength(3);
    // ingest audit + verdict audit
    expect(audits.length).toBe(2);
  });
});
