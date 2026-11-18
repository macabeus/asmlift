// agbcc's Thumb far-jump relay. agbcc spells a branch past the ±2 KB reach of Thumb `b` as
// `bl <label>` with an `@far jump` / `@ far jump` comment (gcc/thumb.md `jump`, `*cond_branch`,
// `*cond_branch_reversed`); a disassembly of the same bytes (romlift, luvdis) has no comment. The
// lowering reads either as `b` only behind a proof that the lr the `bl` writes is never read, so a
// call to a locally-defined thunk — the same `bl` to a label of the function — declines.
// Toolchain-free.
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { __testing } from '../src/frontend/thumb';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const { decode } = __testing;
const MARK = ARMV4T_AGBCC.compilerBehaviors.farJumpRelay?.comment;

const bls = (asm: string) =>
  decode('f', asm, MARK)
    .blocks.flatMap((b) => b.instrs)
    .filter((i) => i.mnemonic === 'bl');

describe('the tokenizer keeps the far-jump mark and nothing else of a comment', () => {
  test.each(['@far jump', '@ far jump', '@  far jump  '])('`bl .L2\\t%s` is marked', (comment) => {
    const asm = `f:\n\tpush\t{lr}\n\tbl\t.L2\t${comment}\n\tbl\th\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n`;
    const [relay, call] = bls(asm);
    expect(relay).toMatchObject({ mnemonic: 'bl', ops: ['.L2'], farJump: 'marked' });
    expect(call.farJump).toBeUndefined();
  });

  // Unmarked, the `bl` to a code label of the function is still a candidate — by its shape.
  test.each(['@ call thunk', '@ not a far jump', '@far jump to .L2', ''])(
    'a `bl` whose comment is %j is a candidate by its shape, not marked',
    (comment) => {
      const asm = `f:\n\tpush\t{lr}\n\tbl\t.L2\t${comment}\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n`;
      expect(bls(asm)[0].farJump).toBe('shape');
    },
  );

  // The mark is the compiler's declared fact, not the Thumb ISA's: with no mark to test against,
  // the comment is dropped like every other, and the `bl` is read by its shape.
  test('a target that declares no mark marks nothing', () => {
    const asm = `f:\n\tpush\t{lr}\n\tbl\t.L2\t@far jump\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n`;
    expect(
      decode('f', asm)
        .blocks.flatMap((b) => b.instrs)
        .map((i) => i.farJump)
        .filter(Boolean),
    ).toEqual(['shape']);
  });

  test('the mark lands on a `bl` only, and the comment still never reaches an operand', () => {
    const asm = 'f:\n\tpush\t{lr}\n\tb\t.L2\t@far jump\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';
    const ins = decode('f', asm, MARK).blocks.flatMap((b) => b.instrs);
    expect(ins.some((i) => i.farJump)).toBe(false);
    expect(ins.find((i) => i.mnemonic === 'b')?.ops).toEqual(['.L2']);
  });
});

const H = '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n';
const lift = (asm: string) => decompile('f', asm, ARMV4T_AGBCC).source;
const TAIL = '.LCB0:\n\tbl\th\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';
/** The listing a disassembler gives of the same bytes: no compiler comment. */
const unmarked = (asm: string) => asm.replace(/\t@ ?far jump/g, '');

// `*cond_branch`: `b<inverse> .LCB; bl <target> @far jump; .LCB:`.
const COND = `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n${TAIL}`;
// `*cond_branch_reversed`: the same relay behind the other polarity, labelled `.LCBR`.
const REVERSED =
  `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tbgt\t.LCBR0\n\tbl\t.L2\t@far jump\n` +
  '.LCBR0:\n\tbl\th\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';
// kleod's `WorldMapScreenHandler` is stored as a callback from ANOTHER function's pool.
const POINTED_AT =
  '\t.code\t16\n\t.globl\tg\n\t.thumb_func\ng:\n\tldr\tr0, .Lg\n\tbx\tlr\n\t.align\t2, 0\n.Lg:\n\t.word\tf\n' + COND;
// libc s_erf.s `erf`: `bl .L28 @ far jump` with `.L28:` stacked on `.L27:`.
const STACKED =
  `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L3\t@ far jump\n` +
  '.LCB0:\n\tbl\th\n.L3:\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';
// `jump`: `bl <target>\t@ far jump`, followed by a pool behind `.align 2, 0`.
const POOL =
  `${H}\tpush\t{r4, lr}\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tldr\tr0, .L5\n\tbl\th\n\tbl\t.L4\t@ far jump\n` +
  '\t.align\t2, 0\n.L5:\n\t.word\t0x12345\n.L3:\n\tmov\tr0, #2\n\tbl\th\n.L4:\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';

