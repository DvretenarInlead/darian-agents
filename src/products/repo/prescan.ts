import { redact } from '../../core/audit/redact.js';
import type { IngestedFile } from './ingest.js';

/**
 * Security pre-scan (brief: "Security pre-scan BEFORE any content reaches
 * Anthropic", build-order step 9).
 *
 * Runs entirely locally. Flags committed secrets and dangerous artefacts, and —
 * crucially — produces a *redacted* view of file contents so secrets are never
 * shipped to the LLM scorer. Pure and testable.
 */

export type FindingType = 'private_key' | 'cloud_key' | 'token' | 'env_file' | 'high_entropy';
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface PrescanFinding {
  path: string;
  type: FindingType;
  severity: FindingSeverity;
}

const CONTENT_RULES: { type: FindingType; severity: FindingSeverity; re: RegExp }[] = [
  { type: 'private_key', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { type: 'cloud_key', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: 'token', severity: 'high', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
];

function isEnvFile(path: string): boolean {
  return /(^|\/)\.env(\.[A-Za-z0-9_]+)?$/.test(path);
}

export function prescanFile(file: IngestedFile): PrescanFinding[] {
  const findings: PrescanFinding[] = [];
  if (isEnvFile(file.path)) {
    findings.push({ path: file.path, type: 'env_file', severity: 'medium' });
  }
  for (const rule of CONTENT_RULES) {
    if (rule.re.test(file.content)) {
      findings.push({ path: file.path, type: rule.type, severity: rule.severity });
    }
  }
  return findings;
}

export interface PrescanResult {
  findings: PrescanFinding[];
  /** File contents with secrets redacted — safe to pass to the LLM scorer. */
  redactedFiles: IngestedFile[];
  /** True if a critical secret (e.g. private key) was committed. */
  hasCritical: boolean;
}

export function prescanRepo(files: IngestedFile[]): PrescanResult {
  const findings: PrescanFinding[] = [];
  const redactedFiles: IngestedFile[] = [];
  for (const file of files) {
    findings.push(...prescanFile(file));
    redactedFiles.push({ ...file, content: redact(file.content) as string });
  }
  return {
    findings,
    redactedFiles,
    hasCritical: findings.some((f) => f.severity === 'critical'),
  };
}
