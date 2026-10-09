// The `/narrow-decl`, `/narrow-load` and `/narrow-read` variations (l3/narrowdecl.ts): `s32 v; v =
// (u8)(x - 1);` is spelled `u8 v; v = x - 1;`, the spelling `kleod:sub_0803E8CC` was compiled from,
// `s32 v; v = p[4];` is spelled `u8 v; v = p[4];`, the one `pokeemerald:LoadMonInfo` was, and `s32 v;
// v = f(); … (u8)v …` is spelled `u8 v; v = f(); … v …`, the one `pokeemerald:RtcGetDayCount` was.
// Each refusal edits one fact of an accepted tree: a structured fixture below, or a hand-built one
// where the fact (a pointer operand, a `for` init) is not a lift's to produce.
import { describe, expect, it } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import type { Expr, SFn } from '../src/l3/ast';
import { narrowDeclarations, narrowLoadDeclarations, narrowReadDeclarations } from '../src/l3/narrowdecl';
import { recoverTypes } from '../src/raise/recover';
import { STACKED_SUBSETS, STACKED_VARIATIONS, applyStacked } from '../src/rank-variations';
import { structure } from '../src/structure/structure';

// sub_0803E8CC's shape: a byte read, less one, zero-extended once and read twice around a call
const NAMED = `fn named {
^bb0():
  %0: u8* = gaddr {sym="gA"}
  %1: s32 = load %0 {off=12, signed=false, width=1}
  %2: s32 = const {value=1}
  %3: s32 = sub %1, %2
  %4: unk32 = zext %3 {width=8}
  %5: s32 = call {target="rnd"}
  %6: s32 = const {value=1}
  %7: s32 = and %4, %6
  %8: s32 = const {value=5}
  %9: s32 = sub %8, %4
  %10: s32 = add %7, %9
  %11: s32 = add %10, %5
  %12: u8* = gaddr {sym="gB"}
  store %12, %11 {off=14, width=1}
  ret
}
`;

// RtcGetDayCount's shape: the first call's result named, because the second call's argument load
// must not move ahead of it, and zero-extended right after the call, as a `u8` local stores it
const READ = `fn read {
^bb0(%0: u8*):
  %1: s32 = load %0 {off=0, signed=false, width=1}
  %2: s32 = call %1 {target="cv"}
  %3: unk32 = zext %2 {width=8}
  %4: s32 = load %0 {off=1, signed=false, width=1}
  %5: s32 = call %4 {target="cv"}
  %6: unk32 = zext %5 {width=8}
  %7: s32 = call %3, %6 {target="dc"}
  ret %7
}
`;

// LoadMonInfo's shape: a byte read named because a call runs between it and its second read
const LOADED = `fn loaded {
^bb0(%0: u8*):
  %1: s32 = load %0 {off=4, signed=false, width=1}
  %2: s32 = call %1 {target="rnd"}
  %3: s32 = add %2, %1
  ret %3
}
`;

// sub_0803E8CC's cast-written local beside LoadMonInfo's load-written one
const BOTH = `fn both {
^bb0(%0: u8*):
  %1: s32 = load %0 {off=4, signed=false, width=1}
  %2: u8* = gaddr {sym="gA"}
  %3: s32 = load %2 {off=12, signed=false, width=1}
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  %6: unk32 = zext %5 {width=8}
  %7: s32 = call {target="rnd"}
  %8: s32 = const {value=1}
  %9: s32 = and %6, %8
  %10: s32 = const {value=5}
  %11: s32 = sub %10, %6
  %12: s32 = add %9, %11
  %13: s32 = add %12, %7
  %14: s32 = add %13, %1
  %15: u8* = gaddr {sym="gB"}
  store %15, %14 {off=14, width=1}
  ret
}
`;

const structured = (ir: string): SFn => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return structure(fn, { homeDerivedReads: true });
};

const local = (sfn: SFn, name: string) => sfn.locals.find((l) => l.name === name);

