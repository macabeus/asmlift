export const meta = {
  name: 'match-round',
  description: 'One /match-function round as phased agents: diagnose, implement and gate, adversarial waves, remediate, ship to the merge queue',
  whenToUse: 'Launched by /parallel-match-function, one run per lane. args: {target, handle, worktree, branch, board, note?}',
  phases: [
    { title: 'Diagnose', detail: 'match-function Phases 0-2: baseline, classify, break down' },
    { title: 'Implement', detail: 'Phases 3-4: atomic commits, gates, the full-bench zero-flip gate' },
    { title: 'Adversarial', detail: 'Phase 5: breaker A and architect B as separate agents, in waves' },
    { title: 'Remediate', detail: 'triage every finding, fix the confirmed ones as new commits' },
    { title: 'Ship', detail: 'Phases 6-7: comment audit, rebase, regenerate, PR, merge-slot' },
  ],
}

// ONE ROUND, NOT ONE AGENT. A round run as a single agent decides for itself whether Phase 5's two
// reviewers are separate agents, whether a second wave runs, and whether a refuted premise ends
// the round; here the script decides, and every phase shows up in /workflows. What each phase DOES
// is still match-function.md's, read by every agent from its own worktree — nothing below restates
// a rule of that file, only which of its phases the agent owns.

const REQUIRED = ['target', 'handle', 'worktree', 'branch', 'board']
const missing = REQUIRED.filter((k) => !args || typeof args[k] !== 'string' || args[k] === '')
if (missing.length) throw new Error(`match-round: args is missing ${missing.join(', ')}`)
const { target, handle, worktree, branch, board } = args

// A wave is followed by another only when its remediation changed code — the spec's "one round is
// not enough" is about reviewing the FIXES, and a wave with nothing to fix left nothing new to
// review. Past the last wave the round reports what is still open rather than looping.
const MAX_WAVES = 3

const SPEC = `${worktree}/.claude/commands/match-function.md`
const PARALLEL_SPEC = `${worktree}/.claude/commands/parallel-match-function.md`

const PREAMBLE = `You are one agent of round **${handle}**, a /match-function round on **${target}**, run
beside other rounds by /parallel-match-function. Several agents share this round in sequence; you
own only the phases named below, and what the earlier ones found is handed to you at the end.

- Worktree: ${worktree} (branch \`${branch}\`). \`cd\` there, and \`source ${worktree}/.envrc.local\`
  in EVERY shell before any harness command — shell state does not survive between tool calls.
- The spec: ${SPEC} — read it by that absolute path, with \`$1\` = \`${target}\`, and every doc it
  links from the same tree.
- The rules every round of a parallel run is held to are the list under "Each round is briefed to"
  in ${PARALLEL_SPEC}. Read that list; it overrides the spec where they disagree.
- **You never merge your own PR.** docs/measurement-discipline.md §8 says to merge on a green
  \`pr-wait\`; in this run a green verdict means: file a \`merge-slot\` message on the board and stop.
- The board: ${board}. Read \`${board}/README.md\`, then \`${board}/INDEX.md\` (re-read it at the
  start of every phase you own), and check \`grep -rl "corrects: <file>" ${board}/board/\` before
  acting on a post. Post what you learn there, authored \`${handle}\`; its README says how. The
  board's path never appears in a commit, a PR body, code or docs.
${args.note ? `\nContext from the coordinator — hypotheses, not facts:\n${args.note}\n` : ''}`

