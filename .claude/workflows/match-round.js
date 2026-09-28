export const meta = {
  name: 'match-round',
  description: 'One /match-function round as phased agents: diagnose, implement and gate, adversarial waves, remediate, ship, a final breaker on unreviewed code, the merge slot',
  whenToUse: 'Launched by /parallel-match-function, one run per lane. args: {target, handle, worktree, branch, board, note?}',
  phases: [
    { title: 'Diagnose', detail: 'match-function Phases 0-2: baseline, classify, break down' },
    { title: 'Implement', detail: 'Phases 3-4: atomic commits, gates, the full-bench zero-flip gate' },
    { title: 'Adversarial', detail: 'Phase 5: breaker A and architect B as separate agents, in waves' },
    { title: 'Remediate', detail: 'triage every finding, fix the confirmed ones as new commits' },
    { title: 'Ship', detail: 'Phases 6-7: comment audit, rebase, regenerate, PR, pr-wait' },
    { title: 'Final review', detail: 'one breaker on every commit no wave reviewed, and its remediation' },
    { title: 'Merge slot', detail: 'the merge-slot message, carrying every open finding' },
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
- The rules every round of a parallel run is held to are the list under "Each round is held to"
  in ${PARALLEL_SPEC}. Read that list; it overrides the spec where they disagree.
- **You never merge your own PR.** docs/measurement-discipline.md §8 says to merge on a green
  \`pr-wait\`; in this run a green verdict means the round's last agent files a \`merge-slot\`
  message on the board, and the coordinator merges.
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
    head: { type: 'string', description: 'the full sha of HEAD when you finished' },
    posts: { type: 'array', items: { type: 'string' } },
  },
  required: ['commits', 'cells', 'gates', 'bench', 'blocked', 'head', 'posts'],
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
    head: { type: 'string', description: 'the full sha of HEAD when you finished' },
  },
  required: ['ledger', 'changedCode', 'gates', 'head'],
}

const SHIPPED = {
  type: 'object',
  properties: {
    pr: { type: 'string', description: 'PR number, or "none" and why' },
    prWait: { type: 'string', description: 'scripts/pr-wait.sh exit status and what it meant' },
    cells: { type: 'string' },
    bench: { type: 'string' },
    declineToWrong: {
      type: 'string',
      description: 'every row `pnpm bench diff` shows leaving `declined` for nonmatch/noncompile/failed, by id, with the command; "none" when none',
    },
    commentBudget: { type: 'string', description: 'Phase 6 inventory before/after' },
    codeChanges: {
      type: 'array',
      items: { type: 'string' },
      description: '<sha> <subject> of every commit you made that changes code — a conflict resolved by editing code, a gate fix — not the regenerated artifact or a comment-only edit',
    },
    head: { type: 'string', description: 'the full sha of HEAD you pushed' },
    blocked: { type: 'string' },
    posts: { type: 'array', items: { type: 'string' } },
  },
  required: ['pr', 'prWait', 'cells', 'bench', 'declineToWrong', 'commentBudget', 'codeChanges', 'head', 'blocked', 'posts'],
}

const SLOT = {
  type: 'object',
  properties: {
    mergeSlot: { type: 'string', description: 'the merge-slot message file, or "none" and why' },
  },
  required: ['mergeSlot'],
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
// The commits no adversarial wave has read: `<from>..<to>`, set when the last wave's remediation
// changed code. The final breaker reviews exactly these, plus the ship agent's own code changes.
let unreviewed = null
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
    let reviewedHead = build.head
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
      // A lost reviewer is a stopped round, not a quiet one: its empty findings would read as a clean
      // wave and ship the branch with half of Phase 5 never run.
      if (!breaker || !architect) return died(`Adversarial ${wave} (${breaker ? 'B' : architect ? 'A' : 'A and B'})`)
      const findings = [
        ...breaker.findings.map((f) => ({ ...f, id: `w${wave}A-${f.id}` })),
        ...architect.findings.map((f) => ({ ...f, id: `w${wave}B-${f.id}` })),
      ]
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
      if (wave === MAX_WAVES) {
        unreviewed = `${reviewedHead}..${triage.head}`
        log(`${handle}: remediation after the last wave changed code — the final breaker reviews ${unreviewed}`)
      }
      reviewedHead = triage.head
    }
  }
}

phase('Ship')
const shipped = await agent(
  `${PREAMBLE}
You own **Phases 6 and 7** of the spec, and the end of Phase 4 that follows a rebase: audit the
comments this branch added, rebase on a freshly fetched \`origin/main\`, re-run the gates, regenerate
the artifact if \`scripts/check-artifact-provenance.sh\` says one is owed (last commit on the branch),
push, open the PR, and run \`scripts/pr-wait.sh\` on it. Stop at its verdict: a later agent files the
\`merge-slot\`, after a final review of any code no adversarial wave read — so list in
\`codeChanges\` every commit of yours that changes code. If the round built nothing, ship only what the
spec says a completed round ships (a measured null, a docs or test-only change with lasting value) —
or no PR, and say why.${handoff('Diagnosis', diagnosis)}${handoff('Build', build)}${handoff('Triage ledger', ledger)}`,
  { label: `${handle}: ship`, phase: 'Ship', schema: SHIPPED, agentType: 'general-purpose' },
)
if (!shipped) return died('Ship')

// ONE MORE BREAKER on every commit that reached the PR without a wave reading it: the last wave's
// remediation, and whatever the ship agent changed while rebasing. A remediation is the likeliest
// place for a new defect — it is written fast, against a finding, by an agent that has not read the
// whole change — and on the 2026-09-23 run a dedupe one round wrote was itself decline→wrong, and
// only a breaker reading it caught that. One breaker, not a wave: what it finds is fixed and gated, and
// those fixes are named as unreviewed in the slot rather than looping.
let finalReview = null
const pending = [
  ...(unreviewed ? [`the last wave's remediation: \`git -C ${worktree} log -p ${unreviewed}\``] : []),
  ...shipped.codeChanges.map((c) => `a ship-time code change: ${c}`),
]
const noPr = /^none\b/i.test(shipped.pr)
if (pending.length && !noPr) {
  const breaker = await agent(
    `${PREAMBLE}
You are **Agent A** of Phase 5, in a final pass. Take your brief from the spec's Phase 5 (Agent A),
with \`$1\` = \`${target}\`, but review ONLY these commits, which no adversarial wave read — and
the code they touch, as it stands at the PR head:
${pending.map((p) => `- ${p}`).join('\n')}
Change no file in the worktree; scratch goes outside it. Report only findings you reproduced.${handoff('Triage ledger of the waves', ledger)}`,
    { label: `${handle}: final breaker`, phase: 'Final review', schema: FINDINGS, agentType: 'general-purpose' },
  )
  if (!breaker) return died('Final review (breaker)')
  const findings = breaker.findings.map((f) => ({ ...f, id: `final-${f.id}` }))
  log(`${handle}: final breaker — ${findings.length} finding(s) on ${pending.length} unreviewed change(s)`)
  finalReview = { reviewed: pending, findings, triage: null }
  if (findings.length) {
    const triage = await agent(
      `${PREAMBLE}
You own the **remediation** after the final breaker. Reproduce each finding below before judging it;
fix every confirmed one as a new commit, re-run the gates the spec's Phase 3 names and the scoped
bench on the rows it touches; then, as the ship agent did, rebase if \`origin/main\` moved, regenerate
the artifact if \`scripts/check-artifact-provenance.sh\` says one is owed, push, and re-run
\`scripts/pr-wait.sh\` on PR ${shipped.pr}. Record every finding in the ledger.${handoff('Findings', findings)}`,
      { label: `${handle}: final remediation`, phase: 'Final review', schema: TRIAGE, agentType: 'general-purpose' },
    )
    if (!triage) return died('Final review (remediation)')
    ledger.push(...triage.ledger)
    finalReview.triage = triage
  }
}

phase('Merge slot')
const open = ledger.filter((f) => f.verdict === 'CONFIRMED-OPEN')
const unreviewedFixes = finalReview?.triage?.changedCode ? `the final remediation's commits, up to ${finalReview.triage.head}` : 'none'
const slot = noPr
  ? { mergeSlot: `none — the round shipped no PR: ${shipped.pr}` }
  : await agent(
    `${PREAMBLE}
File the \`merge-slot\` message for PR ${shipped.pr}, as the board's README describes, and stop.
Run \`scripts/pr-wait.sh ${shipped.pr}\` first; file only on a green verdict, and otherwise return
"none" and the verdict. The message must carry, each written out and never omitted ("none" when
empty):
- every CONFIRMED-OPEN finding below, with its reason: ${open.length} of them;
- decline→wrong: ${JSON.stringify(shipped.declineToWrong)}, plus every CONFIRMED finding of severity
  \`silent-wrong\` in the ledger;
- code no reviewer read: ${unreviewedFixes};
- the cells and the bench line below.${handoff('Ledger', ledger)}${handoff('Shipped', { pr: shipped.pr, cells: shipped.cells, bench: shipped.bench })}`,
    { label: `${handle}: merge slot`, phase: 'Merge slot', schema: SLOT, agentType: 'general-purpose', effort: 'low' },
  )
if (!slot) return died('Merge slot')

return { handle, target, diagnosis, build, ledger, shipped, finalReview, slot }
