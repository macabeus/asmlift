// Decline-reason classification over asmlift's DECLINED rows — the "blocker Pareto". Every declined
// row carries structured markers (`<stage>: <reason>`, from asmlift's annotate-mode diagnostics);
// classifying them by capability gap answers the roadmap question the raw outcome counts can't:
// WHICH missing capability blocks the most functions.
//
// The classes are regex-matched against asmlift's decline-message vocabulary. That vocabulary is
// deliberately stable prose (each decline message names its construct); an unrecognized reason
// falls into "other" with its raw text preserved — never silently dropped.
//
// A CLASS MUST BE DECIDABLE INSIDE THE FIRST 200 CHARACTERS OF THE REASON. The benchmark publishes
// a marker as `<stage>: ` + `firstLine(reason)`, and `firstLine` in
// `apps/benchmark/src/eval/asmlift.ts` is `split('\n')[0].slice(0, 200)`, so a pattern keyed on the
// tail of a long message tests a string the artifact does not carry. 18 markers in the published
// artifact sit at that cap. The reload refusal in `packages/core/src/frontend/ppc.ts` is the shape
// that pays for it: one throw with two arms, and on `pikmin:__ct__7ActFreeFP4Piki:mwcc_233_163n`
// the second arm's "a local stack frame this frontend does not model" begins at character 197 —
// the published marker ends "which is a l". `stack-frames` keys on `a slot … was saved into`
// instead, which that message reaches at character 64. A reason opens with the function's own
// name, so a long C++ name pushes every later phrase toward the cap on its own.
//
// `declines.test.ts` classifies every marker in the committed artifact and requires "other" to be
// EMPTY — the residue this list deliberately leaves unclassified is zero rows of the artifact's
// 331 declines. That is the anchor a comment cannot be: a reworded core message, or a gap nobody
// has named, fails there by name rather than quietly enlarging a catch-all.
//
// THAT ZERO IS TRUE OF THE ARTIFACT AND NOT OF THE TOOL, and the difference is the honest residue.
// RESIDUE MEANS ONE THING IN THIS FILE, and it is this: the decline messages core can throw that no
// class here claims. It is not what a landed capability left behind (`branch-likely` is labelled
// "residual shapes only" for that) and it is not a catch-all class.
// `packages/core/src` throws 119 distinct decline messages (the texts reached by
// `FrontendUnsupportedError`, `PpcUnsupportedError`, `RaiseUnsupportedError` and `StructureError`,
// harvested by taking each throw's balanced-paren argument, keeping its string-literal pieces and
// replacing every interpolation with a placeholder). 71 of them classify as "other". Some belong
// there — a `disasm.ts` "symbol not found in the disassembly" and a `format.ts` frontend mismatch
// are input errors, not capability gaps — but most are gaps nothing in the corpus has reached yet:
//
//   frontend/thumb.ts   26  ARM-mode function, raw data in the code stream, a base alignment the
//                           input does not determine, pc used as a data base, `stm` with its own
//                           base in the list, control falling off the end, a register spelled in
//                           upper case, and the reaching-compare throw whose reason is
//                           interpolated (`cross-block-flags-arm` keys on one of its reasons, so
//                           the template with a placeholder in it matches nothing)
//   structure.ts        16  eleven loop and post-loop naming refusals beside the two
//                           `loop-exit-values` claims, an unsupported terminator, a volatile read
//                           behind a `&&`/`||`, the pass-through of a recovered switch's own `why`,
//                           and two internal invariants (an ambiguous array offset, a
//                           parallel-copy bug)
//   frontend/mips.ts     9  a relocation with an addend, an address below the symbol, an indirect
//                           `jr`, a non-numeric immediate, and five refusals about a disassembly
//                           the reader cannot account for
//   frontend/splat.ts    8  a data directive in the code stream, a tail call / cross-function
//                           branch, an unparsable constant expression, and a magnitude with a
//                           leading zero (octal to the assembler)
//   frontend/disasm.ts   7  the objdump `...` elision family
//   frontend/ppc.ts      3  `stwu` with update, a relocation on a stack-pointer adjust, and the
//                           two-armed branch denylist, whose template is interpolation end to end
//   frontend/format.ts   1  the input/frontend mismatch — an input error
//   pipeline.ts          1  the attribution wrapper, which carries whichever reason it wraps
//
// THAT COUNT IS A GATE, not a comment. `declines.test.ts` re-runs the harvest and holds the total
// and the per-file breakdown, so a paragraph of figures cannot drift away from the files it counts.
// Move a family out of the residue and into a class and the gate goes red with the new number.
//
// Named here rather than given classes, because a class with no inhabitant and no witness row is
// the defect this file exists to remove. A class that HAS a name and no rows is read in only one
// place: `DeclinePicker` in `components/FeaturePicker.tsx` renders one option per class and
// disables the zero-count ones, so the label is the whole of what a reader gets. `GapAnalysis.tsx`
// — the panel whose own subtitle calls itself the roadmap view — renders `declinePareto`, which
// accumulates only from markers it saw, so a zero-row class does not appear there at all. A label
// written for the roadmap reader lands on the picker.
//
// `declineClassesOf` answers only for a DECLINED row, which is also why nothing here has to cope
// with a compiler's own error text: 13 `c.c:` markers and 12 more compiler lines in the artifact
// belong to noncompile rows. Every marker on a declined row opens with `lift:`, `structure:` or
// `raise:` — 265 / 60 / 18 — and `Diagnostic.stage` in `packages/core/src/pipeline.ts` has no
// fourth value a decline could carry. Two control-transfer capabilities are in that residue and
// are worth naming on their own: `frontend/mips.ts`'s "indirect jump 'jr rN' — jump tables / tail
// calls not supported" and `frontend/thumb.ts`'s "indirect/computed jump — jump tables / computed
// gotos / register tail calls". So is the sixth kind of the naming family: `reloc-symbol.ts`
// `unspellableReason` refuses six ways and five have a class here, while "names 'X', which is not
// a C identifier" has none. They have no rows, so they wait for one.
import type { FunctionResult } from '@asmlift/bench-schema';

