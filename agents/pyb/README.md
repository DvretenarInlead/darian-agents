# PYB Team agents (Claude Managed Agents) — definitions as code

Nine agent definitions and four environments for the PYB technical-solutions
team, created and updated through the Claude API with the `ant` CLI. The
darian-agents app does not create agents; it starts **sessions** on the agents
this directory describes, using the ids `ant apply` records in `claude-lock.json`
(see `docs/PYB_TEAM_ARCHITECTURE.md` and `docs/plans/team-control-plane.md`).

```
agents/        one Markdown file per agent: frontmatter = definition, body = system prompt
environments/  one YAML file per environment (networking, packages)
skills/        custom skills (one directory each, SKILL.md at the root); none yet
claude-lock.json          written by `ant apply`; COMMIT IT — the app reads agent ids/versions from it
claude-lock.example.json  the shape the app's loader expects, with fake ids
```

## Create or update the agents

Run from this directory so the lockfile lands here. Needs Claude CLI 1.30+ and
an API key for the PYB Anthropic organisation.

```sh
export ANTHROPIC_API_KEY=...
cd agents/pyb
ant apply .                 # shows a plan, then creates/updates
git add claude-lock.json && git commit -m "Apply PYB agent definitions"
```

Re-running after editing a file updates that agent (a new immutable version)
instead of creating a second one; sessions already running keep their pinned
version. Every change to a prompt is therefore a PR here, never a Console edit:
`ant apply` refuses to run when an agent was changed outside these files.

## What `ant apply` does not do

- **Credentials.** The MCP servers are declared by URL only. Before a session
  can use them, create vaults and credentials (HubSpot per portal, Fireflies,
  GitHub) in the Anthropic Console or through the vaults API, then put the
  vault ids where the app expects them: the HubSpot vault id on the portal row
  in Console → Team → Portals, `TEAM_FIREFLIES_VAULT_ID` and
  `TEAM_GITHUB_VAULT_ID` in the app environment.
- **Per-tool permissions.** MCP toolsets stay on the default (`always_ask`),
  which is what the app's approval gate relies on: every write pauses and is
  decided in our console. Once a server's tool list is visible in the Console,
  set its read tools to `always_allow` and disable the tools each role must
  never use, then update the agent file to match.
- **Repositories and skills.** Attach repositories per session as a
  `github_repository` resource; upload custom skills and reference them from an
  agent file as `skills: [../skills/<name>]`.

## How the app maps these files

| Agent file (`metadata.slug`) | App catalog slug (`src/products/team/catalog.ts`) | Environment |
|---|---|---|
| 01 `project_manager` | `project_manager` | pyb-office |
| 02 `solutions_architect` | `solutions_architect` | pyb-office |
| 03 `content` | `content` | pyb-office |
| 04 `dev` | `hubspot_developer` | pyb-build |
| 05 `qa` | `qa` | pyb-build |
| 06 `security` | `security_reviewer` | pyb-build |
| 07 `hubspot_admin` | `hubspot_admin` | pyb-office |
| 08 `migration_data` | `migration_data` | pyb-migration |
| 09 `orchestrator` | `orchestrator` | pyb-orchestrated |

The lockfile loader normalises names (`PYB Project Manager`, `pyb-project-manager`
and `project_manager` all resolve to `project_manager`) and applies these
aliases so both the file slugs and the display names resolve:
`dev → hubspot_developer`, `security → security_reviewer`, `qa_reviewer → qa`,
`migration_and_data → migration_data`. If `ant apply` keys the lockfile differently from what the
loader expects, the Team page in the console shows the lockfile status banner
with the reason; fix the mapping in `src/products/team/lockfile.ts`.

Single tenant: these agents work only on PYB's own HubSpot portal (production)
and its sandbox/test portals. The prompts still say "confirm which account you
are connected to" as a second line of defence; the first is the app, which
attaches exactly one portal's vault to each session.
