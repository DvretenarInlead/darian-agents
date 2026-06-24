import { describe, it, expect, beforeAll } from 'vitest';

// config() validates the environment lazily on first call, so populate the
// required vars before any governance function runs.
beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://app:pw@localhost:5432/test';
  process.env.EGRESS_ALLOWLIST = 'api.anthropic.com,api.fireflies.ai,api.hubapi.com,api.github.com';
  process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
  process.env.HUBSPOT_SERVICE_KEY = 'svc-key';
  process.env.GITHUB_TOKEN = 'gh-token';
});

const mod = () => import('./credentials.js');

describe('per-agent egress scoping', () => {
  it('allows an agent to reach a host in its scope and the allowlist', async () => {
    const { assertEgressAllowed } = await mod();
    expect(() => assertEgressAllowed('data_quality', 'api.fireflies.ai')).not.toThrow();
  });

  it('denies a host the agent is not scoped for (deny-by-default)', async () => {
    const { assertEgressAllowed, EgressDeniedError } = await mod();
    // project_manager is Anthropic-only; HubSpot is out of scope.
    expect(() => assertEgressAllowed('project_manager', 'api.hubapi.com')).toThrow(EgressDeniedError);
  });

  it('denies an arbitrary external host for every agent', async () => {
    const { assertEgressAllowed, EgressDeniedError } = await mod();
    expect(() => assertEgressAllowed('dev', 'evil.example.com')).toThrow(EgressDeniedError);
  });
});

describe('per-agent credential scoping', () => {
  it('returns a configured, in-scope secret', async () => {
    const { getScopedSecret } = await mod();
    expect(getScopedSecret('hubspot_admin', 'hubspotService')).toBe('svc-key');
  });

  it('refuses a secret outside the agent scope', async () => {
    const { getScopedSecret, CredentialScopeError } = await mod();
    // Only hubspot_admin may touch the HubSpot service key.
    expect(() => getScopedSecret('dev', 'hubspotService')).toThrow(CredentialScopeError);
  });

  it('refuses an in-scope secret that is not configured', async () => {
    const { getScopedSecret, CredentialScopeError } = await mod();
    // fireflies is in data_quality's scope but FIREFLIES_API_KEY is unset.
    expect(() => getScopedSecret('data_quality', 'fireflies')).toThrow(CredentialScopeError);
  });
});
