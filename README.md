# darian-agents

A shared **agent-orchestration platform** hosting two products on common
infrastructure:

- **Product A — Meeting→Task Engine:** ingests Fireflies meeting data, extracts
  action items with an LLM, reconciles against existing HubSpot data, runs a
  multi-agent review board, then syncs approved items into HubSpot as Projects +
  Tasks. Includes a query agent ("what's my priority today?").
- **Product B — Repo Scoring:** on request, ingests a GitHub repo in a sandbox
  and runs a Dev + Security + CTO review board that scores code and integration
  quality.

One agent framework, one orchestrator, one admin console, one governance layer,
one audit log, one datastore. Product-specific logic lives in its own module.

> **Status:** foundation scaffold (build-order step 1 + core contracts).
> See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full build order and
> what is and isn't implemented yet.

## Stack

| Concern        | Choice                                              |
|----------------|-----------------------------------------------------|
| Runtime        | TypeScript (Node ≥ 20), ESM                         |
| HTTP           | Fastify                                             |
| Persistence    | DigitalOcean Managed Postgres (`pg`, raw SQL migrations) |
| Validation     | Zod (config + agent verdict contract)               |
| Tests          | Vitest                                              |
| Package mgr    | pnpm                                                |
| LLM            | Anthropic (commercial API terms — no training on inputs) |
| Hosting        | DigitalOcean App Platform (web + worker)            |

## Getting started

```bash
pnpm install
cp .env.example .env          # fill in secrets locally; never commit .env
pnpm migrate                  # apply Postgres migrations
pnpm dev                      # run the web service with reload
pnpm test                     # run unit tests
pnpm typecheck                # type-check without emitting
```

Health probes: `GET /healthz` (liveness), `GET /readyz` (DB readiness).

## Layout

```
migrations/        Forward-only SQL migrations (schema_migrations ledger)
scripts/migrate.ts Migration runner
src/
  config/          Validated env config (single source of truth)
  core/
    agents/        Strict-JSON verdict contract + untrusted-text sanitizer
    orchestrator/  Board resolution (Security veto, CTO tie-break) + policy loader
    governance/    Per-agent credential/egress scoping + output-side injection guard
    triggers/      Webhook verify/dedupe/rate-limit, cron locking, trigger registry
    audit/         Tamper-evident hash-chain, secret redaction, append-only writer
    db/            Shared pg pool
  integrations/
    hubspot/       HubSpotClient port + Agent CLI / Projects-API / in-memory adapters, plan + sync
  web/             Fastify plugins (hardened webhook receiver)
  index.ts         Web service entrypoint + health probes
docs/              Architecture, security, and ISO compliance mapping
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, build order, what's built.
- [`docs/SECURITY.md`](docs/SECURITY.md) — the security model and hardening controls.
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — ISO 9001 / 27001 / 42001 control mapping.
- [`docs/BUILD_BRIEF.md`](docs/BUILD_BRIEF.md) — the source build brief (v2).
