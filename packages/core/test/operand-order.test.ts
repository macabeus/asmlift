// Commutative operand order — the def-order re-spelling (structure.ts lowerDef) and its
// /mulfirst sibling (l3/mulfirst.ts). A commutative instruction's operand order is an allocator
// artifact; the compiler's EVALUATION order survives as the operands' def order in the
// instruction stream, and that order is what recompiles to the original bytes (verified against
// agbcc and IDO on the bg_area rows).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
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
