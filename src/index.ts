import Fastify from 'fastify';
import { config } from './config/index.js';
import { getPool, closePool } from './core/db/index.js';
import { createWebhookReceiver } from './web/webhookReceiver.js';
import { meetingIdFromPayload } from './products/meeting/handler.js';
import { createAssistantRoutes } from './web/assistant.js';
import { AnthropicLlmClient } from './integrations/anthropic/client.js';
import { ElevenLabsVoiceClient } from './integrations/elevenlabs/client.js';
import { appendAudit } from './core/audit/writer.js';
import { enqueueJob } from './core/queue/jobs.js';
import { enterCorrelation } from './core/obs/logger.js';
import { registry, renderMetrics } from './core/obs/metrics.js';
import { createConsole } from './console/web/plugin.js';
import { PgUsersRepo, PgSessionsRepo } from './console/web/repos.js';
import { defaultHasher } from './console/auth/password.js';
import { keyringFromConfig } from './core/crypto/envelope.js';

/**
 * Application entrypoint (web service). At this foundation stage it boots
 * Fastify, validates config, and exposes health/readiness probes. Product
 * routes (webhook receiver, console API, repo-scoring) attach here as they land
 * in later build-order steps.
 */
export function buildServer() {
  const cfg = config();
  // trustProxy: behind DO App Platform's LB the client IP arrives via
  // X-Forwarded-For; without this, IP-based checks would see the LB's address.
  const app = Fastify({ logger: { level: cfg.logLevel }, trustProxy: cfg.trustProxy });

  // Bind each request's id as the correlation id for logs + audit.
  app.addHook('onRequest', async (req) => {
    enterCorrelation(String(req.id));
  });

  // Liveness — process is up.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Root: service info so `/` isn't a bare 404. Lists the real endpoints.
  app.get('/', async () => ({
    service: 'darian-agents',
    status: 'ok',
    endpoints: ['/console', '/assistant', '/healthz', '/readyz', '/metrics', 'POST /webhooks/:source'],
  }));

  // Prometheus metrics.
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return renderMetrics();
  });

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
  // secret is configured. A verified delivery is audited and ENQUEUED as a
  // durable job (idempotent on the delivery id); the worker drains the queue and
  // runs the meeting pipeline — decoupling burst ingestion from slow LLM work.
  if (cfg.fireflies.webhookSecret) {
    void app.register(
      createWebhookReceiver({
        pool: getPool(),
        secret: cfg.fireflies.webhookSecret,
        toleranceSec: cfg.fireflies.timestampToleranceSec,
        onVerified: async ({ source, deliveryId, body }) => {
          const pool = getPool();
          await appendAudit(
            pool,
            { eventType: 'ingest', product: 'meeting', actorId: null, subjectId: deliveryId, payload: { source, body } },
            new Date().toISOString(),
          );
          // Dedupe on the MEETING id when the payload carries one, so the
          // webhook and the backstop poller can never double-ingest the same
          // meeting; delivery id remains the fallback key.
          const meetingId = meetingIdFromPayload({ body });
          await enqueueJob(pool, {
            kind: 'meeting_ingest',
            payload: { source, deliveryId, body },
            dedupeKey: `meeting_ingest:${meetingId ?? deliveryId}`,
          });
        },
      }),
    );
  }

  // Admin console (server-rendered UI + auth). Mounted under /console.
  void app.register(
    createConsole({
      pool: getPool(),
      users: new PgUsersRepo(getPool()),
      sessions: new PgSessionsRepo(getPool()),
      hasher: defaultHasher(),
      now: () => new Date(),
      secureCookies: cfg.env === 'production',
      ttls: {
        idleSec: cfg.session.idleTtlSec,
        absoluteSec: cfg.session.absoluteTtlSec,
        sudoWindowSec: cfg.session.sudoWindowSec,
      },
      ...(cfg.envelope.masterKey ? { keyring: keyringFromConfig() } : {}),
    }),
  );

  // Personal-assistant HUD (voice/text query surface over the commitments
  // ledger). Registered only when its shared access token and the Anthropic
  // key are configured; strictly read-only against our own provenance store.
  if (cfg.assistant.accessToken && cfg.anthropic.apiKey) {
    void app.register(
      createAssistantRoutes({
        pool: getPool(),
        llm: new AnthropicLlmClient(),
        model: cfg.anthropic.assistantModel,
        accessToken: cfg.assistant.accessToken,
        allowedIps: cfg.assistant.allowedIps,
        // Provider voice (ears + mouth) only when the key is configured; the
        // HUD falls back to the browser's built-in voice otherwise.
        ...(cfg.elevenlabs.apiKey ? { voice: new ElevenLabsVoiceClient() } : {}),
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
