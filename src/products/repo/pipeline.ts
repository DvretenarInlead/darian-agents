import type { Pool } from 'pg';
import { appendAudit } from '../../core/audit/writer.js';
import { ingestRepo, type IngestLimits } from './ingest.js';
import { prescanRepo } from './prescan.js';
import {
  aggregate,
  buildSummary,
  REPO_REVIEWERS,
  type RepoReviewClient,
  type Scorecard,
  type DimensionScore,
} from './score.js';

/**
 * Product B pipeline (build-order step 9), on-demand only:
 *   sandboxed ingest → security pre-scan (redact before LLM) → Dev/Security/CTO
 *   board → aggregated scorecard → audit persist.
 *
 * The pre-scan runs before any content reaches Anthropic, and only redacted
 * content is sampled for the reviewers. Pre-scan findings are recorded to audit
 * regardless of the score.
 */

export interface RepoPipelineDeps {
  pool: Pool;
  reviewer: RepoReviewClient;
  limits?: IngestLimits;
  now: () => string;
}

export interface RepoScoreResult {
  scorecard: Scorecard;
  prescanFindings: number;
  filesScanned: number;
  skipped: number;
}

export async function scoreRepo(
  deps: RepoPipelineDeps,
  input: { repo: string; rootDir: string },
): Promise<RepoScoreResult> {
  const { pool, now } = deps;

  const ingest = await ingestRepo(input.rootDir, deps.limits);
  const prescan = prescanRepo(ingest.files);

  // Pre-scan findings are audited before any LLM call.
  await appendAudit(
    pool,
    {
      eventType: 'ingest',
      product: 'repo',
      actorId: null,
      subjectId: input.repo,
      payload: {
        files: ingest.files.length,
        skipped: ingest.skipped,
        truncated: ingest.truncated,
        prescan: prescan.findings,
      },
    },
    now(),
  );

  const summary = buildSummary(input.repo, prescan.redactedFiles);
  // Reviewers are independent — run them concurrently.
  const dimensions: DimensionScore[] = await Promise.all(
    REPO_REVIEWERS.map((reviewer) => deps.reviewer.review(reviewer, summary)),
  );
  const scorecard = aggregate(input.repo, dimensions);

  await appendAudit(
    pool,
    { eventType: 'verdict', product: 'repo', actorId: null, subjectId: input.repo, payload: { scorecard, hasCritical: prescan.hasCritical } },
    now(),
  );

  return {
    scorecard,
    prescanFindings: prescan.findings.length,
    filesScanned: ingest.files.length,
    skipped: ingest.skipped.length,
  };
}
