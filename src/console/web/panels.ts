import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appendAudit } from '../../core/audit/writer.js';
import { verifyChain, type AuditEntryInput } from '../../core/audit/hashChain.js';
import { isEngaged, setKillSwitch } from '../killswitch.js';
import { recordSodAction, assertApprovalAllowed, SeparationOfDutiesError } from '../rbac/sod.js';
import { layout, csrfField, esc, type NavUser } from './views.js';
import { resolveUser, csrfOk, can, ensureCsrf, type ConsoleDeps, type CurrentUser } from './context.js';
import { AGENTS } from '../../core/agents/contract.js';
import { getAgentScope } from '../../core/governance/credentials.js';
import { config } from '../../config/index.js';
import { DEFAULT_AGENT_PROMPTS, DEFAULT_ASSISTANT_SKILL } from '../../products/meeting/prompts.js';
import { SyncRules, SETTINGS_KEY, loadSyncRules } from '../../products/meeting/rules.js';
import { randomBytes } from 'node:crypto';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.js';
import { encrypt, decrypt } from '../../core/crypto/envelope.js';

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
  // Agents dashboard: the FULL roster (not just customised rows) with live
  // capability badges (governance scope + which integrations are configured),
  // enabled state, and prompt/model editing. Saving creates a new version.
  app.get('/console/agents', async (req, reply) => {
    const user = await guard(req, reply, deps, 'agents:edit');
    if (!user) return;
    const csrf = ensureCsrf(req, reply, deps);
    const { rows } = await deps.pool.query<{ agent: string; prompt: string; model: string; enabled: boolean; version: number }>(
      `SELECT DISTINCT ON (agent) agent, prompt, model, enabled, version FROM agent_configs ORDER BY agent, version DESC`,
    );
    const configured = new Map(rows.map((r) => [r.agent, r]));
    const cfg = config();

    const toolBadges = (agent: string): string => {
      const scope = getAgentScope(agent as (typeof AGENTS)[number]);
      const badges: string[] = scope.egress.map((h) => h.replace('api.', ''));
      if (agent === 'assistant') {
        badges.push(cfg.fireflies.apiKey ? 'meeting tools: ON' : 'meeting tools: off (no FIREFLIES_API_KEY)');
        badges.push(cfg.hubspot.accessToken ? 'task tools: ON' : 'task tools: off (no HUBSPOT_ACCESS_TOKEN)');
        badges.push(cfg.elevenlabs.apiKey ? 'voice: ON' : 'voice: browser fallback');
      }
      if (agent === 'orchestrator') {
        badges.push(cfg.slack.botToken && cfg.slack.channelId ? 'slack pings: ON' : 'slack pings: off');
      }
      return badges.map((b) => `<span class="muted">[${esc(b)}]</span>`).join(' ');
    };

    const defaultPromptFor = (agent: string): string =>
      agent === 'assistant'
        ? DEFAULT_ASSISTANT_SKILL
        : ((DEFAULT_AGENT_PROMPTS as Record<string, string>)[agent] ?? '');

    const body = `<h1>Agents</h1>
      <p class="muted">All platform agents. Badges show each agent's allowed egress and live tool status.
      Prompt edits are versioned, audited, and take effect within ~30s (assistant) or on the next run (board).</p>
      ${AGENTS.map((agent) => {
        const r = configured.get(agent);
        const prompt = r?.prompt ?? defaultPromptFor(agent);
        const enabled = r?.enabled ?? true;
        const status = r ? `v${r.version} · ${enabled ? 'enabled' : 'DISABLED'}` : 'default (not customised)';
        return `<div class="card" style="max-width:680px"><strong>${esc(agent)}</strong> <span class="muted">${esc(status)}</span><br>${toolBadges(agent)}
        <form method="post" action="/console/agents">${csrfField(csrf)}<input type="hidden" name="agent" value="${esc(agent)}">
          <label>Model <span class="muted">(empty = platform default)</span></label><input name="model" value="${esc(r?.model ?? '')}">
          <label>Prompt${agent === 'assistant' ? ' <span class="muted">(conversational skill block — how it prepares lists/tasks)</span>' : ''}</label><textarea name="prompt" rows="5">${esc(prompt)}</textarea>
          <label><input type="checkbox" name="enabled" style="width:auto" ${enabled ? 'checked' : ''}> enabled</label>
          <p><button>Save new version</button></p>
        </form></div>`;
      }).join('')}`;
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
  // Skills: sync rules — how the pipeline creates HubSpot projects/tasks and
  // which data lands in which fields. Stored in app_settings, versioned,
  // audited; the assistant's conversational skill lives in the Agents panel.
  const envProjectDefaults = () => ({
    pipeline: process.env.HUBSPOT_PROJECT_PIPELINE ?? 'default',
    pipelineStage: process.env.HUBSPOT_PROJECT_STAGE ?? 'new',
  });

  app.get('/console/skills', async (req, reply) => {
    const user = await guard(req, reply, deps, 'agents:edit');
    if (!user) return;
    const csrf = ensureCsrf(req, reply, deps);
    const rules = await loadSyncRules(deps.pool, envProjectDefaults());
    const body = `<h1>Skills — sync rules</h1>
      <p class="muted">Controls how approved meeting items become HubSpot projects and tasks.
      The assistant's conversational skill (how it prepares to-do lists) is edited under <a href="/console/agents">Agents → assistant</a>.</p>
      <div class="card" style="max-width:640px">
      <form method="post" action="/console/skills">${csrfField(csrf)}
        <h2 style="font-size:1rem">Project</h2>
        <label>Name template <span class="muted">({meetingId} is substituted)</span></label>
        <input name="nameTemplate" value="${esc(rules.project.nameTemplate)}">
        <label>Pipeline</label><input name="pipeline" value="${esc(rules.project.pipeline)}">
        <label>Pipeline stage</label><input name="pipelineStage" value="${esc(rules.project.pipelineStage)}">
        <label>Type <span class="muted">(optional)</span></label><input name="type" value="${esc(rules.project.type ?? '')}">
        <h2 style="font-size:1rem;margin-top:1rem">Tasks</h2>
        <label>Title prefix <span class="muted">(e.g. "[PYB] "; empty = none)</span></label>
        <input name="titlePrefix" value="${esc(rules.task.titlePrefix)}">
        <label><input type="checkbox" name="includeMeetingContext" style="width:auto" ${rules.task.includeMeetingContext ? 'checked' : ''}> append meeting reference to task notes</label>
        <label>Default due date <span class="muted">(days from processing; empty = leave unset)</span></label>
        <input name="defaultDueDays" value="${rules.task.defaultDueDays ?? ''}" inputmode="numeric">
        <p><button>Save rules</button></p>
      </form></div>`;
    return reply.type('text/html').send(layout({ title: 'Skills', user: navUser(user), body }));
  });

  app.post('/console/skills', async (req, reply) => {
    const user = await guard(req, reply, deps, 'agents:edit');
    if (!user) return;
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    if (needsSudo(reply, user, '/console/skills')) return;
    const f = (req.body ?? {}) as Record<string, string | undefined>;
    const candidate = {
      project: {
        nameTemplate: f.nameTemplate ?? '',
        pipeline: f.pipeline ?? '',
        pipelineStage: f.pipelineStage ?? '',
        ...(f.type?.trim() ? { type: f.type.trim() } : {}),
      },
      task: {
        titlePrefix: f.titlePrefix ?? '',
        includeMeetingContext: f.includeMeetingContext === 'on',
        defaultDueDays: f.defaultDueDays?.trim() ? Number(f.defaultDueDays) : null,
      },
    };
    const parsed = SyncRules.safeParse(candidate);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.type('text/html').send(
        layout({ title: 'Skills', user: navUser(user), flash: { kind: 'err', msg: `Invalid rules — ${msg}` }, body: '<p><a href="/console/skills">Back</a></p>' }),
      );
    }
    await deps.pool.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = app_settings.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [SETTINGS_KEY, JSON.stringify(parsed.data), user.id],
    );
    await recordSodAction(deps.pool, { subjectId: SETTINGS_KEY, action: 'configured', actorId: user.id });
    await appendAudit(
      deps.pool,
      { eventType: 'config_change', product: 'console', actorId: user.id, subjectId: SETTINGS_KEY, payload: { rules: parsed.data } },
      deps.now().toISOString(),
    );
    return reply.redirect('/console/skills');
  });

  // MFA (TOTP) self-enrollment — any signed-in user secures their own account.
  // The seed is shown once at enrollment, then stored only envelope-encrypted.
  app.get('/console/mfa', async (req, reply) => {
    const user = await guard(req, reply, deps);
    if (!user) return;
    const csrf = ensureCsrf(req, reply, deps);
    const record = await deps.users.findById(user.id);

    if (record?.mfaEnabled) {
      const body = `<h1>Two-factor authentication</h1>
        <div class="card" style="max-width:560px"><p>MFA is <strong>enabled</strong> for ${esc(user.email)}.</p>
        <form method="post" action="/console/mfa/disable">${csrfField(csrf)}
          <label>Current authenticator code</label><input name="totp" inputmode="numeric" autocomplete="one-time-code">
          <p><button class="danger">Disable MFA</button></p>
        </form></div>`;
      return reply.type('text/html').send(layout({ title: 'MFA', user: navUser(user), body }));
    }

    if (!deps.keyring) {
      const body = `<h1>Two-factor authentication</h1>
        <div class="card" style="max-width:560px"><p class="muted">ENVELOPE_MASTER_KEY is not configured, so MFA seeds cannot be stored encrypted. Set it (32 bytes base64) and redeploy, then return here.</p></div>`;
      return reply.type('text/html').send(layout({ title: 'MFA', user: navUser(user), body }));
    }

    const secret = generateTotpSecret(randomBytes);
    const uri = otpauthUri(secret, user.email);
    const body = `<h1>Two-factor authentication</h1>
      <div class="card" style="max-width:560px">
      <p>1. In your authenticator app (Google Authenticator, 1Password, Authy…) choose <em>add account → enter key manually</em> and paste:</p>
      <p><code style="font-size:1.05rem;letter-spacing:.08em">${esc(secret)}</code></p>
      <p class="muted">Or open this link on a device with the app installed: <a href="${esc(uri)}">${esc(uri)}</a></p>
      <p>2. Enter the 6-digit code the app shows to confirm:</p>
      <form method="post" action="/console/mfa/enable">${csrfField(csrf)}
        <input type="hidden" name="secret" value="${esc(secret)}">
        <label>Code</label><input name="totp" inputmode="numeric" autocomplete="one-time-code">
        <p><button>Enable MFA</button></p>
      </form></div>`;
    return reply.type('text/html').send(layout({ title: 'MFA', user: navUser(user), body }));
  });

  app.post('/console/mfa/enable', async (req, reply) => {
    const user = await guard(req, reply, deps);
    if (!user) return;
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    if (needsSudo(reply, user, '/console/mfa')) return;
    if (!deps.keyring) return reply.redirect('/console/mfa');
    const { secret, totp: code } = (req.body ?? {}) as { secret?: string; totp?: string };
    const nowSec = Math.floor(deps.now().getTime() / 1000);
    if (!secret || !/^[A-Z2-7]{16,64}$/.test(secret) || !verifyTotp(code ?? '', secret, nowSec)) {
      return reply.type('text/html').send(
        layout({ title: 'MFA', user: navUser(user), flash: { kind: 'err', msg: 'Code did not match — scan/enter the key again.' }, body: '<p><a href="/console/mfa">Try again</a></p>' }),
      );
    }
    await deps.users.setMfa(user.id, encrypt(secret, deps.keyring), true);
    await appendAudit(deps.pool, { eventType: 'auth_event', product: 'console', actorId: user.id, subjectId: user.id, payload: { mfa: 'enabled' } }, deps.now().toISOString());
    return reply.redirect('/console/mfa');
  });

  app.post('/console/mfa/disable', async (req, reply) => {
    const user = await guard(req, reply, deps);
    if (!user) return;
    if (!csrfOk(req)) return reply.code(403).send('invalid form token');
    if (needsSudo(reply, user, '/console/mfa')) return;
    const record = await deps.users.findById(user.id);
    const nowSec = Math.floor(deps.now().getTime() / 1000);
    const { totp: code } = (req.body ?? {}) as { totp?: string };
    const stored = record?.mfaSecretEnc && deps.keyring ? decrypt(record.mfaSecretEnc, deps.keyring).toString('utf8') : '';
    if (!stored || !verifyTotp(code ?? '', stored, nowSec)) {
      return reply.type('text/html').send(
        layout({ title: 'MFA', user: navUser(user), flash: { kind: 'err', msg: 'Current code required to disable MFA.' }, body: '<p><a href="/console/mfa">Back</a></p>' }),
      );
    }
    await deps.users.setMfa(user.id, null, false);
    await appendAudit(deps.pool, { eventType: 'auth_event', product: 'console', actorId: user.id, subjectId: user.id, payload: { mfa: 'disabled' } }, deps.now().toISOString());
    return reply.redirect('/console/mfa');
  });

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
