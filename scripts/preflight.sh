#!/usr/bin/env bash
# Pre-push gate. Same checks CI runs, in the same order, stopping at the first
# failure. Used by /ship and by the git-push PreToolUse hook (.claude/hooks).
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$1"; }

step "typecheck";  pnpm -s typecheck
step "lint";       pnpm -s lint
step "unit tests"; pnpm -s test
if [[ -n "${INTEGRATION_DATABASE_URL:-}" ]]; then
  step "integration tests"; pnpm -s test:integration
else
  printf '\n== integration tests: skipped (INTEGRATION_DATABASE_URL not set; CI runs them)\n'
fi
step "dependency audit"; pnpm -s audit --audit-level high
step "build";      pnpm -s build

printf '\n== preflight: all checks passed\n'
