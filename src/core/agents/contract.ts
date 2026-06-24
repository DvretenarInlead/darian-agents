import { z } from 'zod';

/**
 * Shared agent contract for the review board.
 *
 * Every board agent returns a strict-JSON verdict that is schema-validated
 * before the orchestrator acts on it. Two principles from the brief are encoded
 * here:
 *
 *  1. Reader/actor separation — agents emit *verdicts and proposed fixes*, never
 *     side effects. The orchestrator + sync layer are the only actors.
 *  2. Output-as-untrusted — an agent's free-text output is untrusted input to
 *     the next stage, so free-text fields are length-capped and must be scanned
 *     for instruction-smuggling before being fed onward (see sanitize.ts).
 */

/** Canonical agent roster. Orchestrator/Router runs the board; the other six are board agents. */
export const AGENTS = [
  'orchestrator', // Orchestrator / Router — not a board voter; runs the board
  'project_manager',
  'hubspot_admin',
  'security',
  'data_quality', // Data Quality / Extraction
  'dev',
  'cto', // CTO / Architect — breaks non-security ties
] as const;

export type AgentName = (typeof AGENTS)[number];

/** Board voters — the six agents that issue pass/fail verdicts on a subject. */
export const BOARD_AGENTS = [
  'project_manager',
  'hubspot_admin',
  'security',
  'data_quality',
  'dev',
  'cto',
] as const satisfies readonly AgentName[];

export type BoardAgent = (typeof BOARD_AGENTS)[number];

export const Disposition = z.enum(['pass', 'fail']);
export type Disposition = z.infer<typeof Disposition>;

export const Severity = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;

/** Per-source free-text caps — bound context-stuffing attacks (brief §4). */
export const FREE_TEXT_MAX = 4_000;
export const ISSUE_TEXT_MAX = 1_000;
export const MAX_ISSUES = 50;

const freeText = z.string().max(FREE_TEXT_MAX);
const issueText = z.string().max(ISSUE_TEXT_MAX);

/** A single finding raised by a board agent. */
export const Issue = z.object({
  code: z.string().max(120),
  message: issueText,
  severity: Severity,
});
export type Issue = z.infer<typeof Issue>;

/**
 * The strict verdict every board agent must return. `.strict()` rejects any
 * unexpected key, which is a cheap first line against output-side injection
 * that tries to smuggle extra directives through unknown fields.
 */
export const Verdict = z
  .object({
    agent: z.enum(BOARD_AGENTS),
    subject_id: z.string().min(1).max(256),
    /** The agent's own domain — used to enforce the non-overridable Security veto. */
    domain: z.string().min(1).max(120),
    disposition: Disposition,
    confidence: z.number().min(0).max(1),
    issues: z.array(Issue).max(MAX_ISSUES).default([]),
    /** Optional machine-applicable fix the orchestrator may auto-apply if policy allows. */
    proposed_fix: freeText.nullable().default(null),
    /** Free-form rationale; untrusted to downstream stages. */
    context: freeText.nullable().default(null),
  })
  .strict();

export type Verdict = z.infer<typeof Verdict>;

/**
 * Parse raw agent output into a validated Verdict.
 * Returns a discriminated result so callers can quarantine malformed output to
 * the audit log (brief §4: "quarantine, don't drop") rather than throwing.
 */
export type ParseResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; error: string; raw: unknown };

export function parseVerdict(raw: unknown): ParseResult {
  const result = Verdict.safeParse(raw);
  if (result.success) return { ok: true, verdict: result.data };
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    raw,
  };
}
