// Thumb frontend robustness. Pins that an unmodelled instruction with a register destination is
// never SILENTLY DROPPED (stale/absent value → confidently-wrong C): like the MIPS/PPC frontends,
// Thumb degrades it to a loud `opaque`. Toolchain-free.
//
// The instruction spellings, returns and condition flags. The rest of the Thumb frontend suite is in
// thumb-stack-args, thumb-frontend, thumb-frame-objects, thumb-call-args, thumb-cmn and
// thumb-narrow-reload (.test.ts).
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';
import { dc } from './helpers';

// THE SPELLING OF AN IMMEDIATE IS NOT ITS VALUE. Two producers feed this frontend and write the
// same zero differently — agbcc's own `.s` emits `#0`, a pret-style disassembly emits `#0x0` — so an
// idiom gated on the TOKEN is silently off for a whole project. Counting the two gated shapes over
// the vendored agbcc checkouts: sa3 writes `#0` 9510 times and `#0x0` never; klonoa writes `#0` 36
// times and `#0x0` 3533.
//
// The predicate is `immEq`, a LITERAL-shape test rather than a `parseInt`, and the refusal tests
// are why: `parseInt` stops at the first character it cannot consume, so `#0b1` reads as zero — and
// at the `rsb` site that turned a loud decline into a confident negate. The `add` site cannot make
// the same promise, because a non-match there falls through to `imm()` rather than refusing; the
// last test pins what that costs instead of pretending it does not exist.
describe('an immediate idiom is keyed on the VALUE, not the spelling', () => {
  const spellings = ['#0', '#0x0', '#0X0', '#00'];

  // Not cosmetic: the copy makes both sides the SAME SSA VALUE, which is what the pattern engine
  // (`{same:'X'}`) and the structurer's pre-update loop test compare on.
  test.each(spellings)('`add rD, rS, %s` is a register copy', (n) => {
    expect(dc('f', `\tpush\t{r4, lr}\n\tadd\tr0, r1, ${n}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`).source).toBe(
      's32 f(s32 a0, s32 a1) {\n    return a1;\n}\n',
    );
  });

  // This one degrades LOUD when unrecognised — an `rsb` the arm does not claim becomes an `opaque`,
  // so the wrong spelling costs the whole function rather than one `+ 0`.
  test.each(spellings)('`rsb rD, rS, %s` is a negate', (n) => {
    expect(dc('f', `\tpush\t{r4, lr}\n\trsb\tr0, r1, ${n}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`).source).toBe(
      's32 f(s32 a0, s32 a1) {\n    return -a1;\n}\n',
    );
  });

  // REFUSALS at the `rsb` site, where a non-match declines. `parseInt` reads every one of these as
  // zero; the shape test is the only thing between them and a confident negate.
  test.each(['#0X10', '#0b1', '#0.5', '#0e5', '#0*4'])('`rsb rD, rS, %s` is not a negate', (n) => {
    const rsb = (imm: string) => `\tpush\t{r4, lr}\n\trsb\tr0, r1, ${imm}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(() => dc('f', rsb('#0'))).not.toThrow(); // control
    expect(() => dc('f', rsb(n))).toThrow(/unmodelled instruction 'rsb'/);
  });

  // CHARACTERIZATION, not an assertion of correctness. A non-match at the `add` site falls through
  // to `constVal(imm(…))`, and `imm` does not read binary — gas assembles `#0b1` as `+ 1`. Nothing
  // in any corpus spells it (105411 `#` operands, zero of this class), so the honest move is to pin
  // the gap where a reader will find it rather than leave the header claiming it cannot happen.
  test('KNOWN GAP: a binary immediate reaches the `add` lowering and is misread', () => {
    const add = (imm: string) => `\tpush\t{r4, lr}\n\tadd\tr0, r1, ${imm}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(dc('f', add('#0X1')).source).toBe('s32 f(s32 a0, s32 a1) {\n    return a1 + 1;\n}\n'); // the radix fix
    expect(dc('f', add('#0b1')).source).toBe('s32 f(s32 a0, s32 a1) {\n    return a1 + 0;\n}\n'); // gas: + 1
  });
});

// THE SAME QUESTION FOR A REGISTER ALIAS, and here it decides CONTROL FLOW rather than a value, so
// missing it does not degrade: the write is not recognised as a transfer, no terminator forms, and
// execution runs on into the next block. `readData` already treats `pc` and `r15` as one register;
// `classifyXfer` did not.
describe('a PC write is a control transfer under either spelling', () => {
  const body = (dest: string, src: string) =>
    `\tpush\t{r4, lr}\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tmov\t${dest}, ${src}\n.L1:\n\tadd\tr0, r0, #1\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
  const RETURNS =
    's32 f(s32 a0) {\n    if (a0 != 0) {\n        return a0;\n    } else {\n        return a0 + 1;\n    }\n}\n';

  test.each([
    ['pc', 'lr'],
    ['r15', 'lr'],
    ['pc', 'r14'],
    ['r15', 'r14'],
  ])('`mov %s, %s` is the return', (dest, src) => {
    expect(dc('f', body(dest, src)).source).toBe(RETURNS);
  });

  // …and a PC write that is NOT the link register is an indirect jump, which declines. Spelled
  // `r15` it used to be no transfer at all: the early return vanished and the leftover read minted
  // a phantom parameter, both silently.
  test.each(['pc', 'r15'])('`mov %s, rN` is an indirect jump, loudly', (dest) => {
    expect(() => dc('f', body(dest, 'lr'))).not.toThrow(); // control
    expect(() => dc('f', body(dest, 'r3'))).toThrow(/indirect\/computed jump/);
  });
});

// THE SAME QUESTION FOR `bx`. `classifyXfer` sees one instruction and reads every `bx rN` (and
// `pop {…, pc}`) as a return, which is only true when what it jumps to is the lr this function was
// called with. Which word a `pop` reads is a FRAME question, not a register-name one — a list is
// filled by register number, lowest address first — so a return must read the word the prologue's
// `push` saved lr in, on every path; `mov r0, #7; bx r3` jumps wherever r3 points.
describe("a return is a return only through the caller's lr, read from the frame word it was saved in", () => {
  test.each([
    ['a register nothing popped', '\tpush\t{lr}\n\tmov\tr0, #7\n\tbx\tr3\n', 'bx r3'],
    [
      'a register nothing popped, reached by a branch',
      '\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tb\t.L2\n.LCB0:\n\tbl\th\n\tpop\t{r0}\n\tbx\tr0\n.L2:\n\tmov\tr0, #7\n\tbx\tr3\n',
      'bx r3',
    ],
    [
      'a register the `pop` filled from the saved r4',
      '\tpush\t{r4, lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tb\t.L2\n.LCB0:\n\tbl\th\n.L2:\n\tpop\t{r0, r4}\n\tbx\tr0\n',
      'bx r0',
    ],
    [
      "a one-register `pop` of r4's word",
      '\tpush\t{r4, lr}\n\tmov\tr4, r0\n\tmov\tr0, #5\n\tpop\t{r0}\n\tbx\tr0\n',
      'bx r0',
    ],
    [
      'a `pop` of a local, with the release after it',
      '\tpush\t{lr}\n\tsub\tsp, #8\n\tmov\tr0, #5\n\tpop\t{r1}\n\tadd\tsp, #8\n\tbx\tr1\n',
      'bx r1',
    ],
    [
      'a list written out of order (`pop {r4, r1}` fills r1 first)',
      '\tpush\t{r4, lr}\n\tmov\tr0, #5\n\tpop\t{r4, r1}\n\tbx\tr1\n',
      'bx r1',
    ],
    [
      'a pop on only one of the paths in',
      '\tpush\t{lr}\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tpop\t{r1}\n.L1:\n\tbx\tr1\n',
      'bx r1',
    ],
    ['a `pop {pc}` of a local', '\tpush\t{lr}\n\tsub\tsp, #8\n\tmov\tr0, #5\n\tpop\t{pc}\n', 'pop {pc}'],
    // lr itself, once written: a tail jump to g with every argument register live, not a return
    [
      'lr after `mov lr, r4`',
      '\tpush\t{r4, lr}\n\tldr\tr4, .Lg\n\tmov\tlr, r4\n\tpop\t{r4}\n\tbx\tlr\n.Lg:\n\t.word\tg\n',
      'bx lr',
    ],
    ["lr a `pop {lr}` filled from r4's word", '\tpush\t{r4, lr}\n\tpop\t{lr}\n\tadd\tsp, #4\n\tbx\tlr\n', 'bx lr'],
  ])('a return through %s declines', (_, body, bx) => {
    expect(() => dc('f', body)).toThrow(
      new RegExp(`indirect/computed jump '${bx}' is not a return through the caller's lr`),
    );
  });

  test.each([
    ['`bx lr`', '\tmov\tr0, #5\n\tbx\tlr\n'],
    ['`mov pc, lr`', '\tmov\tr0, #5\n\tmov\tpc, lr\n'],
    ['`pop {rN}; bx rN`', '\tpush\t{lr}\n\tmov\tr0, #5\n\tpop\t{r1}\n\tbx\tr1\n'],
    ["agbcc's `pop {r4}; pop {r1}; bx r1`", '\tpush\t{r4, lr}\n\tmov\tr0, #5\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n'],
    // (into scratch registers: popping lr's word into a callee-saved one is a write the caller sees)
    ['`pop {r2, r3}; bx r3`', '\tpush\t{r4, lr}\n\tmov\tr0, #5\n\tpop\t{r2, r3}\n\tbx\tr3\n'],
    ['`pop {r4, pc}`', '\tpush\t{r4, lr}\n\tmov\tr0, #5\n\tpop\t{r4, pc}\n'],
    ['a pop in the block that falls into the `bx`', '\tpush\t{lr}\n\tmov\tr0, #5\n\tpop\t{r1}\n.L1:\n\tbx\tr1\n'],
    [
      'a local area released before the `pop`',
      '\tpush\t{lr}\n\tsub\tsp, #8\n\tmov\tr0, #5\n\tadd\tsp, #8\n\tpop\t{r1}\n\tbx\tr1\n',
    ],
  ])('%s is the return', (_, body) => {
    expect(dc('f', body).source).toContain('return 5;');
  });

  // A store over the saved word: the frame refuses it first (the word is above the local area), and
  // the return proof would refuse the `bx` after it too; either way it is not a return.
  test('a return through the saved word, overwritten, declines', () => {
    expect(() => dc('f', '\tpush\t{lr}\n\tmov\tr1, #0\n\tstr\tr1, [sp]\n\tpop\t{r0}\n\tbx\tr0\n')).toThrow(
      /cannot lift/,
    );
  });

  // agbcc's variadic epilogue releases the pretend-argument area between the pop and the `bx`
  // (sa3 hariisen_proj.s: `pop {r3}; add sp, sp, #0x10; bx r3`). r3 was filled from lr's word,
  // which sits below the four argument words the first `push` stored.
  test('a release of sp between the `pop` and the `bx` keeps it a return', () => {
    const body = '\tpush\t{r0, r1, r2, r3}\n\tpush\t{lr}\n\tmov\tr0, #5\n\tpop\t{r3}\n\tadd\tsp, sp, #0x10\n\tbx\tr3\n';
    expect(() => dc('f', body)).not.toThrow(/indirect\/computed jump/);
  });
});

// THE SAME QUESTION FOR A REGISTER'S CASE. GNU as accepts `R2` for `r2`; this frontend identifies
// registers by spelling, and its predicates disagreed about that — `isSpReg` folds case, the
// flag-clobber test and `isThumbReg` did not. Each thing the non-folding ones then missed was
// silently wrong C, never a decline, so they are refused once at the seam instead of folded one
// predicate at a time.
describe('a register spelled in upper case is refused, not half-modelled', () => {
  const TAIL = '\tmov\tr0, #0\n\tbx\tlr\n.Ltrue:\n\tmov\tr0, #1\n\tbx\tlr\n';

  test('an upper-case destination no longer eats its own write', () => {
    // Emitted `s32 f(s32 a0) { return a0; }` — the store to `R0` went to a register nothing reads,
    // and the `r0` the return needs was never written, so it became a parameter.
    expect(() => dc('f', '\tmov\tR0, #5\n\tbx\tlr\n')).toThrow(
      /register 'R0' in 'mov R0, #5' is spelled in upper case/,
    );
  });

  test('an upper-case destination no longer survives a compare it clobbers', () => {
    // The `add` writes the flags `bge` tests. Read as "not a register" it left the inherited
    // compare pending, and the branch folded the CALLER's operands under the `add`'s flags.
    const gone = `\tcmp\tr0, r1\n\tb\t.L2\n.L2:\n\tadd\tR2, r0, #1\n\tbge\t.Ltrue\n${TAIL}`;
    expect(() => dc('f', gone)).toThrow(/register 'R2' .* is spelled in upper case/);
  });

  test('an upper-case PC write no longer stops being a return', () => {
    expect(() => dc('f', '\tmov\tr0, #5\n\tmov\tPC, lr\n')).toThrow(/register 'PC' .* is spelled in upper case/);
  });

  test.each([
    ['a destination', '\tmov\tr0, #5\n\tbx\tlr\n'],
    ['a PC write', '\tmov\tr0, #5\n\tmov\tpc, lr\n'],
  ])('control: %s in lower case lifts', (_what, body) => {
    expect(dc('f', body).source).toContain('return 5;');
  });

  test('a SYMBOL that merely starts with a register spelling is not a register', () => {
    // The scan reads words, and a word starts at an underscore as readily as at a letter — without
    // that, `_R0` would be read as `R0` with a prefix and the call would decline.
    expect(dc('f', '\tpush\t{lr}\n\tbl\t_R0\n\tpop\t{r1}\n\tbx\tr1\n').source).toContain('_R0(');
  });
});

describe('Thumb frontend robustness (CONTRACT-AS-INVARIANT)', () => {
  test('a flag-setting instruction between a cmp and its branch declines loud', () => {
    // On Thumb-1 nearly every data-processing instruction on LOW registers writes the condition
    // flags, `s`-suffix or not (agbcc spells `adds r0,r0,r3` as `add r0,r0,r3` and the assembler
    // picks the flag-setting encoding). So the `add` below REPLACES the flags `beq` tests: folding
    // the earlier `cmp` in emitted `if (a0 != a1)` where the hardware branches on `r0 + 1 == 0`.
    // Silent wrong C — now a loud decline that names the instruction that took the flags.
    const clobbered =
      '\tcmp\tr0, r1\n\tadd\tr2, r0, #1\n\tbeq\t.Lt\n\tmov\tr0, #0\n\tbx\tlr\n.Lt:\n\tmov\tr0, #1\n\tbx\tlr\n';
    expect(() => dc('flagclobber', clobbered)).toThrow(
      "conditional branch 'beq' has no reaching compare: the flags it tests were written by 'add' in " +
        "'flagclobber', over the compare that reached it, and only a compare's are modelled",
    );

    // …and the three shapes that must NOT trip it, or the guard would cost real matches: an
    // adjacent pair, a LOAD between them (loads leave the flags alone), and a move to a HIGH
    // register.
    const folds = (mid: string) =>
      dc('ok', `\tcmp\tr0, r1\n${mid}\tbeq\t.Lt\n\tmov\tr0, #0\n\tbx\tlr\n.Lt:\n\tmov\tr0, #1\n\tbx\tlr\n`).source;
    expect(folds('')).toContain('if (a0 != a1)');
    expect(folds('\tldr\tr2, [r3]\n')).toContain('if (a0 != a1)');
    expect(folds('\tmov\tip, r2\n')).toContain('if (a0 != a1)');

    // The guard reads the DESTINATION, so only that half of the high-register form is transparent.
    // `mov r7, sl` writes no flags on the machine either — Thumb-1 takes the flag-free encoding
    // whenever EITHER operand is high — and it is a clobber here. Pinned as a DECLINE rather than
    // quietly left to a comment claiming the opposite: agbcc's callee-saved shuffling is spelled
    // exactly this way (the row this branch lifted holds seven of them), and the direction of the
    // error is what makes it sound. 405 such sites across the benchmark's 450 agbcc rows, 0 of
    // them reached with a compare still live.
    expect(() =>
      dc(
        'highsrc',
        `\tcmp\tr0, r1\n\tmov\tr7, sl\n\tbeq\t.Lt\n\tmov\tr0, #0\n\tbx\tlr\n.Lt:\n\tmov\tr0, #1\n\tbx\tlr\n`,
      ),
    ).toThrow(/the flags it tests were written by 'mov'/);
  });

  test('a CALL between a cmp and its branch declines loud — the callee left the flags', () => {
    // The `bl` instruction writes no flags, but the function it enters does: AAPCS lists N/Z/C/V as
    // corruptible across a call, so what `bge` tests here is whatever compare the callee retired
    // last. Folding the caller's `cmp` in emitted `if (a0 < a1)` — a condition on the right
    // operands and the wrong flags, which no marker reports and no reviewer can see.
    const across =
      '\tpush\t{r4, lr}\n\tcmp\tr0, r1\n\tbl\tfoo\n\tbge\t.Lt\n\tmov\tr0, #0\n\tbx\tlr\n.Lt:\n\tmov\tr0, #1\n\tbx\tlr\n';
    expect(() => dc('flagsacrosscall', across)).toThrow(
      "conditional branch 'bge' has no reaching compare: the flags it tests were written by a call in " +
        "'flagsacrosscall', over the compare that reached it, and only a compare's are modelled",
    );

    // The compare AFTER the call is the shape every compiler emits, and it must still fold. Its
    // second operand is saved into a callee-saved register BEFORE the call, which is what agbcc
    // emits and what the caller has to do: r1 is caller-saved, so comparing it after the `bl`
    // would be comparing whatever the callee left there. The frontend refuses that read outright —
    // an earlier and more basic gate than the flags — so a fixture that did it would decline on
    // the stale read and never reach the question this case is about. `foo` is declared: r1 read
    // and r0 not is a gap an undeclared arity refuses (`fallbackArgc`).
    const after =
      'flagsaftercall:\n\tpush\t{r4, lr}\n\tmov\tr4, r1\n\tbl\tfoo\n\tcmp\tr0, r4\n\tbge\t.Lt\n\tmov\tr0, #0\n\tbx\tlr\n.Lt:\n\tmov\tr0, #1\n\tbx\tlr\n';
    expect(decompile('flagsaftercall', after, ARMV4T_AGBCC, { prototypes: { foo: { params: 0 } } }).source).toContain(
      'if (',
    );
  });

  test('an unmodelled op that reaches the output FAILS LOUD (no silent wrong C)', () => {
    // `clz` (count-leading-zeros) is not modelled. If dropped, the function would return a
    // stale/absent r0; instead it emits an opaque the boundary contract rejects — loud.
    expect(() => dc('clzret', '\tclz\tr0, r0\n\tbx\tlr\n').source).toThrow();
  });

  test('a DEAD unmodelled op fails loud too — a dead DESTINATION is not a dead INSTRUCTION', () => {
    // `clz` writes r1, which is never read. That says nothing about what the instruction did to
    // memory or to system state, because `clz` here stands for "a mnemonic this frontend does not
    // model" — and the mnemonics that reach this path include real stores (see opaque-effects.test.ts).
    expect(() => dc('clzdead', '\tclz\tr1, r0\n\tadd\tr0, r0, #1\n\tbx\tlr\n').source).toThrow(
      /unmodelled instruction 'clz'/,
    );
  });

  test('a push frame op still falls through harmlessly (no spurious opaque)', () => {
    // `push {r4, lr}`'s operands are reg-list tokens (`{r4`, `lr}`), not a bare `rN` data
    // destination, so the guard skips it — frame transparency is preserved.
    expect(dc('framed', '\tpush\t{r4, lr}\n\tadd\tr0, r0, #1\n\tbx\tlr\n').source).toBe(
      's32 framed(s32 a0) {\n    return a0 + 1;\n}\n',
    );
  });

  test('an ENTRY block that is itself the loop header (tight strcpy self-loop) gets a preheader', () => {
    // The `strcpy`/`strlen`/`memset` shape: block 0 IS the loop — its first op reads a
    // loop-carried pointer (`ldrb r2,[r1]`) whose phi merges the entry PARAM with the back-edge
    // increment. Without a synthetic preheader supplying the entry operand, Braun SSA builds that
    // phi from the back-edge alone and the first read is use-before-def (a `verify` decline). The
    // preheader gives the header its forward predecessor: the loop lifts cleanly to a do-while.
    const src = decompile(
      'strcpyloop',
      'strcpyloop:\n\tldrb\tr2, [r1]\n\tstrb\tr2, [r0]\n\tadd\tr0, r0, #0x1\n\tadd\tr1, r1, #0x1\n\tcmp\tr2, #0\n\tbne\tstrcpyloop\n\tbx\tlr\n',
      ARMV4T_AGBCC,
      { prototypes: { strcpyloop: { returnsVoid: true } } },
    ).source;
    expect(src).toContain('do {');
    expect(src).toContain('} while (v0 != 0);');
    expect(src).not.toContain('ASMLIFT_ERROR'); // no decline / use-before-def
  });
});

// ARM/Thumb has ONE implicit flags register, so a block entered from exactly one predecessor starts
// with exactly the flags that predecessor left. agbcc relies on it: a function long enough to need a
// mid-function literal pool gets its `cmp` and its conditional branch separated by the `b` that
// jumps over the pool, and the branch then sits alone in a block of its own.
//
// Every refusal below is one of the two facts behind that sentence failing — the entry is not
// unique, or the edge itself writes flags — and each has its own sentence in the decline, because a
// catch-all makes several gaps look like one.
describe('the condition flags reach across a straight-line edge, and across a run of them', () => {
  const TAIL = '\tmov\tr0, #0\n\tbx\tlr\n.Ltrue:\n\tmov\tr0, #1\n\tbx\tlr\n';
  // `bge .Ltrue` folded and then structured: the sense inverts because the fall-through arm leads.
  const FOLDED = 'if (a0 < a1)';

  test('a `b` over a literal pool carries the flags to the branch on the far side', () => {
    // The agbcc shape, with the pool itself elided: `cmp`, the jump over the pool, and the `bge`
    // alone under the label the jump targets.
    expect(dc('poolsplit', `\tcmp\tr0, r1\n\tb\t.L2\n.L2:\n\tbge\t.Ltrue\n${TAIL}`).source).toContain(FOLDED);
  });

  test('a RUN of straight-line blocks carries them the whole way', () => {
    // The model is transitive: every block runs the inheritance and writes its own exit state, so
    // the chain is as long as the labels make it. Not exotic — agbcc emits `.LBB`/`.LBE`/`.LM`
    // debug labels freely, so several in a row between a compare and its branch is ordinary. An
    // audit scoped to a single edge is scoped to the wrong thing.
    const hops = `\tcmp\tr0, r1\n\tb\t.L2\n.L2:\n\tb\t.L3\n.L3:\n\tb\t.L4\n.L4:\n\tbge\t.Ltrue\n${TAIL}`;
    expect(dc('chain', hops).source).toContain(FOLDED);
    const labels = `\tcmp\tr0, r1\n.LM1:\n.LM2:\n.LM3:\n.LM4:\n\tbge\t.Ltrue\n${TAIL}`;
    expect(dc('labelrun', labels).source).toContain(FOLDED);
    // …and one clobber anywhere in the run breaks it, at the hop that did the clobbering.
    const broken = `\tcmp\tr0, r1\n\tb\t.L2\n.L2:\n\tadd\tr2, r0, #1\n\tb\t.L3\n.L3:\n\tbge\t.Ltrue\n${TAIL}`;
    expect(() => dc('chainbroken', broken)).toThrow(
      "the flags it tests were written by 'add' in '.L2', over the compare that reached it",
    );
  });

  test('a label alone between the cmp and the branch carries them too', () => {
    // Same question one edge kind over: the predecessor ends in no transfer at all and control
    // falls through the label. Nothing between the pair writes flags either way.
    expect(dc('splitcmp', `\tcmp\tr0, r1\n.L2:\n\tbge\t.Ltrue\n${TAIL}`).source).toContain(FOLDED);
  });

  test('TWO edges into the block decline — the flags need not agree on both', () => {
    // `beq` reaches .L2 with the flags of the first compare, the fall-through path with those of
    // the second. There is no single answer to inherit, and picking either is a coin toss the
    // emitted C would state as fact.
    const two = `\tcmp\tr0, r1\n\tbeq\t.L2\n\tcmp\tr0, #5\n\tb\t.L2\n.L2:\n\tbge\t.Ltrue\n${TAIL}`;
    expect(() => dc('twoedges', two)).toThrow(
      "no reaching compare: no compare crosses the edges into '.L2': 2 meet there, and the flags need not " +
        'agree on all of them',
    );
  });

  test('a compare clobbered before the predecessor ENDS does not reach the branch', () => {
    const gone = `\tcmp\tr0, r1\n\tadd\tr2, r0, #1\n\tb\t.L2\n.L2:\n\tbge\t.Ltrue\n${TAIL}`;
    // The reason CROSSES the edge: the predecessor wrote down what took the flags, and the
    // successor repeats it rather than minting one of its own. Minting one produced "no compare
    // reaches the end of its only predecessor 'clobberedinpred'" — true, and it named the edge for
    // a gap no edge model would move, then sent the reader to a block whose first instruction is
    // the `cmp` the message says is missing.
    expect(() => dc('clobberedinpred', gone)).toThrow(
      "the flags it tests were written by 'add' in 'clobberedinpred', over the compare that reached it",
    );
    // A CALL in the predecessor is the same question through a different flag-taker, and the same
    // sentence has to cross. This is the shape a reader meets first: agbcc puts the `bl` and the
    // branch either side of a `.LBB` label as readily as inside one block.
    const called = `\tpush\t{lr}\n\tcmp\tr0, r1\n\tbl\tg\n\tb\t.L2\n.L2:\n\tbge\t.Ltrue\n${TAIL}`;
    expect(() => dc('calledinpred', called)).toThrow(
      "the flags it tests were written by a call in 'calledinpred', over the compare that reached it",
    );
  });

  test('a compare clobbered AFTER it is inherited does not reach the branch either', () => {
    // The seed arrives at the block's first instruction, so the in-block clear judges it exactly as
    // it judges a compare the block made itself. Seeding at the TERMINATOR instead would skip that
    // clear and fold a compare the `add` had already overwritten.
    const gone = `\tcmp\tr0, r1\n\tb\t.L2\n.L2:\n\tadd\tr2, r0, #1\n\tbge\t.Ltrue\n${TAIL}`;
    // The whole sentence, because the part that was wrong was the part no pattern asserted: the
    // displaced compare was in the PREDECESSOR, and the message said "in its block".
    expect(() => dc('clobberedinsucc', gone)).toThrow(
      "conditional branch 'bge' has no reaching compare: the flags it tests were written by 'add' in " +
        "'.L2', over the compare that reached it, and only a compare's are modelled",
    );
  });

  test('a block whose ARITHMETIC set the flags is not a block that set none', () => {
    // The gap here is arithmetic flags, and the decline has to say so. Reporting the edge instead
    // sends the reader to build a cross-block meet that would not move either of these one inch:
    // both blocks write their own flags, so there is nothing for an edge to disagree about.
    //
    // The loop is verbatim `MultiBootWaitSendDone` (sa3, src/multi_boot.s) — the corpus shape, not
    // an invented one.
    const loop = `\tmov\tr1, #4\n.LWait:\n\tsub\tr0, r1\n\tbgt\t.LWait\n\tbx\tlr\n`;
    expect(() => dc('arithloop', loop)).toThrow(
      "conditional branch 'bgt' has no reaching compare: the flags it tests were written by 'sub' in " +
        "'.LWait', and only a compare's are modelled",
    );
    // …and with no edge in the picture at all, where blaming one is plainly absurd.
    const straight = `\tsub\tr0, r0, r1\n\tbge\t.Ltrue\n${TAIL}`;
    expect(() => dc('arithstraight', straight)).toThrow(
      "conditional branch 'bge' has no reaching compare: the flags it tests were written by 'sub' in " +
        "'arithstraight', and only a compare's are modelled",
    );
    // Stated over the vocabulary the messages use TODAY, because a negative assertion written
    // against a phrase nothing emits any more passes whatever the code does.
    for (const asm of [loop, straight]) {
      expect(() => dc('f', asm)).not.toThrow(/crosses the edges? into|predecessor/);
    }
  });

  test('`tst` writes the flags too, and the decline names it', () => {
    // It defines no register, so the destination test that judges `sub` cannot see it, and the
    // decline used to say "nothing in its block sets the flags, and its block has no predecessor
    // to inherit them from" — both clauses false of four lines of asm, and the second one sending
    // the reader to a block that does not exist. Counted over the vendored kleod, sa3, pokeemerald
    // and klonoa checkouts, 115 `.s` sites put a `tst` (99) or a `cmn` (16) on the line immediately
    // before a conditional branch — blank and comment lines skipped or not, the number is the
    // same. `cmn` is a compare ("`cmn` is a compare against the negation"); no compiler emits `tst`.
    expect(() => dc('flagonly', `\ttst\tr0, r1\n\tbne\t.Ltrue\n${TAIL}`)).toThrow(
      "conditional branch 'bne' has no reaching compare: the flags it tests were written by 'tst' " +
        "in 'flagonly', and only a compare's are modelled",
    );
    // …and a compare it displaces is not folded in behind it. This shape used to emit a
    // `cond_br` over the stale `cmp` and was loud only because the `opaque` a `tst` mints is
    // unresolvable — the right answer resting on an accident of an unrelated model.
    expect(() => dc('stale', `\tcmp\tr0, r1\n\ttst\tr2, r3\n\tbge\t.Ltrue\n${TAIL}`)).toThrow(
      "the flags it tests were written by 'tst' in 'stale', over the compare that reached it",
    );
  });

  test('a predecessor that ends in a CONDITIONAL branch declines — unbuilt, not unsound', () => {
    // The flags do survive `beq` on ARM, so this shape is liftable; it is the PowerPC frontend's
    // inhabitant (a `cmpwi` read by the fall-through of the `beq` that already consumed it) and has
    // no ARM inhabitant in the corpus. A rewrite with no inhabitant is not earned, so it refuses.
    const condpred = `\tcmp\tr0, r1\n\tbeq\t.Ltrue\n.L2:\n\tbge\t.Ltrue\n${TAIL}`;
    expect(() => dc('condpred', condpred)).toThrow(
      /no compare crosses the edge into '.L2': it leaves '.*' through a conditional branch/,
    );
  });

  test('a predecessor LIFTED AFTER this block declines, and the sentence says so', () => {
    // The refusal is about the fill order, and it used to be reported as "a back edge". The CFG
    // below has no cycle in it at all — `f → .L2 → .L1` — so a reader was sent to look for a loop
    // that is not there, and the same CFG laid out the other way round lifts. The honest sentence
    // names the walk, because a reverse-postorder fill is what would close it.
    const back = `\tb\t.L2\n.L1:\n\tbge\t.Ltrue\n.L2:\n\tcmp\tr0, r1\n\tb\t.L1\n${TAIL}`;
    expect(() => dc('backedge', back)).toThrow(
      "no compare crosses the edge into '.L1': its only predecessor '.L2' is lifted after it",
    );
    // …and the other layout of that same CFG, which the fill order does reach.
    const laidOut = `\tb\t.L2\n.L2:\n\tcmp\tr0, r1\n\tb\t.L1\n.L1:\n\tbge\t.Ltrue\n${TAIL}`;
    expect(dc('laidout', laidOut).source).toContain(FOLDED);
  });

  test('a case block of a JUMP TABLE names the dispatch, not the bounds branch', () => {
    // The one arm of `inheritedCmp` that had no test, and the ablation says something different
    // from what it looks like it says. A case block DOES have exactly one predecessor — the bounds
    // block, whose successors `buildCfg` replaces with the case labels — so without an arm of its
    // own its `bge` would fold the `cmp r1, #0x1` that selected the case. It does not, and it would
    // not even with this arm deleted: `recoverJumpTable` only recognises a table whose bounds block
    // ends in `bhi`/`bls`, so the conditional-branch arm below catches every block in `tables`
    // anyway. Ablated, this fixture declines with "it leaves 'jtcase' through a conditional
    // branch".
    //
    // So the arm buys a TRUER SENTENCE, not a verdict: the edge into a case is a switch edge, and
    // the bounds guard is not the branch that made it. Worth keeping and worth saying, but not
    // worth claiming a wrong answer for — the soundness here is the conditional-branch arm's.
    const table =
      '\tcmp\tr1, #0x1\n\tbhi\t.Ldef\n\tlsl\tr0, r1, #0x2\n\tldr\tr1, .Lp\n\tadd\tr0, r0, r1\n' +
      '\tldr\tr0, [r0]\n\tmov\tpc, r0\n' +
      '.Lc0:\n\tbge\t.Ltrue\n\tmov\tr0, #10\n\tbx\tlr\n' +
      '.Lc1:\n\tmov\tr0, #11\n\tbx\tlr\n.Ldef:\n\tmov\tr0, #99\n\tbx\tlr\n' +
      `${TAIL}\t.align 2\n.Lp:\n\t.word\t.Ltab\n.Ltab:\n\t.word\t.Lc0\n\t.word\t.Lc1\n`;
    expect(() => dc('jtcase', table)).toThrow(
      "no compare crosses the edge into '.Lc0': it leaves the jump-table dispatch in 'jtcase'",
    );
  });

  test('a branch with no compare anywhere still declines, and says so', () => {
    expect(() => dc('nocmp', `\tbge\t.Ltrue\n${TAIL}`)).toThrow(
      "no compare reaches 'nocmp', and it has no predecessor to inherit any from",
    );
  });

  test('what crosses the edge is the compare’s VALUES, not its register names', () => {
    // `r0` is redefined on the far side of the edge, by a LOAD — which writes no flags, so the
    // compare is still the one `bge` tests. Carrying register names would re-read `r0` here and
    // state a condition over the loaded word; carrying the values the `cmp` consumed is what makes
    // the block boundary invisible, and it is also why a single predecessor is required: it
    // dominates, so those values dominate every use on this side.
    const redef = `\tcmp\tr0, r1\n\tb\t.L2\n.L2:\n\tldr\tr0, [r1]\n\tbge\t.Ltrue\n${TAIL}`;
    const src = dc('redef', redef).source;
    expect(src).toContain(FOLDED);
    // The loaded word is not in the condition. Nothing uses it, so it stands alone as the read the
    // machine made (frontend/dead-reads.ts) and appears nowhere else.
    expect(src.replace('    *(volatile s32 *)a1;\n', '')).not.toContain('*');
  });
});

describe('the return register cannot be both the return ADDRESS and the return value', () => {
  // `bx rN` branches THROUGH rN, so at that instruction rN holds the return address. When rN is
  // also the return-VALUE register the two uses collide and the address wins by definition —
  // whatever was in r0 is gone. agbcc's interworking epilogue is exactly that shape
  // (`push {lr}` … `pop {r0}; bx r0`), and reading r0 as a value there invents a return the
  // machine provably cannot make.
  test('a `bx r0` epilogue returns VOID, with no phantom value', () => {
    const src = dc('viaR0', '\tpush\t{lr}\n\tmov\tr0, #0x5\n\tpop\t{r0}\n\tbx\tr0\n').source;
    expect(src).toContain('void viaR0(void)');
    expect(src).not.toMatch(/return\s+\w/); // no value returned — there is none to return
  });

  test('the dead computation feeding that phantom return goes with it', () => {
    // `mov r0,#5` is dead once r0 is not a return value; keeping the phantom kept it alive.
    expect(dc('viaR0', '\tpush\t{lr}\n\tmov\tr0, #0x5\n\tpop\t{r0}\n\tbx\tr0\n').source).not.toContain('5');
  });

  test('control: `bx lr` keeps the value — lr is not the return register', () => {
    const src = dc('viaLr', '\tmov\tr0, #0x5\n\tbx\tlr\n').source;
    expect(src).toContain('return 5;');
    expect(src).toContain('s32 viaLr(void)');
  });

  test('control: `bx r1` keeps the value — only the register BRANCHED THROUGH is disqualified', () => {
    // agbcc also spells the interworking return through r1/r2; those leave r0 untouched, so a
    // value there is real. A blanket "any register epilogue means void" would lose it.
    const src = dc('viaR1', '\tpush\t{lr}\n\tmov\tr0, #0x5\n\tpop\t{r1}\n\tbx\tr1\n').source;
    expect(src).toContain('return 5;');
  });
});

describe('pre-UAL mnemonic spellings', () => {
  // Each pair below is ONE instruction with two accepted spellings, not two instructions: GNU `as`
  // assembles either to identical bytes (checked across 14 operand shapes). A disassembler is free
  // to emit whichever it likes, and luvdis emits the legacy one 472 times against 12 UAL in one
  // real ROM. Before normalisation `ldsh` fell through the decode switch to the loud `opaque` and
  // the function declined with "unmodelled instruction 'ldsh'" — a lift refused over a spelling.
  //
  // Pinned as EQUIVALENCE (legacy output === UAL output) rather than against expected source, so
  // the test cannot rot into asserting whatever the frontend happens to emit. Both corpus operand
  // shapes are covered: multi-register lists and a base that appears in its own list.
  const pairs: ReadonlyArray<[string, string, string]> = [
    ['ldsh', '\tldsh\tr0, [r0, r1]\n\tbx\tlr\n', '\tldrsh\tr0, [r0, r1]\n\tbx\tlr\n'],
    ['ldsb', '\tldsb\tr0, [r0, r1]\n\tbx\tlr\n', '\tldrsb\tr0, [r0, r1]\n\tbx\tlr\n'],
    ['ldm', '\tldm\tr1!, {r0}\n\tbx\tlr\n', '\tldmia\tr1!, {r0}\n\tbx\tlr\n'],
    ['ldm multi', '\tldm\tr0!, {r1, r2, r3}\n\tbx\tlr\n', '\tldmia\tr0!, {r1, r2, r3}\n\tbx\tlr\n'],
    ['ldm no-!', '\tldm\tr1, {r0}\n\tbx\tlr\n', '\tldmia\tr1, {r0}\n\tbx\tlr\n'],
    ['ldmfd', '\tldmfd\tr1!, {r0}\n\tbx\tlr\n', '\tldmia\tr1!, {r0}\n\tbx\tlr\n'],
    ['stm', '\tstm\tr1!, {r0}\n\tbx\tlr\n', '\tstmia\tr1!, {r0}\n\tbx\tlr\n'],
    ['stm base lowest', '\tstm\tr0!, {r0, r1}\n\tbx\tlr\n', '\tstmia\tr0!, {r0, r1}\n\tbx\tlr\n'],
    ['stmea', '\tstmea\tr1!, {r0}\n\tbx\tlr\n', '\tstmia\tr1!, {r0}\n\tbx\tlr\n'],
  ];

  test.each(pairs)('%s lifts, and identically to its UAL spelling', (_mn, legacyAsm, ualAsm) => {
    expect(dc('f', legacyAsm).source).toBe(dc('f', ualAsm).source);
  });

  test('`ldmfd rN, {rD}` loads — it used to be deleted outright', () => {
    // The reason ldmfd is in the table. Without it the op reaches opaqueDest, which takes ops[0] —
    // the BASE — as the destination; the opaque is then dead, DCE removes it, and the load simply
    // vanishes. That is a SILENT wrong answer, not a decline: it lifted to `return a1;`.
    expect(dc('f', '\tldmfd\tr1, {r0}\n\tbx\tlr\n').source).toContain('*a1');
  });

  test('a register list naming no register degrades loud, it does not invent one', () => {
    // The ldm/stm arm used to reject only a leftover `-` from an unexpandable range, so a token
    // naming nothing at all passed as if it were a register: `ldmia r1!, {foo}` emitted
    // `s32 f(s32 a0, s32 a1) { return a0; }` — a fabricated parameter, from a list it could not
    // read. Both this arm and the frame walk now share one definite-register predicate.
    // It declines outright rather than degrading to an opaque: with no readable list there is no
    // register destination to hang one on, which is the loudest of the available answers.
    expect(() => dc('f', '\tldmia\tr1!, {foo}\n\tbx\tlr\n')).toThrow(/unmodelled effect instruction/);
    expect(() => dc('f', '\tldmia\tr1!, {ip}\n\tbx\tlr\n')).toThrow(/unmodelled effect instruction/);
    // the well-formed spelling still lifts, so the guard is not simply refusing everything
    expect(dc('f', '\tldmia\tr1!, {r0}\n\tbx\tlr\n').source).toContain('*a1');
  });

  test('Thumb-1 has no no-writeback LDM: the `!`-less spelling still advances the base', () => {
    // `ldm r1,{r0}` and `ldm r1!,{r0}` assemble to the SAME halfword (0xc901); GNU as warns "this
    // instruction will write back the base register", gba-kit executes both with the base
    // advanced, and GBATEK says "Both STM and LDM are incrementing the Base Register". The
    // frontend used to drive writeback off the `!`, which is syntax, not architecture.
    expect(dc('f', '\tldm\tr1, {r0}\n\tbx\tlr\n').source).toBe(dc('f', '\tldm\tr1!, {r0}\n\tbx\tlr\n').source);
  });

  test('an LDM whose base is in its own list does NOT write back', () => {
    // GBATEK, THUMB.15: "no writeback (LDM/ARMv4/ARMv5; at this point, THUMB opcodes work
    // different than ARM opcodes)". The loaded value wins.
    expect(dc('f', '\tldm\tr1, {r1, r2}\n\tbx\tlr\n').source).toContain('return a0;');
  });

  test('an STM storing its own base, not lowest, DECLINES rather than guessing', () => {
    // ARM calls the stored value UNPREDICTABLE and GNU as warns "value stored for r4 is UNKNOWN";
    // GBATEK records that it is version-specific — new base on ARMv4, old base on ARMv5. This
    // frontend targets ARMv4T and used to emit the ARMv5 answer silently.
    expect(() => dc('f', '\tstm\tr4!, {r0, r2, r4}\n\tbx\tlr\n')).toThrow(/UNPREDICTABLE/);
    // …but the LOWEST-entry case is defined (old base) and must still lift.
    expect(dc('f', '\tstm\tr0!, {r0, r1}\n\tbx\tlr\n').source).toContain('*a0 = (s32)a0;');
  });

  test('a decline names the spelling the INPUT used, not the canonical one', () => {
    // Normalising must not send a reader looking for an instruction their .s does not contain.
    // `ldsh r0` is malformed (one operand), so it degrades to the loud opaque and is reported.
    expect(() => dc('f', '\tldsh\tr0\n\tbx\tlr\n')).toThrow(/'ldsh'/);
    expect(() => dc('f', '\tldsh\tr0\n\tbx\tlr\n')).not.toThrow(/'ldrsh'/);
  });

  test('a mnemonic that merely STARTS with a legacy name is untouched', () => {
    // The table is keyed on the whole mnemonic, so no prefix of a longer name is rewritten.
    // A prefix-keyed table would make this lift instead of declining.
    expect(() => dc('f', '\tldmxyz\tr1!, {r0}\n\tbx\tlr\n')).toThrow(/ldmxyz/);
  });

  test('an inherited Object key is not treated as an entry', () => {
    // The table is null-prototype. With a plain object literal, `LEGACY_MNEMONICS['constructor']`
    // resolves to Object's own constructor and the mnemonic becomes the string
    // "function Object() { [native code] }". Unreachable from real assembly — no assembler emits
    // `constructor` — so the property to pin is the absence of that leak, not which error fires.
    const run = () => dc('f', '\tconstructor\tr0, r1\n\tbx\tlr\n');
    expect(run).toThrow();
    expect(run).not.toThrow(/native code|function Object/);
  });
});
