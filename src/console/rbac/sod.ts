import type { Pool } from 'pg';

/**
 * Separation of duties (build-order step 7): the identity that configured a
 * subject (edited an agent prompt, the safe/unsafe table, etc.) **cannot
 * self-approve** its own escalation. Enforced in code, evidenced in
 * sod_action_log.
 */

export type SodAction = 'configured' | 'approved' | 'rejected';

export interface SodEntry {
  subjectId: string;
  action: SodAction;
  actorId: string;
}

export class SeparationOfDutiesError extends Error {}

/** Pure rule: an actor who configured this subject may not approve it. */
export function canApprove(actorId: string, subjectId: string, history: SodEntry[]): boolean {
  return !history.some(
    (e) => e.subjectId === subjectId && e.action === 'configured' && e.actorId === actorId,
  );
}

export function assertCanApprove(actorId: string, subjectId: string, history: SodEntry[]): void {
  if (!canApprove(actorId, subjectId, history)) {
    throw new SeparationOfDutiesError(
      `actor ${actorId} configured subject ${subjectId} and cannot self-approve it`,
    );
  }
}

/** Record an SoD-relevant action (append-only evidence). */
export async function recordSodAction(pool: Pool, entry: SodEntry): Promise<void> {
  await pool.query(
    `INSERT INTO sod_action_log (subject_id, action, actor_id) VALUES ($1, $2, $3)`,
    [entry.subjectId, entry.action, entry.actorId],
  );
}

/** DB-backed approval guard: loads history for a subject and applies the rule. */
export async function assertApprovalAllowed(pool: Pool, actorId: string, subjectId: string): Promise<void> {
  const { rows } = await pool.query<{ subject_id: string; action: SodAction; actor_id: string }>(
    `SELECT subject_id, action, actor_id FROM sod_action_log WHERE subject_id = $1`,
    [subjectId],
  );
  const history: SodEntry[] = rows.map((r) => ({ subjectId: r.subject_id, action: r.action, actorId: r.actor_id }));
  assertCanApprove(actorId, subjectId, history);
}
