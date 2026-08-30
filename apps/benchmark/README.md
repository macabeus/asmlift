# asmlift benchmark — m2c vs asmlift decompilation quality

A reproducible, **extensible** benchmark comparing the decompilation quality of
[`m2c`](https://github.com/matt-kempster/m2c) and asmlift over the four toolchains asmlift supports, scored with the same
`objdiff` engine asmlift uses. Built to become a **live QA pipeline**: re-run it as asmlift evolves
and watch match/compile/error rates move.

## What it measures

For every `(function × toolchain)` case it runs BOTH decompilers and records, per decompiler —
**one classifier, applied identically to both columns** (`src/eval/outcome.ts`):

> **Vocabulary.** A **case** is the measurement unit: one function on one toolchain (one function
> can appear as several cases); after a run, each case is one **row** in `results.json` — the two
> words name the same thing before and after measurement. A **tier** is a dataset half: synthetic
> (authored probes) vs real (verbatim decomp-project functions). A **candidate** is one compilable
> source a decompiler emits for a case (asmlift may emit several and rank them); the **target
> object** (or reference object) is the compiled reference C the candidate is byte-compared
> against — distinct from the `--target` toolchain ID. **Match** = compiles AND objdiff score 0 =
> **byte-exact**: three spellings of one predicate. **Gap size** is the measured objdiff distance
> of the best compiling candidate on a non-matching case. **Provenance** (`meta.asmlift`) records
> which asmlift commit produced the numbers, and whether the tree was dirty.

| outcome      | meaning                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `match`      | output compiles **and** objdiff score is 0 (byte-exact)                                                                                                                                                                              |
| `nonmatch`   | output compiles but score > 0 (with the objdiff difference count)                                                                                                                                                                    |
| `declined`   | output bears explicit incompleteness markers — asmlift's `ASMLIFT_ERROR`; m2c's `M2C_ERROR`/`M2C_UNK`/`M2C_CARRY`/`?` type placeholders. Deliberately uncompilable, never scored (a marker compiled out could byte-match wrong code) |
| `noncompile` | marker-free output that claims completeness but fails to compile — the case's record keeps the source AND the compiler's diagnostics                                                                                                 |
| `failed`     | no usable output at all (crash, `Function not found`, empty)                                                                                                                                                                         |

plus a transparent **readability heuristic** (`quality`), a measured **gap size** for
non-matching rows.

The `declined` label is symmetric: capability gaps on both sides. Every real row **receives its
context**: 246 rows are flagged `m2cCtx` in their manifest, which feeds m2c that row's vendored
project context verbatim (the row publishes the file as `ctxRef`); six kleod rows instead carry a
hand-written `ctx` naming callees the project's headers do not declare, held symmetric with the
`proto` hints asmlift gets by `test/authored-facts.test.ts`. Synthetic rows carry the prototype in
the dataset (`ctx` — mirroring `proto`) and nothing else. The boundary is firm: a real context is
what that translation unit preprocesses to, **never an invented type** (where a project types a
global as a raw byte arena, a made-up struct would copy the answer out of the reference source),
and the row's own signature is not pasted into it out of `funcC` — the one channel by which it
still arrives on 8 rows is residual 4 below, disclosed and measured. Remaining m2c declines
are genuine modeling gaps — carry flags, unknown instructions, and callees the project itself
never declares — that context cannot fix; same class as asmlift's declines (the decline-reason
Pareto in Gap Analysis is the roadmap).

## Toolchains (the four `--target` IDs)

All four are live via asmlift's own scoring seam (`packages/cli/src/score.ts`), reused here so the benchmark
measures the exact compilers asmlift is tested against. Candidate compilation runs THROUGH the
same `decomp.yaml` path a real project uses (`src/decomp-config.ts`): the configs are COMMITTED
as live documentation — `dataset/toolchains/<id>/decomp.yaml`, one per toolchain, with machine
locations as `$ASMLIFT_*` placeholders (the same names `@asmlift/toolchains` honors as env
overrides). The harness materializes them into the gitignored `.cache/decomp-configs/` and loads
them with the real loader — the native pair (agbcc, IDO) keeps its `tools.asmlift.compiler`
command mirroring the built-in invocation (parity enforced by `test/decomp-config.test.ts`),
while for the dockerized pair (KMC GCC, mwcc) the harness strips the compiler so the registry
built-ins (with container pooling) serve it, the same either/or a user gets. The reproduction
scripts (`bench target`) get the command intact on every toolchain:

