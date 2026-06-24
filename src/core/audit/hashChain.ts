import { createHash } from 'node:crypto';

/**
 * Tamper-evident hash chain for the audit log (brief §7).
 *
 * Each row stores the hash of the previous row plus a hash over its own
 * canonicalised content. Any edit or deletion of an earlier row breaks every
 * subsequent hash, so tampering is *detectable* even though the DB-level
 * append-only grant already makes it *hard*. This module is pure (no I/O) so it
 * is trivially unit-testable; persistence/redaction live in the audit writer.
 */

export interface AuditEntryInput {
  eventType: string;
  product: string | null;
  actorId: string | null;
  subjectId: string | null;
  /** Already secret-scanned + redacted payload. */
  payload: unknown;
  createdAt: string; // ISO-8601 — passed in, never read from a clock here
}

/**
 * Deterministic, key-sorted JSON serialisation so the same logical content
 * always hashes identically regardless of key insertion order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortDeep(obj[key]);
    }
    return out;
  }
  return value;
}

/** Hash of one row given the prior row's hash (null for the genesis row). */
export function computeRowHash(entry: AuditEntryInput, prevHash: string | null): string {
  const canonical = canonicalize({
    eventType: entry.eventType,
    product: entry.product,
    actorId: entry.actorId,
    subjectId: entry.subjectId,
    payload: entry.payload,
    createdAt: entry.createdAt,
  });
  return createHash('sha256')
    .update(prevHash ?? '')
    .update('\n')
    .update(canonical)
    .digest('hex');
}

export interface ChainLink {
  prevHash: string | null;
  rowHash: string;
}

/** Build the (prev_hash, row_hash) pair for a new entry appended after prevHash. */
export function nextLink(entry: AuditEntryInput, prevHash: string | null): ChainLink {
  return { prevHash, rowHash: computeRowHash(entry, prevHash) };
}

export interface VerifyResult {
  valid: boolean;
  /** Index of the first row whose hash does not reconcile, or -1 if intact. */
  brokenAt: number;
}

/**
 * Verify an ordered slice of the chain. Each row supplies its stored
 * prev_hash/row_hash plus the content needed to recompute the hash.
 */
export function verifyChain(
  rows: Array<AuditEntryInput & { prevHash: string | null; rowHash: string }>,
): VerifyResult {
  let expectedPrev: string | null = rows.length > 0 ? rows[0]!.prevHash : null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.prevHash !== expectedPrev) return { valid: false, brokenAt: i };
    const recomputed = computeRowHash(row, row.prevHash);
    if (recomputed !== row.rowHash) return { valid: false, brokenAt: i };
    expectedPrev = row.rowHash;
  }
  return { valid: true, brokenAt: -1 };
}
