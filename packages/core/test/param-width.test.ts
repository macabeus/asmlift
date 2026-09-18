// A NARROW DECLARED PARAMETER, extended once in the prologue. agbcc has no byte/half register
// move, so a callee declared `u8`/`s16` widens its own argument with a shift pair at the top of the
// function; folded to a `zext`/`sext`, that leaves the parameter with exactly one use — its own
// extension. Recovered as a wide parameter instead, every use has to re-spell the cast.
//
// The refusals carry the file's weight, and the ordering one is measured rather than reasoned:
// compiled with this benchmark's agbcc, `void pb(s32 *out, s32 a) { out[0]=1; out[1]=2;
// out[2]=(u8)a; }` emits mov/str/mov/str/lsl/lsr/str — the shift pair stays WHERE THE SOURCE WROTE
// IT, so a rule keyed only on "sole use, entry block" would hoist two instructions to the top. Each
// refusal is then ABLATED against its own fixture: `without` drops that one gate, and the pass must
// narrow — which is also what proves the fixture is refused by that gate alone.
//
// The structurer block pins what a narrow parameter means to the module that has to accept one:
// every other producer of an entry param types it register-wide, so nothing checked that a merged
// value fits the name it is destroyed into. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import type { FnProto } from '../src/proto';
import { PARAM_WIDTH_GATES, narrowEntryParams } from '../src/raise/paramwidth';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, type NarrowParamWitness } from '../src/target';

// The IR below is agbcc's prologue shape unless a test says otherwise, so the default witness is
// the one agbcc declares — read OFF the target rather than spelled as a literal, so a round that
// re-measures agbcc moves these tests with it.
const AGBCC_WITNESS = ARMV4T_AGBCC.compilerBehaviors.narrowParamWitness!;

const run = (ir: string, self?: FnProto, witness: NarrowParamWitness = AGBCC_WITNESS) => {
  const fn = parse(ir);
  verify(fn);
  const n = narrowEntryParams(fn, witness, self);
  verify(fn);
  return { fn, n, ir: print(fn) };
};
/** the same pass with one gate dropped — the ablation each refusal below is measured against */
const runWithout = (ir: string, gate: string, self?: FnProto, witness: NarrowParamWitness = AGBCC_WITNESS): number => {
  const fn = parse(ir);
  verify(fn);
  return narrowEntryParams(fn, witness, self, without(PARAM_WIDTH_GATES, gate));
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

/** the extension behind a store — where the SOURCE wrote the cast, not a prologue */
const BEHIND_BODY_CODE = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=1}
  store %1, %2 {off=0, width=4}
  %3: unk32 = zext %0 {width=8}
  store %1, %3 {off=4, width=4}
  ret
}
`;

/** the entry block as a loop header: its params are merge values, not arguments */
const ENTRY_IS_JOIN = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = sext %0 {width=16}
  store %1, %2 {off=0, width=4}
  br ^bb0(%2, %1)
}
`;

