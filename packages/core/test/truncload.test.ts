// A NARROW READ OF A WIDER FIELD (raise/truncload.ts) — the fold that stops a cast at a call site
// being read as a second field at one offset.
//
// These tests pin the rewrite (what the IR becomes, and that the recovered struct then has ONE
// field where two widths were observed), the endianness split that decides which end of a field is
// its low-order one, and one refusal per gate — each by ABLATING that gate and showing the fold
// then happens, so "this rule is load-bearing" is executed rather than asserted.
//
// THE SHAPES ARE NOT ALL STRAIGHT-LINE, deliberately. A base is an ADDRESS, and the three address
// forms a device cell takes (a bare literal, a sum reaching one, a named register) reach different
// rules, while the question of whether the covering access runs at all is a question about EDGES.
// A single-block envelope pins the fold and none of its refusals.
//
// The byte evidence is on the benchmark's own rows: `synthetic:unitrunc` and `synthetic:utag` are
// the shapes that lift, and `synthetic:uhalf`, `synthetic:uniwrite` and `synthetic:unidev` are the
// controls that must keep declining.
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
  // A CELL AT A CONSTANT ADDRESS, in each of the three spellings a source has for a hardware
  // register. `*(vu16 *)0x4000004` lifts to a bare `const`; the same register reached as
  // `REG_BASE + 4` lifts to a sum of two of them; and with a symbol map naming it, to a `gaddr`.
  // All three are the same cell and all three must refuse — the widths are what the device
  // answers, not two readings of one datum.
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
  const SUM_OF_LITERALS = `fn t {
^bb0():
  %0: unk32 = const {value=67108864}
  %1: unk32 = const {value=4}
  %2: unk32 = add %0, %1
  %3: unk32 = load %2 {off=0, width=2, signed=false}
  %4: unk32 = load %2 {off=0, width=1, signed=false}
  %5: unk32 = add %3, %4
  store %2, %5 {off=0, width=2}
  ret
}
`;
  const NAMED_REGISTER = `fn t {
^bb0():
  %0: unk32 = gaddr {sym="REG_DISPSTAT"}
  %1: unk32 = load %0 {off=0, width=2, signed=false}
  %2: unk32 = load %0 {off=0, width=1, signed=false}
  %3: unk32 = add %1, %2
  store %0, %3 {off=0, width=2}
  ret
}
`;

  test('a cell at a constant address is not narrowed', () => {
    for (const ir of [LITERAL, SUM_OF_LITERALS, NAMED_REGISTER]) {
      expect(refusals(ir)).toEqual(['fixed-cell']);
      const fn = parse(ir);
      verify(fn);
      expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
      // ABLATED, the same input folds — the gate is what refuses it, not a shape the pass misses
      const ablated = parse(ir);
      verify(ablated);
      expect(foldTruncatedLoads(ablated, true, without(TRUNC_LOAD_GATES, 'fixed-cell'))).toBe(1);
    }
  });

  // THE SAME REFUSAL'S RESIDUE. A base joined on two edges has no definition to walk, so the rule
  // above cannot ask whether the cell is constant — and one of the edges here carries a device
  // literal. An `undef` base is the same shape: storage nothing was entitled to write.
  const JOINED_BASE = `fn t {
^bb0(%c: unk32):
  %z: unk32 = const {value=0}
  %t: u32 = icmp_eq %c, %z
  cond_br %t, ^bb1(), ^bb2()
^bb1():
  %a: unk32 = const {value=67108868}
  br ^bb3(%a)
^bb2():
  br ^bb3(%c)
^bb3(%b: unk32):
  %1: unk32 = load %b {off=0, width=2, signed=false}
  %2: unk32 = load %b {off=0, width=1, signed=false}
  %3: unk32 = add %1, %2
  store %b, %3 {off=4, width=2}
  ret
}
`;

  test('a base joined on two edges is not narrowed', () => {
    expect(refusals(JOINED_BASE)).toEqual(['unresolved-base']);
    const fn = parse(JOINED_BASE);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    const ablated = parse(JOINED_BASE);
    verify(ablated);
    expect(foldTruncatedLoads(ablated, true, without(TRUNC_LOAD_GATES, 'unresolved-base'))).toBe(1);
  });

  // A WIDTH NO CAST SPELLS. Unreachable from every frontend today (a lifted load is 1, 2 or 4
  // bytes), so the shape is written by hand — the rule is here to keep the fold from minting a
  // `zext` the backend can only gap on if a frontend ever acquires a wider load.
  const WIDE_NARROW = `fn t {
^bb0(%0: unk32, %9: unk32):
  %1: unk32 = load %0 {off=0, width=8, signed=true}
  %2: unk32 = load %0 {off=0, width=4, signed=true}
  %3: unk32 = add %1, %2
  store %9, %3 {off=0, width=4}
  ret
}
`;

  test('a width no C type spells is refused', () => {
    expect(refusals(WIDE_NARROW)).toEqual(['cast-width']);
    const fn = parse(WIDE_NARROW);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    const ablated = parse(WIDE_NARROW);
    verify(ablated);
    expect(foldTruncatedLoads(ablated, true, without(TRUNC_LOAD_GATES, 'cast-width'))).toBe(1);
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

  // A COVER ON THE OTHER ARM. The two reads are on mutually exclusive paths, so no execution reads
  // the word: widening the byte read would read three bytes this path never touched. The refusal
  // matters more than the others because the differ CANNOT referee it — agbcc compiles the honest
  // `(unsigned char)*p` and the folded `(u8)p->field_0` to a byte-identical `.text` — so the throw
  // that `recognizeStructs` keeps is the only thing standing between the two readings.
  const OTHER_ARM = `fn t {
^bb0(%0: unk32, %c: unk32):
  %z: unk32 = const {value=0}
  %t: u32 = icmp_eq %c, %z
  cond_br %t, ^bb1(), ^bb2()
^bb1():
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  store %0, %1 {off=16, width=4}
  br ^bb3()
^bb2():
  %2: unk32 = load %0 {off=0, width=1, signed=false}
  store %0, %2 {off=16, width=4}
  br ^bb3()
^bb3():
  ret
}
`;

  test('a cover on the other arm of a branch is not narrowed', () => {
    expect(refusals(OTHER_ARM)).toEqual(['covering-dominates']);
    const fn = parse(OTHER_ARM);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    expect(() => recognizeStructs(fn)).toThrow(/overlapping fields at offset 0/);
    const ablated = parse(OTHER_ARM);
    verify(ablated);
    expect(foldTruncatedLoads(ablated, true, without(TRUNC_LOAD_GATES, 'covering-dominates'))).toBe(1);
  });

  test('a cover in a block that dominates the narrow read is taken', () => {
    const fn = parse(`fn t {
^bb0(%0: unk32, %c: unk32):
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  store %0, %1 {off=16, width=4}
  %z: unk32 = const {value=0}
  %t: u32 = icmp_eq %c, %z
  cond_br %t, ^bb1(), ^bb2()
^bb1():
  %2: unk32 = load %0 {off=0, width=1, signed=false}
  store %0, %2 {off=16, width=4}
  br ^bb2()
^bb2():
  ret
}
`);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(1);
    verify(fn);
  });
});

