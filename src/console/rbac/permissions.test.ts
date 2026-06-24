import { describe, it, expect } from 'vitest';
import { can, assertCan, hasHubspotAdminMode, PermissionDeniedError, type Role } from './permissions.js';

const viewer: Role = { name: 'viewer', permissions: ['audit:read'] };
const configurer: Role = { name: 'configurer', permissions: ['agents:*'] };
const admin: Role = { name: 'admin', permissions: ['*'] };

describe('can (deny-by-default)', () => {
  it('grants an exact permission', () => {
    expect(can([viewer], 'audit:read')).toBe(true);
  });
  it('denies anything not explicitly granted', () => {
    expect(can([viewer], 'agents:edit')).toBe(false);
  });
  it('honours a resource wildcard', () => {
    expect(can([configurer], 'agents:edit')).toBe(true);
    expect(can([configurer], 'escalation:approve')).toBe(false);
  });
  it('honours a global wildcard', () => {
    expect(can([admin], 'anything:goes')).toBe(true);
  });
});

describe('assertCan', () => {
  it('throws when denied', () => {
    expect(() => assertCan([viewer], 'agents:edit')).toThrow(PermissionDeniedError);
  });
});

describe('hasHubspotAdminMode', () => {
  it('is gated behind the explicit grant', () => {
    expect(hasHubspotAdminMode([viewer])).toBe(false);
    expect(hasHubspotAdminMode([{ name: 'hs', permissions: ['hubspot:admin_mode'] }])).toBe(true);
  });
});