const handoff = (label, value) => `\n\n## ${label}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``

const DIAGNOSIS = {
  type: 'object',
  properties: {
    baseline: { type: 'string', description: 'pnpm bench baseline output, verbatim, every cell' },
    classification: {
      type: 'string',
      enum: ['missing-capability', 'missing-variation', 'unmatchable-quirk', 'harness-fidelity', 'correct-decline', 'already-matches'],
    },
    evidence: { type: 'string', description: 'the measurement that decided the classification, with its command' },
    proceed: { type: 'boolean', description: 'true only when there is a capability or variation to build' },
    breakdown: { type: 'array', items: { type: 'string' }, description: 'Phase 2 steps, one line each' },
    refutedPremises: { type: 'array', items: { type: 'string' } },
    posts: { type: 'array', items: { type: 'string' }, description: 'board posts made' },
  },
  required: ['baseline', 'classification', 'evidence', 'proceed', 'breakdown', 'refutedPremises', 'posts'],
}

const BUILD = {
  type: 'object',
  properties: {
    commits: { type: 'array', items: { type: 'string' }, description: '<sha> <subject>, oldest first' },
    cells: { type: 'string', description: 'baseline -> now for every cell of the target, as whole N/M pairs' },
    gates: { type: 'string', description: 'each gate run, its count and exit status' },
    bench: { type: 'string', description: 'full-bench totals before/after, regression and diff verdicts, fan multiplier; or why none was owed' },
    blocked: { type: 'string', description: 'what is still blocked and the next step; empty if nothing' },
    posts: { type: 'array', items: { type: 'string' } },
  },
  required: ['commits', 'cells', 'gates', 'bench', 'blocked', 'posts'],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          location: { type: 'string', description: 'file:line' },
          trigger: { type: 'string', description: 'a concrete input that fires it' },
          why: { type: 'string' },
          severity: { type: 'string', enum: ['silent-wrong', 'loud-regression', 'design', 'minor'] },
        },
        required: ['id', 'location', 'trigger', 'why', 'severity'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

const TRIAGE = {
  type: 'object',
  properties: {
    ledger: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['CONFIRMED-FIXED', 'CONFIRMED-OPEN', 'DECLINED', 'NOT-REPRODUCED'] },
          reason: { type: 'string' },
          commit: { type: 'string' },
        },
        required: ['id', 'verdict', 'reason', 'commit'],
      },
    },
    changedCode: { type: 'boolean', description: 'true when any commit this stage made touches code' },
    gates: { type: 'string' },
  },
  required: ['ledger', 'changedCode', 'gates'],
}

const SHIPPED = {
  type: 'object',
  properties: {
    pr: { type: 'string', description: 'PR number, or "none" and why' },
    mergeSlot: { type: 'string', description: 'the merge-slot message file, or "none" and why' },
    prWait: { type: 'string', description: 'scripts/pr-wait.sh exit status and what it meant' },
    cells: { type: 'string' },
    bench: { type: 'string' },
    commentBudget: { type: 'string', description: 'Phase 6 inventory before/after' },
    blocked: { type: 'string' },
    posts: { type: 'array', items: { type: 'string' } },
  },
  required: ['pr', 'mergeSlot', 'prWait', 'cells', 'bench', 'commentBudget', 'blocked', 'posts'],
}

const died = (stage) => {
  log(`${handle}: the ${stage} agent returned nothing; the round stops here`)
  return { handle, target, stoppedAt: stage }
}

phase('Diagnose')
const diagnosis = await agent(
  `${PREAMBLE}
You own **Phases 0, 1 and 2** of the spec. Phase 2 says to show the breakdown to the user: post it
to the board's \`rounds/\` instead and do not wait. Post your file claims to \`rounds/\` too. A premise
of the coordinator's context that you refute is posted the moment it is refuted. Change no code.`,
  { label: `${handle}: diagnose`, phase: 'Diagnose', schema: DIAGNOSIS, agentType: 'general-purpose' },
)
if (!diagnosis) return died('Diagnose')
log(`${handle}: ${diagnosis.classification}${diagnosis.proceed ? '' : ' — nothing to build'}`)