| id            | ISA / compiler                     | asm both decompilers read                   |
| ------------- | ---------------------------------- | ------------------------------------------- |
| `agbcc`       | agbcc / ARM (GBA)                  | agbcc `.s` (shared by both — ARM is free)   |
| `ido7.1`      | IDO / MIPS (N64)                   | `objdump -d` → normalized to GNU-as for m2c |
| `gcc2.7.2kmc` | KMC GCC / MIPS (N64, Docker)       | `objdump -d` → normalized for m2c           |
| `mwcc_242_81` | CodeWarrior / PowerPC (GC, Docker) | `objdump -d` → normalized for m2c           |

asmlift's MIPS/PPC frontends consume `objdump`; m2c wants GNU-as text, so `src/eval/m2c-normalizer.ts`
normalizes objdump -> GNU-as (faithful: same instructions/order, resyntaxed). ARM needs no
normalization (both read agbcc's `.s`).

## Important framing: context

The two tiers ask different questions, and they give the decompilers different things.

**Synthetic tier — cold recovery, symmetric by construction.** Both decompilers get the function's
declared signature and nothing else: no struct layouts, no global types. m2c gets it as a `ctx`
header, asmlift gets the same facts as `proto` hints, and `test/authored-facts.test.ts` holds the
two lists equal. This is the half that isolates _raw recovery from assembly_.

**Real tier — recovery with the project in hand, on both sides.** Here withholding project types
would not be neutral, because asmlift is handed the project's vendored **symbol map** on every
real row, and that map is not name-and-address: sizes, declaration shapes, signedness, array
extents, volatility, const-ness, address-cast macro bodies, and, where the vendoring found them,
callee signatures and struct tags with full field tables. So m2c is given the matching thing —
that row's own vendored preprocessed context, verbatim, via `--context` — on every real row.

**The row's own signature is no longer pasted into m2c's context out of the reference source.**
That is the harness's own leakage rule (core's `asIfUndecompiled`: "only CALLEE signatures
transfer"), and it now applies to both halves — with residual 4 as the one measured exception. The row's own declaration reaches m2c only where the context already
carries it (39 rows: 31 declared by the project's headers, as a user mid-decomp genuinely has, and
8 by the forward declaration the manifest needs to compile the reference standalone — residual 4)
or as the one line `proto` also gives asmlift (`m2cOwnPrototype`, at most `void f(…);`, 84 rows).
The remaining 123 rows get nothing appended, and m2c infers the signature as asmlift does.

It is **not exact parity**, and pretending otherwise would be the same defect with the sign
flipped. The residuals run in both directions; none is closed here, because closing any of them
changes what asmlift is given or re-vendors the blobs both tools compile against, and this change
moves no asmlift row.

_Favouring m2c._

1. **Struct field tables.** `layout` is a vendoring product and only pokeemerald carries it in
   bulk (2179 of 41016 entries; af 26 of 61860, kleod 25, sa3 8, marioparty3 7, snowboardkids2 5).
   Where m2c's context declares a record the map only sizes, m2c has field names asmlift must
   invent — `sa3:gSio32MultiLoadArea` is `{kind: data, size: 24}` in the map and
   `.state/.frameCounter/.type/.datap` in the context.
2. **Callee prototypes.** m2c reads them out of the headers; asmlift's channel is the map's
   `signature` field, which the vendoring extracts for kleod and pokeemerald only — af,
   marioparty3, sa3 and snowboardkids2 vendor **zero**.
3. **`prependC` types.** A manifest's per-function `prependC` already feeds BOTH tools' compile,
   and m2c can READ it, so where it declares a struct type for a project static table
   (`pokeemerald:sBigMonSizeTable`) m2c learns field names the map gives only an element size for.
4. **`prependC` forward declarations.** On 8 rows (7 kleod, `pokeemerald:AcroBikeHandleInputTurning`)
   the declaration the reference needs to compile standalone IS the row's own signature, and it is
   the only declaration of it in that context — the one place a signature fact still reaches m2c
   and not asmlift. Measured by deleting the line and re-running m2c: 3 of the 8 change output
   (`ConfigureEntityBehavior`, `IsSelectButtonPressed`, `AcroBikeHandleInputTurning`), none is a
   match either way. Not closed because closing it means re-vendoring the blob asmlift's candidate
   scorer also compiles against. Named by `test/authored-facts.test.ts`.

_Favouring asmlift._

5. **Scope.** The symbol map is whole-project and every row gets all of it; a context is one
   translation unit, so a fact another TU's headers declare reaches asmlift and not m2c.
6. **Named callees.** Four callees are named to asmlift through `proto` and are absent from the
   row's context, all on `sa3:sub_8001FD4` (`ValidateSave`, `PackSaveSector`, `WriteSaveSector`,
   `sub_8001A90`).
