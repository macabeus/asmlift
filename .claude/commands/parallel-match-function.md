---
description: Run several match-function rounds at once behind a fresh message board, a merge queue, and a coordinator that cannot end a pass with an unanswered message
argument-hint: <FunctionName> [FunctionName ...]
---

Targets: **$ARGUMENTS**

If `$ARGUMENTS` is empty, ask which functions before doing anything else. Do not guess, and do not
pick targets from the benchmark yourself — the choice of what to chase is the user's.

**You are the coordinator.** Not a subagent: you, the top-level session. Everything below that
says "the coordinator" is an instruction to you. You run the passes, you own the board, you own
the merge queue, and you are the only party in this command that can put a question in front of
the user.

This command runs [`/match-function`](./match-function.md) several times over, concurrently, and
owns the three things a single round cannot own for itself: **a message board** the rounds publish
to, **a merge queue** somebody has to sequence, and **a set of passes** structured so that nothing
filed can be left unhandled without a command saying so.

It adds no matching capability of its own. Every rule about how a round finds, builds, proves and
ships a capability lives in [`/match-function`](./match-function.md) and in the docs it defers to —
[`docs/measurement-discipline.md`](../../docs/measurement-discipline.md),
[`docs/bench-cost.md`](../../docs/bench-cost.md) and
[`docs/ranked-repro.md`](../../docs/ranked-repro.md). Follow that file's list rather than this
sentence; it is the one that is maintained. **Do not restate any of it here.** What follows is only
what changes when rounds run beside each other.

---

## What this costs, honestly

Running rounds concurrently converts one round's waiting into another's progress. It does **not**
make three rounds cost three rounds — it costs more than that, and the overhead is not in the
rounds, it is in the merges:

- **A full bench does not parallelise.** The register is machine-wide and a second full run is
  refused rather than queued — [`docs/bench-cost.md`](../../docs/bench-cost.md) §5 is the rule and
  the wait recipe. Concurrent rounds serialise at their bench, with no queue and no fairness.
- **Every merge can oblige every still-open branch to re-measure.** `scripts/check-artifact-provenance.sh`
  verdict 3 fails a branch whose artifact was generated on a tree that does not contain its base.
  So the moment a merge lands a change under the paths that decide a measurement, every open PR
  holding its own artifact owes: rebase → gates → regenerate → push, in the order
  [`/match-function`](./match-function.md) fixes. That is a bench apiece, and by §5 they cannot
  overlap.

Reach for this command for **wall clock**, knowing the merge tail is superlinear. Two targets is
often the right number. It is worth it when the targets are plausibly independent capabilities; it
is not worth it when they are one capability seen from three angles, because those rounds collide
in the same files and the merge queue spends more than the parallelism saved.

---

## Phase 0 — Build the board

**Every invocation gets a new board.** A board that outlives its run accumulates claims whose
author, tree and assumptions are gone, and a reader cannot tell a live fact from a dead one.

1. **Derive the path; do not invent one.** The board is
   `/tmp/asmlift-board-$(id -u)/<run-id>`, where `<run-id>` is `date -u +%Y%m%dT%H%M%SZ`. Not
   `mktemp -d`: `$TMPDIR` disagrees with `/tmp` between a login shell and a plain node process on
   this machine, and this directory is a rendezvous several agents in several worktrees must all
   resolve identically. Freshness comes from `<run-id>`, not from the directory being anonymous —
   and a derivable path is one you can still find after an interruption, where an anonymous one
   exists only in a context that may not survive.
2. **Print the absolute path to the user now**, in your first message. It is the only handle they
   have if this session dies.
3. Create the layout. Folders before files, so the first agent to arrive cannot find a `README.md`
   promising a folder that is not there:

   ```
   <board>/board/facts/    <board>/board/traps/    <board>/board/rounds/
   <board>/queue/          <board>/bin/
   <board>/README.md       <board>/INDEX.md        <board>/MERGE-QUEUE.md    <board>/LANES.md
   ```

   `board/` is append-only publication. `queue/` is a mailbox with an owner. `MERGE-QUEUE.md` and
   `LANES.md` are **mutable state and are edited** — they are deliberately outside `board/`, because
   the append-only rule that makes a post trustworthy would make a queue unmaintainable.
