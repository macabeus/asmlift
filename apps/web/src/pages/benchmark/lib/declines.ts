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
// tail of a long message tests a string the artifact does not carry. 17 markers in the published
// artifact sit at that cap. The reload refusal in `packages/core/src/frontend/ppc.ts` is the shape
// that pays for it: one throw with two arms, and on `pikmin:__ct__7ActFreeFP4Piki:mwcc_233_163n`
// the second arm's "a local stack frame this frontend does not model" begins at character 199 —
// the published marker ends "which is a l". `stack-frames` keys on `a slot … was saved into`
// instead, which that message reaches at character 64. A reason opens with the function's own
// name, so a long C++ name pushes every later phrase toward the cap on its own.
//
// `declines.test.ts` classifies every marker in the committed artifact and requires "other" to be
// EMPTY — the residue this list deliberately leaves unclassified is zero rows of the artifact's
// 301 declines. That is the anchor a comment cannot be: a reworded core message, or a gap nobody
// has named, fails there by name rather than quietly enlarging a catch-all.
//
// THAT ZERO IS TRUE OF THE ARTIFACT AND NOT OF THE TOOL, and the difference is the honest residue.
// `packages/core/src` throws 118 distinct decline messages (the texts reached by
// `FrontendUnsupportedError`, `PpcUnsupportedError`, `RaiseUnsupportedError` and `StructureError`,
// harvested by taking each throw's balanced-paren argument, keeping its string-literal pieces and
// replacing every interpolation with a placeholder). 72 of them classify as "other". Some belong
// there — a `disasm.ts` "symbol not found in the disassembly" and a `format.ts` frontend mismatch
// are input errors, not capability gaps — but most are gaps nothing in the corpus has reached yet:
//
//   frontend/thumb.ts   24  ARM-mode function, raw data in the code stream, a base alignment the
//                           input does not determine, pc used as a data base, `stm` with its own
//                           base in the list, control falling off the end
//   structure.ts        15  ten more loop and post-loop naming refusals beside the two
//                           `loop-exit-values` claims, plus an unsupported terminator
//   frontend/mips.ts     9  a relocation with an addend, an address below the symbol, a missing
//                           delay slot
//   frontend/ppc.ts      8  `stwu` with update, an `@l`/`@ha` half whose immediate is not the
//                           expected placeholder, a relocation on a stack-pointer adjust
//   frontend/splat.ts    7  a data directive in the code stream, a tail call / cross-function
//                           branch, an unparsable constant expression
//   frontend/disasm.ts   7  the objdump `...` elision family
//
// Named here rather than given classes, because a class with no inhabitant and no witness row is
// the defect this file exists to remove. Two control-transfer capabilities are in that residue and
// are worth naming on their own: `frontend/mips.ts`'s "indirect jump 'jr rN' — jump tables / tail
// calls not supported" and `frontend/thumb.ts`'s "indirect/computed jump — jump tables / computed
// gotos / register tail calls". They have no rows, so they wait for one.
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
    key: 'address-taken-local',
    label: 'Address-taken stack locals (&local escapes)',
    pattern: /address-taken stack local|address of a stack local is (taken|computed)/,
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
    // `stack-passed` used to be an alternative here and could never fire: its one producer,
    // `frontend/mips.ts`'s never-stored slot load, opens with "was never stored", which
    // `uninit-local` above claims first. An alternative no string core emits can reach is inert,
    // and this repo refuses inert refusal declarations elsewhere (`pattern/engine.ts`).
    key: 'stack-frames',
    label: 'Local stack frames (other sp uses)',
    pattern:
      /stack pointer .* used as data|local stack frames not supported|spill of a live value|reload of a stack local|a slot \S+ was saved into|sub-word stack-frame/,
  },
  {
    key: 'cross-block-cr',
    label: 'Cross-block condition flags (PPC cr)',
    pattern: /no reaching compare/,
  },
  {
    // A RESIDUE of a capability that LANDED, not a capability that is missing — the one class here
    // that a reader would otherwise misread in the worse direction. Branch-likely is modelled: a
    // likely branch nullifies its delay slot, and the slot becomes its own block on the taken edge.
    // What still refuses is what that model left over — `normaliseBranchLikely` in
    // `packages/core/src/frontend/mips.ts` (the throw at :386) on the shapes the ISA leaves
    // undefined, and the two recovered-switch interactions at :642 and :647. No compiled row in the
    // corpus reaches any of them, so the class reads 0; deleting it would assert that nothing is
    // left, which is the opposite falsehood.
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
    // so what still reaches the throw is the `0(0)` placeholder with no relocation behind it. The
    // class reads 0 because the canonical IDO flags are `-non_shared -G 0` (`toolchain.ts`), which
    // is a flag choice rather than a shape the toolchain cannot emit. `declines.test.ts` carries
    // the two-line source and the flags that do emit it, measured; the row itself is still owed.
    key: 'pic-globals',
    label: 'Small-data globals (gp-relative / GPREL / an SDA base with no relocation)',
    // One alternative per producer, each the whole phrase that site emits. Bare `PIC` and bare
    // `SDA` are three upper-case letters with nothing to anchor them, and a mangled C++ symbol
    // carries substrings: `draw__3SDAFv` declining on an `stfd` would have been filed here rather
    // than as floating point. `non-register memory base` is the PPC site's EARLY anchor — its own
    // `SDA/global-relative` sits about 81 characters past the function name, so a long C++ name
    // pushes it past the 200-character cap this file opens with.
    pattern: /gp used as data|small-data \/ PIC data access|non-register memory base|SDA\/global-relative/,
  },
  {
    key: 'store-class',
    label: 'Unmodelled store-class instructions',
    pattern: /unmodelled store-class/,
  },
  {
    key: 'float',
    label: 'Floating point',
    // The alternation is anchored by the closing quote, so a bare `add\.` would require the literal
    // `add.'` and match nothing. `[\w.]+` after the dot covers the one-part (`add.s`) and two-part
    // (`c.lt.s`, `cvt.s.w`) MIPS FPU formats alike.
    //
    // THE PPC ARM IS WRITTEN AS THE ISA SPELLS THE FAMILY, NOT AS THE CORPUS HAPPENED TO PRINT IT.
    // Listing `fadd|fsub|fmul|fdiv` against a closing quote silently excludes every single-precision
    // form — `fadds`, `fsubs`, `fmuls`, `fdivs` are the ones mwcc actually emits for `float`
    // arithmetic — and `fneg`/`fabs` were absent outright, so 7 published markers over 7 rows,
    // 2 of them real ac-decomp functions, were filed as generic opaque instructions. PPC spells a
    // single-precision op with a trailing `s` and a record form with a trailing `.`, so both are
    // optional suffixes here rather than separate alternatives; `psq_*`/`ps_*` are the GameCube
    // paired singles, which are floating point on the same FPU.
    pattern:
      /unmodelled (?:effect )?instruction '(mfc1|mtc1|ctc1|cfc1|lwc1|ldc1|swc1|sdc1|(?:add|sub|mul|div|mov|neg|abs|c|cvt|trunc|round|ceil|floor|sqrt)\.[\w.]+|f(?:add|sub|mul|div|madd|msub|nmadd|nmsub|sqrt|res|rsqrte|sel|abs|nabs|neg|mr|rsp)s?\.?|fcmp\w*|fct\w*|lfd\w*|lfs\w*|stfd\w*|stfs\w*|psq_\w+|ps_[\w.]+)'/,
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
    // no switch in it, and the Pascal backend's own unrelated refusal — a BACKEND spelling inside a
    // lifting-gap taxonomy. Tightening rather than reordering removes the overlap with
    // `block-boundary` entirely, so neither class depends on where the other sits: `ppc.ts`'s
    // recovered-dispatch refusal ("jump-table target is not a block boundary") matches only this
    // one, and its conditional-branch refusal only that one.
    key: 'switch-shapes',
    label: 'Switch fall-through / jump-table shapes',
    pattern: /case arms do not linearize|jump-table target is not a block boundary|a case body reaches/,
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
    // than on the one `why` the corpus printed. Three `why`s reach it: a word that is not a symbol
    // ± offset, an offset that is not a whole word in the pool, and a word the reader cannot parse.
    // Keying on `pool word` matched only the first, so the other two — the same capability at the
    // same site — would arrive as unclassified.
    key: 'pool-word-shape',
    label: 'Literal-pool words the reader cannot resolve',
    pattern: /literal-pool load of/,
  },
  {
    // Both halves of a MIPS address are relocated, and both refusals are about a half arriving
    // somewhere it cannot be used: a `%hi` read as a value with no matching `%lo` to consume it, and
    // a relocation carried by an instruction that is not a modelled consumer of it. Either way the
    // printed immediate is a link-time placeholder rather than the address.
    key: 'reloc-halves',
    label: 'Relocated address halves (MIPS %hi / %lo)',
    pattern: /high half of|not a modelled consumer of it/,
  },
  {
    key: 'no-prototype-args',
    label: 'Call argument registers with no prototype',
    pattern: /has no prototype/,
  },
  // The three control-transfer gaps, ABOVE the `control-flow` catch-all that would otherwise take
  // all of them on `unmodelled control transfer`.
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
    // is decidable there from the mnemonic; it is not in this diff because it rewrites three
    // published markers and so owes a whole-tier bench.
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
    // NOT a catch-all, and it may not become one again. It used to read `indirect|computed` as bare
    // lowercase words, which is a SECOND catch-all sitting ABOVE `other` — and `other` is the only
    // bucket the anchor watches, so anything this absorbed went unnamed for ever. It was already
    // absorbing outside control flow: `sa3:ProcessOamBuffers` declines because "the address of a
    // stack local is computed", and a loop-naming refusal in `structure/structure.ts` says
    // "rebuild a computed value inside a loop". What is left is one producer phrase — the MIPS and
    // PPC frontends' denylist for a branch mnemonic no frontend models — so the label names that
    // and nothing else. What used to hide under it and now falls to `other` is named in the
    // residue list at the top of this file, where it can be read.
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
