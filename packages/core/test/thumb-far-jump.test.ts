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

const { decode, readGasLines } = __testing;
const texts = (asm: string) => readGasLines(asm).map((l) => l.statements.map((st) => st.text));
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
      /'bl \.L2' \(a `bl` to a label inside this function — a long branch or a call to a local thunk, read as a branch only where the lr it writes is never read\) is in a function whose entry block does not save lr with a `push`/,
    );
  });

  // A thunk that returns to its caller through lr names lr, which no relay's function may.
  test('an unmarked `bl` to a thunk that returns with `bx lr` declines', () => {
    declines(
      `${H}\tpush\t{lr}\n\tbl\t.L2\n\tpop\t{r0}\n\tbx\tr0\n.L2:\n\tmov\tr0, #1\n\tbx\tlr\n`,
      /a `bl` to a label inside this function — a long branch or a call to a local thunk, read as a branch only where the lr it writes is never read\) is in a function that names lr after saving it \('bx lr'\)/,
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
      /\(a `bl` to a label inside this function — a long branch or a call to a local thunk, read as a branch only where the lr it writes is never read\) is in a function that branches back to its entry/,
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

  // `.inst.n 0x4770` is `bx lr`: the thunk returns to the `adds r4, #7` after the `bl`. The lr
  // proof reads the function's text, so an instruction spelled by its encoding must not vanish
  // from it — it declines before the proof is asked.
  test('an unmarked `bl` to a thunk that returns with `.inst.n 0x4770` (`bx lr`) declines', () => {
    declines(
      `${H}\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0\n\tbeq\t.Lskip\n\tbl\t.Lthunk\n\tadd\tr4, #7\n` +
        '.Lskip:\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.Lthunk:\n\tadd\tr4, #1\n\t.inst.n 0x4770\n\tadd\tr4, #3\n\tb\t.Lskip\n',
      /'\.inst\.n' in the code stream spells an instruction by its encoding/,
    );
  });

  // gas's other spellings of the same `bx lr` bytes (each assembled with arm-none-eabi-as
  // -mthumb -mcpu=arm7tdmi and read back with objdump: 0x4770 at .Lthunk+2). Skipped, each
  // would lift the thunk as a branch: `a0 + 1 + 3` for a machine that returns a0 + 8.
  test.each([
    '.dc.w 0x4770',
    '.dc 0x4770',
    '.dc.b 0x70, 0x47',
    '.dc.l 0x47704770',
    '.dc.a 0x47704770',
    '.int 0x47704770',
    '.dcb.w 1, 0x4770',
    '.DC.W 0x4770',
    '.BYTE 0x70, 0x47',
  ])('an unmarked `bl` to a thunk that returns with `%s` (`bx lr`) declines', (line) => {
    declines(
      `${H}\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0\n\tbeq\t.Lskip\n\tbl\t.Lthunk\n\tadd\tr4, #7\n` +
        '.Lskip:\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        `.Lthunk:\n\tadd\tr4, #1\n\t${line}\n\tadd\tr4, #3\n\tb\t.Lskip\n`,
      /is a directive this frontend does not read, where control can reach its bytes/,
    );
  });

  // gas for ARM reads `;` as a statement separator, so a line led by a zero-byte directive can
  // still assemble the `bx lr` (objdump: 0x4770 at .Lthunk+2). Read as one statement, the line
  // was skipped whole and the thunk lifted as a branch: `a0 + 1 + 3` for a machine giving a0 + 8.
  test('a `bx lr` after a `;` on a zero-byte directive line is read, and the thunk declines', () => {
    declines(
      `${H}\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0\n\tbeq\t.Lskip\n\tbl\t.Lthunk\n\tadd\tr4, #7\n` +
        '.Lskip:\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.Lthunk:\n\tadd\tr4, #1\n\t.set K, 1; bx lr\n\tadd\tr4, #3\n\tb\t.Lskip\n',
      /a long branch or a call to a local thunk/,
    );
  });

  test('a `;` hiding a byte directive behind a zero-byte one declines, relay or not', () => {
    declines(
      `${H}\tadd\tr0, #2\n\t.set K, 1; .dc.w 0x3001\n\tbx\tlr\n`,
      /'\.dc\.w' is a directive this frontend does not read, where control can reach its bytes/,
    );
  });

  test('a `;` inside a string or a character constant is not a statement separator', () => {
    expect(texts('.ascii "a;b\\";c"; bx lr')).toEqual([['.ascii "a;b\\";c"', 'bx lr']]);
    expect(texts("mov r0, #';")).toEqual([["mov r0, #';"]]);
  });

  // A macro wins over the instruction it is named after (gas matches macro names
  // case-insensitively): `.macro nop` / `bx lr` / `.endm` above the function makes its `NOP` the
  // thunk's return (objdump: 0x4770 at .Lthunk+2). The definition sits outside the slice.
  test('a line naming a macro the input defines above it declines, even outside the slice', () => {
    declines(
      `\t.macro nop\n\tbx lr\n\t.endm\n${H}\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0\n\tbeq\t.Lskip\n` +
        '\tbl\t.Lthunk\n\tadd\tr4, #7\n.Lskip:\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.Lthunk:\n\tadd\tr4, #1\n\tNOP\n\tadd\tr4, #3\n\tb\t.Lskip\n',
      /'nop' inside the function changes which lines are assembled/,
    );
  });

  // gas expands a macro only after its definition: a `nop` above `.macro nop` is the instruction
  // (objdump: 0x46c0), so a definition after the function leaves the function's lift as it was.
  test('a line above the macro it names is the instruction, and lifts', () => {
    const asm =
      `${H}\tnop\n\tadd\tr0, #2\n\tbx\tlr\n` + '\t.thumb_func\ng:\n\tbx\tlr\n\t.macro nop\n\tbx lr\n\t.endm\n';
    expect(lift(asm)).toContain('return a0 + 2;');
  });

  // Comments, as gas reads them (arm-none-eabi-as checked): a `;` inside `/* … */` separates
  // nothing, and a `#` opening a statement comments out the rest of the line, `;`s included.
  // Split blindly, `# x; add r0, #1` assembled an `add` the object does not have.
  test('a `;` inside a comment is not a statement separator', () => {
    expect(lift(`${H}\tadd\tr0, #2 /* x; y */\n\tbx\tlr\n`)).toContain('return a0 + 2;');
    expect(lift(`${H}\tadd\tr0, #2\n# x; add r0, #1\n\tbx\tlr\n`)).toContain('return a0 + 2;');
    expect(lift(`${H}\tadd\tr0, #1; # x; add r0, #4\n.Lb: # z; add r0, #8\n\tbx\tlr\n`)).toContain('return a0 + 1;');
    expect(texts('add r0, #3 /* a; b */; add r0, #1')).toEqual([['add r0, #3', 'add r0, #1']]);
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

// Every statement gas assembles reaches decode, read the way gas reads it, or the function declines.
// The probe is the call thunk: `bl .Lthunk` returns to the `add r4, #7` after it whenever gas puts
// a `bx lr` (0x4770) at .Lthunk+2, so a function giving a0 + 1 + LINE + 3 + 7. Read as a branch it
// lifts `a0 + 1 + 3`. Each LINE was assembled with arm-none-eabi-as -mthumb -mcpu=arm7tdmi and read
// back with objdump; the halfwords from .Lthunk are in each row. One reader cuts every line into
// statements (comments, strings, character constants, `;`) for decode, the debug-section filter
// and the macro scan alike, and a statement that reader or decode cannot classify declines in the
// slice instead of being skipped.
describe('every statement in the function is read the way gas reads it, or the function declines', () => {
  const thunk = (line: string, prefix = '') =>
    `${prefix}${H}\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0\n\tbeq\t.Lskip\n\tbl\t.Lthunk\n\tadd\tr4, #7\n` +
    '.Lskip:\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
    `.Lthunk:\n\tadd\tr4, #1\n${line}\n\tadd\tr4, #3\n\tb\t.Lskip\n`;
  const declines = (asm: string, why: RegExp) => {
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(FrontendUnsupportedError);
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(why);
  };
  const READS_LR = /names lr after saving it \('bx lr'\)/;

  // The `bx lr` reaches the lr proof, which declines the relay.
  test.each([
    // 3401 4770 3403: an `@` inside `/* … */` is comment text, not the start of an `@` comment
    ['/* a @ b */ bx lr', ''],
    // 3401 3400 4770 3403
    ['\tadd r4, #0 /* x @ y */ ; bx lr', ''],
    // 3401 2140 4770 3403: `'@` is the character constant 64, and the `;` after it separates
    ["\tmov r1, #'@ ; bx lr", ''],
    // 3401 4770 3403: the closing `'` of `'a'` is optional and eaten; the `;` after it separates
    ["\t.set K, 'a'; bx lr", ''],
    // 3401 4770 3403: `'\\'` is the escape `\\'` (39) and its closing quote
    ["\t.set K, '\\'; bx lr", ''],
    // 3401 4770 3403: a `/* … */` comment spanning lines ends where it closes
    ['/* x\n*/ bx lr', ''],
    // 3401 4770 3403: any number of labels on one statement
    ['a: b: bx lr', ''],
    // 3401 4770 3403: `;` splits the section switch, so `.text` comes back before the `bx lr`
    ['\t.section .debug_str,"MS",%progbits,1; .text\n\tbx lr\n\t.text', ''],
    // 3401 4770 3403: `.pushsection` and `.previous` leave a debug section as `.text` does
    ['\t.section .debug_str\n\t.pushsection .text\n\tbx lr\n\t.popsection\n\t.byte 1\n\t.text', ''],
    ['\t.section .debug_str\n\t.previous\n\tbx lr', ''],
    // 3401 4770 3403: a quoted section name is the same section
    ['\t.section ".debug_str"\n\t.byte 1; .text; bx lr', ''],
  ])('`%s` assembles a `bx lr` the lr proof reads', (line, prefix) => {
    declines(thunk(line, prefix), READS_LR);
  });

  test.each([
    // 3401 4770 3403: gas reads `"lab":` as a label; this frontend reads no quoted symbol
    ['"lab": bx lr', /'"lab": bx lr' is a statement this frontend does not read the way the assembler does/],
    // gas: an error (`'` reads the line break as its character), so no lift
    ["\tmov r1, #'\n\tbx lr", /is a character constant at the end of its line/],
    // gas: a warning, and the string reads on through the next line
    ['\t.ascii "ab\n\tbx lr', /is a string still open at the end of its line/],
  ])('`%s` is a statement this frontend cannot read, and declines', (line, why) => {
    declines(thunk(line), why);
  });

  // A macro defined by a label (`nop: .macro`: 3401 4770 3403), or inside a debug section (gas
  // defines it wherever it sits: 3401 4770 3403), still makes the thunk's `nop` its `bx lr`.
  test.each([
    ['nop: .macro\n\tbx lr\n\t.endm\n'],
    ['\t.section .debug_str,"MS",%progbits,1\n\t.macro nop\n\tbx lr\n\t.endm\n\t.text\n'],
    ['\t.text; .macro nop; bx lr; .endm\n'],
  ])('a `nop` after a definition `%s` declines', (prefix) => {
    declines(thunk('\tnop', prefix), /'nop' inside the function changes which lines are assembled/);
  });

  // What gas assembles WITHOUT a `bx lr` still lifts, as the branch it is (a0 + 1 + 3).
  test.each([
    // 3401 3403: a `#` after a closed `/* … */` comments out the rest of the line
    ['/* x\n*/ # y; bx lr', ''],
    // 3401 46c0 3403: `m: .macro nop` defines `m`, and `nop` stays the instruction
    ['\tnop', 'm: .macro nop\n\tbx lr\n\t.endm\n'],
  ])('`%s` assembles no `bx lr`, and the thunk lifts as a branch', (line, prefix) => {
    expect(lift(thunk(line, prefix))).toContain('a0 = a0 + 1 + 3;');
  });

  test('the reader keeps the far-jump mark of an `@` comment after a string holding `@`', () => {
    expect(readGasLines('\t.ascii "a@b" @far jump').map((l) => [l.statements.map((s) => s.text), l.comment])).toEqual([
      [['.ascii "a@b"'], '@far jump'],
    ]);
  });
});

// Bodies gas may not assemble as written, and code in another section. Each LINE was assembled with
// arm-none-eabi-as -mthumb -mcpu=arm7tdmi and read back with objdump; the halfwords from .Lthunk
// are in each row. Read as written, each lifted a phantom instruction or hid the thunk's `bx lr`.
describe('a section switch this frontend cannot place, and code in another section, decline', () => {
  const thunk = (line: string, prefix = '') =>
    `${prefix}${H}\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tcmp\tr4, #0\n\tbeq\t.Lskip\n\tbl\t.Lthunk\n\tadd\tr4, #7\n` +
    '.Lskip:\n\tadd\tr0, r4, #0\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
    `.Lthunk:\n\tadd\tr4, #1\n${line}\n\tadd\tr4, #3\n\tb\t.Lskip\n`;
  const declines = (asm: string, why: RegExp) => {
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(FrontendUnsupportedError);
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(why);
  };
  const DBG = '.section .debug_str,"MS",%progbits,1';
  const IN_BODY = /switches section inside a conditional, macro or repeated body/;

  // 3401 3403 each: the body is never assembled, so there is no `add r4, #2`. Applying the body's
  // `.text` hid the closing directive in a debug region, and the `add` lifted.
  test.each([
    ['.if 0', '.endif'],
    ['.macro mm', '.endm'],
    ['.rept 0', '.endr'],
    ['.ifdef NOPE', '.endif'],
  ])('a `.text` inside `%s` … `%s` opened in a debug section declines', (open, close) => {
    declines(thunk(`${DBG}\n${open}\n.text ; add r4, #2 ; ${DBG}\n${close}\n.text`), IN_BODY);
    declines(thunk(`${DBG}\n${open}\n.text\nadd r4, #2\n${DBG}\n${close}\n.text`), IN_BODY);
  });

  // 3401 4770 3403: the macro's `.text` runs where it is invoked, inside the debug section.
  test('a macro whose body switches to `.text`, invoked in a debug section, declines', () => {
    declines(thunk(`${DBG}\ntotext\nbx lr\n.text`, '.macro totext\n.text\n.endm\n'), IN_BODY);
  });

  // 3401 3403: the `add r4, #2` is assembled into `.text.foo` (or `.text 1`, laid out after
  // subsection 0), not between the `add`s around it.
  test.each([
    ['\t.section .text.foo\n\tadd r4, #2\n\t.text', /\(\.text 0, \.text\.foo 0\)/],
    ['\t.text 1\n\tadd r4, #2\n\t.text 0', /\(\.text 0, \.text 1\)/],
  ])('code in another section (`%s`) declines', (line, why) => {
    declines(thunk(line), /is assembled into more than one section/);
    declines(thunk(line), why);
  });

  // 3401 e001 3403 e7f7 3402 3405 e7f4: `.subsection 0+1` is subsection 1, laid out after the
  // function, so `.LA` falls into the `add r4, #5` below it. Read as subsection 0, `.LA` fell into
  // `add r4, #3`. Only a plain number is read as a subsection; any other expression keys one of its own.
  test.each(['0+1', '2*1'])('code under `.subsection %s` declines as split across sections', (expr) => {
    declines(
      thunk(`b .LA\n.subsection ${expr}\n.LA: add r4, #2\n.previous`) +
        `.subsection ${expr}\n\tadd r4, #5\n\tb .Lskip\n`,
      /is assembled into more than one section \(\.text 0, \.text \?/,
    );
  });

  // 3401 e001 3403 e7f7 3402 3405 e7f4: `.set S, 0` before the function and `.set S, 1` in it make
  // the same `.subsection S` text two subsections; read as one, `.LA` fell into `add r4, #3`.
  test('the same subsection expression at two uses keys two subsections, and declines', () => {
    const asm =
      '\t.set S, 0\n\t.text\n\t.subsection S\n' +
      thunk('b .LA\n.set S, 1\n.subsection S\n.LA: add r4, #2\n.previous') +
      '.subsection S\n\tadd r4, #5\n\tb .Lskip\n';
    declines(asm, /is assembled into more than one section \(\.text \?S#0, \.text \?S#1/);
  });

  // 3401 3403: after `.struct 0` (or `.offset 0`) the `add r4, #2` is in the absolute section, not
  // the code. Any directive not known to keep the section is a section of its own.
  test.each(['.struct 0', '.offset 0'])('code after `%s` declines as split across sections', (dir) => {
    declines(
      thunk(`${dir}\nadd r4, #2\n.text`),
      /more than one section \(\.text 0, \?\.|is a directive this frontend does not read/,
    );
  });

  // `.set ., .+2` moves the location counter: gas emits a 0x0000 halfword (`movs r0, r0`, which
  // sets the flags `beq` reads: 2900 0000 d001). Skipped as a zero-byte `.set`, the lift branched
  // on `cmp r1, #0`. After a return it is fill a pc-relative load reads (gas loads 0, not 9).
  // the quoted `"."` names the location counter too (measured: the same 0x0000 halfword)
  test('`.set ".", .+2` moves the location counter, and declines', () => {
    const asm =
      '\t.text\n\t.thumb\n\t.thumb_func\n\t.global g\ng:\n\tcmp r1, #0\n\t.set ".", .+2\n\tbeq .L1\n' +
      '\tmov r0, #1\n\tbx lr\n.L1:\tmov r0, #2\n\tbx lr\n';
    expect(() => decompile('g', asm, ARMV4T_AGBCC)).toThrow(/'\.set' is a directive this frontend does not read/);
  });

  test.each(['.set', '.equ', '.eqv'])('`%s ., .+2` moves the location counter, and declines', (dir) => {
    const g = (body: string) =>
      decompile('g', `\t.text\n\t.thumb\n\t.thumb_func\n\t.global g\ng:\n${body}`, ARMV4T_AGBCC);
    expect(() =>
      g(`\tcmp r1, #0\n\t${dir} ., .+2\n\tbeq .L1\n\tmov r0, #1\n\tbx lr\n.L1:\tmov r0, #2\n\tbx lr\n`),
    ).toThrow(new RegExp(`'\\${dir}' is a directive this frontend does not read, where control can reach its bytes`));
    expect(() => g(`\tldr r0, [pc, #0]\n\tbx lr\n\t${dir} ., .+4\n\t.word 9\n\t.word 10\n`)).toThrow(
      /raw-encoded input needs byte-accurate layout/,
    );
  });

  // A `[pc, #4]` load is resolved by laying the slice's items end to end; a word gas assembles into
  // `.data` (or a halfword into `.rodata`) is not there. Measured: gas loads 11 (y1) and 22 (y2,
  // unaligned), where the layout read 7 and 11.
  test.each([
    ['.data\n.Ld: .word 7\n.text\n.align 2', /another section \(\.data 0\)/],
    ['.section .rodata\n.Ld: .2byte 7\n.text', /another section \(\.rodata 0\)/],
  ])('a pc-relative load past data in another section (`%s`) declines', (other, why) => {
    declines(thunk(`ldr r1, [pc, #4]\nadd r4, r1\nb .Lz\n${other}\n.Lq: .word 11\n.word 22\n.word 33\n.Lz:`), why);
  });

  test('a function with no relay and code in another section declines', () => {
    declines(`${H}\tadd\tr0, #2\n\t.section .text.foo\n\tadd\tr0, #1\n\t.text\n\tbx\tlr\n`, /more than one section/);
  });

  // 3401 4770 3403: a quoted label names the macro `nop`, which this frontend does not read.
  test('a macro defined under a quoted label declines the input', () => {
    declines(
      thunk('\tnop', '"nop": .macro\n\tbx lr\n\t.endm\n'),
      /defines a macro whose name this frontend does not read/,
    );
  });
});

// A control byte other than TAB ends a statement for gas, where readGasLines kept it inside one
// (arm-none-eabi-as -mthumb -mcpu=arm7tdmi): `mov r0, #1<NUL>add r0, #2` assembles both instructions
// (return 3), and a `.set K, 1<NUL>add r0, #2` line assembles the `add` too; both lifted `return 1`.
// Any line holding one now declines the whole input, wherever it sits; a CRLF line and UTF-8 text
// read as before.
describe('a line holding a control byte declines', () => {
  const fn = (mid: string) => `\t.text\n\t.code 16\n\t.thumb_func\nf:\n\tmov\tr0, #1${mid}\n\tbx\tlr\n`;
  test.each(['\u0000add r0, #2', '\n\t.set K, 1\u0000add r0, #2', '\n\t@ x\u0000y', '\u0001', '\u007f', '\rx'])(
    '%j',
    (mid) => {
      expect(() => decompile('f', fn(mid), ARMV4T_AGBCC)).toThrow(/on a line holding a control byte/);
    },
  );
  test('before the function too', () => {
    expect(() => decompile('f', `\t.text\u0000.data\n${fn('')}`, ARMV4T_AGBCC)).toThrow(/control byte/);
  });
  test('CRLF and UTF-8 still read', () => {
    expect(lift(fn(' @ café').replace(/\n/g, '\r\n'))).toContain('return 1;');
  });
});
