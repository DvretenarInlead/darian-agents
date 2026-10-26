import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearLockfileCache, loadLockfile, normalizeSlug } from './lockfile.js';

const reader = (text: string) => async () => text;

afterEach(() => clearLockfileCache());

describe('normalizeSlug', () => {
  it('maps every spelling onto the catalog slug', () => {
    expect(normalizeSlug('PYB Project-Manager')).toBe('project_manager');
    expect(normalizeSlug('pyb-project-manager')).toBe('project_manager');
    expect(normalizeSlug('project_manager')).toBe('project_manager');
    expect(normalizeSlug('pyb-office')).toBe('office');
    expect(normalizeSlug('  --PYB  HubSpot Admin-- ')).toBe('hubspot_admin');
  });
});

describe('loadLockfile', () => {
  it('returns ok:false for a missing file', async () => {
    const r = await loadLockfile('nope.json', async () => {
      throw new Error('ENOENT');
    });
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for bad JSON and a non-object top level', async () => {
    expect((await loadLockfile('x', reader('{nope'))).ok).toBe(false);
    expect((await loadLockfile('x', reader('[1,2]'))).ok).toBe(false);
    expect((await loadLockfile('x', reader('null'))).ok).toBe(false);
  });

  it('tolerates extra keys, coerces numeric-string versions and normalises names', async () => {
    const r = await loadLockfile(
      'x',
      reader(
        JSON.stringify({
          generatedBy: 'ant',
          agents: { 'PYB Project-Manager': { id: 'agent_test_pm', version: '4', extra: true } },
          environments: { 'pyb-office': { id: 'env_test_office', note: 'x' } },
        }),
      ),
    );
    expect(r).toEqual({
      ok: true,
      agents: { project_manager: { id: 'agent_test_pm', version: 4 } },
      environments: { office: { id: 'env_test_office' } },
      warnings: [],
    });
  });

  it('skips one malformed entry with a warning and keeps the rest', async () => {
    const r = await loadLockfile(
      'x',
      reader(
        JSON.stringify({
          agents: {
            'pyb-content': { id: 'agent_test_content', version: 1 },
            'pyb-qa': { id: 'agent_test_qa' },
            'pyb-security-reviewer': { id: 'agent_test_sec', version: 0 },
          },
          environments: { 'pyb-build': {} },
        }),
      ),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(Object.keys(r.agents)).toEqual(['content']);
    expect(r.warnings).toHaveLength(3);
  });

  it('defaults missing sections to empty', async () => {
    const r = await loadLockfile('x', reader('{}'));
    expect(r).toEqual({ ok: true, agents: {}, environments: {}, warnings: [] });
  });

  it('parses the shipped example fixture', async () => {
    const r = await loadLockfile('agents/pyb/claude-lock.example.json', (p) => readFile(p, 'utf8'));
    if (!r.ok) throw new Error('expected ok');
    expect(r.agents.project_manager).toEqual({ id: 'agent_test_pm', version: 3 });
    expect(r.agents.solutions_architect?.version).toBe(2);
    expect(r.environments.office).toEqual({ id: 'env_test_office' });
    expect(r.warnings).toEqual([]);
  });

  it('reads from disk by default and does not cache a failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lock-'));
    try {
      const path = join(dir, 'claude-lock.json');
      expect((await loadLockfile(path)).ok).toBe(false);
      await writeFile(path, JSON.stringify({ agents: { content: { id: 'a1', version: 1 } } }));
      const first = await loadLockfile(path);
      expect(first.ok && first.agents.content?.id).toBe('a1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
