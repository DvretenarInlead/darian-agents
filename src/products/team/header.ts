import { sanitize } from '../../core/agents/sanitize.js';
import type { TeamAgentSpec } from './catalog.js';
import type { PortalKind } from './types.js';

export interface HeaderInput {
  spec: TeamAgentSpec;
  portal: { hubspotId: string; kind: PortalKind } | null;
  clientLabel: string;
  projectRef: string | null;
  inputs: string;
  acceptanceCriteria: string;
  task: string;
}

/** One-line field: untrusted text must not be able to start a new header line. */
function oneLine(s: string): string {
  return sanitize(s, { maxLength: 200 }).replace(/[\r\n]+/g, ' ').trim();
}

/**
 * The standard kickoff header, generated in code so no caller can omit or
 * reorder a line. Everything caller-supplied is sanitised; the portal line comes
 * from the resolved team_portals row, never from the request.
 */
export function buildRunHeader(h: HeaderInput): string {
  const inputs = sanitize(h.inputs, { maxLength: 4_000 }).trim();
  const acceptance = sanitize(h.acceptanceCriteria, { maxLength: 4_000 }).trim();
  const task = sanitize(h.task, { maxLength: 20_000 }).trim();
  const portal = h.portal
    ? `${h.portal.hubspotId} (${h.portal.kind}) — confirm you are connected to this account before any action`
    : 'none';
  return [
    `CLIENT: ${oneLine(h.clientLabel) || 'PYB'}`,
    `PROJECT: ${h.projectRef ? oneLine(h.projectRef) : 'none'}`,
    `PORTAL: ${portal}`,
    `INPUTS: ${inputs || 'none'}`,
    `ACCEPTANCE CRITERIA: ${acceptance || h.spec.defaultAcceptance}`,
    `HAND BACK: ${h.spec.handBack}`,
    '---',
    'TASK:',
    task,
  ].join('\n');
}
