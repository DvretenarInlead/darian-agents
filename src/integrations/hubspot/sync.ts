import type { Pool } from 'pg';
import type { HubSpotClient } from './client.js';
import type { SyncPlan, SyncResult, SyncPreview } from './types.js';

/**
 * Sync orchestration (build-order step 5). Enforces the brief's invariants:
 *  - **Dry-run first:** always preview; the preview is logged to sync_log
 *    (outcome 'previewed') before any write.
 *  - **Board-approved only:** apply() requires the caller to pass approved=true,
 *    which is set only after the review board clears the subject. There is no
 *    path to apply without an explicit approval flag.
 *  - Every apply is logged to sync_log (outcome 'applied' | 'failed').
 *
 * A plan with zero ops (everything reconciled away as duplicates) short-circuits
 * — nothing is previewed or applied.
 */

export interface SyncOutcome {
  preview: SyncPreview;
  result?: SyncResult;
  skipped: boolean;
}

async function logSync(
  pool: Pool,
  subjectId: string,
  dryRun: boolean,
  outcome: 'previewed' | 'applied' | 'failed',
  hubspotRef: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO sync_log (subject_id, dry_run, outcome, hubspot_ref) VALUES ($1, $2, $3, $4)`,
    [subjectId, dryRun, outcome, hubspotRef],
  );
}

export async function runSync(
  pool: Pool,
  client: HubSpotClient,
  plan: SyncPlan,
  approved: boolean,
): Promise<SyncOutcome> {
  const preview = await client.preview(plan);

  if (plan.ops.length === 0) {
    return { preview, skipped: true };
  }

  // Dry-run preview is always recorded before any write.
  await logSync(pool, plan.subjectId, true, 'previewed', null);

  if (!approved) {
    return { preview, skipped: false };
  }

  try {
    const result = await client.apply(plan);
    const ref = result.refs.map((r) => r.projectId).join(',') || null;
    await logSync(pool, plan.subjectId, false, 'applied', ref);
    return { preview, result, skipped: false };
  } catch (err) {
    await logSync(pool, plan.subjectId, false, 'failed', null);
    throw err;
  }
}
