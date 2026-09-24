// STRUCT-RECOVERY — the access-pattern-EVIDENCE discriminator (raise/structs.ts).
//
// The load `lw v0, 8(a0)` is ambiguous: it is BOTH `s->c` (struct field) and `arr[2]` (array
// element), byte-identical, so the objdiff score cannot referee. With no supplied layout yet
// (DWARF is future work), asmlift decides array-vs-struct from the ACCESS-PATTERN SHAPE on each
// base. These tests pin that discriminator's four cases and prove the emitted C is well-formed
// (the struct is declared, fields are named by offset). Toolchain-free: it drives the raise tower
// on hand-written IR and asserts the emitted source — the same style as struct-harden.test.ts.
//
// WHY NO objdiff SCORE HERE: this first representation is BYTE-NEUTRAL (`a0->field_8` and `a0[2]` compile
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
import type { SymbolInfo } from '../src/symbols';
import { ARMV4T_AGBCC, MIPS_IDO, type TargetDescription, structureOptionsFor } from '../src/target';

// Run the raise tower (post-lift IR → recognizeStructs → recover → structure → C), mirroring the
// pipeline's post-lift stages (pre-recovery structs pass onward), and return the emitted C — for
// agbcc unless a test names another target.
function emit(
  ir: string,
  returnsVoid = false,
  symbols?: Map<string, SymbolInfo>,
  target: TargetDescription = ARMV4T_AGBCC,
): string {
  const fn = parse(ir);
  verify(fn);
  recognizeStructs(fn, target.compilerBehaviors.aggregateBoundary);
  recoverTypes(fn);
  verify(fn);
  const sfn = structure(fn, { ...structureOptionsFor(target, returnsVoid), ...(symbols ? { symbols } : {}) });
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
    expect(c).toContain('mix(struct Struct0 *a0)');
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
  // the same-offset check cannot see it). No plain struct lays it out, so it is a UNION member —
  // the halfword at 2 is element 1 of the `half` view (the next describe block owns the rule).
  test('fields overlapping at distinct offsets become one union member', () => {
    const c = emit(`fn ov {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  %2: unk32 = load %0 {off=2, width=2, signed=true}
  %3: unk32 = add %1, %2
  ret %3
}
`);
    expect(c).toContain('struct Struct0 { union { s32 word; s16 half[2]; } field_0; };');
    expect(c).toContain('a0->field_0.word + a0->field_0.half[1]');
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

// AN ADDRESS THE FUNCTION DID NOT INVENT. The recovery above reads a base's access set as
// EVIDENCE for a layout, and declines LOUD when no plain C struct reproduces it. That reading only
// makes sense for a base whose layout this function's accesses are the only account of. Two bases
// are not like that: a NAMED global (`gaddr`), declared in the project's own headers, and a
// LITERAL ADDRESS, which is a cell the hardware placed. For those the accesses are not evidence
// about a layout — they are just accesses, each spelled at its own width — so a synthesis failure
// is forgiven and the base keeps its untyped spelling.
//
// This is the DUAL of raise/truncload.ts's `fixed-cell` gate, which refuses to FOLD two widths at a
// fixed cell into one cast of a wider load. Both readings agree the two accesses stay two; this one
// adds that two accesses at one device address are not a contradiction to decline over.
describe('struct recovery — a base whose address is declared elsewhere', () => {
  // The inhabitant: a memory-mapped I/O register the source writes as a halfword and as a word
  // (`sa3:Sio32MultiLoadMain` writes REG_SIOCNT at 0x4000128 both ways). BEFORE this rule the
  // whole function declined with "overlapping fields at offset 0 (widths 2 and 4)".
  test('two widths at one literal address lift, at their own widths, with no struct', () => {
    const c = emit(
      `fn dev {
^bb0(%0: unk32):
  %1: unk32 = const {value=67109160}
  store %1, %0 {off=0, width=2}
  store %1, %0 {off=0, width=4}
  ret
}
`,
      true,
    );
    expect(c).not.toContain('struct');
    expect(c).toContain('*(u16 *)67109160 = a0;');
    expect(c).toContain('*(s32 *)67109160 = a0;');
  });

  // The same forgiveness on the OTHER kind of declared address — a named global, whose two widths
  // at one offset are agbcc fusing two adjacent byte compares into one `ldrh`. `not.toContain
  // ('struct')` alone would pass on the WRONG answer here (the bare `gState + gState`, which loses
  // the narrow read), so the spelling is asserted too — structure.ts's width-aware classification
  // is what makes it the right one, and this is that rule's reader-side witness.
  test('two widths at one named global lift with no struct', () => {
    const c = emit(`fn sym {
^bb0():
  %0: unk32 = gaddr {sym="gState"}
  %1: unk32 = load %0 {off=0, width=2, signed=false}
  %2: unk32 = load %0 {off=0, width=1, signed=false}
  %3: unk32 = add %1, %2
  ret %3
}
`);
    expect(c).not.toContain('struct');
    expect(c).toContain('(u16 *)&gState');
    expect(c).toContain('(u8 *)&gState');
    expect(c).not.toContain('gState + gState');
  });

  // WRONG-ANSWER SIDE ①. This rule forgives a FAILED synthesis; it does not stop synthesizing at a
  // constant address. A literal-address base whose accesses DO reconcile still gets its struct —
  // `((struct S *)K)->field_4` and `((u32 *)K)[1]` are byte-visibly different spellings (the
  // COMPONENT_REF keeps the offset in the load displacement), so losing the struct here would
  // silently respell every device-struct row, rather than widen anything.
  test('a reconcilable layout at a literal address still recovers its struct', () => {
    const c = emit(`fn devstruct {
^bb0():
  %0: unk32 = const {value=67109160}
  %1: unk32 = load %0 {off=0, width=1, signed=false}
  %2: unk32 = load %0 {off=4, width=4, signed=true}
  %3: unk32 = add %1, %2
  ret %3
}
`);
    expect(c).toContain('struct Struct0 {');
    expect(c).toContain('->field_0');
    expect(c).toContain('->field_4');
  });

  // ② THE BASE THIS RULE DOES NOT COVER: an ANONYMOUS base — a parameter, a
  // loaded pointer — has no source of truth but its own access set, so the identical overlap is
  // evidence about ITS layout and is declared as a union rather than left as two casts.
  test('the identical overlap on an anonymous base is declared as a union', () => {
    const c = emit(
      `fn anon {
^bb0(%0: unk32, %1: unk32):
  store %0, %1 {off=0, width=2}
  store %0, %1 {off=0, width=4}
  ret
}
`,
      true,
    );
    expect(c).toContain('struct Struct0 { union { s32 word; u16 half; } field_0; };');
    expect(c).toContain('a0->field_0.half = a1;');
    expect(c).toContain('a0->field_0.word = a1;');
  });
});

// AN OVERLAP ON AN ANONYMOUS BASE IS A UNION (raise/structs.ts `buildUnionStruct`). The same bytes
// read or written at two widths are two views of one cell. Aligned power-of-two accesses overlap
// only by CONTAINMENT, so each overlap is one widest access and the narrower ones inside it, and it
// becomes one member holding one view per width. A cast of the base at each access's own width
// spells the same accesses but not the same program on agbcc, whose aliasing rules let it reuse a
// narrow read across a wider store — `synthetic:ureread` is the row that referees it.
describe('struct recovery — an overlap on an anonymous base is a union', () => {
  // `synthetic:uhalf`: a word written, both of its halves read back. The half at +2 makes the
  // view an ARRAY reaching the furthest element read; index 0 prints in the `*` form.
  test('a word written and both halves read back', () => {
    const c = emit(`fn halves {
^bb0(%0: unk32, %1: unk32):
  store %0, %1 {off=0, width=4}
  %2: unk32 = load %0 {off=0, width=2, signed=false}
  %3: unk32 = load %0 {off=2, width=2, signed=false}
  %4: unk32 = add %2, %3
  ret %4
}
`);
    expect(c).toContain('struct Struct0 { union { s32 word; u16 half[2]; } field_0; };');
    expect(c).toContain('a0->field_0.word = a1;');
    expect(c).toContain('*a0->field_0.half + a0->field_0.half[1]');
  });

  // `synthetic:uniwrite`: the narrow STORE raise/truncload.ts refuses to widen stays one byte wide.
  test('a narrow store writes the narrow view', () => {
    const c = emit(`fn narrowst {
^bb0(%0: unk32):
  %1: unk32 = const {value=1}
  store %0, %1 {off=0, width=1}
  %2: unk32 = load %0 {off=0, width=2, signed=false}
  ret %2
}
`);
    expect(c).toContain('struct Struct0 { union { u16 half; u8 byte; } field_0; };');
    expect(c).toContain('a0->field_0.byte = 1;');
    expect(c).toContain('return a0->field_0.half;');
  });

  // `synthetic:utag`: the overlap is ONE member of a struct whose other fields stay plain.
  test('an overlap at an interior offset is one member beside plain fields', () => {
    const c = emit(`fn tagged {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  %2: unk32 = load %0 {off=4, width=4, signed=true}
  %3: unk32 = load %0 {off=4, width=2, signed=false}
  %4: unk32 = load %0 {off=4, width=1, signed=false}
  %5: unk32 = add %1, %2
  %6: unk32 = add %3, %4
  %7: unk32 = add %5, %6
  ret %7
}
`);
    expect(c).toContain('struct Struct0 { s32 field_0; union { s32 word; u16 half; u8 byte; } field_4; };');
    expect(c).toContain('a0->field_0 + a0->field_4.word');
    expect(c).toContain('a0->field_4.half + a0->field_4.byte');
  });

  // The union does not forgive a PACKED access: it has no view to seat it in either.
  test('a misaligned access beside an overlap still declines as packed', () => {
    expect(() =>
      emit(`fn packedov {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=4, signed=true}
  %2: unk32 = load %0 {off=0, width=2, signed=true}
  %3: unk32 = load %0 {off=2, width=4, signed=true}
  %4: unk32 = add %1, %2
  %5: unk32 = add %4, %3
  ret %5
}
`),
    ).toThrow(/field at offset 2 \(width 4\) is not naturally aligned — packed layout not modelled/);
  });

  // A narrow width LOADED with both extensions (MIPS `lh`/`lhu`, PPC `lha`/`lhz`) is two views: one
  // view would read one of the two with the other's extension. The store writes the unsigned one.
  test('a width loaded with both extensions gets a view for each', () => {
    const c = emit(`fn exts {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = load %0 {off=0, width=2, signed=true}
  store %0, %1 {off=0, width=4}
  %3: unk32 = load %0 {off=0, width=2, signed=false}
  store %0, %3 {off=2, width=2}
  %4: unk32 = add %2, %3
  ret %4
}
`);
    expect(c).toContain('struct Struct0 { union { s32 word; u16 uhalf[2]; s16 shalf; } field_0; };');
    expect(c).toContain('a0->field_0.shalf');
    expect(c).toContain('a0->field_0.uhalf[1] = ');
    expect(c).not.toMatch(/\(u16\)|\(s16\)/);
  });

  // agbcc aligns and rounds EVERY struct and union to 4 bytes: `union { u16 h; u8 b; }` is four
  // bytes there and two on ido/kmc/mwcc (target.ts `aggregateBoundary`, compiled). A field inside
  // the rounded size would be mislaid on agbcc, so it declines there — and lifts where the compiler
  // lays the union out naturally, and declines where nobody measured the boundary.
  const NARROW_THEN_FIELD = `fn narrowthen {
^bb0(%0: unk32, %1: unk32):
  store %0, %1 {off=0, width=2}
  %2: unk32 = load %0 {off=1, width=1, signed=false}
  %3: unk32 = load %0 {off=2, width=2, signed=false}
  %4: unk32 = add %2, %3
  ret %4
}
`;
  test('a narrow union with a field inside its rounded size declines on a 4-byte boundary', () => {
    expect(() => emit(NARROW_THEN_FIELD)).toThrow(
      /the union at offset 0 does not fit this compiler's 4-byte aggregate boundary/,
    );
  });

  test('…and is laid out naturally where the boundary is 1', () => {
    const c = emit(NARROW_THEN_FIELD, false, undefined, MIPS_IDO);
    expect(c).toContain('struct Struct0 { union { u16 half; u8 byte[2]; } field_0; u16 field_2; };');
    expect(c).toContain('a0->field_0.byte[1] + a0->field_2');
  });

  test('…and declines on a compiler whose boundary is unmeasured', () => {
    const unmeasured = {
      ...MIPS_IDO,
      compilerBehaviors: { ...MIPS_IDO.compilerBehaviors, aggregateBoundary: undefined },
    };
    expect(() => emit(NARROW_THEN_FIELD, false, undefined, unmeasured)).toThrow(
      /the union at offset 0 needs this compiler's aggregate boundary, which is unmeasured/,
    );
  });

  // The same both-extensions rule on a cell that has ONE width: it is a union of `uhalf` and
  // `shalf`, not the one signed field `buildStruct` would give it.
  test('a single-width cell loaded both ways beside another overlap is a union too', () => {
    const c = emit(`fn cellexts {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = load %0 {off=4, width=2, signed=false}
  store %0, %1 {off=0, width=1}
  %3: unk32 = load %0 {off=4, width=2, signed=true}
  %4: unk32 = load %0 {off=0, width=2, signed=false}
  %5: unk32 = add %2, %3
  %6: unk32 = add %5, %4
  ret %6
}
`);
    expect(c).toContain('union { u16 uhalf; s16 shalf; } field_4;');
    expect(c).toContain('a0->field_4.uhalf');
    expect(c).toContain('a0->field_4.shalf');
  });

  test('a narrow union off the 4-byte boundary declines there too', () => {
    expect(() =>
      emit(`fn narrowoff {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = load %0 {off=0, width=1, signed=false}
  store %0, %1 {off=2, width=2}
  %3: unk32 = load %0 {off=3, width=1, signed=false}
  %4: unk32 = add %2, %3
  ret %4
}
`),
    ).toThrow(/the union at offset 2 does not fit this compiler's 4-byte aggregate boundary/);
  });

  // A width no view is named for keeps the overlap decline.
  test('an overlap involving a width with no view declines', () => {
    expect(() =>
      emit(`fn wide {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=0, width=8, signed=true}
  %2: unk32 = load %0 {off=0, width=4, signed=true}
  %3: unk32 = add %1, %2
  ret %3
}
`),
    ).toThrow(/no union view for a 8-byte access at offset 0/);
  });
});

// WRONG-ANSWER SIDE ③. THE FORGIVENESS IS KEYED ON THE REFUSAL, NOT ON THE BASE. `buildStruct`
// throws at three sites in TWO classes, and only one class has a per-access residue. `overlap`
// does, and it is two of the three sites — a second access at the same offset with a different
// width, and one whose range straddles the field before it (`{s32@0, s16@2}`, which reaches the
// `aligned > f.off` arm and carries the SAME "unions not modelled" text at a different offset).
// Either way the accesses are each spellable at their own offset and width, which is what the four
// tests above assert. `packed` does not: a misaligned access renders through the element index `off / width`,
// and for `{off 2, width 4}` that is `0.5`. Forgiving it would emit `((s32 *)K)[0.5]`, which agbcc
// answers with `array subscript is not an integer` — an uncompilable candidate where the tree had
// an honest decline. Both kinds of declared address are asserted, because the catch that forgave
// them keyed on the base and so had the same hole twice.
describe('struct recovery — a packed layout is refused whatever the base', () => {
  test('a misaligned access at a literal address declines rather than emitting a fraction', () => {
    expect(() =>
      emit(
        `fn packedlit {
^bb0():
  %0: unk32 = const {value=67109160}
  %1: unk32 = load %0 {off=2, width=4, signed=true}
  ret %1
}
`,
      ),
    ).toThrow(/not naturally aligned — packed layout not modelled/);
  });

  test('a misaligned access at a named global declines too', () => {
    expect(() =>
      emit(`fn packedsym {
^bb0():
  %0: unk32 = gaddr {sym="gState"}
  %1: unk32 = load %0 {off=2, width=4, signed=true}
  ret %1
}
`),
    ).toThrow(/not naturally aligned — packed layout not modelled/);
  });

  // …and the fraction is refused again where it would be COMPUTED, so a base that never reaches
  // `recognizeStructs` at all cannot produce one either. `displacementIndex` is called from three
  // places in `memAccess` and EACH needs its own witness: the call cannot be hoisted to the top of
  // `memAccess`, because the declared-struct-member path and the bare-scalar path legitimately
  // arrive with `off % width !== 0` and must not be refused, so the refusal is per-path — and a
  // per-path refusal is per-path forgettable. Replacing any one call below with the bare
  // `off / width` emits the subscript named in that test's own assertion; replacing the other two
  // leaves the whole of `packages/core/test` green, which is what the three tests here answer.
  test('an interior-offset store below the access width has no subscript at all', () => {
    expect(() =>
      emit(
        `fn frac {
^bb0(%0: s32):
  %1: s32* = gaddr {sym="gArr"}
  store %1, %0 {off=2, width=4}
  ret
}
`,
        true,
      ),
    ).toThrow(/a 4-byte access at byte 2 of its base is not a whole number of elements/);
  });

  // THE MOST GENERAL PATH IN `memAccess`, and the one `recognizeStructs` can never have refused
  // first: a base that is ALREADY TYPED is skipped by the struct pass (`base.type.kind !==
  // 'unknown'`), so a parameter declared `s32 *` and read at byte 2 arrives at the anonymous-base
  // fallback with nothing between it and `((s32 *)a0)[0.5]` but this guard. Four lines of IR reach
  // it, which is the whole argument for the guard being installed at each call rather than once.
  test('a typed base read below its own width has no subscript either', () => {
    expect(() =>
      emit(`fn anon {
^bb0(%0: s32*):
  %1: unk32 = load %0 {off=2, width=4, signed=true}
  ret %1
}
`),
    ).toThrow(/a 4-byte access at byte 2 of its base is not a whole number of elements/);
  });

  // …and the MULTIDIMENSIONAL spelling, whose recovered subscripts are whole and whose operand
  // DISPLACEMENT need not be. `declaredSubscripts` divides the address RESIDUAL into rows and
  // elements and answers null when that does not come out whole; `off` is a separate fact (the
  // load's own immediate) and is added afterwards, so a clean `gTab[a0]` can still carry a
  // fractional tail. Without the guard on this path the emitted C is `gTab[a0][0.5]`.
  test('a declared row index with a fractional displacement has no subscript either', () => {
    const symbols = new Map<string, SymbolInfo>([
      ['gTab', { name: 'gTab', kind: 'data', shape: 'array', elemSize: 4, elemSigned: true, dims: [3, 4] }],
    ]);
    expect(() =>
      emit(
        `fn multi {
^bb0(%0: unk32):
  %1: unk32 = gaddr {sym="gTab"}
  %2: unk32 = const {value=16}
  %3: unk32 = mul %0, %2
  %4: s32* = add %1, %3
  %5: unk32 = load %4 {off=2, width=4, signed=true}
  ret %5
}
`,
        false,
        symbols,
      ),
    ).toThrow(/a 4-byte access at byte 2 of its base is not a whole number of elements/);
  });
});

// AN INTERIOR ADDRESS IS DECLARED BY THE SAME HEADER THE SYMBOL IS. `&gBuf + 8` is a cell of a
// project-declared object exactly as `&gBuf` is, and raise/truncload.ts's `fixed-cell` gate already
// reads it that way (`globalCellOf`). Asking the narrower question here — "is this Value itself a
// `gaddr` op" — split the two readers, because `constOffsetAccesses` keys an access on its raw
// base Value, so an interior address is its own base and never the bare symbol's.
test('an overlap at an interior global address lifts, like one at the bare symbol', () => {
  const c = emit(`fn interior {
^bb0():
  %0: unk32 = gaddr {sym="gBuf"}
  %1: unk32 = const {value=8}
  %2: unk32 = add %0, %1
  %3: unk32 = load %2 {off=0, width=2, signed=false}
  %4: unk32 = load %2 {off=0, width=1, signed=false}
  %5: unk32 = add %3, %4
  ret %5
}
`);
  expect(c).not.toContain('struct');
  // THE SUBSCRIPT IS THE WHOLE OF WHAT MAKES THIS INTERIOR. `*(u16 *)&gBuf + *(u8 *)&gBuf` is the
  // residue that forgives the overlap and then reads the WRONG cell, and a bare `(u16 *)&gBuf`
  // assertion passes on it, so the byte offset is asserted rather than the cast alone.
  expect(c).toContain('((u16 *)&gBuf)[4]');
  expect(c).toContain('((u8 *)&gBuf)[8]');
});