describe('a marked relay is lowered to the branch it stands for', () => {
  // reads exactly as the `b` it relays, which is the whole claim
  test('the `.LCB` relay of a conditional branch lifts as that branch', () => {
    const near = `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tb\t.L2\n${TAIL}`;
    expect(lift(COND)).toBe(lift(near));
    expect(lift(COND)).toBe('void f(s32 a0) {\n    if (a0 <= 5) h(a0);\n    return;\n}\n');
  });

  test('the `.LCBR` relay keeps its polarity', () => {
    expect(lift(REVERSED)).toBe('void f(s32 a0) {\n    if (a0 > 5) h(a0);\n    return;\n}\n');
  });

  // A word naming the entry is a pointer, not a way back into it, though the decoder sees the whole file's.
  test('a pointer to the function from another function’s pool is not a branch back to its entry', () => {
    expect(lift(POINTED_AT)).toBe('void f(s32 a0) {\n    if (a0 <= 5) h(a0);\n    return;\n}\n');
  });

  // agbcc puts two labels on one instruction when a helper label lands on an existing one, and the
  // first is dropped as an alias of the second. The relay is still a `bl` when that happens, and
  // must follow the alias as a `b` does.
  test('a relay to a stacked label follows the alias like the branch it stands for', () => {
    expect(lift(STACKED)).toBe(lift(STACKED.replace('\tbl\t.L3\t@ far jump', '\tb\t.L3')));
    expect(lift(STACKED)).toBe('void f(s32 a0) {\n    if (a0 <= 5) h(a0);\n    return;\n}\n');
  });

  // The relay seals the fill and stays 4 bytes in the layout, so the pool word is found on its
  // 4-byte boundary.
  test('the unconditional relay seals the pool after it and keeps its four bytes', () => {
    expect(lift(POOL)).toBe(
      'void f(s32 a0) {\n    if (a0 != 0) {\n        h(74565);\n    } else {\n        h(2);\n    }\n}\n',
    );
  });
});

// The same bytes as a disassembler lists them. Nothing says the `bl` is a relay, and nothing needs
// to: the proof that its lr is never read is the one the marked relay is lowered behind.
describe('an unmarked relay lifts exactly as its marked twin', () => {
  test.each([
    ['cond', COND],
    ['reversed', REVERSED],
    ['pointed at from another pool', POINTED_AT],
    ['stacked label', STACKED],
    ['unconditional before a pool', POOL],
  ])('%s', (_, asm) => {
    expect(unmarked(asm)).not.toContain('far jump');
    expect(lift(unmarked(asm))).toBe(lift(asm));
  });

  // A target that declares no mark reads the marked listing by its shape alone.
  test('a target that declares no mark lowers the marked listing by its shape', () => {
    const noMark = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, farJumpRelay: undefined },
    };
    expect(decompile('f', COND, noMark).source).toBe(lift(COND));
  });
});

// romlift / pret spellings: `thumb_func_start`, `_0801XXXX` labels, pool words labelled one per
// line with no `.align` after an unconditional relay (kl2dct sub_0801C234's `bl _0801D0CC`).
describe('a romlift listing reads its relay candidates by shape', () => {
  const ROM =
    '.thumb\n\tthumb_func_start f\nf: @ 08000000\n\tpush {r4, lr}\n\tcmp r0, #0\n\tbne _08000010\n' +
    '\tldr r0, _0800000C @ =gX\n\tbl _08000018\n_0800000C: .4byte gX\n_08000010:\n\tldr r0, [r0]\n\tbl h\n' +
    '_08000018:\n\tpop {r4}\n\tpop {r0}\n\tbx r0\n\tthumb_func_start h\nh:\n\tbx lr\n';
  const kinds = (asm: string) =>
    decode('f', asm, MARK)
      .blocks.flatMap((b) => b.instrs)
      .filter((i) => i.mnemonic === 'bl')
      .map((i) => [i.ops[0], i.farJump]);

  test('a `bl` to a code label is a candidate; one to a declared function is a call', () => {
    expect(kinds(ROM)).toEqual([
      ['_08000018', 'shape'],
      ['h', undefined],
    ]);
  });

  // Read as the call it then is, the `bl` continues into the pool word after it.
  test('a `bl` to a label heading data, or to a label of another function, is not a candidate', () => {
    const toData = ROM.replace('\tbl _08000018\n', '\tbl _0800000C\n');
    expect(() => kinds(toData)).toThrow(/falls through into data bytes/);
    const elsewhere = `${ROM}_08000020:\n\tbx lr\n`.replace('\tbl _08000018\n', '\tbl _08000020\n');
    expect(() => kinds(elsewhere)).toThrow(/falls through into data bytes/);
  });

  test('the unconditional relay seals the pool word after it, with no `.align`, and lifts as a branch', () => {
    const near = ROM.replace('\tbl _08000018\n', '\tb _08000018\n');
    expect(lift(ROM)).toBe(lift(near));
  });
});

