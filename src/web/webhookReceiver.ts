import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { verifyWebhook } from '../core/triggers/webhookVerify.js';
import { recordDelivery } from '../core/triggers/dedupe.js';
import { InMemoryRateLimiter, type RateLimiter } from '../core/triggers/rateLimiter.js';

/**
 * Hardened webhook receiver (brief §1, build-order step 4).
 *
 * Order of defence, before any worker sees the payload:
 *   1. Payload size cap (Fastify bodyLimit) — blunt oversized-payload DoS.
 *   2. Rate limit by IP and source — blunt flood DoS.
 *   3. Constant-time signature verification over `${timestamp}.${rawBody}`.
 *   4. Timestamp tolerance window — reject stale payloads.
 *   5. Delivery-ID dedupe — reject replays of otherwise-valid webhooks.
 * Every receipt is recorded to webhook_deliveries for forensics regardless of
 * outcome. The handler responds fast and hands real work to the worker.
 */

export interface WebhookReceiverOptions {
  pool: Pool;
  secret: string;
  toleranceSec: number;
  /** Max JSON body size in bytes. */
  bodyLimitBytes?: number;
  rateLimit?: { windowMs: number; max: number };
  headers?: {
    signature?: string;
    timestamp?: string;
    deliveryId?: string;
    meetingId?: string;
  };
  /** Called for a fresh, verified delivery. Should enqueue, not process inline. */
  onVerified: (payload: { source: string; deliveryId: string; body: unknown }) => Promise<void> | void;
  /** Shared rate limiter; defaults to per-instance in-memory. Use PgRateLimiter for multi-instance. */
  limiter?: RateLimiter;
  /** Injectable clock for tests (unix seconds). */
  nowSec?: () => number;
}

const DEFAULT_HEADERS = {
  signature: 'x-webhook-signature',
  timestamp: 'x-webhook-timestamp',
  deliveryId: 'x-delivery-id',
  meetingId: 'x-meeting-id',
};

export function createWebhookReceiver(opts: WebhookReceiverOptions): FastifyPluginAsync {
  const headers = { ...DEFAULT_HEADERS, ...opts.headers };
  const bodyLimit = opts.bodyLimitBytes ?? 1_000_000; // 1 MB default
  const limiter = opts.limiter ?? new InMemoryRateLimiter(opts.rateLimit ?? { windowMs: 60_000, max: 120 });
  const now = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    // Encapsulated raw-body parser so we can verify the signature over the exact
    // bytes received. Scoped to this plugin instance only.
    app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit }, (_req, body, done) => {
      (_req as { rawBody?: string }).rawBody = body as string;
      if (body === '') return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    app.post('/webhooks/:source', { config: { rawBody: true } }, async (req, reply) => {
      const nowMs = now() * 1000;
      const ip = req.ip;
      const source = (req.params as { source: string }).source;

      const rl = await limiter.consume([`ip:${ip}`, `src:${source}`], nowMs);
      if (!rl.allowed) {
        return reply.code(429).header('retry-after', Math.ceil((rl.resetAtMs - nowMs) / 1000)).send({ error: 'rate_limited' });
      }

      const rawBody = (req as { rawBody?: string }).rawBody ?? '';
      const signature = String(req.headers[headers.signature] ?? '');
      const timestamp = Number(req.headers[headers.timestamp]);
      const deliveryId = String(req.headers[headers.deliveryId] ?? '');
      const meetingId = req.headers[headers.meetingId] ? String(req.headers[headers.meetingId]) : null;

      if (!signature || !deliveryId || !Number.isFinite(timestamp)) {
        return reply.code(400).send({ error: 'missing_headers' });
      }

      const verdict = verifyWebhook({
        rawBody,
        signatureHeader: signature,
        timestamp,
        secret: opts.secret,
        toleranceSec: opts.toleranceSec,
        nowSec: now(),
      });

      // Record every receipt for forensics, even rejects.
      const { firstDelivery } = await recordDelivery(opts.pool, {
        deliveryId,
        meetingId,
        signatureOk: verdict.signatureOk,
        tsInWindow: verdict.tsInWindow,
      });

      if (!verdict.ok) {
        // Identical response shape/timing for signature vs window failures.
        return reply.code(401).send({ error: 'invalid_signature' });
      }
      if (!firstDelivery) {
        // Idempotent: a replay of a valid webhook is acknowledged but not reprocessed.
        return reply.code(200).send({ status: 'duplicate' });
      }

      await opts.onVerified({ source, deliveryId, body: req.body });
      return reply.code(202).send({ status: 'accepted' });
    });
  };

  return plugin;
}
