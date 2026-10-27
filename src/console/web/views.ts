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

// Visual language shared with the /assistant HUD: deep space background,
// glass panels, cyan→violet accents. Class names are unchanged so every
// panel renders without edits.
const STYLE = `
  :root{
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.55;color-scheme:dark;
    --bg0:#05070f;--bg1:#0b1020;--panel:rgba(17,26,48,.72);--panel-solid:#111a30;
    --line:rgba(84,118,190,.22);--text:#dbe4ff;--dim:#7487b8;
    --cyan:#59e3ff;--blue:#4f7cff;--violet:#9a6bff;--danger:#ff6b6b;--ok:#4ade80;
  }
  *{box-sizing:border-box}
  body{
    margin:0;min-height:100vh;color:var(--text);
    background:
      radial-gradient(1100px 520px at 50% -12%, #16224077 0%, transparent 60%),
      radial-gradient(900px 600px at 90% 110%, #251a4d55 0%, transparent 55%),
      linear-gradient(180deg,var(--bg1) 0%,var(--bg0) 100%);
    background-attachment:fixed;
  }
  header{
    position:sticky;top:0;z-index:20;display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;
    padding:.7rem 1.1rem;border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,rgba(11,16,32,.92),rgba(11,16,32,.55));backdrop-filter:blur(10px);
  }
  .brand{
    font-weight:700;font-size:.82rem;letter-spacing:.3em;text-transform:uppercase;margin-right:.9rem;
    background:linear-gradient(90deg,var(--cyan),var(--violet));-webkit-background-clip:text;background-clip:text;color:transparent;
    text-decoration:none;
  }
  header a{color:var(--dim);text-decoration:none;font-size:.85rem;padding:.32rem .7rem;border-radius:999px;border:1px solid transparent}
  header a:hover{color:var(--text);border-color:var(--line)}
  header a.active{color:var(--text);border-color:var(--line);background:rgba(36,54,92,.5)}
  header a.brand:hover{border-color:transparent}
  header .sp{flex:1}
  main{max-width:1020px;margin:1.6rem auto 3rem;padding:0 1.1rem}
  h1{font-size:1.05rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--text);margin:.2rem 0 1rem}
  h2{color:var(--text)}
  a{color:var(--cyan)}
  table{
    border-collapse:separate;border-spacing:0;width:100%;
    background:var(--panel);border:1px solid var(--line);border-radius:.9rem;overflow:hidden;backdrop-filter:blur(8px);
  }
  th,td{text-align:left;padding:.6rem .8rem;border-bottom:1px solid rgba(84,118,190,.12);font-size:.88rem;vertical-align:top}
  tr:last-child td{border-bottom:0}
  th{background:rgba(8,13,28,.55);color:var(--dim);font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;font-weight:600}
  tbody tr:hover td,tr:hover td{background:rgba(36,54,92,.18)}
  form.inline{display:inline}
  input,select,textarea{
    font:inherit;color:var(--text);padding:.5rem .65rem;width:100%;
    background:rgba(8,13,28,.8);border:1px solid var(--line);border-radius:.55rem;outline:none;
  }
  input:focus,select:focus,textarea:focus{border-color:#3b5aa0;box-shadow:0 0 0 3px rgba(79,124,255,.12)}
  textarea{resize:vertical;min-height:5.5rem}
  input[type=checkbox]{width:auto;accent-color:var(--blue)}
  button{
    font:inherit;font-weight:600;padding:.5rem 1.05rem;border:1px solid rgba(120,160,255,.35);border-radius:999px;
    background:linear-gradient(135deg,#24406e,#203058);color:var(--text);cursor:pointer;
  }
  button:hover{background:linear-gradient(135deg,#2c4a80,#263a6a);border-color:#3b5aa0}
  button.danger{background:linear-gradient(135deg,#7a1d1d,#521010);border-color:rgba(255,107,107,.4)}
  button.danger:hover{background:linear-gradient(135deg,#8f2424,#611414)}
  .card{
    background:var(--panel);border:1px solid var(--line);border-radius:1rem;backdrop-filter:blur(10px);
    padding:1.1rem 1.2rem;margin-bottom:1.1rem;max-width:440px;
  }
  .card strong{color:var(--text)}
  .flash{padding:.65rem .9rem;border-radius:.7rem;margin-bottom:1rem;border:1px solid}
  .flash.err{background:rgba(122,29,29,.25);color:#ffb4b4;border-color:rgba(255,107,107,.35)}
  .flash.ok{background:rgba(20,83,45,.3);color:#a7f3c8;border-color:rgba(74,222,128,.3)}
  .muted{color:var(--dim);font-size:.85rem}
  label{display:block;margin:.65rem 0 .25rem;font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
  code{background:rgba(8,13,28,.8);border:1px solid var(--line);border-radius:.4rem;padding:.15rem .45rem;color:var(--cyan)}
  ::selection{background:rgba(79,124,255,.35)}
`;

const NAV = [
  { href: '/console', label: 'Dashboard', perm: null },
  { href: '/console/escalations', label: 'Escalations', perm: 'escalation:approve' },
  { href: '/console/team/runs', label: 'Team', perm: 'team:view' },
  { href: '/console/agents', label: 'Agents', perm: 'agents:edit' },
  { href: '/console/skills', label: 'Skills', perm: 'agents:edit' },
  { href: '/console/triggers', label: 'Triggers', perm: 'triggers:edit' },
  { href: '/console/audit', label: 'Audit', perm: 'audit:read' },
  { href: '/console/security', label: 'Security', perm: 'users:manage' },
  { href: '/console/mfa', label: 'MFA', perm: null },
] as const;

export function layout(opts: { title: string; user?: NavUser; flash?: { kind: 'ok' | 'err'; msg: string }; body: string }): string {
  const links = opts.user
    ? NAV.filter((n) => !n.perm || opts.user!.permissions.includes(n.perm) || opts.user!.permissions.includes('*'))
        .map((n) => `<a href="${n.href}"${n.label === opts.title ? ' class="active"' : ''}>${esc(n.label)}</a>`)
        .join('')
    : '';
  const header = opts.user
    ? `<header><a class="brand" href="/console">Darian Agents</a>${links}<span class="sp"></span><span class="muted">${esc(opts.user.email)}</span><a href="/console/logout">Sign out</a></header>`
    : '';
  const flash = opts.flash ? `<div class="flash ${opts.flash.kind === 'ok' ? 'ok' : 'err'}">${esc(opts.flash.msg)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)} · darian-agents</title><style>${STYLE}</style></head><body>${header}<main>${flash}${opts.body}</main></body></html>`;
}

/** Hidden CSRF field for any state-changing form. */
export function csrfField(token: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(token)}">`;
}
