import type { PortalKind } from './types.js';

/**
 * The PYB Team roster as the control plane knows it. Slugs, environments and
 * the per-role `writes` flag are derived from the agent definitions in
 * agents/pyb (phase 0); the lockfile loader normalises `claude-lock.json`
 * names onto these slugs. Changing a role's policy is a one-line edit here.
 */

export const TEAM_AGENT_SLUGS = [
  'orchestrator',
  'project_manager',
  'solutions_architect',
  'content',
  'hubspot_developer',
  'qa',
  'security_reviewer',
  'hubspot_admin',
  'migration_data',
] as const;
export type TeamAgentSlug = (typeof TEAM_AGENT_SLUGS)[number];

export const TEAM_ENVIRONMENTS = ['pyb-office', 'pyb-build', 'pyb-migration', 'pyb-orchestrated'] as const;
export type TeamEnvironment = (typeof TEAM_ENVIRONMENTS)[number];

export type TeamMcpServer = 'hubspot' | 'fireflies' | 'github';

export interface TeamAgentSpec {
  slug: TeamAgentSlug;
  label: string;
  environment: TeamEnvironment;
  /** Role may propose HubSpot/GitHub writes (gated by always_ask either way). Drives kill-switch + portal-kind policy. */
  writes: boolean;
  mcp: readonly TeamMcpServer[];
  allowedPortalKinds: readonly PortalKind[];
  /** Phase gate: only launchable roles appear in the console start form. */
  launchable: boolean;
  defaultBudgetCents: number | null; // null → cfg.team.defaultBudgetCents
  handBack: string;
  defaultAcceptance: string;
}

const ALL: readonly PortalKind[] = ['production', 'sandbox', 'test'];
const NON_PROD: readonly PortalKind[] = ['sandbox', 'test'];

export const TEAM_AGENT_CATALOG: Record<TeamAgentSlug, TeamAgentSpec> = {
  orchestrator: {
    slug: 'orchestrator',
    label: 'PYB Orchestrator',
    environment: 'pyb-orchestrated',
    writes: true,
    mcp: ['hubspot', 'fireflies', 'github'],
    allowedPortalKinds: NON_PROD,
    launchable: false,
    defaultBudgetCents: 4000,
    handBack: 'Summary of every specialist hand-back and what still needs a human.',
    defaultAcceptance: 'Every specialist task closed or explicitly handed back.',
  },
  project_manager: {
    slug: 'project_manager',
    label: 'Project Manager',
    environment: 'pyb-office',
    writes: true,
    mcp: ['hubspot', 'fireflies'],
    allowedPortalKinds: NON_PROD,
    launchable: true,
    defaultBudgetCents: null,
    handBack: 'Proposed task list and follow-up draft; every HubSpot write waits for PYB approval.',
    defaultAcceptance: 'Each task has an owner, a due date and a source quote.',
  },
  solutions_architect: {
    slug: 'solutions_architect',
    label: 'Solutions Architect',
    environment: 'pyb-office',
    writes: false,
    mcp: ['hubspot', 'fireflies'],
    allowedPortalKinds: ALL,
    launchable: true,
    defaultBudgetCents: null,
    handBack: 'Solution brief written to /mnt/session/outputs/ and summarised in your final message.',
    defaultAcceptance: 'Brief covers scope, objects/properties, integrations, risks and open questions.',
  },
  content: {
    slug: 'content',
    label: 'Content',
    environment: 'pyb-office',
    writes: true,
    mcp: ['hubspot'],
    allowedPortalKinds: NON_PROD,
    launchable: true,
    defaultBudgetCents: null,
    handBack: 'Drafts and the exact HubSpot changes proposed; writes wait for approval.',
    defaultAcceptance: 'Drafts match the brief and PYB tone.',
  },
  hubspot_developer: {
    slug: 'hubspot_developer',
    label: 'HubSpot Developer',
    environment: 'pyb-build',
    writes: true,
    mcp: ['hubspot', 'github'],
    allowedPortalKinds: NON_PROD,
    launchable: false,
    defaultBudgetCents: null,
    handBack: 'PR link and test evidence.',
    defaultAcceptance: 'Tests pass; PR description lists every portal change.',
  },
  qa: {
    slug: 'qa',
    label: 'QA',
    environment: 'pyb-build',
    writes: false,
    mcp: ['hubspot', 'github'],
    allowedPortalKinds: NON_PROD,
    launchable: false,
    defaultBudgetCents: null,
    handBack: 'QA report with pass/fail per acceptance criterion.',
    defaultAcceptance: 'Every criterion tested.',
  },
  security_reviewer: {
    slug: 'security_reviewer',
    label: 'Security Reviewer',
    environment: 'pyb-build',
    writes: false,
    mcp: ['hubspot'],
    allowedPortalKinds: ALL,
    launchable: true,
    defaultBudgetCents: null,
    handBack: 'Findings with severity, evidence and fix; no changes made.',
    defaultAcceptance: 'Each finding has a reproducible failure path.',
  },
  hubspot_admin: {
    slug: 'hubspot_admin',
    label: 'HubSpot Admin',
    environment: 'pyb-office',
    writes: true,
    mcp: ['hubspot'],
    allowedPortalKinds: NON_PROD,
    launchable: true,
    defaultBudgetCents: null,
    handBack: 'List of portal changes made (after approval) and anything left undone.',
    defaultAcceptance: 'Every change approved in the PYB console before it was made.',
  },
  migration_data: {
    slug: 'migration_data',
    label: 'Migration & Data',
    environment: 'pyb-migration',
    writes: true,
    mcp: ['hubspot'],
    allowedPortalKinds: NON_PROD,
    launchable: false,
    defaultBudgetCents: null,
    handBack: 'Migration report with row counts and rejects.',
    defaultAcceptance: 'Counts reconcile.',
  },
};
