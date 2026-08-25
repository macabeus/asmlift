// A NARROW DECLARED PARAMETER, extended once in the prologue. agbcc has no byte/half register
// move, so a callee declared `u8`/`s16` widens its own argument with a shift pair at the top of the
// function; folded to a `zext`/`sext`, that leaves the parameter with exactly one use — its own
// extension. Recovered as a wide parameter instead, every use has to re-spell the cast.
//
// The refusals carry the file's weight, and the ordering one is measured rather than reasoned:
// compiled with this benchmark's agbcc, `void pb(s32 *out, s32 a) { out[0]=1; out[1]=2;
// out[2]=(u8)a; }` emits mov/str/mov/str/lsl/lsr/str — the shift pair stays WHERE THE SOURCE WROTE
// IT, so a rule keyed only on "sole use, entry block" would hoist two instructions to the top.
// Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { narrowEntryParams } from '../src/raise/paramwidth';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';

const run = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = narrowEntryParams(fn);
  verify(fn);
  return { fn, n, ir: print(fn) };
};
const emit = (ir: string): string => {
  const { fn } = run(ir);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

/** `void f(s16 d, s32 *out)` reading `d` twice — sxparam's shape. */
const PROLOGUE_S16 = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = sext %0 {width=16}
  %3: unk32 = const {value=8}
  %4: unk32 = and %3, %2
  store %1, %4 {off=0, width=4}
  %5: unk32 = const {value=4}
  %6: unk32 = and %5, %2
  store %1, %6 {off=4, width=4}
  ret
}
`;

/** `void f(u8 a, u8 b, s32 *out)` — two extensions, one prologue. */
const PROLOGUE_TWO_U8 = `fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*):
  %3: unk32 = zext %0 {width=8}
  %4: unk32 = zext %1 {width=8}
  %5: unk32 = add %3, %4
  store %2, %5 {off=0, width=4}
  ret
}
`;

describe('a parameter extended in the prologue is declared at that width', () => {
  test('a sole `sext {16}` types the parameter `s16` and drops the extension', () => {
    const { n, fn, ir } = run(PROLOGUE_S16);
    expect(n).toBe(1);
    expect(fn.blocks[0].params[0].type).toEqual({ kind: 'int', width: 16, signed: true });
    expect(ir).not.toMatch(/sext/);
    // both reads now come off the parameter itself
    expect(ir).toMatch(/and %\d+, %0/);
  });

  test('…and the emitted signature carries the width, with no cast at either use', () => {
    const src = emit(PROLOGUE_S16);
    expect(src).toContain('s16 a0');
    expect(src).not.toContain('(s16)');
    expect(src).toContain('8 & a0');
    expect(src).toContain('4 & a0');
  });

  test('two `zext {8}` extensions narrow both parameters', () => {
    const { n } = run(PROLOGUE_TWO_U8);
    expect(n).toBe(2);
    expect(emit(PROLOGUE_TWO_U8)).toContain('void f(u8 a0, u8 a1, s32 * a2)');
  });

  test('the shift kind picks the signedness and the shift amount the width', () => {
    const at = (op: string, width: number) =>
      run(PROLOGUE_S16.replace('sext %0 {width=16}', `${op} %0 {width=${width}}`)).fn.blocks[0].params[0].type;
    expect(at('sext', 8)).toEqual({ kind: 'int', width: 8, signed: true });
    expect(at('zext', 8)).toEqual({ kind: 'int', width: 8, signed: false });
    expect(at('zext', 16)).toEqual({ kind: 'int', width: 16, signed: false });
  });
});

describe('refusals', () => {
  test('a second reader of the raw parameter proves the declaration was wide', () => {
    // `d` reaches an `add` as well as the cast, so no narrow declaration can produce this asm.
    const ir = PROLOGUE_S16.replace('store %1, %6 {off=4, width=4}', 'store %1, %0 {off=4, width=4}');
    expect(run(ir).n).toBe(0);
  });

  test('an extension behind body code is where the SOURCE wrote it, not a prologue', () => {
    const ir = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=1}
  store %1, %2 {off=0, width=4}
  %3: unk32 = zext %0 {width=8}
  store %1, %3 {off=4, width=4}
  ret
}
`;
    expect(run(ir).n).toBe(0);
  });

  test('an extension outside the entry block is refused', () => {
    const ir = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=0}
  %3: u32 = icmp_eq %2, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  %4: unk32 = zext %0 {width=8}
  store %1, %4 {off=0, width=4}
  br ^bb2()
^bb2():
  ret
}
`;
    expect(run(ir).n).toBe(0);
  });

  test('an entry block with a predecessor carries merge values, not arguments', () => {
    const ir = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = sext %0 {width=16}
  store %1, %2 {off=0, width=4}
  br ^bb0(%2, %1)
}
`;
    expect(run(ir).n).toBe(0);
  });

  test('a parameter the pointer recovery already typed is left alone', () => {
    const ir = `fn f {
^bb0(%0: s32*):
  %1: unk32 = sext %0 {width=16}
  store %0, %1 {off=0, width=4}
  ret
}
`;
    expect(run(ir).n).toBe(0);
  });
});

describe('the signedness axis has nothing left to ask', () => {
  // agbcc's `void f(s16 d, s32 *out) { out[0] = d; }`: the prologue extension states the
  // signedness, so pinning the parameter signed-then-unsigned would only widen it back.
  const NARROW_PARAM_ASM = 'f:\n\tlsl\tr0, r0, #0x10\n\tasr\tr0, r0, #0x10\n\tstr\tr0, [r1]\n\tbx\tlr\n';

  test('a function whose only scalar parameter is narrowed is enumerated once', () => {
    const cands = enumerateCandidates('f', NARROW_PARAM_ASM, ARMV4T_AGBCC, {});
    expect(cands.length).toBe(1);
    expect(cands[0].source).toContain('s16 a0');
  });
});