/** the parameter the pointer recovery already typed */
const PARAM_TYPED = `fn f {
^bb0(%0: s32*, %1: s32*):
  %2: unk32 = sext %0 {width=16}
  store %1, %2 {off=0, width=4}
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

  test('a materialization among the extensions does not end the prologue', () => {
    // `s32 mask = 0;` above the chain: sa3's sub_802DFC8 puts `mov r5, #0x0` between the frame
    // setup and its `lsl/asr`, and a constant depends on nothing, so its position says nothing
    // about where the extension sits.
    const ir = PROLOGUE_S16.replace(
      '  %2: unk32 = sext %0 {width=16}',
      '  %9: unk32 = const {value=0}\n  %2: unk32 = sext %0 {width=16}',
    );
    expect(run(ir).n).toBe(1);
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
    expect(run(BEHIND_BODY_CODE).n).toBe(0);
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
    expect(run(ENTRY_IS_JOIN).n).toBe(0);
  });

  test('an extension behind a nullary call is body code', () => {
    // The scan steps over MATERIALIZATIONS, which depend on nothing. A call depends on the whole
    // machine: `void f(s32 a) { sidefx(); consume((s16)a); }` compiled with this benchmark's agbcc
    // puts the shift pair after the `bl`, and declaring `s16` there both re-spells the function's
    // ABI and costs the byte match. `opaque` is the same shape — effectful, and nullary when it
    // reads no register.
    const call = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = call {target="g"}
  %3: unk32 = sext %0 {width=16}
  store %1, %3 {off=0, width=4}
  store %1, %2 {off=4, width=4}
  ret
}
`;
    expect(run(call).n).toBe(0);
    expect(run(call.replace('call {target="g"}', 'opaque')).n).toBe(0);
  });

  test('a width no C type spells is refused', () => {
    const ir = PROLOGUE_S16.replace('sext %0 {width=16}', 'sext %0 {width=24}');
    expect(run(ir).n).toBe(0);
  });

  test('a parameter the pointer recovery already typed is left alone', () => {
    // The typed parameter's SOLE use is the extension, so only the type stands between it and a
    // narrowing that would replace a recovered `s32 *` with `s16` — the struct/array recognizers
    // run ahead of this pass and write exactly such a type.
    expect(run(PARAM_TYPED).n).toBe(0);
  });

  test('a declared width the extension contradicts refuses the narrowing', () => {
    // `int tou8(int x){ return (unsigned char)x; }` and `u8 tou8(u8 x){ return x; }` are the same
    // bytes, so only the header separates them — and getting it wrong moves bytes in the CALLERS,
    // which this per-function pass never compiles.
    expect(run(PROLOGUE_S16, { params: ['int', 'void *'] }).n).toBe(0);
    expect(run(PROLOGUE_S16, { params: ['s16', 'void *'] }).n).toBe(1);
  });

  test('a declaration asmlift cannot read leaves the inference standing', () => {
    // A project typedef, a bare arity, a list too short for the entry: no opinion, not "wide".
    expect(run(PROLOGUE_S16, { params: ['Direction', 'void *'] }).n).toBe(1);
    expect(run(PROLOGUE_S16, { params: 2 }).n).toBe(1);
    expect(run(PROLOGUE_S16, {}).n).toBe(1);
  });
});

describe('every refusal is load-bearing', () => {
  // Each case is the fixture its refusal rejects, re-run with exactly that gate dropped: the pass
  // then narrows, which is the wrong answer the gate exists to prevent.
  const ABLATIONS: [gate: string, ir: string, self?: FnProto][] = [
    ['entry-is-join', ENTRY_IS_JOIN],
    ['param-typed', PARAM_TYPED],
    ['cast-width', PROLOGUE_S16.replace('sext %0 {width=16}', 'sext %0 {width=24}')],
    ['raw-reader', PROLOGUE_S16.replace('store %1, %6 {off=4, width=4}', 'store %1, %0 {off=4, width=4}')],
    ['proto-width', PROLOGUE_S16, { params: ['int', 'void *'] }],
    ['not-prologue', BEHIND_BODY_CODE],
  ];

  for (const [gate, ir, self] of ABLATIONS) {
    test(`without \`${gate}\` the pass narrows a parameter it must not`, () => {
      expect(run(ir, self).n).toBe(0);
      expect(runWithout(ir, gate, self)).toBe(1);
    });
  }
});

describe('the signedness variation has nothing left to ask', () => {
  // agbcc's `void f(s16 d, s32 *out) { out[0] = d; }`: the prologue extension states the
  // signedness, so pinning the parameter signed-then-unsigned would only widen it back.
  const NARROW_PARAM_ASM = 'f:\n\tlsl\tr0, r0, #0x10\n\tasr\tr0, r0, #0x10\n\tstr\tr0, [r1]\n\tbx\tlr\n';

  test('a function whose only scalar parameter is narrowed is enumerated once', () => {
    const cands = enumerateCandidates('f', NARROW_PARAM_ASM, ARMV4T_AGBCC, {});
    expect(cands.length).toBe(1);
    expect(cands[0].source).toContain('s16 a0');
  });
});

describe("a narrow parameter is not a wide value's home", () => {
  // agbcc's `s32 f(u8 x, s32 c, s32 *out) { s32 t = c ? x : 0x1234; out[0] = t; return t; }`: the
  // merge value reaches the structurer with `x` as one of its incoming arguments, and destroying
  // SSA writes the OTHER argument through whatever name the merge takes. `u8 a0` as that name
  // emits `a0 = 4660`, which agbcc truncates to 52 — silently, since it only warns.
  const MERGE_ONTO_PARAM = `fn f {
^bb0(%0: u8, %1: unk32, %2: s32*):
  %3: unk32 = const {value=0}
  %4: u32 = icmp_eq %1, %3
  cond_br %4, ^bb1(), ^bb2(%0)
^bb1():
  %5: unk32 = const {value=4660}
  br ^bb2(%5)
^bb2(%6: unk32):
  store %2, %6 {off=0, width=4}
  ret %6
}
`;

  test('a merge of the parameter with a wider value takes a fresh name', () => {
    const fn = parse(MERGE_ONTO_PARAM);
    verify(fn);
    recoverTypes(fn);
    const src = cBackend.emit(structure(fn));
    expect(src).not.toMatch(/\ba0 = /);
    expect(src).toContain('4660');
  });
});

