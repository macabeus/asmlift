// UNIT tests for the pointer/integer spelling of operands (structure/pointer-spelling.ts): whether
// a value is written as a pointer or as an integer, and through which cast. Each case builds the
// facts structure() hands the factory — the map's declarations, the globals the IR loads as a
// pointer or as a word, the declared variable types — and the IR op being spelled, and pins what
// the rules spell for them today. The compiled evidence for each spelling stays with the
// end-to-end suites (pointer-members.test.ts, ptrcell.test.ts, deref-typing.test.ts).
import { describe, expect, test } from 'vitest';

import { type Op, type Value, mkOp, mkValue } from '../src/ir/core';
import type { Opcode } from '../src/ir/opcodes';
import { type IrType, T } from '../src/ir/types';
import type { BinOp, Expr } from '../src/l3/ast';
import { memoFieldsOf } from '../src/structure/globalaccess';
import { declaresBytePointer, holdsPointerWord, makePointerSpelling } from '../src/structure/pointer-spelling';
import type { SymbolInfo } from '../src/symbols';

interface Fixture {
  /** the project map's entries; absent ⇒ no map */
  map?: SymbolInfo[];
  pointerGlobals?: string[];
  pointerLoaded?: string[];
  wordLoaded?: string[];
  /** the globals structure() spells bare */
  scalar?: string[];
  varType?: Record<string, IrType>;
}
// The map lookup as structure() builds it: by name, with its member lookup.
const make = (f: Fixture = {}) => {
  const byName = new Map((f.map ?? []).map((si) => [si.name, si]));
  const info = (n: string) => byName.get(n);
  return makePointerSpelling({
    sym: f.map === undefined ? undefined : { info, fieldsOf: memoFieldsOf(info) },
    pointerGlobals: f.pointerGlobals === undefined ? undefined : new Set(f.pointerGlobals),
    pointerLoadedGlobals: new Set(f.pointerLoaded ?? []),
    wordLoadedGlobals: new Set(f.wordLoaded ?? []),
    scalarGlobals: new Set(f.scalar ?? []),
    varType: new Map(Object.entries(f.varType ?? {})),
  });
};

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const addr = (name: string): Expr => ({ k: 'addr', name });
const cast = (to: IrType, e: Expr): Expr => ({ k: 'cast', to, e });
const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const member = (base: string, name: string): Expr => ({ k: 'field', base: v(base), name });
const dotMember = (base: string, name: string): Expr => ({ k: 'field', base: v(base), name, dot: true });
const bytes = (e: Expr): Expr => cast(T.ptr(T.u(8)), e);
const word = (e: Expr): Expr => cast(T.u(32), e);

/** A two-operand integer arithmetic op whose result the IR types `result`. */
const arithOp = (opcode: 'add' | 'sub' | 'and' | 'logic_and', result: IrType): Op =>
  mkOp(opcode, { operands: [mkValue(T.u(32)), mkValue(T.u(32))], results: [mkValue(result)] });
const spell = (s: ReturnType<typeof make>, d: Op, l: Expr, r: Expr) => s.arith(d, l, r, false);
/** The sum `arith` prints: `l op r`, cast back to `restoreTo` when there is one. */
const sum = (op: BinOp, l: Expr, r: Expr, restoreTo?: IrType): Expr =>
  restoreTo === undefined ? bin(op, l, r) : cast(restoreTo, bin(op, l, r));

const ptrInfo = (name: string): SymbolInfo => ({ name, kind: 'data', declared: true, shape: 'pointer', size: 4 });
const u16Info = (name: string, over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  name,
  kind: 'data',
  declared: true,
  shape: 'scalar',
  size: 2,
  signed: false,
  ...over,
});

// A struct global with a `void *` and a `u16 *` member beside an integer one, and a pointer global
// whose pointee seats a pointer member.
const bgPtrsInfo: SymbolInfo = {
  name: 'gBgPtrs',
  kind: 'data',
  declared: true,
  shape: 'struct',
  structName: 'BgPtrs',
  size: 12,
  layout: [
    { name: 'pTiles', offset: 0, size: 4, pointer: true },
    { name: 'pMap', offset: 4, size: 4, pointer: true, pointeeSize: 2, pointeeSigned: false },
    { name: 'count', offset: 8, size: 4, signed: true },
  ],
};
const outerInfo: SymbolInfo = {
  name: 'gQ',
  kind: 'data',
  declared: true,
  shape: 'pointer',
  size: 4,
  pointee: {
    structName: 'Inner',
    size: 8,
    volatile: false,
    const: false,
    layout: [
      { name: 'n', offset: 0, size: 4, signed: true },
      { name: 'pInner', offset: 4, size: 4, pointer: true },
    ],
  },
};

