# asmlift 101

A from-zero tour of asmlift: the problem it solves, the ideas it is built on, a real function
walked through every stage of the pipeline, and a map of the codebase. No decompilation
background is assumed: every term is explained on first use, and there is a [glossary](#glossary)
at the end. If you already know the field, skim Part I and jump to
[Part III](#part-iii--one-function-end-to-end).

---

## What asmlift is, in one example

You give asmlift the **assembly** of one function. For example this, produced by a Game Boy
Advance's (GBA) C compiler:

```asm
clamp0:
	cmp	r0, #0
	bge	.L4
	mov	r0, #0x0
.L4:
	bx	lr
```

and it gives you back C:

```c
s32 clamp0(s32 a0) {
    if (a0 < 0) a0 = 0;
    return a0;
}
```

(`s32` is a signed 32-bit integer — a typedef the decomp community uses instead of `int`;
Part III says why.)

That looks like ordinary decompilation, but asmlift's bar is much higher than "readable and
roughly right". The goal is **matching** decompilation: if you compile that C with the _same
compiler and flags_ that produced the original, you get back the **byte-identical** machine
code. When asmlift can't meet that bar, it never guesses silently: it either declines with a
precise reason or emits output with every gap loudly marked. This
"**loud decline > silent miscompile**" rule shapes everything in the codebase, and Part II
explains why.

asmlift is a TypeScript library built as an alternative to [m2c](https://github.com/matt-kempster/m2c)
— the standard decompiler the matching decompilation community uses today — as an experiment
in a different set of design ideas. The two are compared head-to-head on the project's
own benchmark of hundreds function×toolchain cases (a **toolchain** being one exact vintage
compiler+assembler; the same function is tried against several) — see the
[Benchmark view](../apps/web/README.md) of the webapp, methodology and caveats included.

---

## Part I — the problem space

### 1.1 From C to machine code (and the road back)

A **compiler** (like GCC) translates C source into **machine code**: raw bytes a CPU executes.
**Assembly** ("asm") is the human-readable spelling of machine code — one line per CPU
instruction, like `cmp r0, #0` ("compare **register** r0 — one of the CPU's handful of named
storage slots — with 0"). That's enough to read `clamp0` above: `cmp` compares, `bge` is a
**branch** (a jump to another instruction) taken if the comparison came out ≥, `.L4:` is the
label it jumps to, `mov` writes 0 into r0, and `bx lr` returns — with the function's argument
and return value both living in r0. A **disassembler** (asmlift uses
the standard [GNU binutils](https://www.gnu.org/software/binutils/) `objdump`) turns machine
code bytes back into assembly text. That's the easy direction.

A **decompiler** attempts the hard direction: assembly back to source code. It's hard because
compilation destroys information — variable names, types, comments, and the shape of your
control flow are all gone. Two very different C programs can compile to the same instructions,
and one C program can compile to wildly different instructions depending on compiler and
optimization level.

### 1.2 ISA — the three instruction sets asmlift speaks

An **ISA** (Instruction Set Architecture) is a CPU family's vocabulary: which instructions
exist, what registers are available, how memory is addressed. asmlift has three ISA
**frontends** (the pipeline stage that reads assembly), matching three retro consoles:

| ISA                | Console          | Compiler asmlift targets                                                                                          | Notes                                                                                                                                                                                                                 |
| ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ARMv4T / Thumb** | Game Boy Advance | [agbcc](https://github.com/pret/agbcc) (GCC 2.9 fork)                                                             | Thumb = 16-bit compressed ARM encoding. No hardware divide, no hardware floats — the compiler emits helper-function calls and shift tricks instead, which is exactly what makes GBA code hard for generic decompilers |
| **MIPS**           | Nintendo 64      | IDO 7.1 (SGI's compiler, run via [ido-static-recomp](https://github.com/decompals/ido-static-recomp)) and KMC GCC | MIPS has **delay slots**: the instruction _after_ a branch executes _before_ the branch takes effect. The frontend has to model that faithfully                                                                       |
| **PowerPC**        | GameCube         | CodeWarrior `mwcceppc` (run through [wibo](https://github.com/decompals/wibo), a Win32 shim)                      | Condition results live in **condition-register fields** (cr0…) rather than being recomputed at each branch                                                                                                            |

Why these? Because of who asmlift is for.

### 1.3 Matching decompilation and the decomp community

There is a community of projects that reverse classic games into **buildable source code** —
[pret](https://github.com/pret)'s Pokémon decompilations, the Zelda and Mario 64 projects, and
many more. Their standard of proof is total: the reconstructed C must compile, with the
original vintage compiler, to a byte-identical ROM (the game's shipped binary). This is called a **matching decomp**, and
the per-function workflow (try C, compile, compare, adjust) is supported by shared tools:

- [decomp.me](https://decomp.me) — a collaborative web "scratch" for matching one function.
- [objdiff](https://github.com/encounter/objdiff) — the community differ: it compares two
  **object files** (compiled machine code — the `.o` a compiler produces before linking)
  function-by-function and scores how close they are (0 = byte-exact match).
  **It's used by asmlift:** it calls objdiff (the `objdiff-wasm` package) so "match" means
  exactly what the community means.
- [m2c](https://github.com/matt-kempster/m2c) — the decompiler that produces the best effort
  of a matching C/C++ code.

The key mental shift from ordinary decompilation: **the compiler is the spec**. You know
_exactly_ which compiler produced the bytes. So instead of asking "what C could this be?", a
matching decompiler asks "what C does _agbcc -O2_ compile to _these exact bytes_?" — a much
narrower question, and one with a mechanical oracle: compile the candidate and let objdiff
judge. asmlift leans on that oracle everywhere (see "ranked candidates", §2.6).

### 1.4 Why not Ghidra? Why an alternative to m2c?

[Ghidra](https://github.com/NationalSecurityAgency/ghidra)
is the NSA's open-source reverse-engineering suite, and its decompiler is excellent — _for
reading_. It's built for security analysts: it aggressively simplifies, renames, hoists, and
normalizes to maximize readability, and — by design, not by defect — its C output is not meant
to recompile at all, let alone to the original bytes. For a matching workflow those readability
transforms are actively harmful: every normalization moves the output _away_ from the one C shape
the original compiler would accept. asmlift used Ghidra's decompiler as a reference and
deliberately inverted the philosophy: be _more_ conservative than Ghidra about rewriting,
and let byte-equality (instead of aesthetics) pick between alternatives.

[m2c](https://github.com/matt-kempster/m2c) _is_ built for matching (and it's good at it,
especially on MIPS/N64). But the community's current AI workflow usually is the following:
point an LLM agent at one function, let it massage the draft until objdiff says 0, repeat.
That works, but the effort spent per function might be more efficiently used.

asmlift starts from a different question: **what if, instead of using AI to match a single
function, we used AI to build a machine that matches functions programmatically?**

The runtime stays fully programmatic, with no LLM in the translation path. AI's job is building and
improving the machine itself, and that one decision drives the architecture:

- The machine needs a **mechanical fitness function** — the objdiff oracle (§2.6), and the
  benchmark (`apps/benchmark/`) that judges every change to asmlift itself.
- It needs **failures the loop can see**. A best-effort draft that's silently wrong is exactly
  the failure an automated loop cannot detect — which is why "loud decline > silent miscompile"
  is the cardinal rule (§2.8): everything not fully modeled is marked or thrown, never silent.
  (The in-source marker idea itself is borrowed from m2c's `M2C_ERROR`.)
- It needs **improvements expressible as data** the oracle can validate — the patterns-as-data
  idiom layer (§2.5). Its first payoff is the GBA soft-arithmetic family (no hardware
  divide/floats, so `x / 2` compiles to a three-instruction shift dance and float math becomes
  helper calls): idioms that throw off any decompiler's type inference are first-class
  recognizable patterns here.

---

## Part II — the foundations

### 2.1 IR — intermediate representation

Most of the compiler or decompiler works on an **IR** (intermediate representation): a
data structure standing between source and machine code, designed to be analyzed and
transformed. Working directly on assembly text is tough; working directly on a C **AST**
(abstract syntax tree — the parsed tree structure of source code, as in Babel or ESLint) is too
rigid. asmlift's IR (defined in [`packages/core/src/ir/`](../packages/core/src/ir)) is a small,
strict, printable language — you'll see real dumps of it in Part III.

### 2.2 Basic blocks and the CFG

A **basic block** is a straight-line run of instructions with one entry and one exit — control
can only enter at the top and leave at the bottom (via a branch, return, etc.). The blocks of a
function plus the branch edges between them form the **CFG** (control-flow graph). `clamp0`
above has three blocks: the compare-and-branch, the `x = 0` assignment, and the shared return.
Recovering `if`/`while`/`switch` source from a bare CFG is called **structuring** (§2.7).

### 2.3 SSA and block arguments

**SSA** (static single assignment) is the IR discipline where every value is assigned exactly
once. Instead of "r0 changed three times", you get three named values `%0`, `%1`, `%2` — which
makes "where did this value come from?" a trivial question, and that question is the heart of
decompilation.

The classic problem: what happens where control flow _merges_? In `clamp0`, the value returned
is _either_ the original `r0` _or_ the constant 0, depending on the path. Textbook SSA solves
this with **φ (phi) functions** — a special instruction at the merge point meaning "this value
is X if control arrived from edge A, Y from edge B". asmlift instead uses **block arguments**,
the style popularized by [MLIR](https://mlir.llvm.org/) (a compiler framework you'll meet
properly in §2.4): a merge block declares a parameter
(`^bb2(%4: s32)`), and each incoming branch passes its value as an argument
(`br ^bb2(%3)`). Same power, but merges become explicit call-like edges — easier to verify and
to read in dumps.

To _build_ SSA out of assembly (where registers are reassigned constantly), the frontends use
the algorithm from **Braun et al. 2013, "Simple and Efficient Construction of Static Single
Assignment Form"** ([PDF](https://c9x.me/compile/bib/braun13cc.pdf)) — it constructs SSA
directly while decoding, block by block, no dominator-tree precomputation needed. It lives in
[`packages/core/src/frontend/ssa.ts`](../packages/core/src/frontend/ssa.ts).

### 2.4 The IR tower — L1, L2, L3

[MLIR](https://mlir.llvm.org/) ("Multi-Level IR", from LLVM, the compiler infrastructure behind
Clang, Rust, and Swift — [paper](https://arxiv.org/abs/2002.11054))
made mainstream the idea that a compiler shouldn't have _one_ IR but a **tower** of them, each
level closer to the target, with explicit lowering between levels. asmlift runs that idea in
reverse — each level is closer to _source_:

- **L1** — machine-shaped SSA. What the frontend emits: values are `unk32` (32 bits, meaning
  unknown), operations mirror instructions (`shr_u` = shift right, unsigned; `icmp_sge` =
  integer compare, signed ≥), the CFG is the machine's.
- **L2** — typed SSA. After **type recovery**: the same graph, but values now carry `s32`/
  `u32`/pointer types. The _boundary contract_ `assertTypesRecovered` refuses to pass any
  lingering `unknown` downward.
- **L3** — a language-**neutral** structured AST: `if`/`while`/`switch`/expressions, no
  registers, no goto. The contract into L3 is the structurer refusing any CFG shape it cannot
  prove structured.

The levels are **enforced contracts, not folders** — a verifier (`ir/verify.ts`) runs after
every mutating pass, and typed boundary assertions gate each transition (the deeper design
argument, and how the tower is grown only when a capability earns it, is
[`docs/level-tower.md`](level-tower.md)).
One consequence you'll feel immediately when contributing: you cannot "just push something
through" — malformed IR fails loudly at the next gate, which is by design.

Language **backends** then print L3 as concrete source: C, Pascal, and a deliberately scoped
C++ (`packages/core/src/backend/`). One neutral AST, three spellings — every language-specific
decision (Pascal's `:=`, C's `?:`) lives in a backend, never in the tower.

### 2.5 Idioms — when the compiler writes riddles

Compilers replace expensive operations with cheaper equivalent sequences. Two families matter
enormously for retro consoles:

- **Division by a constant** is compiled to multiplication by a _magic number_ plus shift
  fix-ups (the algorithm is **Granlund & Montgomery 1994, "Division by Invariant Integers using
  Multiplication"** — [PDF](https://gmplib.org/~tege/divcnst-pldi94.pdf) — also popularized by
  the book _Hacker's Delight_). A naive decompiler emits the multiply-shift soup;
  a matching decompiler must recognize it and emit `x / 7`, because that's the only C the
  original compiler will re-lower to those exact bytes. asmlift's recognizer
  ([`raise/magicdiv.ts`](../packages/core/src/raise/magicdiv.ts)) _inverts_ the algorithm and
  verifies the inversion, rather than pattern-matching a few known constants.
- **Soft arithmetic**: on CPUs without divide/float hardware, `a / b` becomes a call to a
  helper like `__divsi3`. Recognizers rewrite those calls back to operators
  ([`raise/softdiv.ts`](../packages/core/src/raise/softdiv.ts)).

Simpler idioms (power-of-two division via shifts — the `half` example in Part III — multiply
strength-reduction, width casts) are expressed as **rewrite patterns as data**
([`pattern/engine.ts`](../packages/core/src/pattern/engine.ts)): serializable objects saying
"this DAG (directed-acyclic-graph) shape of operations becomes this op", each gated to the
compilers that emit it. Data, not code, so
that an automated loop can eventually _propose_ new patterns and have the oracle validate them.

### 2.6 Types as ranked candidates, judged by the differ

Assembly rarely proves a type. `x >> 1` compiles to a _logical_ shift (fill with zeros) if `x`
is unsigned and an _arithmetic_ shift (copy the sign bit) if signed — JavaScript's `>>>` vs
`>>` — so from the C side, signedness changes the bytes. asmlift's rule:
when the choice is real, **emit both candidates, compile both, and let objdiff pick** (the
score is 0 for exactly one of them). That's `decompileRanked` in
[`packages/cli/src/rank.ts`](../packages/cli/src/rank.ts) — types are _differ-ranked levers_, not
guesses. This is only possible because matching decompilation has an oracle; it's the single
biggest philosophical difference from a traditional decompiler.

### 2.7 Structuring — from CFG back to `if`/`while`/`switch`

Turning an arbitrary CFG into structured source is a classic problem. The academic north star
for readability is **"No More Gotos"** (Yakdan et al., NDSS 2015 —
[paper](https://www.ndss-symposium.org/ndss2015/no-more-gotos-decompilation-using-pattern-independent-control-flow-structuring-and-semantics/)),
which recovers goto-free code via pattern-independent structuring; Ghidra has its own
transform pipeline with similar goals. asmlift deliberately does **less**: it recognizes the
shapes real compilers emit (if/else **diamonds** — a branch splits, the arms re-merge, as in
`clamp0` — natural loops, two regimes of `switch` —
comparison trees and jump tables), and for anything else it _declines_ rather than emitting
`goto` — because for byte-matching, emitting the compiler's canonical shape is the whole game,
and a `goto` is never that shape. The structurer lives in
[`packages/core/src/structure/`](../packages/core/src/structure) — the most intricate code in the
project, because destroying SSA (assigning merge values back to named C variables without
changing meaning) is where several audit rounds found the subtlest bugs.

Historical grounding, if you want it: the founding academic treatment of decompilation is
Cristina Cifuentes' 1994 thesis _Reverse Compilation Techniques_
([QUT ePrints](https://eprints.qut.edu.au/36820/)).

### 2.8 The cardinal rule: loud decline > silent miscompile

A matching decompiler's output is _checked_ by recompilation, so you might think wrong output
is harmless, since the score just won't be 0. But remember the driver question (§1.4): asmlift is a
machine built and improved by an AI loop, and such a machine is only as good as the failure
signals it emits. A silent miscompile poisons every consumer of those signals:

1. **The improvement loop.** A typed decline names the exact missing capability — the
   benchmark's gap histogram turns declines into a work-list. Plausible-looking wrong C tells
   the loop nothing but "not 0", indistinguishable from a genuine near-miss.
2. **The human or agent finishing a function.** Output that's wrong in a way that still
   _compiles_ wastes exactly the time the tool exists to save, with no signal about where the
   lie is.
3. **Contexts with no oracle at all** — the **playground** (the project's interactive web UI,
   `apps/web`) or a quick CLI run without a scoring target. There, a silent miscompile is a lie
   with no tell.

So the rule, enforced structurally: any instruction, CFG shape, or memory pattern the pipeline
does not fully model must end in a **typed decline** (`FrontendUnsupportedError`,
`RaiseUnsupportedError`, `StructureError`…) or an explicit **`ASMLIFT_ERROR`-marked stub**
(annotate mode — the default for the CLI/benchmark), never in plausible-looking wrong code.

---

## Part III — one function, end to end

Real output, generated with `decompileTraced` (the same trace the playground's **Pipeline tab**
shows — the fastest way to explore this interactively is `cd apps/web && pnpm run dev`).

**Input** (agbcc compiling `int clamp0(int x){ if (x < 0) return 0; return x; }` at `-O2`):

```asm
clamp0:
	cmp	r0, #0
	bge	.L4
	mov	r0, #0x0
.L4:
	bx	lr
```

**Stage 1 — lift** (Thumb frontend → L1 SSA). Three blocks; note the block argument
`^bb2(%4)` receiving either the original `%0` or the constant `%3` depending on the path, and
that every type is still `unk32` (`cond_br c, ^then, ^else` is the conditional branch — two
possible targets, each taking its arguments):

```
fn clamp0 {
^bb0(%0: unk32):
  %1: unk32 = const {value=0}
  %2: unk32 = icmp_sge %0, %1
  cond_br %2, ^bb2(%0), ^bb1()
^bb1():
  %3: unk32 = const {value=0}
  br ^bb2(%3)
^bb2(%4: unk32):
  ret %4
}
```

**Stage 2 — idiom fold.** Patterns apply to this target and are tried.
Since none of them match this function, the IR is unchanged (the playground's Pipeline tab dims
such a stage with a "no change" badge). To see a pattern actually fire,
here is `int half(int x){ return x / 2; }` — agbcc has no divide instruction, so it emits a
sign-fix shift dance, and the `sdiv-pow2/2` pattern folds it back (`{imm=…}` is an
**immediate**: a constant operand baked into the instruction):

```
BEFORE                                     AFTER
^bb0(%0: unk32):                           ^bb0(%0: unk32):
  %1: unk32 = shr_u %0 {imm=31}              %1: s32 = sdiv %0 {imm=2}
  %2: unk32 = add %0, %1                     ret %1
  %3: unk32 = shr_s %2 {imm=1}
  ret %3
```

…which emits `return a0 / 2;` and recompiles byte-exact. This is the GBA soft-arithmetic
family from §1.4, handled by construction.

**Stage 3 — type recovery** (L1 → L2). The signed compare `icmp_sge` is evidence: its operands
are `s32`. Every `unk32` is resolved or the contract throws:

```
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sge %0, %1
  cond_br %2, ^bb2(%0), ^bb1()
...
```

**Stage 4 — structure** (L2 → L3). The diamond CFG is recognized as an if-assign that merges
back into one variable; SSA is destroyed (the block argument `%4` and both its sources become
the single C variable `a0` — safe only because the structurer proves they never _interfere_,
i.e. no two of them are ever needed at the same moment).

**Stage 5 — emit** (C backend):

```c
s32 clamp0(s32 a0) {
    if (a0 < 0) a0 = 0;
    return a0;
}
```

(`s32` is the decomp-community typedef for `int32_t` — projects define these in their headers.)

**Scoring** (needs the real toolchain; `@asmlift/cli`): compile that C with agbcc, objdiff it
against the original object → score 0, byte-exact match.

**And when it can't?** Take `maxab`, a corpus test function (max of two values) that matches on
IDO but declines on KMC GCC, because GCC lowers it with a _branch-likely_ instruction (`beqzl` — a MIPS branch that annuls
its delay slot) the frontend doesn't model yet:

```
FrontendUnsupportedError: cannot lift 'maxab': unmodelled control transfer 'beqzl'
at 0x8 — branch-likely / coprocessor branch not supported
```

Typed error, precise location, honest reason. In annotate mode the same gap becomes an
`ASMLIFT_ERROR` marker inside best-effort output instead of a throw.

---

## Part IV — the codebase map

```
packages/core/            @asmlift/core — the pipeline
  src/frontend/           ISA frontends: thumb.ts, mips.ts, ppc.ts + shared disasm/ssa/opaque
  src/ir/                 the IR substrate: types, ops, printer/parser, verifier
  src/pattern/            rewrite-patterns-as-data + the greedy driver
  src/raise/              L1→L2: recognizers (magicdiv, softdiv, arrays, structs, shortcircuit)
                          + type recovery (recover.ts)
  src/structure/          L2→L3: loop discovery, switch recovery, SSA destruction, emission
  src/l3/ + src/backend/  the neutral AST + its readability passes, and the C / C++ / Pascal printers
  src/pipeline.ts         decompile() — the one shared stage spine
  src/trace.ts            decompileTraced() — the same spine, recorded per stage
  test/                   offline suites + corpus/ (real committed disassembly)
packages/cli/             @asmlift/cli — the user-facing asmlift interface
  test/matching/          the byte-exactness suite (needs real toolchains)
  test/offline/           Node-side suites that run on hosted CI (no toolchains needed)
packages/toolchains/      @asmlift/toolchains — pinned calibration toolchains (tests + benchmark only)
packages/bench-schema/    @asmlift/bench-schema — the shared benchmark result/manifest types
apps/web/                 the webapp: Playground + Benchmark view
apps/benchmark/           the m2c-vs-asmlift harness; the Benchmark view renders its results
```

A reading order that works:

1. This doc, then [`packages/core` › Architecture](../packages/core/README.md#architecture) — the same
   pipeline, one level deeper (module-by-module).
2. [`packages/core/src/ir/core.ts`](../packages/core/src/ir/core.ts) +
   [`ir/print.ts`](../packages/core/src/ir/print.ts) +
   [`ir/opcodes.ts`](../packages/core/src/ir/opcodes.ts) — the IR is small; read the structure,
   the printer, and the opcode table and the dumps above become completely legible.
3. One frontend end-to-end — [`frontend/thumb.ts`](../packages/core/src/frontend/thumb.ts) is the
   founding one.
4. [`pattern/engine.ts`](../packages/core/src/pattern/engine.ts) — patterns-as-data, self-contained.
5. The structurer _last_ ([`structure/structure.ts`](../packages/core/src/structure/structure.ts))
   — it's the deep end.

Tests are documentation here: nearly every suite header states the invariant it pins and why.
`packages/core/test/corpus-offline.test.ts` (committed real disassembly → **golden** C, i.e.
checked-in expected output, snapshot-test style) is a particularly good guided tour.

## Glossary

| Term                      | Meaning                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ISA**                   | Instruction Set Architecture — a CPU family's instruction vocabulary (Thumb, MIPS, PowerPC)                                                                           |
| **Frontend**              | The per-ISA stage that decodes assembly into L1 IR                                                                                                                    |
| **Backend**               | The per-language printer from the neutral L3 AST to C / C++ / Pascal                                                                                                  |
| **IR**                    | Intermediate representation — the data structure passes analyze and transform                                                                                         |
| **Basic block / CFG**     | Straight-line instruction run / the graph of blocks and branch edges                                                                                                  |
| **SSA**                   | Static single assignment — every value defined exactly once                                                                                                           |
| **Block argument**        | MLIR-style alternative to φ-functions: merge blocks take parameters, branches pass arguments                                                                          |
| **φ (phi) function**      | Classic SSA's merge construct — "this value is X from edge A, Y from edge B"                                                                                          |
| **MLIR**                  | LLVM's multi-level IR framework; source of the tower + block-argument ideas                                                                                           |
| **L1 / L2 / L3**          | asmlift's tower: machine-shaped SSA → typed SSA → neutral structured AST                                                                                              |
| **Lift / raise**          | Decode asm into IR / move IR up the tower (recognizers + type recovery)                                                                                               |
| **Structuring**           | Recovering `if`/`while`/`switch` from a CFG                                                                                                                           |
| **Idiom**                 | A compiler's cheap-instruction spelling of an expensive operation (magic division, soft-div)                                                                          |
| **Magic division**        | Constant division compiled to multiply+shift (Granlund–Montgomery)                                                                                                    |
| **Delay slot**            | MIPS: the instruction after a branch executes before the branch takes effect                                                                                          |
| **Branch-likely**         | MIPS branch variant that _annuls_ its delay slot when not taken (currently declined)                                                                                  |
| **Matching / byte-exact** | The reconstructed source recompiles to the identical bytes                                                                                                            |
| **objdiff**               | The community object-file differ; score 0 = match; asmlift's only scorer                                                                                              |
| **Decline**               | asmlift's typed refusal when it cannot be byte-faithful                                                                                                               |
| **Annotate mode**         | `onGap: "annotate"` — emit best-effort source with `ASMLIFT_ERROR` markers instead of throwing                                                                        |
| **Toolchain**             | The exact vintage compiler+assembler that is the spec (agbcc, IDO, KMC GCC, mwcc)                                                                                     |
| **Target**                | asmlift's ID for one ISA+toolchain pair (`agbcc`, `ido7.1`, `gcc2.7.2kmc`, `mwcc_242_81`); "target object" = the original object a candidate is byte-compared against |
| **Case / row**            | The benchmark's measurement unit: one function × one toolchain — a "case" before the run, a "row" of `results.json` after                                             |
| **Prototype (here)**      | Caller-supplied callee arity/void-ness, standing in for a project's headers                                                                                           |

## References

**Academic**

- Braun et al., _Simple and Efficient Construction of Static Single Assignment Form_, CC 2013 — [PDF](https://c9x.me/compile/bib/braun13cc.pdf)
- Granlund & Montgomery, _Division by Invariant Integers using Multiplication_, PLDI 1994 — [PDF](https://gmplib.org/~tege/divcnst-pldi94.pdf)
- Lattner et al., _MLIR: Scaling Compiler Infrastructure for Domain Specific Computation_, CGO 2021 — [arXiv preprint](https://arxiv.org/abs/2002.11054) (posted under its earlier title, _MLIR: A Compiler Infrastructure for the End of Moore's Law_)
- Yakdan et al., _No More Gotos_, NDSS 2015 — [paper page](https://www.ndss-symposium.org/ndss2015/no-more-gotos-decompilation-using-pattern-independent-control-flow-structuring-and-semantics/)
- Cifuentes, _Reverse Compilation Techniques_, PhD thesis, QUT 1994 — [ePrints](https://eprints.qut.edu.au/36820/)
- Warren, _Hacker's Delight_ (2nd ed., Addison-Wesley 2012) — the standard reference for the bit-trick idioms

**Tools & community**

- [m2c](https://github.com/matt-kempster/m2c) · [objdiff](https://github.com/encounter/objdiff) · [decomp.me](https://decomp.me) · [Ghidra](https://github.com/NationalSecurityAgency/ghidra) · [MLIR](https://mlir.llvm.org/)
- [pret](https://github.com/pret) (GBA decomps, agbcc) · [decompals](https://github.com/decompals) (ido-static-recomp, wibo)

**In this repo**

- [`packages/core` › Architecture](../packages/core/README.md#architecture) — the architecture, one level deeper
- [`apps/web`](../apps/web/README.md) — the webapp's Benchmark view: methodology and results