export interface DeclineClass {
  key: string;
  label: string;
  pattern: RegExp;
}

export const DECLINE_CLASSES: DeclineClass[] = [
  // The Thumb frontend attributes its sp declines (frontend/thumb.ts slotModelBlocker), so what
  // was one "local stack frames" bucket splits into the capabilities actually missing. Specific
  // classes first — the classifier is first-match.
  {
    // THE LABEL NAMES A DISJUNCTION BECAUSE TWO OF THE THREE PRODUCERS DO. `frontend/thumb.ts`
    // decides the cause at the throw and spells it ("address-taken stack local", "the address of a
    // stack local is computed"); `frontend/ppc.ts` and `frontend/mips.ts` read the same guard —
    // their own comments say so, "mirroring the PPC frontend's r1" — and refuse without resolving
    // it, spelling "address-taken local / frame arithmetic". So does the fallback `why` in
    // thumb.ts's own sp-as-data throw. One phrase, three frontends, one class — and that
    // disjunction is 17 of the 20 rows, so a pattern requiring the word only Thumb writes claims
    // three of them and leaves the rest to a class whose label reads "other sp uses".
    key: 'address-taken-local',
    label: 'Address-taken stack locals (&local escapes, or frame arithmetic)',
    pattern:
      /address-taken stack local|address of a stack local is (taken|computed)|address-taken local \/ frame arithmetic/,
  },
  {
    key: 'outgoing-stack-args',
    label: 'Outgoing stack arguments (callee args 5+)',
    pattern: /outgoing stack[- ]argument/,
  },
  {
    // ABOVE `stack-frames`, which would otherwise claim these on `never stored`: a slot read on a
    // path that never writes it is not a frame the lifter cannot model but a value that does not
    // exist. `ssa.ts` spells it "never stores it" for a read and `mips.ts` "was never stored" for
    // a load.
    //
    // THE LABEL NAMES TWO CAPABILITIES BECAUSE THE MESSAGE DOES. `frontend/mips.ts` refuses with
    // "(stack-passed argument beyond the 4 register args, or an address-taken/uninitialised
    // local)" and says in its own comment that the two are separable and that the Thumb frontend
    // already separates them — O32's 16-byte home area is what stops it doing the same. Two of the
    // three rows here arrive by that spelling, so a label reading "Uninitialised locals" would
    // assert a cause the marker does not carry, and no gate could notice. The durable fix is to
    // split the refusal at the throw, where the frame arithmetic is in hand; a regex in the web app
    // is the wrong layer to decide it.
    key: 'unstored-slot',
    label: 'Slots nothing stores (an uninitialised local, or an incoming stack argument)',
    pattern: /never stores it|never stored/,
  },
  {
    // No `stack-passed` alternative, although `frontend/mips.ts` spells that phrase: its message
    // opens with "was never stored", which `unstored-slot` above claims first, so no string core
    // emits could reach it. An alternative nothing can reach is inert, and this repo refuses inert
    // refusal declarations elsewhere (`pattern/engine.ts`).
    //
    // `stack pointer used as data` is keyed on the THROW, not on the `why` the corpus printed:
    // `frontend/thumb.ts`'s one sp-as-data throw appends ten different `why`s and only two of them
    // name a capability of their own (an address-taken local and an outgoing stack-argument block,
    // both claimed above by first-match). The other eight ARE this class — a register-offset or
    // sub-word sp access that can alias a word slot, a frame that moves between two accesses keyed
    // against it, a pop that reads the frame while the local area is still reserved. Keyed on one
    // `why`, the first corpus row on any of the eight arrives unclassified.
    //
    // THE SUBJECT IS SPELT DIFFERENTLY PER FRONTEND — PPC writes `stack pointer r1 used as data`,
    // Thumb `stack pointer used as data` — so one alternative with a wildcard between "pointer"
    // and "used" reads as ISA-neutral and is not: a space on both sides requires a word there, so
    // it takes the PPC form alone.
    key: 'stack-frames',
    label: 'Local stack frames (other sp uses)',
    pattern:
      /stack pointer used as data|local stack frames not supported|spill of a live value|reload of a stack local|a slot \S+ was saved into|sub-word stack-frame/,
  },
  {
    // KEYED ON THE FIELD THE MESSAGE NAMES, because two frontends write this subject and only one
    // of them has fields to name. PowerPC has eight condition-register fields and says which one
    // it wanted (`(cr0)`, `(cr1)`); ARM/Thumb has one, so it spends the same space on the reason
    // instead. A pattern over `no reaching compare` alone caught both and filed an ARM row under a
    // label that says PPC.
    key: 'cross-block-cr',
    label: 'Cross-block condition flags (PPC cr)',
    pattern: /no reaching compare \(/,
  },
  {
    // THE ARM SIDE, and the leftovers of a capability that landed rather than one that is missing —
    // the same reading `branch-likely` below asks for. Thumb carries a compare across a run of
    // straight-line edges into blocks with one predecessor each, so what still refuses is what that
    // model leaves over, and it is exactly four shapes: two or more edges meet at the block, the
    // one predecessor is lifted after it, or the edge leaves a conditional branch or a jump-table
    // dispatch. No compiled row in the corpus reaches any of them, so the class reads 0; deleting
    // it would assert that nothing is left.
    //
    // KEYED ON THE REASON, not on the headline, and that is the whole point. The same throw fires
    // for two more subjects that no edge model would move, and both say so in their own words
    // rather than in this one:
    //   * the flags were written by ARITHMETIC, by `tst`/`cmn` or by a call — the message names
    //     the instruction and the block it sits in, and it crosses an edge unchanged, so the run
    //     of straight-line blocks between the writer and the branch does not turn it into an edge
    //     problem;
    //   * the branch's block has no predecessor at all, so there is no edge to carry anything.
    // `/no reaching compare: /` caught all three and filed them under a label that says "across an
    // edge", which is the over-claim the `stack-frames` class was fixed for. Neither of the two has
    // a row, so they stay in the residue the header paragraph names rather than take a class each.
    key: 'cross-block-flags-arm',
    label: 'Condition flags across an edge (ARM) — residual shapes only',
    pattern: /no compare crosses the edges? into /,
  },
  {
    // THE LEFTOVER SHAPES OF A CAPABILITY THAT LANDED, not a capability that is missing — the one
    // class here that a reader would otherwise misread in the worse direction. Branch-likely is
    // modelled: a likely branch nullifies its delay slot, and the slot becomes its own block on the
    // taken edge. What still refuses is what that model left over — `normaliseBranchLikely` in
    // `packages/core/src/frontend/mips.ts` on the shapes the ISA leaves undefined, and the two
    // recovered-switch interactions in `lift` ("cannot annul its delay slot", "lands on its delay
    // slot"). No compiled row in the corpus reaches any of them, so the class reads 0; deleting it
    // would assert that nothing is left, which is the opposite falsehood.
    //
    // THAT THROW HAS SEVEN ARMS AND ONLY THREE ARE SCANNED. The other four refuse a disassembly the
    // reader cannot account for — an unresolved branch target, and no instruction at the slot, at
    // the not-taken edge, or before the branch. `normaliseBranchLikely`'s own comment says
    // `parseDisasm` guarantees those by refusing a listing it cannot account for, so they are
    // plausibly unreachable by construction; nothing measures that, and a coverage claim owes its
    // whole gate list.
    key: 'branch-likely',
    label: 'Branch-likely delay slots (MIPS) — residual shapes only',
    pattern: /branch-likely/,
  },
  {
    key: 'fp-cond-branch',
    label: 'FP condition-code branches (MIPS bc1*)',
    pattern: /floating-point condition-code branch/,
  },
  {
    key: 'mips-calls',
    label: 'MIPS calls (jal/jalr)',
    pattern: /MIPS calls not yet modelled/,
  },
  {
    // Three sites spell this one gap: a surviving `gp` read (`mips.ts` `gp used as data`), a
    // relocation operand the Splat reader cannot resolve (`splat.ts` `small-data / PIC data
    // access`), and a memory base that is not a register (`ppc.ts` `SDA/global-relative`). The PPC
    // one is narrower than its wording: since #221 an SDA access that CARRIES its relocation lifts,
    // so what still reaches the throw is the `0(0)` placeholder with no relocation behind it — and
    // the two ppc.ts refusals for an SDA relocation whose operand or immediate is NOT that
    // placeholder are the same capability. Its one corpus inhabitant is `synthetic:tax_gprel`,
    // because every MIPS toolchain's canonical set turns small data off (`TOOLCHAIN_TARGETS` in
    // `packages/core/src/target.ts`: `-non_shared -G 0`, `-mno-abicalls -fno-PIC -G 0`) — a flag
    // choice rather than a shape the toolchain cannot emit. That row sets `-G 8`.
    key: 'pic-globals',
    label: 'Small-data globals (gp-relative / GPREL / an SDA base with no relocation)',
    // One alternative per producer, each the whole phrase that site emits. Bare `PIC` and bare
    // `SDA` are three upper-case letters with nothing to anchor them, and a mangled C++ symbol
    // carries substrings: `draw__3SDAFv` declining on an `stfd` would have been filed here rather
    // than as floating point. `non-register memory base` is the PPC site's EARLY anchor — its own
    // `SDA/global-relative` sits about 81 characters past the function name, so a long C++ name
    // pushes it past the 200-character cap this file opens with.
    pattern:
      /gp used as data|small-data \/ PIC data access|non-register memory base|SDA\/global-relative|carries a small-data relocation/,
  },
  {
    key: 'float',
    label: 'Floating point (FPU arithmetic, FPU loads and stores, paired singles)',
    // The alternation is anchored by the closing quote, so a bare `add\.` would require the literal
    // `add.'` and match nothing. `[\w.]+` after the dot covers the one-part (`add.s`) and two-part
    // (`c.lt.s`, `cvt.s.w`) MIPS FPU formats alike.
    //
    // THE PPC ARM IS WRITTEN AS THE ISA SPELLS THE FAMILY, NOT AS THE CORPUS HAPPENED TO PRINT IT.
    // Listing `fadd|fsub|fmul|fdiv` against a closing quote silently excludes every single-precision
    // form — `fadds`, `fsubs`, `fmuls`, `fdivs` are the ones mwcc emits for `float` arithmetic —
    // and leaves out `fneg`/`fabs` outright. PPC spells a single-precision op with a trailing `s`
    // and a record form with a trailing `.`, so both are optional suffixes here rather than
    // separate alternatives; `psq_*`/`ps_*` are the GameCube paired singles, which are floating
    // point on the same FPU.
    //
    // AND IT ADMITS THE STORE-CLASS PREFIX, or four of its alternatives are inert. `opaque.ts`
    // tests `policy.storeClass` FIRST, before anything can become an opaque, and `mips.ts` has
    // `swc1|sdc1` in that policy while `ppc.ts`'s `^st` covers `stfs`/`stfd` — so those four can
    // only ever arrive spelt "unmodelled store-class instruction", which the bare `unmodelled
    // (?:effect )?instruction '` prefix cannot reach.
    pattern:
      /unmodelled (?:effect |store-class )?instruction '(mfc1|mtc1|ctc1|cfc1|lwc1|ldc1|swc1|sdc1|(?:add|sub|mul|div|mov|neg|abs|c|cvt|trunc|round|ceil|floor|sqrt)\.[\w.]+|f(?:add|sub|mul|div|madd|msub|nmadd|nmsub|sqrt|res|rsqrte|sel|abs|nabs|neg|mr|rsp)s?\.?|fcmp\w*|fct\w*|lfd\w*|lfs\w*|stfd\w*|stfs\w*|psq_\w+|ps_[\w.]+)'/,
  },
  {
    // WHAT IS LEFT AFTER `float` TAKES ITS OWN, which in this corpus is nothing: every one of the
    // 13 markers core spells this way is a floating-point store (`stfd` 7, `swc1` 2, `sdc1` 2,
    // `stfs` 2), and `float` is listed first, so the honest floating-point number is 69 and this
    // class reads 0.
    //
    // The class stays, because the ISA policies reach further than the FPU — `mips.ts` lists
    // `sb|sh|sw|swl|swr|sc|sd|sdl|sdr` beside the FPU pair, `thumb.ts` `^(str|stm)`, `ppc.ts`
    // `^st`, so `stwbrx` or an unaligned `swl` reaches it — and because what it names is real: core
    // throws here to say a MEMORY WRITE cannot degrade to a register opaque, which is a different
    // refusal from an unresolvable value. But that is a property of the throw, not a capability to
    // build; the capability is whatever instruction it is. So the class is uninhabited, and it is
    // in `NO_ROWS` with that measurement beside it.
    key: 'store-class',
    label: 'Unmodelled store-class instructions (a non-FPU store)',
    pattern: /unmodelled store-class/,
  },
  {
    // A 64-bit value reaching an ordinary callee's argument list. `Prototypes` counts argument
    // REGISTERS, so a header's `void sink(long long)` and `void sink(int)` are the same fact by the
    // time the frontend reads them, and both answers it could give — the low half alone, or the two
    // halves as two words — recompile to the `bl` being lifted. What closes it is a parameter
    // vocabulary that carries WIDTHS across that boundary, which today only the runtime-helper
    // table has.
    key: 'wide-call-arg',
    label: 'A 64-bit value handed to a call (no width in the prototype)',
    pattern: /half of a 64-bit value/,
  },
  {
    // THE SIBLING GAP OF `opaque-ops`, and a different capability: not an instruction nobody
    // decoded, but a call into the compiler's own runtime that no recognizer folded into the
    // operation it computes. It is a REFUSAL rather than a miss — re-emitting `__div2i(a, b)` as
    // source recompiles to the `bl __div2i` it was lifted from, so the alternative is a row that
    // scores the broken candidate exactly as it scores the right one.
    //
    // Its rows are the mwcc 64-bit family: the PPC frontend does not yet read a register PAIR at a
    // call, so `raise/widehelpers.ts` declines on arity and this is what it declines to.
    key: 'runtime-helper',
    label: "Runtime-helper calls with no model (a compiler's own libcall)",
    pattern: /no model for the runtime helper/,
  },
  // BELOW `float`, ABOVE the shape classes, and both halves matter. This pattern has no mnemonic
  // filter, so it subsumes float's whole list and would swallow the largest MIPS family. And an
  // `opaque` makes its block impure, so a shape recognizer refuses and the message names the SHAPE
  // (pipeline.ts `attributeOpaques` appends the instruction) — the missing instruction model is the
  // cause, the loop shape the symptom. First-match; `declines.test.ts` pins it.
  {
    key: 'opaque-ops',
    label: 'Other unmodelled instructions (opaque)',
    // Two spellings mean this same gap: `unmodelled instruction` (the structurer's) and `unmodelled
    // effect instruction` (opaqueDest refusing one with no degradable destination — a `$zero` write,
    // a `swi`, a trap). `unmodelled store-class instruction` keeps its own class above.
    pattern: /unmodelled (?:effect )?instruction|no lowering for op/,
  },
  {
    key: 'loop-shapes',
    label: 'Loop shapes declined (multi-latch / irreducible / hazards)',
    pattern: /unrecovered back-edge|loop-recovery declined|pre-update loop variable/,
  },
  {
    // The loop IS recovered here and the values crossing its exit are what refuse: a post-loop read
    // of a temp the guarded body may never assign, and a fused guard whose exit edge carries a
    // value the post-loop copies do not reproduce on a zero-trip run. Separate from `loop-shapes`
    // because the thing to build is different — an exit-value model, not a second loop recognizer.
    key: 'loop-exit-values',
    label: 'Loop exit values (zero-trip edges / post-loop temps)',
    pattern: /post-loop read reaches a temp|do not reproduce on a zero-trip run/,
  },
  {
    // Keyed on the three producers rather than on the bare words `fall-through` and `jump-table`,
    // which are English before they are a switch: `fall-through` alone claimed `frontend/ppc.ts`'s
    // generic tail-branch refusal ("a target/fall-through that is not a block boundary"), which has
    // no switch in it. Tightening it to the phrases its three producers guarantee stopped that.
    //
    // IT DOES NOT REMOVE THE ORDERING DEPENDENCY. `jump-table target is not a block boundary` is a
    // strict SUPERSTRING of `not a block boundary`, so `frontend/ppc.ts`'s recovered-dispatch
    // refusal matches this class AND `block-boundary`, and it is attributed here only because this
    // class is listed first. The artifact cannot show it — the one `switch-shapes` row declines on
    // "the jump table's case arms do not linearize" — so `declines.test.ts` checks the overlap
    // table over core's own messages as well as over the published markers, and this pair is in it.
    //
    // ONE PRODUCER, FIVE REFUSALS, AND ONLY ONE OF THEM SAYS "linearize". `structure/structure.ts`
    // also refuses cases sharing a target block with differing phi args, a case running on into the
    // next where the target language has no fall-through in its case statement, an arm falling
    // through into one that is not the next emitted, and the arm fallen into taking a value from
    // the switch edge that the fall-through path would re-run. Same capability, same site, so the
    // pattern carries a phrase for each rather than the one the corpus happened to print.
    //
    // The fall-through-POSITION one is keyed on the clause that opens its sentence, not on the one
    // that ends it. This file opens with the rule that a class is decided inside the first 200
    // characters of the reason, and "C fall-through only reaches the arm below" is where that
    // message ends: under a 90-character C++ name it falls past the cap and the row arrives
    // unclassified, while a short name classifies. The opening clause reaches character 34 plus
    // the function's own name. It is spelt without the word "falls" because the producer splits
    // the template there (`… falls ` + `through into an arm …`), and a phrase this file keys on has
    // to exist literally in the file that emits it, or the pin below cannot see it.
    key: 'switch-shapes',
    label: 'Switch fall-through / jump-table shapes',
    pattern:
      /case arms do not linearize|jump-table target is not a block boundary|a case body reaches|jump-table cases share a target block|a jump-table case runs on into the next case|through into an arm that is not the next one emitted|takes a value from the switch edge/,
  },
  {
    key: 'structs',
    label: 'Struct layouts (packed / overlapping)',
    pattern: /cannot recover struct|naturally aligned|overlapping fields/,
  },
  {
    key: 'sub-word-table',
    label: 'Sub-word data tables (.byte / .short / .space)',
    pattern: /sub-word data table/,
  },
  // THE LINKER'S NAMESPACE IS LARGER THAN C'S, and these five are one producer with five different
  // things to build, so they are five classes rather than one. A relocation hands the lifter a name;
  // whether any C source can spell it is decided per KIND. A pooled literal is a value the object
  // already carries and could be rendered; a function-scope static is spellable once the compiler's
  // counter suffix is dropped; a C++ entity needs a declaration seam that does not exist yet; a
  // section-relative label denotes an offset rather than an object, so nothing declares it at all.
  {
    key: 'pooled-literal',
    label: 'Compiler-pooled literals with no declaration (@NNN)',
    pattern: /anonymous constant pool entry/,
  },
  {
    key: 'tu-scoped-name',
    label: 'Function-scope statics (compiler-counter suffixes)',
    pattern: /function-scope static/,
  },
  {
    key: 'cxx-symbol',
    label: 'C++ symbols no C declaration reaches (vtables, class-scoped)',
    pattern: /C\+\+ class-scoped symbol|C\+\+ virtual table/,
  },
  {
    key: 'section-label',
    label: 'Section-relative labels (an offset, not an object)',
    pattern: /section-relative label/,
  },
  {
    // Keyed on the throw (`frontend/thumb.ts`, "literal-pool load of ${why} — not modelled") rather
    // than on the one `why` the corpus printed. Six `why`s reach it: an offset that is not spelled
    // `+N`, an offset that is not a whole word in the pool, a numeric word that is not a 32-bit
    // value, a symbolic word whose addend is not, a magnitude with a leading zero (octal to the
    // assembler), and a word that is not `symbol±offset` at all. Keying on `pool word` matched
    // three of the six, so the rest — the same capability at the same site — would arrive as
    // unclassified.
    key: 'pool-word-shape',
    label: 'Literal-pool words the reader cannot resolve',
    pattern: /literal-pool load of/,
  },
  {
    // An address arrives in halves, and every refusal here is a half arriving somewhere it cannot
    // be used: a `%hi` read as a value with no matching `%lo` to consume it, a relocation carried by
    // an instruction that is not a modelled consumer of it, a `lui` whose high half is the literal 0
    // because no relocation ever arrived for it, and a PPC `@l`/`@ha` half or data relocation whose
    // immediate is not the placeholder the linker will overwrite. Either way the printed immediate
    // is a link-time placeholder rather than the address — PR #222's law, spelt in both frontends,
    // which is why neither the key nor the label names one of them.
    key: 'reloc-halves',
    label: 'Relocated address halves (%hi / %lo, @l / @ha)',
    pattern: /high half|not a modelled consumer of it|carries a data relocation|carries the '@(?:l|ha)' half/,
  },
  {
    key: 'no-prototype-args',
    label: 'Call argument registers with no prototype',
    pattern: /has no prototype/,
  },
  {
    // The ABI destroyed the value, and nothing about the register file says so: the read has a
    // reaching definition, and it names bytes the callee overwrote. A capability rather than an
    // input error — what closes it is a model for whatever the callee left there. Its row,
    // `synthetic:llfrom`, is the case that model has to cover first: an ordinary callee returning
    // a 64-bit value leaves it in a register PAIR, and only the runtime-helper table says which
    // callees do that, so the high register reads as a destroyed one.
    key: 'clobbered-value',
    label: 'A value a call destroyed (caller-saved register read back)',
    pattern: /is read on a path where a call has destroyed it/,
  },
  // The three control-transfer gaps, ABOVE `branch-form`, which would otherwise take all of them on
  // `unmodelled control transfer`.
  {
    key: 'indirect-call',
    label: 'Indirect calls (virtual dispatch / call through a pointer)',
    pattern: /an indirect call/,
  },
  {
    // NOT "loop unrolling", although `frontend/ppc.ts` says so. Its branch denylist has one throw
    // with two arms, and the non-`bctrl`/`blrl` arm prints "CTR-counted loop or indirect branch —
    // mwcc -O4 loop unrolling is not yet supported" for ANY unmodelled `b*`. All three rows that
    // reach it are a `bctr` the switch recovery did not claim — a jump-table dispatch — and one of
    // them, `synthetic:sw_jtfall`, is a `switch` with no loop in it at all. A label taken from that
    // arm sends a reader to build loop unrolling for three dispatch rows.
    //
    // The label therefore names the disjunction the message carries, dispatch side first, because
    // that is the side the corpus inhabits. The durable fix is to split the arm at the throw, which
    // is decidable there from the mnemonic and which rewrites three published markers, so it owes a
    // whole-tier bench of its own.
    key: 'ctr-transfer',
    label: 'Branches through CTR (an unclaimed jump-table dispatch, or a CTR-counted loop)',
    // `frontend/ppc.ts` refuses a CTR loop at three sites, not one, and the other two are the ones
    // that say the trip count is unrecoverable — a `bdnz` with no reaching `mtctr`, and a body that
    // clobbers CTR. Keyed on the single spelling the artifact carried, both would arrive as
    // unclassified the first time a row reached them.
    pattern: /CTR-counted loop|without a reaching 'mtctr'|clobbers CTR/,
  },
  {
    key: 'block-boundary',
    label: 'Branch to a non-boundary address (tail branch / unrecovered target)',
    pattern: /not a block boundary/,
  },
  {
    // NOT a catch-all, and it may not become one. A pattern here reading `indirect|computed` as
    // bare lowercase words is a SECOND catch-all sitting ABOVE `other` — and `other` is the only
    // bucket the anchor watches, so whatever it absorbs goes unnamed for ever, control flow or not:
    // `sa3:ProcessOamBuffers` declines because "the address of a stack local is computed", and a
    // loop-naming refusal in `structure/structure.ts` says "rebuild a computed value inside a
    // loop". So the pattern carries one producer phrase — the MIPS and PPC frontends' denylist for
    // a branch mnemonic no frontend models — and the label names that and nothing else. Everything
    // a wider pattern would swallow falls to `other`, where the residue list names it.
    key: 'branch-form',
    label: 'Unmodelled branch forms (a control transfer no frontend models)',
    pattern: /unmodelled control transfer|not a modelled branch form/,
  },
];

export const OTHER_CLASS = { key: 'other', label: 'Other / unclassified' };

/** The decline classes exhibited by one row's asmlift markers (a row can exhibit several). */
export function declineClassesOf(r: FunctionResult): string[] {
  if (r.asmlift.outcome !== 'declined') {
    return [];
  }
  const found = new Set<string>();
  for (const m of r.asmlift.errorMarkers ?? []) {
    const cls = DECLINE_CLASSES.find((c) => c.pattern.test(m));
    found.add(cls ? cls.key : OTHER_CLASS.key);
  }
  return [...found];
}

export interface ParetoRow {
  key: string;
  label: string;
  count: number; // rows blocked (a row counts once per class it exhibits)
  examples: string[]; // up to 3 raw marker strings, for the tooltip
}

/** Rows blocked per decline class, sorted descending — the Pareto. */
export function declinePareto(rows: FunctionResult[]): ParetoRow[] {
  const acc = new Map<string, ParetoRow>();
  for (const r of rows) {
    if (r.asmlift.outcome !== 'declined') {
      continue;
    }
    for (const m of r.asmlift.errorMarkers ?? []) {
      const cls = DECLINE_CLASSES.find((c) => c.pattern.test(m));
      const key = cls?.key ?? OTHER_CLASS.key;
      const label = cls?.label ?? OTHER_CLASS.label;
      let row = acc.get(key);
      if (!row) {
        acc.set(key, (row = { key, label, count: 0, examples: [] }));
      }
    }
    // count each ROW once per class (not once per marker)
    for (const key of declineClassesOf(r)) {
      const row = acc.get(key)!;
      row.count++;
      const marker = (r.asmlift.errorMarkers ?? []).find((m) => {
        const cls = DECLINE_CLASSES.find((c) => c.pattern.test(m));
        return (cls?.key ?? OTHER_CLASS.key) === key;
      });
      if (marker && row.examples.length < 3 && !row.examples.includes(marker)) {
        row.examples.push(marker);
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.count - a.count);
}
