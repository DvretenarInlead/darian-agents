/**
 * Deny-by-default RBAC (build-order step 7).
 *
 * A permission is `resource:action` (e.g. `agents:edit`, `escalation:approve`,
 * `hubspot:admin_mode`). Access is granted only by an explicit matching grant in
 * one of the actor's roles. Wildcards are supported (`agents:*`, `*`) for
 * coarse roles, but absence of a grant is always a denial.
 */

export interface Role {
  name: string;
  permissions: string[];
}

export class PermissionDeniedError extends Error {}

function grantMatches(grant: string, permission: string): boolean {
  if (grant === '*' || grant === permission) return true;
  const [gRes, gAct] = grant.split(':');
  const [pRes] = permission.split(':');
  return gAct === '*' && gRes === pRes;
}

export function can(roles: Role[], permission: string): boolean {
  return roles.some((role) => role.permissions.some((g) => grantMatches(g, permission)));
}

export function assertCan(roles: Role[], permission: string): void {
  if (!can(roles, permission)) {
    throw new PermissionDeniedError(`permission denied: ${permission}`);
  }
}

/** Convenience: does any role grant admin-mode HubSpot ops? */
export function hasHubspotAdminMode(roles: Role[]): boolean {
  return can(roles, 'hubspot:admin_mode');
}
