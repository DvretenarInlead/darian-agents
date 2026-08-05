import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { makeMeetingHandler, meetingIdFromPayload } from './handler.js';
import { StubFirefliesClient } from '../../integrations/fireflies/client.js';
import { StubLlmClient, type LlmRequest } from '../../integrations/anthropic/client.js';
import { InMemoryHubSpotClient } from '../../integrations/hubspot/client.js';
import type { Job } from '../../core/queue/jobs.js';

describe('meetingIdFromPayload', () => {
  it('reads meetingId / meeting_id / id, else null', () => {
    expect(meetingIdFromPayload({ body: { meetingId: 'm1' } })).toBe('m1');
    expect(meetingIdFromPayload({ body: { meeting_id: 'm2' } })).toBe('m2');
    expect(meetingIdFromPayload({ body: { id: 'm3' } })).toBe('m3');
    expect(meetingIdFromPayload({ body: {} })).toBeNull();
  });
});

const items = [{ title: 'Send proposal', description: null, owner_hint: null, due_hint: null, source_quote: 'Send proposal by Friday', confidence: 0.9 }];

/** Stub LLM: extraction returns items; board returns a pass verdict per subject. */
function responder(req: LlmRequest, agent: string): string {
  if (req.system?.includes('extract concrete action items')) return JSON.stringify(items);
  const m = req.messages[0]?.content.match(/Subjects:\n(\[[\s\S]*\])/);
  const subjects = m ? (JSON.parse(m[1]!) as Array<{ subjectId: string }>) : [];
  return JSON.stringify(
    subjects.map((s) => ({ agent, subject_id: s.subjectId, domain: agent === 'security' ? 'security' : 'general', disposition: 'pass', confidence: 0.9, issues: [], proposed_fix: null, context: null })),
  );
}

function fakePool() {
  const seen = new Set<string>();
  const syncs: string[] = [];
  const auditClient = { query: async (sql: string) => (sql.includes('INSERT INTO audit_log') ? { rows: [{ id: '1' }], rowCount: 1 } : { rows: [], rowCount: 0 }), release: () => {} };
  const pool = {
    connect: async () => auditClient,
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO reconciliation_ledger')) {
        const fresh = (params[1] as string[]).filter((h) => !seen.has(h));
        fresh.forEach((h) => seen.add(h));
        return { rows: fresh.map((h) => ({ item_hash: h })), rowCount: fresh.length };
      }
      if (sql.includes('FROM agent_configs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM resolution_policy')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM sync_log')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO sync_log')) {
        syncs.push(params[2] as string);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, syncs };
}

describe('makeMeetingHandler', () => {
  it('fetches the transcript and runs the pipeline through to a HubSpot apply', async () => {
    const { pool, syncs } = fakePool();
    const hubspot = new InMemoryHubSpotClient();
    const handler = makeMeetingHandler({
      pool,
      fireflies: new StubFirefliesClient({ m1: 'Dana will send the proposal by Friday' }),
      llm: new StubLlmClient(responder),
      hubspot,
      projectDefaults: { pipeline: 'default', pipelineStage: 'new' },
    });
    await handler({ id: 'j1', kind: 'meeting_ingest', payload: { body: { meetingId: 'm1' } }, attempts: 1, maxAttempts: 5 } as Job);
    expect(hubspot.applied).toHaveLength(1); // board passed → synced
    expect(syncs).toEqual(['previewed', 'applied']);
  });

  it('throws when the payload has no meeting id', async () => {
    const { pool } = fakePool();
    const handler = makeMeetingHandler({
      pool,
      fireflies: new StubFirefliesClient({}),
      llm: new StubLlmClient(responder),
      hubspot: new InMemoryHubSpotClient(),
      projectDefaults: { pipeline: 'default', pipelineStage: 'new' },
    });
    await expect(handler({ id: 'j2', kind: 'meeting_ingest', payload: { body: {} }, attempts: 1, maxAttempts: 5 } as Job)).rejects.toThrow('no meetingId');
  });
});
