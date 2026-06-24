/**
 * Untrusted-text handling for prompt-injection hardening (brief §4).
 *
 * Any text that originates outside our own code — meeting transcripts, repo
 * file contents, and crucially *another agent's free-text output* — is treated
 * as untrusted before it enters a prompt. This module does two things:
 *
 *  - sanitize(): strip control characters and neutralise fake role/system
 *    markers so smuggled directives cannot impersonate our own framing.
 *  - scanForInjection(): flag (do not silently drop) text that looks like an
 *    instruction-smuggling attempt, so the caller can quarantine it to audit.
 */

/** Control chars except tab (\x09), newline (\x0A), carriage return (\x0D). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Fake chat/role markers an attacker might inject to hijack framing. */
const ROLE_MARKERS = [
  /<\/?(?:system|assistant|user|tool|developer)\b[^>]*>/gi,
  /\[(?:\/?INST|\/?SYS|system|assistant|user)\]/gi,
  /\b(?:system|assistant|developer)\s*:/gi,
];

export interface SanitizeOptions {
  /** Hard length cap; text beyond this is truncated (per-source token/length cap). */
  maxLength: number;
}

/** Normalise untrusted text: drop control chars, defuse role markers, cap length. */
export function sanitize(input: string, opts: SanitizeOptions): string {
  let out = input.replace(CONTROL_CHARS, '');
  for (const marker of ROLE_MARKERS) {
    out = out.replace(marker, (m) => `​${m}`); // zero-width prefix breaks the token
  }
  if (out.length > opts.maxLength) {
    out = out.slice(0, opts.maxLength);
  }
  return out;
}

/** Heuristic patterns that suggest an attempt to redirect the agent/tooling. */
const INJECTION_PATTERNS: { code: string; re: RegExp }[] = [
  { code: 'override_instructions', re: /\b(?:ignore|disregard|forget)\b.{0,30}\b(?:previous|prior|above|all)\b.{0,30}\b(?:instructions?|prompts?|rules?)\b/i },
  { code: 'role_reassignment', re: /\byou are now\b|\bact as\b.{0,30}\b(?:admin|root|system)\b/i },
  { code: 'tool_directive', re: /\b(?:call|invoke|execute|run)\b.{0,20}\b(?:tool|function|command|shell|bash)\b/i },
  { code: 'exfil_directive', re: /\b(?:print|reveal|output|send|leak)\b.{0,30}\b(?:secret|api[_\s-]?key|token|password|credential)s?\b/i },
  { code: 'fake_system_tag', re: /<\/?(?:system|developer)\b/i },
];

export interface InjectionScan {
  suspicious: boolean;
  matches: string[];
}

/** Scan text for injection signals. Caller decides to quarantine, not us. */
export function scanForInjection(input: string): InjectionScan {
  const matches: string[] = [];
  for (const { code, re } of INJECTION_PATTERNS) {
    if (re.test(input)) matches.push(code);
  }
  return { suspicious: matches.length > 0, matches };
}