describe('needsIntSpelling', () => {
  test('a pointer-typed local, a bare address and an undeclared pointer-loaded global need the integer', () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { a0: T.ptr(T.u(16)) } });
    expect(s.needsIntSpelling(v('a0'))).toBe(true);
    expect(s.needsIntSpelling(addr('gArr'))).toBe(true);
    expect(s.needsIntSpelling(v('gPtr'))).toBe(true);
  });

  test('an integer local, and a pointer-loaded global the map declares a scalar, take `-` as spelled', () => {
    const s = make({ map: [u16Info('gPtr')], pointerLoaded: ['gPtr'], varType: { a0: T.s(32) } });
    expect(s.needsIntSpelling(v('a0'))).toBe(false);
    expect(s.needsIntSpelling(v('gPtr'))).toBe(false);
  });

  test('a global the map declares a pointer needs it whatever the IR loaded it as', () => {
    expect(make({ map: [ptrInfo('gP')] }).needsIntSpelling(v('gP'))).toBe(true);
    expect(make({ pointerGlobals: ['gP'] }).needsIntSpelling(v('gP'))).toBe(true);
  });

  test('a member the map declares a pointer needs it, through a struct global or a pointee', () => {
    const s = make({ map: [bgPtrsInfo, outerInfo] });
    expect(s.needsIntSpelling(dotMember('gBgPtrs', 'pMap'))).toBe(true);
    expect(s.needsIntSpelling(member('gQ', 'pInner'))).toBe(true);
    expect(s.needsIntSpelling(dotMember('gBgPtrs', 'count'))).toBe(false);
    expect(s.needsIntSpelling(member('gQ', 'n'))).toBe(false);
  });

  test('a member no map declares is no pointer value', () => {
    expect(make().needsIntSpelling(dotMember('gBgPtrs', 'pMap'))).toBe(false);
  });
});

describe('intoDeclaredTemp', () => {
  test("a pointer global value goes into a declared temp through the temp's own type", () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { v0: T.ptr(T.u(16)) } });
    expect(s.intoDeclaredTemp('v0', v('gPtr'))).toEqual(cast(T.ptr(T.u(16)), v('gPtr')));
  });

  test('a name with no declared type takes the value as it is', () => {
    expect(make({ pointerLoaded: ['gPtr'] }).intoDeclaredTemp('v9', v('gPtr'))).toEqual(v('gPtr'));
  });

  test('a rendered pointer of another type is cast, one of the same type is not', () => {
    const s = make({ varType: { v0: T.ptr(T.s(32)), a0: T.ptr(T.s(32)) } });
    expect(s.intoDeclaredTemp('v0', bytes(v('a0')))).toEqual(cast(T.ptr(T.s(32)), bytes(v('a0'))));
    expect(s.intoDeclaredTemp('v0', v('a0'))).toEqual(v('a0'));
  });

  test("`&g` stays bare only where the map declares g a plain scalar of the temp's pointee", () => {
    const into = (si: SymbolInfo | undefined, t: IrType) =>
      make({ map: si === undefined ? [] : [si], varType: { v0: t } }).intoDeclaredTemp('v0', addr('gS'));
    expect(into(u16Info('gS'), T.ptr(T.u(16)))).toEqual(addr('gS'));
    expect(into(u16Info('gS', { volatile: true }), T.ptr(T.u(16)))).toEqual(cast(T.ptr(T.u(16)), addr('gS')));
    expect(into(u16Info('gS'), T.ptr(T.s(16)))).toEqual(cast(T.ptr(T.s(16)), addr('gS')));
    expect(into(undefined, T.ptr(T.u(16)))).toEqual(cast(T.ptr(T.u(16)), addr('gS')));
  });

  test('an integer temp takes a pointer value through its integer type', () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { v0: T.u(32) } });
    expect(s.intoDeclaredTemp('v0', v('gPtr'))).toEqual(word(v('gPtr')));
  });
});

describe('intoPtrCell', () => {
  test('a pointer value stored into a pointer cell goes through `void *`', () => {
    const s = make({ pointerLoaded: ['gCell', 'gPtr'], varType: { a0: T.ptr(T.u(16)) } });
    expect(s.intoPtrCell(v('gCell'), v('a0'))).toEqual(cast(T.ptr(T.void()), v('a0')));
    expect(s.intoPtrCell(v('gCell'), v('gPtr'))).toEqual(cast(T.ptr(T.void()), v('gPtr')));
  });

  test('a `void *` value, an integer value and a cell that is no pointer value are left alone', () => {
    const s = make({ pointerLoaded: ['gCell'], varType: { a0: T.ptr(T.void()), a1: T.s(32) } });
    expect(s.intoPtrCell(v('gCell'), v('a0'))).toEqual(v('a0'));
    expect(s.intoPtrCell(v('gCell'), v('a1'))).toEqual(v('a1'));
    expect(s.intoPtrCell(v('gWord'), v('a0'))).toEqual(v('a0'));
  });

  test("a pointer value stored into a word cell the map declares an integer takes the cell's type", () => {
    const s = make({
      map: [ptrInfo('gP'), u16Info('gOut', { size: 4, signed: true }), u16Info('gCount', { size: 4 })],
      varType: { a0: T.ptr(T.u(8)) },
    });
    const sum = bin('+', v('a0'), c(4));
    expect(s.intoPtrCell(v('gOut'), sum)).toEqual(cast(T.s(32), sum));
    expect(s.intoPtrCell(v('gCount'), v('gP'))).toEqual(cast(T.u(32), v('gP')));
    expect(s.intoPtrCell(v('gOut'), addr('gArr'))).toEqual(cast(T.s(32), addr('gArr')));
  });

  test("a pointer value stored into a member the map declares an integer takes the member's type", () => {
    const s = make({ map: [ptrInfo('gP'), bgPtrsInfo, outerInfo], varType: { a0: T.ptr(T.u(8)) } });
    const sum = bin('+', v('a0'), c(4));
    expect(s.intoPtrCell(dotMember('gBgPtrs', 'count'), sum)).toEqual(cast(T.s(32), sum));
    expect(s.intoPtrCell(member('gQ', 'n'), v('gP'))).toEqual(cast(T.s(32), v('gP')));
    expect(s.intoPtrCell(dotMember('gBgPtrs', 'field_8'), sum)).toEqual(sum);
  });

  test('an integer value, a narrower integer cell and a cell no map declares are left alone', () => {
    const s = make({
      map: [u16Info('gOut', { size: 4, signed: true }), u16Info('gHalf')],
      varType: { a0: T.ptr(T.u(8)), a1: T.s(32) },
    });
    expect(s.intoPtrCell(v('gOut'), v('a1'))).toEqual(v('a1'));
    expect(s.intoPtrCell(v('gHalf'), v('a0'))).toEqual(v('a0'));
    expect(s.intoPtrCell(v('gOther'), v('a0'))).toEqual(v('a0'));
    expect(make({ varType: { a0: T.ptr(T.u(8)) } }).intoPtrCell(v('gOut'), v('a0'))).toEqual(v('a0'));
  });
});

