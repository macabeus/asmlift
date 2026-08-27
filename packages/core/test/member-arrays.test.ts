// MEMBER-ARRAY RECOVERY — a struct whose MEMBER is an array (raise/memberarrays.ts).
//
// The shape is `d->name[i]`: a variable-index walk over an array that lives at a constant byte
// offset inside a struct, which reaches the pass as an `aload`/`astore` whose base is a
// materialized `add(P, K)`. These tests pin the site model (which bases the pass claims and which
// it leaves alone), the declared layout (interior element counts forced by the member that
// follows, the trailing one read off its walking loop), and one refusal per gate.
//
// The C is asserted at the SOURCE, like struct-recovery.test.ts: what the pass decides is a
// spelling, and the byte evidence for it lives on the benchmark's own rows (`synthetic:membnarrow`
// and `synthetic:sibwalk` close to a byte match on it, `synthetic:membwalk` and
// `synthetic:basefold` are the controls it must not touch).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { firstRejection, without } from '../src/l3/gates';
import { dce } from '../src/pattern/engine';
import { MEMBER_ARRAY_GATES, memberArrayCandidates, recognizeMemberArrays } from '../src/raise/memberarrays';
import { recoverTypes } from '../src/raise/recover';
import { recognizeStructArrays } from '../src/raise/struct-arrays';
import { recognizeStructs } from '../src/raise/structs';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

// The pre-recovery tail this pass sits in (struct-array → member-array → struct-pointer), then
// recovery and structuring — the pipeline's own order, so a test cannot pass on an order the
// shipped driver does not run.
function emit(ir: string, returnsVoid = true): string {
  const fn = parse(ir);
  verify(fn);
  recognizeStructArrays(fn);
  if (recognizeMemberArrays(fn)) {
    dce(fn);
  }
  recognizeStructs(fn);
  recoverTypes(fn);
  verify(fn);
  return cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, returnsVoid)));
}

/** The gate that refuses each base, in first-appearance order — `null` for a base the table admits. */
function refusals(ir: string): (string | null)[] {
  const fn = parse(ir);
  verify(fn);
  recognizeStructArrays(fn);
  return memberArrayCandidates(fn).map((g) => firstRejection(MEMBER_ARRAY_GATES, g.c));
}

/** A counted `do { body } while (i + 1 <= bound)` loop over one member of each of two bases. */
const walk = (body: string, bound: number, pre = '', name = 'walk') => `fn ${name} {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=0}
${pre}  br ^bb1(%2)
^bb1(%6: unk32):
${body}  %8: unk32 = const {value=1}
  %9: unk32 = add %6, %8
  %10: unk32 = const {value=${bound}}
  %11: unk32 = icmp_sle %9, %10
  cond_br %11, ^bb1(%9), ^bb2()
^bb2():
  ret
}
`;

// The member address itself: `add(P, 4)`, hoisted out of the loop exactly as the compiler emits it.
const MEMBER_AT_4 = `  %3: unk32 = const {value=4}
  %4: unk32 = add %0, %3
  %5: unk32 = add %1, %3
`;
const COPY_AT_4 = `  %7: unk32 = aload %5, %6 {elemSize=2, signed=false}
  astore %4, %6, %7 {elemSize=2}
`;

