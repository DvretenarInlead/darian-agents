-- ============================================================================
-- Migration 0002 — incident kill-switch
--
-- Single-row flag shared across web + worker instances. When engaged, all
-- external writes (HubSpot sync, email) are frozen and triggers paused.
-- (ISO 27001 A.5.24–5.26 Incident management.)
-- ============================================================================

CREATE TABLE kill_switch (
  key        TEXT PRIMARY KEY,
  engaged    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the single external-writes flag (disengaged).
INSERT INTO kill_switch (key) VALUES ('external_writes_frozen')
  ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON kill_switch TO app_rw;
  END IF;
END
$$;
