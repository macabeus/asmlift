// The closed feature vocabulary: every tag a benchmark row may carry, defined once for the producer
// (apps/benchmark, which derives and validates them) and the consumer (apps/web, which renders them
// in the filter picker and the definition drawer). It lives here because apps/web cannot import
// apps/benchmark. Data only — no I/O, no dependencies, browser-safe.
//
// Two orthogonal axes: `evidence` is how a tag is established, `group` is what kind of construct it
// names. A jump table is control flow whether or not we learned about it from the assembly.
//
// CLOSED: a published tag with no definition, or a definition carried by no row, fails
// apps/benchmark/test/features.test.ts — so a typo cannot become a silently-new category that
// halves every aggregate over it.

export type FeatureGroup = 'control-flow' | 'arithmetic' | 'data-types' | 'memory' | 'calls' | 'meta';

export type EvidenceKind =
  /** decided from the function's own C source, derived per row */
  | 'source'
  /** decided from the row's compiled reference assembly, derived per row */
  | 'codegen'
  /** a human call, authored in the dataset and held to a necessary condition */
  | 'judgement';

export const FEATURE_GROUP_LABEL: Record<FeatureGroup, string> = {
  'control-flow': 'Control flow',
  arithmetic: 'Arithmetic',
  'data-types': 'Data & types',
  memory: 'Memory',
  calls: 'Calls',
  meta: 'Meta',
};

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  source: 'checked from the source',
  codegen: 'derived from the compiled code',
  judgement: 'human judgement',
};

export interface FeatureExample {
  /** the C construct the tag names */
  c: string;
  /** what it compiles to, when the tag is a claim about codegen */
  asm?: string;
  /** which toolchain produced `asm` */
  toolchain?: string;
}

export interface FeatureDef {
  id: string;
  /** human title for the picker and the definition drawer */
  label: string;
  group: FeatureGroup;
  evidence: EvidenceKind;
  /** one line — the picker subtitle and the chip tooltip */
  summary: string;
  /** the definition drawer's prose */
  detail?: string;
  example?: FeatureExample;
  /** related ids, rendered as links in the definition drawer */
  seeAlso?: string[];
  /** a retired id, kept only so an archived dataset stays readable. Exempt from the
   *  "every definition is carried by a row" gate; never offered in the picker. */
  deprecated?: true;
}