describe('castsIntoGlobal', () => {
  const s = make({
    map: [
      u16Info('gOut', { size: 4, signed: true }),
      u16Info('gHalf'),
      u16Info('gVol', { size: 4, volatile: true }),
      bgPtrsInfo,
      ptrInfo('gP'),
    ],
    scalar: ['gOut', 'gHalf', 'gVol', 'gP'],
  });

  test('casts into a word global the map declares an integer and spelled bare, or an integer member', () => {
    expect(s.castsIntoGlobal('gOut', 0)).toBe(true);
    expect(s.castsIntoGlobal('gBgPtrs', 8)).toBe(true);
  });

  test('does not cast into a global not spelled bare, at another byte, narrower, volatile or no integer', () => {
    expect(make({ map: [u16Info('gOut', { size: 4, signed: true })] }).castsIntoGlobal('gOut', 0)).toBe(false);
    expect(s.castsIntoGlobal('gOut', 4)).toBe(false);
    expect(s.castsIntoGlobal('gHalf', 0)).toBe(false);
    expect(s.castsIntoGlobal('gVol', 0)).toBe(false);
    expect(s.castsIntoGlobal('gP', 0)).toBe(false);
  });

  test('does not cast into a pointer member, a byte no member starts at, or a global no map declares', () => {
    expect(s.castsIntoGlobal('gBgPtrs', 4)).toBe(false);
    expect(s.castsIntoGlobal('gBgPtrs', 2)).toBe(false);
    expect(s.castsIntoGlobal('gOther', 0)).toBe(false);
  });
});

describe('arith: the operand order of a load pair evaluated right first', () => {
  const swapped = (s: ReturnType<typeof make>, d: Op, l: Expr, r: Expr) => s.arith(d, l, r, true);

  test('re-spells two integer operands in evaluation order', () => {
    const s = make({ varType: { a1: T.s(32) } });
    expect(swapped(s, arithOp('add', T.u(32)), v('gX'), v('a1'))).toEqual(bin('+', v('a1'), v('gX')));
  });

  test('keeps a pointer-loaded global no map declares in the IR’s order of its integer sum, the asm’s on IDO 7.1', () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { a1: T.s(32) } });
    expect(swapped(s, arithOp('add', T.u(32)), v('gPtr'), v('a1'))).toEqual(
      sum('+', word(v('gPtr')), v('a1'), T.ptr(T.u(8))),
    );
  });

  test('keeps a word-loaded global in the IR’s order only in a sum the IR types a pointer, the asm’s on IDO 7.1', () => {
    const s = make({ wordLoaded: ['gW'], varType: { a1: T.s(32) } });
    expect(swapped(s, arithOp('add', T.ptr(T.u(8))), v('gW'), v('a1'))).toEqual(
      sum('+', word(bytes(v('gW'))), v('a1'), T.ptr(T.u(8))),
    );
    expect(swapped(s, arithOp('add', T.u(32)), v('gW'), v('a1'))).toEqual(bin('+', v('a1'), v('gW')));
  });

  test('keeps a rendered pointer', () => {
    const s = make({ varType: { a0: T.ptr(T.u(8)), a1: T.s(32) } });
    expect(swapped(s, arithOp('add', T.u(32)), v('a0'), v('a1'))).toEqual(bin('+', v('a0'), v('a1')));
  });

  test('re-spells a pointer global the map declares, which the table then spells as a pointer sum', () => {
    const s = make({ map: [ptrInfo('gP')], pointerLoaded: ['gP'], varType: { a1: T.s(32) } });
    expect(swapped(s, arithOp('add', T.u(32)), v('gP'), v('a1'))).toEqual(bin('+', v('a1'), bytes(v('gP'))));
  });

  test('keeps a `pointerGlobals` name with no map entry in the IR’s order of its integer sum', () => {
    const s = make({ pointerGlobals: ['gP'], pointerLoaded: ['gP'], varType: { a1: T.s(32) } });
    expect(swapped(s, arithOp('add', T.u(32)), v('gP'), v('a1'))).toEqual(
      sum('+', word(v('gP')), v('a1'), T.ptr(T.u(8))),
    );
  });
});

