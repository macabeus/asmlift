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

> Published as [`@asmlift/core`](https://www.npmjs.com/package/@asmlift/core); inside this repo it
> resolves through the pnpm workspace.

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
- The MIPS targets read `objdump -d --no-show-raw-insn` output and Splat-disassembled `.s`.
- The PPC target reads `powerpc-eabi-objdump -d -r -M gekko --no-show-raw-insn` output. `-r` carries
  the relocation lines a `bl`'s callee name lives in, and `-M gekko` names CodeWarrior's machine:
  the generic dialect decodes the GameCube's paired-single opcodes as POWER VSX.

### `decompile(name, asm, target, opts?)`

| Option       | Meaning                                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`    | `cBackend` (default) or `pascalBackend` — values from `@asmlift/core/backend/*`. C++ is `cppBackend(spec)`, a per-function factory: it takes a `CppFnSpec` (class/method name, explicit param types, class field layouts — what a project's headers supply) and covers free and non-virtual member functions with word-sized fields; virtual dispatch, references, ctors/dtors decline |
| `patterns`   | Idiom rewrite patterns. Omitted = `DEFAULT_IDIOM_PATTERNS` (self-selects per target: most are compiler-gated, the boolean-negation folds are universal); `[]` = none                                                                                                                                                                                                                   |
| `prototypes` | Callee arities + void-ness, as a real project takes them from headers — drives call-argument recovery                                                                                                                                                                                                                                                                                  |
| `asmData`    | Optional `objdump -s -r -t` side-table; required to recover MIPS/PPC jump-table switches                                                                                                                                                                                                                                                                                               |
| `symbols`    | The project's address→symbol map: names, declaration shapes and signatures for the addresses the assembly only numbers. What each channel buys and how to build the ELF behind it: [`@asmlift/cli`](../cli/README.md#the-symbol-map-elf)                                                                                                                                               |
| `onGap`      | `"strict"` (default): throw on any gap. `"annotate"`: emit best-effort source with `ASMLIFT_ERROR` markers; every gap is also returned in the structured `diagnostics` array (empty ⇔ gap-free)                                                                                                                                                                                        |

`DecompileResult.assumedSymbols` carries the declarations the returned source is correct only
BESIDE — array shapes derived from the assembly rather than read from `symbols`. A caller that
publishes the source alone publishes a spelling whose meaning it has not stated, so render them
with it.

Targets: `ARMV4T_AGBCC`, `MIPS_IDO`, `MIPS_GCC`, `PPC_MWCC` (`@asmlift/core/target`). A toolchain
id plus the flags its build compiles the function with resolves to one through
`targetFor(toolchain, cflags)`, which returns that description alongside the `CodegenProfile` the
flags describe — optimisation level, debug info, and the words the flag table does not name.
`TOOLCHAIN_TARGETS` is the registry it reads, and `canonicalFlagsOf` gives a toolchain's default
set where it has one.

### Other entry points

- `decompileTraced` (`@asmlift/core/trace`) — same tower, returns a `TraceReport`: per-stage IR
  dumps + pattern before/after events. This is what the playground's Pipeline tab renders.
- `detectName` (`@asmlift/core/detect`) — best-effort symbol detection for pasted asm.
- Typed decline errors: `FrontendUnsupportedError`, `RaiseUnsupportedError`, `StructureError`,
  `ContractError`, `VerifyError` — a principled decline is distinguishable from a bug.

Everything under `src/` is importable as `@asmlift/core/<path>` (e.g.
`@asmlift/core/pattern/engine`); `@asmlift/core` alone resolves to the pipeline.

## Architecture

Three ISA frontends (ARMv4T/Thumb, MIPS, PowerPC), five compilers (agbcc, IDO, KMC GCC, GCC
2.7.2, CodeWarrior), three language backends over one neutral AST — all scored across the package seam
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

| Module                                          | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ir/{types,core,opcodes,print,parse,verify}.ts` | MLIR-lite substrate: CFG of blocks + typed **block-arguments**, the typed opcode registry (`Opcode`, the one `effects` table DCE and hoist guards derive from), printer + parser (round-trip for L1/scalar types — see the domain note in parse.ts), verifier (arity/attrs/terminators/SSA dominance, located errors); `core.ts` also owns the CFG facts every level reads — `successorsOf`, `predecessors`, `dominators`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `frontend/{thumb,mips,ppc}.ts`                  | ISA frontends: decode → CFG → L1 with **Braun-2013 block-arg SSA** (`ssa.ts`), incl. loops, calls (signature-driven arity), memory, jump tables. Shared scaffolding: `disasm.ts` (objdump parsing), `splat.ts` (Splat-dialect MIPS → objdump-shaped instrs), `format.ts` (input-format classification), `emit.ts` (per-block emitter kit + `switch_br`), `opaque.ts` (the unmodelled-op → loud-`opaque` contract), `errors.ts` (`FrontendUnsupportedError`; PPC's subclass), `registry.ts`, `asmdata.ts` (Regime-B jump-table side-table), `high-half.ts` (a relocated address's high half is a link-time placeholder, never a value), `reloc-symbol.ts` (the per-KIND policy deciding which linker names C can spell), `stackargs.ts` (the outgoing stack-argument fixpoint, over digested slot events rather than instructions) |
| `pattern/engine.ts`                             | Idiom layer: **rewrite patterns as data** + greedy driver + DCE; `patternApplies` gates on Target capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `raise/*.ts`                                    | The pre-recovery recognizers, in ONE ordered list (`pre-recovery.ts`): const materialize → magic division (`magicdiv.ts`, Hacker's Delight inverse) → soft division → array legalize → struct-array → member-array (`memberarrays.ts`, a constant offset feeding a variable-index walk is a struct's ARRAY member) → struct-pointer → short-circuit → narrow-reads (`narrow.ts`) → narrow locals (`narrowlocal.ts`, a carrier read only through its own extension IS that width) → parameter width (`paramwidth.ts`, a parameter extended in the prologue is DECLARED at that width); plus `recover.ts` (L1→L2 type recovery), `retsink.ts` (return-sinking), `latch.ts` (empty-latch folding), `errors.ts` (`RaiseUnsupportedError`)                                                                                             |
| `structure/*.ts`                                | L2→L3: `loops.ts` (natural-loop discovery, over `ir/core.ts`'s dominators), `analysis.ts` (use registry, liveness, C4 materialization), `switch-recover.ts` (Regime-A comparison-tree recovery), `hazards.ts` (the checks a loop emitter runs before committing to a loop form), `namecoalesce.ts` (copy coalescing over the interference graph — the `/merge-names` variation), `structure.ts` (SSA-destruction coalescing with interference checks + emission: if/while/do-while/for/switch, break/early-return), `retspell.ts` (which `return;` the source wrote, read off the epilogue's in-edges), `bitfields.ts` + `globalaccess.ts` (the map-driven bitfield and global-access spellings, both refusal machines)                                                                                                           |
| `l3/*.ts`                                       | `ast.ts`: language-**neutral** structured AST, the one traversal vocabulary (`exprChildren` etc.), and the `LanguageBackend` seam. Post-structure passes `dce.ts` + `basecse.ts`, the shared hoist mechanism `hoist.ts`, the differ-ranked respell variations (`regspell.ts`, `reindex.ts`, `argbase.ts`, `scopebase.ts`, `argcopy.ts` — one entry each in a family of thirty), the spelling pass `tailret.ts` (drop a void `return;` `structure/retspell.ts` marked unspelled), and `typing.ts` (the rendered-expression C type the backends and contracts share)                                                                                                                                                                                                                                                                |
| `backend/{c,cpp,cfamily,pascal}.ts`             | Three backends: C and C++ (CodeWarrior mangling via `mangle.ts`) over the shared `cfamily.ts` substrate, and Pascal (`:=`, `div`, tail-position returns; unspellable constructs throw)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pipeline.ts`                                   | `decompile()` + the shared tower spine + annotate-mode stubs/diagnostics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `trace.ts`                                      | `decompileTraced` — the traced tower (per-stage IR dumps + pattern before/after events), browser-pure; @asmlift/cli's `report.ts` enriches it with objdiff scores/candidates, the playground's Pipeline tab renders it directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rank.ts`                                       | Pure candidate enumeration + `rankBy` (an injected score function ranks). @asmlift/cli's differ ranks through `rankBy`; the playground's wasm scorer consumes the same enumeration with its own async loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rank-variations.ts`, `rank-declare.ts`         | The two halves `rank.ts` walks rather than hand-codes: the enumeration TABLES (declaration order is published behaviour — it breaks a score tie), and the declarations a candidate needs to compile outside the project's headers, including which names one must REFUSE to claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `variation-{tokens,definitions,gates}.ts`       | The variation REGISTRY as data: every variation a candidate's name can carry, what each one MEANS for a reader, and the admission tables a definition names. Keyed by the registry in both directions, so a variation with no definition and a definition naming no variation are each a type error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `codegen-flags.ts`                              | Compiler flags parsed into the codegen profile a function was compiled at — each option that can change what the compiler emits, as a named slot. One flag set reaches both the compile and the decompile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `symbols.ts`, `declare.ts`, `macros.ts`         | The address→symbol map seam (core consumes the VALUE; the providers that read files live in `@asmlift/cli`), the declaration block a self-declaring candidate carries, and the address-cast macro spelling — a `#define` emits a NUMERIC pool word where an `extern` emits a relocated one, so the two are not interchangeable in the bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `target.ts`                                     | `TargetDescription` (ABI + capabilities + compilerBehaviors as data — no `arch ==` in shared code); toolchain paths live in `@asmlift/toolchains`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `contracts.ts`, `proto.ts`, `mangle.ts`         | Boundary contracts; prototype tables; the CodeWarrior mangler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Scoring and ranking live across the package seam in [`@asmlift/cli`](../cli/README.md):
`score.ts` + `objdiff.ts` (toolchain compiles → in-process pinned `objdiff-wasm`, fail-closed)
and `rank.ts` (ranked type candidates re-ranked by the differ).

### Honest coverage gaps

Recovered today: straight-line, if/else diamonds, natural loops (`while` / `do-while` / `for`,
properly nested, in-body `break`/early-`return`), comparison-tree and jump-table switches,
direct calls, constant-offset and variable-index memory (`*p`, `p[n]`, `a[i]`, struct fields),
magic-number and soft division, short-circuit booleans, width casts, and PowerPC small-data
access through its `R_PPC_EMB_SDA21` relocation. Still DECLINED (loud, never
wrong code): **local stack frames** (address-taken locals / sp-as-data; MIPS models word `sp`
slots and PPC elides callee-saved save slots, so a spill/reload pair is modelled on those two —
anything the narrow models cannot honour declines),
**cross-block condition flags** on PPC (a `cmpw` whose branch lands in another block — the
capability gap behind the mwcc switch stubs), computed tail calls, PIC and `gp`-relative access no relocation
names, switch fall-through, multi-latch/irreducible loops, floats, and 64-bit memory ops. Prototypes
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
- `one-version` — a WORKSPACE-scope invariant, like `offline-list`: every dependency that two or
  more workspace packages declare must be declared AND resolved at one version. It exists because
  `packages/cli` scored with `objdiff-wasm` 3.7.3 while `apps/web` scored with 3.7.0, so the
  playground silently showed 229 where the benchmark published 233 on a byte-identical object
  pair. Both the package set and the dependency set are derived, so a third consumer is covered
  without editing the test.

**`test/corpus/` is load-bearing beyond this suite.** The committed disassembly fixtures in
`test/corpus/` are ALSO imported (via Vite `?raw`) by the playground's example gallery —
`apps/web/src/pages/playground/examples.ts`. Renaming or pruning a corpus file breaks the `apps/web` build
(CI-gated on every push), so treat these files as a public fixture surface, not suite-private
scratch.

## More

- the root [`README.md`](../../README.md) — monorepo layout, benchmark, webapps.
