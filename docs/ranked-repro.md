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
  with asmlift's canonical flags for the ISA. That file says so in its own header: _"the target is
  our deterministic re-compile of real game code, not the shipped ROM object."_ The project's
  template — its `-iquote include`, its `-Werror`, its `arm-none-eabi-cpp` — is not on that path.
- **The scoring object differs**, and with it the denominator: a per-function `target.o` the harness
  built, against whatever `build/…/tu.o` the project's make produced.

Measured on `kleod:StrCpy:agbcc`, one of the smallest real agbcc rows (11 of the 126 have a shorter
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
asmlift: [ranked] 4 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, best unsigned/raw-globals: 4/14 [asmlift source 3a06c74]
repro: script exit 1 — a non-matching row exits nonzero by design
```

**Quote the `[ranked]` line, not a `[score]` line.** It carries `best …` and the `[asmlift source
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
pnpm bench fan <sym|project:sym:toolchain> [--show <label>] [--enumerate] [--force] [--base <ref>]
pnpm bench fan <sym> --asm <file.s> --toolchain <id> [--show <label>]
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
`kleod:StrCpy:agbcc`: `unsigned: 5/8` in **9 s**, the published row exactly, and `--show best`
printed the published source byte-for-byte.

Two things it can do that nothing else can:

- **`--show <label>` prints a NON-WINNING candidate's source.** `results.json` carries the winner's
  C and no other's, while `RankedResult.candidates` — every other spelling, each with its own
  `source` — is computed on every run and discarded. "The near-miss spelling is right and only
  loses on X" is a thing to read here rather than infer.
- **`--enumerate` lists the fan without compiling anything**, and still serves `--show <label>`
  (not `--show best` — nothing is scored, so there is no winner to name, and that combination is
  refused rather than answered with whatever enumeration emitted first). That is the cheap
  configuration-identification this file's "Getting the fan alone is cheap" section describes,
  without killing the run after its first `[progress]` line. **Cheap relative to compiling, not
  cheap absolutely**: `kleod:CountCollectedGems:agbcc`'s 5,952 labels take 50 s wall with the
  target build included (~120 candidates/s), so `LoadBGTilemapData`'s 225,792 is ~30 minutes just
  to LIST. Read a long enumeration as a big fan, not as a hang.

  It also prints `[lever] <label> threw (no candidate from it)`, a channel `bench run` supplies no
  sink for at all — so a whole pre-fan half of a row's fan can vanish from a benchmark run with
  nothing printed, and here it does not.

- **`--base <ref>` prints the fan MULTIPLIER against what that artifact recorded.** Since each row
  carries its own `candidateCount`, this is a comparison rather than archaeology: `asmlift:
[fan-diff] kleod:CountCollectedGems:agbcc: 5952 → 11904 (2.00×) vs origin/main`, with no bench run behind it.
  It is sound because both sides are the SAME call — the run wrote its count out of
  `rankOptionsFor`, and this enumerates under those same options for the same row id. It prints at
  whichever of FOUR exits the run reaches: the `--enumerate` listing, the scored table, the
  over-limit refusal (on the rows that refuse, you learn what the fan did without compiling any of
  it), and the `noncompile` path — where every spelling was refused and the two refusal lists ARE
  the fan, so it is the one row class whose count the artifact knows. Three ways there is no
  comparison are three different sentences — an artifact that predates the field, a row the base
  never had, a ref nothing can read — and none of them is a silence. The first two are ANSWERS and
  print beside the count; a ref nothing can read is a bad ARGUMENT, so it goes to stderr and
  **exits 2**: `bench fan <row> --base X && …` must not read success from a run that compared
  nothing.
- **`--asm <file.s> --toolchain <id>` prices a function that is not a benchmark row at all.** The
  positional is then the SYMBOL. **Enumeration only**: scoring needs a target object to diff
  against and a compiler configured for that object's world, which is exactly what a row carries
  and a bare `.s` does not — a score from one would be a number against a target nobody named. And
  it is NOT the harness's configuration: no prototypes, no `asmData` side table, no symbol map. So
  its count compares with another `.s` run and with itself across two revisions, and NOT with a
  row's recorded `candidateCount` — measured on `synthetic:dma_wait:agbcc`, whose row enumerates
  **32** and whose bare `.s` enumerates **36**. The command says so on stderr every time.

  **Which function it priced.** On a `.s` holding two or more functions, a name that is not one of
  them is refused by the frontend, loudly. On a SINGLE-function `.s` the frontend does the opposite
  and lifts that one function under the name you typed — deliberately, because that rename is the
  point when the split calls it `sub_0800D188` and you are decompiling it as something else. So a
  typo prices the right function under a name that exists nowhere, and the command warns when the
  symbol is in no label of the file, naming the labels it does define. It is a warning and not a
  refusal: refusing would break the rename this flag exists for.

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
to return: on a `declined` row (233 of 1,035) enumeration THROWS on the same gap the published row
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
starts working. Confirm a moved row with `pnpm bench run --tier real --only <sym>` (30–90 s).

And on an **unscored** row it is not "the rung this row stopped at" at all: only `match`/`nonmatch`
rows have a source that pins a rung, so for anything `declined`/`noncompile`/`failed` the caller
falls back to the **richest** rung unconditionally (`cli.ts`, `publishedAsmliftSource` → `undefined`
→ `ladder[ladder.length - 1]`) — **101 of the 252 real rows (40%)**, and the archetypal
`/attribute-function` target. `real.ts`'s own comment says that fallback "is wrong whenever
escalation stopped earlier, because a richer context can REJECT what a poorer one accepts". The
stdout line names the rung either way and never says which case you are in.

Everything below — the checkout, the axis set, the loader, the cache, the flags — is part of both
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
another round reported a fan "4.4x larger" that was simply its own tree, map-less, after an axis
had merged.

## The AXIS SET is part of the number

The fan is a product over enumeration axes, so **one merged axis multiplies it**. Between
`4fd59555` and `3ebe810d` the fan on a fixed corpus went **112,896 to 225,792 — exactly 2x** —
because #148 shipped `/copy-defpos` (`rank.ts`), the edge-copy-order axis, as a ranked sibling.
That was disclosed in its own PR and still invalidated every carried LBG number, because nobody
re-stated the baseline against it.

`/site-sense` (the per-site branch sense, `rank-axes.ts`) is the same shape and is **GATED**, which
is the part to carry forward: it is enumerated only on a function whose raised IR holds a branch
`raise/shortcircuit.ts` folded, so it multiplies the fan on those functions and on no others. Over
the synthetic tier a lift-only census finds **34 rows carrying such a branch** (of 770; 130 rows the
census's own bare lift could not raise are outside that count), and `LoadBGTilemapData` is one of
them — one folded branch. **So the LBG numbers above are again stale by up to 2x, and this round did
not re-measure them**: the ranked run costs 1500–8000 s and no gap in this chain needs it, so what
is recorded here is the GATE firing, not a fan.

Two consequences, and they are cheap:

- **A fan size that changed is a fact to explain, not noise.** Factor it: the counts above are all
  `2^8 * 3^2 * k`, and only `k` — a per-site count — moves with the recovered structure. A clean
  power-of-two jump is a new axis; a change in `k` is the function being recovered differently.
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

## The cache state is part of the number

asmlift can serve a candidate object a previous run already compiled, instead of compiling it
again (`packages/cli/src/candcache.ts`). **It is ON unless `ASMLIFT_CANDCACHE` says otherwise**,
and it changes a run's WALL by several times while changing nothing a run computes. So every wall
quoted from now on has to say which state it was measured in, in the same breath as the command:

| `ASMLIFT_CANDCACHE`                         | what the run does                                                                                      | when to use it                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| unset, `1`, `on`, `true`, `yes`             | serves any candidate this toolchain already compiled, and AUDITS a sampled 2% by compiling them anyway | **the default** — say `cold` or `warm`, and paste the `[candcache]` line with the wall |
| `0`, `off`, `false`, `no`, or SET-AND-EMPTY | compiles every candidate; touches no disk                                                              | a wall you want comparable with every wall published before the default flipped        |
| `verify` (any capitalisation)               | compiles every candidate AND audits the store against it, loudly                                       | after any change to the cache, or when a stored answer is suspect                      |
| anything else                               | **OFF, with `[candcache] REFUSED reason=unrecognised-mode` on stderr**                                 | never on purpose — the parse is closed so a typo cannot silently SERVE                 |

**EVERY WALL PUBLISHED IN THIS REPO BEFORE THE DEFAULT FLIPPED WAS MEASURED CACHE-OFF**, because
the variable was set in no shell profile, no `.envrc` and no CI job — so `unset` and `off` were the
same run. They are not the same run now. A wall taken today with nothing said about the cache is a
WARM CACHE wall and is not comparable with any of them; measure with `ASMLIFT_CANDCACHE=0` to
compare against a published number, and say so.

`ASMLIFT_CANDCACHE=` (set, empty) is OFF and says so on stderr. It is deliberately NOT the same
state as unset: an empty value is both a one-shot bypass someone typed and an unexpanded
`$SOMETHING`, so it lands on the side whose cost is a cold start rather than a served object.

**SET-AND-EMPTY is guarded on every one of these variables, and it was not.** An unexpanded
`$SOMETHING` reaches a variable as the empty STRING, which `??` does not catch — and for the two
below an empty string is a perfectly usable value, so nothing failed:

- `ASMLIFT_CANDCACHE_DIR=` is a PATH, and the path it is is the CURRENT DIRECTORY. `ns/`,
  `objects/` and `MISMATCHES.log` landed wherever the process was standing — which the section
  above tells you is your decomp checkout — and the pruner then deleted from a two-level
  `objects/<dir>/<file>` layout that is an ordinary build-output shape. It now falls back to the
  default store and says so; a non-empty value is resolved once, so a relative store cannot mean
  two directories in one process.
- `ASMLIFT_CANDCACHE_SAMPLE_SEED=` pinned the audit's selection to one fixed subset of every store
  forever — the exact "audits the same keys and never the rest" failure the seed exists to prevent
  — with a trailing `seed=` on the `[candcache]` line as the only tell. It now falls back to a
  fresh random seed and says so.

`ASMLIFT_BENCH_CACHE=0` turns this cache off too: "bypass the benchmark's caches" has to mean all
of them, or bisecting a suspect row still reads candidate objects off disk.

**TEST RUNS ARE FENCED, and two of the three pins are not the obvious one.** `vitest.config.ts`
pins `ASMLIFT_CANDCACHE=0` for every suite it runs (`test:offline`, `apps/benchmark/test`,
`apps/web/test`) — ablated, `pnpm test:offline` wrote 8 namespaces / 20 keys of a throwaway `sh`
"compiler"'s output into the shared store, and against a poisoned store 13 tests in
`compile-command.test.ts` failed on the poison. It also pins `ASMLIFT_CANDCACHE_SAMPLE=0`, because
the 2% audit under a random per-run seed is a 1-in-50 flake for any test asserting "a hit is an
execution that did not happen"; and `ASMLIFT_CANDCACHE_DIR` to a per-run throwaway, because the
candcache suites DELETE the mode pin to exercise the real default and the mode pin therefore cannot
protect them. `pnpm test:matching` is the deliberate exception: it forces `verify` and audits the
SHARED store, which is the only thing in the repo that does — pointed at a fresh directory it would
find nothing to disagree with and go green having audited nothing.

- **COLD or WARM is a property of the STORE, not of the flag.** The first cache-on
  run after a toolchain change, a flag change, or a change to the harness code that shapes the
  compiler's input is COLD by construction — the namespace moved and nothing in the store answers
  to it. Say `cold` or `warm`, not just `on`. The store lives at `ASMLIFT_CANDCACHE_DIR`
  (default `$TMPDIR/asmlift-candcache`); deleting it makes the next run cold.
  **AND SO DOES REBUILDING THE BUNDLE, whatever you changed.** That sentence used to say "the
  harness code that shapes the compiler's input", which is what the namespace INTENDS to measure
  (`compile-command.ts` hashes its own module file) — but in the shipped bundle that file is
  `dist/asmlift.mjs`, so the digest covers the whole CLI. MEASURED, on this box, with everything
  else held fixed: two LoadBGTilemapData runs off one bundle both resolved
  `ns=82c83810be494b45`; adding a COMMENT to `packages/cli/src/phase.ts` — a file no compile
  reads and that shapes no compiler input — and rebuilding moved it to `ns=a5e72b95f10cea78`.
  **AND SO DOES COMMITTING.** The build bakes its own commit and dirty flag into the bundle, so a
  DOC-ONLY commit, and the dirty-to-clean transition of an unchanged tree, both move the namespace
  as surely as an emitter change does. In this repo's own workflow — commit, rebuild, quote — that
  makes the first run after every commit cold, and it means **a warm store cannot be carried across
  one**: a wall quoted as `warm` is only reproducible from the store filled at the same commit, so
  name that commit beside the wall.
  This is the cold-start direction and therefore sound, but it decides how to pair runs: `docs`
  above tells you to rebuild before any run you intend to quote, so **a base run and a lever run
  with a rebuild between them share nothing** and both are cold. Build once, then run the pair —
  or expect the first of them to pay full price.
- **Never compare a warm wall against a cold one and call the difference a code change.** This is
  the same rule as "never compare numbers made with different flag sets", and it is easier to
  break because nothing on the command line says which state you were in. The run itself does:
  with the cache on, an `asmlift: [candcache]` line prints next to `[ranked]` with the mode and
  the hit/miss/stored counts. **Paste it whenever you paste a wall.**
- **The cache is a throughput lever and never a result lever.** The `[score]` lines, the winner
  and the stdout are identical in all three states by construction — a cache miss is
  indistinguishable in RESULT from no cache at all. If a `[score]` line moves between a cold run
  and a warm one, the cache is wrong; run the `diff` below, then re-run with `ASMLIFT_CANDCACHE=0`
  and report it.
- **On a PROJECT's own `decomp.yaml` command, the cache runs — there is nothing to declare.**
  **THE POSTURE CHANGE, stated where it happens:** two of them, in sequence. First, the cache
  stopped needing a `tools.asmlift.cacheInputs` declaration, so `ASMLIFT_CANDCACHE=1` stopped being
  inert on a project's own command. Then the DEFAULT flipped: it is live for everyone now, on every
  project's own `decomp.yaml` — the path every published score comes from — with no variable set
  anywhere. Your next run caches your own project's compiles with no further action, and the only
  signal is one `asmlift: [candcache]` line among the phase output. `ASMLIFT_CANDCACHE=0` is the
  way back.
  The opt-in existed because one input class could not be measured: a directory named by a flag.
  `-I tools/agbcc/include` was hashed by content already; `-iquote include` — klonoa's own template
  — was a bare word nothing looked at. A declaration a project could get incomplete was itself a
  stale-object hole, so it is gone: the namespace measures the toolchain rather than listing it.
  Measured now: **every token that names an existing path**, whether or not anyone listed the flag
  in front of it (`--include-directory inc`, `-iframework inc`, a flag invented after this was
  written); every ATTACHED operand of the flags in the de-gluer table (`-Iinc`, `--sysroot=dir`,
  `-Wa,-Iinc`); the CONTENTS of a `@response` or `-specs` file, scanned BOTH ways the outer
  template is — the de-gluer table and every token tried as a path — because scanning a body with
  the table alone made a response file the safer place to hide an input; the directory a
  SUBDIRECTORY-qualified injected `-include` header resolves its own quoted includes from; the
  DIRECTORY PART of a glob (`cat inc/*.h`); an operand held in a variable the template assigns,
  quoted with a space in it, or written `~/…`; the base a `cd` in the template moves to; and what
  `CPATH` and friends point AT.
  A shell COMMENT is not scanned — `sh` drops from an unquoted `#` to the end of the line, so
  nothing in it is read, and scanning it put the project's own `build/` tree in the namespace
  (every rebuild cold) or refused the whole cache over the word `docker` in an English sentence.
  Editing the comment still moves the namespace: the template's raw bytes are hashed
  unconditionally.
  That holds for a WRAPPER SCRIPT the template names, not only for the template itself: a comment
  computes no delegate and opens no file, so it decides neither what the chain follows nor whether
  the chain can be followed at all. Measured on one 61-line decomp wrapper — ten of its lines trip
  the "computes its delegate" refusal below, EIGHT are English sentences quoting `.set`, `.4byte`
  and `make` in backticks, and the other TWO ARE CODE. So reading prose as prose removes 8 of 10
  refusal SITES on that script and the script still refuses; clearing it takes an edit in the
  checkout that owns it as well, and the two halves only work together.
  Whole SCRIPTS therefore cross from the refusing side to the serving side, which is worth saying
  plainly even though every CONSTRUCT that refused still refuses. A script that is now followed is
  a script whose data inputs are your problem — see the residual list below, and the one-token fix
  under it.
  One exception, and it is the refusing side: a script containing a HEREDOC is read as written,
  because inside one a leading `#` is body text and `$(…)` still substitutes, so the comment
  reading is not decidable there. The marker is a heredoc's SHAPE (`<<EOF`, `<<-'EOF'`) tested on
  the text with comments already dropped — a bare `<<` on the raw bytes let a `<<` in an English
  sentence, and an arithmetic `$((1 << 2))`, switch the whole script back to being read as prose.
  A refusal QUOTES the lines it is about (`… [line 35: REPO="$(cd …)"]`) — naming only the file
  left the reader to guess which of ten matches was the answer. It is computed LAZILY, once a key
  is first looked up, so a run that printed no `REFUSED` line may simply have compiled no
  candidate; that is not evidence the cache worked.
  The cache still refuses, out loud, when the compile is not a pure function of its input —
  `[candcache] REFUSED label=command reason=object-is-not-a-pure-function-of-its-input` is what
  `ido7.1` gets, because it writes the absolute path of its input `.c` into the object — when a
  measured path exists and CANNOT BE READ (an include directory at mode 0311 is searchable and not
  listable: the compile can read it and the walk cannot, so nothing is cached), and when the
  command runs the compiler somewhere this namespace cannot follow — a container image named by a
  mutable tag, another host over `ssh`, a `chroot`/`qemu`/`wine` (`reason=stamp-threw`).
- **A project can refuse for itself: `tools.asmlift.candidateCache: off`.** One key, one value.
  Declare it when your command runs the compiler somewhere nothing here can read it, or reaches
  something in the residual list below. It is deliberately the inverse of the deleted
  `cacheInputs`: that key asserted what a command reads and an incomplete assertion served a stale
  object; this one only ever turns the cache OFF, so an unnecessary one costs a cold start.
  `ASMLIFT_CANDCACHE=0` is the same answer for a whole process; this one is per project, which is
  what you want when only one of your projects has the problem.
- **What is still NOT measured, said out loud.** A path the command itself COMPUTES
  (`H=in; cat ${H}c/k.h`), which no token scan can resolve, and its cousin, a `cd` into a computed
  directory (`cd "$(dirname …)"` contributes no resolution base — and note the ASYMMETRY, which is
  the most surprising thing in this file: that same `$( )` costs a template a resolution base, and
  REFUSES THE WHOLE CACHE inside a wrapper SCRIPT, because a script's delegate cannot be read
  without running it); a wrapper script that reads a config DIRECTORY, or any data FILE it locates
  for itself (the chain follows what a script EXECS, not what it OPENS — though editing the script
  itself does move the namespace);
  `-B /opt/tc/arm-` used as a filename PREFIX rather than a
  directory (the operand is measured as a path, so the prefix spelling names nothing that exists
  and contributes nothing);
  a candidate's assembler `.include`/`.incbin` (the per-key refusal tests the C preprocessor's
  `#include`, and asmlift's emitter emits object-like `#define` only — measured 0 of 66,816 on
  LoadBGTilemapData); the compiler's own built-in search directories, which every corpus
  template puts out of reach with `-nostdinc`; and an opaque runtime this build has never heard of
  — the refusal above is a deny-list of process names, and a deny-list's miss is on the
  stale-object side.
  **THE PROJECT ROOT is on this list on purpose, with a number.** A glob with no directory part
  (`cat *.h`, `rm -f *.o`) expands in the project root, and an injected header spelled without a
  directory (`-include global.h`) resolves its quoted includes from it — and the project root is
  the whole checkout, not an include directory anyone named. Measured on one box: 29,126 entries
  at `pokeemerald`, 25,901 at `af`, 47,211 at a real klonoa dev checkout, all over the
  20,000-entry stamp budget, so treating `.` as an operand REFUSED those projects outright; its
  depth-0 files alone are the baserom (26 files / 131,114,078 bytes at `pokeemerald`), a quarter
  of the 512 MiB budget hashed per process for a file no compile reads; and where it did fit, the
  namespace tracked `build/` and `.git/`, so every rebuild was a cold start. A glob or an injected
  header WITH a directory part (`cat inc/*.h`, `-include inc/pre.h`) is bounded and is measured —
  though only one level: a `#include "../other/k.h"` from inside that header escapes it.
  One FALSE POSITIVE is kept for the same asymmetry: the container-runtime check reads every
  token, so a runtime word inside a quoted string (`echo "no ssh here"`) refuses the project's
  cache. That is loud and costs a cold start, and a command-position-only rule would silently miss
  `env X=1 docker run`.
  If your command reads something in one of those shapes, declare
  `tools.asmlift.candidateCache: off`, or run with `ASMLIFT_CANDCACHE=verify` — it compiles anyway
  and fails on any disagreement — or `ASMLIFT_CANDCACHE=0`. Serving mode's own sampled audit is the
  standing mitigation for this whole list, and it is a bound on how long one survives, not a
  removal: see the `on` MODE AUDITS ITSELF bullet below.
  **What `verify` can and cannot evidence for this bullet.** A verify run compares stored bytes
  against fresh for every key it stores — but 0 of 66,816 LoadBGTilemapData candidate TUs carry an
  `#include`, so the include directory is never read for any key stored, and a clean verify run is
  zero evidence about the directory measurement specifically. It evidences the toolchain, the
  environment and the template. The evidence for the directory measurement is the offline poison
  suite (`packages/cli/test/offline/candcache-dirflags.test.ts`), which drives each shape through
  a real compile across an edit.
- **A DATA INPUT YOUR WRAPPER OPENS: name it in the template.** The residual above — a script that
  reads a file it locates for itself — has a fix, and the whole recipe is three steps, none of
  which is in asmlift:
  1. pass the file as a template ARGUMENT
     (`… ./scripts/wrap.sh "$OBJ" "$ASM" build/game.elf`) instead of letting the script find it:
     every token that names an existing path is measured by content, so the data input rejoins the
     namespace and rebuilding it correctly invalidates;
  2. delete the `$(…)` PATH computation from the script — `REPO="$(cd "$(dirname "$0")/.." && pwd)"`
     is the near-universal wrapper idiom and it alone refuses the whole project, because the
     detector is a syntax test over a script and does not ask whether the computed value reaches an
     exec position. Take the directory from the caller, or accept the path as an argument;
  3. de-backtick any diagnostic STRING (`echo "… (run \`make\` first)"` is code, correctly, so the
     backtick in it counts).

  Step 2 is the asymmetry the residual list names: the identical `$( )` costs a TEMPLATE a
  resolution base and REFUSES a SCRIPT outright. Steps 1 and 3 alone leave a script refusing.
  Proven on the shape that motivated this bullet — a decomp wrapper that appends
  `.set NAME, 0xADDR` lines read out of the project's linked ELF, so the candidate object is a
  function of that ELF's symbol table: patching one symbol's `st_value` moved the object's literal
  pool with its SIZE UNCHANGED (680 B either way, `.word 0x03005478` → `.word 0x03009999`), which
  is exactly the row objdiff scores. With the ELF named in the template, renaming a symbol it
  defines recompiled all 1,104 candidates of one fan (`{"miss":1104,"stored":1104}`), and putting
  the ELF back was the same toolchain again (`{"hit":1082}`). With the identical script locating
  the same ELF for itself, the same rename served 1,085 stale objects — and the standing 2% audit
  is what stood between that and a published score: 9 of the 19 sampled keys disagreed and the run
  exited 3, with `ASMLIFT_CANDCACHE=verify` putting the real damage at 439 of 1,104 keys.

  **AND THE COST, because it is not free.** A named file is a namespace input, so every rebuild of
  it is a full cold fan — the same rule that keeps the PROJECT ROOT on the residual list above
  (`build/` and `.git/` in the namespace means the cache never warms). The `{"miss":1104}` line
  two paragraphs up is that cost as well as the soundness proof: it is what a `make` of the named
  file buys you, every time. So name the SMALLEST file your wrapper actually reads, not the tree it
  sits in, and expect a cold start after each build of it. On a workflow that rebuilds that file
  constantly — a symbol-renaming round, say — that is the honest expected value, and it is what
  decides whether the warm-cache ratio is real for you.

- **A `put` does not trust the store either, and that hole had NO audit over it at all.** The
  store is content-addressed: `objects/<sha>` is deduped and hardlinked per key. Treating the
  EXISTENCE of that file as proof of its CONTENT meant a corrupted entry — a disk error, an
  external edit, a store living where the project's own build writes — was hardlinked onto a key
  whose object had just been compiled correctly, and the caller was served bytes it had not
  produced. MEASURED: a run in which every key MISSED, every candidate compiled freshly and
  correctly, and the audit ran at 100% published a NONMATCH as a byte-exact MATCH with exit 0 and
  wrote no `MISMATCHES.log`. What sampling cannot reach is that RUN — it is reached from the SERVE
  path, so it withholds only keys the store can already ANSWER, and there every key MISSED. (Once
  such a key can be served, the audit does compare it and does report; the run in which the
  corruption is first deduped onto is the hole.) A `put` holds the truth and has already hashed it,
  so it compares: a disagreement is an `OBJECT STORE CORRUPT` mismatch like any other, and the run
  exits 3. **The repair is written THROUGH THE INODE**, because `objects/<sha>` is hardlinked from
  every key that deduped onto it — replacing the NAME would repair the key being stored and leave
  every other one serving the bytes the same line just reported, with a warm run (all hits, no
  puts) never reaching the comparison again. Cost, measured at the cold LBG fan's own shape (53,228
  dedup-hit puts over 15,124 distinct objects): +1.5 s on a 683-905 s run, and zero on a warm run,
  which serves and never stores.
- **The store is bounded, but only between runs.** `ASMLIFT_CANDCACHE_MAX_MB` (default 4096)
  counts the distinct object bytes plus one allocation block per stored key — 77% of a warm store
  is negative entries, which weigh nothing logically and cost a block each. It is enforced ONCE per
  process, at the first namespace resolution and before any candidate compiles: whole namespaces no
  live process holds go first, then the oldest-written keys of the namespace this run is about to
  use. A namespace another process holds is never touched, so under `pnpm bench run`'s 8–16 shards
  the second shard onward prunes nothing. `rm -rf "$TMPDIR/asmlift-candcache"` is the reliable
  reset, and it is also how you make the next run cold on purpose.
- **`verify` audits the OUTCOME, not only the bytes.** A stored object whose TU no longer compiles,
  and a stored rejection whose TU now does, are both mismatches — the second is the one that
  silently drops a spelling from a row's fan, and it is 77% of what a warm store serves. Any
  mismatch is written to `MISMATCHES.log` in the store and fails the run with **exit 3**, on every
  path that can produce one: the ranked CLI's success return AND its decline/internal-error return,
  a `pnpm bench run` shard, and the orchestrator over those shards (which propagates 3 only when
  EVERY failed shard says cache — one shard that failed for its own reason is a run whose headline
  is that failure). `bench fidelity` is the exception by design: it pins the cache OFF for its
  ~1234 reproduction scripts, so nothing there can disagree.
  **3, not 1, and the distinction is the whole point:** a ranked run that does not MATCH exits 1
  already, so `1` carries no signal for the case this repo actually publishes — LoadBGTilemapData
  has been a nonmatch at 386 for twenty rounds, and a clean run and a poisoned run of it were
  measured exiting 1 with byte-identical `[ranked]` lines. Measured offline end to end, on one
  store: the audited run and the unaudited one print the same `[ranked]` line and the same stdout,
  and the unaudited one publishes the target's own bytes as a byte-exact **MATCH with exit 0**
  (`packages/cli/test/offline/candcache-sampling.test.ts`).
- **`on` MODE AUDITS ITSELF, and that is what licenses serving at all.** `bench regression` and
  `bench diff` compare OUTCOMES: a stale object is served identically on the base and on the head,
  so a cache defect makes BOTH GO GREEN. Neither gate is capable of catching one, so serving mode
  compiles a sampled fraction of the keys it serves anyway and runs them through the exact same
  two-direction comparison `verify` uses. Same counters, same `MISMATCHES.log`, same nonzero exit.
  - **The rate is 2%, and a five-rate measurement is what picked it.** Ten runs on ONE warm
    LoadBGTilemapData store (68,352 candidates, one box, one namespace, one bundle at
    `dae489e`), interleaved `0 25 0 10 0 5 0 2` so a drifting load cannot be read as a rate, then
    the same command with the cache off:

    | state               | wall        | loadavg (1 m, before) | `sampled` |
    | ------------------- | ----------- | --------------------- | --------- |
    | cache OFF           | **740.9 s** | 16.8                  | —         |
    | cache on, COLD fill | **711.2 s** | 28.3                  | —         |
    | warm, audit off     | 167.4 s     | 15.0                  | 0         |
    | warm, audit off     | 173.1 s     | 9.0                   | 0         |
    | warm, audit off     | 176.2 s     | 10.2                  | 0         |
    | warm, audit off     | 192.7 s     | 20.2                  | 0         |
    | **warm, 2%**        | **186.2 s** | 16.7                  | 1,394     |
    | warm, 5%            | 222.6 s     | 17.2                  | 3,477     |
    | warm, 10%           | 238.9 s     | 8.8                   | 6,977     |
    | warm, 25%           | 287.0 s     | 6.6                   | 17,137    |

    All ten printed `best …: 386`, the same 68,352 `[score]` lines (md5
    `3cd87d7623dd843fd791b9bdc86ea27b`) and the same stdout (md5
    `fd90209d88d7313cb7f5568186ef6e73`), each stamped `[asmlift source dae489e]`.

    **2% is the largest rate that lands inside the audit-off arms' OWN SPREAD** (167.4-192.7 s);
    5% is 30 s above the slowest of them, 10% is 46 s and 25% is 94 s above their mean. So the
    audit is NOT free as a function of rate, and an earlier round's "0%, 1% and 2% are not
    separable" was the flat part of a curve, not the curve: read off the separable arms the cost
    is 6-13 ms of wall per sampled compile, falling as the count rises because a warm run's six
    workers are otherwise idle. Speedup against cache-off: **4.18x** with the audit off, **3.98x**
    at 2% — **95% of it survives**, and every survival number below is halved against 1%.
    **Do not price the audit off the `[phase]` compile column.** It reads 273-306 s with the audit
    off and 633 s at 2%, 817 s at 5%, 926 s at 10% — 2.3x the worker time for a wall 5% longer.
    That column sums the queueing every hit does behind a busy worker; a "cost per sampled
    compile" derived from it is an artifact.
    **A wall here is ordinal, and the loadavgs say why**: another project's test suite ran at
    390% CPU on this box throughout, and the 1-minute loadavg before these arms swung between 6.6
    and 28.3. The interleave is what makes the comparison survive that; a single sequential pair
    would not.

  - **The seed is on the line and it rotates.** `[candcache] on sample=2%/seed=8cd2c1164ce2105d {…}`
    — an audited run is distinguishable from an unaudited one, and `sample=off` says so when
    someone turns it off. Sampling is deterministic within a run (so a run is reproducible) and
    picks DIFFERENT keys next run (so the rest of the store is eventually looked at, which
    hashing the key alone would never do). `ASMLIFT_CANDCACHE_SAMPLE_SEED=<seed>` replays a run's
    exact selection; `ASMLIFT_CANDCACHE_SAMPLE=<percent>` changes the rate (`0` turns it off).
  - **What it catches and how fast — PER CLASS, because the residuals are not one population.**
    The catch probability in one run is `1 - (1 - rate)^C` where C is the number of SERVED keys the
    staleness touches. At 2%: C = 700 is certain, C = 100 is 87%, C = 9 is 17%, C = 1 is 2%
    (mean 50 runs, 87% within 100). Most of the residuals listed above are "the namespace does
    not measure input X" where X is read by a whole CLASS — a directory, a wrapper's config, the
    runtime — and those are caught in the first run that serves a few hundred keys. **One is not:**
    a candidate's own assembler `.include`/`.incbin` is per-CANDIDATE, and the same list measures
    it at 0 of 68,352 on LoadBGTilemapData — the sparse regime, where the honest number is the
    50-run figure, not "the first run".
    **And the BENCH path is sparser than the ranked one, though the rate is the same.** One whole
    `pnpm bench run` serves ~60,800 answers and audits ~1,280 of them (2.1%), so a staleness
    confined to ONE ROW's keys (~9 objects on the agbcc real tier) is caught with probability 17%
    per bench run — a mean of about 6. The bench is where every published score comes from, so that
    is the number to quote for a row-local staleness, not the ranked fan's.
    Sampling does not ELIMINATE the residual list; it bounds how long one can live undetected.
  - **This fan prices only the OBJECT half, and the negative half is measured on the bench.** 0 of
    its 68,352 answers are cached rejections. The `pnpm bench run` behind the artifact as it stood
    when this was measured (948 rows, warm store, 16 shards) served **10,221 objects and 50,583
    rejections** — 83% negative — and audited **1,283 of them (2.11% of what it served): 210
    objects, 1,073 rejections, 0 disagreements**, with `sampled` reconciling exactly against the
    audits. A second full run the same day read 84% negative on the same measure, so treat it as
    "five sixths", not as a constant. That is the direction that silently DROPS a spelling, and it
    is only ever exercised by a bench run: sum the per-shard `[candcache]` lines, which is where a
    reader can check it too.
  - **A withholding accounts for itself, so `sampled` cannot overstate the audit.** `sampled`
    counts keys the cache WITHHELD, not comparisons it made: a withheld key whose compile dies
    without a verdict is never compared, because a transient must never be stored as a rejection.
    The counters therefore close:
    `sampled = verified + verifiedFail + mismatch + sampledStale + sampledAbandoned + sampledPending`
    — `sampledStale` a key a sibling shard pruned between the get and the put, `sampledAbandoned`
    a compile that produced no verdict, `sampledPending` still outstanding when the line was
    printed. Read `sampled` alone and a run that audited 400 keys can claim 700.
  - A sampled key is withheld, so its candidate is compiled for real — and is therefore exposed to
    a transient compile failure exactly as an uncached run is. That is the state every wall
    published before the default flipped was measured in, on 100% of keys instead of 2%. What
    that no longer costs is the CANDIDATE: when the compile of a withheld key produces neither an
    object nor a deterministic rejection, the withheld answer is handed back (`sampledAbandoned`),
    which is what an unaudited run would have been served. Sampling must never be worse than not
    sampling, and a warm run's exposure to a transient had been zero.
  - **`bench fidelity` runs its ~1234 reproduction scripts with `ASMLIFT_CANDCACHE=0`,
    deliberately.** That gate exists to prove a READER who copies a published script reproduces
    the published row, and that reader starts with an empty store. Inheriting the default would
    run the gate SERVED off the publishing machine's warm store — the base-versus-head asymmetry
    the audit exists to bound, in the one gate whose job is to be the reader.

## The flags are part of the number

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
  the box with a full `pnpm bench run`, read `wall 426.3s · compile 2175.1s · score 211.2s` —
  same 26880 candidates, same 0 dropped, same 395, same winner. Only the shares travel; re-time on
  your own log, and say what else the machine was doing.

  `idle+other` is the wall minus the work that HELD the main thread, which is not a fixed list of
  phases: at `--jobs 1` the compiles run on the main thread and come out of it, at `--jobs n` they
  are subprocess awaits and do not. So the residual means "waiting on subprocesses, plus whatever
  this clock does not name" in both, and the parts never sum past the wall.

- **`--proto`'s absence is now in the log.** Every run ends with an `asmlift: [proto]` line
  naming the callees whose arity it had to guess (nothing declared them: no `--proto` entry, no
  signature in `tools.asmlift.elf`). On the canonical LBG command that line is absent; without
  `--proto` it reads `1 callee(s) have no declared arity … thunk_HeapFree`, in the same stderr you
  are already pasting. Check the tail of your log before you quote a score.
- Quote the counts by pasting the **`asmlift: [ranked]` line**, the last thing every ranked run
  writes:

  ```
  asmlift: [ranked] 20608 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, best <label>: 531/<rows> [asmlift source 7362050]
  ```

  A score from a run that dropped candidates is not comparable to one that dropped none — and
  "0 dropped" is now something the run SAYS. It used to be spelled as an absent line, so a clean
  run, a truncated log and a killed run left identical evidence.

  `synthesized` counts the declarations asmlift wrote for the winning candidate because no symbol
  map knew the name — read out of the same asm the score is about, so they cannot lose score, only
  manufacture agreement. A non-zero count means the artifact is that declaration block plus the
  source; the block itself is printed on the `asmlift: [declared]` lines just above.

  **WITHHELD is a third count and a different fact.** `dropped` means the scorer refused a
  spelling; `withheld` means one compiled, scored, and was refused PUBLICATION because it is
  proof-gated (`Candidate.matchOnly` — a spelling whose semantics no gate over the C can settle, so
  only a byte-exact score licenses it). Without the count, `candidates scored` silently
  under-reports the fan. On the LBG command below it is 0, because `/unreduce` declines there.

  **The candidate COUNT belongs to the tree, not to the function.** Every axis admitted multiplies
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

**Every `[score]` line, and the `best …` on the `[ranked]` line, reads `<score>/<rows>`.** `rows`
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
