#!/usr/bin/env node
// PreToolUse hook: refuse `git push` unless scripts/preflight.sh passes.
// Claude Code pipes the tool call as JSON on stdin; printing a deny decision
// blocks the call and the reason is shown to the model. Anything that is not a
// git push exits 0 without a decision, so the normal permission flow applies.
import { spawnSync } from 'node:child_process';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

let command = '';
try {
  command = String(JSON.parse(input)?.tool_input?.command ?? '');
} catch {
  process.exit(0);
}
if (!/\bgit\s+push\b/.test(command)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const run = spawnSync('bash', ['scripts/preflight.sh'], { cwd: root, encoding: 'utf8', timeout: 9 * 60_000 });

if (run.status === 0) process.exit(0);

const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Push refused: scripts/preflight.sh failed (exit ${run.status ?? 'signal'}). Fix the cause, not the check, then push again.\n\n${tail}`,
    },
  }),
);
