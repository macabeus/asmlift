// Commutative operand order — the def-order re-spelling (structure.ts lowerDef) and its
// /mulfirst sibling (l3/mulfirst.ts). A commutative instruction's operand order is an allocator
// artifact; the compiler's EVALUATION order survives as the operands' def order in the
// instruction stream, and that order is what recompiles to the original bytes (verified against
// agbcc and IDO on the bg_area rows).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { mulFirstSums } from '../src/l3/mulfirst';
import { decompile } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

test('a commutative mul whose machine operands are def-DESCENDING re-spells in def order', () => {
  // load w, load h, `mul h, w` (dst-first machine order) — the source was `w * h`.
  const src = emit(`fn deforder {
^bb0(%0: unk32):
  %1: s32 = load %0 {off=0, signed=false, width=2}
  %2: s32 = load %0 {off=2, signed=false, width=2}
  %3: s32 = mul %2, %1
  ret %3
}`);
  expect(src).toContain('*a0 * a0[1]');
});

test('a const operand is outside the rule: machine order is kept, whichever side it is', () => {
  const src = emit(`fn constside {
^bb0(%0: s32):
  %1: s32 = const {value=100}
  %2: s32 = mul %1, %0
  ret %2
}`);
  expect(src).toContain('100 * a0');
});

test('the bg_area shape end-to-end: loads re-spell w-first through the full pipeline', () => {
  const asm = [
    '\tlsl\tr1, r0, #0x3',
    '\tsub\tr1, r1, r0',
    '\tlsl\tr1, r1, #0x2',
    '\tmov\tr0, #0x80',
    '\tlsl\tr0, r0, #0x12',
    '\tadd\tr1, r1, r0',
    '\tldrh\tr2, [r1, #0x10]',
    '\tldrh\tr0, [r1, #0x12]',
    '\tmul\tr0, r0, r2',
    '\tldr\tr1, [r1]',
    '\tadd\tr0, r0, r1',
    '\tbx\tlr',
  ].join('\n');
  const src = decompile('bg_area', `bg_area:\n${asm}\n`, ARMV4T_AGBCC).source;
  expect(src).toMatch(/field_16 \* .*field_18/); // w * h, the evaluation order
  expect(src).not.toMatch(/field_18 \* .*field_16/);
});

// ---- /mulfirst (l3/mulfirst.ts) ----

const V = (name: string): Expr => ({ k: 'var', name });
const fnOf = (value: Expr): SFn => ({
  name: 'f',
  params: [
    { name: 'a', type: T.s(32) },
    { name: 'b', type: T.s(32) },
    { name: 'c', type: T.s(32) },
  ],
  locals: [],
  retType: T.s(32),
  body: [{ k: 'return', value } as Stmt],
});
const mul = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '*', l, r });
const add = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '+', l, r });

test('/mulfirst flips `c + a*b` to product-first and declines when already product-first', () => {
  const out = mulFirstSums(fnOf(add(V('c'), mul(V('a'), V('b')))));
  expect(out).not.toBeNull();
  expect(cBackend.emit(out!)).toContain('a * b + c');
  expect(mulFirstSums(fnOf(add(mul(V('a'), V('b')), V('c'))))).toBeNull();
});

test('/mulfirst declines a two-product sum (nothing anchors the flip)', () => {
  expect(mulFirstSums(fnOf(add(mul(V('a'), V('b')), mul(V('b'), V('c')))))).toBeNull();
});

test('/mulfirst never moves a side containing a call', () => {
  const call: Expr = { k: 'call', fn: 'g', args: [] };
  expect(mulFirstSums(fnOf(add(call, mul(V('a'), V('b')))))).toBeNull();
});
