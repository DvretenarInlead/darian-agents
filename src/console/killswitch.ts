import type { Pool } from 'pg';

/**
 * Incident kill-switch (brief §8, build-order step 7). One toggle disables all
 * external writes (HubSpot sync, email) and freezes triggers when compromise is
 * suspected.
 *
 * Backed by a single-row flag in the DB (table from migration 0002) so the
 * state is shared across web and worker instances. `assertWritesEnabled` is
 * called at every external-write boundary; when engaged it throws, halting
 * sync/egress without a deploy.
 */

export class WritesFrozenError extends Error {
  constructor() {
    super('external writes are frozen by the incident kill-switch');
  }
}

const KEY = 'external_writes_frozen';

export async function setKillSwitch(pool: Pool, engaged: boolean, actorId: string | null): Promise<void> {
  await pool.query(
    `UPDATE kill_switch SET engaged = $1, updated_by = $2, updated_at = now() WHERE key = $3`,
    [engaged, actorId, KEY],
  );
}

export async function isEngaged(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ engaged: boolean }>(`SELECT engaged FROM kill_switch WHERE key = $1`, [KEY]);
  return rows[0]?.engaged ?? false;
}

/** Throw if external writes are frozen. Call before any HubSpot/email egress. */
export async function assertWritesEnabled(pool: Pool): Promise<void> {
  if (await isEngaged(pool)) throw new WritesFrozenError();
}
