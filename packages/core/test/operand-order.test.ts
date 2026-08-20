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

test('a var naming a MATERIALIZED load does not swap: its evaluation is not at this site', () => {
  // The store forces the first load into a local (memWriteBetween); the add's operands are then
  // (inline load, var). Re-ordering the var reference re-orders no evaluation - machine order
  // stays, even though the VAR's def is the earlier load.
  const src = emit(`fn matvar {
^bb0(%0: unk32, %1: s32):
  %2: s32 = load %0 {off=4, signed=false, width=4}
  store %0, %1 {off=4, width=4}
  %3: s32 = load %0 {off=0, signed=false, width=4}
  %4: s32 = add %3, %2
  ret %4
}`);
  expect(src).toContain('v0 = a0[1];');
  expect(src).toContain('return *a0 + v0;');
});

test('ldmia-expanded loads do not swap: their stream order is LIST order, not evaluation order', () => {
  const asm = ['\tldmia\tr0!, {r1, r2}', '\tmov\tr3, r2', '\tmul\tr3, r3, r1', '\tmov\tr0, r3', '\tbx\tlr'].join('\n');
  const src = decompile('lm2', `lm2:\n${asm}\n`, ARMV4T_AGBCC).source;
  // machine order (r2-loaded-second first) is kept — the multi attr blocks the def-order swap
  expect(src).toContain('a0[1] * *a0');
});

test('a bare scalar-global pair swaps too: recovery spells the read as a var, but it IS this site', () => {
  const asm = [
    '\tldr\tr2, .L1',
    '\tldr\tr3, .L2',
    '\tldr\tr2, [r2]',
    '\tldr\tr3, [r3]',
    '\tmul\tr3, r3, r2',
    '\tmov\tr0, r3',
    '\tbx\tlr',
    '.L1:',
    '\t.word\tgA',
    '.L2:',
    '\t.word\tgB',
  ].join('\n');
  const src = decompile('sgpair', `sgpair:\n${asm}\n`, ARMV4T_AGBCC).source;
  expect(src).toContain('gA * gB');
});