4. Write `README.md` — the **The board** and **The queue** sections below are its content. Write
   `INDEX.md` as a header line and nothing else. Write `MERGE-QUEUE.md` and `LANES.md` as empty
   tables with their headers.
5. **Write `bin/pass-check.sh`** — see **The pass check** below. Run it once, now, against the
   empty board and confirm it exits 0. A check you have never seen pass is a check you cannot read
   a failure from.
6. **Seed `board/facts/` and `board/traps/` before any round is launched.** A fact posted at launch
   is free to every round; the same fact posted once a round has already hit it was paid for by
   whoever was blocked. Read them from
   `~/.claude/projects/-Users-macabeus-ApenasMeu-decompiler-asmlift/memory/` — at minimum
   `asmlift-parallel-worktree-harness.md` for the traps that make a run report success with wrong
   numbers, and the compiler-facts file for whichever toolchains the targets use. Restate each as a
   post; do not post a path to the memory file, because the round agents are told not to read
   outside their worktree for specs.

Do not create a folder for questions-addressed-to-nobody. The last run's equivalent received
nothing: a question worth asking is worth publishing as a post, and a question that genuinely
blocks goes on the queue, where somebody owns it.

---

## Phase 1 — Lanes

**The binding constraint is open PRs, not running agents.** Merges serialise, merges can force
other branches to re-measure, and the merge-time consistency read (Phase 3) is pairwise against
every other open PR — so depth in the merge queue costs more than depth in the lanes.

- **Never exceed two un-merged PRs.** When two are open, no lane opens, however many are idle.
- **Never exceed three running rounds.** Three is an untested default — neither of the two runs
  this command was written from tried two or four — so treat it as a ceiling, not a target, and
  record in the closing report what the open-PR depth actually was when each lane opened. That is
  the number a future revision needs.

Open the first lanes with a pass (Phase 2) — **Phase 1 begins by running a pass**, before any round
exists. The first pick has no running round to compare file surface against, so pick on the target
list alone and say so.

`LANES.md` is the registry, one row per lane: `handle | worktree path | branch | started (UTC) | state`.
`state` is `running`, `returned`, or `dead`. **Nothing is ever launched into a worktree named in
`LANES.md`** — the duplicate-agent-into-a-live-worktree failure is on record, and this row is the
only thing that prevents it. You create the worktree (`git worktree add`) before launching the
round and remove it (`git worktree remove`) after that round's PR has merged or been closed —
never the round itself, which cannot outlive its own worktree.

**Every round is a run of the `match-round` workflow** (`.claude/workflows/match-round.js`), never a
single agent you brief by hand:

```
Workflow({ name: "match-round",
           args: { target, handle, worktree, branch, board, note } })
```

`worktree` and `board` are absolute paths; `note` is optional and carries what you know about the
target as hypotheses. This command's instructions are the opt-in the Workflow tool asks for, so do
not ask the user a second time. When the checkout this session runs in has no
`.claude/workflows/match-round.js` — the user's checkout is routinely behind `main` — launch it with
`scriptPath: "<a worktree on origin/main>/.claude/workflows/match-round.js"` instead of `name`.

A workflow and not one agent per round, because a round run as one agent decides for itself
whether Phase 5's two reviewers are separate agents, whether a second wave runs, and whether a
refuted premise ends the round — and nothing outside that agent can see which it chose. The
script makes those decisions, gives each phase its own agent with only the earlier phases'
results handed on, and puts every lane's progress, phase by phase, in `/workflows`. A run that dies
resumes with `resumeFromRunId`; a run that finishes is the task notification Phase 2 treats as "a
round returns".

Every agent of that workflow reads the list below from its own worktree, so the list is the brief —
edit it here, never in the script. Each round is held to:

- work in **the worktree you created for it**, at the absolute path you give it, branched from a
  freshly fetched `origin/main`;
- read [`/match-function`](./match-function.md) **from that worktree, by absolute path** — the rule
  and the incident behind it are `docs/measurement-discipline.md` §0 — and follow it without
  exception, save for the one override below;
- read `<board>/README.md` first and `<board>/INDEX.md` at the start of every phase;
- **not merge its own PR.** This overrides `docs/measurement-discipline.md` §8 for the duration of
  this command, and it is the single most important line in the brief: that table's "green and
  ready to merge" verdict means *file a `merge-slot` message and return*, not `gh pr merge`. A
  round that merges itself bypasses the whole of Phase 3 on a base that may already have moved.
  `match-round`'s preamble says it in so many words, and must keep saying it — every agent reads
  the table, and the table says merge.
