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
// halves every aggregate over it. A definition may run AHEAD of its rows only by saying so
// (`pending`), and only until the first row carries it.

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
  /** an id defined AHEAD of the rows that will carry it: the construct it names is not in the
   *  corpus yet, so its detector fires on nothing and no dataset authors it. Also exempt from the
   *  "carried by a row" gate, and also kept out of the picker, where it would be a filter that
   *  matches nothing. The flag cannot outlive what it waits for: `definitionsOutOfStep` fails
   *  while a row carries a pending tag, so the PR that lands the first carrier must remove it. */
  pending?: true;
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
    id: 'switch-arms',
    label: 'Switch arm grouping and order',
    group: 'control-flow',
    evidence: 'judgement',
    summary: 'how the dispatch is grouped into arms, and in what order they are emitted',
    detail:
      'A multi-way dispatch can be spelled as one `switch` or as nested `if`/`else`, and its arms ' +
      'can be written in any order — all of them behave identically and none of them compile ' +
      'identically. An old compiler with no instruction scheduler and no block reordering pass ' +
      'lays case bodies out in SOURCE order, so the assembly fixes both the grouping and the ' +
      'sequence, and getting either wrong shifts every instruction after the first arm. The tag ' +
      'marks rows where that grouping and that order are the whole of what a recovery has to get ' +
      'right: the arithmetic, the types and the case values all agree. Floor: a `switch` in the body. Whether the original grouped its arms the way this ' +
      "row's assembly implies is a human call — the same reason `read-once` has no machine floor.",
    example: {
      c: 'switch (mode) { case 2: …  case 0: …  case 3: …  case 1: … }',
      asm: '  cmp r0, #1\n  beq .Lcase1        @ dispatch is a balanced tree\n.L4:               @ …but the BODIES are laid out 2, 0, 3, 1',
      toolchain: 'agbcc',
    },
    seeAlso: ['switch', 'comparison-tree', 'branch', 'read-once'],
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
      'The shape that makes destroying SSA cost something. Several arms of a conditional or ' +
      'switch decide the values one join reads, so the join takes one merge value per local and ' +
      'each arm hands them over on its edge. A decompiler that gives the merge and one arm the same variable ' +
      'pays nothing; for every other arm it emits a copy the source never wrote — and the compiled ' +
      'code below shows what that copy corresponds to, which is nothing: the arms already share ' +
      'registers, and the join reads its values where they lie. Reserved for bodies where MORE ' +
      'THAN ONE value is merged at the join — whether every arm decides all of them (`mergechain`) ' +
      'or each arm decides one and the rest stay live across it (`mergeif`) — and where those ' +
      'values are themselves computed rather than named already: one value, or a value the arm ' +
      'merely passes through, is coalesced by walking backward along its own edge and leaves no ' +
      'chain behind.',
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
      asm:
        '\tasr\tr0, r0, r1\t@ the shift reads the OLD b\n' +
        '\tand\tr0, r0, r3\n' +
        '\tadd\tr1, r1, #0x1\t@ b++ hoisted ABOVE the test\n' +
        '\tcmp\tr0, #0',
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
    id: 'guard-init',
    label: 'Init-first loop guard',
    group: 'control-flow',
    evidence: 'judgement',
    summary: "a counted loop's zero-trip guard tests the initialised counter, not the constant",
    detail:
      '`for (i = 0; i < n; i++)` compiles with the init ABOVE the zero-trip test, so the guard ' +
      'compares the COUNTER against the bound (`mov r4, #0` / `cmp r4, r5`). The same loop ' +
      'written `if (0 < n) { i = 0; do … }` compiles with the init behind the branch and the ' +
      'guard against the CONSTANT (`cmp r5, #0`) — and on an UNSIGNED bound the branch opcode ' +
      'changes too, because the compiler folds the unsigned `> 0` to `!= 0` (`beq` where the ' +
      'counted form gives `bcs`). Both source forms lift to the same IR — a constant has no ' +
      'position — so which one the original spelled is a judgement worth two instructions and a ' +
      'condition code, and it is the mirror of `do-while` at the TOP of the loop. The floor is ' +
      'only the necessary condition (a counter the loop itself initialises to 0); whether the ' +
      "guard's spelling is what the diff turns on stays a human call.",
    example: {
      c: 'for (i = 0; i < n; i++) { … }',
      asm: '\tmov\tr4, #0x0\n\tcmp\tr4, r5\t@ the counter against the bound, not #0\n\tbge\t.L4',
      toolchain: 'agbcc',
    },
    seeAlso: ['loop', 'do-while', 'branch', 'unsigned'],
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
  {
    id: 'float-compare',
    label: 'Floating-point comparison',
    group: 'arithmetic',
    evidence: 'codegen',
    summary: 'two floating-point values are compared',
    detail:
      'Not an integer compare with different operands. PowerPC writes the result into a CONDITION ' +
      'REGISTER FIELD as four bits — less, greater, equal, unordered — so `<` reads one bit while ' +
      '`<=` needs two and the compiler ORs them together with `cror` before branching. MIPS writes ' +
      'one FP condition flag that a separate `bc1t`/`bc1f` reads, which lets the compare and the ' +
      'branch sit far apart. On a target with no FPU the same C becomes a call to `__ltsf2` and ' +
      'friends, and that counts too: the tag is the comparison, not the unit that performs it. ' +
      'What a recovery must get right is the predicate INCLUDING its unordered case — with a NaN ' +
      'operand `a < b` and `!(a >= b)` are different answers, and they are different instructions.',
    example: {
      c: 'if (a < b) { return a; }',
      asm: '  14:\tc.lt.s\t$f14,$f0\n  1c:\tbc1fl\t30 <add_calc0+0x30>',
      toolchain: 'ido7.1',
    },
    seeAlso: ['float', 'double', 'compare', 'branch', 'runtime-helper-call'],
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
      'way, so the tag records source intent that cannot be recovered from the bytes. ' +
      'What "identical" costs is per-ISA, and worth knowing before reading a diff on one of these ' +
      'rows: ARM and MIPS spell an insert as a load, a mask, a shift, an OR and a store, while ' +
      'PowerPC has ONE instruction for the whole of it — `rlwimi` rotates the new value into ' +
      'position and writes only the bits its mask selects, leaving the rest of the word untouched. ' +
      'So the same declaration is five instructions on one row here and one on another, and the ' +
      'hand-rolled spelling compiles back to that same single instruction.',
    example: {
      c: 'struct S { u32 a : 3; u32 b : 5; };\ns->b = v;',
      asm: '   8:\tlwz\tr0,0(r3)\n   c:\trlwimi\tr0,r4,24,3,7\t@ v into bits 3–7, the rest as it was\n  10:\tstw\tr0,0(r3)',
      toolchain: 'mwcc_242_81',
    },
    seeAlso: ['mask', 'shift', 'struct', 'field'],
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
    id: 'narrow-counter',
    label: 'Narrow loop counter',
    group: 'data-types',
    evidence: 'judgement',
    summary: "the loop's induction variable is declared narrower than a register",
    detail:
      'A counter declared `s16 i` rather than `s32 i` is re-narrowed on every iteration, and the ' +
      'compiler must keep both the raw halfword and its sign-extended value live. On agbcc that ' +
      'shows up twice: the sign extension is materialised once and reused for BOTH the address ' +
      'scale and the increment, and the loop keeps its INDEX where a wide counter would have been ' +
      'strength-reduced into a pointer walk. The second effect is not register pressure — it is ' +
      'the shape of the write-back: agbcc promotes every sub-word local to a word UNSIGNED, so a ' +
      'narrow counter is written back through a LOGICAL right shift, and its loop optimiser looks ' +
      'for a basic induction variable only through a sign-extension or an ARITHMETIC shift. The ' +
      'logical one falls through, the counter is never recognised as one, and strength reduction ' +
      'never runs on it. A decompiler with no narrow local type has to spell it `s32 v` plus a ' +
      'cast at every use, which agbcc folds differently.',
    example: {
      c: 's16 i; for (i = 0; i < 10; i++) s += i;',
      asm: 'lsl r0, r1, #0x10 / asr r0, r0, #0x10 / add r2, r2, r0 / add r0, r0, #0x1',
      toolchain: 'agbcc',
    },
    seeAlso: ['narrow', 'sign-extend', 'variable-index'],
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
    id: 'reference',
    label: 'C++ reference',
    group: 'data-types',
    evidence: 'judgement',
    pending: true,
    summary: 'a C++ reference — a pointer the source never spells as one',
    detail:
      '`void f(Vec& v)` and `void f(Vec* v)` compile to the same instructions. What differs is the ' +
      'SOURCE: every use of the reference is missing a `*` or a `->`, and assigning to it writes ' +
      'THROUGH it where assigning to a pointer would rebind it. Two things do reach the object, ' +
      'which is what keeps the tag from being purely cosmetic: a reference cannot be null, so the ' +
      'null checks a careful pointer version would carry are absent, and it cannot be reseated, so ' +
      'the compiler may keep it in a register across code that would have had to reload a pointer. ' +
      'A C decompiler necessarily spells the parameter as a pointer — the same object, a different ' +
      'source, and on a C++ compile a different mangled name.',
    example: { c: 'void add(Vec& dst, const Vec& src) { dst.x += src.x; dst.y += src.y; }' },
    seeAlso: ['pointer', 'method', 'struct-return', 'struct'],
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
    id: 'local-aggregate-init',
    label: 'Local aggregate initialiser',
    group: 'data-types',
    evidence: 'source',
    pending: true,
    summary: 'an automatic local array or struct declared with a brace initialiser',
    detail:
      '`int v[4] = { 1, 2, 3, 4 };` inside a function is not a declaration the compiler can fold ' +
      'away. The initialiser is emitted once into read-only data and COPIED into the frame on ' +
      'every call, so the function carries a block move no statement wrote — and the bytes being ' +
      'copied are in a data section, not in the function. Recovering it means reading that ' +
      'section, recognising the copy as a declaration rather than as a `memcpy`, and re-emitting ' +
      'the values as an initialiser list. A struct is an aggregate too — `Vec3f v = { 0, 1, 2 };` ' +
      'takes the same copy and carries the same tag, with no array extent to give it away. Adding ' +
      '`static` to either line removes the copy entirely, because the object stops being in the ' +
      'frame: that is `static-local`.',
    example: {
      c: 'void f(void) { s16 dx[4] = { 0, -1, 0, 1 }; g(dx[k]); }',
      asm: '  lwz  r5,0(r4)      @ the four values, loaded from .rodata …\n  stw  r5,8(r1)      @ … and stored into the frame, every call',
      toolchain: 'mwcc_242_81',
    },
    seeAlso: ['static-local', 'struct-copy', 'array', 'table', 'memory'],
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
      '`default`. The other flavour is a local that no path in the function assigns at all — its ' +
      'address is handed to a callee that owns the write, so the frame word is store-less on the ' +
      'way in (`s32 v; fill(&v); return v;`). It compiles, and the compiler emits the unassigned path faithfully, so ' +
      'recovering it means being able to say "undefined here" rather than inventing a value. ' +
      'Where the local lives decides what a decompiler must not do: in a stack slot the danger ' +
      'is inventing a parameter for memory the function owns, and in a register it is inventing ' +
      'one for a callee-saved register the function never wrote.',
    example: {
      c: 'int r; switch (k) { case 0: r = a; break; case 1: r = a * 2; break; } return r + 1;',
      asm: '  14:\tb\t2c\n  18:\tlw\tv0,4(sp)   # the default arm: no store reaches here',
      toolchain: 'ido7.1',
    },
    seeAlso: ['switch', 'branch', 'load', 'store', 'stack-addr'],
  },
  {
    id: 'value-home',
    label: 'Value home',
    group: 'memory',
    evidence: 'judgement',
    summary: 'the diff is dominated by where a value lives, not what it computes',
    detail:
      'Both decompilers recover the computation; the bytes differ because the original source ' +
      'pinned a value to a home the candidate does not reproduce — a base address held in one ' +
      'register and reused at immediate offsets, a clamp that overwrites its own variable ' +
      'instead of assigning a fresh one, a value parked in a callee-saved register across a ' +
      'high-pressure region. Old compilers place values by the SPELLING of the source (a ' +
      'pointer local shares its base; a repeated absolute cast re-folds it into a fresh ' +
      'constant), so recovering the placement means recovering that spelling. ' +
      'Deliberately has NO machine-checked floor: the spellings that pin a home (pointer ' +
      'locals, in-place updates, address macros) are ordinary C that no scan can tell apart ' +
      'from incidental style.',
    example: {
      c: 'volatile u32 *dma = (volatile u32 *)0x040000d4; dma[0] = src; dma[1] = dst;',
      asm: '  ldr r2, .L3        @ .word 0x40000d4\n  str r0, [r2]\n  str r1, [r2, #0x4]   @ one base, offset stores',
      toolchain: 'agbcc',
    },
    seeAlso: ['pointer', 'struct', 'mmio', 'uninit-local'],
  },
  {
    id: 'read-once',
    label: 'Read once, above the branch',
    group: 'memory',
    evidence: 'judgement',
    summary: 'the original read a value once above a branch, where a decompiler renders the read at each use',
    detail:
      'A decompiler renders a value where it is USED. An old compiler emits a read where the ' +
      'SOURCE put it — agbcc has no instruction scheduler, and its code-hoisting pass is gated ' +
      'behind -Os while every build here is -O2, so a read SPELLED above a branch is EMITTED ' +
      'above it. (Not the converse: partial-redundancy elimination does run at -O2 and inserts a ' +
      'load into a sibling arm the source never read in, so the block a read appears in is not by ' +
      'itself proof of the block the source read in.) Recovering ' +
      'it at each use is therefore a spelling this compiler emits only for a source that read per arm: ' +
      'it costs a second load, a second pool literal for the folded address, and a live range ' +
      'short enough to change the whole allocation downstream. mwcc_242_81 keeps the placement too, ' +
      'measured rather than transferred: at its canonical flags the read spelled above the branch ' +
      'lands once in a register live across it and the read spelled per arm lands twice in the ' +
      'scratch register, two objects of different lengths. The tag marks rows where the diff ' +
      'turns on that placement alone — the computation, the types and the control flow all agree. ' +
      'No machine-checked floor: whether the source named a temp above the branch is ordinary C ' +
      'style that no scan can distinguish from an incidental one.',
    example: {
      c: 'u32 s = *gKind; if (c & 1) { *gOutA = s << 3; } else { *gOutB = s << 4; }',
      asm: '  ldr r1, .L6        @ .word 0x8057acc\n  ldrb r2, [r1]      @ read ONCE, above the branch\n  mov r1, #0x1\n  and r1, r1, r0\n  cmp r1, #0',
      toolchain: 'agbcc',
    },
    seeAlso: ['value-home', 'load', 'pointer', 'branch'],
  },
  {
    id: 'stack-addr',
    label: 'Address-taken local',
    group: 'memory',
    evidence: 'judgement',
    summary: "a local's address is taken, so the compiler must keep it in a stack slot",
    detail:
      'A local whose address escapes cannot live in a register: every assignment is a store and ' +
      'every read is a load, at the exact places the source put them. That changes the ' +
      'instruction COUNT, not just which register is named — in gcc 2.9 a store to such a slot ' +
      'also kills CSE of any pointer-based load made before it, so a value read once above the ' +
      'store and used again below it is loaded TWICE. Recovering the function means recognising ' +
      'the slot as an addressable object rather than as a spill or as an outgoing stack argument, ' +
      'which are the other two things a store to `[sp,#N]` can be. ' +
      'No machine-checked floor beyond the `&`: whether a given slot is addressable, spilled or ' +
      'an argument is exactly the judgement the tag records.',
    example: {
      c: 's32 w; u16 t = e->h; w = 32; if (t <= 31) { w = e->h; } use(&w);',
      asm:
        '  ldrh r1, [r2, #0x12]\n  mov r0, #0x20\n  str r0, [sp]      @ the store kills the load above\n' +
        '  cmp r1, #0x1f\n  bhi .L3\n  ldrh r0, [r2, #0x12]   @ re-read, not CSE-shared\n  str r0, [sp]',
      toolchain: 'agbcc',
    },
    seeAlso: ['value-home', 'uninit-local', 'multi-arg', 'store'],
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
    id: 'sda-global',
    label: 'Small-data global',
    group: 'memory',
    evidence: 'codegen',
    summary: 'a global reached through a small-data base register instead of its full address',
    detail:
      'The PowerPC EABI keeps r13 pointed at `.sdata`/`.sbss` and r2 at `.sdata2`, so a global the ' +
      'linker decided is small enough costs ONE instruction — `lwz r3,-0x6cf0(r13)` — where an ' +
      'ordinary global costs an `lis`/`addi` pair. Which globals qualify is a LINK-time decision ' +
      'the compiler only records as a relocation (`R_PPC_EMB_SDA21`), so in an unlinked object the ' +
      'offset is a placeholder and the base register is the only visible evidence. Two things a ' +
      'recovery can get wrong: reading r13 as an ordinary register invents a pointer parameter the ' +
      'source never had, and spelling the access as an ordinary global makes the compiler emit the ' +
      'two-instruction form.',
    example: {
      c: 'extern f32 gScale;\nreturn x * gScale;',
      asm: '   c:\tlfs\tf0,0(r2)\n\t\t\tc: R_PPC_EMB_SDA21\t@6',
      toolchain: 'mwcc_242_81',
    },
    seeAlso: ['global', 'load', 'store', 'value-home', 'table'],
  },
  {
    id: 'static-local',
    label: 'Static local',
    group: 'memory',
    evidence: 'source',
    summary: 'a `static` object declared inside the function body',
    detail:
      'Function SCOPE with static STORAGE: the object is not in the frame, it survives the call, ' +
      'and the compiler emits it as an ordinary datum under a name it invents to keep it private ' +
      '(`name$123` on Metrowerks, `name.0` on gcc). In the compiled code it is indistinguishable ' +
      'from a file-scope global — the scope that makes it interesting is exactly the part that is ' +
      'not in the bytes — so a decompiler can only recover WHERE the object lives, never that the ' +
      'source declared it inside the function.',
    example: {
      c: 'void f(u8 h) { static const u8 tide[] = { 1, 1, 0 }; use(tide[h]); }',
      asm: '\tldr\tr0, .L4\t@ .word tide.0 — a plain address, like any global',
      toolchain: 'agbcc',
    },
    seeAlso: ['global', 'table', 'local-aggregate-init', 'load'],
  },
  {
    id: 'static-member',
    label: 'Static data member',
    group: 'memory',
    evidence: 'judgement',
    pending: true,
    summary: "a class's static data member is read or written",
    detail:
      'File-scope storage under a class-scope NAME. In the object it is an ordinary global — a ' +
      'mangled symbol (`count__5Thing`) reached through the same relocation as any other — so the ' +
      'scope that makes it a member is the part that is not in the bytes, exactly as with ' +
      '`global`. The part that IS: an inline-initialised or template static member may be emitted ' +
      'into whichever object references it rather than into one definition, so WHICH unit owns the ' +
      'datum is not decided by the source file it appears in. ' +
      'No machine-checked floor: the mangling is the only hint the symbol gives, and a row may ' +
      'reach the member through a project accessor that mentions neither.',
    seeAlso: ['global', 'method', 'load', 'store', 'struct'],
  },
  {
    id: 'struct-copy',
    label: 'Struct copy',
    group: 'memory',
    evidence: 'judgement',
    pending: true,
    summary: 'a struct is assigned BY VALUE, and the compiler emits the copy',
    detail:
      '`*a = *b;` on a struct is not one store. The compiler emits a run of loads and stores — or ' +
      'a call to a copy helper once the struct is large enough — sized and aligned by a type that ' +
      'is nowhere in the object. Recovering it therefore means inventing a struct whose SIZE ' +
      'happens to match the run: one word short and the tail of the function shifts, one word long ' +
      'and it shifts the other way. And it means spelling the assignment as an assignment, because ' +
      'the loads and stores written out by hand are a different (legal, wrong) answer that the ' +
      'compiler will not re-fuse. ' +
      'Floor: an assignment whose right-hand side is a whole object rather than an expression. ' +
      'Whether that object is an aggregate is what no scan can decide — the types are the project’s.',
    example: {
      c: 'void set(Rect *a, const Rect *b) { *a = *b; }',
      asm: '  lwz  r0,0(r4)\n  stw  r0,0(r3)\n  lwz  r0,4(r4)\n  stw  r0,4(r3)   @ …and so on, once per word',
      toolchain: 'mwcc_242_81',
    },
    seeAlso: ['struct', 'memory', 'local-aggregate-init', 'struct-return', 'field'],
  },
  {
    id: 'new-delete',
    label: 'new / delete',
    group: 'memory',
    evidence: 'source',
    pending: true,
    summary: 'a C++ `new` or `delete` expression',
    detail:
      'One keyword, several calls. `new T` calls the allocator (`__nw__FUl`) and then the ' +
      "constructor on whatever came back — including the null check, because the operand of C++'s " +
      'placement-free `new` may be null. `new T[n]` goes through `__construct_new_array`, which ' +
      'takes the element constructor AND destructor as arguments so it can unwind. `delete` ' +
      'mirrors it, and on a polymorphic class it does not call the allocator at all: it calls the ' +
      'destructor with its hidden delete flag set and lets the destructor free the object. None ' +
      'of that sequence is in the source, and none of it is spellable in C.',
    seeAlso: ['ctor', 'dtor', 'virtual-call', 'method', 'call'],
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
  {
    id: 'device-access',
    label: 'Device access',
    group: 'memory',
    evidence: 'judgement',
    summary: 'the diff turns on a device access the recovered C left unpinned',
    detail:
      'A store to a hardware register is an EVENT, not an assignment: it must happen where the ' +
      'source put it, as many times as the source wrote it. `volatile` is what says so, and a ' +
      'decompiler that renders the access as ordinary memory hands the recompiler licence to ' +
      'move it or delete it. Both halves are observable at -O2 on agbcc, which turns on ' +
      "`flag_strict_aliasing` (toplev.c) and gcc's loop MEM-promotion: a register store whose " +
      'address is loop-invariant is hoisted into a register and written back once after the ' +
      'loop, and a register READ whose result nobody consumes is deleted outright. The tag ' +
      'marks rows whose residual TURNS ON that motion or that deletion — which is not the same ' +
      'as the residual being only that. On a row where the deletion is the whole diff the two ' +
      'coincide; where the motion is one term of a conjunction (a device store that is only ' +
      'promotable because the surrounding expression was also spelled differently) the tag still ' +
      'applies and the row is where the other terms are named and priced. ' +
      'Distinct from `mmio`/`dma`, which are derived from the ADDRESS and say only that a ' +
      'device register is referenced; this one is the judgement that the diff turns on it. ' +
      'Floor: a `volatile` in the body. Whether that access is the thing the diff turns on ' +
      'stays the judgement.',
    example: {
      c:
        '#define gDma ((volatile u32 *)0x040000d4)\n' +
        'for (i = lo; i < 32; i++) { gDma[1] = base + i * 64; gDma[2] = 0x81000020; }',
      asm:
        '  str  r0, [r5]     @ INSIDE the loop, once per iteration\n' +
        '  add  r0, r0, #0x40\n  ble  .L6\n' +
        '  @ unpinned, the same C compiles the store to AFTER the branch instead',
      toolchain: 'agbcc',
    },
    seeAlso: ['mmio', 'dma', 'value-home', 'load', 'store'],
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
      'A C++ member function: the object is the implicit first argument, which is what changes the ' +
      'calling convention. Where a row reaches the member through an `extern "C"` wrapper — the ' +
      'symbol both decompilers can spell — what is scored is the member ACCESS through that ' +
      'pointer rather than a mangled name. ' +
      "The row's `language` field records that it is C++.",
    seeAlso: ['call', 'struct', 'pointer'],
  },
  {
    id: 'virtual-call',
    label: 'Virtual call',
    group: 'calls',
    evidence: 'judgement',
    pending: true,
    summary: "a call dispatched through the object's virtual table",
    detail:
      'Two dependent loads and an indirect branch: read the vtable pointer out of the object, read ' +
      'the slot at a fixed offset in that table, call it. NOTHING here names the callee — the ' +
      'whole of what a recovery must get right is the SLOT NUMBER, and that is decided by a class ' +
      'hierarchy which appears nowhere in the object. The vtable pointer is not always at offset 0 ' +
      'either: a class deriving from a non-polymorphic base carries it after that base’s fields. ' +
      'A decompiler with no class model can only spell this as a load of a function-pointer field, ' +
      'which compiles to the same two loads exactly when its invented offsets agree with the real ' +
      'layout. ' +
      'Floor: an indirect call in the compiled code. Whether it goes through a vtable rather than a ' +
      'plain function pointer is the judgement — `fnptr` is the tag for the other answer.',
    example: {
      c: 'void tick(Obj *o) { o->draw(); }',
      asm: '   8:\tlwz\tr12,0(r3)\n   c:\tlwz\tr12,8(r12)\n  10:\tmtctr\tr12\n  14:\tbctrl',
      toolchain: 'mwcc_242_81',
    },
    seeAlso: ['fnptr', 'method', 'ctor', 'dtor', 'call'],
  },
  {
    id: 'ctor',
    label: 'Constructor',
    group: 'calls',
    evidence: 'judgement',
    pending: true,
    summary: 'a C++ constructor',
    detail:
      'A constructor is not a function whose source is all there. Before the first statement of ' +
      'its body the compiler runs the base constructors and then the member constructors in ' +
      'DECLARATION order, and on a polymorphic class it installs the vtable pointer — a store of a ' +
      '`__vt__` address into the object that no line of source corresponds to. All of that order ' +
      'comes from the class, not from the body, so a recovery that spells the initialisation as ' +
      'ordinary assignments can produce the right stores in the wrong sequence and be wrong by the ' +
      'whole prologue. ' +
      'Floor: a `Name::Name(` in the signature. Whether the constructor’s generated part is what ' +
      'the row is about stays the judgement.',
    example: { c: 'Thing::Thing(int n) { this->count = n; }' },
    seeAlso: ['dtor', 'method', 'new-delete', 'virtual-call', 'struct'],
  },
  {
    id: 'dtor',
    label: 'Destructor',
    group: 'calls',
    evidence: 'judgement',
    pending: true,
    summary: 'a C++ destructor',
    detail:
      'The mirror of `ctor` — member and base destructors run in REVERSE declaration order after ' +
      'the body — plus a parameter the source cannot see. A destructor reachable through `delete` ' +
      'takes a hidden flag saying whether to free the object as well as destroy it; Metrowerks ' +
      'passes it in the second argument register and tests it with an `extsh`. The flag is not in ' +
      'the mangled name (`__dt__6SystemFv` claims to take nothing at all), so a prototype that ' +
      'matches the CODE has to contradict the symbol that names it. ' +
      'Floor: a `~Name(` in the signature.',
    example: { c: 'System::~System() { free(this->buf); }' },
    seeAlso: ['ctor', 'method', 'new-delete', 'virtual-call'],
  },
  {
    id: 'struct-return',
    label: 'Struct returned by value',
    group: 'calls',
    evidence: 'judgement',
    pending: true,
    summary: 'a struct or class is returned BY VALUE, through a hidden pointer',
    detail:
      'No ABI here returns an aggregate in a register. The CALLER allocates the space and passes ' +
      'its address as a hidden argument ahead of every real one — which on a member function ' +
      'pushes `this` into the SECOND argument register — and the callee writes through it and ' +
      'returns it. A recovery that spells the function as returning the type gets all of that for ' +
      'free; one that spells the hidden pointer as an ordinary first parameter gets byte-identical ' +
      'code and a signature no other call site in the program can use. ' +
      'No machine-checked floor: the returned type is a project typedef, and no scan can tell ' +
      '`Vec3f f(void)` from `u32 f(void)`.',
    seeAlso: ['multi-arg', 'method', 'struct', 'struct-copy', 'reference'],
  },
  {
    id: 'hw-float-abi',
    label: 'Hardware float ABI',
    group: 'calls',
    evidence: 'judgement',
    pending: true,
    summary: 'floating-point arguments and results travel in floating-point registers',
    detail:
      'A target with an FPU has a SECOND register file in its calling convention: PowerPC passes ' +
      'floats in f1–f8 and returns in f1, MIPS passes $f12/$f14 and returns in $f0, and no ' +
      'general-purpose register is involved at all. The GBA has no FPU, so the same C passes the ' +
      'same values as integers and calls a helper to add them. That makes the float TYPE ' +
      'load-bearing in a way it is not elsewhere: a decompiler that reads a parameter as an ' +
      'integer does not merely name it wrongly, it passes it in the wrong register file, and ' +
      'every call site moves. ' +
      'Floor: a floating-point type in the signature. Whether the ABI is what the diff turns on ' +
      'stays the judgement.',
    example: { c: 'f32 lerp(f32 a, f32 b, f32 t) { return a + (b - a) * t; }' },
    seeAlso: ['float', 'double', 'float-callee-save', 'runtime-helper-call', 'multi-arg'],
  },
  {
    id: 'inlined-callee',
    label: 'Inlined callee',
    group: 'calls',
    evidence: 'judgement',
    pending: true,
    summary: 'a call the source spells that the compiler expanded in place',
    detail:
      'The source says `fabsf(x)`, or calls a small static helper in the same unit, and the object ' +
      'contains no call — the callee’s body is sitting in the middle of this one. The decompiler ' +
      'sees only that body, and both ways of writing it back can be wrong: spell the expansion and ' +
      'the code is right but the source is a paraphrase no one would maintain; spell the call and ' +
      'it only reproduces the bytes if the recompile can SEE the same definition and chooses to ' +
      'inline it again. Which of those two the row is measuring is the judgement. ' +
      'Floor: the body spells at least one call for the compiler to have expanded.',
    seeAlso: ['call', 'inline-member', 'libm-call', 'macro'],
  },
  {
    id: 'runtime-helper-call',
    label: 'Runtime helper call',
    group: 'calls',
    evidence: 'codegen',
    summary: 'the compiled code calls a compiler-generated helper the source never wrote',
    detail:
      'The target has no instruction for what the C says, so the compiler calls a helper instead. ' +
      'On agbcc every floating-point OPERATOR becomes one (`__addsf3`, `__mulsf3`, `__floatsisf`, ' +
      '`__fixsfsi`) and so does every 64-bit shift or multiply (`__ashrdi3`, `__muldi3`); ' +
      'Metrowerks spells the same idea `__shl2i`, `__cvt_fp2unsigned`, `__va_arg`. Recovering the ' +
      'function means folding the call back into the operator — leave it and the output calls a ' +
      'function no header declares, which is the one kind of wrong answer that will not even ' +
      'compile. The four DIVISION helpers are excluded on purpose: `soft-div` names them and says ' +
      'more about the same call, so the two tags partition the runtime instead of doubling up. ' +
      'Only a call the assembly NAMES can be seen, which on MIPS is none of them — the same limit ' +
      '`call` documents.',
    example: {
      c: 'float f(float a, float b) { return a + b; }',
      asm: '\tbl\t__addsf3',
      toolchain: 'agbcc',
    },
    seeAlso: ['soft-div', 'call', 'float', 'int64', 'libm-call'],
  },
  {
    id: 'libm-call',
    label: 'Maths library call',
    group: 'calls',
    evidence: 'codegen',
    pending: true,
    summary: 'the compiled code calls the C maths library — `sin`, `sqrt`, `fmod` and friends',
    detail:
      'The mirror image of `runtime-helper-call`: a libm function is something the SOURCE asked ' +
      'for, so the recovery has to SPELL the call rather than fold it away. What makes it a ' +
      'measurement rather than a formality is everything around it — projects reach these through ' +
      'their own wrappers and macros (`sind`, `cosd`), the arguments are widened to `double` and ' +
      'the result narrowed back by conversions the source never wrote, and a compiler is free to ' +
      'expand some of them inline instead, so that `fabsf` leaves two instructions and no call at ' +
      'all. The tag is read off the callee NAME and nothing else, so a project function of its own ' +
      'called `log`, `pow` or `floor` carries it and should not — the names the standard claims are ' +
      'ordinary enough that a decomp reuses them.',
    seeAlso: ['call', 'runtime-helper-call', 'inlined-callee', 'float', 'double'],
  },
  {
    id: 'savegpr-helper',
    label: 'Out-of-line register save',
    group: 'calls',
    evidence: 'codegen',
    summary: 'the prologue saves registers by CALLING `_savegpr_NN` instead of storing them inline',
    detail:
      'A function that uses many callee-saved registers pays a `stw` per register on entry and an ' +
      '`lwz` per register on exit. Optimising for SIZE, the PowerPC EABI compiler replaces both ' +
      'runs with one call each into a shared ladder of stores (`_savegpr_25` stores r25 upward, ' +
      '`_restgpr_25` reloads them), and Gekko adds `_savefpr_`/`_restfpr_` for the FP half. Two ' +
      'consequences for a recovery: the function CALLS something before its first statement, so ' +
      'the call graph gains an edge the source has no line for, and the choice is driven purely ' +
      'by how many registers the body ends up needing — which is decided by the spelling of the ' +
      'body, not by anything local to the prologue.',
    example: {
      c: 'for (i = 0; i < n; i++) { s += a[i] * b[i]; }',
      asm: '  10:\tbl\t10 <dotprod+0x10>\n\t\t\t10: R_PPC_REL24\t_savegpr_25',
      toolchain: 'mwcc_242_81',
    },
    seeAlso: ['call', 'float-callee-save', 'runtime-helper-call', 'value-home'],
  },
  {
    id: 'float-callee-save',
    label: 'Float callee-save',
    group: 'calls',
    evidence: 'codegen',
    summary: 'callee-saved floating-point registers are written to the frame and restored',
    detail:
      'A float value that has to stay live across a call cannot sit in a volatile register, so the ' +
      "function borrows one of the ABI's callee-saved FP registers — PowerPC f14–f31, MIPS " +
      '$f20–$f31 — and owes the caller a save and a restore for it. That makes the tag a PRESSURE ' +
      'signal rather than a source construct: the same C compiles with none of it when the float ' +
      'values do not outlive a call, so what the prologue saves is evidence about how the source ' +
      'arranged its values. On Gekko the save is often `psq_st`, a paired-single store, which an ' +
      'objdump given no `-M gekko` decodes as POWER vector instructions that have nothing to do ' +
      'with this code.',
    example: {
      c: 'f32 g(f32 a, f32 b) { f32 t = a * b; h(); return t; }',
      asm: '   4:\tsdc1\t$f20,16(sp)\n  ...\n  40:\tldc1\t$f20,16(sp)',
      toolchain: 'ido7.1',
    },
    seeAlso: ['float', 'call', 'savegpr-helper', 'value-home'],
  },
  {
    id: 'vararg-call',
    label: 'Variadic call',
    group: 'calls',
    evidence: 'codegen',
    pending: true,
    summary: 'a call to a variadic function, marked by the PowerPC EABI’s CR bit 6',
    detail:
      'A variadic callee cannot know from its arguments whether any float arrived in an FP ' +
      'register, so the PowerPC EABI has the CALLER say so out of band: `crset 4*cr1+eq` if a ' +
      'float was passed, `crclr 4*cr1+eq` if not — and one of the two is emitted at EVERY variadic ' +
      'call, including calls that pass nothing but integers. Two instructions that no construct in ' +
      'the source explains, at a site that looks like any other call. Whether they appear is ' +
      "decided by the CALLEE's declaration, so recovering the call means having the right " +
      'prototype and not merely the right arguments.',
    seeAlso: ['varargs-def', 'call', 'multi-arg', 'float'],
  },
  {
    id: 'varargs-def',
    label: 'Variadic definition',
    group: 'calls',
    evidence: 'source',
    pending: true,
    summary: 'the function itself is variadic — its parameter list ends in `...`',
    detail:
      'The definition side of the same ABI. `va_start` has to walk the arguments as MEMORY, so a ' +
      'variadic function begins by spilling the whole argument register file into a save area: on ' +
      'PowerPC the integer registers r3–r10 unconditionally, and the FP registers f1–f8 behind a ' +
      "branch on the caller's CR bit 6, because storing eight doubles nobody passed would be eight " +
      'wasted stores on every call. That prologue can be larger than the function, it is implied ' +
      'entirely by the `...`, and a recovery that omits the ellipsis produces none of it.',
    seeAlso: ['vararg-call', 'multi-arg', 'call', 'stack-addr'],
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
    seeAlso: ['baseline', 'inline-member'],
  },
  {
    id: 'inline-member',
    label: 'Inline member',
    group: 'meta',
    evidence: 'judgement',
    pending: true,
    summary: 'a header-defined member function, expanded into the body, is what the diff turns on',
    detail:
      'C++ game code spells its accessors, its operators and its small helpers as inline member ' +
      'functions in headers, and the compiler expands every one of them. What reaches the object ' +
      'is the EXPANSION, and the expansion carries decisions the caller’s source does not: which ' +
      'field an `operator+` reads first, whether a getter is one load or a load and a mask, how a ' +
      'chain of them folds. A decompiler reading only the caller can reproduce the instructions ' +
      'and still not be able to spell the source, because the source is in a header it is not ' +
      'reading. The C++ sibling of `macro`, and distinct from `inlined-callee`: that one is a call ' +
      'the compiler chose to expand, this one is code that was never going to be a call. ' +
      'No machine-checked floor: an expanded accessor and hand-written field arithmetic are the ' +
      'same text.',
    seeAlso: ['macro', 'method', 'inlined-callee', 'field', 'struct'],
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

/** The tags a reader can filter on. A `deprecated` id names something the dataset no longer has and
 *  a `pending` one something it does not have YET, so offering either is offering an empty filter. */
export const PICKABLE_FEATURES: readonly FeatureDef[] = FEATURES.filter((f) => !f.deprecated && !f.pending);

/** Where the definitions and the tags the rows publish contradict each other — both directions, so
 *  neither a dead definition nor a stale flag can sit there unnoticed:
 *
 *   - a live definition NO row carries. The picker would offer a filter that matches nothing, and
 *     the drawer would define a shape the benchmark cannot show. Say `pending` if the rows are
 *     coming, `deprecated` if they are gone; silence is the one thing this refuses.
 *   - a `pending` definition a row DOES carry. The tag has arrived, so the flag is now a lie: it
 *     hides the id from the picker that should be offering it. */
export function definitionsOutOfStep(published: ReadonlySet<string>, defs: readonly FeatureDef[] = FEATURES): string[] {
  return defs
    .flatMap((f) => {
      if (f.deprecated) {
        return [];
      }
      if (f.pending) {
        return published.has(f.id) ? [`${f.id}: marked pending, but rows carry it — drop the flag`] : [];
      }
      return published.has(f.id) ? [] : [`${f.id}: defined, but no row carries it`];
    })
    .sort();
}

/** The ids of one evidence kind — the producer's detectors and validators are keyed off these. A
 *  `pending` id is INCLUDED: its detector or floor has to be wired before the rows arrive, or the
 *  first row carrying it would publish a tag nothing checks. */
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