describe('member-array recovery — the site model', () => {
  // THE ROW SHAPE (`synthetic:membnarrow`): one member at byte 4, walked 0..5. The count comes
  // from the loop bound, the leading gap from the member's own offset.
  test('a trailing member takes its element count from the walking loop', () => {
    const c = emit(walk(COPY_AT_4, 5, MEMBER_AT_4));
    expect(c).toContain('struct Struct0 { u8 _pad0[4]; u16 field_4[6]; };');
    expect(c).toContain('walk(struct Struct0 * a0, struct Struct0 * a1)');
    expect(c).toContain('a0->field_4[v0] = a1->field_4[v0];');
    // the cast spelling the recovery replaces is gone, and so is the member address
    expect(c).not.toContain('(u16 *)');
    expect(c).not.toContain('+ 4');
  });

  // BOTH ENDS OF A COPY LOOP ARE ONE TYPE. Two bases with the same layout share one declaration —
  // two identical structs under different names would be an artifact of the walk order.
  test('bases sharing a layout share one declared struct', () => {
    const c = emit(walk(COPY_AT_4, 5, MEMBER_AT_4));
    expect(c.match(/struct Struct\d+ \{/g)).toEqual(['struct Struct0 {']);
  });

  // AN INTERIOR MEMBER'S COUNT IS NOT A CHOICE (`synthetic:sibwalk`): it is forced by the offset of
  // the member that follows it, whatever its own loop walks.
  test('an interior member count is forced by the member that follows it', () => {
    const c = emit(`fn sib {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=0}
  %3: unk32 = const {value=12}
  %4: unk32 = add %0, %3
  %5: unk32 = add %1, %3
  br ^bb1(%2)
^bb1(%6: unk32):
  %7: unk32 = aload %1, %6 {elemSize=2, signed=false}
  astore %0, %6, %7 {elemSize=2}
  %12: unk32 = aload %5, %6 {elemSize=2, signed=false}
  astore %4, %6, %12 {elemSize=2}
  %8: unk32 = const {value=1}
  %9: unk32 = add %6, %8
  %10: unk32 = const {value=3}
  %11: unk32 = icmp_sle %9, %10
  cond_br %11, ^bb1(%9), ^bb2()
^bb2():
  ret
}
`);
    // the member at 0 is walked only 0..3, but it RUNS to byte 12 because that is where the next
    // member starts; only the trailing member's count is the loop's to state
    expect(c).toContain('struct Struct0 { u16 field_0[6]; u16 field_12[4]; };');
  });

  // The pass claims nothing where the address never named a member.
  test('a bare array walk declines', () => {
    expect(
      refusals(
        walk(
          `  %7: unk32 = aload %1, %6 {elemSize=2, signed=false}
  astore %0, %6, %7 {elemSize=2}
`,
          5,
        ),
      ),
    ).toEqual(['no-member-offset', 'no-member-offset']);
  });

  // `synthetic:membwalk` and `synthetic:basefold` in miniature: the compiler folded the offset into
  // the memory operand, so array legalization produced no site at all and there is nothing to claim.
  test('a constant-offset access is no site', () => {
    const fn = parse(`fn folded {
^bb0(%0: unk32):
  %1: unk32 = load %0 {off=4, width=2, signed=false}
  store %0, %1 {off=8, width=2}
  ret
}
`);
    expect(memberArrayCandidates(fn)).toEqual([]);
  });
});

describe('member-array recovery — the gates', () => {
  test('an array-of-struct base declines', () => {
    // `add(base, index*8)` with a residual field offset is raise/struct-arrays.ts's shape: it types
    // the base first, and this pass must not clobber a type recovered from a machine-code stride.
    expect(
      refusals(`fn elem {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = shl %1 {imm=3}
  %3: unk32 = add %0, %2
  %4: unk32 = load %3 {off=0, width=4, signed=true}
  store %3, %4 {off=4, width=4}
  ret
}
`),
    ).toEqual(['base-typed']);
  });

  // A named global's declaration is the project's own, and the accesses of one already render
  // through the symbol context. This is the gate the sa3 corpus demanded: without it the pass
  // claimed five `&gRgbMap`-shaped bases.
  const GLOBAL_WALK = `fn glob {
^bb0():
  %0: unk32 = gaddr {sym="gRgbMap"}
  %2: unk32 = const {value=0}
  %3: unk32 = const {value=64}
  %4: unk32 = add %0, %3
  br ^bb1(%2)
^bb1(%6: unk32):
  %7: unk32 = aload %0, %6 {elemSize=2, signed=false}
  astore %4, %6, %7 {elemSize=2}
  %8: unk32 = const {value=1}
  %9: unk32 = add %6, %8
  %10: unk32 = const {value=31}
  %11: unk32 = icmp_sle %9, %10
  cond_br %11, ^bb1(%9), ^bb2()
^bb2():
  ret
}
`;

  test('a named global base declines', () => {
    expect(refusals(GLOBAL_WALK)).toEqual(['global-base']);
  });

  // …and the SPELLING behind that gate holds on its own. `&gSym` has no place to put a member
  // offset, so the global-address branch of arrayAccess must not swallow one — with the gate
  // ablated the member is spelled through the struct cast, never dropped onto `&gRgbMap` itself.
  test('an ablated global base still spells the member offset', () => {
    const fn = parse(GLOBAL_WALK);
    verify(fn);
    if (recognizeMemberArrays(fn, without(MEMBER_ARRAY_GATES, 'global-base'))) {
      dce(fn);
    }
    recoverTypes(fn);
    verify(fn);
    const c = cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, true)));
    expect(c).toContain('((struct Struct0 *)&gRgbMap)->field_64[v0]');
    expect(c).toContain('((struct Struct0 *)&gRgbMap)->field_0[v0]');
  });

  // `ldr r0, =0x03000004` then `add r0, r0, rX` reaches this pass as the same `add(P, const)` a
  // member selection does — sa3's task pointers are full of it — and reading it as one would
  // declare a 48 MB struct.
  test('an absolute-address addend declines', () => {
    expect(
      refusals(
        walk(
          COPY_AT_4,
          5,
          `  %3: unk32 = const {value=50331652}
  %4: unk32 = add %0, %3
  %5: unk32 = add %1, %3
`,
        ),
      ),
    ).toEqual(['member-offset-range', 'member-offset-range']);
  });

  test('a base read at a constant offset declines', () => {
    expect(
      refusals(
        walk(
          `${COPY_AT_4}  %12: unk32 = load %0 {off=0, width=4, signed=true}
`,
          5,
          MEMBER_AT_4,
        ),
      ),
    ).toEqual([null, 'direct-access']);
  });

  test('a member address forwarded on a branch declines', () => {
    // the address leaves as a block argument, so a use of it survives the rewrite the pass cannot see
    expect(
      refusals(`fn esc {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=0}
  %3: unk32 = const {value=4}
  %4: unk32 = add %0, %3
  br ^bb1(%2, %4)
^bb1(%6: unk32, %12: unk32):
  %7: unk32 = aload %4, %6 {elemSize=2, signed=false}
  astore %4, %6, %7 {elemSize=2}
  %8: unk32 = const {value=1}
  %9: unk32 = add %6, %8
  %10: unk32 = const {value=5}
  %11: unk32 = icmp_sle %9, %10
  cond_br %11, ^bb1(%9, %12), ^bb2()
^bb2():
  ret
}
`),
    ).toEqual(['escaping-use']);
  });

  test('two widths at one offset decline', () => {
    expect(
      refusals(
        walk(
          `${COPY_AT_4}  %12: unk32 = aload %5, %6 {elemSize=4, signed=true}
  astore %4, %6, %12 {elemSize=4}
`,
          5,
          MEMBER_AT_4,
        ),
      ),
    ).toEqual(['member-conflict', 'member-conflict']);
  });

  test('a word member at byte 2 declines', () => {
    // C aligns a word member to 4, so `field_2` would address bytes 4..8 where the asm read 2..6 —
    // the one refusal here that is about the ADDRESS rather than the spelling.
    expect(
      refusals(
        walk(
          `  %7: unk32 = aload %5, %6 {elemSize=4, signed=true}
  astore %4, %6, %7 {elemSize=4}
`,
          5,
          `  %3: unk32 = const {value=2}
  %4: unk32 = add %0, %3
  %5: unk32 = add %1, %3
`,
        ),
      ),
    ).toEqual(['member-align', 'member-align']);
  });

  test('overlapping member runs decline', () => {
    // a 4-byte member at 0 followed by one at 6: the first member's run cannot reach 6, so the
    // declared layout would seat the second somewhere the asm never addressed
    expect(
      refusals(
        walk(
          `  %7: unk32 = aload %1, %6 {elemSize=4, signed=true}
  astore %0, %6, %7 {elemSize=4}
  %12: unk32 = aload %5, %6 {elemSize=4, signed=true}
  astore %4, %6, %12 {elemSize=4}
`,
          5,
          `  %3: unk32 = const {value=12}
  %4: unk32 = add %0, %3
  %5: unk32 = add %1, %3
  %13: unk32 = const {value=6}
  %14: unk32 = add %0, %13
  %15: unk32 = add %1, %13
  %16: unk32 = aload %15, %2 {elemSize=2, signed=false}
  astore %14, %2, %16 {elemSize=2}
`,
        ),
      ),
    ).toEqual(['member-seat', 'member-seat']);
  });

  test('a member walked to a runtime bound declines', () => {
    // the walk's last index is a parameter, so no constant states the trailing member's count and
    // the declaration would carry a number the asm never says
    expect(
      refusals(`fn runtime {
^bb0(%0: unk32, %1: unk32, %20: unk32):
  %2: unk32 = const {value=0}
${MEMBER_AT_4}  br ^bb1(%2)
^bb1(%6: unk32):
${COPY_AT_4}  %8: unk32 = const {value=1}
  %9: unk32 = add %6, %8
  %11: unk32 = icmp_sle %9, %20
  cond_br %11, ^bb1(%9), ^bb2()
^bb2():
  ret
}
`),
    ).toEqual(['trailing-unbounded', 'trailing-unbounded']);
  });

  test('a walk overrunning its successor declines', () => {
    // the member at 0 is walked 0..7 but the next member starts at byte 12, i.e. after 6 elements:
    // the walk contradicts the layout being declared around it
    expect(
      refusals(`fn over {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=0}
  %3: unk32 = const {value=12}
  %4: unk32 = add %0, %3
  %5: unk32 = add %1, %3
  br ^bb1(%2)
^bb1(%6: unk32):
  %7: unk32 = aload %1, %6 {elemSize=2, signed=false}
  astore %0, %6, %7 {elemSize=2}
  %12: unk32 = aload %5, %6 {elemSize=2, signed=false}
  astore %4, %6, %12 {elemSize=2}
  %8: unk32 = const {value=1}
  %9: unk32 = add %6, %8
  %10: unk32 = const {value=7}
  %11: unk32 = icmp_sle %9, %10
  cond_br %11, ^bb1(%9), ^bb2()
^bb2():
  ret
}
`),
    ).toEqual(['member-overrun', 'member-overrun']);
  });
});
