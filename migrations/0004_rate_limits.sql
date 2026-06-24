-- ============================================================================
-- Migration 0004 — shared rate-limit counters
--
-- The in-memory limiter is per-instance; behind a load balancer that lets N×
-- the intended traffic through. This table backs a shared fixed-window limiter
-- so the budget is enforced across all web instances. (For very high volume,
-- swap in Redis behind the same RateLimiter interface.)
-- ============================================================================

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,   -- epoch ms of the current fixed window
  count        INT    NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO app_rw;
  END IF;
END
$$;