describe('arith: the pointer stride of a rendered pointer', () => {
  const s = make({ varType: { a0: T.ptr(T.s(32)), a1: T.s(32), a2: T.ptr(T.u(16)), a3: T.ptr(T.s(32)) } });
  const add = arithOp('add', T.ptr(T.s(32)));

  test('an exact byte constant becomes an element count, on either side', () => {
    expect(spell(s, add, v('a0'), c(8))).toEqual(bin('+', v('a0'), c(2)));
    expect(spell(s, add, c(8), v('a0'))).toEqual(bin('+', c(2), v('a0')));
  });

  test('an inexact byte constant walks a byte pointer and is not cast back', () => {
    expect(spell(s, add, v('a0'), c(6))).toEqual(bin('+', bytes(v('a0')), c(6)));
  });

  test('a runtime offset walks a byte pointer and the sum goes back to the pointer type', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(16))), v('a2'), v('a1'))).toEqual(
      sum('+', bytes(v('a2')), v('a1'), T.ptr(T.u(16))),
    );
  });

  test('a pointer difference is the byte count', () => {
    expect(spell(s, arithOp('sub', T.s(32)), v('a0'), v('a3'))).toEqual(bin('-', bytes(v('a0')), bytes(v('a3'))));
  });
});

describe('arith: the integer legalizations', () => {
  test('a non-additive operator takes a rendered pointer as an `s32`', () => {
    const s = make({ varType: { a0: T.ptr(T.u(8)) } });
    expect(spell(s, arithOp('and', T.u(32)), v('a0'), c(3))).toEqual(bin('&', cast(T.s(32), v('a0')), c(3)));
  });

  test('`int - ptr` takes the subtrahend as an `s32`', () => {
    const s = make({ varType: { a0: T.ptr(T.u(8)), a1: T.s(32) } });
    expect(spell(s, arithOp('sub', T.s(32)), v('a1'), v('a0'))).toEqual(bin('-', v('a1'), cast(T.s(32), v('a0'))));
  });

  test('a bare global address is added as the `u32` it is', () => {
    const s = make({ varType: { a1: T.s(32) } });
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), addr('gArr'), v('a1'))).toEqual(
      bin('+', word(addr('gArr')), v('a1')),
    );
  });

  test('a non-additive operator takes a pointer global value as its word', () => {
    const s = make({ pointerLoaded: ['gPtr'] });
    expect(spell(s, arithOp('and', T.u(32)), v('gPtr'), c(3))).toEqual(bin('&', word(v('gPtr')), c(3)));
  });
});

describe('arith: a pointer global value', () => {
  const s = make({ map: [ptrInfo('gP')], pointerLoaded: ['gPtr', 'gP'], varType: { a1: T.s(32) } });

  test('plus a constant is byte arithmetic on the value', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gPtr'), c(16))).toEqual(bin('+', bytes(v('gPtr')), c(16)));
  });

  test('an undeclared one plus a runtime offset is the integer sum, cast back to a byte pointer', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gPtr'), v('a1'))).toEqual(
      sum('+', word(v('gPtr')), v('a1'), T.ptr(T.u(8))),
    );
  });

  test('a map-declared one plus a runtime offset keeps the byte pointer for the member spellings', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gP'), v('a1'))).toEqual(bin('+', bytes(v('gP')), v('a1')));
  });

  test('an undeclared one right of an integer is added as an integer in that order', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), v('gPtr'))).toEqual(
      sum('+', v('a1'), word(v('gPtr')), T.ptr(T.u(8))),
    );
  });

  test('a map-declared one right of an integer is the byte pointer, in that order', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), v('gP'))).toEqual(bin('+', v('a1'), bytes(v('gP'))));
  });
});

describe('arith: a word-loaded global no declaration types', () => {
  const s = make({ wordLoaded: ['gW', 'gB2', 'gB3'], pointerLoaded: ['gPtr'], varType: { a1: T.s(32) } });

  test('is the base of a sum the IR types a pointer, as its word through `(u8 *)`', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('gW'), v('a1'))).toEqual(
      sum('+', word(bytes(v('gW'))), v('a1'), T.ptr(T.u(8))),
    );
  });

  test('is left as spelled in a sum the IR types an integer', () => {
    expect(spell(s, arithOp('add', T.u(32)), v('gW'), v('a1'))).toEqual(bin('+', v('gW'), v('a1')));
  });

  test('subtracted as a sum from a byte sum, each global goes its word', () => {
    const byteSum = spell(s, arithOp('add', T.ptr(T.u(8))), v('gPtr'), c(4));
    const globals = spell(s, arithOp('sub', T.u(32)), v('gB2'), v('gB3'));
    expect(globals).toEqual(bin('-', v('gB2'), v('gB3')));
    expect(spell(s, arithOp('sub', T.u(32)), byteSum, globals)).toEqual(
      bin('-', bin('+', bytes(v('gPtr')), c(4)), bin('-', word(bytes(v('gB2'))), word(bytes(v('gB3'))))),
    );
  });
});

