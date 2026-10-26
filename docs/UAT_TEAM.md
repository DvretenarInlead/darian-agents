# UAT: PYB Team control plane (phases 1–2)

What the owner sets up once, and the script to run through, for user acceptance
of the Team feature (`docs/plans/team-control-plane.md`). Nothing here needs
code changes; everything is configuration, credentials and clicks.

## A. One-off setup (owner)

1. **Deploy `main`** with the team PR merged. The migration
   `0006_team_control.sql` runs with the others (`pnpm migrate`).
2. **Anthropic**
   - `ANTHROPIC_API_KEY` already exists; the team feature reuses it.
   - Optional: `ANTHROPIC_WORKSPACE_ID` (from the Console URL) so each run page
     links to the session trace in the Anthropic Console.
3. **Create the agents** — from a machine with the `ant` CLI (1.30+) and the API
   key: `cd agents/pyb && ant apply .`, then commit `agents/pyb/claude-lock.json`
   and deploy again (the app reads ids from that file). See `agents/pyb/README.md`.
4. **Vaults** (Anthropic Console → Vaults, or the vaults API)
   - One vault per HubSpot portal with an `mcp_oauth` credential for
     `https://mcp.hubspot.com`. This is the one-off OAuth (PKCE) flow against
     each PYB portal; start with the **sandbox/test** portal. Note the `vlt_…` id.
   - One vault with the Fireflies credential for `https://api.fireflies.ai/mcp`
     (type per Fireflies' MCP docs: static bearer with the API key, or OAuth).
     Put its id in `TEAM_FIREFLIES_VAULT_ID`. Optional for UAT: without it the
     agent cannot read Fireflies and the transcript is pasted into the task.
   - GitHub vault (`TEAM_GITHUB_VAULT_ID`) is **not** needed for phases 1–2.
5. **App environment** (DO App Platform → app → environment variables)
   - `TEAM_ENABLED=true`
   - leave `TEAM_DEFAULT_BUDGET_CENTS` (1000 = $10), `TEAM_MAX_BUDGET_CENTS`
     (10000), `TEAM_APPROVAL_TTL_HOURS` (24) at their defaults for now
   - `TEAM_FIREFLIES_VAULT_ID`, `ANTHROPIC_WORKSPACE_ID` as above
6. **Roles** — grant the team permissions to the roles that should have them
   (the `*` admin role already has all): `team:view`, `team:run`,
   `team:approve`, `team:approve_production`, `team:portals`, `team:budget`.
   For UAT one admin is enough: sandbox/test approvals may be self-approved;
   production approvals still require a second person.
7. **Portal** — Console → Team → Portals → add the sandbox/test portal:
   label, HubSpot account id (numeric), kind `sandbox` or `test`, vault id.
   Add the production portal later, after UAT.

`pnpm check-env` (or the `/readyz` page) shows "Team control plane" as on.

## B. UAT script

Run in order; each step names what to look at.

1. **Lockfile banner.** Console → Team → Runs. No banner means
   `claude-lock.json` was read and all nine agents resolved. A banner names the
   missing agent/environment.
2. **Read-only run (Solutions Architect).** Start form: agent *Solutions
   Architect*, portal = your sandbox, task = paste a discovery transcript (or a
   Fireflies meeting id if the Fireflies vault is set), leave acceptance
   criteria empty. Expect: run page opens with status `running`, then
   `idle` with stop reason `end_turn`; the timeline shows the agent's messages
   (including the "connected to account … (sandbox)" confirmation and the
   brief); cost appears and stays under the $10 budget. Nothing to approve.
3. **Writing run (Project Manager).** Same portal, agent *Project Manager*,
   task = the ACG transcript used in the desk simulation. Expect: status
   becomes `requires_action`; Console → Team → Approvals lists one row per
   proposed HubSpot write (tool name, portal kind, input preview, age). A Slack
   ping arrives if Slack is configured.
4. **Approve one, deny one.** Approve the first task creation; deny the second
   with a reason. Expect: the approved one is created on the HubSpot sandbox
   project; the agent's next message acknowledges the denial and does not retry
   it; both decisions appear in the run timeline as `team_action_decided`
   (`selfApproved: true` because the starter approved on a sandbox portal).
5. **Follow-up.** On the run page send "Also add a task for the video
   walkthrough, owner Darian". Expect a new pending ask; approve it.
6. **Kill-switch.** Engage the kill-switch (Console → Kill switch) while an ask
   is pending. Expect: within ~5 s the ask is denied with the kill-switch
   message and the run page shows it; starting a new Project Manager run is
   refused with a flash; starting a Solutions Architect run still works.
   Disengage.
7. **TTL.** Leave one ask undecided past `TEAM_APPROVAL_TTL_HOURS` (set it to 1
   for this test, redeploy, then revert). Expect: status `expired`, deny message
   mentions time.
8. **Budget.** Start a run with `TEAM_DEFAULT_BUDGET_CENTS=100` ($1) or lower
   the per-agent budget in Team → Portals → Budgets. Expect `budget_reached`,
   a "raise budget" form on the run page, and the run resuming after a raise
   (needs `team:budget`).
9. **Interrupt.** Interrupt a running session. Expect status `idle`/`terminated`
   and `team_run_interrupted` in the timeline.
10. **Worker failover (optional).** Restart the worker while a run is
    `requires_action`. Expect no duplicate approvals and no lost asks after it
    comes back (the seen-ledger dedupes the replayed history).
11. **Audit.** `audit_log` has `team_*` rows with `subject_id` = run id, chain
    verifies (`/console/audit` or the verify script), no `span.*` rows.

## C. Known limits in phases 1–2

- Orchestrator, Developer, QA and Migration roles are not launchable yet.
- Session output files (e.g. the brief under `/mnt/session/outputs`) are not
  downloadable from our console; read them in the Anthropic Console via the
  deep link, or ask the agent to paste the brief in its message.
- Approvals happen only in our console; a confirmation sent from the Anthropic
  Console is recorded as `external` and flagged.
