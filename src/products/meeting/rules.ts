import { z } from 'zod';
import type { Pool } from 'pg';
import type { TaskInput } from '../../integrations/hubspot/types.js';

/**
 * Operator-tunable sync rules (console → /console/skills → app_settings).
 * Controls how the pipeline creates HubSpot projects/tasks and which data
 * lands in which fields — without a deploy. Everything falls back to safe
 * defaults, and a malformed stored value is ignored rather than trusted.
 */

export const SyncRules = z.object({
  project: z.object({
    /** '{meetingId}' is substituted; e.g. "Meeting {meetingId} — action items". */
    nameTemplate: z.string().min(1).max(200),
    pipeline: z.string().min(1).max(100),
    pipelineStage: z.string().min(1).max(100),
    type: z.string().max(100).optional(),
  }),
  task: z.object({
    /** Prepended to every task title, e.g. "[PYB] ". Empty = none. */
    titlePrefix: z.string().max(50),
    /** Append "From meeting <id> (<date>)" to the task body. */
    includeMeetingContext: z.boolean(),
    /** Default due date offset in days when the item has none. null = leave unset. */
    defaultDueDays: z.number().int().min(0).max(365).nullable(),
  }),
});
export type SyncRules = z.infer<typeof SyncRules>;

export const SETTINGS_KEY = 'sync_rules';

/**
 * Operator tool policy: which assistant/MCP tools are disabled. Stored as
 * {"disabled": ["create_project", ...]} under this key; missing/malformed →
 * nothing disabled (tools are opt-out, availability itself is config-driven).
 */
export const TOOL_POLICY_KEY = 'assistant_tool_policy';

const ToolPolicy = z.object({ disabled: z.array(z.string().max(64)).max(64) });

export async function loadDisabledTools(pool: Pool): Promise<string[]> {
  try {
    const { rows } = await pool.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [TOOL_POLICY_KEY]);
    if (!rows[0]) return [];
    const parsed = ToolPolicy.safeParse(rows[0].value);
    return parsed.success ? parsed.data.disabled : [];
  } catch {
    return [];
  }
}

export function defaultSyncRules(env: { pipeline: string; pipelineStage: string; type?: string }): SyncRules {
  return {
    project: {
      nameTemplate: 'Meeting {meetingId} — action items',
      pipeline: env.pipeline,
      pipelineStage: env.pipelineStage,
      ...(env.type ? { type: env.type } : {}),
    },
    task: { titlePrefix: '', includeMeetingContext: true, defaultDueDays: null },
  };
}

/** Load stored rules merged over defaults; malformed/missing → defaults. */
export async function loadSyncRules(
  pool: Pool,
  env: { pipeline: string; pipelineStage: string; type?: string },
): Promise<SyncRules> {
  const defaults = defaultSyncRules(env);
  try {
    const { rows } = await pool.query<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = $1`, [SETTINGS_KEY]);
    if (!rows[0]) return defaults;
    const parsed = SyncRules.safeParse(rows[0].value);
    return parsed.success ? parsed.data : defaults;
  } catch {
    return defaults; // table missing (pre-migration) or transient error
  }
}

/** Render the project name from the template. Pure. */
export function projectName(rules: SyncRules, meetingId: string): string {
  return rules.project.nameTemplate.replaceAll('{meetingId}', meetingId).slice(0, 200);
}

/** Apply task field rules (prefix, meeting context, default due). Pure. */
export function applyTaskRules(task: TaskInput, rules: SyncRules, meetingId: string, nowIso: string): TaskInput {
  const title = `${rules.task.titlePrefix}${task.title}`.slice(0, 500);
  const contextLine = `From meeting ${meetingId} (${nowIso.slice(0, 10)})`;
  const body = rules.task.includeMeetingContext
    ? task.body
      ? `${task.body}\n\n${contextLine}`
      : contextLine
    : task.body;
  const dueDate =
    task.dueDate ??
    (rules.task.defaultDueDays !== null
      ? new Date(Date.parse(nowIso) + rules.task.defaultDueDays * 86_400_000).toISOString().slice(0, 10)
      : undefined);
  return {
    ...task,
    title,
    ...(body !== undefined ? { body } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
  };
}
