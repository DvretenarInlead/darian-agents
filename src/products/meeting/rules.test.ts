import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { applyTaskRules, defaultSyncRules, loadSyncRules, projectName, type SyncRules } from './rules.js';

const ENV = { pipeline: 'default', pipelineStage: 'new' };
const NOW = '2026-08-06T10:00:00.000Z';

function rulesWith(overrides: Partial<SyncRules['task']>, project?: Partial<SyncRules['project']>): SyncRules {
  const base = defaultSyncRules(ENV);
  return {
    project: { ...base.project, ...project },
    task: { ...base.task, ...overrides },
  };
}

describe('sync rules', () => {
  it('renders the project name template', () => {
    expect(projectName(defaultSyncRules(ENV), 'm-42')).toBe('Meeting m-42 — action items');
    expect(projectName(rulesWith({}, { nameTemplate: 'PYB / {meetingId} / follow-ups' }), 'abc')).toBe(
      'PYB / abc / follow-ups',
    );
  });

  it('applies title prefix and meeting context to tasks', () => {
    const rules = rulesWith({ titlePrefix: '[PYB] ' });
    const out = applyTaskRules({ title: 'Send proposal', body: 'to client X' }, rules, 'm-1', NOW);
    expect(out.title).toBe('[PYB] Send proposal');
    expect(out.body).toBe('to client X\n\nFrom meeting m-1 (2026-08-06)');
  });

  it('adds meeting context even when the task has no body', () => {
    const out = applyTaskRules({ title: 'T' }, defaultSyncRules(ENV), 'm-2', NOW);
    expect(out.body).toBe('From meeting m-2 (2026-08-06)');
  });

  it('can turn meeting context off', () => {
    const out = applyTaskRules({ title: 'T', body: 'b' }, rulesWith({ includeMeetingContext: false }), 'm', NOW);
    expect(out.body).toBe('b');
  });

  it('applies the default due date only when the item has none', () => {
    const rules = rulesWith({ defaultDueDays: 7 });
    expect(applyTaskRules({ title: 'T' }, rules, 'm', NOW).dueDate).toBe('2026-08-13');
    expect(applyTaskRules({ title: 'T', dueDate: '2026-09-01' }, rules, 'm', NOW).dueDate).toBe('2026-09-01');
    expect(applyTaskRules({ title: 'T' }, rulesWith({ defaultDueDays: null }), 'm', NOW).dueDate).toBeUndefined();
  });

  it('loads stored rules, falling back to defaults on malformed or missing data', async () => {
    const stored: SyncRules = rulesWith({ titlePrefix: 'X ' }, { nameTemplate: 'Custom {meetingId}' });
    const okPool = { query: async () => ({ rows: [{ value: stored }] }) } as unknown as Pool;
    expect(await loadSyncRules(okPool, ENV)).toEqual(stored);

    const badPool = { query: async () => ({ rows: [{ value: { nonsense: true } }] }) } as unknown as Pool;
    expect(await loadSyncRules(badPool, ENV)).toEqual(defaultSyncRules(ENV));

    const emptyPool = { query: async () => ({ rows: [] }) } as unknown as Pool;
    expect(await loadSyncRules(emptyPool, ENV)).toEqual(defaultSyncRules(ENV));

    const throwingPool = { query: async () => { throw new Error('relation app_settings does not exist'); } } as unknown as Pool;
    expect(await loadSyncRules(throwingPool, ENV)).toEqual(defaultSyncRules(ENV));
  });
});
