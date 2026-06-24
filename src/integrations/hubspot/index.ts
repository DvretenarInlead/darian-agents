import type { HubSpotClient } from './client.js';
import { ProjectsApiHubSpotClient } from './projectsApi.js';
import { AgentCliHubSpotClient } from './agentCli.js';
import { InMemoryHubSpotClient } from './client.js';

export * from './types.js';
export { renderPreview, InMemoryHubSpotClient } from './client.js';
export type { HubSpotClient } from './client.js';
export { ProjectsApiHubSpotClient } from './projectsApi.js';
export { AgentCliHubSpotClient } from './agentCli.js';
export { buildSyncPlan } from './plan.js';
export type { ApprovedItem, ItemDecision, PlanInput } from './plan.js';

export type HubSpotAdapter = 'agent_cli' | 'projects_api' | 'memory';

/**
 * Select a HubSpot adapter. Default is the version-pinned Projects API — the
 * concrete, implementable-today fallback. The Agent CLI is primary per the brief
 * but its surface is still being verified, so it is opt-in until confirmed.
 */
export function createHubSpotClient(adapter: HubSpotAdapter = 'projects_api'): HubSpotClient {
  switch (adapter) {
    case 'agent_cli':
      return new AgentCliHubSpotClient();
    case 'memory':
      return new InMemoryHubSpotClient();
    case 'projects_api':
    default:
      return new ProjectsApiHubSpotClient();
  }
}
