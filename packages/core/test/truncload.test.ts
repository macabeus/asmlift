// A NARROW READ OF A WIDER FIELD (raise/truncload.ts) — the fold that stops a cast at a call site
// being read as a second field at one offset.
//
// These tests pin the rewrite (what the IR becomes, and that the recovered struct then has ONE
// field where two widths were observed), the endianness split that decides which end of a field is
// its low-order one, and one refusal per gate — each by ABLATING that gate and showing the fold
// then happens, so "this rule is load-bearing" is executed rather than asserted.
//
// The byte evidence is on the benchmark's own rows: `synthetic:unitrunc` and `synthetic:utag` are
// the shapes that lift, and `synthetic:uhalf`, `synthetic:uniwrite` and `synthetic:unidev` are the
// controls that must keep declining — one per gate.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { firstRejection, without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { recognizeStructs } from '../src/raise/structs';
import { TRUNC_LOAD_GATES, foldTruncatedLoads, truncatedLoadCandidates } from '../src/raise/truncload';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

/** The fold, then the struct recovery it feeds and the C that comes out — the shipped order. */
function emit(ir: string, littleEndian = true, gates = TRUNC_LOAD_GATES): string {
  const fn = parse(ir);
  verify(fn);
  foldTruncatedLoads(fn, littleEndian, gates);
  verify(fn);
  recognizeStructs(fn);
  recoverTypes(fn);
  verify(fn);
  return cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, true)));
}

/** The gate that refuses each candidate, in program order — `null` for one the table admits. */
function refusals(ir: string, littleEndian = true): (string | null)[] {
  const fn = parse(ir);
  verify(fn);
  return truncatedLoadCandidates(fn, littleEndian).map((k) => firstRejection(TRUNC_LOAD_GATES, k.c));
}

/** THE ROW SHAPE, reduced: a halfword member at offset 12 read whole and read as a byte, plus a
 *  word member so what is left after the fold is still heterogeneous — a struct rather than an
 *  array. */
const NARROWED_CALL = `fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=8, width=4, signed=true}
  %2: unk32 = load %0 {off=12, width=2, signed=false}
  %3: unk32 = load %0 {off=12, width=1, signed=false}
  %4: unk32 = add %1, %2
  %5: unk32 = add %4, %3
  store %0, %5 {off=8, width=4}
  ret
}
`;

describe('truncated-load recovery — the rewrite', () => {
  test('a byte read of a halfword member becomes a cast of the member', () => {
    const c = emit(NARROWED_CALL);
    expect(c).toContain('struct Struct0 { u8 _pad0[8]; s32 field_8; u16 field_12; };');
    expect(c).toContain('(u8)a0->field_12');
    // the byte access the fold replaced is gone from the layout AND from the spelling
    expect(c).not.toContain('field_13');
    expect(c).not.toContain('(u8 *)');
  });

  test('without the fold the same function declines on the overlap', () => {
    const fn = parse(NARROWED_CALL);
    verify(fn);
    expect(() => recognizeStructs(fn)).toThrow(/overlapping fields at offset 12/);
  });

  test('the fold keeps the narrow value identity, so every existing use reads it', () => {
    const fn = parse(NARROWED_CALL);
    verify(fn);
    const narrow = fn.blocks[0].ops.find((o) => o.opcode === 'load' && o.attrs.width === 1)!;
    const result = narrow.results[0];
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(1);
    expect(narrow.opcode).toBe('zext');
    expect(narrow.attrs).toEqual({ width: 8 });
    expect(narrow.results[0]).toBe(result);
    // the operand is a fresh load of the covering range, inserted immediately before it
    const at = fn.blocks[0].ops.indexOf(narrow);
    const wide = fn.blocks[0].ops[at - 1];
    expect(wide.opcode).toBe('load');
    expect(wide.attrs).toEqual({ off: 12, width: 2, signed: false });
    expect(narrow.operands).toEqual([wide.results[0]]);
  });

  test('a signed narrow load becomes a sign extension', () => {
    const fn = parse(`fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  %2: unk32 = load %0 {off=0, width=1, signed=true}
  %3: unk32 = add %1, %2
  store %0, %3 {off=4, width=4}
  ret
}
`);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(1);
    const cast = fn.blocks[0].ops.find((o) => o.opcode === 'sext')!;
    expect(cast.attrs).toEqual({ width: 8 });
  });

  test('three widths at one offset collapse to the widest in a single pass', () => {
    const c = emit(`fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=4, width=4, signed=true}
  %2: unk32 = load %0 {off=4, width=2, signed=false}
  %3: unk32 = load %0 {off=4, width=1, signed=false}
  %4: unk32 = add %1, %2
  %5: unk32 = add %4, %3
  store %0, %5 {off=2, width=2}
  ret
}
`);
    expect(c).toContain('struct Struct0 { u8 _pad0[2]; u16 field_2; s32 field_4; };');
    expect(c).toContain('(u16)a0->field_4');
    expect(c).toContain('(u8)a0->field_4');
  });
});