- **resolve an artifact conflict by regenerating, never by editing.**
  `apps/benchmark/results/results.json` is a tracked multi-megabyte JSON file and the repo has no
  `.gitattributes`, so git will line-merge it and a hand-merged artifact publishes per-row numbers
  no run ever produced — passing `bench regression`, `bench diff` and the provenance check, all of
  which are blind to it. The only legal resolution is to take one side whole and re-run the bench.
- **never pass `--no-lock` for the duration of this command.** It is a sanctioned door and this is
  the one configuration it was not designed for.
- expect other branches to be open, expect conflicts, and **never degrade the code to dodge one**;
- never `git stash` — the stack is shared with every other worktree and with the user's checkout,
  so a bare `stash`/`pop` can take another agent's work. Use a WIP commit.
- **not write the memory directory.** [`/match-function`](./match-function.md) Phase 7 asks for a
  memory update, and concurrent rounds would race on the same files there; the write-back goes to
  the board as `facts/`, `traps/` and `rounds/` posts, and Phase 4 below promotes it per merge.
- treat its own brief as a hypothesis, and **report a refuted brief as soon as it is refuted**,
  rather than at the end. Every round in both recorded runs refuted its brief. A lane held by a
  round whose premise is already dead is the cheapest thing this command can free.

Give each round a short stable handle (`CRC`, `SIO`, `LLFROM`) and use it as the author on every
post and every message. **Pass the absolute board path in `args`** — never the literal string
`<board>` or a shell variable. Shell state does not survive between
tool calls, each round is a separate agent with a separate shell, and an unset variable expands to
a path that matches nothing, which reads exactly like an empty queue.

---

## Phase 2 — The coordinator pass

**The coordinator is a pass, not a daemon.** A daemon that stops answering looks no different from
one that has nothing to answer; a pass has an exit condition a command can check. That check is
`bin/pass-check.sh`, and **a pass ends by running it and reading its exit status** — not by
believing itself finished.

A message is handled when a reply file exists beside it. There are three kinds of reply and all
three are files, including the escalation:

- **answered** — the decision, and what the sender should do;
- **refused** — why, and what the sender should do instead;
- **escalated** — the message is put in front of the user *in this session, before the pass ends*,
  and the reply file records that it was escalated and what you asked. An escalation with no reply
  file is re-read as unhandled on the next pass and re-escalated forever.

"Still thinking about it" is not a fourth option. A message that cannot be decided this pass is
refused with the reason, or escalated. **A pass that ends with `bin/pass-check.sh` non-zero is a
failed pass**; re-run the pass immediately rather than noting it.

### When a pass runs

Only two events in this system are observable to you, so only two trigger a pass, and the brief
above is written to make them the same event:

1. **A round returns.** Because a round files its `merge-slot` and *then* returns, a returning
   round is both "a lane freed" and "a message was filed". This is why the brief forbids a round
   from blocking on its merge.
2. **You finish handling something and the state has moved** — a merge landed, an escalation came
   back from the user, a PR's `pr-wait` verdict arrived.

Nothing watches GitHub for you. **`scripts/pr-wait.sh <pr>` is the observer** —
`docs/measurement-discipline.md` §8 has its verdicts and what each one means you should do. Run it
when a `merge-slot` is filed; its verdict is what moves that PR in `MERGE-QUEUE.md`. Do not
hand-roll a poll: `docs/bench-cost.md` records what happens when waiter shells match each other.

### Each pass, in order

1. **Drain the queue.** `bin/pass-check.sh --list` prints every message with no reply, oldest
   first. Handle each one to the standard above **before reading the next** — a pass that reads six
   messages and then acts on four has no way to know which two it dropped.
2. **Advance the merge queue** (Phase 3).
3. **Fill a lane**, if the open-PR rule allows one. Choose from the pending list on two counts: least
   expected file-surface overlap with what the running rounds have claimed, and least likely to
   want the bench at the same moment. If every pending target collides badly, **hold** — write the
   target's row in `LANES.md` with `state: held` and the reason. A held target is still pending; it
   is not dropped, and the run does not finish while one is held.
