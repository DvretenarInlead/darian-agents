---
name: ship
description: Run the full pre-push gate (typecheck, lint, unit tests, integration tests when a database is available, dependency audit, build), fix what fails, then commit and push. Use before every push; the git push hook runs the same gate and refuses a red push.
allowed-tools: Bash(./scripts/preflight.sh *) Bash(pnpm *) Bash(git status *) Bash(git diff *) Bash(git add *) Bash(git commit *) Bash(git push *) Bash(git log *)
---

Ship the current branch.

1. Run `./scripts/preflight.sh`. It runs, in order: `pnpm typecheck`,
   `pnpm lint`, `pnpm test`, `pnpm test:integration` (only when
   `INTEGRATION_DATABASE_URL` is set), `pnpm audit --audit-level high`,
   `pnpm build`. It stops at the first failure.
2. If anything fails, fix the cause (never the check: no skipped tests, no
   disabled rules, no audit exceptions) and run the script again until it
   passes end to end.
3. Review `git status` and `git diff --stat`. Everything staged must belong to
   this change; nothing generated or secret may be included.
4. Commit with a specific message (what and why, one topic) and push with
   `git push -u origin <current branch>`. The PreToolUse hook runs the same
   preflight and will refuse the push if it is red.
5. Report: the commit sha, the checks that ran with their counts, and anything
   you changed to make them pass.