const v0 = { k: 'var' as const, name: 'v0' };
const cast = (width: number, signed: boolean, e: Expr): Expr => ({
  k: 'cast',
  to: { kind: 'int', width, signed },
  e,
});
/** the tree with `g(arg);` appended */
const passed = (sfn: SFn, arg: Expr): SFn => ({
  ...sfn,
  body: [...sfn.body, { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [arg] } }],
});
/** the tree with `st` ahead of its body */
const beforeIt = (sfn: SFn, st: SFn['body'][number]): SFn => ({ ...sfn, body: [st, ...sfn.body] });
/** the tree with `st` right after `v0`'s one write */
const afterTheWrite = (sfn: SFn, st: SFn['body'][number]): SFn => ({
  ...sfn,
  body: sfn.body.flatMap((s) => (s.k === 'assign' && s.name === 'v0' ? [s, st] : [s])),
});
/** where a second write goes: ahead of the call's write, or after it */
const SIDES = [
  ['ahead of', beforeIt],
  ['after', afterTheWrite],
] as const;
/** writes that are neither an `int` nor a call */
const NOT_INT = [
  ['a pointer', { k: 'var', name: 'a0' }],
  ['a float', { k: 'fconst', bits: '3ff8000000000000' }],
  ['of no known type', { k: 'addr', name: 'gX' }],
] satisfies [string, Expr][];
/** the tree with `v0`'s one write storing `value` */
const writing = (sfn: SFn, value: Expr): SFn => ({
  ...sfn,
  body: sfn.body.map((st) => (st.k === 'assign' && st.name === 'v0' ? { ...st, value } : st)),
});

