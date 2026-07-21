# @asmlift/core

The asmlift decompile pipeline as a pure library: one function's **assembly text in, C / C++ /
Pascal source out**, built to recompile **byte-identical** to the original object — the
generator role m2c plays in the console-decompilation workflow. Three ISA frontends
(ARMv4T/Thumb, MIPS, PowerPC), three language backends over one neutral AST; C and Pascal are
drop-in backends, C++ is a deliberately scoped per-function factory (see the `backend` option).

The package is **browser-pure by enforced contract**: zero dependencies, no Node or DOM APIs —
it bundles unchanged into the playground webapp (`apps/web` in the repo). The contract is gated
twice: `test/browser-safe.test.ts` (import scanning) and a dedicated `tsc -p packages/core`
project with `types: []`.

The operative invariant everywhere: **loud decline > silent miscompile**. Where the pipeline
cannot be byte-faithful it throws a typed error (strict mode) or emits an `ASMLIFT_ERROR`-marked
stub (`onGap: "annotate"`) — never plausible wrong code.

> Not yet published to npm. Inside this repo it resolves via the pnpm workspace.

## Usage

```ts
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_IDO } from '@asmlift/core/target';

const asm = `...output of: mips-linux-gnu-objdump -d --no-show-raw-insn fn.o ...`;
const { source, diagnostics } = decompile('my_func', asm, MIPS_IDO);
console.log(source); // s32 my_func(s32 a0) { ... }
```

Input is **text**, following what each target's toolchain produces:

- The ARM target reads GBA `.s`, produced by agbcc and pret-style project splits.
- The MIPS/PPC targets read `objdump -d --no-show-raw-insn` output and Splat-disassembled `.s`.

### `decompile(name, asm, target, opts?)`

