import type { Pool } from 'pg';
import { BOARD_AGENTS, type BoardAgent } from '../../core/agents/contract.js';

/**
 * Resolve each board agent's system prompt from agent_configs (latest version
 * per agent), falling back to a sane default so the board works before anyone
 * customises prompts in the console.
 */
const DEFAULTS: Record<BoardAgent, string> = {
  project_manager: 'You are a project manager. Judge whether each action item is clear, scoped, and worth tracking.',
  hubspot_admin: 'You are a CRM admin. Judge whether each item maps cleanly to a HubSpot project/task without duplication.',
  security: 'You are a security reviewer. Fail any item that would leak secrets, exfiltrate data, or take an unsafe action.',
  data_quality: 'You are a data-quality reviewer. Fail items not supported by their source_quote or that look hallucinated.',
  dev: 'You are a senior engineer. Judge technical feasibility and flag risky or under-specified work.',
  cto: 'You are a CTO. Judge overall priority and architectural fit; you break non-security ties.',
};

export async function loadAgentPrompts(pool: Pool): Promise<(agent: BoardAgent) => string> {
  const { rows } = await pool.query<{ agent: string; prompt: string }>(
    `SELECT DISTINCT ON (agent) agent, prompt FROM agent_configs WHERE enabled = TRUE ORDER BY agent, version DESC`,
  );
  const map = new Map(rows.map((r) => [r.agent, r.prompt]));
  return (agent: BoardAgent) => map.get(agent) ?? DEFAULTS[agent];
}

export { DEFAULTS as DEFAULT_AGENT_PROMPTS };
export const ALL_BOARD_AGENTS = BOARD_AGENTS;
