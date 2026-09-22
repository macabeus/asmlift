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
    // exist, and the `uninit-local` feature tag names it as its own gap. `ssa.ts` spells it
    // "never stores it" for a read and `mips.ts` "was never stored" for a load.
    key: 'uninit-local',
    label: 'Uninitialised locals (a slot read on a path that never stores it)',
    pattern: /never stores it|never stored/,
  },
  {
    key: 'stack-frames',
    label: 'Local stack frames (other sp uses)',
    pattern:
      /stack pointer .* used as data|local stack frames not supported|spill of a live value|reload of a stack local|a slot \S+ was saved into|sub-word stack-frame|stack-passed/,
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
    // `PIC` is bounded because it is three upper-case letters with no other anchor: unbounded, a
    // mangled C++ symbol carrying that substring would be filed as a small-data access.
    pattern: /gp used as data|\bPIC\b|small-data|SDA|global-relative/,
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
    pattern:
      /unmodelled (?:effect )?instruction '(mfc1|mtc1|ctc1|cfc1|lwc1|ldc1|swc1|sdc1|(?:add|sub|mul|div|mov|neg|abs|c|cvt|trunc|round|ceil|floor|sqrt)\.[\w.]+|fadd|fsub|fmul|fdiv|fmr|fcmp\w*|frsp|fct\w*|lfs|lfd|stfs|stfd)'/,
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
    key: 'switch-shapes',
    label: 'Switch fall-through / jump-table shapes',
    pattern: /fall-through|jump-table/,
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
    key: 'pool-word-shape',
    label: 'Literal-pool words that are not symbol ± offset',
    pattern: /literal-pool load of pool word/,
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
    key: 'ctr-loop',
    label: 'CTR-counted loops and indirect branches (mwcc -O4 unrolling)',
    pattern: /CTR-counted loop/,
  },
  {
    key: 'block-boundary',
    label: 'Branch to a non-boundary address (tail branch / unrecovered target)',
    pattern: /not a block boundary/,
  },
  {
    key: 'control-flow',
    label: 'Other unmodelled control flow',
    pattern: /unmodelled control transfer|indirect|computed/,
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