describe('arith: a byte sum the rule already spelled', () => {
  const s = make({ pointerLoaded: ['gPtr'], varType: { a1: T.s(32) } });

  test('right of an integer, it is added as the integer it also is', () => {
    const byteSum = spell(s, arithOp('add', T.ptr(T.u(8))), v('gPtr'), c(4));
    expect(byteSum).toEqual(bin('+', bytes(v('gPtr')), c(4)));
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), byteSum)).toEqual(
      sum('+', v('a1'), bin('+', word(v('gPtr')), c(4)), T.ptr(T.u(8))),
    );
  });

  test('as the subtrahend of `int - ptr`, the restored integer sum is taken unwrapped', () => {
    const restored = spell(s, arithOp('add', T.ptr(T.u(8))), v('gPtr'), v('a1'));
    expect(restored).toEqual(bytes(bin('+', word(v('gPtr')), v('a1'))));
    expect(spell(s, arithOp('sub', T.s(32)), c(100), restored)).toEqual(
      bin('-', c(100), bin('+', word(v('gPtr')), v('a1'))),
    );
  });

  test('a global’s byte pointer printed by another rule is no global of this one: the pointer sum stays', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), v('gPtr'))).toEqual(
      sum('+', v('a1'), word(v('gPtr')), T.ptr(T.u(8))),
    );
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), bytes(v('gPtr')))).toEqual(
      bin('+', v('a1'), bytes(v('gPtr'))),
    );
  });

  test('a byte sum printed by another rule is no byte sum of this one', () => {
    expect(spell(s, arithOp('sub', T.s(32)), c(100), bytes(bin('+', word(v('gPtr')), v('a1'))))).toEqual(
      bin('-', c(100), cast(T.s(32), bytes(bin('+', word(v('gPtr')), v('a1'))))),
    );
  });
});

describe('arith: a pointer member', () => {
  test('plus a runtime offset is byte arithmetic on the member', () => {
    const s = make({ map: [bgPtrsInfo], varType: { a1: T.s(32) } });
    expect(spell(s, arithOp('add', T.ptr(T.u(16))), v('a1'), dotMember('gBgPtrs', 'pMap'))).toEqual(
      bin('+', v('a1'), bytes(dotMember('gBgPtrs', 'pMap'))),
    );
  });
});

describe('arith: the operators that take a pointer as it is', () => {
  test('`&&` keeps a pointer global value bare', () => {
    const s = make({ pointerLoaded: ['gPtr'], varType: { a1: T.s(32) } });
    expect(spell(s, arithOp('logic_and', T.s(32)), v('gPtr'), v('a1'))).toEqual(bin('&&', v('gPtr'), v('a1')));
  });

  test('a byte pointer less a byte pointer is left as it is', () => {
    const s = make({ varType: { a4: T.ptr(T.u(8)), a5: T.ptr(T.u(8)) } });
    expect(spell(s, arithOp('sub', T.s(32)), v('a4'), v('a5'))).toEqual(bin('-', v('a4'), v('a5')));
  });
});

describe('arith: two pointers', () => {
  const s = make({
    pointerLoaded: ['gPtr'],
    map: [ptrInfo('gP')],
    varType: { a0: T.ptr(T.s(32)), a2: T.ptr(T.u(16)) },
  });

  test('a pointer plus a pointer walks the left one as bytes and goes back to its type', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(16))), v('a2'), v('a0'))).toEqual(
      sum('+', bytes(v('a2')), cast(T.s(32), v('a0')), T.ptr(T.u(16))),
    );
  });

  test('a wider pointer less a pointer global value is the byte count, not cast back', () => {
    expect(spell(s, arithOp('sub', T.s(32)), v('a0'), v('gPtr'))).toEqual(bin('-', bytes(v('a0')), bytes(v('gPtr'))));
  });

  test('a map-declared pointer global plus a wider pointer local is the global as its word', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(16))), v('gP'), v('a2'))).toEqual(
      sum('+', word(v('gP')), bytes(v('a2')), T.ptr(T.u(16))),
    );
  });
});