describe('truncated-load recovery — endianness decides which end is low-order', () => {
  // `off === covering.off` on a little-endian target, `off + width === covering end` on a
  // big-endian one. The same IR therefore folds under one and refuses under the other, in BOTH
  // directions — which is the whole content of the rule.
  const AT_BASE = `fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=4, width=4, signed=true}
  %2: unk32 = load %0 {off=4, width=2, signed=false}
  %3: unk32 = add %1, %2
  store %0, %3 {off=0, width=4}
  ret
}
`;
  const AT_TOP = `fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=4, width=4, signed=true}
  %2: unk32 = load %0 {off=6, width=2, signed=false}
  %3: unk32 = add %1, %2
  store %0, %3 {off=0, width=4}
  ret
}
`;

  test('little-endian takes the read at the field base', () => {
    expect(refusals(AT_BASE, true)).toEqual([null]);
    expect(refusals(AT_TOP, true)).toEqual(['high-order-read']);
  });

  test('big-endian takes the read at the field top', () => {
    expect(refusals(AT_TOP, false)).toEqual([null]);
    expect(refusals(AT_BASE, false)).toEqual(['high-order-read']);
  });
});

describe('truncated-load recovery — one refusal per gate, each ablated', () => {
  // A LITERAL ADDRESS. `*(vu16 *)0x4000004` and `*(vu8 *)0x4000004` are two device reads, and the
  // widths are what the device answers — so the base is refused whole rather than folded.
  const LITERAL = `fn t {
^bb0():
  %0: unk32 = const {value=67108868}
  %1: unk32 = load %0 {off=0, width=2, signed=false}
  %2: unk32 = load %0 {off=0, width=1, signed=false}
  %3: unk32 = add %1, %2
  store %0, %3 {off=0, width=2}
  ret
}
`;

  test('a literal address is not narrowed', () => {
    expect(refusals(LITERAL)).toEqual(['literal-base']);
    const fn = parse(LITERAL);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    // ABLATED, the same input folds — the gate is what refuses it, not a shape the pass misses
    const ablated = parse(LITERAL);
    verify(ablated);
    expect(foldTruncatedLoads(ablated, true, without(TRUNC_LOAD_GATES, 'literal-base'))).toBe(1);
  });

  // A READ ABOVE THE LOW-ORDER END: `lhu 6(a0)` inside `lw 4(a0)` on a little-endian target is
  // `(u16)(x >> 16)`, which no cast of the field spells.
  const SKEWED = `fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=4, width=4, signed=true}
  %2: unk32 = load %0 {off=6, width=2, signed=false}
  %3: unk32 = add %1, %2
  store %0, %3 {off=0, width=4}
  ret
}
`;

  test('a read above the low-order end is not narrowed', () => {
    expect(refusals(SKEWED)).toEqual(['high-order-read']);
    const fn = parse(SKEWED);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    const ablated = parse(SKEWED);
    verify(ablated);
    expect(foldTruncatedLoads(ablated, true, without(TRUNC_LOAD_GATES, 'high-order-read'))).toBe(1);
  });

  // A COVERING STORE carries no signedness, so the field type the fold would declare is invented.
  const COVERING_STORE = `fn t {
^bb0(%0: unk32, %1: unk32):
  store %0, %1 {off=4, width=4}
  %2: unk32 = load %0 {off=4, width=1, signed=false}
  store %0, %2 {off=0, width=4}
  ret
}
`;

  test('a load covered only by a store is not narrowed', () => {
    expect(refusals(COVERING_STORE)).toEqual(['covering-store']);
    const fn = parse(COVERING_STORE);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    const ablated = parse(COVERING_STORE);
    verify(ablated);
    expect(foldTruncatedLoads(ablated, true, without(TRUNC_LOAD_GATES, 'covering-store'))).toBe(1);
  });
});

describe('truncated-load recovery — what is not a candidate at all', () => {
  // THE TABLE'S NAMED RESIDUE. A narrow STORE is refused in the candidate builder, because widening
  // a write clobbers the bytes past it and no cast spells a partial write. There is nothing to
  // ablate: the base keeps both widths and declines exactly as it did.
  test('a narrow store is never a candidate, and its base still declines', () => {
    const ir = `fn t {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = load %0 {off=4, width=2, signed=false}
  store %0, %1 {off=4, width=1}
  store %0, %2 {off=0, width=4}
  ret
}
`;
    expect(refusals(ir)).toEqual([]);
    const fn = parse(ir);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    expect(() => recognizeStructs(fn)).toThrow(/overlapping fields at offset 4/);
  });

  test('a base with no wider access is left alone', () => {
    const ir = `fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=1, signed=false}
  %2: unk32 = load %0 {off=4, width=2, signed=false}
  %3: unk32 = add %1, %2
  store %0, %3 {off=8, width=4}
  ret
}
`;
    expect(refusals(ir)).toEqual([]);
    const fn = parse(ir);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
  });
});