| Option       | Meaning                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`    | `cBackend` (default) or `pascalBackend` — values from `@asmlift/core/backend/*`. C++ is `cppBackend(spec)`, a per-function factory: it takes a `CppFnSpec` (class/method name, explicit param types, class field layouts — what a project's headers supply) and covers free and non-virtual member functions with word-sized fields; virtual dispatch, references, ctors/dtors decline |
| `patterns`   | Idiom rewrite patterns. Omitted = `DEFAULT_IDIOM_PATTERNS` (each gated per compiler); `[]` = none                                                                                                                                                                                                                                                                                      |
| `prototypes` | Callee arities + void-ness, as a real project takes them from headers — drives call-argument recovery                                                                                                                                                                                                                                                                                  |
| `asmData`    | Optional `objdump -s -r -t` side-table; required to recover MIPS/PPC jump-table switches                                                                                                                                                                                                                                                                                               |
| `onGap`      | `"strict"` (default): throw on any gap. `"annotate"`: emit best-effort source with `ASMLIFT_ERROR` markers; every gap is also returned in the structured `diagnostics` array (empty ⇔ gap-free)                                                                                                                                                                                        |

Targets: `ARMV4T_AGBCC`, `MIPS_IDO`, `MIPS_GCC`, `PPC_MWCC` (`@asmlift/core/target`).

### Other entry points

- `decompileTraced` (`@asmlift/core/trace`) — same tower, returns a `TraceReport`: per-stage IR
  dumps + pattern before/after events. This is what the playground's Pipeline tab renders.
- `detectName` (`@asmlift/core/detect`) — best-effort symbol detection for pasted asm.
- Typed decline errors: `FrontendUnsupportedError`, `RaiseUnsupportedError`, `StructureError`,
  `ContractError`, `VerifyError` — a principled decline is distinguishable from a bug.

Everything under `src/` is importable as `@asmlift/core/<path>` (e.g.
`@asmlift/core/pattern/engine`); `@asmlift/core` alone resolves to the pipeline.

## Architecture

Three ISA frontends (ARMv4T/Thumb, MIPS, PowerPC), four compilers (agbcc, IDO, KMC GCC,
CodeWarrior), three language backends over one neutral AST — all scored across the package seam
by [`@asmlift/cli`](../cli/README.md) with the community `objdiff` engine (in-process, pinned
`objdiff-wasm`; asmlift never hand-rolls a diff).

### The pipeline (`decompile()` in `pipeline.ts`)

```
asm ─▶ lift ─▶ idiom fold ─▶ pre-recovery ─▶ type recovery ─▶ retsink ─▶ structure ─▶ emit
       (L1)     (patterns)    (recognizers)     (L2)                        (L3)      (C/C++/Pascal)
                                       └────▶ ranked candidates ─▶ objdiff ─▶ score (@asmlift/cli rank.ts)
```

The stage sequence is ONE shared spine (`applyIdiomPatterns` / `raiseRecovered` /
`structureChecked`, exported by `pipeline.ts`) that `decompile()`, `decompileTraced` (trace.ts),
and @asmlift/cli's `decompileRanked`/`decompileWithReport` all run — per-caller differences are
injected via hooks, never copied. `verify()` runs after every IR-mutating pass;
`assertTypesRecovered` / `assertResolved` (contracts.ts) gate the L2/L3 boundaries.

### Modules

| Module                                          | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir/{types,core,opcodes,print,parse,verify}.ts` | MLIR-lite substrate: CFG of blocks + typed **block-arguments**, the typed opcode registry (`Opcode`, the one `effects` table DCE and hoist guards derive from), printer + parser (round-trip for L1/scalar types — see the domain note in parse.ts), verifier (arity/attrs/terminators/SSA dominance, located errors)                                                                                                                                                                                                                     |
| `frontend/{thumb,mips,ppc}.ts`                  | ISA frontends: decode → CFG → L1 with **Braun-2013 block-arg SSA** (`ssa.ts`), incl. loops, calls (signature-driven arity), memory, jump tables. Shared scaffolding: `disasm.ts` (objdump parsing), `splat.ts` (Splat-dialect MIPS → objdump-shaped instrs), `format.ts` (input-format classification), `emit.ts` (per-block emitter kit + `switch_br`), `opaque.ts` (the unmodelled-op → loud-`opaque` contract), `errors.ts` (`FrontendUnsupportedError`; PPC's subclass), `registry.ts`, `asmdata.ts` (Regime-B jump-table side-table) |
| `pattern/engine.ts`                             | Idiom layer: **rewrite patterns as data** + greedy driver + DCE; `patternApplies` gates on Target capabilities                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `raise/*.ts`                                    | The pre-recovery recognizers, in ONE ordered list (`pre-recovery.ts`): const materialize → magic division (`magicdiv.ts`, Hacker's Delight inverse) → soft division → array legalize → struct-array → struct-pointer → short-circuit; plus `recover.ts` (L1→L2 type recovery), `retsink.ts` (return-sinking), `errors.ts` (`RaiseUnsupportedError`)                                                                                                                                                                                       |
| `structure/*.ts`                                | L2→L3 in four modules: `loops.ts` (natural-loop discovery), `analysis.ts` (use registry, liveness, C4 materialization), `switch-recover.ts` (Regime-A comparison-tree recovery), `structure.ts` (SSA-destruction coalescing with interference checks + emission: if/while/do-while/for/switch, break/early-return)                                                                                                                                                                                                                        |
| `l3/*.ts`                                       | `ast.ts`: language-**neutral** structured AST, the one traversal vocabulary (`exprChildren` etc.), and the `LanguageBackend` seam. Post-structure passes `dce.ts` + `basecse.ts`, the differ-ranked re-spelling levers `regspell.ts` + `reindex.ts`, and `typing.ts` (the rendered-expression C type the backends and contracts share)                                                                                                                                                                                                    |
| `backend/{c,cpp,cfamily,pascal}.ts`             | Three backends: C and C++ (CodeWarrior mangling via `mangle.ts`) over the shared `cfamily.ts` substrate, and Pascal (`:=`, `div`, tail-position returns; unspellable constructs throw)                                                                                                                                                                                                                                                                                                                                                    |
| `pipeline.ts`                                   | `decompile()` + the shared tower spine + annotate-mode stubs/diagnostics                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `trace.ts`                                      | `decompileTraced` — the traced tower (per-stage IR dumps + pattern before/after events), browser-pure; @asmlift/cli's `report.ts` enriches it with objdiff scores/candidates, the playground's Pipeline tab renders it directly                                                                                                                                                                                                                                                                                                           |
| `rank.ts`                                       | Pure candidate enumeration + `rankBy` (an injected score function ranks). @asmlift/cli's differ ranks through `rankBy`; the playground's wasm scorer consumes the same enumeration with its own async loop                                                                                                                                                                                                                                                                                                                                |
| `target.ts`                                     | `TargetDescription` (ABI + capabilities + compilerBehaviors as data — no `arch ==` in shared code); toolchain paths live in `@asmlift/toolchains`                                                                                                                                                                                                                                                                                                                                                                                         |
| `contracts.ts`, `proto.ts`, `mangle.ts`         | Boundary contracts; prototype tables; the CodeWarrior mangler                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Scoring and ranking live across the package seam in [`@asmlift/cli`](../cli/README.md):
`score.ts` + `objdiff.ts` (toolchain compiles → in-process pinned `objdiff-wasm`, fail-closed)
and `rank.ts` (ranked type candidates re-ranked by the differ).

### Honest coverage gaps

Recovered today: straight-line, if/else diamonds, natural loops (`while` / `do-while` / `for`,
properly nested, in-body `break`/early-`return`), comparison-tree and jump-table switches,
direct calls, constant-offset and variable-index memory (`*p`, `p[n]`, `a[i]`, struct fields),
magic-number and soft division, short-circuit booleans, width casts. Still DECLINED (loud, never
wrong code): **local stack frames** (address-taken locals / sp-as-data / live spills),
**cross-block condition flags** on PPC (a `cmpw` whose branch lands in another block — the
capability gap behind the mwcc switch stubs), computed tail calls, PIC/`gp`/SDA global access,
switch fall-through, multi-latch/irreducible loops, floats, and 64-bit memory ops. Prototypes
(callee arities, void-ness) come from a caller-supplied map, as a real project takes them from
headers.

## Tests

The toolchain-free half of the test story lives in `test/`: every suite there runs with no
compiler installed, on any machine and in hosted CI. The toolchain-bound matching suites live in
[`@asmlift/cli`](../cli/CONTRIBUTION.md#tests) (Docker-gated suites skip WITH a warning — see
`../cli/test/matching/docker-gate.ts`). The CI gate is `pnpm run test:offline`, whose directory
list in the root package.json is SELF-VERIFYING — `offline-list.test.ts` derives the offline set from each
suite's imports and fails on drift.

Landmarks (not exhaustive — suites are named for what they pin):

- `roundtrip` / `verify` / `determinism` / `pattern` — the IR substrate.
- `m1`–`m5` (in `../cli/test/matching/`) — one milestone thesis each.
- `../cli/test/matching/regression.test.ts` — data-driven over `matching/fixtures.ts`; the guard
  that keeps every already-matching function matching. How to add a fixture — and when a
  matching test is the right tool at all, vs a benchmark row — is under
  [`@asmlift/cli` › Tests](../cli/CONTRIBUTION.md#tests).
- `contract-invariant` / `contracts` — the loud-fail contract, mutation-proven.
- `structure-guard` / `structure-soundness` / `audit-regression` — the adversarial-audit repro
  locks.

**`test/corpus/` is load-bearing beyond this suite.** The committed disassembly fixtures in
`test/corpus/` are ALSO imported (via Vite `?raw`) by the playground's example gallery —
`apps/web/src/pages/playground/examples.ts`. Renaming or pruning a corpus file breaks the `apps/web` build
(CI-gated on every push), so treat these files as a public fixture surface, not suite-private
scratch.

## More

- the root [`README.md`](../../README.md) — monorepo layout, benchmark, webapps.