export const FEATURES: readonly FeatureDef[] = [
  // ── control flow ────────────────────────────────────────────────────────────────────────────
  {
    id: 'branch',
    label: 'Conditional branch',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'conditional control flow is a point of the function',
    detail:
      'Reserved for functions whose shape is decided by conditionals — not every function that ' +
      'happens to contain an `if`. The floor rejects bodies with no conditional construct and no ' +
      'conditional branch in the compiled code.',
    seeAlso: ['compare', 'ternary', 'branchless', 'switch'],
  },
  {
    id: 'compare',
    label: 'Comparison',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'the function is essentially a comparison',
    seeAlso: ['branch', 'bool', 'branchless'],
  },
  {
    id: 'bool',
    label: 'Boolean result',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'a truth value is produced, not merely tested',
    detail:
      'The distinction that matters for recovery: a compiler may materialize a boolean without ' +
      'branching (`slt`, `setcc`), so a boolean-returning function often has no control flow at ' +
      'all in its compiled form.',
    seeAlso: ['compare', 'branchless'],
  },
  {
    id: 'ternary',
    label: 'Ternary',
    group: 'control-flow',
    evidence: 'source',
    summary: 'a `?:` conditional expression appears in the body',
    seeAlso: ['branch', 'branchless'],
  },
  {
    id: 'switch',
    label: 'Switch',
    group: 'control-flow',
    evidence: 'source',
    summary: 'a `switch` statement appears in the body',
    detail:
      'What a switch BECOMES is a separate, per-toolchain question — see `jump-table` and ' +
      "`comparison-tree`, which are derived from each row's own assembly rather than authored.",
    seeAlso: ['jump-table', 'comparison-tree', 'dense', 'sparse', 'fallthrough'],
  },
  {
    id: 'dense',
    label: 'Dense case range',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'switch labels are contiguous, inviting a jump table',
    seeAlso: ['switch', 'sparse', 'jump-table'],
  },
  {
    id: 'sparse',
    label: 'Sparse case range',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'switch labels are scattered, inviting compare-and-branch',
    seeAlso: ['switch', 'dense', 'comparison-tree'],
  },
  {
    id: 'fallthrough',
    label: 'Case fall-through',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'a switch case falls through into the next',
    detail:
      'A shape structuring must reproduce exactly: recovering fall-through as duplicated bodies ' +
      'compiles to different code, so this is a common source of declines rather than diffs.',
    seeAlso: ['switch', 'goto'],
  },
  {
    id: 'merge-chain',
    label: 'Merged value chain',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'several values are decided by several arms and merged at one join',
    detail:
      'The shape that makes destroying SSA cost something. Each arm of a conditional or switch ' +
      'decides the same set of locals, so the join takes one merge value per local and every arm ' +
      'hands them over on its edge. A decompiler that gives the merge and one arm the same variable ' +
      'pays nothing; for every other arm it emits a copy the source never wrote — and the compiled ' +
      'code below shows what that copy corresponds to, which is nothing: the arms already share ' +
      'registers, and the join reads its values where they lie. Reserved for bodies where the arms ' +
      'decide MORE THAN ONE value, and where those values are themselves computed rather than ' +
      'named already — one value, or a value the arm merely passes through, is coalesced by ' +
      'walking backward along its own edge and leaves no chain behind.',
    example: {
      c:
        'int x, y, z;\n' +
        'switch (s) {\n' +
        '  case 0: x = p[0] > 31 ? 32 : p[0]; y = p[1] > 31 ? 32 : p[1]; z = p[2] > 31 ? 32 : p[2]; break;\n' +
        '  case 1: x = p[3] > 15 ? 16 : p[3]; y = p[4] > 15 ? 16 : p[4]; z = p[5] > 15 ? 16 : p[5]; break;\n' +
        '  default: x = p[6] > 7 ? 8 : p[6]; y = p[7] > 7 ? 8 : p[7]; z = p[8] > 7 ? 8 : p[8]; break;\n' +
        '}\n' +
        'return x * 100 + y * 10 + z;',
      // The dataset's `mergechain`, abridged at the `@ …` marks: each arm's clamp is a
      // `cmp`/`ble`/`mov` the point does not need. What the point DOES need is the register
      // numbers — every arm lands x in r4, y in r3, z in r2, and the join reads them where they
      // already are. There is no instruction here for a decompiler's copies to correspond to.
      asm:
        '.L4:\t\t\t\t@ case 0 → x in r4, y in r3, z in r2\n' +
        '\tldr\tr4, [r1]\n' +
        '\t\t\t\t@ …\n' +
        '\tldr\tr3, [r1, #0x4]\n' +
        '\t\t\t\t@ …\n' +
        '\tldr\tr2, [r1, #0x8]\n' +
        '\t\t\t\t@ …\n' +
        '\tb\t.L3\n' +
        '.L8:\t\t\t\t@ case 1 → THE SAME THREE registers\n' +
        '\tldr\tr4, [r1, #0xc]\n' +
        '\t\t\t\t@ …\n' +
        '\tldr\tr3, [r1, #0x10]\n' +
        '\t\t\t\t@ …\n' +
        '\tldr\tr2, [r1, #0x14]\n' +
        '\t\t\t\t@ …\n' +
        '.L3:\t\t\t\t@ the join READS r4/r3/r2 — not one copy anywhere\n' +
        '\tmov\tr0, #0x64\n' +
        '\tmul\tr0, r0, r4\n' +
        '\tlsl\tr1, r3, #0x2\n' +
        '\tadd\tr1, r1, r3\n' +
        '\tlsl\tr1, r1, #0x1\n' +
        '\tadd\tr0, r0, r1\n' +
        '\tadd\tr0, r0, r2',
      toolchain: 'agbcc',
    },
    seeAlso: ['branch', 'switch', 'uninit-local'],
  },
  {
    id: 'goto',
    label: 'Goto',
    group: 'control-flow',
    evidence: 'source',
    summary: 'a `goto` appears in the body',
    seeAlso: ['loop', 'fallthrough'],
  },
  {
    id: 'loop',
    label: 'Loop',
    group: 'control-flow',
    evidence: 'source',
    summary: 'a `for`, `while`, or real do-while loop appears in the body',
    detail: '`do { … } while (0)` does NOT count: it is a macro idiom with no back edge.',
    seeAlso: ['nested-loop', 'do-while', 'break', 'continue'],
  },
  {
    id: 'do-while',
    label: 'Do-while loop',
    group: 'control-flow',
    evidence: 'source',
    summary: 'a `do { … } while (cond)` loop, where cond is not the literal 0',
    detail:
      'Distinguished because it is the one loop shape whose condition sits at the BOTTOM, which is ' +
      'also what a `for`/`while` loop becomes after the compiler rotates it — so recovering the ' +
      'original spelling is a real decision, not a formatting one.',
    seeAlso: ['loop'],
  },
  {
    id: 'short-circuit',
    label: 'Short-circuit condition',
    group: 'control-flow',
    evidence: 'source',
    summary: 'an `&&`/`||` that decides a BRANCH rather than producing a value',
    detail:
      'Two comparisons that share a target, with nothing between them — the second only runs when ' +
      'the first did not already settle the question. There is no merged value anywhere to anchor ' +
      'the recovery: the whole construct is edges, and a compiler is free to reorder the arms and ' +
      'invert the senses that spell it. The same shape appears as a loop test, where C has no ' +
      'spelling that avoids repeating the condition, and as a guard whose arms both leave the ' +
      'function. Reserved for the CONTROL-FLOW form; `return a && b` is a value-producing diamond ' +
      'with a merged boolean and is a different recovery.',
    example: {
      c: 'if (a && b) { p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4; } else { p[0] = -1; }',
      asm:
        '\tcmp\tr0, #0\n' +
        '\tbeq\t.L3\t@cond_branch\t@ both tests branch to the SAME arm …\n' +
        '\tcmp\tr1, #0\n' +
        '\tbeq\t.L3\t@cond_branch\t@ … and nothing runs between them\n' +
        '\tmov\tr0, #0x1\n' +
        '\tstr\tr0, [r2]\n' +
        '\tmov\tr0, #0x2\n' +
        '\tstr\tr0, [r3]\n' +
        '\t@ …\n' +
        '\tb\t.L4\n' +
        '.L3:\n' +
        '\tmov\tr0, #0x1\n' +
        '\tneg\tr0, r0\n' +
        '\tstr\tr0, [r2]',
      toolchain: 'agbcc',
    },
    seeAlso: ['branch', 'compare', 'bool', 'goto'],
  },
  {
    id: 'loop-preupdate',
    label: 'Pre-update loop value',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'a loop variable is still needed at the value it held BEFORE its own update',
    detail:
      "The compiler hoists an induction update above the loop's exit test, so the condition, the " +
      'exiting edge, or a value read after the loop wants the variable one iteration back. C can ' +
      'say it — `while (n--)`, `x >> b++`, a trailing pointer captured before the step — but only ' +
      'if the decompiler notices that the read is deliberate rather than a hazard. Reading it as a ' +
      'hazard is the safe answer and costs the whole function; reading it as post-update is a ' +
      'silent off-by-one-iteration. THREE shapes share one symptom and have different causes: the ' +
      'CONDITION reads it, the EXITING EDGE carries it, or a body value read after the loop ' +
      'derives from it.',
    example: {
      c: 'int b = 0; while (((i >> b++) & 1) == 0) ; return b;',
      asm: '\tadd\tr2, r2, #1\t@ b++ hoisted ABOVE the test that reads the old b\n\tcmp\tr1, #0',
      toolchain: 'agbcc',
    },
    seeAlso: ['loop', 'do-while', 'nested-loop'],
  },
  {
    id: 'nested-loop',
    label: 'Nested loop',
    group: 'control-flow',
    evidence: 'source',
    summary: 'a loop lexically inside another loop',
    seeAlso: ['loop'],
  },
  {
    id: 'break',
    label: 'Break',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'a `break` exits a loop or switch early',
    seeAlso: ['loop', 'continue', 'switch'],
  },
  {
    id: 'continue',
    label: 'Continue',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'a `continue` skips to the next loop iteration',
    seeAlso: ['loop', 'break'],
  },
  {
    id: 'jump-table',
    label: 'Jump table',
    group: 'control-flow',
    evidence: 'codegen',
    summary: 'a computed jump through a table (`mov pc`, `jr` on a non-link register, `bctr`)',
    detail:
      'The compiler turned a switch into an indirect jump through an address table in the data ' +
      'section. Recovering it needs the table CONTENTS, not just the instruction — which is why ' +
      "rows carrying this tag also carry the object's data dump.",
    example: {
      c: 'switch (a) { case 0: … case 1: … case 2: … }',
      asm: '\tldr\tr3, .L4\n\tmov\tpc, r3\t@ computed jump into the table below',
      toolchain: 'agbcc',
    },
    seeAlso: ['switch', 'comparison-tree', 'dense', 'table'],
  },
  {
    id: 'comparison-tree',
    label: 'Comparison tree',
    group: 'control-flow',
    evidence: 'codegen',
    summary: 'a source switch became compare-and-branch rather than a jump table',
    detail:
      'The same C, compiled for a different target or a sparser case set, produces a chain of ' +
      'compares. The pair (`jump-table`, `comparison-tree`) is exactly why codegen tags are ' +
      'derived per row: one `switch` in the dataset can be both, on different toolchains.',
    seeAlso: ['switch', 'jump-table', 'sparse'],
  },
  {
    id: 'branchless',
    label: 'Branchless',
    group: 'control-flow',
    evidence: 'codegen',
    summary: 'a source conditional produced no conditional branch',
    detail:
      'The conditional survives only as arithmetic — a set-on-less-than, a conditional move, a ' +
      'mask. Structuring has nothing to recover from the control-flow graph, so the recovery has ' +
      'to happen in the expression layer instead.',
    example: {
      c: 'return (a > 0) - (a < 0);',
      asm: '\tslt\tv0,zero,a0\n\tslt\tv1,a0,zero\n\tsubu\tv0,v0,v1',
      toolchain: 'ido7.1',
    },
    seeAlso: ['branch', 'compare', 'ternary', 'bool'],
  },

  // ── arithmetic ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'arithmetic',
    label: 'Arithmetic',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'integer arithmetic is a POINT of the function, not merely an index computation',
    detail:
      'Every function that indexes an array multiplies something. This tag is for functions where ' +
      'the arithmetic is the content, and the floor rejects bodies containing no arithmetic ' +
      'operator at all.',
    seeAlso: ['shift', 'bitwise', 'strength-reduce'],
  },
  {
    id: 'shift',
    label: 'Shift',
    group: 'arithmetic',
    evidence: 'source',
    summary: '`<<` or `>>` appears in the body',
    seeAlso: ['bitwise', 'rotate', 'mask', 'div-pow2'],
  },
  {
    id: 'bitwise',
    label: 'Bitwise',
    group: 'arithmetic',
    evidence: 'source',
    summary: '`&`, `|`, `^`, or `~` appears in the body (as an operator, not `&&`/`||`/address-of)',
    detail:
      'The operator scan requires a LEFT operand, so `&x` (address-of) and the short-circuit ' +
      '`&&`/`||` do not count — separating them is the difference between a bit-twiddling ' +
      'function and one that merely passes a pointer.',
    seeAlso: ['mask', 'shift', 'rotate', 'bitfield'],
  },
  {
    id: 'mask',
    label: 'Bit mask',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'a bit field is isolated or cleared with an AND mask',
    seeAlso: ['bitwise', 'shift', 'bitfield'],
  },
  {
    id: 'rotate',
    label: 'Rotate',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'a bit rotation, spelled in C as a shift pair',
    detail:
      'C has no rotate operator, so the source says `(x << n) | (x >> (32 - n))`. ARM folds the ' +
      'whole thing into one barrel-shifted instruction, which means the recovered spelling has to ' +
      'be re-expanded to match.',
    seeAlso: ['shift', 'bitwise'],
  },
  {
    id: 'abs',
    label: 'Absolute value',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'absolute value is computed',
    seeAlso: ['branchless', 'compare'],
  },
  {
    id: 'fixed-point',
    label: 'Fixed point',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'Q-format integer math',
    detail:
      'Integer arithmetic standing in for fractional values, with a shift as the implicit binary ' +
      'point. Dominant in GBA game code, where hardware floating point does not exist.',
    seeAlso: ['shift', 'float', 'int64'],
  },
  {
    id: 'div-const',
    label: 'Divide by a constant',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'division by a compile-time constant that is not a power of two',
    detail:
      "The probe's INTENT. What it becomes is per-toolchain and derived separately: a magic " +
      'multiply, a hardware divide, or a call to a soft-division helper. Signedness is carried by ' +
      'the `signed`/`unsigned` tags on the same row rather than baked into this id.',
    example: { c: 'return a / 7;' },
    seeAlso: ['magic-div', 'soft-div', 'hw-div', 'div-pow2', 'signed', 'unsigned'],
  },
  {
    id: 'div-pow2',
    label: 'Divide by a power of two',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'division by a constant power of two',
    detail:
      'Never a division in the compiled code. Signed division rounds toward zero, so the compiler ' +
      'emits a bias-then-shift sequence that does not look like a shift at all — recovering `/ 2` ' +
      'rather than the literal add/shift pair is the whole test.',
    example: {
      c: 'return a / 2;',
      asm: '\tmov\tr3, r0, lsr #31\n\tadd\tr0, r0, r3\n\tmov\tr0, r0, asr #1',
      toolchain: 'agbcc',
    },
    seeAlso: ['div-const', 'shift', 'strength-reduce', 'signed'],
  },
  {
    id: 'div-reg',
    label: 'Divide by a variable',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'division by a runtime value',
    detail:
      'The only divisor kind that cannot be strength-reduced, so it always reaches a real divide or a helper call.',
    seeAlso: ['soft-div', 'hw-div', 'div-const'],
  },
  {
    id: 'mod-const',
    label: 'Modulo by a constant',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'remainder by a compile-time constant that is not a power of two',
    seeAlso: ['div-const', 'magic-div', 'soft-div'],
  },
  {
    id: 'mod-pow2',
    label: 'Modulo by a power of two',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'remainder by a constant power of two',
    detail:
      'Signed remainder is not a plain AND — the sign has to be restored — which is why this is a ' +
      'separate probe from the unsigned case rather than a mask.',
    seeAlso: ['mod-const', 'mask', 'signed'],
  },
  {
    id: 'mod-reg',
    label: 'Modulo by a variable',
    group: 'arithmetic',
    evidence: 'judgement',
    summary: 'remainder by a runtime value',
    seeAlso: ['div-reg', 'soft-div', 'hw-div'],
  },
  {
    id: 'soft-div',
    label: 'Soft division',
    group: 'arithmetic',
    evidence: 'codegen',
    summary: 'the compiled code calls __divsi3/__udivsi3/__modsi3/__umodsi3',
    detail:
      'ARMv4 has no divide instruction, so agbcc calls a helper. Recovering `a / b` from a call ' +
      'means recognizing the helper by name and folding the call back into an operator — get it ' +
      'wrong and the output contains a call to a function the source never mentioned. Neither a ' +
      'hardware `div` nor the GBA BIOS division syscall counts.',
    example: { c: 'return a / b;', asm: '\tbl\t__divsi3', toolchain: 'agbcc' },
    seeAlso: ['hw-div', 'magic-div', 'div-reg', 'call'],
  },
  {
    id: 'hw-div',
    label: 'Hardware division',
    group: 'arithmetic',
    evidence: 'codegen',
    summary: 'uses a hardware divide instruction (MIPS `div`/`divu`, PPC `divw`)',
    example: { c: 'return a / 10;', asm: '\tli\tat,10\n\tdiv\tzero,a0,at\n\tmflo\tv0', toolchain: 'ido7.1' },
    seeAlso: ['soft-div', 'magic-div'],
  },
  {
    id: 'magic-div',
    label: 'Magic-number division',
    group: 'arithmetic',
    evidence: 'codegen',
    summary: 'a constant divide became a multiply-high by a magic reciprocal',
    detail:
      'The compiler replaced `/ 10` with a multiply by a magic constant and a shift. Nothing in ' +
      'the compiled code resembles a division, and the constant is a function of the divisor — ' +
      'recovering it means inverting the reciprocal, not pattern-matching a call.',
    example: {
      c: 'return a / 10;',
      asm: '\tlui\tv0,0x6666\n\tori\tv0,v0,0x6667\n\tmult\ta0,v0\n\tmfhi\tv1',
      toolchain: 'gcc2.7.2kmc',
    },
    seeAlso: ['div-const', 'mod-const', 'soft-div', 'hw-div'],
  },
  {
    id: 'strength-reduce',
    label: 'Strength reduction',
    group: 'arithmetic',
    evidence: 'codegen',
    summary: 'a constant multiply became shifts/adds rather than a multiply instruction',
    example: {
      c: 'return a * 10;',
      asm: '\tmov\tr3, r0, lsl #2\n\tadd\tr3, r3, r0\n\tmov\tr0, r3, lsl #1',
      toolchain: 'agbcc',
    },
    seeAlso: ['arithmetic', 'shift', 'div-pow2'],
  },

  // ── data & types ────────────────────────────────────────────────────────────────────────────
  {
    id: 'struct',
    label: 'Struct',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a struct type is used',
    detail:
      'Struct layout is not present in the compiled code — only offsets are. Every struct tag is ' +
      'therefore a claim that the decompiler must INVENT a type whose field offsets happen to ' +
      'match, which is why struct-carrying rows dominate the nonmatch column.',
    seeAlso: ['field', 'union', 'bitfield', 'array', 'pointer'],
  },
  {
    id: 'field',
    label: 'Field access',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a named struct/union member is accessed',
    seeAlso: ['struct', 'union', 'bitfield', 'pointer'],
  },
  {
    id: 'union',
    label: 'Union',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a union type is accessed (including through a project typedef)',
    detail:
      'Only measurable when the same bytes are reached through members of DIFFERENT width or ' +
      'domain — a union whose members are never aliased compiles identically to a struct, so the ' +
      'tag would mark a property the bytes cannot falsify.',
    example: { c: 'u->w = v;\nreturn u->h[0] + u->h[1];' },
    seeAlso: ['struct', 'bitfield', 'mixed-width'],
  },
  {
    id: 'bitfield',
    label: 'Bitfield',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a declared C bitfield (`u32 x : 2`) is read or written',
    detail:
      'A DECLARED bitfield, not a hand-rolled shift-and-mask. The compiled code is identical either ' +
      'way, so the tag records source intent that cannot be recovered from the bytes.',
    seeAlso: ['mask', 'shift', 'struct'],
  },
  {
    id: 'array',
    label: 'Array',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'an array is indexed',
    seeAlso: ['table', 'variable-index', 'pointer'],
  },
  {
    id: 'variable-index',
    label: 'Variable index',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'an array subscript is a runtime value, not a literal',
    detail:
      'A constant subscript folds into the address at compile time and leaves nothing to recover. ' +
      'A variable one leaves a scaled add, and the scale is the only surviving evidence of the ' +
      'element type.',
    seeAlso: ['array', 'table', 'struct'],
  },
  {
    id: 'table',
    label: 'Lookup table',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a constant lookup table is read with a computed index',
    detail:
      'Both halves are required: the data must be CONSTANT (a `const` array or `.rodata`), and the ' +
      'index must be COMPUTED — `gEntityInfo[0x23].unkF` is a plain field access, not a table read. ' +
      "The distinction matters because the table contents live in the object's data section, so the " +
      'decompiler must read the bytes and re-emit them as an initializer.',
    example: {
      c: 'return gSineTable[angle & 0xFF];',
      asm: '\tldr\tr3, .L2\t@ &gSineTable\n\tand\tr0, r0, #255\n\tldrh\tr0, [r3, r0, lsl #1]',
      toolchain: 'agbcc',
    },
    seeAlso: ['array', 'variable-index', 'global', 'jump-table'],
  },
  {
    id: 'cast',
    label: 'Cast',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'an explicit cast that changes the value or its width',
    seeAlso: ['narrow', 'promotion', 'sign-extend', 'zero-extend'],
  },
  {
    id: 'narrow',
    label: 'Narrowing',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a value is truncated to a smaller width',
    seeAlso: ['cast', 'mixed-width', 'promotion'],
  },
  {
    id: 'promotion',
    label: 'Integer promotion',
    group: 'data-types',
    evidence: 'judgement',
    summary: "C's implicit widening to `int` changes the result",
    detail:
      'Invisible in the source and load-bearing in the output: the compiler inserts the widening, ' +
      'so a recovered expression that omits it computes something else at the same width.',
    seeAlso: ['cast', 'narrow', 'sign-extend', 'zero-extend'],
  },
  {
    id: 'mixed-width',
    label: 'Mixed widths',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'operands of different widths meet in one expression',
    seeAlso: ['narrow', 'promotion', 'union'],
  },
  {
    id: 'sign-extend',
    label: 'Sign extension',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a signed narrow value is widened, preserving its sign',
    seeAlso: ['zero-extend', 'signed', 'promotion'],
  },
  {
    id: 'zero-extend',
    label: 'Zero extension',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'an unsigned narrow value is widened with zeroes',
    seeAlso: ['sign-extend', 'unsigned', 'promotion'],
  },
  {
    id: 'signed',
    label: 'Signed',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'signedness of the operands is load-bearing',
    detail:
      'Paired with the divisor and shift tags rather than baked into their names: `div-const` + ' +
      '`signed` is one row, `div-const` + `unsigned` another, and the two compile very ' +
      'differently. Keeping the axis separate is what makes that cross-product filterable.',
    seeAlso: ['unsigned', 'sign-extend', 'div-const', 'mod-pow2'],
  },
  {
    id: 'unsigned',
    label: 'Unsigned',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'unsignedness of the operands is load-bearing',
    seeAlso: ['signed', 'zero-extend', 'div-const'],
  },
  {
    id: 'int64',
    label: '64-bit integer',
    group: 'data-types',
    evidence: 'judgement',
    summary: '64-bit integer arithmetic',
    detail:
      'On every toolchain in the benchmark a 64-bit value occupies a register PAIR, so recovery ' +
      'has to fuse two registers into one variable and re-split them at every use.',
    seeAlso: ['arithmetic', 'mixed-width'],
  },
  {
    id: 'float',
    label: 'Floating point',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'floating-point types are used',
    seeAlso: ['double', 'fixed-point', 'int-to-float', 'float-to-int'],
  },
  {
    id: 'double',
    label: 'Double precision',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'double-precision floating point is used',
    seeAlso: ['float'],
  },
  {
    id: 'int-to-float',
    label: 'Int → float',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'an integer is converted to floating point',
    seeAlso: ['float-to-int', 'float', 'cast'],
  },
  {
    id: 'float-to-int',
    label: 'Float → int',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'a floating-point value is converted to an integer',
    seeAlso: ['int-to-float', 'float', 'cast'],
  },
  {
    id: 'matrix',
    label: 'Matrix math',
    group: 'data-types',
    evidence: 'judgement',
    summary: 'matrix math',
    seeAlso: ['array', 'nested-loop', 'fixed-point'],
  },
  {
    id: 'sizeof',
    label: 'sizeof',
    group: 'data-types',
    evidence: 'source',
    summary: 'the `sizeof` operator appears in the body',
    detail:
      'Folded to a literal before any code is emitted, so the compiled form carries no trace of ' +
      'it — the recovered spelling can only ever be the number.',
    seeAlso: ['struct', 'memory'],
  },

  // ── memory ──────────────────────────────────────────────────────────────────────────────────
  {
    id: 'memory',
    label: 'Bulk memory',
    group: 'memory',
    evidence: 'judgement',
    summary: 'bulk memory movement (copy/clear/compress), not any single load or store',
    seeAlso: ['load', 'store', 'loop'],
  },
  {
    id: 'load',
    label: 'Load',
    group: 'memory',
    evidence: 'judgement',
    summary: 'a load is the point of the function',
    seeAlso: ['store', 'memory', 'global'],
  },
  {
    id: 'store',
    label: 'Store',
    group: 'memory',
    evidence: 'judgement',
    summary: 'a store is the point of the function',
    seeAlso: ['load', 'memory', 'global'],
  },
  {
    id: 'uninit-local',
    label: 'Uninitialised local',
    group: 'memory',
    evidence: 'judgement',
    summary: 'a local is read on a path that never assigns it',
    detail:
      'A local declared with no initialiser and assigned only inside some arms of a conditional ' +
      'or a `switch`, then read at the join — the commonest source being a `switch` with no ' +
      '`default`. It compiles, and the compiler emits the unassigned path faithfully, so ' +
      'recovering it means being able to say "undefined here" rather than inventing a value. ' +
      'Where the local lives decides what a decompiler must not do: in a stack slot the danger ' +
      'is inventing a parameter for memory the function owns, and in a register it is inventing ' +
      'one for a callee-saved register the function never wrote.',
    example: {
      c: 'int r; switch (k) { case 0: r = a; break; case 1: r = a * 2; break; } return r + 1;',
      asm: '  2c:\tb\t58\n  30:\tlw\tv0,4(sp)   # the default arm: no store reaches here',
      toolchain: 'ido7.1',
    },
    seeAlso: ['switch', 'branch', 'load', 'store'],
  },
  {
    id: 'global',
    label: 'Global',
    group: 'memory',
    evidence: 'judgement',
    summary: 'a file-scope or extern variable is referenced',
    detail:
      'Deliberately has NO machine-checked floor: several projects spell globals as address ' +
      'macros (`#define gStreamPtr (*(u8**)0x03004D84)`), which emit a raw `.word` rather than a ' +
      'symbol, so no scan over source or assembly can decide the tag.',
    seeAlso: ['table', 'load', 'store', 'mmio'],
  },
  {
    id: 'pointer',
    label: 'Pointer',
    group: 'memory',
    evidence: 'judgement',
    summary: 'pointer arithmetic or dereference beyond plain member access',
    seeAlso: ['array', 'struct', 'field'],
  },
  {
    id: 'mmio',
    label: 'Memory-mapped I/O',
    group: 'memory',
    evidence: 'codegen',
    summary: 'references a hardware I/O register (0x04000000–0x040003FF)',
    detail:
      'The address range decides it, not the name. Palette RAM (0x05000000) and IWRAM ' +
      '(0x03007FF8) are hardware addresses but not I/O registers, and both were tagged `mmio` ' +
      'before the range was checked.',
    seeAlso: ['dma', 'global', 'store'],
  },
  {
    id: 'dma',
    label: 'DMA',
    group: 'memory',
    evidence: 'codegen',
    summary: 'programs the DMA registers (0x040000B0–0x040000DF)',
    seeAlso: ['mmio', 'memory'],
  },

  // ── calls ───────────────────────────────────────────────────────────────────────────────────
  {
    id: 'call',
    label: 'Call',
    group: 'calls',
    evidence: 'codegen',
    summary: 'the compiled code contains a call instruction',
    detail:
      "ANY call instruction — the callee's name is deliberately not consulted. These are unlinked " +
      'objects, so an external MIPS `jal` renders as `jal 0 <enclosing symbol>`: the callee lives ' +
      "in a relocation the harness's objdump flags do not emit, and filtering by name would " +
      'discard every real call on MIPS while keeping none.',
    seeAlso: ['fnptr', 'multi-arg', 'soft-div'],
  },
  {
    id: 'fnptr',
    label: 'Function pointer',
    group: 'calls',
    evidence: 'judgement',
    summary: 'a call through a function pointer',
    seeAlso: ['call', 'table', 'jump-table'],
  },
  {
    id: 'multi-arg',
    label: 'Many arguments',
    group: 'calls',
    evidence: 'judgement',
    summary: 'enough arguments that some are passed on the stack',
    detail:
      'Past the register-argument limit the ABI spills to the stack, and recovering the call means ' +
      'reading those slots back as arguments rather than as locals.',
    seeAlso: ['call'],
  },
  {
    id: 'method',
    label: 'C++ method',
    group: 'calls',
    evidence: 'judgement',
    summary: 'a C++ member function, with its implicit `this`',
    detail:
      'Carries the implicit `this` pointer in the first argument register and a mangled symbol ' +
      "name. The row's `language` field records that it is C++; this tag records that the " +
      'function is a MEMBER, which is what changes the calling convention.',
    seeAlso: ['call', 'struct', 'pointer'],
  },

  // ── meta ────────────────────────────────────────────────────────────────────────────────────
  {
    id: 'macro',
    label: 'Macro-shaped',
    group: 'meta',
    evidence: 'judgement',
    summary: 'a project macro is load-bearing for the shape',
    detail:
      'The source spells something as a macro that expands to code no one would write by hand. ' +
      'Recovery cannot reproduce the macro, only its expansion — so these rows measure whether ' +
      'the expansion itself is recoverable.',
    seeAlso: ['baseline'],
  },
  {
    id: 'baseline',
    label: 'Baseline',
    group: 'meta',
    evidence: 'judgement',
    summary: 'a trivial function carrying no other feature',
    detail:
      'The control group. A decompiler that cannot match these has a problem unrelated to any ' +
      'feature, so they exist to make that visible rather than to be interesting.',
  },
];

export const FEATURE_BY_ID: ReadonlyMap<string, FeatureDef> = new Map(FEATURES.map((f) => [f.id, f]));

/** Every id the vocabulary defines, including deprecated ones. */
export const KNOWN_FEATURES: ReadonlySet<string> = new Set(FEATURES.map((f) => f.id));

/** The ids of one evidence kind — the producer's detectors and validators are keyed off these. */
export function featuresByEvidence(kind: EvidenceKind): FeatureDef[] {
  return FEATURES.filter((f) => f.evidence === kind && !f.deprecated);
}

export const GROUP_ORDER: readonly FeatureGroup[] = [
  'control-flow',
  'arithmetic',
  'data-types',
  'memory',
  'calls',
  'meta',
];