7. **Non-void rows.** On the 6 rows whose `proto` says the function is non-void and whose context
   does not declare it, asmlift is told that — and on 3 of them a parameter list as well
   (`af:mPl_SceneNo2SoundRoomType` `["s32"]`, `pokeemerald:GetAnchorCoord` `["s32","s32","s32"]`,
   `sa3:sub_8001FD4` `[]`, i.e. arity 0) — while m2c is told nothing: `proto` carries no return
   type to state, and inventing one would not be parity.

**A context is not one uniform thing**, and the repro scripts say so per row rather than
generalising. It is whatever that TU preprocesses to: af's manifest has `headers: []` — its
headers do not survive a host `cpp` — so an af row's entire context is that row's own `prependC`,
17 to 603 bytes of typedefs, while marioparty3's is ~168 KB of real header tree and one
pokeemerald row's is 410 KB. GCC attributes are **not** stripped: m2c's parser reads them, and
deleting `__attribute__((packed))` silently repadded the project's own structs.

## Dataset

- **Synthetic tier** (`--tier synthetic`) — `dataset/synthetic.ts`: authored C functions spanning common features
  (arithmetic, bitwise, compare/logic, width casts, memory, structs, arrays, loops, calls, nested
  control), each run on its assigned toolchains: 215 functions → 671 cases.
