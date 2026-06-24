import type { BoardAgent, Verdict } from '../../core/agents/contract.js';
import { BOARD_AGENTS, parseVerdict } from '../../core/agents/contract.js';
import { guardVerdictOutput, type GuardFinding } from '../../core/governance/outputGuard.js';
import { resolveBoard, type BoardDecision, type ResolutionPolicyEntry } from '../../core/orchestrator/resolution.js';
import type { LlmClient } from '../../integrations/anthropic/client.js';
import { extractJson } from '../../integrations/anthropic/client.js';

/**
 * Review board for a meeting's action items (build-order step 6).
 *
 * Batched: one call per agent for ALL of the meeting's items (brief). Each
 * agent's output is schema-validated (parseVerdict) and run through the
 * output-side injection guard before it reaches resolution; quarantined verdicts
 * are withheld and surfaced for audit. Per-item resolution reuses the pure
 * orchestrator engine (Security veto, CTO tie-break).
 */

export interface BoardSubject {
  subjectId: string; // item hash
  title: string;
  description: string | null;
  ownerHint: string | null;
  dueHint: string | null;
}

export interface BoardRunner {
  /** One call per agent for the whole batch; returns one verdict per subject. */
  reviewBatch(agent: BoardAgent, subjects: BoardSubject[]): Promise<Verdict[]>;
}

export interface Quarantine {
  agent: string;
  subjectId: string;
  findings: GuardFinding[];
}

export interface BoardOutcome {
  decisions: Map<string, BoardDecision>;
  quarantines: Quarantine[];
  /** Agents whose batched call failed; their subjects fail-closed to escalation. */
  failedAgents: BoardAgent[];
}

export interface RunBoardDeps {
  runner: BoardRunner;
  /** Defaults to all six board agents. */
  agents?: BoardAgent[];
  policy: ResolutionPolicyEntry[];
}

export async function runBoard(deps: RunBoardDeps, subjects: BoardSubject[]): Promise<BoardOutcome> {
  const agents = deps.agents ?? [...BOARD_AGENTS];
  const quarantines: Quarantine[] = [];
  const failedAgents: BoardAgent[] = [];

  // One batched call per agent, in parallel. allSettled so a single agent's
  // failure (LLM error/timeout) doesn't reject the whole board — that agent
  // simply contributes no verdicts, and every subject then escalates for the
  // missing required agent (fail-closed).
  const settled = await Promise.allSettled(agents.map((agent) => deps.runner.reviewBatch(agent, subjects)));
  const perAgent = settled.map((res, i) => {
    const agent = agents[i]!;
    if (res.status === 'fulfilled') return { agent, verdicts: res.value };
    failedAgents.push(agent);
    return { agent, verdicts: [] as Verdict[] };
  });

  // subjectId -> verdicts that passed the output guard
  const bySubject = new Map<string, Verdict[]>();
  for (const { verdicts } of perAgent) {
    for (const verdict of verdicts) {
      const guard = guardVerdictOutput(verdict);
      if (!guard.pass && guard.quarantine) {
        quarantines.push(guard.quarantine);
        continue; // quarantined: withheld from resolution
      }
      const list = bySubject.get(verdict.subject_id) ?? [];
      list.push(verdict);
      bySubject.set(verdict.subject_id, list);
    }
  }

  const decisions = new Map<string, BoardDecision>();
  for (const subject of subjects) {
    const verdicts = bySubject.get(subject.subjectId) ?? [];
    if (verdicts.length === 0) {
      // No usable verdict for this subject (all quarantined/missing) → escalate.
      decisions.set(subject.subjectId, {
        subjectId: subject.subjectId,
        outcome: 'escalate',
        vetoed: false,
        autoFixes: [],
        escalationReasons: ['no usable verdict (missing or quarantined)'],
        rationale: 'Escalated: no usable verdict for this subject.',
      });
      continue;
    }
    decisions.set(subject.subjectId, resolveBoard(verdicts, deps.policy, { requiredAgents: agents }));
  }

  return { decisions, quarantines, failedAgents };
}

/** Canonical domain each board agent reports under (drives the Security veto). */
export const AGENT_DOMAINS: Record<BoardAgent, string> = {
  project_manager: 'project_management',
  hubspot_admin: 'crm',
  security: 'security',
  data_quality: 'data_quality',
  dev: 'engineering',
  cto: 'architecture',
};

/** LLM-backed runner: one strict-JSON verdict per subject, per agent. */
export class LlmBoardRunner implements BoardRunner {
  constructor(
    private readonly llm: LlmClient,
    private readonly promptFor: (agent: BoardAgent) => string,
  ) {}

  async reviewBatch(agent: BoardAgent, subjects: BoardSubject[]): Promise<Verdict[]> {
    const system = this.promptFor(agent);
    const text = await this.llm.complete(
      {
        system,
        messages: [
          {
            role: 'user',
            content:
              `Return ONLY a JSON array of verdicts, one per subject, each with: ` +
              `agent="${agent}", subject_id, domain="${AGENT_DOMAINS[agent]}", disposition ("pass"|"fail"), ` +
              `confidence (0..1), issues ([] or {code,message,severity}), proposed_fix (or null), context (or null).\n` +
              `Subjects:\n${JSON.stringify(subjects)}`,
          },
        ],
      },
      agent,
    );
    const raw = extractJson(text);
    const arr = Array.isArray(raw) ? raw : [raw];
    const verdicts: Verdict[] = [];
    for (const candidate of arr) {
      const parsed = parseVerdict(candidate);
      if (parsed.ok) verdicts.push(parsed.verdict);
      // Malformed verdicts are dropped here; the subject will escalate for want
      // of a usable verdict (and the raw output should be audited by the caller).
    }
    return verdicts;
  }
}
