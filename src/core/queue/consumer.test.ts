import { describe, it, expect } from 'vitest';
import { dispatch, runConsumer, type ConsumerDeps } from './consumer.js';
import { retryDelaySec, type Job } from './jobs.js';

const job = (kind: string, over: Partial<Job> = {}): Job => ({
  id: 'j1',
  kind,
  payload: {},
  attempts: 1,
  maxAttempts: 5,
  ...over,
});

function harness(handlers: ConsumerDeps['handlers']) {
  const completed: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const deps: ConsumerDeps = {
    claim: async () => null,
    complete: async (j) => {
      completed.push(j.id);
    },
    fail: async (j, error) => {
      failed.push({ id: j.id, error });
    },
    handlers,
    sleep: async () => {},
    stopped: () => true,
  };
  return { deps, completed, failed };
}

describe('dispatch', () => {
  it('completes a job whose handler succeeds', async () => {
    const { deps, completed } = harness({ k: async () => {} });
    await dispatch(deps, job('k'));
    expect(completed).toEqual(['j1']);
  });

  it('fails (for retry) a job whose handler throws', async () => {
    const { deps, failed } = harness({
      k: async () => {
        throw new Error('boom');
      },
    });
    await dispatch(deps, job('k'));
    expect(failed[0]).toEqual({ id: 'j1', error: 'boom' });
  });

  it('fails a job with no registered handler', async () => {
    const { deps, failed } = harness({});
    await dispatch(deps, job('unknown'));
    expect(failed[0]!.error).toContain("no handler for job kind 'unknown'");
  });
});

describe('runConsumer', () => {
  it('drains queued jobs then stops', async () => {
    const queue: Job[] = [job('k', { id: 'a' }), job('k', { id: 'b' })];
    const completed: string[] = [];
    let stop = false;
    await runConsumer({
      claim: async () => {
        const next = queue.shift();
        if (!next) {
          stop = true; // drained → let the loop exit on its next guard check
          return null;
        }
        return next;
      },
      complete: async (j) => {
        completed.push(j.id);
      },
      fail: async () => {},
      handlers: { k: async () => {} },
      sleep: async () => {},
      stopped: () => stop,
      idleMs: 0,
      onError: () => {},
    });
    expect(completed).toEqual(['a', 'b']);
  });
});

describe('retryDelaySec', () => {
  it('grows with attempts and is capped', () => {
    const max = retryDelaySec(20, 5, 60, () => 1);
    expect(max).toBeLessThanOrEqual(60);
    expect(max).toBeGreaterThanOrEqual(1);
  });
  it('is at least 1 second', () => {
    expect(retryDelaySec(0, 5, 60, () => 0)).toBe(1);
  });
});
