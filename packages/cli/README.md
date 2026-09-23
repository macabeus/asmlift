# @asmlift/cli

The asmlift command line: give it one function's assembly, get C back — and, pointed at the
original object file, **proof**: the output is recompiled with your project's own compiler and
byte-compared with the community `objdiff` engine. Exit 0 means byte-exact match.

> 📚 Check the [root `README.md`](../../README.md) for a quick-start on how to use `@asmlift/cli`

## Features

| Feature                   |                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decompile one function    | from compiler `.s` text, `objdump -d` text, or an ELF `.o`                                                                                                                                                                    |
| Verify byte-exactness     | `--score-against target.o` (the original object file — the 'target object') recompiles the output and objdiff-scores it — with **your** project's compiler                                                                    |
| Ranked candidates         | genuinely ambiguous choices (e.g. signedness) become candidates; the byte-diff picks the winner                                                                                                                               |
| `decomp.yaml` integration | inside a configured project, no flags needed — target and compiler come from [decomp_settings](https://github.com/ethteck/decomp_settings)                                                                                    |
| Honest failure            | what asmlift can't lift faithfully is annotated in-source (`ASMLIFT_ERROR`) or declined with a typed reason — never plausible wrong code                                                                                      |
| Multiple targets          | agbcc (GBA), IDO 7.1 (N64), KMC GCC (N64), GCC 2.7.2 (N64), CodeWarrior (GameCube) — the compiler families asmlift understands (calibration toolchains live in the repo's private `packages/toolchains`, not in this package) |

## Inputs

| Input                                            | Accepted for                                   |
| ------------------------------------------------ | ---------------------------------------------- |
| Compiler `.s` text                               | All targets                                    |
| `objdump -d --no-show-raw-insn` text             | `ido7.1`, `gcc2.7.2kmc`, `gcc2.7.2`            |
| `objdump -d -r -M gekko --no-show-raw-insn` text | `mwcc_242_81`, `mwcc_233_163n`, `mwcc_247_107` |
| ELF object file (`.o`)                           | MIPS/PPC targets                               |
| `-` (stdin)                                      | text formats only                              |

If the file includes multi-functions, pass the `--name` flag.

An object whose code lives in several sections that share addresses **requires** `--name` (exit
`64` without it). CodeWarrior gives one translation unit many sections, all called `.text` and all
starting at address 0, so a whole-object disassembly labels each address with whichever symbol it
finds at that value — the function a name selects there is not reliably the one the symbol table
places there. With `--name`, asmlift reads the function from the section its `st_shndx` names.

The PowerPC command is not interchangeable with the MIPS one. `-r` carries the relocation lines
that hold a `bl`'s callee name, and `-M gekko` names the machine CodeWarrior compiles for: without
it objdump decodes the GameCube's paired-single opcodes as POWER VSX — `psq_l f30,120(r1),0,0`
prints as `lq r30,112(r1)`, a different register file at a different offset. Object-file input runs
the right command for you.

## CLI reference

```
usage: asmlift <file.s|file.asm|file.o|-> [--target <agbcc|ido7.1|gcc2.7.2kmc|gcc2.7.2|mwcc_242_81|
                                           mwcc_233_163n|mwcc_247_107>]
                [--name <symbol>] [--backend <c|pascal>] [--strict]
                [--cflags <flags>] [--module <module>]
                [--config <decomp.yaml>] [--score-against <target.o>]
                [--asm-data <dump.txt>] [--proto <json|proto.json>]
                [--jobs <n>] [--progress]
```

| Flag              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target`        | Which ISA+compiler pair produced the input. Optional inside a `decomp.yaml` project (resolution: flag > `tools.asmlift.target` > `platform`, traced on stderr; an ambiguous platform like `n64` or `gc` asks you to choose rather than guessing)                                                                                                                                                                                                                                                                                               |
| `--name`          | The function to decompile when the input holds several (default: auto-detected; required for an object whose code sections share addresses, see [Inputs](#inputs))                                                                                                                                                                                                                                                                                                                                                                             |
| `--backend`       | Output language: `c` (default) or `pascal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--strict`        | Fail on any gap instead of annotating. Default: gaps become in-source `ASMLIFT_ERROR` markers plus stderr diagnostics                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--cflags`        | The flags your build compiles this function's file with, as the build spells them (`--cflags "-mthumb-interwork -O1"`). They fill `{{cflags}}` in the `compiler` command and win over every other source. See [Compiler flags](#compiler-flags)                                                                                                                                                                                                                                                                                                |
| `--module`        | The dtk module the function belongs to. Its unit is looked for among this module's `objdiff.json` units only — REL code repeats names across modules, and a function several units define is refused until you choose — and a REL module's symbols come from that module's own ELF (see [REL modules](#rel-modules))                                                                                                                                                                                                                           |
| `--config`        | Explicit `decomp.yaml` path (default: nearest ancestor of the input file)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--score-against` | Compile the output (and every ranked candidate — unless the fan is stillborn, core `stillborn.ts`: the default candidate and one probe per variation were all rejected alike, and the rest is reported as not compiled) and objdiff-score it against this object. Implies strict; the per-candidate score table goes to stderr                                                                                                                                                                                                                 |
| `--asm-data`      | For text input: an `objdump -s -r -t` dump of the object the asm came from, supplying the data sections text lacks (jump tables, anonymous constants). Object-file input extracts this itself and then refuses the flag — unless the extraction failed, which warns and leaves the flag as the way to supply what it could not read                                                                                                                                                                                                            |
| `--proto`         | Function prototypes, inline JSON or a path to it (`{"sym": {"params": N \| ["u8", ...], "returnsVoid": true}, ...}`): a callee's `params` says how many ARGUMENT REGISTERS the call occupies — a bare count states that number directly, a TYPED list states each C parameter's type and is summed (a `long long` is one parameter and two registers) — and the decompiled function's OWN entry gives its parameter widths (below) and its void-ness. Every entry is validated — a malformed one is refused (exit `64`), never quietly ignored |
| `--jobs`          | With `--score-against`: compile `n` candidates at a time (default `1`). Candidate compiles are the bulk of a ranked run and are independent; the ranking is unchanged — the schedule cannot choose the winner                                                                                                                                                                                                                                                                                                                                  |
| `--progress`      | With `--score-against`: an `asmlift: [progress] i/n candidates scored` liveness line on stderr every few seconds; on a stillborn fan the bar closes on the count that was compiled. The `[score]` table is unchanged, so two runs still compare on their `[score]` lines                                                                                                                                                                                                                                                                       |

Flags take either spelling, `--name X` or `--name=X`. `--jobs` and `--progress` describe a ranked
run and are a usage error (exit `64`) without `--score-against`, rather than silently ignored.
`--progress` also prints a per-phase timing report when the run ends.

Above `--jobs 1` it is YOUR `compiler` template that runs concurrently. Each worker gets its own
`{{inputPath}}`/`{{outputPath}}` scratch directory, but every worker runs from the config's
directory, so a template that writes to a fixed path inside the project races itself.

Exit codes: `0` clean (or byte-exact match when scoring) · `1` gaps, declined, or nonmatch —
the stderr tag says which (`[declined]` = principled refusal, `[internal error]` = bug) ·
`3` the candidate-object cache served bytes a fresh compile disagrees with, which outranks every
other status because a store that lied invalidates the whole fan ·
`64` usage error · `66` unreadable input.

## `decomp.yaml` reference

All asmlift settings live in a spec-compliant `tools.asmlift` block:

| Field      | Meaning                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`   | asmlift target key — needed when the `platform` maps to several compilers (`n64` → `ido7.1`, `gcc2.7.2kmc` or `gcc2.7.2`; `gc`/`gamecube`/`wii` → `mwcc_242_81`, `mwcc_233_163n` or `mwcc_247_107`)                                                                                                                                                      |
| `compiler` | Candidate-compile command template: source file in, relocatable object out. Runs via `sh` with the decomp.yaml's directory as cwd                                                                                                                                                                                                                        |
| `objdump`  | Host objdump binary for `.o` input (overrides the PATH/env-resolved default: `mips-linux-gnu-objdump` / `powerpc-eabi-objdump`)                                                                                                                                                                                                                          |
| `symbols`  | A symbol map already DERIVED, as JSON (hex address → `SymbolInfo[]`), for a project with no ELF to derive one from — an authored map, or the one a published reproduction script must feed back to reproduce its answer. Mutually exclusive with `elf`: two sources for one map is a silent precedence question, so declaring both is a loud input error |
| `elf`      | The project's built ELF, relative to this `decomp.yaml` — the address→symbol source. Absent ⇒ no symbol map. An unreadable ELF is a loud input error (exit `66`), never a silent map-less run. What it feeds and how to produce one: [The symbol map](#the-symbol-map-elf)                                                                               |

Template placeholders: `{{inputPath}}` (candidate source path),
`{{outputPath}}` (where the object must land), `{{symbol}}` (the function name), `{{cflags}}`
(the flags from `--cflags` or a dtk unit, as shell words), `{{cc}}` (the dtk unit's compiler name,
such as `mwcc_247_107`). An unknown
`{{…}}` placeholder is a named error. Values substitute **raw** so your template owns its
quoting (`PRE="{{outputPath}}.i"` works) — each value is verified shell-inert first, and
anything unsafe (including `$`-bearing symbol names) refuses loudly rather than reaching the
shell.

Scoring rules, in the project's spirit of never guessing:

- **`--score-against` requires a `compiler` command** — scoring must use _your_ project's
  compiler and flags; anything else would silently mis-score candidates, so there is no
  fallback of any kind.
- A failing compile command is a loud error carrying the command and its stderr.
- `compiler` executes **only** when you pass `--score-against`; a plain decompile never runs
  config-supplied commands. (`objdump` is the one exception: like the default objdump, it
  runs on `.o` input to disassemble it — argument-array spawn, no shell.)
- There is no typedef-prelude flag. asmlift **probes** your `compiler` template once: a
  template that injects the project's own headers rejects the probe (C89 duplicate typedef)
  and asmlift then drops both its typedefs and its synthesized declarations for every
  candidate; a template that accepts it keeps both. The verdict is cached per run.

### When no target fits your compiler

`--target` is a closed set of seven, and `platform` maps only `gba`, `n64` and `gc`/`gamecube`/`wii`.
An unmapped platform (`ps1`, `nds`, …) refuses. A mapped one whose compiler is not the one it names
does **not**: `platform: gba` on a modern `arm-none-eabi-gcc` build resolves to `agbcc`, and the
`[config]` line is the only thing that says so — read it.

A target key picks the ISA frontend and the `compilerBehaviors` that drive enumeration. It does not
pick the scorer: `--score-against` compiles with YOUR command and diffs YOUR object, so a match is
byte-exact whichever key produced it. A wrong key costs matches, never truth — which makes the
nearest key on the right ISA usable:

| Your ISA                   | Nearest key                                    |
| -------------------------- | ---------------------------------------------- |
| ARMv4T, Thumb only         | `agbcc`                                        |
| MIPS (including PS1 / PS2) | `ido7.1`, `gcc2.7.2`, `gcc2.7.2kmc`            |
| PowerPC                    | `mwcc_233_163n`, `mwcc_242_81`, `mwcc_247_107` |

Only those three frontends exist (`frontend/registry.ts`); an ARM-mode body is refused by name, not
decoded as Thumb, and instructions the frontend does not model decline loudly.

Making a compiler a real target is a change to `TOOLCHAIN_TARGETS`, deliberately not a setting: one
asmlift has not been calibrated against is one it would otherwise guess at.

## Compiler flags

The flags a function was compiled with compile every candidate, and asmlift reports the profile
they describe (optimisation level, debug info, the words its flag table does not name). One set
reaches both, taken from the first of:

| Source                         | How                                                                                                                                                                          | `[flags]` line ends with |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `--cflags "<flags>"`           | fills `{{cflags}}` in `compiler`, word for word                                                                                                                              | `(--cflags)`             |
| a dtk unit                     | in the `objdiff.json` beside `decomp.yaml`, the unit whose target object defines the function (narrowed by `--module`): its `scratch.c_flags` fill `{{cflags}}`              | `(objdiff.json unit …)`  |
| the `compiler` command's words | the words after the compiler binary (`agbcc`, `old_agbcc`, `cc1`, `cc`, `gcc`, `mwcceppc.exe`), through wrappers like `docker run … wibo`, minus `-o`, operands and warnings | `(compiler command)`     |
| none                           | a plain decompile assumes the target's canonical flags and says so                                                                                                           | `none given: …`          |

```
asmlift: [flags] -mthumb-interwork -O1 -ansi (--cflags)
asmlift: [flags] note: -O2 overridden by later -O1
asmlift: [flags] not in asmlift's flag table, passed to the compiler verbatim: -ansi
```

A project with one flag set writes them in its `compiler` command and needs nothing else. A dtk
project, whose units build with many flag sets, writes `{{cflags}}` and asmlift finds each
function's unit. A unit's `scratch.compiler` must be the target's compiler, or the command writes
`{{cc}}` where the compiler's name goes (`compilers/{{cc}}/mwcceppc.exe`) to compile with the
unit's own; a function several units define is refused, naming them. With flags from `--cflags`
or a unit and `--score-against`, the command must take them through `{{cflags}}`: one that has
none is refused with a copy of it that does, and a codegen flag spelled beside `{{cflags}}` is
refused as a second source. A command that runs no compiler asmlift can find is named in a note;
its candidates still compile as written. Every refusal exits `64` with only its message.

## The symbol map: `elf`

Pointed at the project's built ELF, asmlift names what the map covers instead of emitting raw
address casts. Three channels feed the map — each one the ELF carries is used, and a missing one
just means fewer names, never a guess:

| The ELF carries                         | asmlift gains                                                                                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.symtab` (any unstripped link has one) | Names for globals and functions — `gInputState` instead of `*(u16 *)0x03004668`                                                                                                                                                                |
| DWARF (`-g`)                            | Declaration shapes — array/struct/pointer, signedness, `volatile`/`const` — that drive typed spellings like `gCtx.frameCounter`, and signatures for the functions this ELF compiled from C: a callee's arity drives its call-argument recovery |
| `.debug_macinfo` (`-g3`)                | Address-cast macro names (`#define gCounter (*(u16 *)0x03001234)`) — names no symbol table can carry. The macro spelling also matches the **numeric** literal-pool word the original build has, where an extern would emit a relocated one     |

Every map fact is ranked, never an override: naming a global can change an old compiler's
codegen, so the named spelling and its `/raw-globals` sibling are both enumerated, and
`--score-against`'s byte-diff picks the winner — a tie goes to the name. Unmapped addresses
(MMIO registers, unnamed cells) keep the honest cast spelling.

### REL modules

A GameCube/Wii REL module is linked by the game's loader, not by the linker, so its ELF is
RELOCATABLE and every allocated section starts at address 0 — a symbol's value is an offset into
its own section. Naming such a file as `elf:` is refused: read address-first it puts each
section's first symbol at `0x0`, which is 2,393 colliding addresses over Mario Party 4's 99
modules.

`--module <name>` is how a module's function is decompiled instead. `elf:` stays the base
(DOL) ELF, and asmlift reads the module's own ELF beside it at dtk's own layout,
`<directory of elf:>/<module>/<module>.plf` — there is no setting for it. Each of that ELF's
sections is placed at a base of its own, and the base ELF's **global** symbols are unioned in
with the module winning any name they share, because inside a module that name means the
module's own definition. The name must be one the project's `objdiff.json` knows, and a missing
module ELF is refused with the path asmlift looked for.

dtk prefixes the DOL's own units too (`main/`, `static/`), and `elf:` is the file named after that
prefix. So `--module main` names the base ELF itself: it narrows the unit lookup to the DOL's units
and the map is `elf:`'s, unplaced and unioned with nothing. With `symbols:` in place of `elf:` there
is no ELF to find a module beside, and `--module` does the unit job alone.

### Producing the ELF

asmlift only cares which sections end up in the one file `elf:` names, so mix and match:

- **Start with what you have.** Most decomp builds already link an ELF; pointing `elf:` at it
  lights up the `.symtab` channel with zero build changes.
- **Types and signatures: compile with `-g`**, if your era compiler emits DWARF (agbcc does).
  Debug sections are non-alloc and stay out of the image — keep your project's checksum gate
  on and let it prove `-g` really moved nothing.
- **When the compiler can't** (most era MIPS/PPC toolchains): build a _types-sidecar_ — a
  generated TU that `#include`s every project header, compiled by a **modern** cross-gcc for
  the same arch/ABI with `-g -fno-eliminate-unused-debug-types` — and merge its debug sections
  into a derived copy of the ELF with `objcopy --add-section`. Never graft a section name the
  ELF already owns: readers take the first match, silently shadowing the real compiler's DWARF.
- **Macro names need `-g3`, spelled `-gdwarf-2 -g3 -gstrict-dwarf`** — that emits one
  self-contained `.debug_macinfo` with inline strings, the only macro form that survives a
  section graft (DWARF 5's `.debug_macro` splits across COMDAT groups and leans on
  `.debug_str`).

A worked example with all three channels is the Klonoa decomp's
[`asmlift-elf` target](https://github.com/macabeus/kleod/blob/6f149e33517cecae33d57fe888a60f2b20a2008d/Makefile#L115-L152)
(the benchmark's fork of `testyourmine/kleod`):
agbcc `-g` for shapes and signatures, plus a macro-only sidecar graft; the project's default
`make` sha-verifies the same link.

### When there is no signature: `--proto`

A callee still written in assembly was never compiled from C, so no `-g` build produces a signature
for it. The frontend then counts the contiguous argument registers holding a value at the call — an
intervening call disproves some of those and they are dropped, but a value the compiler merely left
behind in the next register reads as an argument, and nothing in the register file distinguishes the
two. The call comes out with arguments the callee never took.

`--proto` is how you state the arity you know:

```
echo '{"AsmCallee": {"params": 1}}' > proto.json
asmlift fn.s --target agbcc --proto proto.json
```

Measured on one real function, a single callee's arity is worth 53 objdiff points. A malformed
entry is refused (exit `64`) rather than ignored — `params: "1"` would otherwise read as an omitted
`params` and fall back to the same guess, costing those points with nothing said about it.

### When the asm is ambiguous: a typed `params` list

A parameter a callee widens at the top of its own body reads as a narrow declaration, and asmlift
declares it that way — `s16 direction` rather than `s32` plus a cast at each use. Two different C
sources compile to those same bytes, though, and the wrong choice moves bytes in the CALLERS:
agbcc truncates at every prototyped call site of a narrow-declared callee. So where you know the
signature, state it and the declaration wins:

```
asmlift fn.s --target agbcc --proto '{"fn": {"params": ["int", "void *"]}}'
```

`"u8"`/`"s16"`/&c., the C89 integer types, `long long` and any pointer are read; a project typedef,
a by-value struct and the floating types are not. The list never PINS a width the asm did not carry
— a declaration that agrees with an elided extension would take the signedness variation off the
table before the differ ever ranked it.

A spelling asmlift cannot read costs nothing on the function's OWN entry: that list is consulted
per parameter, and an unreadable one leaves the asm's own inference standing for it alone. On a
CALLEE's list it costs the whole list, because a parameter wider than a register occupies two of
them and moves every later argument's home, so one unreadable spelling leaves no argument layout
to state — asmlift then recovers the call's arguments from the argument registers it can see it
set up, exactly as it does for a callee you declared nothing about — and the `asmlift: [proto]`
line on stderr names every callee that happened to. A bare count (`{"g": {"params": 3}}`) states
argument registers directly and is taken at its word, so it is the way to state a layout asmlift
cannot derive.

## Environment

| Variable                        | Meaning                                                                                                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASMLIFT_CANDCACHE`             | The candidate-object cache, **on when unset**. `1`/`on`/`true`/`yes` also serve; `0`/`off`/`false`/`no` — and a set-but-empty value — bypass it; `verify` compiles everything anyway and audits the store against it. Anything else is refused out loud rather than read as "on" |
| `ASMLIFT_BENCH_CACHE=0`         | Bypasses that cache too, so bisecting a suspect result does not leave half the caching on                                                                                                                                                                                        |
| `ASMLIFT_CANDCACHE_DIR`         | Where the store lives                                                                                                                                                                                                                                                            |
| `ASMLIFT_CANDCACHE_MAX_MB`      | Its size budget, above which it prunes                                                                                                                                                                                                                                           |
| `ASMLIFT_CANDCACHE_SAMPLE`      | What percentage of served answers are re-compiled and compared. A disagreement FAILS the run — see exit `3`                                                                                                                                                                      |
| `ASMLIFT_CANDCACHE_SAMPLE_SEED` | Replays an exact sampling selection; the `[candcache]` line prints the seed it used                                                                                                                                                                                              |
| `ASMLIFT_CANDCACHE_PRUNE_MS`    | How often it may prune                                                                                                                                                                                                                                                           |
| `ASMLIFT_CANDCACHE_TRACE`       | Prints every store decision, which is how you tell whether a run reaches the cache at all                                                                                                                                                                                        |
| `ASMLIFT_MIPS_OBJDUMP`          | The objdump for MIPS object input, where `tools.asmlift.objdump` does not name one                                                                                                                                                                                               |
| `ASMLIFT_PPC_OBJDUMP`           | The same for PowerPC                                                                                                                                                                                                                                                             |

Every run that touched the store ends with a one-line `asmlift: [candcache] …` summary carrying
the mode, the sample rate and seed, and the hit/miss counts.

## Using it as a library

```ts
// the scoring seam directly
import { compileFromCommand } from '@asmlift/cli/compile-command';
import { decompileRanked } from '@asmlift/cli/rank';
// candidates, objdiff-ranked
import { decompileWithReport } from '@asmlift/cli/report';
// machine-readable run report
import { scoreObjects, scoreSource } from '@asmlift/cli/score';
```

This package ships **no compiler**: any scoring call needs a `compile` function — build one
from your project's command template (`compileFromCommand(template, { cwd })`, the same thing
the CLI builds from `decomp.yaml`) or register one (`registerCandidateCompiler`). Without
either, scoring throws `no candidate compiler for '<id>' — register one or pass a compile
override` — including through `decompileWithReport`'s annotate mode (a missing compiler is a
setup bug, never silently "unscored"). `scoreObjects(targetObj, candidateObj, symbol)` needs
no compiler at all — it diffs two objects you already have. The pure pipeline (no toolchains,
runs in the browser) is [`@asmlift/core`](../core/README.md).

## More

- New to decompilation? [`asmlift-101.md`](../../docs/asmlift-101.md) — the from-zero tour.
- Contributing to this package: [`CONTRIBUTION.md`](CONTRIBUTION.md) — code organization, the
  test suites, and where new coverage goes.
- The m2c-vs-asmlift benchmark: [`apps/benchmark`](../../apps/benchmark/README.md).
