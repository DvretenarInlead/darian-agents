import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { JobHandler } from '../../core/queue/consumer.js';
import type { Job } from '../../core/queue/jobs.js';
import type { LlmClient } from '../../integrations/anthropic/client.js';
import { config } from '../../config/index.js';
import { cloneRepo } from '../../integrations/github/clone.js';
import { LlmRepoReviewClient } from './score.js';
import { scoreRepo } from './pipeline.js';
import type { IngestLimits } from './ingest.js';
import { log } from '../../core/obs/logger.js';

/**
 * repo_score job handler: clone the repo into an ephemeral temp dir, run the
 * (already-tested) scoreRepo pipeline (ingest → pre-scan → board → scorecard),
 * then always remove the clone. Wiring only.
 */
export interface RepoHandlerDeps {
  pool: Pool;
  llm: LlmClient;
  limits?: IngestLimits;
}

export function makeRepoHandler(deps: RepoHandlerDeps): JobHandler {
  return async (job: Job) => {
    const repo = (job.payload as { repo?: string } | undefined)?.repo;
    // Strict owner/name; reject path traversal ('..') so the value can't escape
    // the clone target dir or be abused in the clone URL.
    if (!repo || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo) || repo.includes('..')) {
      throw new Error('repo_score: payload.repo must be "owner/name"');
    }

    const dir = await mkdtemp(join(tmpdir(), 'repo-score-'));
    try {
      const token = config().github.token;
      await cloneRepo({ repoFullName: repo, destDir: dir, ...(token ? { token } : {}) });
      const result = await scoreRepo(
        {
          pool: deps.pool,
          reviewer: new LlmRepoReviewClient(deps.llm),
          now: () => new Date().toISOString(),
          ...(deps.limits ? { limits: deps.limits } : {}),
        },
        { repo, rootDir: dir },
      );
      log().info({ jobId: job.id, repo, overall: result.scorecard.overall, prescanFindings: result.prescanFindings }, 'repo_score processed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
