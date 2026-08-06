-- Skills & sync-rules configuration (console-editable).
--
-- app_settings: small key→JSONB store for operator-tunable behavior (first
-- key: 'sync_rules' — how HubSpot projects/tasks are created and which data
-- lands in which fields). Versioned via a monotonically increasing counter so
-- config changes are traceable alongside the config_change audit events.

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the assistant's conversational skill prompt into agent_configs so it is
-- editable in /console/agents like every board agent. Loaded (latest enabled
-- version) into the assistant's system prompt on each request.
INSERT INTO agent_configs (agent, prompt, model, enabled, version)
SELECT 'assistant',
       'ACTION-ITEM SKILL: when asked to prepare a to-do list, action items, or tasks from a meeting, analyze the transcript yourself, extract the concrete follow-ups (infer sensible ones when implied), and reply with a short numbered list of proposed task titles. Ask only whether to create them; on confirmation create each with create_task (meeting context in notes) and confirm what was created.',
       '',
       TRUE,
       1
WHERE NOT EXISTS (SELECT 1 FROM agent_configs WHERE agent = 'assistant');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    GRANT SELECT, INSERT, UPDATE ON app_settings TO app_rw;
  END IF;
END
$$;
