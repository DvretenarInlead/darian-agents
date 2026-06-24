-- ============================================================================
-- Provision the least-privilege application role (build-order step 8).
--
-- Run ONCE per database by an admin/owner role, BEFORE the app connects and
-- before/with the first migration. The migrations' grant blocks attach the
-- correct privileges to app_rw (including INSERT+SELECT-only on audit_log).
--
-- DigitalOcean Managed Postgres: create this via the console or `doctl`, then
-- point DATABASE_URL at app_rw (NOT the admin/doadmin role).
-- ============================================================================

-- 1. Create the role the application connects as.
--    Replace the password with a strong secret stored in DO App secrets.
CREATE ROLE app_rw LOGIN PASSWORD 'CHANGE_ME_STRONG_SECRET';

-- 2. Allow it to use the schema.
GRANT USAGE ON SCHEMA public TO app_rw;

-- 3. Re-run the migrations (or their DO $$ ... $$ grant blocks) so app_rw gets:
--      - full DML on operational tables,
--      - INSERT + SELECT only on audit_log (no UPDATE/DELETE),
--      - sequence usage.
--    The migration grant blocks are guarded by `IF EXISTS (… app_rw)`, so they
--    are no-ops until this role exists and take effect once it does.

-- 4. (Optional, defence in depth) prevent future tables from defaulting to
--    broad grants for app_rw — grant explicitly per table in migrations instead.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM app_rw;
