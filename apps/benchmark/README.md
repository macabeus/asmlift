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

The `declined` label is symmetric: capability gaps on both sides. Functions whose context-free
m2c run declined on `?` placeholders **receive their context**: synthetic functions carry the
prototype in the dataset (`ctx` — mirroring the `proto` hints asmlift gets), and real functions
are flagged `m2cCtx` in their manifest, which feeds m2c the project's own vendored context
(GCC attributes stripped for m2c's C parser; the row publishes the file as `ctxRef`), plus the
function's own prototype. The boundary is firm: contexts contain exactly what the project
declares — **never authored types** (where a project types a global as a raw byte arena, an
invented struct would copy the answer out of the reference source). Remaining
m2c declines are genuine modeling gaps (carry flags, unknown instructions) that context cannot
fix — same class as asmlift's declines (the decline-reason Pareto in Gap Analysis is the
roadmap).

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

| id          | ISA / compiler                     | asm both decompilers read                   |
| ----------- | ---------------------------------- | ------------------------------------------- |
| `agbcc-arm` | agbcc / ARM (GBA)                  | agbcc `.s` (shared by both — ARM is free)   |
| `ido-mips`  | IDO / MIPS (N64)                   | `objdump -d` → normalized to GNU-as for m2c |
| `gcc-mips`  | KMC GCC / MIPS (N64, Docker)       | `objdump -d` → normalized for m2c           |
| `mwcc-ppc`  | CodeWarrior / PowerPC (GC, Docker) | `objdump -d` → normalized for m2c           |

asmlift's MIPS/PPC frontends consume `objdump`; m2c wants GNU-as text, so `src/eval/m2c-normalizer.ts`
normalizes objdump -> GNU-as (faithful: same instructions/order, resyntaxed). ARM needs no
normalization (both read agbcc's `.s`).

## Important framing: context

By default both decompilers get function prototypes (arities / void-ness / callee signatures) but
**no struct or global type layouts** — isolating _raw recovery from assembly_, asmlift's design
target. The one exception is described above: real functions whose m2c run declines purely for
missing context receive the project's own headers via `--context`. m2c's normal in-project
workflow supplies that full context on **every** function, which would raise its readability and
compile rate on type-heavy code across the board; that is a different experiment. The report
states this caveat prominently.

## Dataset

- **Synthetic tier** (`--tier synthetic`) — `dataset/synthetic.ts`: authored C functions spanning common features
  (arithmetic, bitwise, compare/logic, width casts, memory, structs, arrays, loops, calls, nested
  control), each run on its assigned toolchains: ~124 functions → 483 cases.
- **Real tier** (`--tier real`) — `dataset/real/*.json`: real matched functions extracted **verbatim** from five decomp projects (kleod, pokeemerald, sa3, af, snowboardkids2), compiled standalone
  with asmlift's canonical toolchain flags using each project's headers as context: 130 cases
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
cd apps/web && pnpm run build         # the site (the Benchmark view renders results.json)
```

### Caching (what a number means)

Results are cached in `apps/benchmark/.cache/` keyed by CONTENT (the case + the decompiler build
inputs), so a warm re-run only recomputes what changed. `ASMLIFT_BENCH_CACHE=0` bypasses the
cache entirely — use it for A/B runs where you need every case recomputed from scratch (the cache
key derivation is in `src/cache.ts`; the m2c side fails closed on a dirty m2c checkout).
`ASMLIFT_DOCKER_POOL=0` disables the persistent container pool (the docker-cost A/B switch, see
`packages/toolchains/src/compile.ts`).

### Environment

Harness path defaults live in `src/config.ts`, following the sibling-checkout WORKSPACE
convention: `ASMLIFT_M2C_DIR` overrides the m2c checkout; `ASMLIFT_CPP` names the GNU cpp used
for real-tier preprocessing (Apple's `/usr/bin/cpp` ignores `-o`). Real-tier manifests carry NO machine paths — each project resolves as
`WORKSPACE/<repoDir>`, overridable per project via `ASMLIFT_PROJ_<PROJECT>`; projects missing on
this machine are skipped with one aggregated warning.

## Harness layout (`src/`)

| module             | role                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli.ts`           | THE entry point: one argv parser, subcommand dispatch                                                                                                                           |
| `config.ts`        | ALL env/path resolution (m2c, cpp, WORKSPACE)                                                                                                                                   |
| `cases/`           | the `Case` abstraction + both tier providers (`synthetic.ts`, `real.ts`) + manifest loader/validation                                                                           |
| `compile/`         | one module per toolchain — real-tier build + candidate steps shared (candidate-compile commands live in `dataset/toolchains/`)                                                  |
| `eval/`            | `evaluate.ts` (both decompilers on one case), `asmlift.ts`, `m2c.ts`, `m2c-normalizer.ts` (objdump-to-GNU-as normalizer), `outcome.ts` (the symmetric classifier), `quality.ts` |
| `run/`             | `runner.ts` (the ONE case loop), `orchestrate.ts` (spawns the shards, merges their partial results), `fidelity.ts` (the script-fidelity gate), `smoke.ts`, `verify.ts`          |
| `report/`          | `merge.ts` (pure: tiers -> results.json), `gap-size.ts`, `repro-scripts.ts` (the embedded per-row scripts), `stale-check.ts`, `publish.ts` (the named cross-app step)           |
| `toolchains.ts`    | 4 toolchain adapters over `@asmlift/toolchains` (`buildTarget` + `score`)                                                                                                       |
| `decomp-config.ts` | candidate compilation through the real `decomp.yaml` user path                                                                                                                  |
| `cache.ts`         | content-keyed result cache (tmp-then-rename; m2c dirty-checkout fail-closed; versioned key)                                                                                     |

The result schema is `@asmlift/bench-schema` (types-only workspace package) — the ONE definition
this harness produces and the web Benchmark view consumes. The harness's own toolchain-free tests
live in `test/` and run in CI.

## Extending

- **Add a synthetic function**: one entry in `dataset/synthetic.ts` (each entry is one function, run on its assigned toolchains).
- **Add real functions**: write `dataset/real/<project>.json` (schema + validation in
  `src/cases/manifests.ts`; `repoDir` is a workspace-relative checkout name — no machine paths,
  enforced by `test/real-manifests.test.ts`) and iterate with `pnpm bench verify <manifest>`
  until they compile; then `pnpm bench run` + `pnpm bench:merge`.
- **Add a toolchain**: an adapter in `toolchains.ts` + a `compile/<name>.ts` module for the real
  tier (or a typed `null` while unwired — see `compile/mwcc.ts`).
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
