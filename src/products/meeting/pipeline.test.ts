import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { processMeeting, type MeetingPipelineDeps } from './pipeline.js';
import { StubExtractor, type ActionItem } from './extract.js';
import { type BoardRunner, type BoardSubject } from './board.js';
import { InMemoryHubSpotClient } from '../../integrations/hubspot/client.js';
import { type BoardAgent, type Verdict } from '../../core/agents/contract.js';

const DOMAINS: Record<BoardAgent, string> = {
  project_manager: 'project_management',
  hubspot_admin: 'crm',
  security: 'security',
  data_quality: 'data_quality',
  dev: 'engineering',
  cto: 'architecture',
};

const pass = (agent: BoardAgent, subjectId: string, over: Partial<Verdict> = {}): Verdict => ({
  agent,
  subject_id: subjectId,
  domain: DOMAINS[agent],
  disposition: 'pass',
  confidence: 0.9,
  issues: [],
  proposed_fix: null,
  context: null,
  ...over,
});

class StubRunner implements BoardRunner {
  constructor(private readonly fn: (agent: BoardAgent, subjects: BoardSubject[]) => Verdict[]) {}
  async reviewBatch(agent: BoardAgent, subjects: BoardSubject[]): Promise<Verdict[]> {
    return this.fn(agent, subjects);
  }
}

/** Fake pool routing by SQL substring; tracks reconcile dedupe + side tables. */
function fakePool() {
  const seen = new Set<string>();
  const escalations: unknown[][] = [];
  const syncs: unknown[][] = [];
  const auditClient = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO audit_log')) return { rows: [{ id: '1' }], rowCount: 1 };
      if (sql.includes('SELECT row_hash')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => auditClient,
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO reconciliation_ledger')) {
        const h = params[1] as string;
        if (seen.has(h)) return { rowCount: 0, rows: [] };
        seen.add(h);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('FROM sync_log')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO sync_log')) {
        syncs.push(params);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO escalation_queue')) {
        escalations.push(params);
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, escalations, syncs };
}

const item = (title: string): ActionItem => ({
  title,
  description: null,
  owner_hint: null,
  due_hint: null,
  source_quote: `${title} mentioned`,
  confidence: 0.9,
});

function deps(pool: Pool, runner: BoardRunner): MeetingPipelineDeps {
  return {
    pool,
    extractor: new StubExtractor([item('Send proposal'), item('Book venue')]),
    board: { runner, policy: [] },
    hubspot: new InMemoryHubSpotClient(),
    projectDefaults: { pipeline: 'default', pipelineStage: 'new' },
    now: () => '2026-06-24T00:00:00.000Z',
  };
}

describe('processMeeting', () => {
  it('extracts, clears the board, and syncs proceeding items', async () => {
    const { pool, syncs } = fakePool();
    const runner = new StubRunner((agent, subjects) => subjects.map((s) => pass(agent, s.subjectId)));
    const summary = await processMeeting(deps(pool, runner), { meetingId: 'm1', transcript: 'text' });
    expect(summary.extracted).toBe(2);
    expect(summary.proceeded).toBe(2);
    expect(summary.escalated).toBe(0);
    expect(summary.synced).toBe(true);
    // preview + applied logged.
    expect(syncs.map((p) => p[2])).toEqual(['previewed', 'applied']);
  });

  it('escalates security-vetoed items and does not sync them', async () => {
    const { pool, escalations } = fakePool();
    // Security fails every subject → all escalate, nothing proceeds.
    const runner = new StubRunner((agent, subjects) =>
      subjects.map((s) =>
        agent === 'security'
          ? pass(agent, s.subjectId, { disposition: 'fail', issues: [{ code: 'x', message: 'no', severity: 'high' }] })
          : pass(agent, s.subjectId),
      ),
    );
    const summary = await processMeeting(deps(pool, runner), { meetingId: 'm1', transcript: 'text' });
    expect(summary.escalated).toBe(2);
    expect(summary.proceeded).toBe(0);
    expect(summary.synced).toBe(false);
    expect(escalations).toHaveLength(2);
  });

  it('drops duplicates on a second run (reconciliation)', async () => {
    const { pool } = fakePool();
    const runner = new StubRunner((agent, subjects) => subjects.map((s) => pass(agent, s.subjectId)));
    const d = deps(pool, runner);
    await processMeeting(d, { meetingId: 'm1', transcript: 'text' });
    const second = await processMeeting(d, { meetingId: 'm1', transcript: 'text' });
    expect(second.duplicates).toBe(2);
    expect(second.proceeded).toBe(0);
  });

  it('previews only when apply=false', async () => {
    const { pool, syncs } = fakePool();
    const runner = new StubRunner((agent, subjects) => subjects.map((s) => pass(agent, s.subjectId)));
    const summary = await processMeeting(deps(pool, runner), { meetingId: 'm1', transcript: 'text', apply: false });
    expect(summary.synced).toBe(false);
    expect(syncs.map((p) => p[2])).toEqual(['previewed']);
  });
});
