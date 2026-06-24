import type { Pool } from 'pg';
import { z } from 'zod';

/**
 * Trigger registry backed by trigger_configs (build-order step 4).
 *
 * Three trigger kinds: `webhook`, `cron`, and `on_demand` ("run now"). The
 * `spec` JSONB is kind-specific and validated on load so a malformed/edited
 * config surfaces as a clear error rather than a downstream surprise.
 */

export type TriggerKind = 'webhook' | 'cron' | 'on_demand';

export const WebhookSpec = z.object({
  /** Logical source, e.g. 'fireflies'. */
  source: z.string().min(1),
  /** Header carrying the delivery id used for dedupe. */
  deliveryIdHeader: z.string().min(1).default('x-delivery-id'),
});

export const CronSpec = z.object({
  /** 5-field cron expression, interpreted by the scheduler. */
  expression: z.string().min(1),
  /** Stable key used for the advisory lock (defaults to the trigger id). */
  jobKey: z.string().min(1).optional(),
});

export const OnDemandSpec = z.object({
  /** What running "now" does, e.g. 'repo_score' | 'meeting_replay'. */
  action: z.string().min(1),
});

export interface TriggerConfig {
  id: string;
  kind: TriggerKind;
  spec: unknown;
  enabled: boolean;
}

const SPEC_VALIDATORS: Record<TriggerKind, z.ZodTypeAny> = {
  webhook: WebhookSpec,
  cron: CronSpec,
  on_demand: OnDemandSpec,
};

/** Validate a trigger's spec against its kind; throws on mismatch. */
export function validateTriggerSpec(kind: TriggerKind, spec: unknown): unknown {
  const validator = SPEC_VALIDATORS[kind];
  if (!validator) throw new Error(`unknown trigger kind '${kind}'`);
  return validator.parse(spec);
}

export async function loadTriggers(pool: Pool, kind?: TriggerKind): Promise<TriggerConfig[]> {
  const params: unknown[] = [];
  let where = 'WHERE enabled = TRUE';
  if (kind) {
    params.push(kind);
    where += ` AND kind = $1`;
  }
  const { rows } = await pool.query<{ id: string; kind: TriggerKind; spec: unknown; enabled: boolean }>(
    `SELECT id, kind, spec, enabled FROM trigger_configs ${where} ORDER BY kind`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    spec: validateTriggerSpec(r.kind, r.spec),
    enabled: r.enabled,
  }));
}
