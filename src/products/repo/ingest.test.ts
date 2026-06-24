import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathSafe, ingestRepo, DEFAULT_LIMITS } from './ingest.js';

describe('isPathSafe', () => {
  it('accepts normal relative paths', () => {
    expect(isPathSafe('src/a.ts')).toBe(true);
  });
  it('rejects traversal, absolute, and null-byte paths', () => {
    expect(isPathSafe('../etc/passwd')).toBe(false);
    expect(isPathSafe('/etc/passwd')).toBe(false);
    expect(isPathSafe('a\0b')).toBe(false);
  });
});

describe('ingestRepo', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'repo-ingest-'));
    await writeFile(join(root, 'a.ts'), 'export const a = 1;');
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'b.ts'), 'export const b = 2;');
    await writeFile(join(root, 'big.bin'), 'x'.repeat(2000));
    await symlink(join(root, 'a.ts'), join(root, 'link.ts'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads regular files, skipping symlinks and oversized files', async () => {
    const result = await ingestRepo(root, { ...DEFAULT_LIMITS, maxFileBytes: 1000 });
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.ts', 'sub/b.ts']);
    expect(result.skipped.some((s) => s.reason === 'symlink')).toBe(true);
    expect(result.skipped.some((s) => s.reason === 'file too large')).toBe(true);
  });

  it('marks truncated when the file cap is hit', async () => {
    const result = await ingestRepo(root, { ...DEFAULT_LIMITS, maxFiles: 1, maxFileBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBe(1);
  });
});
