import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { hashToken, verifyToken } from '../console/auth/session.js';
import { isIpAllowed, parseAllowlist } from '../core/net/ipAllowlist.js';
import { InMemoryRateLimiter, type RateLimiter } from '../core/triggers/rateLimiter.js';
import { appendAudit, type AuditEvent } from '../core/audit/writer.js';
import type { LlmClient } from '../integrations/anthropic/client.js';
import { askAssistant, QUESTION_MAX } from '../products/meeting/assistant.js';
import { ASSISTANT_PAGE } from './assistantPage.js';

/**
 * Personal-assistant surface (voice HUD): GET /assistant serves the laptop HUD
 * page; POST /api/assistant/ask answers a question via the assistant agent.
 *
 * Defence order, matching the webhook receiver's posture:
 *   1. IP allowlist (deny-by-default, CIDR-capable) — gates the HUD page AND
 *      the API; an empty allowlist means nobody gets in. Behind a proxy/LB the
 *      client IP comes from X-Forwarded-For, so TRUST_PROXY must be set there
 *      for this check to see the real caller.
 *   2. Body size/shape cap (schema, question length bound).
 *   3. Rate limit by IP — a voice UI retriggers easily; bound LLM spend.
 *   4. Constant-time bearer-token check (token configured via env, compared as
 *      hashes with timingSafeEqual — never with ===).
 * Every answered or refused question is appended to the audit chain, so the
 * assistant's read path is as traceable as the pipeline's write path.
 */

export interface AssistantRoutesOptions {
  pool: Pool;
  llm: LlmClient;
  /** Shared secret the HUD presents as `Authorization: Bearer <token>`. */
  accessToken: string;
  /** IPs/CIDRs allowed to reach the assistant at all. Empty = deny everyone. */
  allowedIps: string[];
  rateLimit?: { windowMs: number; max: number };
  /** Shared limiter for multi-instance deploys; defaults to in-memory. */
  limiter?: RateLimiter;
  /** Injectable clocks for tests. */
  nowMs?: () => number;
  nowIso?: () => string;
  /** Injectable audit sink for tests; defaults to the hash-chained writer. */
  audit?: (event: AuditEvent, nowIso: string) => Promise<unknown>;
}

export function createAssistantRoutes(opts: AssistantRoutesOptions): FastifyPluginAsync {
  const limiter = opts.limiter ?? new InMemoryRateLimiter(opts.rateLimit ?? { windowMs: 60_000, max: 20 });
  const nowMs = opts.nowMs ?? (() => Date.now());
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const audit = opts.audit ?? ((event: AuditEvent, at: string) => appendAudit(opts.pool, event, at));
  // Store only the hash so the raw token never sits on the closure longer than needed.
  const tokenHash = hashToken(opts.accessToken);
  // Malformed entries throw here, so a bad allowlist fails the boot, not a request.
  const allowlist = parseAllowlist(opts.allowedIps);

  const plugin: FastifyPluginAsync = async (app: FastifyInstance) => {
    if (allowlist.length === 0) {
      app.log.warn('assistant: IP allowlist is empty — all requests will be denied (403)');
    }

    // Scoped to this plugin: every assistant route is IP-gated before anything else.
    app.addHook('onRequest', async (req, reply) => {
      if (!isIpAllowed(req.ip, allowlist)) {
        req.log.warn({ ip: req.ip, url: req.url }, 'assistant: request from non-allowlisted IP denied');
        return reply.code(403).send({ error: 'forbidden' });
      }
    });

    app.get('/assistant', async (_req, reply) => {
      return reply.header('content-type', 'text/html; charset=utf-8').send(ASSISTANT_PAGE);
    });

    app.post(
      '/api/assistant/ask',
      {
        schema: {
          body: {
            type: 'object',
            required: ['question'],
            additionalProperties: false,
            properties: { question: { type: 'string', minLength: 1, maxLength: QUESTION_MAX } },
          },
        },
      },
      async (req, reply) => {
        const rl = await limiter.consume([`assistant:ip:${req.ip}`], nowMs());
        if (!rl.allowed) {
          return reply
            .code(429)
            .header('retry-after', Math.ceil((rl.resetAtMs - nowMs()) / 1000))
            .send({ error: 'rate_limited' });
        }

        const auth = String(req.headers.authorization ?? '');
        const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
        if (!presented || !verifyToken(presented, tokenHash)) {
          return reply.code(401).send({ error: 'unauthorized' });
        }

        const { question } = req.body as { question: string };
        const result = await askAssistant({ pool: opts.pool, llm: opts.llm }, question);

        await audit(
          {
            eventType: 'ingest',
            product: 'meeting',
            actorId: null,
            subjectId: null,
            payload: {
              kind: 'assistant_query',
              question,
              flagged: result.flagged,
              contextRows: result.contextRows,
              answer: result.answer,
            },
          },
          nowIso(),
        );

        return { answer: result.answer, refused: result.flagged.length > 0 };
      },
    );
  };

  return plugin;
}