4. **Update `LANES.md`** — a returned round's row becomes `returned`; a round that returned without
   a PR and without a refuted-brief report becomes `dead`, and its target goes back to pending with
   a note — as does a `match-round` run whose result carries `stoppedAt`, the phase whose agent
   returned nothing. There is no other way for a dead round to be noticed: it will never file
   anything.
5. **Close the pass**: run `bin/pass-check.sh`, read its exit status, and report to the user what
   was handled, what moved, and what was started.

The coordinator has **no push channel to a running round.** It cannot interrupt one. Everything a
running round must know is a board post it will read at its next phase boundary, or a reply file it
is looking for by name.

### What the coordinator does not do

It does not hand out bench slots and it does not hold file locks. Both had working fallbacks, and a
channel whose silence is harmless is a channel whose failure is undetectable.

- **Benches.** The register is a directory holding one record per running bench, and a record whose
  pid is dead reads stale and blocks nothing — so the predicate is **not** "the directory is
  empty", it is "no record names a live pid".
  [`docs/bench-cost.md`](../../docs/bench-cost.md) §5 is the rule, the wait recipe and the stop
  procedure; `pnpm bench in-flight` answers for the worktree you are about to edit. What the
  harness enforces underneath is a refusal, not a queue: there is no fairness, and a round can lose
  the race repeatedly. That is a cost of this command, not a bug in the round.
- **Files.** Git is the arbiter. A claim buys early warning and nothing else, so it is a
  `board/rounds/` post — nobody has to answer it for it to be useful.

---

## Phase 3 — The merge queue

`MERGE-QUEUE.md` exists from the first pass, not from the moment somebody notices that four PRs are
open with nobody sequencing them. One row per open PR: number, branch, position, and if held, **the
condition that releases it, written as something a reader can run.** "Waiting on the 64-bit PR" is
a note; "release when `git grep <symbol> packages/core/src` hits on `main`" is a condition the
blocked round can check without asking, and that you cannot forget the meaning of.

**Delegate each merge to a fresh subagent.** Give it the PR number, `MERGE-QUEUE.md`, and the list
of other open branches; it returns a verdict and merges on green. This is not ceremony: the agent
that feels an idle lane is the wrong agent to decide whether the expensive consistency read can be
skipped, and this repo already separates implementer from reviewer for the same reason. It also
keeps the read out of your context, which is the measured bottleneck.

The merge, in order:

1. **Rebase, re-gate, regenerate, push.** Not "CI was green when it ran" — if `main` has moved
   under this branch at all, the order [`/match-function`](./match-function.md) fixes applies again,
   and `scripts/check-artifact-provenance.sh` is what says whether the artifact is owed. Read that
   script's verdict; do not predict it.
2. **Mergeable** — no textual conflict against `main` as it now is. An artifact conflict is
   regenerated, never resolved by hand.
3. **Architecturally consistent with every other open PR.** Not just the next one — a duplicated
   mechanism between this PR and the third in the queue is invisible to a pairwise check. This is a
   separate question from (2) and no tool answers it: two branches can merge cleanly at the text
   level and leave `main` incoherent. *Git resolves regions; nobody resolves meaning.* For each
   other open PR, read it against the tree as it will exist **after** this one lands:
   - **deleted or renamed surface** — `git grep` its symbols against the post-merge tree;
   - **changed contract** — the dangerous case is the caller that still *compiles*;
   - **prose describing moved code** — a comment or doc paragraph that was true where it was
     written and is false where the code now is;
   - **duplicated mechanism** — two branches that independently built the same thing. Nothing is
     broken and no gate fires; the tree is simply worse, which is why the other checks miss it;
   - **the trial merge** — `git merge --no-commit --no-ff` of the other branch onto the post-merge
     tree, then the round's own gate list, then `git merge --abort`. It is the only one of the five
     that produces an exit status, so run it last and read it.

   **A defect found here is fixed before the merge, not logged after it.**
4. **Squash-merge**, then **re-gate `main` itself.** Run the gate list [`/match-function`](./match-function.md)
   Phase 4 requires, on merged `main`, and **gate on the exit statuses**. This is the check for the
   failure nothing else can see: *a rebase that reverts a hunk can also revert the gate that would
   have caught it.* When the gate and the code it guards live in the same hunk, every branch is
   correct at review time and the tree is wrong afterwards — and step 3 cannot see it, because step
   3 compares two *open* branches while this is a branch against one already landed. Re-running the
   suite on `main` catches it with an exit status and no judgement, which a line-by-line audit of
   the merged diff does not: most lines absent from `main` are legitimately superseded, so that
   audit is unbounded, mostly benign, and therefore skipped.

   If the re-gate is red, **fix forward on `main` before the next merge** and post what happened to
   `board/traps/`.
