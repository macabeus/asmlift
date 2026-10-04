// The `/narrow-decl` variation (l3/narrowdecl.ts): `s32 v; v = (u8)(x - 1);` is spelled
// `u8 v; v = x - 1;`, the spelling `kleod:sub_0803E8CC` was compiled from, and `s32 v; v = f();
// … (u8)v …` is spelled `u8 v; v = f(); … v …`, the one `pokeemerald:RtcGetDayCount` was. Each
// refusal edits one fact of an accepted tree: a structured fixture below, or a hand-built one
// where the fact (a pointer operand, a `for` init) is not a lift's to produce.
import { describe, expect, it } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import type { Expr, SFn } from '../src/l3/ast';
import { narrowDeclarations } from '../src/l3/narrowdecl';
import { recoverTypes } from '../src/raise/recover';
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
// must not move ahead of it, then zero-extended where it is passed on
const READ = `fn read {
^bb0(%0: u8*):
  %1: s32 = load %0 {off=0, signed=false, width=1}
  %2: s32 = call %1 {target="cv"}
  %3: s32 = load %0 {off=1, signed=false, width=1}
  %4: s32 = call %3 {target="cv"}
  %5: unk32 = zext %2 {width=8}
  %6: unk32 = zext %4 {width=8}
  %7: s32 = call %5, %6 {target="dc"}
  ret %7
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

  describe('a narrowing at every read', () => {
    it('declares an s32 local read only through one narrowing cast at that width, and drops the casts', () => {
      const before = structured(READ);
      expect(cBackend.emit(before)).toContain('return dc((u8)v0, (u8)cv(a0[1]));');
      const src = cBackend.emit(narrowDeclarations(before)!);
      expect(src).toContain('u8 v0;');
      expect(src).toContain('v0 = cv(*a0);');
      expect(src).toContain('return dc(v0, (u8)cv(a0[1]));');
    });

    it('keeps a signed narrowing signed', () => {
      const sfn = narrowDeclarations(structured(READ.replaceAll('zext', 'sext').replaceAll('width=8', 'width=16')))!;
      expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 16, signed: true });
    });

    it('takes a read narrowed the way the others are', () => {
      const sfn = narrowDeclarations(passed(structured(READ), cast(8, false, v0)))!;
      expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
    });

    it('does not narrow a local one of whose reads is bare', () => {
      expect(narrowDeclarations(passed(structured(READ), v0))).toBeNull();
    });

    it('does not narrow a local whose reads are cast to two widths', () => {
      expect(narrowDeclarations(passed(structured(READ), cast(16, false, v0)))).toBeNull();
    });

    it('does not narrow a local whose reads are cast to two signednesses', () => {
      expect(narrowDeclarations(passed(structured(READ), cast(8, true, v0)))).toBeNull();
    });

    it('takes a write that is an integer', () => {
      const sfn = narrowDeclarations(writing(structured(READ), { k: 'const', value: 300 }))!;
      expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 8, signed: false });
    });

    it.each([
      ['a pointer', { k: 'var', name: 'a0' }],
      ['a float', { k: 'fconst', value: 1.5 }],
      ['of no known type', { k: 'addr', name: 'gX' }],
    ] as [string, Expr][])('does not narrow a local whose write is %s', (_, value) => {
      expect(narrowDeclarations(writing(structured(READ), value))).toBeNull();
    });
  });
});
