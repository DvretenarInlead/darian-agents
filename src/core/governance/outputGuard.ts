import type { Verdict } from '../agents/contract.js';
import { scanForInjection } from '../agents/sanitize.js';

/**
 * Output-side injection scanning (brief §4, build-order step 3).
 *
 * Every agent's output is untrusted input to the *next* stage. Schema validation
 * (contract.ts) already rejects unknown keys; this adds a content scan of the
 * free-text fields an agent controls — `context`, `proposed_fix`, and each issue
 * `message` — for instruction-smuggling patterns.
 *
 * Policy is **quarantine, don't drop**: suspicious output is flagged so the
 * orchestrator persists it to the audit log for forensics and withholds it from
 * the next stage, rather than silently discarding (which would destroy evidence)
 * or passing it through (which would let the smuggled directive propagate).
 */

export interface GuardFinding {
  field: string;
  matches: string[];
}

export interface GuardResult {
  clean: boolean;
  findings: GuardFinding[];
}

function scanField(field: string, value: string | null, into: GuardFinding[]): void {
  if (!value) return;
  const scan = scanForInjection(value);
  if (scan.suspicious) into.push({ field, matches: scan.matches });
}

/** Scan a parsed verdict's free-text fields. Pure — no I/O, no side effects. */
export function inspectVerdictOutput(verdict: Verdict): GuardResult {
  const findings: GuardFinding[] = [];
  scanField('context', verdict.context, findings);
  scanField('proposed_fix', verdict.proposed_fix, findings);
  verdict.issues.forEach((issue, i) => {
    scanField(`issues[${i}].message`, issue.message, findings);
  });
  return { clean: findings.length === 0, findings };
}

export interface QuarantineDecision {
  /** True when the verdict may continue to the next stage. */
  pass: boolean;
  /** Populated when the verdict is quarantined; shape is audit-ready. */
  quarantine?: {
    agent: string;
    subjectId: string;
    findings: GuardFinding[];
  };
}

/**
 * Decide whether a verdict proceeds or is quarantined. The caller writes the
 * quarantine payload to the audit log (event_type 'autofix'→ use a dedicated
 * quarantine reason) and skips the verdict in resolution.
 */
export function guardVerdictOutput(verdict: Verdict): QuarantineDecision {
  const result = inspectVerdictOutput(verdict);
  if (result.clean) return { pass: true };
  return {
    pass: false,
    quarantine: {
      agent: verdict.agent,
      subjectId: verdict.subject_id,
      findings: result.findings,
    },
  };
}