5. **Update `MERGE-QUEUE.md`**, remove the worktree, and re-run `pr-wait` on whatever the merge
   just unblocked.

Never merge on a red gate, including one red for a known load-flake — re-run it and merge on the
green.

---

## Phase 4 — Harvest, then close

1. **Promote what outlived the run.** Do this **per merge**, not as a final sweep: when a branch
   lands, its `board/facts/` and `board/traps/` posts are promoted to
   `~/.claude/projects/-Users-macabeus-ApenasMeu-decompiler-asmlift/memory/` or to `docs/`,
   restated for a reader who was not here. A final sweep runs at the fullest context with the user
   waiting, and an interruption before it loses everything; per-merge promotion loses only the
   lanes that had not landed.
2. **Measure the corpus once, on merged `main`.** Not by summing per-branch deltas taken against
   different bases — `docs/measurement-discipline.md` §5 and §6 are why. This bench has an owner:
   you, after the last merge.
3. **Report**: every target and its outcome, including held and dead lanes; the corpus movement
   from (2); what is still open; and from `bin/pass-check.sh --stats`, messages filed versus
   answered and the longest a message waited. Do not report how many posts were read — nothing
   records reads, and a number nothing produced is the defect `docs/measurement-discipline.md` §1
   exists to forbid.

A round that ended in a refuted brief, a measured null, or an unmatchable verdict backed by
[`docs/unmatchable-quirks.md`](../../docs/unmatchable-quirks.md) is a completed round. Report it as
one.

**Stopping early.** The user may stop this at any point. When they do, or when you judge the merge
tail is costing more than the remaining targets are worth: stop opening lanes, let running rounds
finish, merge or close what is open, remove every worktree in `LANES.md`, promote the facts, and
report. Never leave a worktree, a branch or a running bench behind without naming it.

---

## The board

Three folders under `board/`, split by **what the reader does with the post** — the split that
predicts who reads it, where a split by topic does not:

| folder | holds | read it |
| --- | --- | --- |
| `facts/` | what is true of the compiler, the ISA, the target — independent of who asks | before building against that compiler |
| `traps/` | tools and commands that return a plausible wrong answer | before trusting a number |
| `rounds/` | what a round is doing, claimed, found, refuted or withdrew | before touching the same files |

Where a post is both a fact and a trap, file it under `traps/`: a trap unread costs a wrong number,
a fact unread costs a re-derivation.

**Filenames carry the time, not a number.** `<stamp>-<AUTHOR>-<slug>.md`, where `<stamp>` is
**`date -u +%Y%m%d-%H%M%SZ`, run as a command every time**. Never compose a timestamp from what you
believe the time to be: an invented stamp collides with your own previous post, silently overwrites
it, and destroys the ordering the drain depends on. With a real clock, two agents cannot collide
without colliding on the second, the author and the slug at once — which is why there is no number
to race for and no allocator to build.

Every post opens with a header — `from:`, `date:`, `tags:`, and `corrects:` when it corrects
another post — then says the thing. Three rules:

- **Append-only.** Never edit a post, never delete one, including your own, including when it turns
  out to be wrong. **Correct it with a new post in the same folder as the post it corrects**, whose
  header names that file in `corrects:`. Same folder, because a reader sent to `facts/` must be
  able to find the correction to a `facts/` post; a correction filed under its author is a
  correction nobody reads. The rule that makes this safe: **before acting on a post, run
  `grep -rl "corrects: <that filename>" <board>/board/`.** One command, and it is the difference
  between append-only being honest and append-only being trustworthy.
- **Write a number the way the project writes numbers** — the command that produced it, run as
  written, or not at all. A board post is read by an agent that will act on it without re-deriving
  it, so an unsourced figure on the board is worse than no post.
- **Do not post status.** "Starting phase 3" is addressed to nobody and read by nobody. Post what
  you *learned*. The coordinator's lane-pick rationale is not a post either — it belongs in the
  pass report.

