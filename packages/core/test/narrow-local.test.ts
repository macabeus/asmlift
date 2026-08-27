// A NARROW DECLARED LOCAL, extended once at every read. agbcc holds an `s16` local in a full
// register and re-extends it at each use, so a narrow loop carrier arrives with exactly one reader —
// its own extension. Recovered wide instead, every use re-spells the cast, and `gcc/loop.c`'s
// `basic_induction_var` then eliminates the index the narrow spelling keeps (the file header carries
// the compiled evidence).
//
// The refusals carry the file's weight, and the one that carries the SOUNDNESS is `raw-reader`:
// typing the carrier narrow makes the C truncate at every incoming edge, which is unobservable only
// while the carrier's single reader reads just those bits. Each refusal is ABLATED against its own
// fixture — `without` drops that one gate and the pass must then narrow, which is also what proves
// the fixture is refused by that gate alone.
//
// The two carriers of the accepted fixture are its own control: `narrowcnt`'s accumulator sits in
// the same block, the same loop and the same terminator as its counter, and is refused while the
// counter narrows. Three refusals are one-fact edits of that fixture; `NOT_AN_EXTENSION` (the
// benchmark's `widecnt` row) and `ENTRY_PARAM` (the sibling pass's shape) are their own, because
// neither is reachable by editing one fact. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { NARROW_LOCAL_GATES, narrowBlockLocals } from '../src/raise/narrowlocal';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const run = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = narrowBlockLocals(fn);
  verify(fn);
  return { fn, n, ir: print(fn) };
};
/** the same pass with one gate dropped — the ablation each refusal below is measured against */
const runWithout = (ir: string, gate: string): number => {
  const fn = parse(ir);
  verify(fn);
  return narrowBlockLocals(fn, without(NARROW_LOCAL_GATES, gate));
};
const emit = (ir: string): string => {
  const { fn } = run(ir);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

/** the benchmark's `narrowcnt` row as it reaches this pass: `s16 i` summed into an `s32` total.
 *  `%2` is the narrow counter — sole reader `%4`, its own sign extension. `%3` is the accumulator,
 *  read by the `add` itself, and it is the control that must stay wide. */
const NARROW_COUNTER = `fn f {
^bb0():
  %0: unk32 = const {value=0}
  %1: unk32 = const {value=0}
  br ^bb1(%1, %0)
^bb1(%2: unk32, %3: unk32):
  %4: unk32 = sext %2 {width=16}
  %5: unk32 = add %3, %4
  %6: unk32 = const {value=1}
  %7: unk32 = add %4, %6
  %8: unk32 = zext %7 {width=16}
  %9: unk32 = sext %8 {width=16}
  %10: unk32 = const {value=9}
  %11: u32 = icmp_sle %9, %10
  cond_br %11, ^bb1(%8, %5), ^bb2()
^bb2():
  ret %5
}
`;

/** the benchmark's `widecnt` row: the same loop with an `s32` counter — no extension anywhere, so
 *  the counter's sole reader is the `add` that increments it. */
const NOT_AN_EXTENSION = `fn f {
^bb0():
  %0: unk32 = const {value=0}
  %1: unk32 = const {value=0}
  br ^bb1(%1, %0)
^bb1(%2: unk32, %3: unk32):
  %4: unk32 = add %3, %2
  %5: unk32 = const {value=1}
  %6: unk32 = add %2, %5
  %7: unk32 = const {value=9}
  %8: u32 = icmp_sle %6, %7
  cond_br %8, ^bb1(%6, %4), ^bb2()
^bb2():
  ret %4
}
`;

/** an ENTRY parameter whose sole reader is its prologue extension — raise/paramwidth.ts's shape,
 *  and the one place a narrow width is settled by a caller's declaration rather than by this pass. */
const ENTRY_PARAM = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = sext %0 {width=16}
  store %1, %2 {off=0, width=4}
  ret
}
`;

describe('a block parameter extended at its only read is declared at that width', () => {
  test('a sole `sext {16}` types the carrier `s16` and drops the extension', () => {
    const { n, fn, ir } = run(NARROW_COUNTER);
    expect(n).toBe(1);
    expect(fn.blocks[1].params[0].type).toEqual({ kind: 'int', width: 16, signed: true });
    // the accumulator beside it keeps its register width
    expect(fn.blocks[1].params[1].type).toEqual({ kind: 'unknown', width: 32 });
    // one `sext` left: the loop test's, which reads the carrier's NEXT value, not the carrier
    expect(ir.match(/sext/g)).toHaveLength(1);
    expect(ir).toMatch(/add %3, %2/);
  });

  test('…and the emitted local carries the width, with no cast at the body use', () => {
    const src = emit(NARROW_COUNTER);
    expect(src).toContain('s16 v0');
    expect(src).toContain('v1 = v1 + v0;');
  });

  test('the extension kind picks the signedness and its width the type', () => {
    const at = (op: string, width: number) =>
      run(NARROW_COUNTER.replace('sext %2 {width=16}', `${op} %2 {width=${width}}`)).fn.blocks[1].params[0].type;
    expect(at('zext', 16)).toEqual({ kind: 'int', width: 16, signed: false });
    expect(at('sext', 8)).toEqual({ kind: 'int', width: 8, signed: true });
    expect(at('zext', 8)).toEqual({ kind: 'int', width: 8, signed: false });
  });
});

describe('refusals', () => {
  test('a second reader of the raw carrier refuses the narrowing', () => {
    // The accumulator reads the counter itself as well as its cast, so the bits a narrow
    // declaration drops are observable and no such declaration produces this IR.
    const ir = NARROW_COUNTER.replace('%5: unk32 = add %3, %4', '%5: unk32 = add %3, %2');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'raw-reader')).toBe(1);
  });

  test('a carrier whose sole reader is not an extension states no width', () => {
    expect(run(NOT_AN_EXTENSION).n).toBe(0);
    // `raw-reader` is the gate that carries both halves — one reader, and an extension.
    expect(runWithout(NOT_AN_EXTENSION, 'raw-reader')).toBe(0);
  });

  test('a carrier forwarded as a branch argument refuses the narrowing', () => {
    // The exit edge hands the counter to another block, which reads it at its full width.
    const ir = NARROW_COUNTER.replace('cond_br %11, ^bb1(%8, %5), ^bb2()', 'cond_br %11, ^bb1(%8, %5), ^bb2(%2)')
      .replace('^bb2():', '^bb2(%12: unk32):')
      .replace('ret %5', 'ret %12');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'forwarded')).toBe(1);
  });

  test('a width no C type spells is refused', () => {
    const ir = NARROW_COUNTER.replace('sext %2 {width=16}', 'sext %2 {width=24}');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'cast-width')).toBe(1);
  });

  test('a parameter the pointer recovery already typed is left alone', () => {
    // The struct/array recognizers run ahead of this pass and write exactly such a type; only the
    // type stands between a recovered `s32 *` carrier and an `s16` declaration.
    const ir = NARROW_COUNTER.replace('^bb1(%2: unk32,', '^bb1(%2: s32*,');
    expect(run(ir).n).toBe(0);
    expect(runWithout(ir, 'param-typed')).toBe(1);
  });

  test('an entry parameter is left to raise/paramwidth.ts', () => {
    // Same shape, decided by a different rule: a caller's declaration outranks the inference there,
    // and this pass has no prototype to check against.
    expect(run(ENTRY_PARAM).n).toBe(0);
    expect(runWithout(ENTRY_PARAM, 'entry-param')).toBe(1);
  });
});

describe("a wide name is not a narrow carrier's home", () => {
  // The converse of param-width.test.ts's "a narrow parameter is not a wide value's home", and the
  // half this pass introduces. A name's type is fixed by its FIRST claimant, so a narrow carrier
  // that adopts an already-`s32` name is DECLARED wide — and its one reading extension is already
  // gone, deleted against the promise that reading the local re-applies it. The merge below reaches
  // the structurer with `a0` as an incoming argument, and taking that name emits `*a1 = a0` where
  // the graph says `*a1 = (s16)a0`: 70000 stored instead of 4464.
  const MERGE_ONTO_WIDE_NAME = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=0}
  %3: u32 = icmp_sle %0, %2
  cond_br %3, ^bb1(), ^bb2(%0)
^bb1():
  %4: unk32 = const {value=70000}
  br ^bb2(%4)
^bb2(%5: unk32):
  %6: unk32 = sext %5 {width=16}
  store %1, %6 {off=0, width=4}
  ret
}
`;

  test('a narrowed carrier whose incoming value is a wide name takes a fresh name', () => {
    const { fn, n } = run(MERGE_ONTO_WIDE_NAME);
    expect(n).toBe(1);
    recoverTypes(fn);
    const src = cBackend.emit(structure(fn));
    expect(src).toContain('s16 v0');
    expect(src).toContain('*a1 = v0;');
    // the truncation the graph states must not have been dropped along with the extension
    expect(src).not.toMatch(/\*a1 = a0;/);
  });
});
