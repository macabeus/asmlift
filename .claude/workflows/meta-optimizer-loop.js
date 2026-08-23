export const meta = {
  name: 'meta-optimizer-loop',
  description: 'Supervise the running rounds, challenge and build the best optimisation, review and merge \u2014 looped, incremental',
  phases: [
    { title: 'Supervise', detail: 'read the ledger + only what is NEW since last iteration' },
    { title: 'Implement', detail: 'challenge, build, prove output-neutrality, open a PR' },
    { title: 'Review', detail: 'audit, re-prove neutrality independently, fix, merge' },
  ],
}

const REPO = '/Users/macabeus/ApenasMeu/decompiler/asmlift'
// Workflow transcripts for THIS session — the runtime prints the dir when a workflow launches.
const WF = process.env.ASMLIFT_WF_DIR ?? '<this session\'s subagents/workflows dir>'
const MEM = '~/.claude/projects/-Users-macabeus-ApenasMeu-decompiler-asmlift/memory'
const LEDGER = `${REPO}/.claude/workflows/meta-optimizer-ledger.md`

const CONTEXT = `
## What this project is doing

asmlift is a TS matching-decompiler. A loop runs \`/attribute-function\` on the klonoa function
\`LoadBGTilemapData\` (LBG) to name missing capabilities and author benchmark rows, then
\`/match-function\` builds the capability those rows gate. Each round is a Workflow of ~8 agents.
**LBG has gone 547 → 473; the corpus is 834 rows, asmlift 433 / m2c 357.**

## READ THIS FIRST — the ledger, not the whole corpus

\`${LEDGER}\` lists everything this loop has already shipped, every harness trap already fixed, and
the known-open items already named. **Read it before anything else.** It exists because the previous
incarnation re-read all 44 agent transcripts (38+ MB) on every iteration, so each pass spent more of
itself re-deriving history than analysing anything new. Do not re-report a ledger entry; if you
believe a ledger entry is wrong, say so with the measurement that shows it.

## Then look ONLY at what is new

- \`git -C ${REPO} log --oneline <last-iteration-sha>..origin/main\` and the PRs in that range.
- Workflow journals **modified since your last iteration**: \`ls -t ${WF}/*/journal.jsonl | head\`,
  and read the per-agent transcripts only for agents whose result you have not seen. Prefer
  \`journal.jsonl\` (one \`{"type":"result"}\` line per agent) over the raw transcripts — it carries
  each agent's own report, which is usually enough.
- \`${MEM}/\` — durable lessons, including the live-tracks table.
- Run logs: \`/tmp/lbg8/*.log\`.

**Budget rule: spend at most a third of your effort reading, and the rest analysing.** If you find
yourself opening a fourth transcript, stop and work with what the journals told you.

## Live tracks you must NOT disturb

Other rounds run in parallel git worktrees and OWN files. **Read the live-tracks table in
\`asmlift-parallel-worktree-harness.md\` under the memory dir before touching anything** — it is
kept current as tracks start and finish. As a rule: capability rounds own \`packages/core/**\` and
the bench artifacts on their own branches; attribution rounds own \`apps/benchmark/dataset/**\` and
\`packages/bench-schema/**\`. Never edit another worktree or the main checkout.
`
const SCOPE = `
## Scope

**IN scope:**
- \`${REPO}/.claude/commands/**\` — the prompts driving every round. Highest leverage available.
- \`docs/**\`, \`scripts/**\`, \`.github/workflows/**\`.
- \`apps/benchmark/src/**\` and \`packages/cli/src/**\` — surgical changes that make the flow FASTER
  or SMOOTHER **without changing any output**.
- New developer tooling nothing yet depends on.

**THE HARD INVARIANT — output neutrality, proved mechanically.**

Run the full bench on your branch and diff the regenerated \`results.json\` against \`origin/main\`'s
committed one, comparing for EVERY row: \`asmlift.{outcome, score, candidateLabel, source}\` and
\`m2c.{outcome, score, source}\`. **Every one must be identical.** Timings, the provenance stamp and
\`droppedCandidates\` ordering are the only permitted differences, and you must name which differed.
A change you cannot prove neutral this way does not ship, however obviously safe it looks.

**OUT of scope — propose in the PR body, never implement:**
- \`packages/core/**\`, \`apps/benchmark/dataset/**\`, \`packages/bench-schema/**\`,
  \`apps/benchmark/src/cases/features.ts\`
- artifacts as an END in themselves (you regenerate them only as the neutrality proof)
- the other worktrees and \`${REPO}\` itself.

**Measuring speed honestly.** Several workflows share this 10-core box, so wall-clock is noisy and a
single before/after pair proves nothing. Prefer counting WORK — compiles issued, scoring calls,
candidates, cache hits, processes spawned — which is deterministic. Report wall-clock too, but say
what else was running. Never quote a speedup measured once under different load.
`

