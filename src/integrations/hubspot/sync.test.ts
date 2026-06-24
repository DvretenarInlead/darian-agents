import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { runSync } from './sync.js';
import { InMemoryHubSpotClient } from './client.js';
import { buildSyncPlan } from './plan.js';
import type { ProjectInput } from './types.js';

const project: ProjectInput = { name: 'P', pipeline: 'default', pipelineStage: 'new' };

/** Stub pool that records sync_log inserts for assertions. */
function recordingPool(): { pool: Pool; rows: { dryRun: boolean; outcome: string }[] } {
  const rows: { dryRun: boolean; outcome: string }[] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      rows.push({ dryRun: params[1] as boolean, outcome: params[2] as string });
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  return { pool, rows };
}

const plan = (existing = false) =>
  buildSyncPlan({
    subjectId: 'm1',
    project,
    ...(existing ? { existingProjectId: 'p9' } : {}),
    items: [{ task: { title: 'A' }, decision: 'created' }],
  });

describe('runSync', () => {
  it('previews without applying when not approved', async () => {
    const { pool, rows } = recordingPool();
    const client = new InMemoryHubSpotClient();
    const outcome = await runSync(pool, client, plan(), false);
    expect(outcome.result).toBeUndefined();
    expect(client.applied).toHaveLength(0);
    expect(rows).toEqual([{ dryRun: true, outcome: 'previewed' }]);
  });

  it('applies only when approved, and logs preview then applied', async () => {
    const { pool, rows } = recordingPool();
    const client = new InMemoryHubSpotClient();
    const outcome = await runSync(pool, client, plan(), true);
    expect(outcome.result).toBeDefined();
    expect(client.applied).toHaveLength(1);
    expect(rows).toEqual([
      { dryRun: true, outcome: 'previewed' },
      { dryRun: false, outcome: 'applied' },
    ]);
  });

  it('short-circuits an empty plan (no preview, no apply, no log)', async () => {
    const { pool, rows } = recordingPool();
    const client = new InMemoryHubSpotClient();
    const emptyPlan = buildSyncPlan({
      subjectId: 'm1',
      project,
      items: [{ task: { title: 'A' }, decision: 'skipped_duplicate' }],
    });
    const outcome = await runSync(pool, client, emptyPlan, true);
    expect(outcome.skipped).toBe(true);
    expect(rows).toHaveLength(0);
    expect(client.applied).toHaveLength(0);
  });

  it('logs failed when apply throws', async () => {
    const { pool, rows } = recordingPool();
    const client = new InMemoryHubSpotClient();
    client.apply = async () => {
      throw new Error('boom');
    };
    await expect(runSync(pool, client, plan(), true)).rejects.toThrow('boom');
    expect(rows).toEqual([
      { dryRun: true, outcome: 'previewed' },
      { dryRun: false, outcome: 'failed' },
    ]);
  });
});
