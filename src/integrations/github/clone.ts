import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Safe shallow clone for Product B ingestion (brief §6: sandboxed, never execute
 * repo content). Defences baked into the clone:
 *  - `--depth 1 --no-tags --single-branch` — minimal history (zip-bomb/DoS).
 *  - `core.hooksPath=/dev/null` — repo-provided git hooks can never run.
 *  - `GIT_TERMINAL_PROMPT=0` — never block on a credential prompt.
 * The clone only fetches bytes; ingest.ts parses them read-only. Run the worker
 * itself in a network-restricted, ephemeral context for true sandboxing.
 */

/** Auth URL for a repo. Token embedded for HTTPS clone. */
export function cloneUrl(repoFullName: string, token: string | undefined): string {
  const base = `github.com/${repoFullName}.git`;
  return token ? `https://x-access-token:${token}@${base}` : `https://${base}`;
}

/** Pure: the exact git argv. No shell, so repo/url values can't be interpreted. */
export function buildCloneArgs(url: string, destDir: string): string[] {
  return ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--no-tags', '--single-branch', url, destDir];
}

export async function cloneRepo(opts: { repoFullName: string; token?: string; destDir: string }): Promise<void> {
  const url = cloneUrl(opts.repoFullName, opts.token);
  await execFileAsync('git', buildCloneArgs(url, opts.destDir), {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 120_000,
    maxBuffer: 10_000_000,
  });
}
