import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { hashToken, verifyToken } from '../console/auth/session.js';
import { isIpAllowed, parseAllowlist } from '../core/net/ipAllowlist.js';
import { InMemoryRateLimiter, type RateLimiter } from '../core/triggers/rateLimiter.js';
import { appendAudit, type AuditEvent } from '../core/audit/writer.js';
import type { LlmClient } from '../integrations/anthropic/client.js';
import type { VoiceClient } from '../integrations/elevenlabs/client.js';
import {
  askAssistant,
  QUESTION_MAX,
  HISTORY_MAX_TURNS,
  HISTORY_TEXT_MAX,
  type AssistantDeps,
  type AssistantTurn,
} from '../products/meeting/assistant.js';
import { FREE_TEXT_MAX } from '../core/agents/contract.js';
import { ASSISTANT_PAGE } from './assistantPage.js';

/**
 * Personal-assistant surface (voice HUD): GET /assistant serves the laptop HUD
 * page; POST /api/assistant/ask answers a question via the assistant agent;
 * /api/assistant/tts and /stt proxy the voice provider (ears + mouth) when one
 * is configured, so no provider key ever reaches the browser.
 *
 * Defence order, matching the webhook receiver's posture:
 *   1. IP allowlist (deny-by-default, CIDR-capable) — gates the HUD page AND
 *      the API; an empty allowlist means nobody gets in. Behind a proxy/LB the
 *      client IP comes from X-Forwarded-For, so TRUST_PROXY must be set there
 *      for this check to see the real caller.
 *   2. Body size/shape cap (schema / audio bodyLimit).
 *   3. Rate limit by IP — a voice UI retriggers easily; bound provider spend.
 *   4. Constant-time bearer-token check (token configured via env, compared as
 *      hashes with timingSafeEqual — never with ===).
 * Every answered or refused question is appended to the audit chain, so the
 * assistant's read path is as traceable as the pipeline's write path.
 */

/** MediaRecorder chunks are small; cap uploads well above a spoken question. */
const AUDIO_BODY_LIMIT = 8_000_000; // 8 MB ≈ several minutes of Opus

export interface AssistantRoutesOptions {
  pool: Pool;
  llm: LlmClient;
  /** Fast model override for spoken answers (latency over depth). */
  model?: string;
  /** Voice provider (TTS+STT). Omit → HUD falls back to browser voice. */
  voice?: VoiceClient;
  /** Read-only Fireflies lookup tools for the assistant; omit → ledger-only. */
  fireflies?: AssistantDeps['fireflies'];
  /** HubSpot task tools for voice commands; writes are kill-switch gated. */
  taskOps?: AssistantDeps['taskOps'];
  /** Loads the console-editable skill block for the system prompt. */
  loadSkill?: () => Promise<string>;
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

    // Raw-buffer parser for recorded question audio (scoped to this plugin).
    for (const type of ['audio/webm', 'audio/ogg', 'audio/mp4', 'application/octet-stream']) {
      app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: AUDIO_BODY_LIMIT }, (_req, body, done) =>
        done(null, body),
      );
    }

    /** Rate-limit + bearer-token gate shared by all POST endpoints. Sends the error reply itself. */
    async function authorize(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
      const rl = await limiter.consume([`assistant:ip:${req.ip}`], nowMs());
      if (!rl.allowed) {
        await reply
          .code(429)
          .header('retry-after', Math.ceil((rl.resetAtMs - nowMs()) / 1000))
          .send({ error: 'rate_limited' });
        return false;
      }
      const auth = String(req.headers.authorization ?? '');
      const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
      if (!presented || !verifyToken(presented, tokenHash)) {
        await reply.code(401).send({ error: 'unauthorized' });
        return false;
      }
      return true;
    }

    app.get('/assistant', async (_req, reply) => {
      return reply.header('content-type', 'text/html; charset=utf-8').send(ASSISTANT_PAGE);
    });

    // Capability probe: lets the HUD decide between provider voice and the
    // browser fallback. IP-gated like everything else; reveals nothing secret.
    app.get('/api/assistant/voice', async () => ({ tts: Boolean(opts.voice), stt: Boolean(opts.voice) }));

    app.post(
      '/api/assistant/ask',
      {
        schema: {
          body: {
            type: 'object',
            required: ['question'],
            additionalProperties: false,
            properties: {
              question: { type: 'string', minLength: 1, maxLength: QUESTION_MAX },
              // Recent conversation turns for follow-up questions; bounded and
              // re-sanitized server-side (normalizeHistory) before prompting.
              history: {
                type: 'array',
                maxItems: HISTORY_MAX_TURNS,
                items: {
                  type: 'object',
                  required: ['role', 'content'],
                  additionalProperties: false,
                  properties: {
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string', maxLength: HISTORY_TEXT_MAX },
                  },
                },
              },
            },
          },
        },
      },
      async (req, reply) => {
        if (!(await authorize(req, reply))) return reply;

        const { question, history } = req.body as { question: string; history?: AssistantTurn[] };
        const skillPrompt = opts.loadSkill ? await opts.loadSkill() : undefined;
        const result = await askAssistant(
          {
            pool: opts.pool,
            llm: opts.llm,
            ...(skillPrompt ? { skillPrompt } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.fireflies ? { fireflies: opts.fireflies } : {}),
            ...(opts.taskOps ? { taskOps: opts.taskOps } : {}),
          },
          question,
          history,
        );

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
              toolCalls: result.toolCalls,
              answer: result.answer,
            },
          },
          nowIso(),
        );

        return { answer: result.answer, refused: result.flagged.length > 0 };
      },
    );

    // Mouth: synthesize an answer. Text is length-capped to the same bound as
    // agent free-text, and the provider key stays server-side.
    app.post(
      '/api/assistant/tts',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: { text: { type: 'string', minLength: 1, maxLength: FREE_TEXT_MAX } },
          },
        },
      },
      async (req, reply) => {
        if (!opts.voice) return reply.code(501).send({ error: 'voice_not_configured' });
        if (!(await authorize(req, reply))) return reply;
        const { text } = req.body as { text: string };
        const out = await opts.voice.tts(text);
        return reply.header('content-type', out.mime).send(out.audio);
      },
    );

    // Ears: transcribe a recorded question. Raw audio in, plain text out; the
    // transcript then goes through /ask like any typed question.
    app.post('/api/assistant/stt', async (req, reply) => {
      if (!opts.voice) return reply.code(501).send({ error: 'voice_not_configured' });
      if (!(await authorize(req, reply))) return reply;
      const audio = req.body as Buffer | undefined;
      if (!audio || !Buffer.isBuffer(audio) || audio.length === 0) {
        return reply.code(400).send({ error: 'empty_audio' });
      }
      const mime = String(req.headers['content-type'] ?? 'audio/webm').split(';')[0]!;
      const text = await opts.voice.stt(audio, mime);
      return { text };
    });
  };

  return plugin;
}
