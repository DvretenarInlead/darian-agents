import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../../core/audit/writer.js';
import { recordSodAction } from '../rbac/sod.js';
import { config } from '../../config/index.js';
import { TEAM_AGENT_CATALOG, TEAM_AGENT_SLUGS } from '../../products/team/catalog.js';
import {
  BudgetDollars,
  DenyMessageText,
  PortalInput,
  StartRunInput,
  TEAM_PERMS,
  TeamBudgetsInput,
  TeamError,
  sodSubject,
  type LockfileStatus,
  type TeamBudgets,
  type TeamErrorCode,
} from '../../products/team/types.js';
import { layout, type NavUser } from './views.js';
import { can, csrfOk, ensureCsrf, type ConsoleDeps, type CurrentUser, type TeamConsoleDeps } from './context.js';
import { guard, needsSudo } from './panels.js';
import {
  NOTES,
  approvalsPage,
  notEnabledBody,
  portalsPage,
  runPage,
  runsPage,
  tabs,
  type TimelineRow,
} from './teamViews.js';

const TITLE = 'Team';
const TEAM_BUDGETS_SUBJECT = 'team_budgets';
const UUID = z.uuid();

const navUser = (u: CurrentUser): NavUser => ({ email: u.email, permissions: u.permissions });

const ERROR_STATUS: Partial<Record<TeamErrorCode, number>> = {
  invalid_input: 400,
  budget_invalid: 400,
  permission_denied: 403,
  sod_denied: 403,
  disabled: 503,
  unknown_agent: 404,
  portal_not_found: 404,
  run_not_found: 404,
  action_not_found: 404,
};

/** A page that shows one message and a way back; the route's own status code. */
function messagePage(reply: FastifyReply, user: CurrentUser, status: number, msg: string, back: string) {
  return reply
    .code(status)
    .type('text/html')
    .send(layout({ title: TITLE, user: navUser(user), flash: { kind: 'err', msg }, body: `<p><a href="${back}">Back</a></p>` }));
}

function notFound(reply: FastifyReply, user: CurrentUser) {
  return reply.code(404).type('text/html').send(layout({ title: 'Not found', user: navUser(user), body: '<h1>404 — not found</h1>' }));
}

/** A TeamError becomes a flash, never a stack trace. Anything else is a real bug and propagates. */
function teamErrorPage(err: unknown, reply: FastifyReply, user: CurrentUser, back: string) {
  if (err instanceof TeamError) {
    return messagePage(reply, user, ERROR_STATUS[err.code] ?? 409, `${err.code}: ${err.message}`, back);
  }
  throw err;
}

function noteFrom(req: FastifyRequest): { flash: { kind: 'ok'; msg: string } } | Record<string, never> {
  const key = (req.query as { note?: unknown } | undefined)?.note;
  return typeof key === 'string' && Object.hasOwn(NOTES, key) ? { flash: { kind: 'ok', msg: NOTES[key]! } } : {};
}

function bodyOf(req: FastifyRequest): Record<string, string | undefined> {
  return (req.body ?? {}) as Record<string, string | undefined>;
}

