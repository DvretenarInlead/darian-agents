import { describe, it, expect } from 'vitest';
import { InMemoryHubSpotClient, renderPreview } from './client.js';
import { buildSyncPlan } from './plan.js';
import type { ProjectInput } from './types.js';

const project: ProjectInput = { name: 'P', pipeline: 'default', pipelineStage: 'new' };
const plan = buildSyncPlan({
  subjectId: 'm1',
  project,
  items: [
    { task: { title: 'A' }, decision: 'created' },
    { task: { title: 'B' }, decision: 'created' },
  ],
});

describe('renderPreview', () => {
  it('summarises ops without mutating', () => {
    const preview = renderPreview(plan);
    expect(preview.subjectId).toBe('m1');
    expect(preview.ops[0]!.kind).toBe('create_project');
    expect(preview.ops[0]!.taskCount).toBe(2);
    expect(preview.ops[0]!.summary).toContain('create project');
  });
});

describe('InMemoryHubSpotClient', () => {
  it('preview does not record an apply', async () => {
    const client = new InMemoryHubSpotClient();
    await client.preview(plan);
    expect(client.applied).toHaveLength(0);
  });

  it('apply returns refs with generated ids and records the plan', async () => {
    const client = new InMemoryHubSpotClient();
    const result = await client.apply(plan);
    expect(client.applied).toHaveLength(1);
    expect(result.refs[0]!.projectId).toMatch(/^project-/);
    expect(result.refs[0]!.taskIds).toHaveLength(2);
  });

  it('resolves a known owner by email', async () => {
    const client = new InMemoryHubSpotClient([{ ownerId: 'o1', email: 'a@b.com' }]);
    expect(await client.resolveOwner({ email: 'a@b.com' })).toEqual({ ownerId: 'o1', email: 'a@b.com' });
    expect(await client.resolveOwner({ email: 'nobody@x.com' })).toBeNull();
  });
});
