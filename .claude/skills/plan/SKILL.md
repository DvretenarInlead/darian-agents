---
name: plan
description: Produce an implementation plan (modules, shared contracts, migration, order, governance checks, test plan) for a feature or change, using the architect agent. Use before any change that touches two or more modules.
argument-hint: <what to build, or a path to a design doc>
context: fork
agent: architect
background: false
---

Produce the implementation plan for the following request, following the plan
format in your instructions exactly:

$ARGUMENTS

Read `CLAUDE.md`, `docs/ARCHITECTURE.md` and, if the request concerns team
agents, `docs/PYB_TEAM_ARCHITECTURE.md`. Read every existing file the change
would touch before writing a line of the plan.

Write the plan to `docs/plans/<slug>.md`, where `<slug>` is a short kebab-case
name for the change, and return the plan's path plus the **Modules** section
(names and one-line responsibilities) as your final message. The orchestrator
will author the shared contracts from section 3 before fanning out to
implementers, so section 3 must be complete and exact.
