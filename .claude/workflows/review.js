export const meta = {
  name: 'review',
  description: 'Independent correctness and security review of the current branch diff, with every finding adversarially verified before it is reported',
  whenToUse: 'Before any push, on the merged diff of the working branch. Args optional: {base: "origin/main"} or a PR/branch/path string.',
  phases: [
    { title: 'Scope', detail: 'list the changed files' },
    { title: 'Review', detail: 'correctness and security, independently' },
    { title: 'Verify', detail: 'three refuters per finding; majority decides' },
    { title: 'Critique', detail: 'what did the review not cover?' },
  ],
}

const base = (typeof args === 'string' ? args : args?.base) || 'origin/main'

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['files', 'summary'],
  properties: { files: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } },
}
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings', 'checked'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    checked: { type: 'array', items: { type: 'string' } },
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
const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['gaps'],
  properties: { gaps: { type: 'array', items: { type: 'string' } } },
}

phase('Scope')
const scope = await agent(
  `Run \`git diff --name-only ${base}...HEAD\` (fall back to \`git diff --name-only ${base}\` if the three-dot form fails) in the repo and return the changed files plus a two-sentence summary of what the diff does, from \`git diff --stat ${base}...HEAD\` and the commit messages in \`git log --oneline ${base}..HEAD\`.`,
  { label: 'scope', schema: SCOPE_SCHEMA, effort: 'low' },
)
if (!scope || scope.files.length === 0) return { base, findings: [], note: 'no changes against base' }
log(`${scope.files.length} changed file(s): ${scope.summary}`)

const prompt = (lens) => [
  `${lens === 'security' ? 'Security-review' : 'Review'} the diff of the current branch against ${base} in the repo: \`git diff ${base}...HEAD\`.`,
  `Summary of the change: ${scope.summary}`,
  `Changed files: ${scope.files.join(', ')}`,
  `Read the changed files in full, and the callers of anything whose signature changed. Report in your structured format: findings with a concrete failure path only, plus the list of what you checked and judged fine.`,
].join('\n\n')

phase('Review')
const reviews = (await parallel([
  () => agent(prompt('correctness'), { label: 'correctness', phase: 'Review', agentType: 'reviewer', schema: FINDINGS_SCHEMA }),
  () => agent(prompt('security'), { label: 'security', phase: 'Review', agentType: 'security', schema: FINDINGS_SCHEMA }),
])).filter(Boolean)

// Dedupe by file+claim before the expensive verify stage.
const seen = new Set()
const candidates = reviews.flatMap((r) => r.findings).filter((f) => {
  const key = `${f.file}|${f.claim.toLowerCase().slice(0, 80)}`
  if (seen.has(key)) return false
  seen.add(key)
  return f.confidence >= 6
})
log(`${candidates.length} candidate finding(s) after dedupe`)

const verified = await pipeline(candidates, (f) =>
  parallel([0, 1, 2].map((i) => () =>
    agent(
      `Refuter ${i + 1}. A reviewer claims this defect in the current branch (diff against ${base}):\n\nClaim: ${f.claim}\nFile: ${f.file}${f.line ? ':' + f.line : ''}\nSeverity: ${f.severity}\nFailure path: ${f.failurePath}\n\nRead the code and try to REFUTE it: show that the input or state in the failure path cannot occur, or that the effect does not follow. Default to refuted=true if you cannot confirm the failure path yourself.`,
      { label: `verify ${i + 1}: ${f.file}`, phase: 'Verify', agentType: 'reviewer', schema: VERDICT_SCHEMA },
    ),
  )).then((votes) => ({ ...f, votes: votes.filter(Boolean), confirmed: votes.filter(Boolean).filter((v) => !v.refuted).length >= 2 })),
)

phase('Critique')
const critique = await agent(
  [
    `Two reviewers covered this diff (files: ${scope.files.join(', ')}). They say they checked:`,
    ...reviews.flatMap((r) => r.checked).map((c) => `- ${c}`),
    `Read the diff (\`git diff ${base}...HEAD\`) and list concrete gaps: a changed file nobody mentioned, a caller of a changed signature nobody traced, a governance rule from CLAUDE.md nobody verified, a test the plan implied that is missing. Return an empty list if the coverage is complete.`,
  ].join('\n'),
  { label: 'critique', schema: CRITIQUE_SCHEMA, agentType: 'reviewer' },
)

const confirmed = verified.filter(Boolean).filter((f) => f.confirmed)
const refuted = verified.filter(Boolean).filter((f) => !f.confirmed)
log(`review done: ${confirmed.length} confirmed, ${refuted.length} refuted, ${critique?.gaps?.length ?? 0} coverage gap(s)`)
return {
  base,
  verdict: confirmed.some((f) => f.severity !== 'low') ? 'FAIL' : 'PASS',
  confirmed: confirmed.map(({ votes, ...f }) => ({ ...f, refutations: votes.filter((v) => v.refuted).map((v) => v.reason) })),
  refuted: refuted.map((f) => ({ claim: f.claim, file: f.file, reasons: f.votes.filter((v) => v.refuted).map((v) => v.reason) })),
  coverageGaps: critique?.gaps ?? [],
}
