import { readFile as fsReadFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { LockfileStatus } from './types.js';

const Version = z.union([z.number().int().positive(), z.string().regex(/^\d{1,9}$/).transform(Number)]);
const LockAgent = z.looseObject({ id: z.string().min(1).max(128), version: Version });
const LockEnv = z.looseObject({ id: z.string().min(1).max(128) });
export const TeamLockfile = z.looseObject({
  agents: z.record(z.string(), z.unknown()).default({}),
  environments: z.record(z.string(), z.unknown()).default({}),
});

/** 'PYB Project-Manager' | 'pyb-project-manager' | 'project_manager' → 'project_manager'; 'pyb-office' → 'office'. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^pyb_/, '');
}

function parseLockfile(text: string): LockfileStatus {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'claude-lock.json is not valid JSON' };
  }
  const top = TeamLockfile.safeParse(json);
  if (!top.success) return { ok: false, reason: 'claude-lock.json has no usable top level (expected an object)' };

  const warnings: string[] = [];
  const agents: Record<string, { id: string; version: number }> = {};
  const environments: Record<string, { id: string }> = {};

  for (const [key, raw] of Object.entries(top.data.agents)) {
    const p = LockAgent.safeParse(raw);
    const slug = normalizeSlug(key);
    if (!p.success || !slug) {
      warnings.push(`agents.${key}: skipped (needs id and a positive integer version)`);
      continue;
    }
    agents[slug] = { id: p.data.id, version: p.data.version };
  }
  for (const [key, raw] of Object.entries(top.data.environments)) {
    const p = LockEnv.safeParse(raw);
    const slug = normalizeSlug(key);
    if (!p.success || !slug) {
      warnings.push(`environments.${key}: skipped (needs id)`);
      continue;
    }
    environments[slug] = { id: p.data.id };
  }
  return { ok: true, agents, environments, warnings };
}

const CHECK_EVERY_MS = 30_000;
const cache = new Map<string, { checkedAt: number; mtimeMs: number; status: LockfileStatus }>();

/**
 * Tolerant loader: never throws. One malformed entry is skipped with a warning
 * so it cannot hide the rest. With the default reader the result is cached by
 * mtime (checked at most every 30 s); an injected reader is never cached.
 */
export async function loadLockfile(
  path: string,
  readFile?: (p: string) => Promise<string>,
): Promise<LockfileStatus> {
  if (readFile) {
    try {
      return parseLockfile(await readFile(path));
    } catch {
      return { ok: false, reason: 'claude-lock.json is missing or unreadable' };
    }
  }
  const nowMs = Date.now();
  const hit = cache.get(path);
  if (hit && nowMs - hit.checkedAt < CHECK_EVERY_MS) return hit.status;
  try {
    const { mtimeMs } = await stat(path);
    if (hit && hit.mtimeMs === mtimeMs) {
      hit.checkedAt = nowMs;
      return hit.status;
    }
    const status = parseLockfile(await fsReadFile(path, 'utf8'));
    cache.set(path, { checkedAt: nowMs, mtimeMs, status });
    return status;
  } catch {
    cache.delete(path);
    return { ok: false, reason: 'claude-lock.json is missing or unreadable' };
  }
}

/** Test hook: forget cached lockfiles. */
export function clearLockfileCache(): void {
  cache.clear();
}