- **Real tier** (`--tier real`) — `dataset/real/*.json`: real matched functions extracted **verbatim** from six decomp projects (af, kleod, marioparty3, pokeemerald, sa3, snowboardkids2), compiled standalone
  with asmlift's canonical toolchain flags using each project's headers as context: 252 cases
  (one toolchain each). Real game-code shapes, for anti-overfitting. (melee/mwcc_233 is excluded: its compiler version differs
  from asmlift's mwcc_242, so byte-match is not defined there.)

Reference objects — the byte-exact goal each case is scored against — are built by compiling the reference C with asmlift's toolchain (not the shipped ROM object)
— so "match" means "reproduces our deterministic re-compile of real code", the right question for a
decompiler, and asmlift's frontend (calibrated to those exact flags) is applicable.

## Running

ONE entry point — `src/cli.ts` (`pnpm bench <subcommand>`). Before results publish to
apps/web, the **script-fidelity gate** (`pnpm bench fidelity`) re-executes both reproduction
scripts for every function and fails the pipeline on any undocumented divergence from its
measured row (asmlift divergences in the classes the scripts themselves document as approximate
— real-tier scoring context, prototype hints — print as warns, never silently) — what users
copy is what the gate ran. The default `run` is the parallel
orchestrator (the case list split across parallel child processes — 'shards' — + Docker container pool + content-keyed caches, see Caching below; a full cold
run in ~2 min, a warm re-run in ~40 s):

```bash
pnpm bench run                        # both tiers -> results/{synthetic,real}.json (intermediates)
pnpm bench run --tier synthetic --only divc      # targeted subset
pnpm bench run --serial               # in-process, for debugging (also how shard children run)
pnpm bench:merge                      # = bench merge: tiers -> results/results.json, then publish
pnpm bench publish                    # re-stage results.json into the web app alone
pnpm bench:smoke                      # one trivial fn through every available toolchain
pnpm bench verify apps/benchmark/dataset/real/<p>.json   # compile-check loop for manifests
pnpm bench regression --base origin/main   # gate: exit 1 on any lost match or vanished row
pnpm bench diff --base origin/main         # gate: exit 1 if ANY compared field moved, row by row
                                           #   exit 2 if results.json was never regenerated: it is
                                           #   committed, so an unrun gate compares the base with
                                           #   ITSELF and prints a green line having measured nothing
cd apps/web && pnpm run build         # the site (the Benchmark view renders results.json)
```

### Caching (what a number means)

Results are cached in `apps/benchmark/.cache/` keyed by CONTENT (the case + the decompiler build
inputs), so a warm re-run only recomputes what changed. `ASMLIFT_BENCH_CACHE=0` bypasses the
cache entirely — use it for A/B runs where you need every case recomputed from scratch (the cache
key derivation is in `src/cache.ts`; the m2c side fails closed on a dirty m2c checkout).
`ASMLIFT_DOCKER_POOL=0` disables the persistent container pool (the docker-cost A/B switch, see
`packages/toolchains/src/compile.ts`).

A SECOND cache sits a level below that one and is **off by default**: `ASMLIFT_CANDCACHE=1` serves
the candidate objects a previous run of the same toolchain already compiled
(`packages/cli/src/candcache.ts`). It changes no result — the same rows, the same scores — and on a
compile-dominated run it is the difference between minutes and tens of minutes, so it is worth
turning on for the base-run/lever-run pair inside one round and for the gate ladder's repeats. It
is not a historical archive: hit rate decays as the axes accumulate. `ASMLIFT_CANDCACHE=verify`
compiles everything anyway and audits the store against it, failing the run on any disagreement,
and `ASMLIFT_BENCH_CACHE=0` bypasses this cache too. The flag table, the cold-vs-warm rule and what
a project must declare before the cache runs on its own `decomp.yaml` are in `docs/ranked-repro.md`.

### Environment

Harness path defaults live in `src/config.ts`, following the sibling-checkout WORKSPACE
convention: `ASMLIFT_M2C_DIR` overrides the m2c checkout; `ASMLIFT_CPP` names the GNU cpp used
for real-tier preprocessing (Apple's `/usr/bin/cpp` ignores `-o`). Real-tier manifests carry NO
machine paths — each project's checkout resolves in order: `ASMLIFT_PROJ_<PROJECT>` env override

> bench-owned checkout (`apps/benchmark/checkouts/<repoDir>`, materialized by `pnpm bench
setup`) > sibling `WORKSPACE/<repoDir>`; projects missing on this machine are skipped with one
> aggregated warning.

### Bench-owned checkouts (`pnpm bench setup [--build]`)

`bench setup` materializes a HARNESS-OWNED workspace under the gitignored
`apps/benchmark/checkouts/`: every real-tier fork is cloned at its pinned branch (submodules
included; ssh submodule URLs are rewritten to https), baseroms are copied in from the sibling
user checkout when present, and each project's preparation recipe runs
(`src/cases/project-setup.ts`: agbcc builds, venvs, splat splits, generated sources).
`--build` then runs every project's full build through its own byte-compare gate (plus its
`elfMake` symbol-ELF target). These clones are disposable and freely mutated by the harness;
NON-bench-owned checkouts (env override or sibling WORKSPACE) are only ever reported — setup
never mutates them.

Host prerequisites (macOS; verified empirically):

- Xcode CLT (`/usr/bin/cc` — host tools build with `/usr/bin` ahead of homebrew, several
  projects' host tools miscompile under homebrew gcc), plus homebrew `gmake`, `wget`, `libpng`
- an `arm-none-eabi` toolchain on PATH (GBA projects: pokeemerald, sa3, kleod)
- python >= 3.11 first on PATH for kleod's `setup.sh`; any python3 for the others
- big-endian `mips-linux-gnu` binutils under `/opt/cross` (af), and Rosetta
  (`softwareupdate --install-rosetta` — af's IDO recomp and marioparty3's KMC gcc are x86_64)
- Docker (snowboardkids2 builds inside a linux/amd64 container; the `asmlift-elf` DWARF
  sidecar targets also fall back to Docker when no host `mips-linux-gnu-gcc` exists)
- baseroms: setup copies them from the sibling user checkouts when found; otherwise place them
  manually (the status table names the missing file and destination)

## Harness layout (`src/`)

| module             | role                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`           | THE entry point: one argv parser, subcommand dispatch                                                                                                                           |
| `config.ts`        | ALL env/path resolution (m2c, cpp, WORKSPACE)                                                                                                                                   |
| `cases/`           | the `Case` abstraction + both tier providers (`synthetic.ts`, `real.ts`) + manifest loader/validation                                                                           |
| `compile/`         | one module per toolchain — real-tier build + candidate steps shared (candidate-compile commands live in `dataset/toolchains/`)                                                  |
| `eval/`            | `evaluate.ts` (both decompilers on one case), `asmlift.ts`, `m2c.ts`, `m2c-normalizer.ts` (objdump-to-GNU-as normalizer), `outcome.ts` (the symmetric classifier), `quality.ts` |
| `run/`             | `runner.ts` (the ONE case loop), `orchestrate.ts` (spawns the shards, merges their partial results), `fidelity.ts` (the script-fidelity gate), `smoke.ts`, `verify.ts`          |
| `report/`          | `merge.ts` (pure: tiers -> results.json), `gap-size.ts`, `repro-scripts.ts`, the three gates (`stale-check`/`regression`/`diff`) over `committed.ts`, `publish.ts`              |
| `toolchains.ts`    | 4 toolchain adapters over `@asmlift/toolchains` (`buildTarget` + `score`)                                                                                                       |
| `decomp-config.ts` | candidate compilation through the real `decomp.yaml` user path                                                                                                                  |
| `cache.ts`         | content-keyed result cache (tmp-then-rename; m2c dirty-checkout fail-closed; versioned key)                                                                                     |

The result schema is [`@asmlift/bench-schema`](../../packages/bench-schema/README.md) — the ONE
definition this harness produces and the web Benchmark view consumes, including the closed feature
vocabulary every row's `features` is drawn from. The harness's own toolchain-free tests live in
`test/` and run in CI.

## Extending

- **Add a synthetic function**: one entry in `dataset/synthetic.ts` (each entry is one function, run on its assigned toolchains).
- **Add real functions**: write `dataset/real/<project>.json` (schema + validation in
  `src/cases/manifests.ts`; `repoDir` is a workspace-relative checkout name — no machine paths,
  enforced by `test/real-manifests.test.ts`) and iterate with `pnpm bench verify <manifest>`
  until they compile; then `pnpm bench run` + `pnpm bench:merge`.
- **Add a toolchain**: an adapter in `toolchains.ts` + a `compile/<name>.ts` module for the real
  tier (or a typed `null` while unwired — see `compile/mwcc.ts`).
- **Tag a function**: list only judgement tags (`memory`, `struct`, …) — the source- and
  codegen-evidenced ones are derived per row. See
  [`@asmlift/bench-schema`](../../packages/bench-schema/README.md).
- Re-run and re-merge; the Benchmark view re-renders from the committed `results.json`.

## Committed artifacts

`results/results.json` (pretty-printed so refresh diffs review case-by-case) plus
`apps/web/src/pages/benchmark/data/results.json`, and
`apps/web/src/data/summary.json` are committed; the per-tier `synthetic.json`/`real.json` are
gitignored intermediates. Provenance in `meta.asmlift` records the commit + a dirty flag that
ignores these artifact paths themselves; the summary-results consistency test (apps/web) fails
CI if the copies desynchronize or a dirty run is committed. Error markers scrub scratch paths to
`<tmp>/`, so warm-cache re-runs of unchanged cases are byte-identical (a cleared cache re-mints
scratch names inside `targetAsm`).
