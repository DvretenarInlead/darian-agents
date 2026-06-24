-- ============================================================================
-- Migration 0003 — durable job queue (outbox)
--
-- Decouples burst ingestion (webhook receiver) from slow LLM/sync work. The
-- web tier enqueues; worker instances claim jobs with FOR UPDATE SKIP LOCKED
-- so many workers can drain the queue concurrently without double-processing.
-- Retries use run_after for visibility-timeout/backoff; exhausted jobs become
-- 'failed' (dead-letter). dedupe_key gives idempotent enqueue (e.g. one job per
-- webhook delivery id).
-- ============================================================================

CREATE TABLE jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,                       -- meeting_ingest | repo_score | ...
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending|running|done|failed
  attempts     INT  NOT NULL DEFAULT 0,
  max_attempts INT  NOT NULL DEFAULT 5,
  run_after    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- visibility / backoff gate
  locked_at    TIMESTAMPTZ,
  last_error   TEXT,
  dedupe_key   TEXT,                                -- optional idempotency key
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_chk CHECK (status IN ('pending', 'running', 'done', 'failed'))
);

-- Idempotent enqueue: at most one job per dedupe_key.
CREATE UNIQUE INDEX jobs_dedupe_key_idx ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
-- Claim path: pending jobs whose visibility gate has passed, oldest first.
CREATE INDEX jobs_claim_idx ON jobs (run_after) WHERE status = 'pending';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO app_rw;
  END IF;
END
$$;