describe('arith: the integer sum of an undeclared pointer global', () => {
  const s = make({
    pointerLoaded: ['gPtr', 'gQ'],
    wordLoaded: ['gW', 'gB'],
    varType: { a1: T.s(32), a2: T.s(32) },
  });
  const toBytes = T.ptr(T.u(8));

  test('its byte-sum partner goes the integer it also is', () => {
    const partner = spell(s, arithOp('add', toBytes), v('gQ'), c(4));
    expect(spell(s, arithOp('add', toBytes), v('gPtr'), partner)).toEqual(
      sum('+', word(v('gPtr')), bin('+', word(v('gQ')), c(4)), toBytes),
    );
  });

  test('a word-loaded global its byte-sum partner holds goes its word', () => {
    const partner = spell(s, arithOp('sub', toBytes), v('gW'), v('a2'));
    expect(partner).toEqual(bin('-', bytes(v('gW')), v('a2')));
    expect(spell(s, arithOp('add', toBytes), v('gPtr'), partner)).toEqual(
      sum('+', word(v('gPtr')), bin('-', word(bytes(v('gW'))), v('a2')), toBytes),
    );
  });

  test('a constant-valued partner keeps the byte pointer', () => {
    const k = bin('<<', c(1), c(2));
    expect(spell(s, arithOp('add', toBytes), v('gPtr'), k)).toEqual(bin('+', bytes(v('gPtr')), k));
  });

  test('right of a word-loaded global, the left one goes its word too', () => {
    expect(spell(s, arithOp('add', T.u(32)), v('gW'), v('gPtr'))).toEqual(
      sum('+', word(bytes(v('gW'))), word(v('gPtr')), toBytes),
    );
  });

  test('right of an integer, a byte sum less a word-loaded global is converted whole', () => {
    const r = spell(s, arithOp('sub', toBytes), spell(s, arithOp('add', toBytes), v('gPtr'), c(8)), v('gB'));
    expect(r).toEqual(bin('-', bin('+', bytes(v('gPtr')), c(8)), v('gB')));
    expect(spell(s, arithOp('add', toBytes), v('a1'), r)).toEqual(sum('+', v('a1'), word(r), toBytes));
  });

  test('`int - ptr` with a restored sum takes a word-loaded global on the left as its word', () => {
    const restored = spell(s, arithOp('add', toBytes), v('gPtr'), v('a1'));
    expect(spell(s, arithOp('sub', T.s(32)), v('gW'), restored)).toEqual(
      bin('-', word(bytes(v('gW'))), bin('+', word(v('gPtr')), v('a1'))),
    );
  });

  test('under a non-additive operator, a restored sum whose word is a converted byte sum is unwrapped', () => {
    const byteSum = spell(s, arithOp('sub', toBytes), spell(s, arithOp('add', toBytes), v('gPtr'), c(8)), v('gB'));
    const restored = spell(s, arithOp('add', toBytes), v('a2'), byteSum);
    expect(restored).toEqual(bytes(bin('+', v('a2'), word(byteSum))));
    expect(spell(s, arithOp('and', T.u(32)), restored, c(255))).toEqual(
      bin('&', bin('+', v('a2'), word(byteSum)), c(255)),
    );
  });
});

describe('arith: a word-loaded global as the base of a pointer-typed op', () => {
  const s = make({ wordLoaded: ['gW', 'gW2'], varType: { a1: T.s(32) } });

  test('right of an integer, it is the base, added as its word', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), v('gW'))).toEqual(
      sum('+', v('a1'), word(bytes(v('gW'))), T.ptr(T.u(8))),
    );
  });

  test('right of an integer it is subtracted from, it is no base', () => {
    expect(spell(s, arithOp('sub', T.ptr(T.u(8))), v('a1'), v('gW'))).toEqual(bin('-', v('a1'), v('gW')));
  });

  test('left of a word-loaded global it is subtracted from, its partner goes its word', () => {
    expect(spell(s, arithOp('sub', T.ptr(T.u(8))), v('gW'), v('gW2'))).toEqual(
      bin('-', bytes(v('gW')), word(bytes(v('gW2')))),
    );
  });

  test('right of a global address, the address stays the base', () => {
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), addr('gArr'), v('gW'))).toEqual(
      bin('+', word(addr('gArr')), v('gW')),
    );
  });
});

describe('arith: a map-declared byte sum right of an integer', () => {
  test('keeps its byte pointer', () => {
    const s = make({ map: [ptrInfo('gP')], pointerLoaded: ['gP'], varType: { a1: T.s(32) } });
    const r = spell(s, arithOp('add', T.ptr(T.u(8))), v('gP'), c(4));
    expect(spell(s, arithOp('add', T.ptr(T.u(8))), v('a1'), r)).toEqual(bin('+', v('a1'), r));
  });
});

describe('holdsPointerWord: a value that only ever holds a pointer global', () => {
  // The IR around the value: each op's results map back to it, and each block parameter to the
  // values its in-edges pass.
  const defs = new Map<Value, Op>();
  const ins = new Map<Value, Value[]>();
  const ir = { defOf: (x: Value) => defs.get(x), inArgs: (x: Value) => ins.get(x) };
  const def = (op: Op): Value => {
    defs.set(op.results[0], op);
    return op.results[0];
  };
  const load = (sym: string, off = 0, width = 4): Value =>
    def(
      mkOp('load', {
        operands: [def(mkOp('gaddr', { attrs: { sym }, results: [mkValue(T.ptr(T.s(32)))] }))],
        attrs: { off, width, signed: false },
        results: [mkValue(T.s(32))],
      }),
    );
  const merge = (...args: Value[]): Value => {
    const p = mkValue(T.s(32));
    ins.set(p, args);
    return p;
  };
  const pointerGlobal = make({
    map: [ptrInfo('gP'), u16Info('gS')],
    pointerGlobals: ['gRaw'],
    pointerLoaded: ['gL', 'gS'],
  }).pointerGlobal;
  const holds = (x: Value) => holdsPointerWord(x, ir, pointerGlobal);

  test("holds a word load at offset 0 of a global the map declares a pointer, or a `pointerGlobals` one's", () => {
    expect(holds(load('gP'))).toBe(true);
    expect(holds(load('gRaw'))).toBe(true);
  });

  test('holds a global no declaration types that the IR loads as a pointer', () => {
    expect(holds(load('gL'))).toBe(true);
  });

  test('holds a merge every in-edge of which passes one, through a loop back to itself', () => {
    expect(holds(merge(load('gP'), load('gP')))).toBe(true);
    const loop = merge(load('gP'));
    ins.get(loop)!.push(loop);
    expect(holds(loop)).toBe(true);
  });

  test('does not hold a global whose declared shape is not a pointer, or one nothing declares or loads as a pointer', () => {
    expect(holds(load('gS'))).toBe(false);
    expect(holds(load('gW'))).toBe(false);
  });

  test('does not hold a load at another offset or narrower than a word', () => {
    expect(holds(load('gP', 4))).toBe(false);
    expect(holds(load('gP', 0, 2))).toBe(false);
  });

  test('does not hold a merge with any other in-edge value, or a parameter no edge passes', () => {
    expect(holds(merge(load('gP'), mkValue(T.s(32))))).toBe(false);
    expect(holds(merge(load('gP'), load('gS')))).toBe(false);
    expect(holds(mkValue(T.s(32)))).toBe(false);
  });
});