describe('narrowDeclarations', () => {
  it('declares a once-written s32 local at the width of the cast that writes it, and drops the cast', () => {
    const before = structured(NAMED);
    expect(cBackend.emit(before)).toContain('v0 = (u8)(((u8 *)&gA)[12] - 1);');
    const src = cBackend.emit(narrowDeclarations(before)!);
    expect(src).toContain('u8 v0;');
    expect(src).toContain('v0 = ((u8 *)&gA)[12] - 1;');
    expect(src).toContain('(v0 & 1) + (5 - v0)');
  });

  it('keeps a signed narrowing signed', () => {
    const sfn = narrowDeclarations(structured(NAMED.replace('zext %3 {width=8}', 'sext %3 {width=16}')))!;
    expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 16, signed: true });
  });

  it('does not narrow a u32 local, whose reads are unsigned', () => {
    const sfn = structured(NAMED);
    const wide = {
      ...sfn,
      locals: sfn.locals.map((l) => ({ ...l, type: { kind: 'int' as const, width: 32, signed: false } })),
    };
    expect(narrowDeclarations(wide)).toBeNull();
  });

  it('does not narrow a local written twice', () => {
    const sfn = structured(NAMED);
    const twice = {
      ...sfn,
      body: [...sfn.body, { k: 'assign' as const, name: 'v0', value: { k: 'const' as const, value: 0 } }],
    };
    expect(narrowDeclarations(twice)).toBeNull();
  });

  it('does not narrow a local a `v++` also writes', () => {
    const sfn = structured(NAMED);
    const bumped = {
      ...sfn,
      body: [...sfn.body, { k: 'exprstmt' as const, value: { k: 'postincr' as const, name: 'v0', by: 1 as const } }],
    };
    expect(narrowDeclarations(bumped)).toBeNull();
  });

  it('does not narrow a local whose one write is a `for` loop init', () => {
    const sfn = structured(NAMED);
    const write = sfn.body.find((st) => st.k === 'assign' && st.name === 'v0')!;
    const looped = {
      ...sfn,
      body: [
        {
          k: 'for' as const,
          init: write,
          cond: { k: 'var' as const, name: 'v0' },
          inc: { k: 'break' as const },
          body: [],
        },
        ...sfn.body.filter((st) => st !== write),
      ],
    };
    expect(narrowDeclarations(looped)).toBeNull();
  });

  it('does not narrow a local whose one write is not a narrowing cast', () => {
    const sfn = structured(NAMED.replace('%4: unk32 = zext %3 {width=8}', '%4: s32 = add %3, %2'));
    expect(narrowDeclarations(sfn)).toBeNull();
  });

  it('does not retype a local written through a cast that does not narrow', () => {
    const sfn = structured(NAMED);
    const recast = (list: SFn['body']): SFn['body'] =>
      list.map((st) =>
        st.k === 'assign' && st.name === 'v0' && st.value.k === 'cast'
          ? { ...st, value: { ...st.value, to: { kind: 'int' as const, width: 32, signed: false } } }
          : st,
      );
    const wide = { ...sfn, body: recast(sfn.body) };
    expect(narrowDeclarations(wide)).toBeNull();
  });

  it('keeps the cast that converts a pointer, which C does not convert implicitly', () => {
    const ptr: SFn = {
      name: 'f',
      params: [{ name: 'a0', type: { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } } }],
      locals: [{ name: 'v0', type: { kind: 'int', width: 32, signed: true } }],
      retType: { kind: 'int', width: 32, signed: true },
      body: [
        {
          k: 'assign',
          name: 'v0',
          value: { k: 'cast', to: { kind: 'int', width: 8, signed: false }, e: { k: 'var', name: 'a0' } },
        },
        { k: 'return', value: { k: 'bin', op: '+', l: { k: 'var', name: 'v0' }, r: { k: 'var', name: 'v0' } } },
      ],
    };
    expect(narrowDeclarations(ptr)).toBeNull();
  });

  it('does not narrow a local whose address is taken', () => {
    const sfn = structured(NAMED);
    const taken = {
      ...sfn,
      body: [
        ...sfn.body,
        { k: 'exprstmt' as const, value: { k: 'call' as const, fn: 'f', args: [{ k: 'addr' as const, name: 'v0' }] } },
      ],
    };
    expect(narrowDeclarations(taken)).toBeNull();
  });

  it.each(['volatile', 'frame', 'uninit', 'slots'] as const)(
    'does not narrow a %s local, which lives in memory',
    (fact) => {
      const sfn = structured(NAMED);
      const value = { volatile: true, frame: { loads: 2, stores: 1 }, uninit: true, slots: [4] }[fact];
      const marked = { ...sfn, locals: sfn.locals.map((l) => (l.name === 'v0' ? { ...l, [fact]: value } : l)) };
      expect(narrowDeclarations(marked)).toBeNull();
    },
  );

  it('leaves Pascal, which cannot spell the width, to refuse the narrow local', () => {
    const wide: SFn = {
      name: 'f',
      params: [{ name: 'a0', type: { kind: 'int', width: 32, signed: true } }],
      locals: [{ name: 'v0', type: { kind: 'int', width: 32, signed: true } }],
      retType: { kind: 'int', width: 32, signed: true },
      body: [
        {
          k: 'assign',
          name: 'v0',
          value: { k: 'cast', to: { kind: 'int', width: 8, signed: false }, e: { k: 'var', name: 'a0' } },
        },
        { k: 'return', value: { k: 'bin', op: '+', l: { k: 'var', name: 'v0' }, r: { k: 'var', name: 'v0' } } },
      ],
    };
    const narrow = narrowDeclarations(wide)!;
    expect(local(narrow, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
    expect(() => pascalBackend.emit(narrow)).toThrow(/no spelling for a narrow local \(8 bits\)/);
  });

  it('does not narrow a constant write that fits no type of the narrow width', () => {
    const wide = (value: number): SFn => ({
      name: 'f',
      params: [],
      locals: [{ name: 'v0', type: { kind: 'int', width: 32, signed: true } }],
      retType: { kind: 'int', width: 32, signed: true },
      body: [
        { k: 'assign', name: 'v0', value: cast(8, false, { k: 'const', value }) },
        { k: 'return', value: { k: 'bin', op: '+', l: v0, r: v0 } },
      ],
    });
    expect(narrowDeclarations(wide(300))).toBeNull();
    expect(narrowDeclarations(wide(-129))).toBeNull();
    expect(local(narrowDeclarations(wide(-1))!, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
  });

  it('leaves a local written by a memory read to /narrow-load', () => {
    expect(narrowDeclarations(structured(LOADED))).toBeNull();
  });

  it('leaves a local narrowed at its reads to /narrow-read', () => {
    expect(narrowDeclarations(structured(READ))).toBeNull();
  });
});

describe('narrowLoadDeclarations', () => {
  it('declares a once-written s32 local at the width of the memory read that writes it', () => {
    const before = structured(LOADED);
    expect(cBackend.emit(before)).toContain('s32 v0;');
    const src = cBackend.emit(narrowLoadDeclarations(before)!);
    expect(src).toContain('u8 v0;');
    expect(src).toContain('v0 = a0[4];');
    const signed = narrowLoadDeclarations(structured(LOADED.replace('signed=false, width=1', 'signed=true, width=2')))!;
    expect(local(signed, 'v0')?.type).toEqual({ kind: 'int', width: 16, signed: true });
  });

  it('does not narrow a local written by a word read, or by a narrow variable', () => {
    expect(narrowLoadDeclarations(structured(LOADED.replace('width=1', 'width=4')))).toBeNull();
    const byVar: SFn = {
      name: 'f',
      params: [{ name: 'a0', type: { kind: 'int', width: 8, signed: false } }],
      locals: [{ name: 'v0', type: { kind: 'int', width: 32, signed: true } }],
      retType: { kind: 'int', width: 32, signed: true },
      body: [
        { k: 'assign', name: 'v0', value: { k: 'var', name: 'a0' } },
        { k: 'return', value: { k: 'bin', op: '+', l: v0, r: v0 } },
      ],
    };
    expect(narrowLoadDeclarations(byVar)).toBeNull();
  });

  it('does not narrow a u32 local, or one written twice, by a memory read', () => {
    const sfn = structured(LOADED);
    const unsigned = {
      ...sfn,
      locals: sfn.locals.map((l) => ({ ...l, type: { kind: 'int' as const, width: 32, signed: false } })),
    };
    expect(narrowLoadDeclarations(unsigned)).toBeNull();
    const twice = {
      ...sfn,
      body: [...sfn.body, { k: 'assign' as const, name: 'v0', value: { k: 'const' as const, value: 300 } }],
    };
    expect(narrowLoadDeclarations(twice)).toBeNull();
  });

  it('leaves a local written by a narrowing cast to /narrow-decl', () => {
    expect(narrowLoadDeclarations(structured(NAMED))).toBeNull();
  });
});

describe('narrowReadDeclarations', () => {
  it('declares an s32 local read only through one narrowing cast at that width, and drops the casts', () => {
    const before = structured(READ);
    expect(cBackend.emit(before)).toContain('return dc((u8)v0, (u8)cv(a0[1]));');
    const src = cBackend.emit(narrowReadDeclarations(before)!);
    expect(src).toContain('u8 v0;');
    expect(src).toContain('v0 = cv(*a0);');
    expect(src).toContain('return dc(v0, (u8)cv(a0[1]));');
  });

  it('keeps a signed narrowing signed', () => {
    const sfn = narrowReadDeclarations(structured(READ.replaceAll('zext', 'sext').replaceAll('width=8', 'width=16')))!;
    expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 16, signed: true });
  });

  it('takes a read narrowed the way the others are', () => {
    const sfn = narrowReadDeclarations(passed(structured(READ), cast(8, false, v0)))!;
    expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
  });

  it('leaves a local narrowed at its write to /narrow-decl', () => {
    expect(narrowReadDeclarations(structured(NAMED))).toBeNull();
  });

  it('does not narrow a local one of whose reads is bare', () => {
    expect(narrowReadDeclarations(passed(structured(READ), v0))).toBeNull();
  });

  it('takes a u32 local, whose reads narrow it the way an s32 one is narrowed', () => {
    const sfn = structured(READ);
    const wide = {
      ...sfn,
      locals: sfn.locals.map((l) => ({ ...l, type: { kind: 'int' as const, width: 32, signed: false } })),
    };
    expect(local(narrowReadDeclarations(wide)!, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
  });

  it.each(SIDES)(
    'takes a local written twice, the second write %s the call, each value narrowed by every read',
    (_, at) => {
      const sfn = narrowReadDeclarations(
        at(structured(READ), { k: 'assign', name: 'v0', value: { k: 'const', value: 200 } }),
      )!;
      expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
      expect(cBackend.emit(sfn)).toContain('v0 = 200;');
    },
  );

  it.each(SIDES)(
    'does not narrow a local whose write %s the call is a constant that fits no type of the narrow width',
    (_, at) => {
      const twice = at(structured(READ), { k: 'assign', name: 'v0', value: { k: 'const', value: 300 } });
      expect(narrowReadDeclarations(twice)).toBeNull();
    },
  );

  it.each(SIDES)('does not narrow a local whose write %s the call is a `for` loop step', (_, at) => {
    const looped = at(structured(READ), {
      k: 'for',
      init: { k: 'break' },
      cond: { k: 'var', name: 'a0' },
      inc: { k: 'assign', name: 'v0', value: { k: 'const', value: 0 } },
      body: [],
    });
    expect(narrowReadDeclarations(looped)).toBeNull();
  });

  it('does not narrow a local whose reads are cast to two widths', () => {
    expect(narrowReadDeclarations(passed(structured(READ), cast(16, false, v0)))).toBeNull();
  });

  it('does not narrow a local whose reads are cast to two signednesses', () => {
    expect(narrowReadDeclarations(passed(structured(READ), cast(8, true, v0)))).toBeNull();
  });

  it('takes a constant write that fits the narrow width', () => {
    const sfn = narrowReadDeclarations(writing(structured(READ), { k: 'const', value: 200 }))!;
    expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
  });

  it('does not narrow a constant write that fits no type of the narrow width', () => {
    expect(narrowReadDeclarations(writing(structured(READ), { k: 'const', value: 300 }))).toBeNull();
  });

  it.each(NOT_INT)('does not narrow a local whose write is %s', (_, value) => {
    expect(narrowReadDeclarations(writing(structured(READ), value))).toBeNull();
  });

  it.each(SIDES.flatMap(([side, at]) => NOT_INT.map(([what, value]) => [side, what, at, value] as const)))(
    'does not narrow a local whose write %s the call is %s',
    (_, __, at, value) => {
      expect(narrowReadDeclarations(at(structured(READ), { k: 'assign', name: 'v0', value }))).toBeNull();
    },
  );
});

describe('/narrow-decl and /narrow-load stacked', () => {
  const widths = (sfn: SFn) => sfn.locals.map((l) => (l.type.kind === 'int' ? l.type.width : undefined));
  const stacked = (...names: string[]) =>
    applyStacked(
      STACKED_VARIATIONS.filter((x) => names.includes(x.name)),
      structured(BOTH),
    )!;

  it('offers the load-written local and the cast-written local each narrowed alone', () => {
    expect(cBackend.emit(structured(BOTH))).toContain('v0 = a0[4];');
    expect(widths(structured(BOTH))).toEqual([32, 32]);
    expect(widths(stacked('narrow-load').out)).toEqual([8, 32]);
    expect(widths(stacked('narrow-decl').out)).toEqual([32, 8]);
    expect(widths(stacked('narrow-decl', 'narrow-load').out)).toEqual([8, 8]);
  });
});

describe('/narrow-decl and /narrow-read stacked', () => {
  // v0's one read is the narrowing cast that is v1's whole write: `s32 v0; s16 v1; v1 = v0;` and
  // `s16 v0; s32 v1; v1 = v0;` are both offered, and together the write is taken first
  const chained = (): SFn => ({
    name: 'f',
    params: [{ name: 'a0', type: { kind: 'int', width: 32, signed: true } }],
    locals: [
      { name: 'v0', type: { kind: 'int', width: 32, signed: true } },
      { name: 'v1', type: { kind: 'int', width: 32, signed: true } },
    ],
    retType: { kind: 'int', width: 32, signed: true },
    body: [
      { k: 'assign', name: 'v0', value: { k: 'call', fn: 'g', args: [{ k: 'var', name: 'a0' }] } },
      { k: 'assign', name: 'v1', value: cast(16, true, v0) },
      { k: 'return', value: { k: 'bin', op: '+', l: { k: 'var', name: 'v1' }, r: { k: 'var', name: 'v1' } } },
    ],
  });
  const widths = (sfn: SFn) => sfn.locals.map((l) => (l.type.kind === 'int' ? l.type.width : undefined));
  const stacked = (...names: string[]) =>
    applyStacked(
      STACKED_VARIATIONS.filter((x) => names.includes(x.name)),
      chained(),
    )!;

  it('offers each side alone', () => {
    expect(widths(stacked('narrow-decl').out)).toEqual([32, 16]);
    expect(widths(stacked('narrow-read').out)).toEqual([16, 32]);
  });

  it('takes the write first when both are applied', () => {
    const both = stacked('narrow-decl', 'narrow-read');
    expect(both.variations).toEqual(['narrow-decl']);
    expect(widths(both.out)).toEqual([32, 16]);
  });
});

describe('the stacked subsets', () => {
  const names = STACKED_SUBSETS.map((subset) => subset.map((x) => x.name).join('/'));

  it.each([
    'narrow-decl',
    'narrow-load',
    'narrow-read',
    'narrow-decl/narrow-load',
    'narrow-decl/narrow-read',
    'narrow-load/narrow-read',
    'narrow-decl/narrow-load/narrow-read',
  ])('offers the width subset %s', (subset) => {
    expect(names).toContain(subset);
  });

  it('does not cross a width subset with a shape short of the all-together candidate', () => {
    const crossed = STACKED_SUBSETS.filter(
      (subset) =>
        subset.length > 1 &&
        subset.length < STACKED_VARIATIONS.length &&
        subset.some((x) => !x.name.startsWith('narrow-')),
    );
    expect(crossed).toEqual([]);
  });
});
