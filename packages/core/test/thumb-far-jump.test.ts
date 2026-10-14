// agbcc's Thumb far-jump relay. agbcc spells a branch past the ±2 KB reach of Thumb `b` as
// `bl <label>` with an `@far jump` / `@ far jump` comment (gcc/thumb.md `jump`, `*cond_branch`,
// `*cond_branch_reversed`). The comment is the only text that separates the relay from a call to a
// locally-defined thunk, so the tokenizer keeps that one fact of it. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { __testing } from '../src/frontend/thumb';

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