let build = null
const ledger = []
if (diagnosis.proceed) {
  phase('Implement')
  build = await agent(
    `${PREAMBLE}
You own **Phases 3 and 4** of the spec: implement the breakdown below as atomic commits, then the
full-bench zero-flip gate. Do not open a PR — a later agent ships.${handoff('Diagnosis', diagnosis)}`,
    { label: `${handle}: implement`, phase: 'Implement', schema: BUILD, agentType: 'general-purpose' },
  )
  if (!build) return died('Implement')

  if (build.commits.length) {
    for (let wave = 1; wave <= MAX_WAVES; wave++) {
      const context = handoff('Classification', { classification: diagnosis.classification, evidence: diagnosis.evidence }) +
        handoff('Commits, cells and bench', { branch, commits: build.commits, cells: build.cells, bench: build.bench }) +
        (ledger.length ? handoff('Triage ledger of the earlier waves — a triaged finding is not new unless it falsifies the triage', ledger) : '')
      const review = (role, brief) =>
        agent(`${PREAMBLE}
You are **Agent ${role}** of Phase 5, wave ${wave}. Take your brief from the spec's Phase 5 (Agent ${role}),
with \`$1\` = \`${target}\`, and read the branch's diff yourself (\`git -C ${worktree} diff origin/main...HEAD\`).
${brief} Change no file in the worktree; scratch goes outside it. Report only findings you
reproduced.${context}`,
          { label: `${handle}: wave ${wave} ${role}`, phase: 'Adversarial', schema: FINDINGS, agentType: 'general-purpose' })
      const [breaker, architect] = await parallel([
        () => review('A', 'Hunt real inputs across every function that can reach the new path.'),
        () => review('B', 'Judge the mechanism against docs/level-tower.md and docs/asmlift-101.md.'),
      ])
      const findings = [
        ...(breaker?.findings ?? []).map((f) => ({ ...f, id: `w${wave}A-${f.id}` })),
        ...(architect?.findings ?? []).map((f) => ({ ...f, id: `w${wave}B-${f.id}` })),
      ]
      if (!breaker || !architect) log(`${handle}: wave ${wave} lost a reviewer (${breaker ? 'B' : 'A'}) — its findings are missing`)
      log(`${handle}: wave ${wave} — ${findings.length} finding(s)`)
      if (!findings.length) break

      const triage = await agent(
        `${PREAMBLE}
You own the **remediation** after Phase 5 wave ${wave}. Reproduce each finding below before judging
it; fix every confirmed one as a new commit, re-run the gates the spec's Phase 3 names and the
scoped bench on the rows it touches. Record every finding in the ledger, with the reason behind each
DECLINED or NOT-REPRODUCED.${handoff('Findings', findings)}${context}`,
        { label: `${handle}: remediate ${wave}`, phase: 'Remediate', schema: TRIAGE, agentType: 'general-purpose' },
      )
      if (!triage) return died(`Remediate ${wave}`)
      ledger.push(...triage.ledger)
      if (!triage.changedCode) break
      if (wave === MAX_WAVES && triage.changedCode) log(`${handle}: remediation after the last wave changed code — no wave reviewed it; the ship agent must say so in the PR`)
    }
  }
}

phase('Ship')
const shipped = await agent(
  `${PREAMBLE}
You own **Phases 6 and 7** of the spec, and the end of Phase 4 that follows a rebase: audit the
comments this branch added, rebase on a freshly fetched \`origin/main\`, re-run the gates, regenerate
the artifact if \`scripts/check-artifact-provenance.sh\` says one is owed (last commit on the branch),
push, open the PR, and run \`scripts/pr-wait.sh\` on it. On a green verdict, file the \`merge-slot\`
message the board's README describes and stop. If the round built nothing, ship only what the spec
says a completed round ships (a measured null, a docs or test-only change with lasting value) — or
no PR, and say why.${handoff('Diagnosis', diagnosis)}${handoff('Build', build)}${handoff('Triage ledger', ledger)}`,
  { label: `${handle}: ship`, phase: 'Ship', schema: SHIPPED, agentType: 'general-purpose' },
)
if (!shipped) return died('Ship')

return { handle, target, diagnosis, build, ledger, shipped }
