import { config } from '../../config/index.js';
import { AGENTS, type AgentName } from '../agents/contract.js';

/**
 * Per-agent credential & egress scoping (brief §5, build-order step 3).
 *
 * Deny-by-default: each agent may use only the secrets and reach only the egress
 * hosts explicitly listed for it. The orchestrator hands an agent a *scoped*
 * accessor, so a compromised or injected agent cannot reach a credential or
 * domain outside its job. This is enforced in code, not just documented.
 *
 * The broad-permission HubSpot service key is scoped to `hubspot_admin` only and
 * is additionally gated at runtime behind the `hubspot_admin_mode` role + sudo
 * (console layer, later step) — scoping here is necessary, not sufficient.
 */

export type ScopedSecret = 'anthropic' | 'fireflies' | 'hubspotAccess' | 'hubspotService' | 'github';

/** Canonical egress host for each external dependency. */
export const EGRESS_HOSTS: Record<Exclude<ScopedSecret, 'hubspotService'>, string> = {
  anthropic: 'api.anthropic.com',
  fireflies: 'api.fireflies.ai',
  hubspotAccess: 'api.hubapi.com',
  github: 'api.github.com',
};

export interface AgentScope {
  secrets: ScopedSecret[];
  egress: string[];
}

const ANTHROPIC: AgentScope = { secrets: ['anthropic'], egress: [EGRESS_HOSTS.anthropic] };

/**
 * Every board agent reasons via Anthropic; the differentiator is which external
 * data/tools each may additionally touch. Kept narrow on purpose.
 */
const AGENT_SCOPES: Record<AgentName, AgentScope> = {
  orchestrator: ANTHROPIC,
  project_manager: ANTHROPIC,
  cto: ANTHROPIC,
  // Extraction reads Fireflies transcripts.
  data_quality: { secrets: ['anthropic', 'fireflies'], egress: [EGRESS_HOSTS.anthropic, EGRESS_HOSTS.fireflies] },
  // HubSpot Admin is the only agent that may use HubSpot credentials.
  hubspot_admin: {
    secrets: ['anthropic', 'hubspotAccess', 'hubspotService'],
    egress: [EGRESS_HOSTS.anthropic, EGRESS_HOSTS.hubspotAccess],
  },
  // Security + Dev read GitHub repos for Product B scoring.
  security: { secrets: ['anthropic', 'github'], egress: [EGRESS_HOSTS.anthropic, EGRESS_HOSTS.github] },
  dev: { secrets: ['anthropic', 'github'], egress: [EGRESS_HOSTS.anthropic, EGRESS_HOSTS.github] },
};

export class CredentialScopeError extends Error {}
export class EgressDeniedError extends Error {}

export function getAgentScope(agent: AgentName): AgentScope {
  const scope = AGENT_SCOPES[agent];
  if (!scope) throw new CredentialScopeError(`no scope defined for agent '${agent}'`);
  return scope;
}

/**
 * Assert an agent may reach `hostname`. Deny-by-default: the host must be in the
 * agent's per-agent egress list AND the app-level global allowlist (if one is
 * configured). Throws EgressDeniedError otherwise.
 */
export function assertEgressAllowed(agent: AgentName, hostname: string): void {
  const scope = getAgentScope(agent);
  if (!scope.egress.includes(hostname)) {
    throw new EgressDeniedError(`agent '${agent}' is not scoped to reach ${hostname}`);
  }
  const globalAllow = config().egressAllowlist;
  if (globalAllow.length > 0 && !globalAllow.includes(hostname)) {
    throw new EgressDeniedError(`${hostname} is not in the app egress allowlist`);
  }
}

const SECRET_RESOLVERS: Record<ScopedSecret, () => string | undefined> = {
  anthropic: () => config().anthropic.apiKey,
  fireflies: () => config().fireflies.apiKey,
  hubspotAccess: () => config().hubspot.accessToken,
  hubspotService: () => config().hubspot.serviceKey,
  github: () => config().github.token,
};

/**
 * Resolve a secret for an agent. Throws CredentialScopeError if the agent is not
 * scoped for it, or if the secret is not configured. The returned value should
 * be used immediately and never logged (audit/log writers redact regardless).
 */
export function getScopedSecret(agent: AgentName, secret: ScopedSecret): string {
  const scope = getAgentScope(agent);
  if (!scope.secrets.includes(secret)) {
    throw new CredentialScopeError(`agent '${agent}' is not scoped for secret '${secret}'`);
  }
  const value = SECRET_RESOLVERS[secret]();
  if (!value) {
    throw new CredentialScopeError(`secret '${secret}' is not configured`);
  }
  return value;
}

/** All known agents — handy for validation/tests. */
export const SCOPED_AGENTS = AGENTS;