`INDEX.md` is **append-only, one line per post, never renumbered and never sorted**: the path, then
a hook short enough to decide from. **Append with `printf '%s\n' "…" >> <board>/INDEX.md` and
nothing else.** Not the file-editing tools — they read the whole file and write it back, so two
agents appending at once silently lose one line, and a post with no index line is a post nobody
reads. `bin/pass-check.sh` counts the index against the posts for exactly this reason.

---

## The queue

What is left of a request channel after every kind with a working fallback was removed. A message
is `queue/<stamp>-<AUTHOR>-<kind>.md`; its reply is **`queue/<same stem>.reply.md`**, which is what
makes "unhandled" mechanical rather than remembered. Three kinds:

- **`merge-slot`** — "my PR is ready, here is its number." A round files this and returns; it never
  merges itself.
- **`blocked-external`** — "something outside my worktree is wrong and I cannot fix it from here."
  Rare, and worth the whole channel: the recorded instances are a duplicate agent launched into a
  live worktree, and a landed correction that a later rebase had silently reverted.
- **`help`** — a question the board did not answer. **Only the coordinator replies to these.**
  Answer with a board post, and put the post's filename in the reply file; answering in the reply
  alone sends to one reader what cost the same to send to all of them.

Anything that does not need an answer to be useful is a board post instead. If you are about to
file a message and you already know what you will do when nobody replies, it was a post.

---

## The pass check

`bin/pass-check.sh`, written in Phase 0, is what makes Hard rule 2 a gate instead of a promise.
Plain shell over the board directory, and it must:

- **prove its own apparatus first.** Create a known message-and-reply pair under a scratch prefix,
  confirm the unanswered-detection finds the unanswered one and not the answered one, then remove
  them. A listing that returns nothing because the listing is broken is indistinguishable from an
  empty queue, and that is the defect this whole file is built around. Exit non-zero if the
  self-test does not behave.
- **list unanswered messages** — every `queue/*-*.md` that is not itself a `.reply.md` and has no
  `.reply.md` sibling, oldest first, under `--list`.
- **count the index** — the number of files under `board/` against the number of lines in
  `INDEX.md`, and report a mismatch as a failure. A lost index line is a silently unpublished post.
- **report `--stats`** — messages filed, messages answered, and the longest gap between a message's
  stamp and its reply's.
- **exit non-zero while anything is unanswered or the index does not reconcile**, and exit 0
  otherwise.

Quote every path expansion. An unquoted variable that expands to nothing is the exact shape of the
false negative this script exists to prevent.

---

## Hard rules

1. **Code quality is never traded for a smaller conflict.** Not by a round, not by a merge agent,
   not to clear the queue faster. If two branches genuinely need an architectural change to stop
   colliding, that change is proposed, adversarially reviewed, and made on its own — never smuggled
   into a conflict resolution, where nobody will review it.
2. **A pass ends by running `bin/pass-check.sh` and reading its exit status.** Non-zero is a failed
   pass: re-run it. Never carry a message forward to the next pass.
3. **A round never merges its own PR**, whatever `docs/measurement-discipline.md` §8's table says
   to do with a ready verdict. Every merge goes through Phase 3.
4. **An artifact is regenerated, never hand-merged.** The gates in this repo are blind to a
   hand-merged `results.json`.
5. **Everything in [`docs/measurement-discipline.md`](../../docs/measurement-discipline.md)** —
   numbers come from commands; a compiler claim is verified by compiling; never explain a
   discrepancy, re-run it; never ask a human what a command answers; a measured null ships. Those
   are hard rules of this command too. They live there, and this file does not restate them,
   because the last time a rule lived in two prompts they drifted.
6. **Gate on a check, never chain after it.** `if check; then act; fi`, reading that command's own
   exit status. A check whose result nothing consumes is not a check — a push chained after a
   provenance check rather than gated on it is how a failing tree reached a remote.
7. **A census proves its own apparatus.** Before reporting a count from a search, run the same
   search for something you know is present and confirm it is found.
8. **Give every gate in a loop its own log path.** A loop that redirects each iteration to one file
   destroys the output of the iteration that failed.
9. **The board is scratch.** Its path never appears in a commit, a PR body, a promoted post, or
   anything else that leaves this machine.
10. **The user's checkout is frozen.** Rounds read their spec from their own worktree; nothing
    writes to the main checkout except `git worktree add` and `git worktree remove`.
