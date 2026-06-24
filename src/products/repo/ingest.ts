import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Sandboxed repo ingestion (brief §6, build-order step 9).
 *
 * Assumes the repo was cloned into an isolated, network-restricted, ephemeral
 * context by the caller. This module is the read-only, never-execute parser that
 * defends against malicious repo contents:
 *  - resource caps (file count, total bytes, per-file bytes) → zip-bomb / DoS,
 *  - symlink rejection → traversal out of the tree,
 *  - path-escape rejection → `..` / absolute / null-byte filenames.
 * It only reads bytes; it never builds, installs, or runs anything.
 */

export interface IngestLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxFiles: 5_000,
  maxTotalBytes: 50_000_000,
  maxFileBytes: 1_000_000,
};

export interface IngestedFile {
  path: string; // repo-relative, POSIX-style
  bytes: number;
  content: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface IngestResult {
  files: IngestedFile[];
  skipped: SkippedFile[];
  truncated: boolean; // hit a cap before finishing
}

/** Reject `..` traversal, absolute paths, and null bytes. Pure. */
export function isPathSafe(relPath: string): boolean {
  if (relPath.includes('\0')) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  const parts = relPath.split(/[\\/]/);
  return !parts.some((p) => p === '..');
}

export async function ingestRepo(rootDir: string, limits: IngestLimits = DEFAULT_LIMITS): Promise<IngestResult> {
  const files: IngestedFile[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) return;
      const abs = join(dir, entry.name);
      const rel = relative(rootDir, abs).split(sep).join('/');

      if (!isPathSafe(rel)) {
        skipped.push({ path: rel, reason: 'unsafe path' });
        continue;
      }
      // lstat (not stat) so symlinks are detected, not followed.
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        skipped.push({ path: rel, reason: 'symlink' });
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: 'not a regular file' });
        continue;
      }
      if (st.size > limits.maxFileBytes) {
        skipped.push({ path: rel, reason: 'file too large' });
        continue;
      }
      if (files.length >= limits.maxFiles || totalBytes + st.size > limits.maxTotalBytes) {
        truncated = true;
        return;
      }
      const content = await readFile(abs, 'utf8');
      files.push({ path: rel, bytes: st.size, content });
      totalBytes += st.size;
    }
  }

  await walk(rootDir);
  return { files, skipped, truncated };
}
