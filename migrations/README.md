# Migrations

Plain SQL migrations applied in lexical filename order (`0001_…`, `0002_…`).
A `schema_migrations` table records which files have been applied; the runner
(`scripts/migrate.ts`) skips anything already recorded and applies each new file
inside a transaction.

## Running

```bash
pnpm migrate          # apply all pending migrations
```

`DATABASE_URL` (and optional `DATABASE_SSL=true`) drive the connection.

## Conventions

- Migrations are **forward-only and immutable** once committed. To change the
  schema, add a new numbered file — never edit an applied one. This is part of
  the ISO 9001 change-control evidence (8.5.6 Control of changes).
- Each file should be idempotent-safe where practical (`IF NOT EXISTS`) but the
  runner's `schema_migrations` ledger is the source of truth for what has run.

## Append-only audit role

`0001_init.sql` grants the application role `app_rw` only `SELECT, INSERT` on
`audit_log` (no `UPDATE`/`DELETE`). Provision that role out of band before the
app connects:

```sql
CREATE ROLE app_rw LOGIN PASSWORD '…';
-- then re-run migrate (or re-apply the grant block) so the grants attach.
```
