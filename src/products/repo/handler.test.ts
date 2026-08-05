import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { makeRepoHandler } from './handler.js';
import { StubLlmClient } from '../../integrations/anthropic/client.js';
import type { Job } from '../../core/queue/jobs.js';

const pool = {} as Pool;
const handler = makeRepoHandler({ pool, llm: new StubLlmClient(() => '{}') });

describe('makeRepoHandler', () => {
  it('rejects a missing or malformed repo before attempting a clone', async () => {
    await expect(handler({ id: 'j1', kind: 'repo_score', payload: {}, attempts: 1, maxAttempts: 5 } as Job)).rejects.toThrow('owner/name');
    await expect(handler({ id: 'j2', kind: 'repo_score', payload: { repo: 'not-a-repo' }, attempts: 1, maxAttempts: 5 } as Job)).rejects.toThrow('owner/name');
    await expect(handler({ id: 'j3', kind: 'repo_score', payload: { repo: '../evil' }, attempts: 1, maxAttempts: 5 } as Job)).rejects.toThrow('owner/name');
  });
});
