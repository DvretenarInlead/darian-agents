export const meta = {
  name: 'build',
  description: 'Implement a plan module-by-module in parallel worktrees, review each module (correctness + security), verify findings adversarially, fix confirmed ones',
  whenToUse: 'After /plan has written docs/plans/<slug>.md and the orchestrator has authored the shared contracts. Args: the plan path, optionally {plan, modules: [names]} to build a subset.',
  phases: [
    { title: 'Read plan', detail: 'one agent extracts the module list and contracts' },
    { title: 'Implement', detail: 'one implementer per module, each in its own worktree' },
    { title: 'Review', detail: 'reviewer + security per module' },
    { title: 'Verify', detail: 'three refuters per finding; majority decides' },
    { title: 'Fix', detail: 'implementer fixes confirmed findings in its worktree' },
  ],
}

// ---- input -----------------------------------------------------------------
const planPath = typeof args === 'string' ? args : args?.plan
if (!planPath) throw new Error('build: pass the plan path as args (string) or {plan, modules?}')
const only = Array.isArray(args?.modules) ? args.modules : null

// ---- schemas ---------------------------------------------------------------
const PLAN_SCHEMA = {
  type: 'object',
  required: ['goal', 'contracts', 'modules'],
  properties: {
    goal: { type: 'string' },
    contracts: { type: 'string', description: 'Section 3 of the plan, verbatim' },
    governance: { type: 'string', description: 'Section 5 of the plan, verbatim' },
    modules: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'paths', 'brief', 'tests'],
        properties: {
          name: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          brief: { type: 'string', description: 'The module entry from section 2, verbatim, plus its test-plan lines from section 6' },
          tests: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}
const HANDBACK_SCHEMA = {
  type: 'object',
  required: ['status', 'module', 'worktree', 'branch', 'files', 'tests', 'contractIssues', 'notes'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    module: { type: 'string' },
    worktree: { type: 'string' },
    branch: { type: 'string' },
    commit: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    contractIssues: { type: 'string' },
    notes: { type: 'string' },
  },
}
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'file', 'severity', 'failurePath', 'fix', 'confidence'],
        properties: {
          claim: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          failurePath: { type: 'string' },
          fix: { type: 'string' },
          confidence: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

// ---- 1. read the plan ------------------------------------------------------
phase('Read plan')
const plan = await agent(
  `Read the implementation plan at ${planPath} and return it as structured data: the goal, section 3 (shared contracts) verbatim, section 5 (governance checks) verbatim, and one entry per module from section 2 with its paths, its full text as the brief (append the module's lines from section 6, the test plan), and its test files. Do not summarise or reword the plan.`,
  { label: 'read plan', schema: PLAN_SCHEMA, effort: 'low' },
)
if (!plan) throw new Error('build: could not read the plan')
const modules = only ? plan.modules.filter((m) => only.includes(m.name)) : plan.modules
log(`${modules.length} module(s) to build from ${planPath}`)

const implementPrompt = (m) => [
  `Implement the module "${m.name}" of darian-agents from the plan at ${planPath}.`,
  `Goal of the whole change: ${plan.goal}`,
  `Shared contracts (already authored in the repo; do not change them):\n${plan.contracts}`,
  `Governance checks that apply:\n${plan.governance ?? '(see plan)'}`,
  `Your module:\n${m.brief}`,
  `Paths you own: ${m.paths.join(', ')}. Tests to write: ${m.tests.join(', ')}.`,
  `Hand back in the structured format; include the worktree path and branch.`,
].join('\n\n')

const reviewPrompt = (lens, m, hb) => [
  `${lens === 'security' ? 'Security-review' : 'Review'} the module "${m.name}" implemented in the git worktree at ${hb.worktree} (branch ${hb.branch}).`,
  `Run \`git -C ${hb.worktree} diff origin/main...HEAD\` to see the change; read the files in that worktree, not the main checkout.`,
  `The module was built from this plan entry:\n${m.brief}`,
  `Shared contracts it must honour:\n${plan.contracts}`,
  `Report in your structured format. Only findings with a concrete failure path.`,
].join('\n\n')

// ---- 2–5. implement → review → verify → fix, per module, no barrier ---------
const results = await pipeline(
  modules,
  (m) => agent(implementPrompt(m), { label: `implement:${m.name}`, phase: 'Implement', agentType: 'implementer', isolation: 'worktree', schema: HANDBACK_SCHEMA }),

  async (hb, m) => {
    if (!hb || hb.status !== 'done') return { m, hb, findings: [], skipped: 'implementation blocked or failed' }
    const [corr, sec] = await parallel([
      () => agent(reviewPrompt('correctness', m, hb), { label: `review:${m.name}`, phase: 'Review', agentType: 'reviewer', schema: FINDINGS_SCHEMA }),
      () => agent(reviewPrompt('security', m, hb), { label: `security:${m.name}`, phase: 'Review', agentType: 'security', schema: FINDINGS_SCHEMA }),
    ])
    const findings = [...(corr?.findings ?? []), ...(sec?.findings ?? [])].filter((f) => f.severity !== 'low' && f.confidence >= 6)
    return { m, hb, findings }
  },

  async (r) => {
    if (!r.hb || r.findings.length === 0) return { ...r, confirmed: [] }
    const judged = await parallel(
      r.findings.map((f) => () =>
        parallel([0, 1, 2].map((i) => () =>
          agent(
            `Refuter ${i + 1}. A reviewer claims this defect in the worktree at ${r.hb.worktree} (branch ${r.hb.branch}):\n\nClaim: ${f.claim}\nFile: ${f.file}${f.line ? ':' + f.line : ''}\nFailure path: ${f.failurePath}\n\nRead the code there and try to REFUTE it: show the input or state in the failure path cannot occur, or the effect does not follow. Default to refuted=true if you cannot confirm the failure path.`,
            { label: `verify:${r.m.name}:${i + 1}`, phase: 'Verify', agentType: 'reviewer', schema: VERDICT_SCHEMA },
          ),
        )).then((votes) => ({ f, real: votes.filter(Boolean).filter((v) => !v.refuted).length >= 2 })),
      ),
    )
    return { ...r, confirmed: judged.filter(Boolean).filter((j) => j.real).map((j) => j.f) }
  },

  async (r) => {
    if (!r.hb || r.confirmed.length === 0) return r
    const fix = await agent(
      [
        `Fix the following confirmed review findings in the module "${r.m.name}". Work in the existing worktree at ${r.hb.worktree} (branch ${r.hb.branch}); cd there first. Do not change the shared contracts.`,
        ...r.confirmed.map((f, i) => `${i + 1}. ${f.claim} — ${f.file}${f.line ? ':' + f.line : ''}\n   Failure path: ${f.failurePath}\n   Suggested fix: ${f.fix}`),
        `Re-run the module's tests and typecheck, add a regression test for each fix, commit, and hand back in the structured format.`,
      ].join('\n\n'),
      { label: `fix:${r.m.name}`, phase: 'Fix', agentType: 'implementer', schema: HANDBACK_SCHEMA },
    )
    return { ...r, fix }
  },
)

// ---- report ----------------------------------------------------------------
const report = results.filter(Boolean).map((r) => ({
  module: r.m.name,
  status: r.fix?.status ?? r.hb?.status ?? 'failed',
  worktree: r.hb?.worktree ?? null,
  branch: r.hb?.branch ?? null,
  commit: r.fix?.commit ?? r.hb?.commit ?? null,
  tests: r.fix?.tests ?? r.hb?.tests ?? null,
  contractIssues: [r.hb?.contractIssues, r.fix?.contractIssues].filter((x) => x && x !== 'none').join('; ') || 'none',
  reviewFindings: r.findings?.length ?? 0,
  confirmedFindings: r.confirmed?.length ?? 0,
  fixed: r.fix ? r.confirmed.length : 0,
  skipped: r.skipped ?? null,
  notes: r.fix?.notes ?? r.hb?.notes ?? null,
}))
log(`build done: ${report.filter((r) => r.status === 'done').length}/${report.length} modules done`)
return {
  plan: planPath,
  modules: report,
  next: 'Merge each worktree branch into the working branch (git merge <branch>), resolve conflicts, run /review on the merged diff, then /ship.',
}
