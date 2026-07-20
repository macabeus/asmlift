// P2 — Regime B jump-table switch recovery (Regime B). agbcc's
// dense-switch `mov pc, rN` dispatch (with the inline `.word` table) recovers to a `switch_br` terminator,
// lowered to a `switch` that recompiles byte-exact. Also pins the `switch_br` verifier invariants.
// Native/offline only (agbcc; no Docker).
import { type Block, type Fn, mkOp, mkValue } from '@asmlift/core/ir/core';
import { T } from '@asmlift/core/ir/types';
import { VerifyError, verify } from '@asmlift/core/ir/verify';
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const dense = (n: number) => {
  const cases = Array.from({ length: n }, (_, i) => `case ${i}:return ${i * 2 + 3};`).join('');
  return `int sw_jt(int x){ switch(x){${cases}default:return -1;} }`;
};

describe('P2 match — agbcc jump-table dispatch recovers to a matching switch', () => {
  test('8-case dense switch scores 0 and emits a switch', () => {
    const c = dense(8);
    const src = decompile('sw_jt', compileTargetAsm(c), ARMV4T_AGBCC).source;
    expect(src).toContain('switch (');
    expect(src).toContain('case 7:');
    expect(scoreC(src, 'sw_jt', assembleTarget(compileTargetAsm(c))).score).toBe(0);
  });

  test('12-case dense switch scores 0', () => {
    const c = dense(12);
    const src = decompile('sw_jt', compileTargetAsm(c), ARMV4T_AGBCC).source;
    expect(src).toContain('switch (');
    expect(scoreC(src, 'sw_jt', assembleTarget(compileTargetAsm(c))).score).toBe(0);
  });
});

describe('P2 verifier — switch_br invariants fail loud at their source', () => {
  const mkFn = (cases: number[], nSucc: number): Fn => {
    const entry: Block = { params: [], ops: [] };
    const bodies: Block[] = Array.from({ length: nSucc }, () => ({ params: [], ops: [mkOp('ret', { operands: [] })] }));
    const scrut = mkValue(T.unk(32));
    entry.ops.push(mkOp('const', { results: [scrut], attrs: { value: 0 } }));
    entry.ops.push(
      mkOp('switch_br', {
        operands: [scrut],
        successors: bodies.map((block) => ({ block, args: [] })),
        attrs: { cases },
      }),
    );
    return { name: 'sw', blocks: [entry, ...bodies] };
  };

  test('well-formed switch_br verifies', () => {
    expect(() => verify(mkFn([0, 1, 2], 4))).not.toThrow(); // 3 cases + 1 default = 4 successors
  });
  test('duplicate case value fails loud', () => {
    expect(() => verify(mkFn([0, 1, 1], 4))).toThrow(VerifyError);
    expect(() => verify(mkFn([0, 1, 1], 4))).toThrow(/duplicate case/);
  });
  test('cases-length ≠ successors-1 fails loud', () => {
    expect(() => verify(mkFn([0, 1], 4))).toThrow(/'cases' must have/); // 2 cases, 4 successors
  });

  // The switch_br `cases` list must survive print → parse: an unbracketed emission breaks
  // parseAttrs; bracketed `[0;1;2]` round-trips.
  test('switch_br cases survive print → parse round-trip', async () => {
    const { print } = await import('@asmlift/core/ir/print');
    const { parse } = await import('@asmlift/core/ir/parse');
    const fn = mkFn([0, 5, 9], 4);
    const reparsed = parse(print(fn));
    const sb = reparsed.blocks[0].ops.find((o) => o.opcode === 'switch_br')!;
    expect(sb.attrs.cases).toEqual([0, 5, 9]);
  });
});
