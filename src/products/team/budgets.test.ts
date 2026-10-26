import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { TEAM_BUDGETS_KEY, loadTeamBudgets, resolveBudgetCents } from './budgets.js';

const cfg: Config['team'] = {
  enabled: true,
  lockfilePath: 'x',
  defaultBudgetCents: 1000,
  maxBudgetCents: 10_000,
  approvalTtlHours: 24,
  streamIdleCloseMin: 30,
  firefliesVaultId: undefined,
  githubVaultId: undefined,
  workspaceId: undefined,
};

function poolWith(rows: unknown[] | Error): { pool: Pool; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      if (rows instanceof Error) throw rows;
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

describe('loadTeamBudgets', () => {
  it('reads the team_budgets key', async () => {
    const { pool, calls } = poolWith([{ value: { defaultCents: 2000, perAgent: { content: 500 } } }]);
    expect(await loadTeamBudgets(pool)).toEqual({ defaultCents: 2000, perAgent: { content: 500 } });
    expect(calls[0]).toEqual([TEAM_BUDGETS_KEY]);
  });

  it.each([
    ['missing row', []],
    ['wrong shape', [{ value: { defaultCents: 'lots' } }]],
    ['below the minimum', [{ value: { defaultCents: 10, perAgent: {} } }]],
    ['unknown agent', [{ value: { defaultCents: null, perAgent: { nobody: 100 } } }]],
  ])('falls back to empty on %s', async (_n, rows) => {
    expect(await loadTeamBudgets(poolWith(rows).pool)).toEqual({ defaultCents: null, perAgent: {} });
  });

  it('falls back to empty when the query throws', async () => {
    expect(await loadTeamBudgets(poolWith(new Error('no table')).pool)).toEqual({ defaultCents: null, perAgent: {} });
  });
});

describe('resolveBudgetCents', () => {
  const none = { defaultCents: null, perAgent: {} };

  it('prefers the per-agent setting, then the default setting', () => {
    expect(resolveBudgetCents({ defaultCents: 2000, perAgent: { content: 500 } }, 'content', cfg)).toBe(500);
    expect(resolveBudgetCents({ defaultCents: 2000, perAgent: { content: 500 } }, 'project_manager', cfg)).toBe(2000);
  });

  it('then the catalog default, then the config default', () => {
    expect(resolveBudgetCents(none, 'orchestrator', cfg)).toBe(4000);
    expect(resolveBudgetCents(none, 'project_manager', cfg)).toBe(1000);
  });

  it('never exceeds the configured ceiling', () => {
    expect(resolveBudgetCents({ defaultCents: 99_999, perAgent: {} }, 'content', cfg)).toBe(10_000);
    expect(resolveBudgetCents(none, 'orchestrator', { ...cfg, maxBudgetCents: 3000 })).toBe(3000);
  });
});
