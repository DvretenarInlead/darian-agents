import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics (code-review P2). A single registry exposed at /metrics.
 * Instruments the operationally-interesting signals: jobs processed by outcome,
 * board latency, sync outcomes, escalation rate, and queue depth.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const jobsProcessed = new Counter({
  name: 'jobs_processed_total',
  help: 'Jobs processed by kind and outcome',
  labelNames: ['kind', 'outcome'] as const,
  registers: [registry],
});

export const boardLatency = new Histogram({
  name: 'board_latency_seconds',
  help: 'Review-board wall time per subject batch',
  labelNames: ['product'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const syncOutcomes = new Counter({
  name: 'sync_outcomes_total',
  help: 'HubSpot sync outcomes',
  labelNames: ['outcome'] as const, // previewed | applied | failed | skipped
  registers: [registry],
});

export const escalations = new Counter({
  name: 'escalations_total',
  help: 'Items routed to the escalation queue',
  labelNames: ['product'] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'job_queue_depth',
  help: 'Pending jobs in the queue',
  registers: [registry],
});

export const teamEventsProcessed = new Counter({
  name: 'team_events_processed_total',
  help: 'PYB Team session events handled by type and outcome',
  labelNames: ['type', 'outcome'] as const, // outcome: processed | duplicate | error
  registers: [registry],
});

export const teamStreamsOpen = new Gauge({
  name: 'team_streams_open',
  help: 'Managed Agents session event streams currently held by this worker',
  registers: [registry],
});

/** Render the metrics exposition text (Content-Type from registry.contentType). */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}
