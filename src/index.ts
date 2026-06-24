import Fastify from 'fastify';
import { config } from './config/index.js';
import { getPool, closePool } from './core/db/index.js';
import { createWebhookReceiver } from './web/webhookReceiver.js';
import { appendAudit } from './core/audit/writer.js';

/**
 * Application entrypoint (web service). At this foundation stage it boots
 * Fastify, validates config, and exposes health/readiness probes. Product
 * routes (webhook receiver, console API, repo-scoring) attach here as they land
 * in later build-order steps.
 */
export function buildServer() {
  const cfg = config();
  const app = Fastify({ logger: { level: cfg.logLevel } });

  // Liveness — process is up.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness — dependencies reachable (DB ping).
  app.get('/readyz', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ready' };
    } catch (err) {
      app.log.error({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  // Webhook receiver (Product A ingestion). Registered only when a signing
  // secret is configured; the verified delivery is recorded to the audit log
  // and handed to the worker (full pipeline lands in a later build step).
  if (cfg.fireflies.webhookSecret) {
    void app.register(
      createWebhookReceiver({
        pool: getPool(),
        secret: cfg.fireflies.webhookSecret,
        toleranceSec: cfg.fireflies.timestampToleranceSec,
        onVerified: async ({ source, deliveryId, body }) => {
          await appendAudit(
            getPool(),
            {
              eventType: 'ingest',
              product: 'meeting',
              actorId: null,
              subjectId: deliveryId,
              payload: { source, body },
            },
            new Date().toISOString(),
          );
        },
      }),
    );
  }

  return app;
}

async function start(): Promise<void> {
  const cfg = config();
  const app = buildServer();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