/** "12.50" → 1250; empty → undefined; anything else → null (invalid). */
function dollarsToCents(raw: string | undefined): number | null | undefined {
  const t = (raw ?? '').trim();
  if (t === '') return undefined;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

async function loadBudgets(deps: ConsoleDeps): Promise<TeamBudgets> {
  const { rows } = await deps.pool.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key=$1`, [TEAM_BUDGETS_SUBJECT]);
  const parsed = TeamBudgetsInput.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : { defaultCents: null, perAgent: {} };
}

function canApproveAny(user: CurrentUser): boolean {
  return can(user, TEAM_PERMS.approve) || can(user, TEAM_PERMS.approveProduction);
}

export function registerTeamRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  const tabsFor = (user: CurrentUser) =>
    tabs({ view: can(user, TEAM_PERMS.view), portals: can(user, TEAM_PERMS.portals), approvals: canApproveAny(user) });

  const page = (
    req: FastifyRequest,
    reply: FastifyReply,
    user: CurrentUser,
    body: string,
    extra: { flash?: { kind: 'ok' | 'err'; msg: string } } = {},
  ) => reply.type('text/html').send(layout({ title: TITLE, user: navUser(user), ...noteFrom(req), ...extra, body: `${tabsFor(user)}${body}` }));

  /**
   * Shared prologue for every POST: guard, CSRF (403), team enabled, :id → UUID (404), sudo.
   * Returns null after it has replied.
   */
  async function postPrologue(
    req: FastifyRequest,
    reply: FastifyReply,
    opts: { perm?: string; anyApprove?: boolean; sudoReturn?: string | ((id: string) => string); id?: boolean },
  ): Promise<{ user: CurrentUser; team: TeamConsoleDeps; id: string } | null> {
    const user = await guard(req, reply, deps, opts.perm);
    if (!user) return null;
    if (opts.anyApprove && !canApproveAny(user)) {
      void messagePage(reply, user, 403, 'not permitted', '/console/team/approvals');
      return null;
    }
    if (!csrfOk(req)) {
      void reply.code(403).send('invalid form token');
      return null;
    }
    if (!deps.team) {
      void reply.code(503).type('text/html').send(layout({ title: TITLE, user: navUser(user), body: notEnabledBody() }));
      return null;
    }
    let id = '';
    if (opts.id) {
      const parsed = UUID.safeParse((req.params as { id?: string }).id);
      if (!parsed.success) {
        void notFound(reply, user);
        return null;
      }
      id = parsed.data;
    }
    if (opts.sudoReturn) {
      const returnTo = typeof opts.sudoReturn === 'function' ? opts.sudoReturn(id) : opts.sudoReturn;
      if (needsSudo(reply, user, returnTo)) return null;
    }
    return { user, team: deps.team, id };
  }

  /** Shared prologue for GETs that render team data. */
  async function getPrologue(req: FastifyRequest, reply: FastifyReply, perm: string | null, any = false) {
    const user = await guard(req, reply, deps, any ? undefined : (perm ?? undefined));
    if (!user) return null;
    if (any && !canApproveAny(user)) {
      void reply.code(403).type('text/html').send(layout({ title: 'Forbidden', user: navUser(user), body: '<h1>403 — not permitted</h1>' }));
      return null;
    }
    if (!deps.team) {
      void reply.type('text/html').send(layout({ title: TITLE, user: navUser(user), body: notEnabledBody() }));
      return null;
    }
    return { user, team: deps.team };
  }

  app.get('/console/team', async (req, reply) => {
    const user = await guard(req, reply, deps, TEAM_PERMS.view);
    if (!user) return;
    return reply.redirect('/console/team/runs');
  });

  // ---- Portals + budgets ----
  app.get('/console/team/portals', async (req, reply) => {
    const ctx = await getPrologue(req, reply, TEAM_PERMS.portals);
    if (!ctx) return;
    const csrf = ensureCsrf(req, reply, deps);
    const [portals, budgets] = await Promise.all([ctx.team.store.listPortals(), loadBudgets(deps)]);
    return page(req, reply, ctx.user, portalsPage(portals, budgets, config().team.maxBudgetCents, csrf));
  });

  app.post('/console/team/portals', async (req, reply) => {
    const ctx = await postPrologue(req, reply, { perm: TEAM_PERMS.portals, sudoReturn: '/console/team/portals' });
    if (!ctx) return;
    const f = bodyOf(req);
    const parsed = PortalInput.safeParse({ label: f.label ?? '', hubspotId: f.hubspotId ?? '', kind: f.kind ?? '', vaultId: f.vaultId ?? '' });
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return messagePage(reply, ctx.user, 400, `Invalid portal — ${msg}`, '/console/team/portals');
    }
    try {
      const portal = await ctx.team.store.createPortal(parsed.data, ctx.user.id);
      const subjectId = sodSubject.portal(portal.id);
      await recordSodAction(deps.pool, { subjectId, action: 'configured', actorId: ctx.user.id });
      await appendAudit(
        deps.pool,
        {
          eventType: 'config_change',
          product: 'team',
          actorId: ctx.user.id,
          subjectId,
          payload: { action: 'create', kind: portal.kind, hubspotId: portal.hubspotId, vaultId: portal.vaultId },
        },
        deps.now().toISOString(),
      );
    } catch (err) {
      // A duplicate HubSpot id or a second production portal is a user error (DB unique constraints).
      const code = (err as { code?: string } | null)?.code;
      if (!(err instanceof TeamError) && code === '23505') {
        return messagePage(reply, ctx.user, 409, 'That HubSpot portal id is already registered, or a production portal already exists.', '/console/team/portals');
      }
      return teamErrorPage(err, reply, ctx.user, '/console/team/portals');
    }
    return reply.redirect('/console/team/portals?note=created');
  });

  app.post('/console/team/portals/:id/toggle', async (req, reply) => {
    const ctx = await postPrologue(req, reply, { perm: TEAM_PERMS.portals, sudoReturn: '/console/team/portals', id: true });
    if (!ctx) return;
    const enabled = bodyOf(req).enabled === 'true';
    try {
      const portal = await ctx.team.store.setPortalEnabled(ctx.id, enabled, ctx.user.id);
      if (!portal) return notFound(reply, ctx.user);
      const subjectId = sodSubject.portal(portal.id);
      await recordSodAction(deps.pool, { subjectId, action: 'configured', actorId: ctx.user.id });
      await appendAudit(
        deps.pool,
        { eventType: 'config_change', product: 'team', actorId: ctx.user.id, subjectId, payload: { action: 'toggle', enabled: portal.enabled } },
        deps.now().toISOString(),
      );
    } catch (err) {
      return teamErrorPage(err, reply, ctx.user, '/console/team/portals');
    }
    return reply.redirect(`/console/team/portals?note=${enabled ? 'enabled' : 'disabled'}`);
  });

  app.post('/console/team/budgets', async (req, reply) => {
    const ctx = await postPrologue(req, reply, { perm: TEAM_PERMS.portals, sudoReturn: '/console/team/portals' });
    if (!ctx) return;
    const f = bodyOf(req);
    const max = config().team.maxBudgetCents;
    const back = '/console/team/portals';
    const defaultCents = dollarsToCents(f.default);
    if (defaultCents === null) return messagePage(reply, ctx.user, 400, 'Invalid default budget: use dollars such as 10 or 10.50.', back);
    const perAgent: Record<string, number> = {};
    for (const slug of TEAM_AGENT_SLUGS) {
      if (!TEAM_AGENT_CATALOG[slug].launchable) continue;
      const cents = dollarsToCents(f[`agent_${slug}`]);
      if (cents === null) return messagePage(reply, ctx.user, 400, `Invalid budget for ${slug}: use dollars such as 10 or 10.50.`, back);
      if (cents !== undefined) perAgent[slug] = cents;
    }
    const parsed = TeamBudgetsInput.safeParse({ defaultCents: defaultCents ?? null, perAgent });
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return messagePage(reply, ctx.user, 400, `Invalid budgets — ${msg}`, back);
    }
    const all = [parsed.data.defaultCents, ...Object.values(parsed.data.perAgent)].filter((c): c is number => typeof c === 'number');
    if (all.some((c) => c > max)) {
      return messagePage(reply, ctx.user, 400, `Budgets may not exceed ${max / 100} dollars (TEAM_MAX_BUDGET_CENTS).`, back);
    }
    await deps.pool.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = app_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [TEAM_BUDGETS_SUBJECT, JSON.stringify(parsed.data), ctx.user.id],
    );
    await recordSodAction(deps.pool, { subjectId: TEAM_BUDGETS_SUBJECT, action: 'configured', actorId: ctx.user.id });
    await appendAudit(
      deps.pool,
      { eventType: 'config_change', product: 'team', actorId: ctx.user.id, subjectId: TEAM_BUDGETS_SUBJECT, payload: { budgets: parsed.data } },
      deps.now().toISOString(),
    );
    return reply.redirect('/console/team/portals?note=budgets');
  });

  // ---- Runs ----
  app.get('/console/team/runs', async (req, reply) => {
    const ctx = await getPrologue(req, reply, TEAM_PERMS.view);
    if (!ctx) return;
    const csrf = ensureCsrf(req, reply, deps);
    const [runs, portals, lock] = await Promise.all([
      ctx.team.store.listRuns(100),
      ctx.team.store.listPortals(),
      ctx.team.lockStatus().catch((): LockfileStatus | null => null),
    ]);
    return page(req, reply, ctx.user, runsPage({ runs, portals, lock, canRun: can(ctx.user, TEAM_PERMS.run), csrf }));
  });

  app.post('/console/team/runs', async (req, reply) => {
    const ctx = await postPrologue(req, reply, { perm: TEAM_PERMS.run, sudoReturn: '/console/team/runs' });
    if (!ctx) return;
    const f = bodyOf(req);
    const parsed = StartRunInput.safeParse({
      agentSlug: f.agentSlug ?? '',
      portalId: f.portalId?.trim() ? f.portalId.trim() : null,
      clientLabel: f.clientLabel?.trim() ? f.clientLabel : 'PYB',
      projectRef: f.projectRef?.trim() ? f.projectRef.trim() : null,
      task: f.task ?? '',
      inputs: f.inputs ?? '',
      acceptanceCriteria: f.acceptanceCriteria ?? '',
      trigger: 'console',
      startedBy: ctx.user.id,
    });
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return messagePage(reply, ctx.user, 400, `Invalid run — ${msg}`, '/console/team/runs');
    }
    try {
      const run = await ctx.team.launcher.start(parsed.data);
      return reply.redirect(`/console/team/runs/${encodeURIComponent(run.id)}?note=started`);
    } catch (err) {
      return teamErrorPage(err, reply, ctx.user, '/console/team/runs');
    }
  });

  app.get('/console/team/runs/:id', async (req, reply) => {
    const ctx = await getPrologue(req, reply, TEAM_PERMS.view);
    if (!ctx) return;
    const id = UUID.safeParse((req.params as { id?: string }).id);
    if (!id.success) return notFound(reply, ctx.user);
    const csrf = ensureCsrf(req, reply, deps);
    const run = await ctx.team.store.getRun(id.data);
    if (!run) return notFound(reply, ctx.user);
    const [pending, timeline] = await Promise.all([
      ctx.team.store.listPendingForRun(run.id),
      deps.pool.query<TimelineRow>(
        `SELECT event_type, actor_id, payload, created_at FROM audit_log WHERE subject_id=$1 AND product='team' ORDER BY id LIMIT 500`,
        [run.id],
      ),
    ]);
    return page(
      req,
      reply,
      ctx.user,
      runPage({
        run,
        pending,
        timeline: timeline.rows,
        workspaceId: config().team.workspaceId,
        canRun: can(ctx.user, TEAM_PERMS.run),
        canBudget: can(ctx.user, TEAM_PERMS.budget),
        csrf,
      }),
    );
  });

  app.post('/console/team/runs/:id/message', async (req, reply) => {
    const ctx = await postPrologue(req, reply, { perm: TEAM_PERMS.run, id: true });
    if (!ctx) return;
    const back = `/console/team/runs/${ctx.id}`;
    try {
      await ctx.team.launcher.followUp({ runId: ctx.id, text: bodyOf(req).text ?? '', actorId: ctx.user.id });
    } catch (err) {
      return teamErrorPage(err, reply, ctx.user, back);
    }
    return reply.redirect(`${back}?note=sent`);
  });

  app.post('/console/team/runs/:id/interrupt', async (req, reply) => {
    const ctx = await postPrologue(req, reply, { perm: TEAM_PERMS.run, id: true });
    if (!ctx) return;
    const back = `/console/team/runs/${ctx.id}`;
    try {
      await ctx.team.launcher.interrupt({ runId: ctx.id, actorId: ctx.user.id });
    } catch (err) {
      return teamErrorPage(err, reply, ctx.user, back);
    }
    return reply.redirect(`${back}?note=interrupted`);
  });

  app.post('/console/team/runs/:id/budget', async (req, reply) => {
    const back0 = (id: string) => `/console/team/runs/${id}`;
    const ctx = await postPrologue(req, reply, { perm: TEAM_PERMS.budget, id: true, sudoReturn: back0 });
    if (!ctx) return;
    const dollars = BudgetDollars.safeParse(bodyOf(req).dollars);
    if (!dollars.success) return messagePage(reply, ctx.user, 400, 'Invalid budget: whole dollars between 1 and 100000.', back0(ctx.id));
    try {
      await ctx.team.launcher.raiseBudget({ runId: ctx.id, newCents: dollars.data * 100, actorId: ctx.user.id });
    } catch (err) {
      return teamErrorPage(err, reply, ctx.user, back0(ctx.id));
    }
    return reply.redirect(`${back0(ctx.id)}?note=raised`);
  });

  // ---- Approvals ----
  app.get('/console/team/approvals', async (req, reply) => {
    const ctx = await getPrologue(req, reply, null, true);
    if (!ctx) return;
    const csrf = ensureCsrf(req, reply, deps);
    const actions = await ctx.team.store.listPendingActions(['pending', 'deciding'], 200);
    return page(req, reply, ctx.user, approvalsPage(actions, csrf));
  });

  for (const verb of ['approve', 'deny'] as const) {
    app.post(`/console/team/approvals/:id/${verb}`, async (req, reply) => {
      // The per-portal-kind permission (team:approve vs team:approve_production) and SoD are enforced in the gate.
      const ctx = await postPrologue(req, reply, { anyApprove: true, id: true, sudoReturn: '/console/team/approvals' });
      if (!ctx) return;
      const back = '/console/team/approvals';
      let denyMessage: string | null = null;
      if (verb === 'deny') {
        const m = DenyMessageText.safeParse(bodyOf(req).denyMessage ?? '');
        if (!m.success) return messagePage(reply, ctx.user, 400, 'Deny message is too long (1000 characters maximum).', back);
        denyMessage = m.data.trim() === '' ? null : m.data;
      }
      try {
        const outcome = await ctx.team.gate.decide({
          actionId: ctx.id,
          actor: { id: ctx.user.id, permissions: ctx.user.permissions },
          result: verb === 'approve' ? 'allow' : 'deny',
          denyMessage,
        });
        const note = outcome.status === 'void' ? 'void' : outcome.forced ? 'forced' : verb === 'approve' ? 'approved' : 'denied';
        return reply.redirect(`${back}?note=${note}`);
      } catch (err) {
        return teamErrorPage(err, reply, ctx.user, back);
      }
    });
  }
}
