# @asmlift/cli

The asmlift command line: give it one function's assembly, get C back — and, pointed at the
original object file, **proof**: the output is recompiled with your project's own compiler and
byte-compared with the community `objdiff` engine. Exit 0 means byte-exact match.

> 📚 Check the [root `README.md`](../README.md) for a quick-start on how to use `@asmlift/cli`

## Features

| Feature                   |                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Decompile one function    | from compiler `.s` text, `objdump -d` text, or an ELF `.o`                                                                                                                                                   |
| Verify byte-exactness     | `--score-against target.o` (the original object file — the 'target object') recompiles the output and objdiff-scores it — with **your** project's compiler                                                   |
| Ranked candidates         | genuinely ambiguous choices (e.g. signedness) become candidates; the byte-diff picks the winner                                                                                                              |
| `decomp.yaml` integration | inside a configured project, no flags needed — target and compiler come from [decomp_settings](https://github.com/ethteck/decomp_settings)                                                                   |
| Honest failure            | what asmlift can't lift faithfully is annotated in-source (`ASMLIFT_ERROR`) or declined with a typed reason — never plausible wrong code                                                                     |
| Four supported targets    | agbcc (GBA), IDO 7.1 (N64), KMC GCC (N64), CodeWarrior (GameCube) — the compiler families asmlift understands (calibration toolchains live in the repo's private `packages/toolchains`, not in this package) |

## Inputs

| Input                                | Accepted for                           |
| ------------------------------------ | -------------------------------------- |
| Compiler `.s` text                   | All targets                            |
| `objdump -d --no-show-raw-insn` text | `ido7.1`, `gcc2.7.2kmc`, `mwcc_242_81` |
| ELF object file (`.o`)               | MIPS/PPC targets                       |
| `-` (stdin)                          | text formats only                      |

If the file includes multi-functions, pass the `--name` flag.

## CLI reference

```
usage: asmlift <file.s|file.asm|file.o|-> [--target <agbcc|ido7.1|gcc2.7.2kmc|mwcc_242_81>]
                [--name <symbol>] [--backend <c|pascal>] [--strict]
                [--config <decomp.yaml>] [--score-against <target.o>]
                [--asm-data <dump.txt>] [--proto <proto.json>]
```

| Flag              | Meaning                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target`        | Which ISA+compiler pair produced the input. Optional inside a `decomp.yaml` project (resolution: flag > `tools.asmlift.target` > `platform`, traced on stderr; an ambiguous platform like `n64` asks you to choose rather than guessing) |
| `--name`          | The function to decompile when the input holds several (default: auto-detected)                                                                                                                                                          |
| `--backend`       | Output language: `c` (default) or `pascal`                                                                                                                                                                                               |
| `--strict`        | Fail on any gap instead of annotating. Default: gaps become in-source `ASMLIFT_ERROR` markers plus stderr diagnostics                                                                                                                    |
| `--config`        | Explicit `decomp.yaml` path (default: nearest ancestor of the input file)                                                                                                                                                                |
| `--score-against` | Compile the output (and every ranked candidate) and objdiff-score it against this object. Implies strict; the per-candidate score table goes to stderr                                                                                   |
| `--asm-data`      | For text input: an `objdump -s -r -t` dump of the object the asm came from, supplying the data sections text lacks (jump tables, anonymous constants). Object-file input extracts this itself and does not take the flag                 |
| `--proto`         | Function prototypes as JSON (`{"sym": {"params": N \| ["u8", ...], "returnsVoid": true}, ...}`): a callee's params drives its call-argument recovery; the decompiled function's own entry supplies its void-ness                         |

Exit codes: `0` clean (or byte-exact match when scoring) · `1` gaps, declined, or nonmatch —
the stderr tag says which (`[declined]` = principled refusal, `[internal error]` = bug) ·
`64` usage error · `66` unreadable input.

## `decomp.yaml` reference

All asmlift settings live in a spec-compliant `tools.asmlift` block:

| Field      | Meaning                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`   | asmlift target key — needed when the `platform` maps to several compilers (`n64` → `ido7.1` or `gcc2.7.2kmc`)                                        |
| `compiler` | Candidate-compile command template: source file in, relocatable object out. Runs via `sh` with the decomp.yaml's directory as cwd                    |
| `objdump`  | Host objdump binary for `.o` input (overrides the PATH/env-resolved default: `mips-linux-gnu-objdump` / `powerpc-eabi-objdump`)                      |
| `prelude`  | Prepend asmlift's `s32`/`u32`… typedefs to candidates (default `true`; set `false` if your command injects project headers that already define them) |

Template placeholders: `{{inputPath}}` (candidate source path),
`{{outputPath}}` (where the object must land), `{{symbol}}` (the function name). An unknown
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
