import type { BoardAgent, Verdict } from '../core/agents/contract.js';
import { AGENT_DOMAINS } from '../products/meeting/board.js';

/**
 * Shared test factories. Excluded from the production build (tsconfig.build.json),
 * so these never ship in dist. Centralised here to avoid copy-pasting verdict
 * builders and the agent→domain map across test files.
 */

/** Build a board verdict with sensible defaults; override any field. */
export function makeVerdict(agent: BoardAgent, subjectId: string, over: Partial<Verdict> = {}): Verdict {
  return {
    agent,
    subject_id: subjectId,
    domain: AGENT_DOMAINS[agent],
    disposition: 'pass',
    confidence: 0.9,
    issues: [],
    proposed_fix: null,
    context: null,
    ...over,
  };
}