describe('what is not provably a relay declines loud', () => {
  const declines = (asm: string, why: RegExp) => {
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(FrontendUnsupportedError);
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(why);
    expect(decompile('f', asm, ARMV4T_AGBCC, { onGap: 'annotate' }).source).not.toContain('.L2(');
  };

  // Reduced from pokeemerald m4a_1.s: `push {r0, lr}` … `bl call_r3` … `call_r3: bx r3`, with the
  // push moved into the entry block. The function saves lr like a relay's does and names it nowhere
  // else, so the `bl` is lowered; what declines is the thunk's `bx r3`, which is not a return
  // through the caller's lr. The real MPlayMain pushes lr only after an early `bx lr`, so it
  // declines earlier, on its entry block saving no lr (the next test).
  test('the call-thunk shape, unmarked, declines', () => {
    const thunk =
      `${H}\tpush\t{r0, lr}\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tldr\tr3, [r0]\n\tbl\t.L2\n.L1:\n\tpop\t{r0}\n\tpop\t{r0}\n\tbx\tr0\n` +
      '.L2:\n\tbx\tr3\n';
    declines(thunk, /indirect\/computed jump 'bx r3' is not a return through the caller's lr/);
  });

  // The real m4a shape (pokeemerald MPlayMain, sa3 MP2KPlayerMain): an early `bx lr` in the entry
  // block, and `push {r0, lr}` only in the block after it.
  test('the call thunk as m4a writes it declines on its entry block saving no lr', () => {
    const thunk =
      `${H}\tcmp\tr0, #0\n\tbne\t.L0\n\tbx\tlr\n.L0:\n\tpush\t{r0, lr}\n\tldr\tr3, [r0]\n\tbl\t.L2\n` +
      '.L1:\n\tpop\t{r0}\n\tpop\t{r0}\n\tbx\tr0\n.L2:\n\tbx\tr3\n';
    declines(
      thunk,
      /'bl \.L2' \(a `bl` to a label inside this function, read as a long branch\) is in a function whose entry block does not save lr with a `push`/,
    );
  });

  // A thunk that returns to its caller through lr names lr, which no relay's function may.
  test('an unmarked `bl` to a thunk that returns with `bx lr` declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tbl\t.L2\n\tpop\t{r0}\n\tbx\tr0\n.L2:\n\tmov\tr0, #1\n\tbx\tlr\n`,
      /a `bl` to a label inside this function, read as a long branch\) is in a function that names lr after saving it \('bx lr'\)/,
    );
  });

  test('an unmarked `bl` to a thunk that saves lr with its own `push` declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tbl\t.L2\n\tpop\t{r0}\n\tbx\tr0\n.L2:\n\tpush\t{r4, lr}\n\tmov\tr4, #1\n\tpop\t{r4, pc}\n`,
      /names lr after saving it \('push r4, lr'\)|names lr after saving it \('push \{r4, lr\}'\)/,
    );
  });

  test('an unmarked `bl` to a thunk that jumps out of the function declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tbl\t.L2\n\tpop\t{r0}\n\tbx\tr0\n.L2:\n\tmov\tr0, #1\n\tb\tg\n`,
      /branch target 'g' is not a code block in this function/,
    );
  });

  test('an unmarked `bl` in a function that branches back to its entry declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\n.LCB0:\n\tsub\tr0, r0, #1\n\tb\tf\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n`,
      /\(a `bl` to a label inside this function, read as a long branch\) is in a function that branches back to its entry/,
    );
  });

  test('an unmarked `bl` in a function that reads lr after saving it declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\n.LCB0:\n\tbl\th\n.L2:\n\tmov\tr0, lr\n\tpop\t{r1}\n\tbx\tr1\n`,
      /names lr after saving it \('mov r0, lr'\)/,
    );
  });

  test('an unmarked `bl` in a function that never saves lr declines', () => {
    declines(
      `${H}\tcmp\tr0, #0\n\tbne\t.LCB0\n\tbl\t.L2\n.LCB0:\n\tmov\tr0, #1\n\tbx\tlr\n.L2:\n\tmov\tr0, #2\n\tbx\tlr\n`,
      /does not save lr with a `push`/,
    );
  });

  test('a relay in a function that returns through the live lr declines', () => {
    declines(
      `${H}\tcmp\tr0, #0\n\tbne\t.LCB0\n\tbl\t.L2\t@far jump\n.LCB0:\n\tmov\tr0, #1\n\tbx\tlr\n.L2:\n\tmov\tr0, #2\n\tbx\tlr\n`,
      /does not save lr/,
    );
  });

  test('a relay in a function that reads lr after saving it declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n.LCB0:\n\tbl\th\n.L2:\n\tmov\tr0, lr\n\tpop\t{r1}\n\tbx\tr1\n`,
      /names lr after saving it/,
    );
  });

  test('a relay in a function that branches back to its entry declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n.LCB0:\n\tsub\tr0, r0, #1\n\tb\tf\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n`,
      /branches back to its entry/,
    );
  });

  test('a relay in a function whose jump table dispatches back to its entry declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tcmp\tr0, #1\n\tbhi\t.Ldef\n\tlsl\tr0, r0, #0x2\n\tldr\tr1, .Lp\n\tadd\tr0, r0, r1\n` +
        '\tldr\tr0, [r0]\n\tmov\tpc, r0\n\t.align\t2, 0\n.Lp:\n\t.word\t.Ltab\n.Ltab:\n\t.word\tf\n\t.word\t.Lc1\n' +
        '.Lc1:\n\tbl\th\n\tbl\t.L2\t@far jump\n.Ldef:\n\tbl\th\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n',
      /jump table dispatches back to its entry/,
    );
  });

  // A return that is not one declines in a relay's function as in any other (the near-`b` twins
  // are `thumb-instructions.test.ts`'s). Pinned here because lowering the relay must not let one through.
  test("a relay in a function with a `bx` that is not a return through the caller's lr declines", () => {
    declines(
      `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n.LCB0:\n\tbl\th\n\tpop\t{r0}\n\tbx\tr0\n` +
        '.L2:\n\tmov\tr0, #7\n\tbx\tr3\n',
      /indirect\/computed jump 'bx r3' is not a return through the caller's lr/,
    );
  });

  // The relay's lowering leans on this: with every return reading the caller's lr, the lr the relay
  // wrote is not what any return jumps to. `pop {r0}` here reads the saved r4.
  test("a relay in a function whose `pop` reads the saved r4's word, not lr's, declines", () => {
    declines(
      `${H}\tpush\t{r4, lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n.LCB0:\n\tbl\th\n.L2:\n\tmov\tr0, #7\n\tpop\t{r0}\n\tbx\tr0\n`,
      /indirect\/computed jump 'bx r0' is not a return through the caller's lr/,
    );
  });

  test("a `bx` through the register `pop {r0, r4}` filled from the saved r4's word declines", () => {
    declines(
      `${H}\tpush\t{r4, lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n.LCB0:\n\tbl\th\n.L2:\n\tpop\t{r0, r4}\n\tbx\tr0\n`,
      /indirect\/computed jump 'bx r0' is not a return through the caller's lr/,
    );
  });

  test('a marked `bl` to a symbol outside this function is not a relay', () => {
    declines(
      `${H}\tpush\t{lr}\n\tbl\th\t@far jump\n\tpop\t{r0}\n\tbx\tr0\n`,
      /does not target a code label of this function/,
    );
  });

  // The one outcome `compilerBehaviors.farJumpRelay` decides: a `bl` into another function's body
  // declines when marked (the mark says it is a branch) and keeps the call reading when not.
  test('a `bl` to a label inside another function declines marked and lifts as a call unmarked', () => {
    const rom = (mark: string) =>
      '.thumb\n\tthumb_func_start f\nf:\n\tpush {lr}\n\tbl _08000022' +
      mark +
      '\n\tpop {r0}\n\tbx r0\n' +
      '\tthumb_func_start h\nh:\n\tmov r0, #1\n_08000022:\n\tbx lr\n';
    declines(rom('\t@ far jump'), /does not target a code label of this function/);
    expect(decompile('f', rom(''), ARMV4T_AGBCC).source).toContain('_08000022(');
  });
});
