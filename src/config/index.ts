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

  ENVELOPE_MASTER_KEY: z.string().optional(),
  ENVELOPE_KEY_VERSION: z.coerce.number().int().positive().default(1),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_DEFAULT_MODEL: z.string().default('claude-opus-4-8'),

  FIREFLIES_API_KEY: z.string().optional(),
  FIREFLIES_WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_TIMESTAMP_TOLERANCE_SEC: z.coerce.number().int().positive().default(300),

  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_SERVICE_KEY: z.string().optional(),
  HUBSPOT_PROJECTS_API_VERSION: z.string().default('2026-03'),

  GITHUB_TOKEN: z.string().optional(),

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
  db: { url: string; ssl: boolean; poolMax: number };
  envelope: { masterKey: string | undefined; keyVersion: number };
  anthropic: { apiKey: string | undefined; defaultModel: string };
  fireflies: { apiKey: string | undefined; webhookSecret: string | undefined; timestampToleranceSec: number };
  hubspot: { accessToken: string | undefined; serviceKey: string | undefined; projectsApiVersion: string };
  github: { token: string | undefined };
  session: { accessTtlSec: number; idleTtlSec: number; absoluteTtlSec: number; sudoWindowSec: number };
  egressAllowlist: string[];
  auditShip: { endpoint: string | undefined; token: string | undefined };
}

function build(raw: RawEnv): Config {
  return {
    env: raw.NODE_ENV,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    db: { url: raw.DATABASE_URL, ssl: raw.DATABASE_SSL, poolMax: raw.DATABASE_POOL_MAX },
    envelope: { masterKey: raw.ENVELOPE_MASTER_KEY, keyVersion: raw.ENVELOPE_KEY_VERSION },
    anthropic: { apiKey: raw.ANTHROPIC_API_KEY, defaultModel: raw.ANTHROPIC_DEFAULT_MODEL },
    fireflies: {
      apiKey: raw.FIREFLIES_API_KEY,
      webhookSecret: raw.FIREFLIES_WEBHOOK_SECRET,
      timestampToleranceSec: raw.WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
    },
    hubspot: {
      accessToken: raw.HUBSPOT_ACCESS_TOKEN,
      serviceKey: raw.HUBSPOT_SERVICE_KEY,
      projectsApiVersion: raw.HUBSPOT_PROJECTS_API_VERSION,
    },
    github: { token: raw.GITHUB_TOKEN },
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
