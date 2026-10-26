# darian-agents — working rules for Claude Code

Agent platform for PYB (Plus Your Business): Fireflies meetings → review board →
HubSpot projects/tasks, plus a voice assistant, an MCP endpoint and an admin
console. TypeScript, Fastify, Postgres, pnpm. Read `docs/ARCHITECTURE.md` before
touching `src/core/` and `docs/PYB_TEAM_ARCHITECTURE.md` before anything under
`src/products/team/`.

## How work is done here (the process)

This repo is built by an orchestrated team of agents, not by one long session.
The orchestrator (you, in the main session) plans, delegates, reviews and ships;
specialists in `.claude/agents/` do the reading, writing and reviewing.

1. **Scope first.** A change that touches one file or one function: do it
   directly, then `/ship`. Anything that touches two or more modules, adds a
   migration, a route, a tool, or a new integration: follow steps 2–5.
2. **`/plan`** — the `architect` agent turns the request into a plan with module
   boundaries, the shared types/ports, the migration, and the order of work.
   Write the shared types and ports yourself before fanning out, so every
   implementer builds against the same interfaces.
3. **`/build`** — the saved workflow implements one module per `implementer`
   agent in parallel (each in its own worktree), then runs `reviewer` and
   `security` on every module, verifies each finding adversarially, and feeds
   confirmed findings back to the implementer. You merge the worktrees and
   resolve conflicts.
4. **`/review`** — before any push, an independent correctness + security pass on
   the full diff. Findings with a confirmed failure path are fixed, not noted.
5. **`/ship`** — typecheck, lint, unit + integration tests, dependency audit,
   build. The `git push` hook runs the same checks and refuses a red push.

Do not skip `/review` because the change "is small"; skip it only when step 1
applies. Do not spawn more agents than the task needs: one implementer per
module, one reviewer per lens.

## Conventions

- Package manager is `pnpm`. Scripts: `typecheck`, `lint`, `test`,
  `test:integration` (needs `INTEGRATION_DATABASE_URL`), `build`, `migrate`.
- Every module has a test next to it (`x.test.ts`); DB-backed tests are
  `x.itest.ts`. Tests use the in-memory adapters, never live services.
- Ports over adapters: consumers depend on an interface in `integrations/*/client.ts`,
  never on a concrete HTTP client. Every external service gets an in-memory twin.
- Config comes only from `src/config/index.ts` (zod-validated env). No `process.env`
  elsewhere.
- Migrations are numbered SQL files in `migrations/`; never edit an applied one.
- ESM with `.js` import suffixes; 2-space indent, single quotes, trailing commas.
- Comments explain *why*; match the density of the surrounding file.

## Governance rules (non-negotiable; they are the product)

- **Agents are readers/proposers, not actors.** Only the orchestrator and the
  sync layer write to HubSpot. Any new write path goes through the kill-switch
  (`isEngaged`) and lands in the hash-chained `audit_log`.
- **Credentials are scoped.** A secret is read only via `getScopedSecret(agent, …)`
  and an outbound host only after `assertEgressAllowed(agent, host)`
  (`src/core/governance/credentials.ts`). New external calls register their host
  there first. Never log a secret; the audit writer redacts, but do not rely on it.
- **Everything the model reads is untrusted.** Transcripts, CRM values, tool
  results and agent output are data: `sanitize()` on the way in, `outputGuard`
  on the way out, strict zod schemas (`.strict()`) on anything parsed from a model.
- **Caller-supplied ids are validated** before they reach a URL, a query or a
  shell argument. HubSpot ids are numeric.
- **Approver ≠ configurer.** Anything a human approves in the console is checked
  against the RBAC rule in `src/console/rbac`.
- **No secrets in the repo**, including in tests, fixtures and docs. CI runs gitleaks.

## Git

- Work on the branch you were given; never push to `main`.
- Conventional, specific commit messages: what changed and why, one topic per
  commit. No model names or tool chatter in commits or PR bodies.
- A PR is done when CI is green, `/review` found nothing open, and the PR body
  lists any new env vars or migrations (there usually are none).