const HOUSE = `
## Hard house rules

- **NEVER \`git stash\`.**
- \`research/\` is gitignored — never cite a research/ path in a commit, a PR body, or a doc.
- **Numbers come from commands.** Never state a timing, a count or a behaviour you did not observe.
- Lint is \`npx eslint apps packages\` (NOT \`pnpm lint\`). \`pnpm format\` before committing.
- \`source /tmp/wt-env.sh\` in every shell before any harness command, or rows silently SKIP.
- Never wait with a \`pgrep -f\` pattern matching your own shell; use a log marker.
- Commit messages end with:
  \`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>\`
  PR bodies end with:
  \`🤖 Generated with [Claude Code](https://claude.com/claude-code)\`
`

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'summary', 'ledger_additions'],
  properties: {
    summary: { type: 'string' },
    ledger_additions: { type: 'string', description: 'lines to append to the ledger so the next iteration does not re-derive this pass' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'evidence', 'proposal', 'expected_payoff', 'scope', 'confidence'],
        properties: {
          title: { type: 'string' },
          evidence: { type: 'string' },
          proposal: { type: 'string' },
          expected_payoff: { type: 'string' },
          scope: { type: 'string', enum: ['in-scope', 'out-of-scope-propose-only'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pr_url', 'confirmed', 'rejected', 'report'],
  properties: {
    pr_url: { type: 'string' },
    confirmed: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' } },
    neutrality_proof: { type: 'string' },
    report: { type: 'string' },
  },
}

const SUPERVISE = (i, lastSha) => `You are the SUPERVISOR (agent 1 of 3). Iteration ${i}.
You change nothing — you produce findings the implementer will try to kill.

${CONTEXT}
${SCOPE}

Your incremental window starts at **${lastSha}**.

## What counts as a good finding, ranked

1. **Wall-clock.** The ranked LBG run is the expensive path (now ~21m pooled, was 36m). Where does
   the remaining time go? Candidate dedup before compiling, cache misses, an objdiff handle rebuilt
   per call, work repeated across candidates differing in one axis. **Count the work before
   proposing** — do not guess.
2. **A recurring correctness trap** a prompt or a fail-loud check would prevent. Several agents have
   quoted an LBG number without \`--proto\`; one shipped a false compiler premise; one compared a
   branch against its own artifacts. What is the NEXT one, and what makes it impossible?
3. **Wasted or duplicated work across agents.**
4. **Silent degradation** — anywhere the harness continues with a wrong or reduced result.
5. **Prompt defects** — an instruction demonstrably misread, or missing and supplied by the human.

## What does NOT count

- Anything in the ledger.
- Any change that could alter a measurement (mark \`out-of-scope-propose-only\`).
- A speedup you did not measure, or measured once on a contended machine.
- Style opinions without a named defect.

Return at most **4** findings, best first, plus \`ledger_additions\` summarising what this pass
established so iteration ${i + 1} need not re-derive it. **An empty findings array is a valid and
useful result** — say so plainly rather than manufacturing work.

${HOUSE}`

const IMPLEMENT = (i, findings, summary) => `You are the IMPLEMENTER (agent 2 of 3). Iteration ${i}.
Worktree **/tmp/wt-meta-impl**.

${CONTEXT}
${SCOPE}

## The supervisor's report

${summary}

## Its findings (JSON)

${JSON.stringify(findings, null, 2)}

## Your job — CHALLENGE FIRST, build only what survives

1. **Verify the cited evidence yourself.** If it does not say what the finding claims — REJECTED.
2. **Would the proposal really have prevented the problem?** Often the agent had the information
   and ignored it. Reject those.
3. **For a speed finding, measure before building.** Count the work on the current code; if the hot
   path is not where the finding says, reject it.
4. **Is it worth the churn?** \`.claude/commands\` edits change every future round, and a prompt that
   grows without bound is itself a defect because agents skim.
5. **Scope.** Anything out-of-scope goes in the PR body as a proposal, not into the diff.

Then build the survivors:
- \`cd /tmp/wt-meta-impl && source /tmp/wt-env.sh && git fetch origin && git checkout -B meta/v3-${i} origin/main\`
- \`pnpm typecheck\`, \`npx vitest run --maxWorkers=3\`, \`npx eslint apps packages\`, \`pnpm format\`.
- **PROVE OUTPUT NEUTRALITY** exactly as the scope section specifies; put the comparison script and
  its output in your report. Any difference blocks the change.
- Commit saying what defect it closes and what proved it. Push, open a PR titled for iteration ${i}.

**If nothing survives, that is correct.** Open no PR, return \`pr_url: ""\`, report what you rejected.

${HOUSE}`

const REVIEW = (i, prUrl, implReport) => `You are the REVIEWER (agent 3 of 3). Iteration ${i}.
Worktree **/tmp/wt-meta-review**. The implementer opened: **${prUrl}**

${CONTEXT}
${SCOPE}

## Its report

${implReport}

## Your job — audit, fix, merge

1. Get the branch without fighting the implementer's checkout (a branch lives in one worktree):
   \`git fetch origin && git checkout -B review/v3-${i} origin/meta/v3-${i}\`; push fixes with
   \`git push origin HEAD:meta/v3-${i}\`.
2. **Scope audit — BLOCKING.** Confirm the diff touches nothing owned by the live tracks
   (\`packages/core/**\`, \`apps/benchmark/dataset/**\`, \`bench-schema\`, \`cases/features.ts\`).
3. **RE-PROVE OUTPUT NEUTRALITY YOURSELF** — do not take the implementer's word. Full bench on the
   branch, per-row diff against \`origin/main\`'s committed \`results.json\` on
   \`asmlift.{outcome,score,candidateLabel,source}\` and \`m2c.{outcome,score,source}\`. Any
   difference is blocking. This is the most important thing you do: a "harmless" speedup that
   silently moved one row would poison every measurement the project has.
4. **Soundness.** General or a patch shaped like one incident? Does a cache key have a correct
   invalidation story? Does added parallelism introduce output-order nondeterminism something
   downstream depends on?
5. **Re-run every gate yourself.** If the change adds a fail-loud check, verify it fires on the bad
   condition AND does not fire on a clean run — a false-alarming guard stalls every future round.
6. **Apply fixes yourself** rather than bouncing back; commit, push, say what you changed.
7. **Merge when CI is green** (poll \`gh pr checks\`, never with a self-matching \`pgrep\`), then
   \`gh pr merge <n> --squash\`, and **verify main is still green**.
8. **Refuse to merge** if a blocking finding cannot be fixed soundly. Refusing is a valid outcome.

Return: per finding — sound / fixed / blocking; your OWN neutrality proof; gate results; whether you
merged; main's post-merge CI state.

${HOUSE}`

const ITERATIONS = 8
const history = []
// Start the incremental window at the last merged meta PR; the supervisor discovers it if unset.
let lastSha = args?.since ?? 'the last merged meta-optimisation commit on origin/main'

for (let i = 1; i <= ITERATIONS; i++) {
  phase('Supervise')
  const sup = await agent(SUPERVISE(i, lastSha), { label: `supervise:${i}`, phase: 'Supervise', schema: FINDINGS_SCHEMA })
  const findings = sup?.findings ?? []
  log(`iteration ${i}: ${findings.length} finding(s) since ${lastSha}`)
  if (sup?.ledger_additions) {
    log(`ledger += ${String(sup.ledger_additions).slice(0, 90)}…`)
  }
  if (findings.length === 0) {
    history.push({ iteration: i, findings: 0, pr: null, note: 'nothing new — no-op iteration' })
    continue
  }

  phase('Implement')
  const impl = await agent(IMPLEMENT(i, findings, sup?.summary ?? ''), { label: `implement:${i}`, phase: 'Implement', schema: IMPL_SCHEMA })
  if (!impl || !impl.pr_url) {
    log(`iteration ${i}: nothing survived the challenge — no PR`)
    history.push({ iteration: i, findings: findings.length, pr: null, rejected: impl?.rejected ?? [] })
    continue
  }

  log(`iteration ${i}: PR ${impl.pr_url}`)
  phase('Review')
  const rev = await agent(REVIEW(i, impl.pr_url, impl.report ?? ''), { label: `review:${i}`, phase: 'Review' })
  history.push({ iteration: i, findings: findings.length, confirmed: impl.confirmed ?? [], rejected: impl.rejected ?? [], pr: impl.pr_url, review: rev })
  lastSha = 'origin/main'
}

return { iterations: ITERATIONS, history }