// ── WHICH FACT SETTLES THE WIDTH IS A PER-COMPILER QUESTION ───────────────────────────────────
//
// Everything above reads the extension's POSITION, which is evidence only where a declaration's
// extension goes somewhere a body cast's never does. IDO 7.1 at -O2 leads the function with the
// `sll` for BOTH spellings, and what separates them there is a PAIR of facts, because each one
// alone has a compiled counterexample (raise/paramwidth.ts's header has the four-line table). The
// two MIPS GCCs emit one byte-identical object for both spellings and so witness nothing at all.
//
// The SAME IR stands for every case below — one parameter, `sext`, `ret`, prologue-clean and
// single-reader — which is the whole point: every gate above passes, and only the witness and the
// frontend's `Fn.paramEvidence` separate a narrowing from a miscompile.
describe('the declaration witness', () => {
  const PROLOGUE_SEXT = `fn f {
^bb0(%0: unk32):
  %1: unk32 = sext %0 {width=8}
  ret %1
}
`;
  /** the IR above with the parameter carrying whichever observations the case is about. */
  const measured = (deadHome: boolean, selfRedefined: boolean) => {
    const fn = parse(PROLOGUE_SEXT);
    verify(fn);
    fn.paramEvidence = new Map([[fn.blocks[0].params[0], { deadHome, selfRedefined }]]);
    return fn;
  };
  const declared = () => measured(true, true);

  test('agbcc narrows on POSITION — the prologue extension is its declaration', () => {
    expect(run(PROLOGUE_SEXT).n).toBe(1);
    expect(ARMV4T_AGBCC.compilerBehaviors.narrowParamWitness).toBe('prologue-extension');
  });

  test('a homing compiler narrows the parameter it HOMED and widened in place', () => {
    expect(narrowEntryParams(declared(), 'home-store-and-in-place')).toBe(1);
    expect(MIPS_IDO.compilerBehaviors.narrowParamWitness).toBe('home-store-and-in-place');
  });

  test('a homing compiler refuses the parameter it did not home — that is the body cast', () => {
    // `synthetic:tos8:ido7.1`, a MATCH: its target is `sll v0,a0,0x18 / jr ra / sra v0,v0,0x18`,
    // with no `sw`. Narrowed, it recompiles to the four-instruction homing form and the row is lost.
    expect(narrowEntryParams(measured(false, false), 'home-store-and-in-place')).toBe(0);
  });

  test('…and refuses one it homed but widened SOMEWHERE ELSE — that is a 64-bit half', () => {
    // `int f(long long x){ return (signed char)x; }` is `sll v0,a1,0x18 / sra v0,v0,0x18 /
    // sw a0,0(sp) / jr ra / sw a1,4(sp)`: a1 is homed dead, and without this refusal the recovered
    // signature said `s8 a1` for a parameter declared 64 bits wide.
    expect(narrowEntryParams(measured(true, false), 'home-store-and-in-place')).toBe(0);
  });

  test('…and one it widened in place but never homed — that is a cast assigned back to the parameter', () => {
    // `int f(int x){ x = (signed char)x; return x; }` is `sll a0,a0,0x18 / jr ra / sra v0,a0,0x18`
    // — in place, no `sw`, and `int` all the way through.
    expect(narrowEntryParams(measured(false, true), 'home-store-and-in-place')).toBe(0);
  });

  test('a compiler whose two spellings are one object refuses the narrowing, measured or not', () => {
    expect(run(PROLOGUE_SEXT, undefined, 'none').n).toBe(0);
    expect(narrowEntryParams(declared(), 'none')).toBe(0);
    expect(MIPS_GCC.compilerBehaviors.narrowParamWitness).toBe('none');
  });

  test('a fn nobody measured shows NEITHER — absent reads as the refusing answer', () => {
    const fn = parse(PROLOGUE_SEXT);
    verify(fn);
    expect(fn.paramEvidence).toBeUndefined();
    expect(narrowEntryParams(fn, 'home-store-and-in-place')).toBe(0);
  });

  test('all three new refusals are load-bearing — each ablation alone narrows', () => {
    expect(runWithout(PROLOGUE_SEXT, 'no-declaration-witness', undefined, 'none')).toBe(1);
    const ablate = (gate: string, fn: ReturnType<typeof measured>) =>
      narrowEntryParams(
        fn,
        'home-store-and-in-place',
        undefined,
        PARAM_WIDTH_GATES.filter((g) => g.id !== gate),
      );
    expect(ablate('unhomed-param', measured(false, true))).toBe(1);
    expect(ablate('widened-elsewhere', measured(true, false))).toBe(1);
  });

  test('the evidence alone licenses nothing — every gate above still applies', () => {
    // a second reader of the raw parameter proves the declaration was wide, however it was measured
    const fn = parse(`fn f {
^bb0(%0: unk32):
  %1: unk32 = sext %0 {width=8}
  %2: unk32 = add %1, %0
  ret %2
}
`);
    verify(fn);
    fn.paramEvidence = new Map([[fn.blocks[0].params[0], { deadHome: true, selfRedefined: true }]]);
    expect(narrowEntryParams(fn, 'home-store-and-in-place')).toBe(0);
  });
});
