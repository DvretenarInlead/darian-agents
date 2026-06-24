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
  if (items.length === 0) return [];

  const hashes = items.map((item) => itemHash(item));
  const distinct = [...new Set(hashes)];

  // Single round-trip: insert the distinct hashes; RETURNING yields only the
  // rows actually inserted (fresh ones). Anything not returned already existed.
  const inserted = await pool.query<{ item_hash: string }>(
    `INSERT INTO reconciliation_ledger (meeting_id, item_hash, decision)
       SELECT $1, h, 'created' FROM unnest($2::text[]) AS h
     ON CONFLICT (meeting_id, item_hash) DO NOTHING
     RETURNING item_hash`,
    [meetingId, distinct],
  );
  const created = new Set(inserted.rows.map((r) => r.item_hash));

  // Map back, also collapsing intra-batch duplicates: only the first occurrence
  // of a fresh hash is 'created'; repeats in the same batch are duplicates.
  const usedInBatch = new Set<string>();
  return items.map((item, i) => {
    const hash = hashes[i]!;
    const fresh = created.has(hash) && !usedInBatch.has(hash);
    if (fresh) usedInBatch.add(hash);
    return { item, itemHash: hash, decision: fresh ? 'created' : 'skipped_duplicate' };
  });
}
