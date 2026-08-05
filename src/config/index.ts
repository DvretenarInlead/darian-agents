import { z } from 'zod';

/**
 * Central, validated configuration. All process.env access funnels through here
 * so the rest of the app sees a typed, sane config object and the process fails
 * fast at boot if a required secret is missing in production.
 *
 * Secrets are read from the environment only (DO App Platform secrets); nothing
 * is hard-coded and nothing is logged from this module.
 */

const csv = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: boolish.default('false'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Managed-Postgres CA certificate (PEM, or base64 of the PEM). Enables full TLS verification. */
  DATABASE_CA_CERT: z.string().optional(),

  ENVELOPE_MASTER_KEY: z.string().optional(),
  ENVELOPE_KEY_VERSION: z.coerce.number().int().positive().default(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_DEFAULT_MODEL: z.string().default('claude-opus-4-8'),
  /** Fast model for the voice assistant — spoken answers need latency, not deep reasoning. */
  ASSISTANT_MODEL: z.string().default('claude-haiku-4-5-20251001'),

  FIREFLIES_API_KEY: z.string().optional(),
  FIREFLIES_WEBHOOK_SECRET: z.string().optional(),
  /** Poll interval for pull-based ingestion (minutes). 0 disables the poller. */
  FIREFLIES_POLL_MINUTES: z.coerce.number().int().min(0).default(10),
  WEBHOOK_TIMESTAMP_TOLERANCE_SEC: z.coerce.number().int().positive().default(300),

  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_SERVICE_KEY: z.string().optional(),
  HUBSPOT_PROJECTS_API_VERSION: z.string().default('2026-03'),

  GITHUB_TOKEN: z.string().optional(),

  /** Shared secret for the personal-assistant HUD; the route registers only when set. */
  ASSISTANT_ACCESS_TOKEN: z.string().min(16).optional(),

  /** Shared secret for the platform MCP server (/mcp); the route registers only when set. */
  MCP_ACCESS_TOKEN: z.string().min(16).optional(),

  /** Slack pings (bot token + target channel). Both set → the notifier activates. */
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_CHANNEL_ID: z.string().optional(),

  /** ElevenLabs (assistant voice: TTS + STT). Unset → HUD falls back to browser voice. */
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().default('21m00Tcm4TlvDq8ikWAM'),
  /** CSV of IPs/CIDRs allowed to reach the assistant. Deny-by-default: empty = nobody. */
  ASSISTANT_ALLOWED_IPS: z.string().optional(),

  /** Trust X-Forwarded-For from the fronting proxy/LB (required on DO App Platform for real client IPs). */
  TRUST_PROXY: boolish.default('false'),

  SESSION_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
  SESSION_IDLE_TTL_SEC: z.coerce.number().int().positive().default(1800),
  SESSION_ABSOLUTE_TTL_SEC: z.coerce.number().int().positive().default(43200),
  SUDO_REAUTH_WINDOW_SEC: z.coerce.number().int().positive().default(300),

  EGRESS_ALLOWLIST: z.string().optional(),

  AUDIT_SHIP_ENDPOINT: z.string().optional(),
  AUDIT_SHIP_TOKEN: z.string().optional(),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface Config {
  env: RawEnv['NODE_ENV'];
  port: number;
  logLevel: RawEnv['LOG_LEVEL'];
  db: { url: string; ssl: boolean; poolMax: number; caCert: string | undefined };
  envelope: { masterKey: string | undefined; keyVersion: number };
  anthropic: { apiKey: string | undefined; defaultModel: string; assistantModel: string };
  fireflies: { apiKey: string | undefined; webhookSecret: string | undefined; timestampToleranceSec: number; pollMinutes: number };
  hubspot: { accessToken: string | undefined; serviceKey: string | undefined; projectsApiVersion: string };
  github: { token: string | undefined };
  assistant: { accessToken: string | undefined; allowedIps: string[] };
  mcp: { accessToken: string | undefined };
  slack: { botToken: string | undefined; channelId: string | undefined };
  elevenlabs: { apiKey: string | undefined; voiceId: string };
  trustProxy: boolean;
  session: { accessTtlSec: number; idleTtlSec: number; absoluteTtlSec: number; sudoWindowSec: number };
  egressAllowlist: string[];
  auditShip: { endpoint: string | undefined; token: string | undefined };
}

function build(raw: RawEnv): Config {
  return {
    env: raw.NODE_ENV,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    db: { url: raw.DATABASE_URL, ssl: raw.DATABASE_SSL, poolMax: raw.DATABASE_POOL_MAX, caCert: raw.DATABASE_CA_CERT },
    envelope: { masterKey: raw.ENVELOPE_MASTER_KEY, keyVersion: raw.ENVELOPE_KEY_VERSION },
    anthropic: { apiKey: raw.ANTHROPIC_API_KEY, defaultModel: raw.ANTHROPIC_DEFAULT_MODEL, assistantModel: raw.ASSISTANT_MODEL },
    fireflies: {
      apiKey: raw.FIREFLIES_API_KEY,
      webhookSecret: raw.FIREFLIES_WEBHOOK_SECRET,
      timestampToleranceSec: raw.WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
      pollMinutes: raw.FIREFLIES_POLL_MINUTES,
    },
    hubspot: {
      accessToken: raw.HUBSPOT_ACCESS_TOKEN,
      serviceKey: raw.HUBSPOT_SERVICE_KEY,
      projectsApiVersion: raw.HUBSPOT_PROJECTS_API_VERSION,
    },
    github: { token: raw.GITHUB_TOKEN },
    assistant: { accessToken: raw.ASSISTANT_ACCESS_TOKEN, allowedIps: csv(raw.ASSISTANT_ALLOWED_IPS) },
    mcp: { accessToken: raw.MCP_ACCESS_TOKEN },
    slack: { botToken: raw.SLACK_BOT_TOKEN, channelId: raw.SLACK_CHANNEL_ID },
    elevenlabs: { apiKey: raw.ELEVENLABS_API_KEY, voiceId: raw.ELEVENLABS_VOICE_ID },
    trustProxy: raw.TRUST_PROXY,
    session: {
      accessTtlSec: raw.SESSION_ACCESS_TTL_SEC,
      idleTtlSec: raw.SESSION_IDLE_TTL_SEC,
      absoluteTtlSec: raw.SESSION_ABSOLUTE_TTL_SEC,
      sudoWindowSec: raw.SUDO_REAUTH_WINDOW_SEC,
    },
    egressAllowlist: csv(raw.EGRESS_ALLOWLIST),
    auditShip: { endpoint: raw.AUDIT_SHIP_ENDPOINT, token: raw.AUDIT_SHIP_TOKEN },
  };
}

/**
 * Parse and validate the given environment (defaults to process.env).
 * Throws a readable aggregate error if validation fails.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return build(parsed.data);
}

// Lazily-initialised singleton for app code that just wants `config`.
let cached: Config | undefined;
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
