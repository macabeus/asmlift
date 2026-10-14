// agbcc's Thumb far-jump relay. agbcc spells a branch past the ±2 KB reach of Thumb `b` as
// `bl <label>` with an `@far jump` / `@ far jump` comment (gcc/thumb.md `jump`, `*cond_branch`,
// `*cond_branch_reversed`). The comment is the only text that separates the relay from a call to a
// locally-defined thunk, so the tokenizer keeps that one fact of it. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { __testing } from '../src/frontend/thumb';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const { decode } = __testing;

const bls = (asm: string) =>
  decode('f', asm)
    .blocks.flatMap((b) => b.instrs)
    .filter((i) => i.mnemonic === 'bl');

describe('the tokenizer keeps the far-jump mark and nothing else of a comment', () => {
  test.each(['@far jump', '@ far jump', '@  far jump  '])('`bl .L2\\t%s` is marked', (comment) => {
    const asm = `f:\n\tpush\t{lr}\n\tbl\t.L2\t${comment}\n\tbl\th\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n`;
    const [relay, call] = bls(asm);
    expect(relay).toMatchObject({ mnemonic: 'bl', ops: ['.L2'], farJump: true });
    expect(call.farJump).toBeUndefined();
  });

  test.each(['@ call thunk', '@ not a far jump', '@far jump to .L2', ''])(
    'a `bl` whose comment is %j is not marked',
    (comment) => {
      const asm = `f:\n\tpush\t{lr}\n\tbl\t.L2\t${comment}\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n`;
      expect(bls(asm)[0].farJump).toBeUndefined();
    },
  );

  test('the mark lands on a `bl` only, and the comment still never reaches an operand', () => {
    const asm = 'f:\n\tpush\t{lr}\n\tb\t.L2\t@far jump\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';
    const ins = decode('f', asm).blocks.flatMap((b) => b.instrs);
    expect(ins.some((i) => i.farJump)).toBe(false);
    expect(ins.find((i) => i.mnemonic === 'b')?.ops).toEqual(['.L2']);
  });
});

const H = '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n';
const lift = (asm: string) => decompile('f', asm, ARMV4T_AGBCC).source;
const TAIL = '.LCB0:\n\tbl\th\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';

describe('a marked relay is lowered to the branch it stands for', () => {
  // `*cond_branch`: `b<inverse> .LCB; bl <target> @far jump; .LCB:` — reads exactly as the `b`
  // it relays, which is the whole claim.
  test('the `.LCB` relay of a conditional branch lifts as that branch', () => {
    const relay = `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n${TAIL}`;
    const near = `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tb\t.L2\n${TAIL}`;
    expect(lift(relay)).toBe(lift(near));
    expect(lift(relay)).toBe('void f(s32 a0) {\n    if (a0 <= 5) h(a0);\n    return;\n}\n');
  });

  // `*cond_branch_reversed`: the same relay behind the other polarity, labelled `.LCBR`.
  test('the `.LCBR` relay keeps its polarity', () => {
    const asm =
      `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tbgt\t.LCBR0\n\tbl\t.L2\t@far jump\n` +
      '.LCBR0:\n\tbl\th\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(lift(asm)).toBe('void f(s32 a0) {\n    if (a0 > 5) h(a0);\n    return;\n}\n');
  });

  // kleod's `WorldMapScreenHandler` is stored as a callback from ANOTHER function's pool. A word
  // naming the entry is a pointer, not a way back into it, and the whole file's words are visible
  // to the decoder: keyed on them, seven of kleod's relays declined for a word they never read.
  test('a pointer to the function from another function’s pool is not a branch back to its entry', () => {
    const asm =
      '\t.code\t16\n\t.globl\tg\n\t.thumb_func\ng:\n\tldr\tr0, .Lg\n\tbx\tlr\n\t.align\t2, 0\n.Lg:\n\t.word\tf\n' +
      `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L2\t@far jump\n${TAIL}`;
    expect(lift(asm)).toBe('void f(s32 a0) {\n    if (a0 <= 5) h(a0);\n    return;\n}\n');
  });

  // agbcc puts two labels on one instruction when a helper label lands on an existing one, and the
  // first is dropped as an alias of the second. The relay is still a `bl` when that happens, and
  // naming the dropped alias it declined as leaving the function (libc s_erf.s `erf`:
  // `bl .L28 @ far jump` with `.L28:` stacked on `.L27:`).
  test('a relay to a stacked label follows the alias like the branch it stands for', () => {
    const tail = '.LCB0:\n\tbl\th\n.L3:\n.L2:\n\tpop\t{r0}\n\tbx\tr0\n';
    const relay = `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tbl\t.L3\t@ far jump\n${tail}`;
    const near = `${H}\tpush\t{lr}\n\tcmp\tr0, #5\n\tble\t.LCB0\n\tb\t.L3\n${tail}`;
    expect(lift(relay)).toBe(lift(near));
    expect(lift(relay)).toBe('void f(s32 a0) {\n    if (a0 <= 5) h(a0);\n    return;\n}\n');
  });

  // `jump`: `bl <target>\t@ far jump`, followed by a pool behind `.align 2, 0`. The relay seals
  // the fill and stays 4 bytes in the layout, so the pool word is found on its 4-byte boundary.
  test('the unconditional relay seals the pool after it and keeps its four bytes', () => {
    const asm =
      `${H}\tpush\t{r4, lr}\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tldr\tr0, .L5\n\tbl\th\n\tbl\t.L4\t@ far jump\n` +
      '\t.align\t2, 0\n.L5:\n\t.word\t0x12345\n.L3:\n\tmov\tr0, #2\n\tbl\th\n.L4:\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(lift(asm)).toBe(
      'void f(s32 a0) {\n    if (a0 != 0) {\n        h(74565);\n    } else {\n        h(2);\n    }\n}\n',
    );
  });
});

describe('what is not provably a relay declines loud', () => {
  const declines = (asm: string, why: RegExp) => {
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(FrontendUnsupportedError);
    expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(why);
    expect(decompile('f', asm, ARMV4T_AGBCC, { onGap: 'annotate' }).source).not.toContain('.L2(');
  };

  // pokeemerald m4a_1.s: `push {r0, lr}` … `bl call_r3` … `call_r3: bx r3`. The function saves lr
  // like a relay's does, so only the missing mark keeps this a decline.
  test('the call-thunk shape, unmarked, still declines', () => {
    const thunk =
      `${H}\tpush\t{r0, lr}\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tldr\tr3, [r0]\n\tbl\t.L2\n.L1:\n\tpop\t{r0}\n\tpop\t{r0}\n\tbx\tr0\n` +
      '.L2:\n\tbx\tr3\n';
    declines(thunk, /targets a label inside this function/);
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

  test('a marked `bl` to a symbol outside this function is not a relay', () => {
    declines(
      `${H}\tpush\t{lr}\n\tbl\th\t@far jump\n\tpop\t{r0}\n\tbx\tr0\n`,
      /does not target a code label of this function/,
    );
  });
});
