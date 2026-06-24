import { describe, it, expect } from 'vitest';
import { buildSyncPlan, type ApprovedItem } from './plan.js';
import type { ProjectInput } from './types.js';

const project: ProjectInput = { name: 'Acme follow-ups', pipeline: 'default', pipelineStage: 'new' };
const item = (decision: ApprovedItem['decision'], title: string): ApprovedItem => ({
  task: { title },
  decision,
});

describe('buildSyncPlan', () => {
  it('creates a project with non-duplicate tasks', () => {
    const plan = buildSyncPlan({
      subjectId: 'm1',
      project,
      items: [item('created', 'A'), item('created', 'B')],
    });
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]!.kind).toBe('create_project');
    expect(plan.ops[0]!.tasks).toHaveLength(2);
  });

  it('drops skipped duplicates so they are never re-created', () => {
    const plan = buildSyncPlan({
      subjectId: 'm1',
      project,
      items: [item('created', 'A'), item('skipped_duplicate', 'B')],
    });
    expect(plan.ops[0]!.tasks.map((t) => t.title)).toEqual(['A']);
  });

  it('emits an update op when the project already exists', () => {
    const plan = buildSyncPlan({
      subjectId: 'm1',
      project,
      existingProjectId: 'proj-9',
      items: [item('created', 'A')],
    });
    expect(plan.ops[0]).toMatchObject({ kind: 'update_project', projectId: 'proj-9' });
  });

  it('produces zero ops when everything is a duplicate and project is new', () => {
    const plan = buildSyncPlan({
      subjectId: 'm1',
      project,
      items: [item('skipped_duplicate', 'A')],
    });
    expect(plan.ops).toHaveLength(0);
  });

  it('produces zero ops for an existing project with no new tasks or updates', () => {
    const plan = buildSyncPlan({
      subjectId: 'm1',
      project,
      existingProjectId: 'proj-9',
      items: [item('skipped_duplicate', 'A')],
    });
    expect(plan.ops).toHaveLength(0);
  });

  it('updates project fields even with no new tasks', () => {
    const plan = buildSyncPlan({
      subjectId: 'm1',
      project,
      existingProjectId: 'proj-9',
      projectUpdates: { status: 'in_progress' },
      items: [item('skipped_duplicate', 'A')],
    });
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]).toMatchObject({ kind: 'update_project' });
  });
});
