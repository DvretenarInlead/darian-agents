import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appendAudit } from '../../core/audit/writer.js';
import { verifyChain, type AuditEntryInput } from '../../core/audit/hashChain.js';
import { isEngaged, setKillSwitch } from '../killswitch.js';
import { recordSodAction, assertApprovalAllowed, SeparationOfDutiesError } from '../rbac/sod.js';
import { layout, csrfField, esc, type NavUser } from './views.js';
import { resolveUser, csrfOk, can, ensureCsrf, type ConsoleDeps, type CurrentUser } from './context.js';

function navUser(u: CurrentUser): NavUser {
  return { email: u.email, permissions: u.permissions };
}

/** Resolve + authorize. Returns the user, or null after sending a redirect/403. */
async function guard(req: FastifyRequest, reply: FastifyReply, deps: ConsoleDeps, perm?: string): Promise<CurrentUser | null> {
  const user = await resolveUser(req, deps);
  if (!user) {
    void reply.redirect('/console/login');
    return null;
  }
  if (perm && !can(user, perm)) {
    void reply.code(403).type('text/html').send(layout({ title: 'Forbidden', user: navUser(user), body: '<h1>403 — not permitted</h1>' }));
    return null;
  }
  return user;
}

/** Returns true (and redirects to sudo) when the action needs re-auth. */
function needsSudo(reply: FastifyReply, user: CurrentUser, returnTo: string): boolean {
  if (user.sudoActive) return false;
  void reply.redirect('/console/sudo?return=' + encodeURIComponent(returnTo));
  return true;
}

