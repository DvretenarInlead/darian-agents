import { describe, it, expect } from 'vitest';
import { resolveBoard, type ResolutionPolicyEntry } from './resolution.js';
import type { Verdict } from '../agents/contract.js';

const v = (overrides: Partial<Verdict> & Pick<Verdict, 'agent'>): Verdict => ({
  subject_id: 'task-1',
  domain: overrides.agent === 'security' ? 'security' : 'general',
  disposition: 'pass',
  confidence: 0.9,
  issues: [],
  proposed_fix: null,
  context: null,
  ...overrides,
});

const policy = (entries: Partial<ResolutionPolicyEntry>[]): ResolutionPolicyEntry[] =>
  entries.map((e) => ({ condition: 'X', disposition: 'auto_fix', reversible: true, ...e }));

describe('resolveBoard', () => {
  it('proceeds when all agents pass', () => {
    const d = resolveBoard([v({ agent: 'dev' }), v({ agent: 'security' })], []);
    expect(d.outcome).toBe('proceed');
    expect(d.vetoed).toBe(false);
  });

  it('auto-fixes a reversible, policy-sanctioned failure', () => {
    const d = resolveBoard(
      [
        v({
          agent: 'dev',
          disposition: 'fail',
          issues: [{ code: 'missing_due_date', message: 'no date', severity: 'low' }],
          proposed_fix: 'set due date to next Friday',
        }),
      ],
      policy([{ condition: 'missing_due_date', disposition: 'auto_fix', reversible: true }]),
    );
    expect(d.outcome).toBe('proceed');
    expect(d.autoFixes).toHaveLength(1);
  });

  it('escalates when policy says escalate', () => {
    const d = resolveBoard(
      [
        v({
          agent: 'project_manager',
          disposition: 'fail',
          issues: [{ code: 'owner_unknown', message: 'no owner', severity: 'medium' }],
        }),
      ],
      policy([{ condition: 'owner_unknown', disposition: 'escalate', reversible: false }]),
    );
    expect(d.outcome).toBe('escalate');
    expect(d.vetoed).toBe(false);
  });

  it('escalates a non-reversible auto_fix (deny-by-default on irreversibility)', () => {
    const d = resolveBoard(
      [
        v({
          agent: 'hubspot_admin',
          disposition: 'fail',
          issues: [{ code: 'delete_project', message: 'remove dup', severity: 'high' }],
          proposed_fix: 'delete the duplicate project',
        }),
      ],
      policy([{ condition: 'delete_project', disposition: 'auto_fix', reversible: false }]),
    );
    expect(d.outcome).toBe('escalate');
  });

  it('security veto is non-overridable even when CTO passes', () => {
    const d = resolveBoard(
      [
        v({
          agent: 'security',
          domain: 'security',
          disposition: 'fail',
          issues: [{ code: 'secret_in_payload', message: 'token leak', severity: 'critical' }],
        }),
        v({ agent: 'cto', disposition: 'pass' }),
      ],
      [],
    );
    expect(d.outcome).toBe('escalate');
    expect(d.vetoed).toBe(true);
  });

  it('CTO breaks an ambiguous non-security tie toward proceed', () => {
    const d = resolveBoard(
      [
        v({ agent: 'dev', disposition: 'fail', issues: [{ code: 'style_nit', message: 'naming', severity: 'info' }] }),
        v({ agent: 'cto', disposition: 'pass' }),
      ],
      [], // no policy entry → ambiguous
    );
    expect(d.outcome).toBe('proceed');
    expect(d.vetoed).toBe(false);
  });

  it('ambiguous non-security failure escalates when CTO does not clear', () => {
    const d = resolveBoard(
      [
        v({ agent: 'dev', disposition: 'fail', issues: [{ code: 'style_nit', message: 'naming', severity: 'info' }] }),
        v({ agent: 'cto', disposition: 'fail', issues: [{ code: 'arch', message: 'bad', severity: 'medium' }] }),
      ],
      [],
    );
    expect(d.outcome).toBe('escalate');
  });

  it('escalates when a required agent did not report', () => {
    const d = resolveBoard([v({ agent: 'dev' })], [], { requiredAgents: ['dev', 'security'] });
    expect(d.outcome).toBe('escalate');
    expect(d.escalationReasons.join(' ')).toContain('security');
  });

  it('rejects mixed-subject verdicts', () => {
    expect(() =>
      resolveBoard([v({ agent: 'dev' }), v({ agent: 'cto', subject_id: 'other' })], []),
    ).toThrow();
  });
});
