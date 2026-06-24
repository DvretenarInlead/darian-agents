import type { Pool } from 'pg';
import type { ResolutionPolicyEntry } from './resolution.js';

/**
 * Loads the safe/unsafe resolution policy from Postgres. The table is versioned
 * (configurer edits create new versions); we take the latest version per
 * `condition` so a fix or escalation rule can be revised without losing history.
 */
export async function loadResolutionPolicy(pool: Pool): Promise<ResolutionPolicyEntry[]> {
  const { rows } = await pool.query<{
    condition: string;
    disposition: 'auto_fix' | 'escalate';
    reversible: boolean;
  }>(
    `SELECT DISTINCT ON (condition) condition, disposition, reversible
       FROM resolution_policy
      ORDER BY condition, version DESC`,
  );
  return rows.map((r) => ({
    condition: r.condition,
    disposition: r.disposition,
    reversible: r.reversible,
  }));
}