describe('truncated-load recovery — the cover is picked from facts, not from emission order', () => {
  // TWO COVERS OF THE SAME WIDTH, one of which the sound rules can admit. Reducing over the access
  // list would take whichever the frontend emitted first, so the same access set would fold or
  // refuse on instruction scheduling alone.
  const order = (first: string, second: string) => `fn t {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=${first}, width=4, signed=true}
  %2: unk32 = load %0 {off=${second}, width=4, signed=true}
  %3: unk32 = load %0 {off=8, width=1, signed=false}
  %4: unk32 = add %1, %2
  %5: unk32 = add %4, %3
  store %0, %5 {off=32, width=4}
  ret
}
`;

  test('either emission order picks the cover the narrow read is the low-order end of', () => {
    for (const ir of [order('8', '6'), order('6', '8')]) {
      expect(refusals(ir)).toEqual([null]);
      const fn = parse(ir);
      verify(fn);
      expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(1);
      const wide = fn.blocks[0].ops.find((o) => o.opcode === 'load' && o.attrs.off === 8 && o.attrs.width === 4)!;
      expect(wide).toBeDefined();
    }
  });
});

describe('truncated-load recovery — a dead read keeps the width the machine used', () => {
  // A DEAD LOAD is the project's own `volatile` witness (`ir/opcodes.ts` SPELLED_WHEN_DEAD_OPS): an
  // optimizing compiler deletes every dead read it is allowed to delete, so one still in the target
  // is evidence the source qualified the access. The fold rewrites the narrow load into a `zext`,
  // which is NOT in that set, and mints a fresh load, which is — so a widened dead read would carry
  // the witness at the wrong width.
  //
  // `fixed-cell` is what stops it, and by construction rather than by luck: `structure.ts`'s
  // `volatileQualifiable` answers yes only through `globalCellOf` or `constAddressOf`, which are
  // the two predicates that rule asks, so a load the fold admits is one no qualifier can reach.
  test('a dead narrow read at a named cell is not widened', () => {
    const fn = parse(`fn t {
^bb0():
  %0: unk32 = gaddr {sym="gReg"}
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  %2: unk32 = load %0 {off=0, width=1, signed=false}
  store %0, %1 {off=8, width=4}
  ret
}
`);
    verify(fn);
    expect(foldTruncatedLoads(fn, true, TRUNC_LOAD_GATES)).toBe(0);
    const dead = fn.blocks[0].ops.find((o) => o.opcode === 'load' && o.attrs.width === 1)!;
    expect(dead.attrs).toEqual({ off: 0, width: 1, signed: false });
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
