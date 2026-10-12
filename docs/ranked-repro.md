# The ranked repro

The two invocations both `/match-function` and `/attribute-function` measure with — the
project-checkout command below, and the benchmark row's own generated script — and the only place
their flags are written down. **Which one you ran is part of the number** (see "The VEHICLE is part
of the number"); a real-tier row is reproduced by the second, never the first. **Both prompts point
here; edit this file, not a copy inside a prompt.** The last time the same command was described in two prompts they
drifted, and a round published `557/578` against a `547` baseline — three numbers produced by
three different commands (PR #79).

## The command

```sh
cd <repo> && pnpm --filter @asmlift/cli build     # rebuild the loader; see below

cd apps/benchmark/checkouts/<project>   # THE BENCHMARK CHECKOUT — not a sibling clone; see below
node <repo>/packages/cli/dist/asmlift.mjs <asm/nonmatchings/…/Fn.s> \
  --config decomp.yaml \
  --score-against <build/…/tu.o> \
  --proto '{"<callee>":{"params":N}}' \
  --jobs 6 --progress
```

**That command measures a project checkout's function, and it is NOT how you reproduce a benchmark
row** — a real-tier row is scored on a different input `.s` and compiled down a different path, so
it lands on a different number. The next section has the measurement and the vehicle that does
reproduce a row (the row's own generated script, from `results.json`). Read it before you quote a
number against a harness outcome.

Run it from the project checkout and redirect stderr to a file — the `[score]` and `[progress]`
lines are stderr, and they are the whole record. From a git worktree, export the harness's
toolchain overrides first (`ASMLIFT_AGBCC` and the rest): a worktree's repo root is not the
workspace, so without them the sibling checkouts do not resolve and the run measures nothing.

## The VEHICLE is part of the number: a benchmark ROW is not this command

The command above measures **a project checkout's function**. It reads the split `.s` the project
committed under `asm/`, compiles candidates with the project's own `decomp.yaml` template against
the project's headers, and scores them against an object the project's build produced. That is the
right question when you are landing a match in a decomp repo.

**A real-tier benchmark row is a different question, and the command above does not reproduce it.**
The harness never reads the project's `.s` and never runs the project's `decomp.yaml`:

- **The input `.s` differs.** A row's input is its `targetAsm` — the compiler's own assembly for the
  target object the harness itself built (`eval/evaluate.ts`) — not the disassembly the project
  committed. Same function, different text: `.L3` labels against a branch back to the symbol,
  `.gcc2_compiled.`/`.size` against `thumb_func_start`, and in the split file the inter-function pad
  spelled as an instruction.
- **The compile path differs.** Real rows are compiled inside `compile/real.ts`'s vendored-context
  escalation ladder — bare typedefs, then the manifest's `prependC`, then the vendored `ctx.i` —
  at THE ROW'S OWN codegen flags, the ones its project's build compiles that unit with. That file
  says so in its own header: _"The target and every candidate compile at the row's codegen flags
  (`Case.codegen`)."_ The project's
  template — its `-iquote include`, its `-Werror`, its `arm-none-eabi-cpp` — is not on that path.
- **The scoring object differs**, and with it the denominator: a per-function `target.o` the harness
  built, against whatever `build/…/tu.o` the project's make produced.

Measured on `kleod:StrCpy:agbcc` — a row retired on 2026-09-13 with the kleod source swap
(`apps/benchmark/dataset/retired-rows.json`), so every number below describes no current row — one of the smallest real agbcc rows (11 of the 126 have a shorter
`targetAsm`), at one asmlift commit (`3a06c74`). Both runs are seconds. The one step that can take
minutes is step 1's: an unbuilt sidecar ELF makes `bench target` run `make asmlift-elf` in your
checkout (below).

| what was run                                                                                                           |  best `[score]` | the source it printed               |
| ---------------------------------------------------------------------------------------------------------------------- | --------------: | ----------------------------------- |
| the command above: `asm/matchings/system/StrCpy.s`, the checkout's `decomp.yaml`, `--score-against build/src/system.o` | `unsigned: 6/9` | `u8 *StrCpy(…) { … return v2; }`    |
| `pnpm bench repro kleod:StrCpy:agbcc --run` (the row's own script)                                                     | `unsigned: 5/8` | byte-identical to the published row |
| `pnpm bench fan kleod:StrCpy:agbcc` (the harness's own call, no script)                                                | `unsigned: 5/8` | byte-identical to the published row |
| the published row, `apps/benchmark/results/results.json`                                                               |           `5/8` | —                                   |

Different score, a different denominator, and a different C spelling — on a seven-instruction
function. Neither run is wrong; they answer different questions, and only the second one is the row.

### The row's own script is the vehicle: `pnpm bench repro`

The thing that reproduces a row end-to-end is **the script the row already carries**, and one
command hands it to you with this machine's paths already in it:

```sh
pnpm bench repro kleod:StrCpy:agbcc --run
```

It writes the row's `scripts.asmlift` into `.local/repro/<row>/` (gitignored, deliberately — see
below), fills in `ASMLIFT_PATH` and the row's own project checkout, runs it with stdout to `out.c`
and stderr to `out.err`, and reports **the `[ranked]` line**:

```
repro: kleod:GetEntityLookupData:agbcc — nonmatch 4/14 as published
repro: symbol map from …/apps/benchmark/checkouts/klonoa-empire-of-dreams
asmlift: [ranked] 4 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, winner unsigned/raw-globals: 4/14 [asmlift source 3a06c74]
repro: script exit 1 — a non-matching row exits nonzero by design
```

**Quote the `[ranked]` line, not a `[score]` line.** It carries `winner …` and the `[asmlift source
<sha>]` stamp this file requires beside every fan number, in one line whatever the fan size. The
`[score]` table above it is sorted **best first**, so a `| tail -1` reports the WORST candidate —
measured on the row above, `signed: 15/18` against a published `4/14`, a different numerator and a
different denominator. If you want one `[score]` line it is `head -1`.

Without `--run` it writes the script and prints how to run it, for editing a flag or stepping
through the three sections by hand. `--tool m2c` writes the row's m2c script instead. A needle with
no `:` is a symbol substring, exactly as `bench run --only` reads it; anything that selects no row
or more than one exits 1 saying so, rather than leaving you a script that runs clean and prints
nothing.

**A non-matching row's script exits nonzero, and that is the row reproducing** — `--score-against`
exits 0 only on byte-exact, and the script is `set -euo pipefail`.

**Build the CLI before the first run.** The script's last line is
`"$ASMLIFT_PATH/node_modules/.bin/asmlift"`, and `packages/cli/dist/` is gitignored — so a fresh
clone's first `pnpm install` warns (`Failed to create bin … ENOENT … dist/asmlift.mjs`) and skips
that link. `pnpm --filter @asmlift/cli build` **and then a second `pnpm install`** creates it.
(The bin is the built bundle, not the repo's `tsx` — see "The loader is part of the number".)

**The flags are per-vehicle.** `--jobs 6 --progress` and a hand-written `--proto '{…}'` belong to
the project-checkout command at the top of this file; the generated script carries neither `--jobs`
nor `--progress` and takes `--proto` from a `proto.json` it writes, and still reproduces the row
exactly. Do not "fix" the script by adding them — it is gated by `pnpm bench fidelity` in
`benchmark.yml`, which re-runs both repro scripts for every function.

**Run it in a gitignored directory, which is what the default gives you.** The script's step 1 is
`bench target … --out "$PWD"`, so running it in the repo root leaves `decomp.yaml`, `ctx.i`,
`in.asm`, `proto.json` and the script itself untracked there — and `bench run`'s dirty-tree
preflight then **refuses the round**, ~39 minutes in. (A scoped `--only` run is exempt, so the
confirm passes and the refusal lands later.) `.local/` and `.envrc.local` are the sanctioned names;
`bench repro` defaults under the first of them. Running it inside
`apps/benchmark/checkouts/<project>` is worse than untidy: `--out "$PWD"` **overwrites that
checkout's own `decomp.yaml`**.

#### `bench target` on its own, for iterating by hand

```sh
pnpm bench target <project:sym:toolchain> --out <dir> [--project-root <checkout>]
```

`bench target` is one of the script's steps (`cli.ts` calls it the "repro-script pre-step"); run
alone it leaves you holding a `target.o` and no input `.s`, prints no `[score]`, and is a third
number away from the row. What CI re-runs for every function is the script, not the pre-step.

Into `<dir>` it writes `target.o` (the harness's own target object, content-cached), a `decomp.yaml`
whose compile command **is the benchmark's toolchain invocation**, and ONE frozen scoring context —
the escalation rung the row's published source stops at, or, on an unscored row, the richest rung
(see "What this vehicle does NOT reproduce", below). Its last stdout line names the rung it picked;
there is no `[score]` on any of them. It does not write the input `.s`, because that is the row's
`targetAsm` — so take it from the row (or just run `bench repro`, above). A symbol-fed row also gets
its map: grafted as `tools.asmlift.elf` from the checkout `--project-root` names, or written beside
`target.o` as `symbols.json` for a synthetic row's authored map.

It is also the step with the long pole in it. If the checkout's declared `tools.asmlift.elf` is not
built and its Makefile has an `asmlift-elf` target, `cases/project-elf.ts` runs
`make asmlift-elf` **in your checkout**, with a ten-minute timeout — so a first run against an
unbuilt sidecar project is minutes and a write into that tree, not the ~10 s a warm one takes.

**A missing checkout does not stop anything, and it does not always move the number.** `bench
target` prints `WARN: <project>: project checkout not found … output may differ from the published
row` and **exits 0**; the script runs on. With the script's `PROJECT_PATH=` line pointed at a
nonexistent path — it is a plain assignment, so an env var of that name does not override it —
`kleod:StrCpy:agbcc` printed the same `unsigned: 5/8` and a **byte-identical** source. So a cheap
row will tell you your setup is right when it is not. `bench repro --run`
surfaces any `WARN` line above the `[ranked]` line for you; running the script by hand, `grep -n
'^WARN' out.err` before quoting anything.

**And `^WARN` catches a MISSING map, not a WRONG one.** `resolveProjectElf` reads whatever
`decomp.yaml` sits at the root it is handed and never checks that the checkout is **this row's**
project — point that line at a different one and a foreign symbol map is grafted silently, at
exit 0, with no `WARN`. That is strictly worse than map-less: the names come out wrong rather than
absent. `bench repro` resolves the checkout from the row's own manifest and cannot do this; if you
pass `--project-root` yourself, `grep -n 'elf:' decomp.yaml` and check the path names this row's
project.

**`bench target` freezes the PUBLISHED rung, and a local run does not refresh it.** The rung comes
from `results.json` — the committed file — and the gitignored per-tier `real.json` beside it is
consulted only for a row `results.json` does not carry at all. So after a `bench run --tier real
--only <sym>` moves your row, the reproduction still replays the rung the published source pins.
That is right for reproducing a published row and wrong for watching your own change land: for
that, the number is `bench run`'s.

#### The whole FAN, and any candidate's source: `pnpm bench fan`

```sh
pnpm bench fan <sym|project:sym:toolchain> [--show <variations>] [--enumerate] [--force] [--base <ref>] [--whole]
pnpm bench fan <sym> --asm <file.s> --toolchain <id> [--show <variations>]
```

The third vehicle, and the only one that answers **"which spellings did asmlift consider"** rather
than "what did this row score". It is not a script and writes no directory: it re-enters the
harness's own ranked call for one row, with the row's own target object, prototypes, context
compile and vendored symbol map, assembled by the single function `bench run` assembles them with
(`eval/asmlift.ts`'s `rankOptionsFor`). So the checkout question this whole file is about does not
arise — there is no second tree to be in.

It prints the `[score]` table this file's comparison recipe is written for, then `[dropped]`,
`[withheld]`, the `[declared]` block and `[ranked]` — all through the CLI's own renderers, the same
functions `pnpm asmlift` prints them with, so the `[ranked]` line here carries the `synthesized`
count and the `[asmlift source <sha>]` stamp this file tells you to quote. Measured on
`kleod:StrCpy:agbcc`: `unsigned: 5/8` in **9 s**, the published row exactly, and `--show winner`
printed the published source byte-for-byte.

Two things it can do that nothing else can:

- **`--show <variations>` prints a NON-WINNING candidate's source.** `results.json` carries the winner's
  C and no other's, while `RankedResult.candidates` — every other candidate, each with its own
  `source` — is computed on every run and discarded. "The near-miss spelling is right and only
  loses on X" is a thing to read here rather than infer.
- **`--enumerate` lists the fan without compiling anything**, and still serves `--show <variations>`
  (not `--show winner` — nothing is scored, so there is no winner to name, and that combination is
  refused rather than answered with whatever enumeration emitted first). That is the cheap
  configuration-identification this file's "Getting the fan alone is cheap" section describes,
  without killing the run after its first `[progress]` line. **Cheap relative to compiling, not
  cheap absolutely**: `kleod:CountCollectedGems:agbcc`'s 5,952 candidates take 50 s wall with the
  target build included (~120 candidates/s), so `LoadBGTilemapData`'s 225,792 is ~30 minutes just
  to LIST. Read a long enumeration as a big fan, not as a hang.

  It also prints `[threw] <function> <variations> threw (no candidate from it)`, a channel
  `bench run` supplies no sink for at all — so the half of a row's fan a pre-respell variation produces can vanish from a
  benchmark run with nothing printed, and here it does not.

- **`--base <ref>` prints the fan MULTIPLIER against what that artifact recorded.** Since each row
  carries its own `fanSize`, this is a comparison rather than archaeology:
  `asmlift: [fan-diff] <row-id>: 5952 → 11904 (2.00×) vs <ref>`, with no bench run behind it.
  It is sound because both sides are the SAME call — the run wrote its count out of
  `rankOptionsFor`, and this enumerates under those same options for the same row id. It prints at
  whichever of FOUR exits the run reaches: the `--enumerate` listing, the scored table, the
  over-limit refusal (on the rows that refuse, you learn what the fan did without compiling any of
  it), and the `noncompile` path — where every candidate was refused and the two refusal lists ARE
  the fan, so it is the one row class whose count the artifact knows. It prints on the **declined**
  path too, which has no count of its own at all — the 234-row class both briefs send rounds to,
  where "the artifact recorded 26,880 for this row and this run has no fan" is the answer rather
  than a silence. Four ways there is no comparison are four different sentences — an artifact that
  predates the field, a row the base never had, a ref nothing can read, and this run having no fan
  — and none of them is a silence. The first is what a base older than the field answers today:
  `pnpm bench fan synthetic:dma_wait:agbcc --enumerate --base origin/main` →
  `the artifact at origin/main records no candidate count for synthetic:dma_wait:agbcc (it predates
the field, or the row never ranked there). And this run enumerates 32; the series starts here.`
  Three are ANSWERS and print beside the count; a ref nothing can
  read is a bad ARGUMENT, so it goes to stderr, is refused **before the row is built** (diagnosing
  it after a ~46 s enumeration — the figure this row showed on 2026-09-12 — is the worst order) and
  **exits 2**: `bench fan <row> --base X && …`
  must not read success from a run that compared nothing.

  **And whether the base's own number is still the base's answer.** The artifact committed on
  `origin/main` was generated by the tree at _its_ commit, and `origin/main` has moved since — so
  part of a multiplier can already be on the base and none of this branch's doing. The command
  prints that question on stderr, from the same `commitsSinceArtifact` split `bench baseline`
  stamps CURRENT / NOT CURRENT with. And `bench baseline <sym>` prints `fan=N rank=Ns` beside
  each row's outcome and score, so the committed values are readable — under that verdict — with no
  comparison at all.

- **`--whole` checks a stillborn stop.** A fan the stillborn stop (core `stillborn.ts`) ended is
  published `noncompile` with `fanNotCompiled` of its candidates never compiled, and no ranked run
  compiles them: the stop is a bet that none would. `--whole` runs the ranked pass as usual, then
  compiles that rest through the pass's own compiler, and exits **1** naming every one that
  compiled (`[whole] COMPILED …`, a false stop), **3** naming every one whose compile threw
  something that is no readable refusal (`[whole] UNCHECKED …`: a killed compiler, a Docker
  outage, a timeout, which say nothing about the candidate — core `stillborn.ts` `readableRefusal`), or
  **0** when the compiler refused them all — the only exit that says the stop held. On a fan no
  stop ended it says so, ranks the fan whole and exits non-zero. It raises the 2,000-candidate
  limit as `--force` does: the rest of a stopped fan is exactly the compiles that limit asks about,
  and the biggest stops are over it. `pnpm -s` reports every non-zero exit as 1, so read the
  `[whole]` line for which. `bench diff`'s `STOP` lines print this command for each newly stopped row.
  Measured on `ac-decomp:aINS_destruct:mwcc_242_81`: 8 compiled by the pass, the other 4 by
  `--whole`, all refused, exit 0, in 12 s.
- **`--toolchain` without `--asm` is refused.** A row carries its toolchain in its own id
  (`project:sym:toolchain`) and the row path never reads the flag, so `bench fan sub_806132C
--toolchain ido7.1` would price **agbcc** — the toolchain in `sa3:sub_806132C:agbcc` — at exit 0.
  The flag exists only for the `.s` form below, which is also what teaches you to type it.
- **`--asm <file.s> --toolchain <id>` prices a function that is not a benchmark row at all.** The
  positional is then the SYMBOL. **Enumeration only**: scoring needs a target object to diff
  against and a compiler configured for that object's world, which is exactly what a row carries
  and a bare `.s` does not — a score from one would be a number against a target nobody named. And
  it is NOT the harness's configuration: no prototypes, no `asmData` side table, no symbol map. So
  its count compares with another `.s` run and with itself across two revisions, and NOT with a
  row's recorded `fanSize`: the same function priced both ways gives two counts, because the
  side tables are half of what the fan is a cross over. The command says so on stderr every time.

  It is runnable on anything in the repo, not only on functions nobody has:
  `pnpm bench fan gcd --asm packages/core/test/corpus/ido-gcd.asm --toolchain ido7.1` → 4
  candidates, in about a second.

  **Which function it priced.** On a `.s` holding two or more functions, a name that is not one of
  them is refused by the frontend, loudly. On a SINGLE-function `.s` the frontend does the opposite
  and lifts that one function under the name you typed — deliberately, because that rename is the
  point when the split calls it `sub_0800D188` and you are decompiling it as something else. So a
  typo prices the right function under a name that exists nowhere, and the command warns when the
  file declares no such function, naming what it does declare. It is a warning and not a refusal:
  refusing would break the rename this flag exists for.

  The census behind that warning tells a **declared function** from the labels around it, and it is
  spelled out of regexes that already exist rather than invented: the objdump symbol header and
  Splat's `glabel` are `detect.ts`'s own, `.globl` is its third, and `*_func_start` is the
  splitter's. Two consequences worth knowing, because a warning that cries wolf is a warning rounds
  learn to skip. **objdump text is read as objdump** — four of the five toolchains this flag
  accepts are fed it, and there a plain `name:` is never a label: objdump's
  `corpus.o:  file format …` header and its instruction OFFSET column both match one, so read
  flatly `ido-gcd.asm` "defines `corpus.o, c`" while its `00000000 <gcd>:` header says
  `gcd`. And a **branch label is not a function**: `_0800D192` is a name you can
  copy out of a klonoa split by the hundred, it _is_ in the file, and lifting the file's one
  function under it is the same wrong answer one level in — so that case gets its own sentence, and
  declared names are listed before branch labels so the one name you came for is not the ninth.

**A fan over 2,000 candidates is refused, not scored** (`--force` overrides), and the refusal
prices the run it is refusing from the row's own count AND ITS OWN TIER. Scoring is a compile each,
and the two tiers do not compile the same thing: `synthetic:sizebound:agbcc`'s 800 take **48 s
cold** (10 s warm, 60 ms each), while `kleod:CountCollectedGems:agbcc`'s 5,952 took **518 s and
483 s** on two cold runs (85 ms each, both reproducing the published `171/387`) — a real candidate
escalates through up to three preludes in `compile/real.ts`, a synthetic one through a single small
prelude; one rate for both under-prices the real tier by ~35%, on the row the refusal's own example
is. So the limit is ~2 minutes of synthetic scoring, `CountCollectedGems` is ~8 minutes — a
`--force` worth typing, not an hour — and `LoadBGTilemapData`'s 225,792 is a five-hour run;
`--enumerate` is the answer at THAT size, and note the guard is checked after the pre-count
enumeration, so the refusal itself pays the enumeration price above. `--force` raises that compile
limit and nothing else, so it is **refused** beside a path that compiles nothing (`--enumerate`,
`--asm`) rather than accepted and dropped.

**A row with no fan says so, and exits 2.** Neither of the ranked path's two calls can be assumed
to return: on a `declined` row (303 of 1,200) enumeration THROWS on the same gap the published row
annotates — `enumerateCandidates` has no annotate mode — and on a `noncompile` row every candidate
is refused, so there is no ranking to print. Both are answered with `asmlift: [fan] no fan …` and
exit 2, and the noncompile case prints the whole `[dropped]`/`[withheld]` list first, because on
that row the refusals ARE the fan.

**Which of the two you are looking at is decided by the ERROR, never by which call site caught it**,
so `--force` does not change the answer — it skips the pre-count enumeration, and a declined row's
lift error then arrives at the scoring catch, where a call-site guess would report it as
`noncompile` under no `[dropped]` lines at all. `NoScorableCandidateError` (nothing SCORED) and
`NoSpellableCandidateError` (nothing SPELLED — the backend refused every tree) are separate classes
for this reason, and a throw that is neither of them nor a decline is reported as a HARNESS defect
with its stack rather than dressed up as a fact about the row.

What it is NOT: a reproduction. It runs asmlift in-process from this repo's sources, so it proves
nothing about the published script, and `pnpm bench fidelity` still re-runs the scripts rather than
this. When you need to quote a number a reader can re-derive from a published artifact, that is
`bench repro`; when you need to know what asmlift thought about, it is this.

### What this vehicle does NOT reproduce: your CHANGED asmlift

The materialized context is pinned to **the published winner**, not to the ladder. The harness runs
the escalation ladder **per candidate** (`compile/real.ts`, `makeRealCompile` — first rung that
compiles wins, for every candidate in the fan); `bench target` replays that ladder once, against the
row's published source, and freezes the single rung it lands on (`compile/real.ts`'s
`resolveScoringPrelude`, called from `cli.ts`).
`kleod:StrCpy:agbcc` freezes rung 1 — a **161-byte** `ctx.i` of six typedefs — while the row's
vendored context is 28 KB of project types.

So a candidate your change makes asmlift emit that names a project type or global (`bool8`,
`gEntityArray`, a `struct`) **noncompiles here and would have been scored by the harness**: the fan
size, and therefore the `[ranked]` line, can differ from the harness's at the same commit. The
vehicle is faithful to the row as published, and drifts from the harness exactly as your change
starts working. Confirm a moved row with `pnpm bench run --tier real --only <sym>`, whose cost is
the ROW's own and spans three orders of magnitude across this tier — ask `pnpm bench baseline <sym>`
for that row's `rank=` before you launch it (`docs/bench-cost.md` §1 and §3). A flat price for this
command is wrong by more than an order of magnitude at both ends of the tier.

And on an **unscored** row it is not "the rung this row stopped at" at all: only `match`/`nonmatch`
rows have a source that pins a rung, so for anything `declined`/`noncompile`/`failed` the caller
falls back to the **richest** rung unconditionally (`cli.ts`, `publishedAsmliftSource` → `undefined`
→ `ladder[ladder.length - 1]`) — **172 of the 421 real rows (41%)**, and the archetypal
`/attribute-function` target. `real.ts`'s own comment says that fallback "is wrong whenever
escalation stopped earlier, because a richer context can REJECT what a poorer one accepts". The
stdout line names the rung either way and never says which case you are in.

Everything below — the checkout, the variation set, the loader, the cache, the flags — is part of both
numbers. Pick the vehicle first, then read the rest.

## The CHECKOUT is part of the number, and it is the one that bit

A project can exist on this machine more than once — the benchmark's own
`apps/benchmark/checkouts/<project>` and whatever working clone the author develops in. **Those are
different trees with different symbol maps and different `decomp.yaml` compile templates, and they
produce different fans from byte-identical assembly.**

Measured on `LoadBGTilemapData`, one asmlift commit, one command, the same `.s` bytes — and
measured **before #148 shipped `/copy-defpos`**, which the next section shows doubled both columns.
The ratio between the two rows is what this table teaches; neither absolute fan is current.

| checkout                                           | branch                  | FUNC/OBJECT syms |         fan |
| -------------------------------------------------- | ----------------------- | ---------------: | ----------: |
| `apps/benchmark/checkouts/klonoa-empire-of-dreams` | `asmlift-benchmark`     |            1,196 | **112,896** |
| a sibling working clone of the same project        | `runtime-naming-round7` |            1,161 | **135,936** |

Note the direction: **fewer symbols, larger fan.** It is the names and the recovered shapes that
drive enumeration, not the symbol count, so "it has a symbol map" is not a configuration — _which_
map is. A run with **no** map is a third configuration again, and a much wider one: every global
becomes a raw address, which is the `/raw-globals` basin, and a partial run in that state was
observed at 603,648 against 271,872 for the same tree with its map present.

**So: run from the benchmark checkout unless you have a stated reason not to, and say which tree,
which branch and whether a symbol map was loaded in the same breath as the number.** Two numbers
from two trees are not a before/after pair — they are two different questions. A round once
published a 10-point improvement measured in one tree against a baseline taken in another, and
another round reported a fan "4.4x larger" that was simply its own tree, map-less, after a variation
had merged.

## The VARIATION SET is part of the number

The fan is a product over the variations enumerated, so **one merged variation multiplies it**. Between
`4fd59555` and `3ebe810d` the fan on a fixed corpus went **112,896 to 225,792 — exactly 2x** —
because #148 shipped `/copy-defpos` (`rank.ts`), the edge-copy-order variation, as a ranked sibling.
That was disclosed in its own PR and still invalidated every carried LBG number, because nobody
re-stated the baseline against it.

`/site-sense` (the per-site branch sense, `rank-variations.ts`) is the same shape and is **GATED**, which
is the part to carry forward: it is enumerated only on a function whose raised IR holds a branch
`raise/shortcircuit.ts` folded, so it multiplies the fan on those functions and on no others. Over
the synthetic tier a lift-only census finds **34 rows carrying such a branch** (of 770; 130 rows the
census's own bare lift could not raise are outside that count), and `LoadBGTilemapData` is one of
them — one folded branch. **So the LBG numbers above are again stale by up to 2x, and this round did
not re-measure them**: a ranked run at that scale is HARD-RULE forbidden and priced in
`docs/bench-cost.md` §1, and no gap in this chain needs it, so what
is recorded here is the GATE firing, not a fan.

Two consequences, and they are cheap:

- **A fan size that changed is a fact to explain, not noise.** Factor it: the counts above are all
  `2^8 * 3^2 * k`, and only `k` — a per-site count — moves with the recovered structure. A clean
  power-of-two jump is a new variation; a change in `k` is the function being recovered differently.
- **Quote the asmlift commit with the fan.** The `[ranked]` line already carries
  `[asmlift source <sha>]`; a number without it cannot be placed.

**Getting the fan alone is cheap.** The first `[progress]` line carries the total, so a
configuration can be identified in about two minutes without compiling anything: run the command
with `--progress`, wait for `1/<TOTAL> candidates scored`, and kill it. Use that before committing
hours to a full run you intend to compare against something.

## The loader is part of the number

Two loaders run the same sources. `npx tsx packages/cli/src/main.ts` reads and transforms every
file on every run, and its transform wraps every arrow function in esbuild's `--keep-names` shim,
which the enumerator's per-candidate closures then pay for on every candidate.
`packages/cli/dist/asmlift.mjs` is those same sources bundled once without it, and it is what the
command above runs. Both produce the same candidates and the same scores; the `[score]` diff below
is the check, and it is cheap.

Measured back to back on the LoadBGTilemapData command below — one machine, other work running on
it, `--jobs 6`, 26880 candidates: **620s under tsx against 484s bundled**, of which the ENUMERATION
(the only phase a loader touches — the candidate compiles are subprocesses) was **207s against
118s**. Both printed the same `[ranked]` line, the same 26880 `[score]` lines and the same stdout
byte for byte. The ratio is the machine's, not the code's: re-time on your own log.

**A bundle is only as fresh as its last build, and `dist/` is gitignored** — nothing rebuilds it for
you, nothing commits it, and an old one runs exactly as happily as a new one. So rebuild before any
run you intend to quote, and read the stamp: the build BAKES the tree it was built from into the
bundle, and the run compares that bake against the checkout it is standing in. A bundle that no
longer matches says `STALE BUNDLE` on the line you are pasting, instead of naming a commit whose
code it is not running.

The comparison is on `packages/` CONTENT, not on the commit: docs and the regenerated benchmark
artifact are committed constantly and change nothing a ranked run computes, so a commit that leaves
`packages/` alone is not staleness and does not warn. CONTENT means the bytes — the check hashes
every tracked-or-untracked file under `packages/` — so re-editing a file the tree was ALREADY
carrying dirty is staleness like any other. That is the state a perf round runs in, and a check that
stopped at the list of dirty paths would have called such a bundle current.

## The cache state is part of a `bench fan` number

The CLI compiles every candidate it scores, so the project-checkout command and a row's own script
(`bench repro`) are never served a stored object. `pnpm bench fan` compiles through the benchmark's
own pipelines, which serve from the candidate store (`apps/benchmark/README.md`, "Modes, refusals
and limits"): a fan wall is COLD or WARM, the two are not comparable, and nothing the fan prints
says which, so say it beside the wall. `ASMLIFT_CANDCACHE=0` compiles every candidate there too.

## The flags are part of the number

- **The CODEGEN FLAGS, first of all.** Every row compiles at its own build's flags, so a ranked run
  that assumes the toolchain's canonical set is measuring a different function from the one the
  benchmark published. Four sources, in this order: `--cflags "<flags>"` first and above everything
  else, then the `objdiff.json` unit that defines the function, then the words already in your
  `compiler` command — and, when none of those answers, the toolchain's canonical set, which the
  run takes WITHOUT refusing. That last one is the case this bullet exists for: it is a silent
  substitution, announced only on the line most readers skip. The run says which source it used, and
  a number quoted without reading that line is a number about an unknown compile:

  ```
  asmlift: [flags] -mthumb-interwork -O2 -fhex-asm (compiler command)
  ```

  A row's own flags are in the artifact (`cflags`), and `pnpm bench repro <row> --run` fills them in
  for you — which is the argument for reproducing through it rather than by hand.

- **`--proto`, whenever a callee's arity matters.** A callee still written in assembly carries no
  DWARF signature, so asmlift has to guess its arity and guesses wrong. `LoadBGTilemapData`
  without `--proto '{"thunk_HeapFree":{"params":1}}'` scores **578** where the round's baseline is
  **547** — a plausible number that is comparable to nothing. Pass the table inline, as above; a
  path to a file holding the same JSON is accepted too, but a scratch file is one more thing that
  drifts between rounds, and two of them carrying different tables is how the `557/578/547` above
  happened.
- **`--jobs 6 --progress`.** The candidate compiles dominate a ranked run and pool cleanly.
  Two LBG runs launched together measured **36m10s serial against 21m32s at `--jobs 6`** (20608
  candidates, 0 dropped, identical winner) — but that machine was also running two full benches
  and both test suites, and a quieter pair measured **31m55s against 11m16s**. The ratio is the
  machine's, not the code's: re-time on your own log and quote that, never these. The
  `asmlift: [progress]` lines are what make a later claim about the run checkable from its log.

- **`--progress` also prints WHERE the time went**, as one `asmlift: [phase]` line from the run's own
  clock (`packages/cli/src/phase.ts`) — so a per-phase claim comes from the log everyone already
  pastes, not from a rig outside the tree that the next round has to rebuild:

  ```
  asmlift: [phase] wall 259.4s · enumerate 19.9s (1 call) · compile 1257.3s over 6 workers
    (26880 calls) · score 163.7s (26880 calls) · rank 2.5s (1 call) · main-thread idle+other 73.3s
  ```

  Two denominators, answering different questions. `compile` is summed ACROSS workers, so
  `compile / wall` is the pool's average parallelism — **4.85 of 6** above, which is what says
  whether more `--jobs` would buy anything. The MAIN THREAD's budget is `enumerate + score + rank`
  = 186.1s of the 259.4s wall, of which scoring is 88%; the remaining `idle+other` is the main
  thread waiting on subprocesses. Of the work charged at all (1443.4s), the compiles are **87%**.

  Both figures move with the machine, and by a lot. The same command on the same commit, sharing
  the box with a full `pnpm bench run`, read `wall 426.3s · compile 2175.1s · score 211.2s` (both
  profiles recorded 2026-08-24; neither is a price to budget with, which is the point) —
  same 26880 candidates, same 0 dropped, same 395, same winner. Only the shares travel; re-time on
  your own log, and say what else the machine was doing.

  `idle+other` is the wall minus the work that HELD the main thread, which is not a fixed list of
  phases: at `--jobs 1` the compiles run on the main thread and come out of it, at `--jobs n` they
  are subprocess awaits and do not. So the residual means "waiting on subprocesses, plus whatever
  this clock does not name" in both, and the parts never sum past the wall.

- **`--proto`'s absence is now in the log.** Every run ends with an `asmlift: [proto]` line
  naming the callees whose arity it had to guess (nothing declared them: no `--proto` entry, no
  declaration in a `--context` header, no signature in `tools.asmlift.elf`). On the canonical LBG command that line is absent; without
  `--proto` it reads `1 callee(s) have no declared arity … thunk_HeapFree`, in the same stderr you
  are already pasting. Check the tail of your log before you quote a score.
- Quote the counts by pasting the **`asmlift: [ranked]` line**, the last thing every ranked run
  writes:

  ```
  asmlift: [ranked] 20608 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, winner <variations>: 531/<rows> [asmlift source 7362050]
  ```

  A score from a run that dropped candidates is not comparable to one that dropped none — and
  "0 dropped" is now something the run SAYS. It used to be spelled as an absent line, so a clean
  run, a truncated log and a killed run left identical evidence.

  `synthesized` counts the declarations asmlift wrote for the winning candidate because no symbol
  map knew the name — read out of the same asm the score is about, so they cannot lose score, only
  manufacture agreement. A non-zero count means the artifact is that declaration block plus the
  source; the block itself is printed on the `asmlift: [declared]` lines just above.

  **WITHHELD is a third count and a different fact.** `dropped` means the scorer refused a
  candidate; `withheld` means one compiled, scored, and was refused PUBLICATION because it is
  proof-gated (`Candidate.matchOnly` — a spelling whose semantics no gate over the C can settle, so
  only a byte-exact score licenses it). Without the count, `candidates scored` silently
  under-reports the fan. On the LBG command below it is 0, because `/unreduce` declines there.

  **The candidate COUNT belongs to the tree, not to the function.** Every variation admitted multiplies
  it, so the counts quoted in the anecdotes above are each an A/B against themselves and none of
  them is a figure to reproduce. Quote your own `[ranked]` line.

- **The tree is part of the number too, and it is on that same line.** `[asmlift source <commit>]`
  names the asmlift sources the run actually executed. A reviewer's run of the command above
  returned **455** against a twice-reproduced **419** with a spotless log — another session had
  written `packages/core/src/target.ts` inside that read-only worktree at the minute it launched and
  restored it before it finished, so `git status` was clean on both sides of the run. Rounds run in
  parallel worktrees other agents write to. **If the stamp is not a bare commit, the number is not
  comparable to anything; fix what it names and re-run.** A bare commit is not a proof of the
  converse: the tree is sampled at the run's two ends, so an edit that lands and is reverted
  strictly between them leaves no mark. The window is the run's length rather than unbounded.

  | stamp                                            | what it says                                                                                                    |
  | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
  | `asmlift source af59b99`                         | the commit whose `packages/` produced this score. Quotable.                                                     |
  | `asmlift source af59b99+dirty`                   | uncommitted changes under `packages/`; nobody else can reproduce it                                             |
  | `asmlift source af59b99, CHANGED DURING THE RUN` | the sources moved between the run's start and its end — a tsx run can load a file from either side of that edit |
  | `asmlift source af59b99, STALE BUNDLE: …`        | the bundle ran `af59b99`'s code, and the checkout no longer holds it. Rebuild, re-run                           |
  | `asmlift source unversioned`                     | not run out of an asmlift checkout at all (an installed package), so nothing here can name the sources          |

## Comparing two runs

Compare on the `[score]` lines, filtered with a **fixed** string:

```sh
diff <(grep -F '[score]' a.err) <(grep -F '[score]' b.err)
```

`grep '[progress]'` is a bracket **expression** matching any one of `p r o g e s`, so
`grep -v '[progress]'` deletes almost every line including every `[score]` one, and the diff
passes having compared nothing. A neutrality check that filters away what it is comparing is
worse than none.

**Every `[score]` line, and the `winner …` on the `[ranked]` line, reads `<score>/<rows>`.** `rows`
is objdiff's total row count for _that candidate's_ alignment against the target, so it belongs to
the candidate and not to the target: a different spelling aligns differently and is scored against
a different scale. **A run-to-run delta is therefore a pair of fractions, never a subtraction.**
`kleod:CountCollectedGems:agbcc` moved 290/404 → 171/387 between two committed artifacts, and
reading its `290 → 171` as 119 points on a fixed scale cost an attribution round. Quote both
numbers; if the denominators differ, say so in the same sentence.

(The runs recorded in this file predate that format, so their `[score]` md5s do not compare with a
run made today; their line _counts_ and their **stdout** md5s do — every score the CLI prints goes
to stderr, and the generated C on stdout is untouched.)

## Write it down

Whatever you run, paste it verbatim, flags included, into your report. Every later measurement —
each reviewer's, each remediation's, the PR body's — re-runs _that_ command, not one recomposed
from memory.
