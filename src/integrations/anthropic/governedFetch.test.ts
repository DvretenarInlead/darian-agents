import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgres://app:pw@localhost:5432/test',
  ANTHROPIC_API_KEY: 'sk-test-anthropic',
  EGRESS_ALLOWLIST: 'api.anthropic.com',
};

const saved = { ...process.env };

// config() caches on first use, so each test sets its env, then re-imports fresh modules.
async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env = { ...saved, ...BASE_ENV };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const gov = await import('./governedFetch.js');
  const cred = await import('../../core/governance/credentials.js');
  const inner = vi.fn<typeof fetch>(async () => new Response('{}'));
  return { ...gov, ...cred, inner };
}

afterEach(() => {
  process.env = { ...saved };
});

describe('createGovernedFetch', () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    ctx = await load();
  });

  it('injects the scoped key, strips authorization and drops the placeholder', async () => {
    const f = ctx.createGovernedFetch('team_control', ctx.inner);
    await f('https://api.anthropic.com/v1/sessions', {
      headers: { 'x-api-key': 'resolved-per-request', Authorization: 'Bearer nope', 'x-other': 'keep' },
    });
    expect(ctx.inner).toHaveBeenCalledTimes(1);
    const headers = new Headers(ctx.inner.mock.calls[0]![1]!.headers);
    expect(headers.get('x-api-key')).toBe('sk-test-anthropic');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get('x-other')).toBe('keep');
  });

  it('accepts URL and Request inputs', async () => {
    const f = ctx.createGovernedFetch('team_control', ctx.inner);
    await f(new URL('https://api.anthropic.com/v1/x'));
    await f(new Request('https://api.anthropic.com/v1/y', { headers: { authorization: 'Bearer nope', 'x-r': '1' } }));
    const h = new Headers(ctx.inner.mock.calls[1]![1]!.headers);
    expect(h.get('x-api-key')).toBe('sk-test-anthropic');
    expect(h.has('authorization')).toBe(false);
    expect(h.get('x-r')).toBe('1');
  });

  it.each([
    ['http scheme', 'http://api.anthropic.com/v1/x'],
    ['non-default port', 'https://api.anthropic.com:8443/v1/x'],
    ['other host', 'https://evil.example.com/v1/x'],
    ['lookalike host', 'https://api.anthropic.com.evil.example/v1/x'],
    ['userinfo trick', 'https://api.anthropic.com@evil.example/v1/x'],
    ['unparseable', 'not a url'],
  ])('refuses %s without calling inner', async (_n, url) => {
    const f = ctx.createGovernedFetch('team_control', ctx.inner);
    await expect(f(url)).rejects.toBeInstanceOf(ctx.EgressDeniedError);
    expect(ctx.inner).not.toHaveBeenCalled();
  });

  it('refuses an agent whose scope lacks the host', async () => {
    // slack-only scope does not exist; hubspot_admin has anthropic, so use a host check instead.
    const f = ctx.createGovernedFetch('project_manager', ctx.inner);
    await expect(f('https://api.hubapi.com/x')).rejects.toBeInstanceOf(ctx.EgressDeniedError);
    expect(ctx.inner).not.toHaveBeenCalled();
  });
});

describe('createGovernedFetch with app-level config', () => {
  it('refuses the host when EGRESS_ALLOWLIST excludes it', async () => {
    const c = await load({ EGRESS_ALLOWLIST: 'api.fireflies.ai' });
    const f = c.createGovernedFetch('team_control', c.inner);
    await expect(f('https://api.anthropic.com/v1/x')).rejects.toBeInstanceOf(c.EgressDeniedError);
    expect(c.inner).not.toHaveBeenCalled();
  });

  it('throws CredentialScopeError when ANTHROPIC_API_KEY is unset', async () => {
    const c = await load({ ANTHROPIC_API_KEY: undefined });
    const f = c.createGovernedFetch('team_control', c.inner);
    await expect(f('https://api.anthropic.com/v1/x')).rejects.toBeInstanceOf(c.CredentialScopeError);
    expect(c.inner).not.toHaveBeenCalled();
  });
});
