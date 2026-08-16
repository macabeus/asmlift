---
description: Bump the pinned m2c baseline, rerun the benchmark, attribute every moved row, and review upstream commits for portable ideas
argument-hint: [target-m2c-commit] (default: upstream master HEAD)
---

Update the benchmark's pinned m2c to **$1** (if empty: latest upstream master). This is a
*measurement + intelligence* task, not just a version bump: every row that moves must be attributed
to a specific upstream commit, and the commit range must be mined for ideas asmlift can port.

Key facts about the setup (verified 2026-08-05):

- The ONE pin is `apps/benchmark/M2C_COMMIT` (plain text, full sha + trailing newline). It is
  enforced at run start by `assertM2cPinned()` against the live checkout — the pin file and the
  checkout must move together or `pnpm bench run` refuses to start.
- The checkout lives at the sibling dir `../m2c` (override: `ASMLIFT_M2C_DIR`). m2c is invoked as
  plain `python3 m2c.py …` — no Docker, no venv.
- The harness caches m2c results keyed by the m2c commit (`apps/benchmark/src/cache.ts`), so after
  a bump all rows recompute m2c automatically while reference builds stay cached. A warm full run
  is ~1 minute, not hours — do not shard-babysit it.
- asmlift's own column is never cached and must come out **byte-identical** — if any asmlift
  outcome moves, something is wrong with the run, not with m2c; stop and investigate.

## Phase 1 — Bump and rerun

1. `git ls-remote https://github.com/matt-kempster/m2c.git HEAD` for the target sha (or use `$1`).
   Read the current pin; record the range `OLD..NEW` and `git log --oneline OLD..NEW` in the m2c
   checkout after `git fetch origin`.
2. **Snapshot first**: copy `apps/benchmark/results/results.json` to the scratchpad as
   `results-old.json` *before* anything reruns. The whole row-diff analysis depends on it.
3. Write the new sha to `apps/benchmark/M2C_COMMIT`; `git -C ../m2c checkout <NEW>`.
4. Smoke-test the new m2c under the local Python before the full run: `python3 m2c.py --help`
   (upstream occasionally breaks on newer Pythons; catch it in 2 seconds, not mid-run).
5. `pnpm bench run` (background it), then `pnpm bench merge` — `run` only writes the per-tier
   files; `merge` produces `results.json` and republishes the web data. Both steps are required.

## Phase 2 — Attribute every moved row

Diff old vs new `results.json` per row id, comparing THREE things for the m2c column: `outcome`,
`diffScore`, and the full `source` **text**. The text diff is the honesty check — it tells you
which rows the upstream commits touched at all, and proves the rest of the range inert on the
dataset. Report the outcome-tally table (match/nonmatch/noncompile/declined/failed, old → new).

For each moved row:

1. Read the old and new m2c `source` side by side; identify the mechanism (e.g. a hard-failure
   message that disappeared).
2. Find the candidate commit: grep the m2c checkout for the error message / touched behavior,
   match against the commit list.
3. **Bisect-verify** — do not attribute on vibes. Dump the row's `targetAsm` from `results.json`
   to a scratch `.s` file, then in the m2c checkout run
   `python3 m2c.py -t <target> -f <sym> <file.s>` at `<commit>~1` and at `<commit>` and confirm
   the flip. Target strings: agbcc → `arm-gcc-c`; MIPS/PPC rows were fed *normalized* asm, so
   `targetAsm` works the same way. **Always `git checkout <NEW>` in the m2c dir afterwards** — a
   drifted checkout makes every later `pnpm bench run` fail the pin assert.
4. For each moved row also record asmlift's outcome on it — a row both tools decline is an open
   differential opportunity and belongs in the findings.

Distinguish honestly between "moved" (outcome/score changed) and "changed but equivalent" (text
churn, same classification). `failed → declined` is not a threat; a new m2c `match` is.

## Phase 3 — Review the commit range for portable ideas

m2c's architecture (per-arch `Arch` classes, asm/IR pattern rewrites over a flow graph) is very
different from asmlift's raising tower — port **ideas, never code**.

- Triage by relevance first: the benchmark is agbcc/ARM + ido & gcc2.7.2/MIPS + mwcc/PPC. Commits
  purely for other ISAs (e.g. the 2026 SH2/Saturn series) cannot move rows — skim them only for
  generalizable mechanisms, and say so explicitly rather than analyzing each.
- The generic files are where sleeper changes hide: `evaluate.py`, `translate.py`,
  `flow_graph.py`, `asm_file.py`, `ir_pattern.py`. An "sh2:"-titled commit that touches these can
  still affect our arches — read those hunks.
- For each potentially portable commit, classify: **worth porting** (name the asmlift module it
  would land in), **nice-to-have**, **already covered by asmlift**, or **not applicable** — with
  one sentence of why. Where a claim is checkable cheaply, check it (e.g. scan `targetAsm` across
  rows for the instruction shape a new m2c pattern matches — "zero bench rows have this shape" is
  a far stronger statement than "low priority").
- Watch for reverted experiments inside the range (a commit added then backed out): the lesson in
  the revert is often the most portable finding.

## Phase 4 — Write up, commit, push

1. Research doc at `research/m2c-bump-<shortsha>-<date>.md` with: the tally table, every moved row
   + verified attribution, the commit-by-commit portability review, and a ranked follow-up list
   for asmlift. `research/` is **gitignored — never cite its paths in the commit message or
   anything that leaves this machine.**
2. Commit `apps/benchmark/M2C_COMMIT`, `apps/benchmark/results/results.json`, and the republished
   `apps/web/src/data/summary.json` + `apps/web/src/pages/benchmark/data/results.json` together,
   on the current branch. Message: headline numbers, what moved and the verified why, one line.
   Push.
3. Final report to the user: headline (moved or held), the moved rows with attribution, and the
   top portable ideas — lead with whatever changes what we build next.
