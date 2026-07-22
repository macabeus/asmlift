# Contributing to @asmlift/cli

This file covers how the package is organized and how it is tested.

## Code organization

`@asmlift/cli` wraps the pure pipeline ([`@asmlift/core`](../core/README.md)) with everything
that needs a real machine — process spawning, toolchains, Docker, the objdiff engine:

| Module                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`            | The `asmlift` bin: flags, input handling, config wiring, exit codes. `runCli` is exported (and async — scoring loads `objdiff-wasm` via dynamic import so plain decompiles stay light)                                                                                                                                                                                                                                                                                           |
| `src/config.ts`          | `decomp.yaml` (decomp_settings) loader + target resolution with a decision trace; ambiguity declines, never guesses                                                                                                                                                                                                                                                                                                                                                              |
| `src/compile-command.ts` | `compileFromCommand`: turns a `{{inputPath}}`/`{{outputPath}}`/`{{symbol}}` template into a `CandidateCompiler`. Raw-but-shell-safe substitution (the injection guard lives here); free of score/objdiff imports so it stays offline-testable                                                                                                                                                                                                                                    |
| `src/objfile.ts`         | ELF `.o` input: sniff, disassemble with the target family's objdump (PATH/env/config-resolved — no Docker, no compiler paths), extract the jump-table side-table. Deliberately separate from score.ts so the bin never loads the wasm                                                                                                                                                                                                                                            |
| `src/score.ts`           | The scoring SEAM only: the empty-by-default candidate-compiler registry (`registerCandidateCompiler`), the target-dispatched `scoreSource`, and `NoCandidateCompilerError` (a setup error that propagates even through annotate mode). Fail-closed: an unparseable object, missing symbol, or engine error throws — a false "match" is the one defect this package can never emit. The pinned toolchain implementations live in [`@asmlift/toolchains`](../toolchains/README.md) |
| `src/objdiff.ts`         | The community `objdiff` engine in-process (pinned `objdiff-wasm`); asmlift never hand-rolls a diff                                                                                                                                                                                                                                                                                                                                                                               |
| `src/rank.ts`            | `decompileRanked` — candidates from `@asmlift/core/rank`, scored for real and ranked: types are differ-ranked levers, not guesses                                                                                                                                                                                                                                                                                                                                                |
| `src/report.ts`          | `decompileWithReport` — the core `TraceReport` enriched with scores, per-pattern deltas, ranked candidates                                                                                                                                                                                                                                                                                                                                                                       |

The `mwcc_242_81` Docker image (`asmlift-ppc:latest`) is built from
[`packages/toolchains/ppc-docker/Dockerfile`](../toolchains/ppc-docker/Dockerfile) — 32-bit wibo + PowerPC
objdump; the proprietary CodeWarrior dir is bind-mounted at run time, never baked in.

## The pinned toolchains

They live in the private [`@asmlift/toolchains`](../toolchains/README.md) workspace package —
compile+score implementations, Docker pool, env vars, the `asmlift-ppc` image. They serve the
benchmark and the matching suite and register themselves with this package's registry on
import; the CLI never uses them (`--score-against` requires the project's own `compiler`
command). Publish gate: `@asmlift/toolchains` may appear ONLY under `devDependencies` here —
in `dependencies` the published package would be uninstallable.

## Tests

Two directories with two contracts:

| Directory        | Contract                                                                                                                                                                                                                            | Needs                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `test/offline/`  | The Node-side surfaces that run WITHOUT a toolchain: the objdiff scoring seam (committed `.o` fixtures), the CLI surface, config/compile-command handling, the report's annotate degradation. Runs on hosted CI via `test:offline`. | nothing                                     |
| `test/matching/` | The **matching suite**: decompile → recompile with the REAL toolchain → objdiff score. Proves byte-exactness, the one thing no offline test can.                                                                                    | agbcc + IDO native, Docker for KMC-GCC/mwcc |

The split is enforced: `packages/core/test/offline-list.test.ts` fails when an `offline/` suite
imports a compile/score helper or a `matching/` suite doesn't (the latter would be offline-safe
coverage hosted CI silently never runs).

### Matching suite ≠ benchmark

[`apps/benchmark`](../../apps/benchmark/README.md) runs the same compile→decompile→score loop
over the full function×toolchain dataset. A simple positive case ("this C should match") duplicates a
benchmark case — so **new positive coverage defaults to a benchmark case**, which also scores m2c
and feeds the report. Add a matching test only when you need something the benchmark doesn't give:

- a **gate** — the suite is red on every `pnpm test`; the benchmark is a scoreboard a human
  reads after a run;
- a **golden source pin** (`expectSource`) — catches output-text drift even while still matching;
- an **intermediate assertion** — IR shape, pattern-hit counts, ranked-candidate order,
  a specific loud-fail decline;
- a **regression repro** — an input distilled from a bug that must break the build if it returns.

Keep the suite lean. It is a gate, not a coverage farm; breadth lives in the benchmark.

### Where a new matching test goes

Simple end-to-end case (reference C → golden source → score) → **one fixture entry in
`test/matching/fixtures.ts`**; the registry runner (`test/matching/regression.test.ts`) picks it up:

```ts
{
  symbol: "myfn",
  referenceC: "int myfn(int x){ ... }",   // compiled by the toolchain → both target + input
  toolchain: "ido",                       // "agbcc" (default) | "ido" | "mwcc" (Docker-gated)
  patterns: [SOME_PATTERN],               // omit = default idiom bundle (the benchmark path);
                                          //   [] pins the naive no-idiom baseline
  prototypes: {                           // optional: header facts, keyed by symbol
    g: { params: 1 },                     //   a callee's arg count (drives `bl` recovery)
    myfn: { params: 1, returnsVoid: true }, // the fixture's own void-ness
  },
  expectPatternHits: 1,                   // optional
  expectSource: "s32 myfn(...) {\n...\n}\n", // optional golden C, asserted byte-for-byte
  expectMatch: false, expectScore: 3,     // optional: pin a known near-miss instead of a match
  note: "what this covers",
}
```

`expectSource` goldens come from a real run, never hand-written — a throwaway script that prints
`JSON.stringify(decompile(...).source)`. When a deliberate improvement changes the output,
re-capture; never loosen the assertion to hide a real regression. Toolchain paths resolve in
`@asmlift/toolchains` (`packages/toolchains/src/toolchain.ts`); scoring is the pinned
`objdiff-wasm` package.

A dedicated file is for suites the registry can't express: A/B comparisons (`m2`), ranked
candidates (`m3`), seam proofs (`m4`), report shape (`m5`), multi-case feature narratives
(`switch-p*`, `mips-*`, `ppc-*`), and invariant/soundness suites (`structure-soundness`,
`contracts`, `audit-regression`).

Offline-safe pipeline tests (no toolchain in the loop) belong in `packages/core/test`, not here.
