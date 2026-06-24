import type { Pool } from 'pg';
import { config } from '../../config/index.js';
import { nextLink, type AuditEntryInput } from './hashChain.js';
import { redact } from './redact.js';

/**
 * Append-only audit writer (build-order step 2).
 *
 * Guarantees:
 *  - Secrets are redacted from the payload *before* it is hashed or stored.
 *  - Appends are serialised with a transaction-scoped advisory lock so the
 *    hash chain (prev_hash → row_hash) is computed against a stable tail even
 *    under concurrent writers.
 *  - created_at is written explicitly with the exact value that was hashed, so
 *    the stored row is independently re-verifiable by verifyChain().
 *  - The row is shipped off-box best-effort after commit; shipping failure never
 *    fails the local write (the local append is the source of truth).
 *
 * The app role has INSERT + SELECT only on audit_log (see 0001_init.sql), so a
 * compromised process cannot rewrite history even if this code is bypassed.
 */

/** Arbitrary constant key for pg_advisory_xact_lock — serialises audit appends. */
const AUDIT_LOCK_KEY = 0x4155_4454; // 'AUDT'

export type AuditEventType =
  | 'ingest'
  | 'verdict'
  | 'autofix'
  | 'escalation'
  | 'approval'
  | 'external_write'
  | 'config_change'
  | 'auth_event';

export type AuditProduct = 'meeting' | 'repo' | 'console';

export interface AuditEvent {
  eventType: AuditEventType;
  product: AuditProduct | null;
  actorId: string | null;
  subjectId: string | null;
  payload: unknown;
}

export interface AppendResult {
  id: string;
  rowHash: string;
}

export async function appendAudit(pool: Pool, event: AuditEvent, nowIso: string): Promise<AppendResult> {
  const [result] = await appendAuditBatch(pool, [event], nowIso);
  return result!;
}

/**
 * Append several events as one chained, single-transaction batch. The global
 * audit advisory lock is taken ONCE for the whole batch (not per row), so a
 * pipeline that emits many events doesn't serialise the whole system N times.
 * Hashes are chained in array order against the current tail.
 */
export async function appendAuditBatch(pool: Pool, events: AuditEvent[], nowIso: string): Promise<AppendResult[]> {
  if (events.length === 0) return [];

  const entries: AuditEntryInput[] = events.map((event) => ({
    eventType: event.eventType,
    product: event.product,
    actorId: event.actorId,
    subjectId: event.subjectId,
    payload: redact(event.payload),
    createdAt: nowIso,
  }));

  const results: AppendResult[] = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);

    const tail = await client.query<{ row_hash: string }>('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1');
    let prevHash = tail.rows[0]?.row_hash ?? null;

    for (const entry of entries) {
      const { rowHash } = nextLink(entry, prevHash);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO audit_log
           (event_type, product, actor_id, subject_id, payload, prev_hash, row_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [entry.eventType, entry.product, entry.actorId, entry.subjectId, JSON.stringify(entry.payload), prevHash, rowHash, entry.createdAt],
      );
      results.push({ id: inserted.rows[0]!.id, rowHash });
      prevHash = rowHash;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Best-effort off-box shipping; never blocks or fails the local append.
  entries.forEach((entry, i) => void shipOffBox({ ...entry, id: results[i]!.id, prevHashRow: results[i]!.rowHash }));
  return results;
}

async function shipOffBox(row: AuditEntryInput & { id: string; prevHashRow: string }): Promise<void> {
  try {
    const cfg = config();
    if (!cfg.auditShip.endpoint) return;
    await fetch(cfg.auditShip.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.auditShip.token ? { authorization: `Bearer ${cfg.auditShip.token}` } : {}),
      },
      body: JSON.stringify(row),
    });
  } catch {
    // Swallow: local append already committed. A shipping monitor/retry job
    // (later build step) reconciles gaps; we do not lose the local record.
  }
}
