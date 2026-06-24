import type { BoardAgent, Verdict } from '../agents/contract.js';

/**
 * Board resolution engine (build-order step 2).
 *
 * Takes the set of strict-JSON verdicts a board produced for one subject and
 * decides what happens next, consulting the safe/unsafe policy table. Pure and
 * deterministic — no I/O, no clock — so the highest-risk decision logic is fully
 * unit-testable (ISO 9001 §8.6 / §9.1; ISO 42001 human-oversight evidence).
 *
 * Rules (from the brief):
 *  - Independent agents run in parallel; we only resolve their verdicts here.
 *  - **Security veto is non-overridable on its own domain.** A failing Security
 *    verdict on a security-domain matter always routes to a human and can never
 *    be auto-fixed away or tie-broken by the CTO.
 *  - **CTO breaks non-security ties.** When a non-security failure is *ambiguous*
 *    (no matching policy entry), the CTO's disposition decides.
 *  - A subject proceeds only if every required agent passes (or every failure is
 *    a reversible, policy-sanctioned auto-fix).
 *  - Deny-by-default: a failure we cannot positively classify escalates.
 */

export interface ResolutionPolicyEntry {
  /** Matches a Verdict issue `code`. */
  condition: string;
  disposition: 'auto_fix' | 'escalate';
  reversible: boolean;
}

export const SECURITY_DOMAIN = 'security';
const SECURITY_AGENT: BoardAgent = 'security';
const CTO_AGENT: BoardAgent = 'cto';

export type Outcome = 'proceed' | 'escalate' | 'blocked';

export interface AutoFix {
  agent: BoardAgent;
  codes: string[];
  proposedFix: string;
}

export interface BoardDecision {
  subjectId: string;
  outcome: Outcome;
  /** True when a non-overridable Security veto was the reason for escalation. */
  vetoed: boolean;
  /** Reversible, policy-sanctioned fixes the actor layer may apply. */
  autoFixes: AutoFix[];
  /** Human-readable reasons that forced escalation/block. */
  escalationReasons: string[];
  rationale: string;
}

export interface ResolveOptions {
  /**
   * Agents whose passing verdict is required for the subject to proceed. Defaults
   * to the set of agents that actually submitted a verdict. A required agent with
   * no verdict forces escalation.
   */
  requiredAgents?: BoardAgent[];
}

type FailClass = 'auto_fixable' | 'must_escalate' | 'ambiguous';

/** Classify one failing verdict against the policy table. */
function classifyFailure(verdict: Verdict, policyByCondition: Map<string, ResolutionPolicyEntry>): FailClass {
  if (verdict.issues.length === 0) {
    // A bare fail with no issue codes is ambiguous — nothing to match on.
    return 'ambiguous';
  }

  let matched = 0;
  let allAutoFixReversible = true;
  for (const issue of verdict.issues) {
    const entry = policyByCondition.get(issue.code);
    if (!entry) {
      allAutoFixReversible = false;
      continue;
    }
    matched++;
    if (entry.disposition === 'escalate' || !entry.reversible) {
      return 'must_escalate';
    }
  }

  if (matched === 0) return 'ambiguous';
  // Some issues matched policy, but others had no entry (deny-by-default) →
  // we can't safely auto-fix the unmatched ones.
  if (matched < verdict.issues.length) return 'must_escalate';
  return allAutoFixReversible && verdict.proposed_fix ? 'auto_fixable' : 'must_escalate';
}

export function resolveBoard(
  verdicts: Verdict[],
  policy: ResolutionPolicyEntry[],
  opts: ResolveOptions = {},
): BoardDecision {
  if (verdicts.length === 0) {
    throw new Error('resolveBoard requires at least one verdict');
  }
  const subjectId = verdicts[0]!.subject_id;
  if (!verdicts.every((v) => v.subject_id === subjectId)) {
    throw new Error('all verdicts must concern the same subject');
  }

  const policyByCondition = new Map(policy.map((p) => [p.condition, p]));
  const present = new Set(verdicts.map((v) => v.agent));
  const required = opts.requiredAgents ?? [...present];

  const escalationReasons: string[] = [];
  const autoFixes: AutoFix[] = [];
  let vetoed = false;

  // A required agent that never reported blocks auto-proceed.
  const missing = required.filter((a) => !present.has(a));
  for (const agent of missing) {
    escalationReasons.push(`required agent '${agent}' produced no verdict`);
  }

  const ctoPassed = verdicts.some((v) => v.agent === CTO_AGENT && v.disposition === 'pass');
  const failures = verdicts.filter((v) => v.disposition === 'fail');

  for (const verdict of failures) {
    const isSecurityVeto = verdict.agent === SECURITY_AGENT && verdict.domain === SECURITY_DOMAIN;
    const klass = classifyFailure(verdict, policyByCondition);

    if (isSecurityVeto) {
      // Non-overridable: a reversible auto-fix is still allowed, but anything
      // else routes to a human and CTO cannot tie-break it.
      if (klass === 'auto_fixable') {
        autoFixes.push({ agent: verdict.agent, codes: verdict.issues.map((i) => i.code), proposedFix: verdict.proposed_fix! });
      } else {
        vetoed = true;
        escalationReasons.push(`security veto: ${describe(verdict)}`);
      }
      continue;
    }

    switch (klass) {
      case 'auto_fixable':
        autoFixes.push({ agent: verdict.agent, codes: verdict.issues.map((i) => i.code), proposedFix: verdict.proposed_fix! });
        break;
      case 'ambiguous':
        // CTO breaks the non-security tie.
        if (ctoPassed) {
          // Overruled toward proceed — recorded in rationale, not escalated.
        } else {
          escalationReasons.push(`unresolved (CTO did not clear): ${describe(verdict)}`);
        }
        break;
      case 'must_escalate':
        escalationReasons.push(`policy escalation: ${describe(verdict)}`);
        break;
    }
  }

  const outcome: Outcome = vetoed
    ? 'escalate'
    : escalationReasons.length > 0
      ? 'escalate'
      : 'proceed';

  return {
    subjectId,
    outcome,
    vetoed,
    autoFixes,
    escalationReasons,
    rationale: buildRationale({ outcome, vetoed, autoFixes, escalationReasons, ctoPassed }),
  };
}

function describe(verdict: Verdict): string {
  const codes = verdict.issues.map((i) => i.code).join(', ') || '(no codes)';
  return `${verdict.agent} failed [${codes}]`;
}

function buildRationale(d: {
  outcome: Outcome;
  vetoed: boolean;
  autoFixes: AutoFix[];
  escalationReasons: string[];
  ctoPassed: boolean;
}): string {
  if (d.vetoed) return 'Escalated: non-overridable Security veto on its own domain.';
  if (d.outcome === 'escalate') return `Escalated: ${d.escalationReasons.join('; ')}.`;
  const parts = ['All required agents passed or were auto-fixed.'];
  if (d.autoFixes.length) parts.push(`${d.autoFixes.length} reversible auto-fix(es) applied.`);
  if (d.ctoPassed) parts.push('CTO cleared ambiguous non-security findings.');
  return parts.join(' ');
}
