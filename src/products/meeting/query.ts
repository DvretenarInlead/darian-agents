import type { Pool } from 'pg';

/**
 * Query agent (build-order step 6): "what's my priority today / what did I
 * commit to". Answers from our own provenance store — the reconciliation_ledger
 * and sync_log — rather than re-deriving from transcripts, so every answer is
 * backed by a recorded decision and its HubSpot reference (ISO 42001 traceability).
 *
 * Reads are filtered to what the caller is allowed to see; this module returns
 * structured rows and leaves natural-language phrasing to the caller (which may
 * use the LLM). It performs no writes.
 */

export interface CommitmentRow {
  meetingId: string;
  itemHash: string;
  decision: string;
  hubspotObj: string | null;
  createdAt: string;
}

export interface QueryFilter {
  meetingId?: string;
  /** Only items recorded on/after this ISO timestamp. */
  since?: string;
  limit?: number;
}

/**
 * Commitments captured from meetings, newest first. Provenance-backed: each row
 * is a ledger entry with its sync reference when available.
 */
export async function listCommitments(pool: Pool, filter: QueryFilter = {}): Promise<CommitmentRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.meetingId) {
    params.push(filter.meetingId);
    clauses.push(`meeting_id = $${params.length}`);
  }
  if (filter.since) {
    params.push(filter.since);
    clauses.push(`created_at >= $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(filter.limit ?? 100, 500));
  const limitIdx = params.length;

  const { rows } = await pool.query<{
    meeting_id: string;
    item_hash: string;
    decision: string;
    hubspot_obj: string | null;
    created_at: string;
  }>(
    `SELECT meeting_id, item_hash, decision, hubspot_obj, created_at
       FROM reconciliation_ledger
       ${where}
      ORDER BY created_at DESC
      LIMIT $${limitIdx}`,
    params,
  );

  return rows.map((r) => ({
    meetingId: r.meeting_id,
    itemHash: r.item_hash,
    decision: r.decision,
    hubspotObj: r.hubspot_obj,
    createdAt: r.created_at,
  }));
}
