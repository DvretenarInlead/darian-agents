import type { Pool } from 'pg';
import type { Config } from '../../config/index.js';
import { TEAM_AGENT_CATALOG, type TeamAgentSlug } from './catalog.js';
import { TeamBudgetsInput, type TeamBudgets } from './types.js';

export const TEAM_BUDGETS_KEY = 'team_budgets';

const none = (): TeamBudgets => ({ defaultCents: null, perAgent: {} });

/** Operator-set budgets from app_settings; a missing or malformed value is ignored, not trusted. */
export async function loadTeamBudgets(pool: Pool): Promise<TeamBudgets> {
  try {
    const { rows } = await pool.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [TEAM_BUDGETS_KEY]);
    if (!rows[0]) return none();
    const parsed = TeamBudgetsInput.safeParse(rows[0].value);
    return parsed.success ? parsed.data : none();
  } catch {
    return none(); // table missing (pre-migration) or transient error
  }
}

/**
 * perAgent → defaultCents → catalog default → config default. The result is
 * always clamped to cfg.maxBudgetCents, so a setting written before the ceiling
 * was lowered can never exceed it.
 */
export function resolveBudgetCents(b: TeamBudgets, slug: TeamAgentSlug, cfg: Config['team']): number {
  const cents =
    b.perAgent[slug] ?? b.defaultCents ?? TEAM_AGENT_CATALOG[slug].defaultBudgetCents ?? cfg.defaultBudgetCents;
  return Math.min(cents, cfg.maxBudgetCents);
}
