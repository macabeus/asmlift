// A named narrow value declared at its width (l3/narrowdecl.ts): `s32 v; v = (u8)(x - 1);` is
// spelled `u8 v; v = x - 1;`, the spelling agbcc allocates `kleod:sub_0803E8CC`'s registers from.
// Every refusal is a one-fact edit of the accepted shape.
import { describe, expect, it } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import type { SFn } from '../src/l3/ast';
import { narrowDeclarations } from '../src/l3/narrowdecl';
import { readabilityRewrites } from '../src/pipeline';
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

const structured = (ir: string): SFn => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return structure(fn, { homeDerivedReads: true });
};

const local = (sfn: SFn, name: string) => sfn.locals.find((l) => l.name === name);

describe('narrowDeclarations', () => {
  it('declares a once-written s32 local at the width of the cast that writes it, and drops the cast', () => {
    const before = structured(NAMED);
    expect(cBackend.emit(before)).toContain('v0 = (u8)(((u8 *)&gA)[12] - 1);');
    const src = cBackend.emit(narrowDeclarations(before));
    expect(src).toContain('u8 v0;');
    expect(src).toContain('v0 = ((u8 *)&gA)[12] - 1;');
    expect(src).toContain('(v0 & 1) + (5 - v0)');
  });

  it('is one of the committed readability rewrites', () => {
    expect(cBackend.emit(readabilityRewrites(structured(NAMED)))).toContain('u8 v0;');
  });

  it('keeps a signed narrowing signed', () => {
    const sfn = narrowDeclarations(structured(NAMED.replace('zext %3 {width=8}', 'sext %3 {width=16}')));
    expect(local(sfn, 'v0')?.type).toEqual({ kind: 'int', width: 16, signed: true });
  });

  it('does not narrow a u32 local, whose reads are unsigned', () => {
    const sfn = structured(NAMED);
    const wide = {
      ...sfn,
      locals: sfn.locals.map((l) => ({ ...l, type: { kind: 'int' as const, width: 32, signed: false } })),
    };
    expect(narrowDeclarations(wide)).toBe(wide);
  });

  it('does not narrow a local written twice', () => {
    const sfn = structured(NAMED);
    const twice = {
      ...sfn,
      body: [...sfn.body, { k: 'assign' as const, name: 'v0', value: { k: 'const' as const, value: 0 } }],
    };
    expect(narrowDeclarations(twice)).toBe(twice);
  });

  it('does not narrow a local whose one write is not a narrowing cast', () => {
    const sfn = structured(NAMED.replace('%4: unk32 = zext %3 {width=8}', '%4: s32 = add %3, %2'));
    expect(narrowDeclarations(sfn)).toBe(sfn);
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
    expect(narrowDeclarations(wide)).toBe(wide);
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
    expect(narrowDeclarations(taken)).toBe(taken);
  });

  it.each(['volatile', 'frame', 'uninit', 'slots'] as const)(
    'does not narrow a %s local, which lives in memory',
    (fact) => {
      const sfn = structured(NAMED);
      const value = { volatile: true, frame: { loads: 2, stores: 1 }, uninit: true, slots: [4] }[fact];
      const marked = { ...sfn, locals: sfn.locals.map((l) => (l.name === 'v0' ? { ...l, [fact]: value } : l)) };
      expect(narrowDeclarations(marked)).toBe(marked);
    },
  );
});
