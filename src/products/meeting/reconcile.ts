import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ActionItem } from './extract.js';
import type { ItemDecision } from '../../integrations/hubspot/plan.js';

/**
 * Reconciliation (build-order step 6) — "core, not an afterthought".
 *
 * Each item is normalised to a stable `item_hash`; the reconciliation_ledger has
 * a UNIQUE(meeting_id, item_hash), so an `INSERT ... ON CONFLICT DO NOTHING`
 * atomically decides create-vs-duplicate. A re-delivered meeting or a repeated
 * action item can never produce a duplicate HubSpot project/task.
 *
 * normalizeItem/itemHash are pure and unit-tested; the DB step records the
 * decision and is the dedupe source of truth.
 */

/** Canonical form for hashing: lowercased, whitespace-collapsed title + owner. */
export function normalizeItem(item: Pick<ActionItem, 'title' | 'owner_hint'>): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const owner = item.owner_hint ? norm(item.owner_hint) : '';
  return `${norm(item.title)}|${owner}`;
}

export function itemHash(item: Pick<ActionItem, 'title' | 'owner_hint'>): string {
  return createHash('sha256').update(normalizeItem(item)).digest('hex');
}

export interface ReconciledItem {
  item: ActionItem;
  itemHash: string;
  decision: ItemDecision;
}

/**
 * Reconcile a meeting's items against the ledger. Newly-seen items are recorded
 * as `created`; previously-seen hashes are `skipped_duplicate`. Runs each item
 * through an atomic conditional insert so concurrent deliveries stay correct.
 */
export async function reconcileItems(
  pool: Pool,
  meetingId: string,
  items: ActionItem[],
): Promise<ReconciledItem[]> {
  const out: ReconciledItem[] = [];
  for (const item of items) {
    const hash = itemHash(item);
    const res = await pool.query(
      `INSERT INTO reconciliation_ledger (meeting_id, item_hash, decision)
       VALUES ($1, $2, 'created')
       ON CONFLICT (meeting_id, item_hash) DO NOTHING`,
      [meetingId, hash],
    );
    out.push({
      item,
      itemHash: hash,
      decision: res.rowCount === 1 ? 'created' : 'skipped_duplicate',
    });
  }
  return out;
}
