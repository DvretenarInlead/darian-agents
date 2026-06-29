/**
 * Server-rendered admin console views (no frontend build, no template engine —
 * plain, escaped string functions). One service serves API + UI at /console.
 * All dynamic values go through `esc()` to prevent HTML injection.
 */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface NavUser {
  email: string;
  permissions: string[];
}

const STYLE = `
  :root{font-family:system-ui,sans-serif;line-height:1.5}
  body{margin:0;color:#1a1a2e;background:#f6f7fb}
  header{background:#1a1a2e;color:#fff;padding:.75rem 1rem;display:flex;gap:1rem;align-items:center}
  header a{color:#cfd3ff;text-decoration:none;font-size:.9rem}
  header .sp{flex:1}
  main{max-width:980px;margin:1.5rem auto;padding:0 1rem}
  h1{font-size:1.3rem}
  table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 3px #0001}
  th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #eee;font-size:.9rem;vertical-align:top}
  th{background:#fafbff}
  form.inline{display:inline}
  input,select,textarea{font:inherit;padding:.4rem;border:1px solid #ccd;border-radius:4px;width:100%;box-sizing:border-box}
  button{font:inherit;padding:.45rem .8rem;border:0;border-radius:4px;background:#3b3b98;color:#fff;cursor:pointer}
  button.danger{background:#b00020}
  .card{background:#fff;padding:1rem;border-radius:6px;box-shadow:0 1px 3px #0001;margin-bottom:1rem;max-width:420px}
  .flash{padding:.6rem .8rem;border-radius:4px;margin-bottom:1rem}
  .flash.err{background:#fde8e8;color:#9b1c1c}
  .flash.ok{background:#e6f4ea;color:#1e7e34}
  .muted{color:#777;font-size:.85rem}
  label{display:block;margin:.6rem 0 .2rem;font-size:.85rem;font-weight:600}
`;

const NAV = [
  { href: '/console', label: 'Dashboard', perm: null },
  { href: '/console/escalations', label: 'Escalations', perm: 'escalation:approve' },
  { href: '/console/agents', label: 'Agents', perm: 'agents:edit' },
  { href: '/console/triggers', label: 'Triggers', perm: 'triggers:edit' },
  { href: '/console/audit', label: 'Audit', perm: 'audit:read' },
  { href: '/console/security', label: 'Security', perm: 'users:manage' },
] as const;

export function layout(opts: { title: string; user?: NavUser; flash?: { kind: 'ok' | 'err'; msg: string }; body: string }): string {
  const links = opts.user
    ? NAV.filter((n) => !n.perm || opts.user!.permissions.includes(n.perm) || opts.user!.permissions.includes('*'))
        .map((n) => `<a href="${n.href}">${esc(n.label)}</a>`)
        .join('')
    : '';
  const header = opts.user
    ? `<header>${links}<span class="sp"></span><span class="muted" style="color:#cfd3ff">${esc(opts.user.email)}</span><a href="/console/logout">Sign out</a></header>`
    : '';
  const flash = opts.flash ? `<div class="flash ${opts.flash.kind === 'ok' ? 'ok' : 'err'}">${esc(opts.flash.msg)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)} · darian-agents</title><style>${STYLE}</style></head><body>${header}<main>${flash}${opts.body}</main></body></html>`;
}

/** Hidden CSRF field for any state-changing form. */
export function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}
