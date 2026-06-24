import { describe, it, expect } from 'vitest';
import { runWithCorrelation, currentCorrelationId, log } from './logger.js';
import { renderMetrics, jobsProcessed } from './metrics.js';

describe('correlation context', () => {
  it('exposes the id inside the context and clears outside', () => {
    expect(currentCorrelationId()).toBeUndefined();
    const inside = runWithCorrelation('cid-123', () => currentCorrelationId());
    expect(inside).toBe('cid-123');
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('log() returns a usable logger in and out of context', () => {
    expect(typeof log().info).toBe('function');
    runWithCorrelation('x', () => expect(typeof log().info).toBe('function'));
  });
});

describe('metrics', () => {
  it('renders Prometheus exposition text including custom metrics', async () => {
    jobsProcessed.inc({ kind: 'meeting_ingest', outcome: 'done' });
    const text = await renderMetrics();
    expect(text).toContain('jobs_processed_total');
    expect(text).toContain('job_queue_depth');
  });
});