export function registerPanelRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  // Dashboard
  app.get('/console', async (req, reply) => {
    const user = await guard(req, reply, deps);
    if (!user) return;
    const pending = await deps.pool.query<{ n: string }>(`SELECT count(*) n FROM escalation_queue WHERE status='pending'`);
    const frozen = await isEngaged(deps.pool);
    return reply.type('text/html').send(
      layout({
        title: 'Dashboard',
        user: navUser(user),
        body: `<h1>Dashboard</h1>
          <table>
            <tr><th>Pending escalations</th><td>${esc(pending.rows[0]?.n ?? '0')}</td></tr>
            <tr><th>External writes</th><td>${frozen ? '<strong>FROZEN (kill-switch on)</strong>' : 'enabled'}</td></tr>
          </table>`,
      }),
    );
  });

  // Escalation queue
  app.get('/console/escalations', async (req, reply) => {
    const user = await guard(req, reply, deps, 'escalation:approve');
    if (!user) return;
    const csrf = ensureCsrf(req, reply, deps);
    const { rows } = await deps.pool.query<{ id: string; product: string; subject_id: string; reason: string; created_at: Date }>(
      `SELECT id, product, subject_id, reason, created_at FROM escalation_queue WHERE status='pending' ORDER BY created_at LIMIT 200`,
    );
    const body = rows.length
      ? `<table><tr><th>Subject</th><th>Reason</th><th>When</th><th></th></tr>${rows
          .map(
            (r) => `<tr><td>${esc(r.subject_id)}<div class="muted">${esc(r.product)}</div></td><td>${esc(r.reason)}</td><td class="muted">${esc(r.created_at)}</td>
            <td><form class="inline" method="post" action="/console/escalations/${esc(r.id)}/approve">${csrfField(csrf)}<button>Approve</button></form>
                <form class="inline" method="post" action="/console/escalations/${esc(r.id)}/reject">${csrfField(csrf)}<button class="danger">Reject</button></form></td></tr>`,
          )
          .join('')}</table>`
      : '<p class="muted">No pending escalations.</p>';
    return reply.type('text/html').send(layout({ title: 'Escalations', user: navUser(user), body: `<h1>Escalation queue</h1>${body}` }));
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post(`/console/escalations/:id/${action}`, async (req, reply) => {
      const user = await guard(req, reply, deps, 'escalation:approve');
      if (!user) return;
      if (!csrfOk(req)) return reply.code(403).send('invalid form token');
      if (needsSudo(reply, user, '/console/escalations')) return;
      const id = (req.params as { id: string }).id;
      const { rows } = await deps.pool.query<{ subject_id: string }>(`SELECT subject_id FROM escalation_queue WHERE id=$1 AND status='pending'`, [id]);
      const subjectId = rows[0]?.subject_id;
      if (!subjectId) return reply.redirect('/console/escalations');

      if (action === 'approve') {
        // Separation of duties: the configurer of this subject cannot approve it.
        try {
          await assertApprovalAllowed(deps.pool, user.id, subjectId);
        } catch (err) {
          if (err instanceof SeparationOfDutiesError) {
            return reply.code(403).type('text/html').send(layout({ title: 'Blocked', user: navUser(user), body: `<div class="flash err">${esc(err.message)}</div><p><a href="/console/escalations">Back</a></p>` }));
          }
          throw err;
        }
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      await deps.pool.query(`UPDATE escalation_queue SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [id, status, user.id]);
      await recordSodAction(deps.pool, { subjectId, action: status, actorId: user.id });
      await appendAudit(deps.pool, { eventType: status === 'approved' ? 'approval' : 'escalation', product: 'console', actorId: user.id, subjectId, payload: { decision: status } }, deps.now().toISOString());
      return reply.redirect('/console/escalations');
    });
  }

  // Audit viewer (with hash-chain integrity status)
  app.get('/console/audit', async (req, reply) => {
    const user = await guard(req, reply, deps, 'audit:read');
    if (!user) return;
    const { rows } = await deps.pool.query<{ event_type: string; product: string | null; actor_id: string | null; subject_id: string | null; payload: unknown; prev_hash: string | null; row_hash: string; created_at: Date }>(
      `SELECT event_type, product, actor_id, subject_id, payload, prev_hash, row_hash, created_at FROM audit_log ORDER BY id DESC LIMIT 100`,
    );
    const ordered = [...rows].reverse();
    const chain = ordered.map((r) => ({ eventType: r.event_type, product: r.product, actorId: r.actor_id, subjectId: r.subject_id, payload: r.payload, createdAt: new Date(r.created_at).toISOString(), prevHash: r.prev_hash, rowHash: r.row_hash })) as Array<AuditEntryInput & { prevHash: string | null; rowHash: string }>;
    const integrity = verifyChain(chain);
    const status = integrity.valid
      ? '<span style="color:#1e7e34">✓ hash chain intact (last 100)</span>'
      : `<span style="color:#b00020">✗ chain broken at row ${integrity.brokenAt}</span>`;
    const body = `<h1>Audit log</h1><p>${status}</p><table><tr><th>When</th><th>Event</th><th>Product</th><th>Subject</th></tr>${rows
      .map((r) => `<tr><td class="muted">${esc(r.created_at)}</td><td>${esc(r.event_type)}</td><td>${esc(r.product)}</td><td>${esc(r.subject_id)}</td></tr>`)
      .join('')}</table>`;
    return reply.type('text/html').send(layout({ title: 'Audit', user: navUser(user), body }));
  });

  registerAgentRoutes(app, deps, guard, needsSudo);
  registerTriggerRoutes(app, deps, guard);
  registerSecurityRoutes(app, deps, guard, needsSudo);
}

type Guard = (req: FastifyRequest, reply: FastifyReply, deps: ConsoleDeps, perm?: string) => Promise<CurrentUser | null>;
type NeedsSudo = (reply: FastifyReply, user: CurrentUser, returnTo: string) => boolean;

function registerAgentRoutes(app: FastifyInstance, deps: ConsoleDeps, guard: Guard, needsSudo: NeedsSudo): void {
  app.get('/console/agents', async (req, reply) => {
    const user = await guard(req, reply, deps, 'agents:edit');
    if (!user) return;
    const csrf = ensureCsrf(req, reply, deps);
    const { rows } = await deps.pool.query<{ agent: string; prompt: string; model: string; enabled: boolean; version: number }>(
      `SELECT DISTINCT ON (agent) agent, prompt, model, enabled, version FROM agent_configs ORDER BY agent, version DESC`,
    );
    const body = `<h1>Agents</h1>${rows
      .map(
        (r) => `<div class="card" style="max-width:640px"><strong>${esc(r.agent)}</strong> <span class="muted">v${esc(r.version)} · ${r.enabled ? 'enabled' : 'disabled'}</span>
        <form method="post" action="/console/agents">${csrfField(csrf)}<input type="hidden" name="agent" value="${esc(r.agent)}">
          <label>Model</label><input name="model" value="${esc(r.model)}">
          <label>Prompt</label><textarea name="prompt" rows="4">${esc(r.prompt)}</textarea>
          <label><input type="checkbox" name="enabled" style="width:auto" ${r.enabled ? 'checked' : ''}> enabled</label>
          <p><button>Save new version</button></p>
        </form></div>`,
      )
      .join('')}`;
    return reply.type('text/html').send(layout({ title: 'Agents', user: { email: user.email, permissions: user.permissions }, body }));
  });

  app.post('/console/agents', async (req, reply) => {
    const user = await guard(req, reply, deps, 'agents:edit');
    if (!user) return;
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    if (needsSudo(reply, user, '/console/agents')) return;
    const { agent, model, prompt, enabled } = (req.body ?? {}) as { agent?: string; model?: string; prompt?: string; enabled?: string };
    if (!agent) return reply.redirect('/console/agents');
    const max = await deps.pool.query<{ v: number }>(`SELECT COALESCE(MAX(version),0) v FROM agent_configs WHERE agent=$1`, [agent]);
    const version = (max.rows[0]?.v ?? 0) + 1;
    await deps.pool.query(`INSERT INTO agent_configs (agent, prompt, model, enabled, version, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`, [agent, prompt ?? '', model ?? '', enabled === 'on', version, user.id]);
    // SoD: editing a subject's config bars this actor from approving it later.
    await recordSodAction(deps.pool, { subjectId: agent, action: 'configured', actorId: user.id });
    await appendAudit(deps.pool, { eventType: 'config_change', product: 'console', actorId: user.id, subjectId: agent, payload: { agent, version } }, deps.now().toISOString());
    return reply.redirect('/console/agents');
  });
}

function registerTriggerRoutes(app: FastifyInstance, deps: ConsoleDeps, guard: Guard): void {
  app.get('/console/triggers', async (req, reply) => {
    const user = await guard(req, reply, deps, 'triggers:edit');
    if (!user) return;
    const csrf = ensureCsrf(req, reply, deps);
    const { rows } = await deps.pool.query<{ id: string; kind: string; enabled: boolean }>(`SELECT id, kind, enabled FROM trigger_configs ORDER BY kind`);
    const body = `<h1>Triggers</h1><table><tr><th>Kind</th><th>Enabled</th><th></th></tr>${rows
      .map(
        (r) => `<tr><td>${esc(r.kind)}</td><td>${r.enabled ? 'yes' : 'no'}</td><td><form class="inline" method="post" action="/console/triggers/${esc(r.id)}/toggle">${csrfField(csrf)}<button>${r.enabled ? 'Disable' : 'Enable'}</button></form></td></tr>`,
      )
      .join('')}</table>`;
    return reply.type('text/html').send(layout({ title: 'Triggers', user: { email: user.email, permissions: user.permissions }, body }));
  });

  app.post('/console/triggers/:id/toggle', async (req, reply) => {
    const user = await guard(req, reply, deps, 'triggers:edit');
    if (!user) return;
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    const id = (req.params as { id: string }).id;
    await deps.pool.query(`UPDATE trigger_configs SET enabled = NOT enabled, updated_by=$2, updated_at=now() WHERE id=$1`, [id, user.id]);
    await appendAudit(deps.pool, { eventType: 'config_change', product: 'console', actorId: user.id, subjectId: id, payload: { toggled: 'trigger' } }, deps.now().toISOString());
    return reply.redirect('/console/triggers');
  });
}

function registerSecurityRoutes(app: FastifyInstance, deps: ConsoleDeps, guard: Guard, needsSudo: NeedsSudo): void {
  app.get('/console/security', async (req, reply) => {
    const user = await guard(req, reply, deps, 'users:manage');
    if (!user) return;
    const csrf = ensureCsrf(req, reply, deps);
    const frozen = await isEngaged(deps.pool);
    const users = await deps.users.list();
    const body = `<h1>Security</h1>
      <div class="card"><strong>Incident kill-switch</strong><p class="muted">External writes are ${frozen ? '<strong>FROZEN</strong>' : 'enabled'}.</p>
        <form method="post" action="/console/security/killswitch">${csrfField(csrf)}<input type="hidden" name="engage" value="${frozen ? 'off' : 'on'}">
          <button class="${frozen ? '' : 'danger'}">${frozen ? 'Resume external writes' : 'Freeze external writes'}</button></form></div>
      <h2 style="font-size:1rem">Users</h2>
      <table><tr><th>Email</th><th>Status</th><th>MFA</th><th></th></tr>${users
        .map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.status)}</td><td>${u.mfaEnabled ? 'on' : 'off'}</td>
          <td><form class="inline" method="post" action="/console/security/users/${esc(u.id)}/revoke-sessions">${csrfField(csrf)}<button class="danger">Revoke sessions</button></form></td></tr>`)
        .join('')}</table>`;
    return reply.type('text/html').send(layout({ title: 'Security', user: { email: user.email, permissions: user.permissions }, body }));
  });

  app.post('/console/security/killswitch', async (req, reply) => {
    const user = await guard(req, reply, deps, 'killswitch:toggle');
    if (!user) return;
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    if (needsSudo(reply, user, '/console/security')) return;
    const engage = ((req.body ?? {}) as { engage?: string }).engage === 'on';
    await setKillSwitch(deps.pool, engage, user.id);
    await appendAudit(deps.pool, { eventType: 'config_change', product: 'console', actorId: user.id, subjectId: 'kill_switch', payload: { engaged: engage } }, deps.now().toISOString());
    return reply.redirect('/console/security');
  });

  app.post('/console/security/users/:id/revoke-sessions', async (req, reply) => {
    const user = await guard(req, reply, deps, 'users:manage');
    if (!user) return;
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    if (needsSudo(reply, user, '/console/security')) return;
    const id = (req.params as { id: string }).id;
    await deps.sessions.revokeAllForUser(id);
    await appendAudit(deps.pool, { eventType: 'auth_event', product: 'console', actorId: user.id, subjectId: id, payload: { event: 'sessions_revoked' } }, deps.now().toISOString());
    return reply.redirect('/console/security');
  });
}
