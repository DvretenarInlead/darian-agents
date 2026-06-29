import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger } from 'pino';
import { config } from '../../config/index.js';

/**
 * One structured logger for web + worker (code-review P2) — replaces the
 * Fastify-pino / worker-console.log split. A correlation id (request id on the
 * web, job id on the worker) is carried in AsyncLocalStorage and auto-attached
 * to every log line and available to the audit writer, so a single run is
 * traceable end-to-end across logs and the audit trail.
 */

const correlationStore = new AsyncLocalStorage<string>();

let base: Logger | undefined;
function baseLogger(): Logger {
  if (!base) {
    base = pino({ level: safeLevel(), base: { service: 'darian-agents' } });
  }
  return base;
}

function safeLevel(): string {
  try {
    return config().logLevel;
  } catch {
    return 'info';
  }
}

/** Run `fn` within a correlation-id context; nested logs inherit the id. */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return correlationStore.run(correlationId, fn);
}

export function currentCorrelationId(): string | undefined {
  return correlationStore.getStore();
}

/** Bind a correlation id to the current async context (e.g. a Fastify request). */
export function enterCorrelation(correlationId: string): void {
  correlationStore.enterWith(correlationId);
}

/** The logger, bound to the current correlation id when one is active. */
export function log(): Logger {
  const cid = currentCorrelationId();
  return cid ? baseLogger().child({ correlationId: cid }) : baseLogger();
}
