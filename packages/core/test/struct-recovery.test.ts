// STRUCT-RECOVERY — the access-pattern-EVIDENCE discriminator (raise/structs.ts).
//
// The load `lw v0, 8(a0)` is ambiguous: it is BOTH `s->c` (struct field) and `arr[2]` (array
// element), byte-identical, so the objdiff score cannot referee. With no supplied layout yet
// (DWARF is future work), asmlift decides array-vs-struct from the ACCESS-PATTERN SHAPE on each
// base. These tests pin that discriminator's four cases and prove the emitted C is well-formed
// (the struct is declared, fields are named by offset). Toolchain-free: it drives the raise tower
// on hand-written IR and asserts the emitted source — the same style as struct-harden.test.ts.
//
// WHY NO objdiff SCORE HERE: this first axis is BYTE-NEUTRAL (`a0->field_8` and `a0[2]` compile
// identically), so a real-toolchain fixture would score 0 for EITHER representation and prove
// nothing about the discriminator. The discriminator is a source-shape decision, so it is tested
// at the source. (A live byte-exact fixture belongs with the layout-MOVES-bytes cases — padding /
// sizeof / by-value ABI — which are the follow-on, deliberately not built ahead of an inhabitant.)
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { recognizeStructs } from '../src/raise/structs';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

// Run the raise tower (post-lift IR → recognizeStructs → recover → structure → C), mirroring the
// pipeline's post-lift stages (pre-recovery structs pass onward), and return the emitted C.
function emit(ir: string, returnsVoid = false): string {
  const fn = parse(ir);
  verify(fn);
  recognizeStructs(fn);
  recoverTypes(fn);
  verify(fn);
  const sfn = structure(fn, structureOptionsFor(ARMV4T_AGBCC, returnsVoid));
  return cBackend.emit(sfn);
}

describe('struct recovery — access-pattern evidence discriminator', () => {
  // HETEROGENEOUS WIDTHS on one base ⇒ struct. `char` at 0 + `int` at 4 can't be one array.
  test('mixed-width access recovers a struct with named fields', () => {
    const c = emit(`fn mix {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=1, signed=true}
  %2: unk32 = load %0 {off=4, width=4, signed=true}
  %3: unk32 = add %1, %2
  ret %3
}
`);
    // The base is typed `struct Struct0 *`, the struct is declared, and both accesses are named
    // by offset — `a0[0]`/`a0[1]` never appear.
    expect(c).toContain('struct Struct0 { s8 field_0; s32 field_4; };');
    expect(c).toContain('mix(struct Struct0 * a0)');
    expect(c).toContain('a0->field_0 + a0->field_4');
    expect(c).not.toContain('a0[');
  });

  // A LONE word at offset 2 (width 4) is NOT array-indexable (2 % 4 ≠ 0), and a 4-byte field
  // cannot sit at offset 2 under natural C alignment (4-align). It fails LOUD (out of scope)
  // rather than emit a wrong `a0[?]` or an unreproducible struct.
  test('a word field at a non-natural offset fails loud', () => {
    expect(() =>
      emit(`fn skew {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=2, width=4, signed=true}
  ret %1
}
`),
    ).toThrow(/not naturally aligned/);
  });

  // GAP-FILL (F8): unaccessed leading/interior members (the compiler had them; this function never
  // touched them) leave an offset gap that natural packing can't justify — filled with a `u8[N]`
  // pad so the declared struct reproduces the observed offsets byte-for-byte. `s16 @ 2` (aligned
  // to its own width) + `s32 @ 4`, with bytes 0–1 never read → a 2-byte leading pad.
  test('a leading/interior gap is filled with a u8 pad, not declined', () => {
    const c = emit(`fn gap {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=2, width=2, signed=true}
  %2: unk32 = load %0 {off=4, width=4, signed=true}
  %3: unk32 = add %1, %2
  ret %3
}
`);
    expect(c).toContain('struct Struct0 { u8 _pad0[2]; s16 field_2; s32 field_4; };');
    expect(c).toContain('a0->field_2 + a0->field_4');
  });

  // OVERLAP at DISTINCT offsets (a word at 0 AND a half at 2 — byte ranges [0,4) and [2,4) collide;
  // the same-offset union check above cannot see it). A union view natural C cannot lay out → LOUD.
  test('fields overlapping at distinct offsets fail loud (union view)', () => {
    expect(() =>
      emit(`fn ov {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  %2: unk32 = load %0 {off=2, width=2, signed=true}
  %3: unk32 = add %1, %2
  ret %3
}
`),
    ).toThrow(/overlaps the prior field/);
  });

  // UNIFORM STRIDE (off 0/4/8, all width 4) ⇒ array, untouched. This is the `mfield` shape —
  // proving the existing `a0[2]` golden does NOT change.
  test('uniform-stride access stays an array (no struct)', () => {
    const c = emit(`fn uni {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=8, width=4, signed=true}
  ret %1
}
`);
    expect(c).not.toContain('struct');
    expect(c).not.toContain('->');
    expect(c).toContain('return a0[2];');
  });

  // MIXED-WIDTH STORE + LOAD ⇒ struct, and the store writes a named field lvalue.
  test('struct field store emits a named lvalue', () => {
    const c = emit(`fn setf {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = load %0 {off=0, width=2, signed=true}
  store %0, %1 {off=4, width=4}
  ret %2
}
`);
    expect(c).toContain('struct Struct0 { s16 field_0; s32 field_4; };');
    expect(c).toContain('a0->field_4 = a1;');
    expect(c).toContain('return a0->field_0;');
  });

  // PACKED / non-natural offset ⇒ LOUD failure, not a silently-wrong struct. A `char` at 0 and an
  // `int` at 1 (offset 1, not 4-aligned) can't be reproduced by a naive `struct { ... };`.
  test('packed layout fails loud rather than miscompile', () => {
    expect(() =>
      emit(`fn packed {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=1, signed=true}
  %2: unk32 = load %0 {off=1, width=4, signed=true}
  %3: unk32 = add %1, %2
  ret %3
}
`),
    ).toThrow(/not naturally aligned/);
  });
});