describe('declaresBytePointer: when a temp holding a declared pointer word is declared `u8 *`', () => {
  // A temp `t` holding gP's word, and the ops that read it. Each op records itself as a use of its
  // operands, an edge's args included, so a case lists only the ops it builds.
  const defs = new Map<Value, Op>();
  const uses = new Map<Value, Op[]>();
  const ins = new Map<Value, Value[]>();
  const named = new Set<Value>();
  const ir = {
    defOf: (x: Value) => defs.get(x),
    inArgs: (x: Value) => ins.get(x),
    usesOf: (x: Value) => uses.get(x) ?? [],
    isNamed: (x: Value) => named.has(x),
  };
  const op = (opcode: Opcode, operands: Value[], attrs: Op['attrs'] = {}, result: IrType = T.s(32)): Value => {
    const o = mkOp(opcode, { operands, attrs, results: [mkValue(result)] });
    defs.set(o.results[0], o);
    for (const x of operands) {
      uses.set(x, [...(uses.get(x) ?? []), o]);
    }
    return o.results[0];
  };
  const effect = (opcode: Opcode, operands: Value[], attrs: Op['attrs'] = {}): void => {
    const o = mkOp(opcode, { operands, attrs });
    for (const x of operands) {
      uses.set(x, [...(uses.get(x) ?? []), o]);
    }
  };
  const gaddr = (sym: string): Value => op('gaddr', [], { sym }, T.ptr(T.s(32)));
  const word = (): Value => op('load', [gaddr('gP')], { off: 0, width: 4, signed: false });
  const k = (value: number): Value => op('const', [], { value });
  const x = (): Value => mkValue(T.u(32));
  const plusK = (): Value => op('add', [op('shl', [x()], { imm: 2 }), k(2672)]);
  const spelling = make({
    map: [ptrInfo('gP'), u16Info('gOut', { size: 4, signed: true }), bgPtrsInfo],
    scalar: ['gOut'],
  });
  const declares = (...values: Value[]) => declaresBytePointer(values, ir, spelling);
  const scratch = (): Value => op('load', [mkValue(T.ptr(T.s(32)))], { off: 0, width: 4, signed: false });

  test('declares the base of a sum with a constant addend, `t + (x + K)`', () => {
    const t = word();
    effect('store', [scratch(), op('add', [t, plusK()])], { off: 0, width: 4 });
    expect(declares(t)).toBe(true);
  });

  test('counts a merge of constants, or a fold of them, as the addend', () => {
    const merged = mkValue(T.s(32));
    ins.set(merged, [k(2672), op('shl', [k(167)], { imm: 4 })]);
    const t = word();
    op('add', [t, op('add', [op('shl', [x()], { imm: 2 }), merged])]);
    expect(declares(t)).toBe(true);
  });

  test("counts a merge of addend sums as the addend, each arm's `x + K`", () => {
    const merged = mkValue(T.s(32));
    ins.set(merged, [plusK(), plusK()]);
    const t = word();
    op('add', [t, merged]);
    expect(declares(t)).toBe(true);
    const mixed = mkValue(T.s(32));
    ins.set(mixed, [plusK(), x()]);
    const u = word();
    op('add', [u, mixed]);
    expect(declares(u)).toBe(false);
  });

  test('does not declare a temp no sum with a constant addend reads: the two temps compile alike', () => {
    const t = word();
    op('add', [t, op('shl', [x()], { imm: 2 })]);
    op('add', [t, op('shl', [k(250)], { imm: 1 })]);
    expect(declares(t)).toBe(false);
  });

  test('does not count an addend that is itself a constant, `t + (K1 - K2)`', () => {
    const t = word();
    op('add', [t, op('sub', [k(1753), k(23)])]);
    op('add', [t, op('add', [op('shl', [k(167)], { imm: 4 }), k(4)])]);
    expect(declares(t)).toBe(false);
  });

  test('does not count a sum spelled only inside the accesses it addresses', () => {
    const t = word();
    const sum = op('add', [t, plusK()]);
    op('load', [sum], { off: 0, width: 1, signed: false });
    effect('store', [sum, k(255)], { off: 0, width: 1 });
    op('aload', [sum, x()], { elemSize: 1, signed: false });
    effect('astore', [sum, x(), k(255)], { elemSize: 1 });
    expect(declares(t)).toBe(false);
    effect('store', [scratch(), sum], { off: 0, width: 4 });
    expect(declares(t)).toBe(true);
  });

  test('counts a sum a name holds, though only an access reads it', () => {
    const t = word();
    const sum = op('add', [t, plusK()]);
    op('load', [sum], { off: 0, width: 1, signed: false });
    expect(declares(t)).toBe(false);
    named.add(sum);
    expect(declares(t)).toBe(true);
  });

  test('does not count a loop counter as a constant', () => {
    const i = mkValue(T.s(32));
    ins.set(i, [k(0), op('add', [i, k(1)])]);
    const t = word();
    op('add', [t, op('add', [x(), i])]);
    expect(declares(t)).toBe(false);
  });

  test('reads a chain of constant merges once per value, each arm of which reads the last', () => {
    let n = k(0);
    for (let i = 0; i < 20; i++) {
      const merged = mkValue(T.s(32));
      ins.set(merged, [n, op('add', [n, k(1)])]);
      n = merged;
    }
    const t = word();
    op('add', [t, op('add', [op('shl', [x()], { imm: 2 }), n])]);
    let reads = 0;
    const counted = { ...ir, defOf: (v: Value) => (reads++, ir.defOf(v)) };
    expect(declaresBytePointer([t], counted, spelling)).toBe(true);
    expect(reads).toBeLessThan(200);
  });

  test('does not declare the right operand of a sum, which a pointer sum would put first', () => {
    const t = word();
    op('add', [t, plusK()]);
    op('add', [x(), t]);
    expect(declares(t)).toBe(false);
  });

  test('does not declare a temp whose sum is the right operand of a sum, or beside a pointer', () => {
    const t = word();
    op('add', [x(), op('add', [t, plusK()])]);
    expect(declares(t)).toBe(false);
    const u = word();
    op('add', [op('add', [u, plusK()]), mkValue(T.ptr(T.u(16)))]);
    expect(declares(u)).toBe(false);
  });

  test('declares a temp whose sum is the base of a further sum', () => {
    const t = word();
    op('add', [op('add', [t, plusK()]), x()]);
    expect(declares(t)).toBe(true);
  });

  test("does not declare a sum's base beside a global's address or a pointer", () => {
    const t = word();
    op('add', [t, plusK()]);
    op('add', [t, gaddr('gArr')]);
    expect(declares(t)).toBe(false);
    const u = word();
    op('add', [u, plusK()]);
    op('add', [u, mkValue(T.ptr(T.u(16)))]);
    expect(declares(u)).toBe(false);
  });

  test('does not declare a switch selector or an array index', () => {
    const t = word();
    op('add', [t, plusK()]);
    effect('switch_br', [t], { cases: [0, 1] });
    expect(declares(t)).toBe(false);
    const u = word();
    op('add', [u, plusK()]);
    op('aload', [mkValue(T.ptr(T.u(8))), u], { elemSize: 1, signed: false });
    expect(declares(u)).toBe(false);
  });

  test('does not declare a call argument, or a temp written to a global', () => {
    const t = word();
    op('add', [t, plusK()]);
    op('call', [t], { target: 'Use' });
    expect(declares(t)).toBe(false);
    const w = word();
    op('add', [w, plusK()]);
    effect('store', [gaddr('gNone'), w], { off: 0, width: 4 });
    expect(declares(w)).toBe(false);
  });

  test('declares a temp stored as a word into a global or member the map declares an integer', () => {
    const t = word();
    op('add', [t, plusK()]);
    effect('store', [gaddr('gOut'), t], { off: 0, width: 4 });
    expect(declares(t)).toBe(true);
    const u = word();
    op('add', [u, plusK()]);
    effect('store', [gaddr('gBgPtrs'), u], { off: 8, width: 4 });
    expect(declares(u)).toBe(true);
  });

  test('does not declare a temp stored narrower, or into a member that takes no cast', () => {
    const t = word();
    op('add', [t, plusK()]);
    effect('store', [gaddr('gOut'), t], { off: 0, width: 2 });
    expect(declares(t)).toBe(false);
    const u = word();
    op('add', [u, plusK()]);
    effect('store', [gaddr('gBgPtrs'), u], { off: 4, width: 4 });
    expect(declares(u)).toBe(false);
  });

  test('declares a temp whose sum is a call argument or written to a global', () => {
    const t = word();
    op('call', [op('add', [t, plusK()])], { target: 'Use' });
    expect(declares(t)).toBe(true);
    const u = word();
    effect('store', [gaddr('gOut'), op('add', [u, plusK()])], { off: 0, width: 4 });
    expect(declares(u)).toBe(true);
  });

  test('does not declare a temp whose sum is a switch selector or an array index', () => {
    const t = word();
    effect('switch_br', [op('add', [t, plusK()])], { cases: [0, 1] });
    expect(declares(t)).toBe(false);
  });

  test('does not declare a temp one of whose values holds anything else', () => {
    const t = word();
    op('add', [t, plusK()]);
    expect(declares(t, scratch())).toBe(false);
  });
});
