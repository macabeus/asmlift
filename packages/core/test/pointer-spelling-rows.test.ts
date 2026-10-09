// UNIT tests for the arithmetic table (structure/pointer-spelling.ts `ARITH_ROWS`), one case per
// row, in the table's order, and one per operand role. Each expectation is the spelling that
// computes the asm's bytes in the project's translation unit and in the candidate's own declared
// world, where a global no map declares is `extern u32 g;`. A rule that is a compiler's own choice
// says which compiler; the compiled checks of those live in the matching suite
// (packages/cli/test/matching/pointer-spelling.test.ts).
import { describe, expect, it } from 'vitest';

import { type Op, mkOp, mkValue } from '../src/ir/core';
import { type IrType, T } from '../src/ir/types';
import type { BinOp, Expr } from '../src/l3/ast';
import { memoFieldsOf } from '../src/structure/globalaccess';
import { makePointerSpelling } from '../src/structure/pointer-spelling';
import type { SymbolInfo } from '../src/symbols';

const ptrInfo = (name: string): SymbolInfo => ({ name, kind: 'data', declared: true, shape: 'pointer', size: 4 });
const bgPtrsInfo: SymbolInfo = {
  name: 'gBgPtrs',
  kind: 'data',
  declared: true,
  shape: 'struct',
  structName: 'BgPtrs',
  size: 8,
  layout: [
    { name: 'pMap', offset: 0, size: 4, pointer: true, pointeeSize: 2, pointeeSigned: false },
    { name: 'count', offset: 4, size: 4, signed: true },
  ],
};

// One world for every row: the map declares the pointer globals gP and gR and the struct gBgPtrs;
// gPtr and gQ are globals no map declares that the IR loads as pointers, gW, gW2, gB2 and gB3
// ones it loads as words; the locals are typed as named.
const MAP = [ptrInfo('gP'), ptrInfo('gR'), bgPtrsInfo];
const make = () => {
  const byName = new Map(MAP.map((si) => [si.name, si]));
  const info = (n: string) => byName.get(n);
  return makePointerSpelling({
    sym: { info, fieldsOf: memoFieldsOf(info) },
    pointerGlobals: undefined,
    pointerLoadedGlobals: new Set(['gPtr', 'gQ', 'gP', 'gR']),
    wordLoadedGlobals: new Set(['gW', 'gW2', 'gB2', 'gB3']),
    varType: new Map<string, IrType>([
      ['i', T.s(32)],
      ['j', T.s(32)],
      ['pb', T.ptr(T.u(8))],
      ['pb2', T.ptr(T.u(8))],
      ['ph', T.ptr(T.u(16))],
      ['pw', T.ptr(T.s(32))],
    ]),
  });
};

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const addr = (name: string): Expr => ({ k: 'addr', name });
const cast = (to: IrType, e: Expr): Expr => ({ k: 'cast', to, e });
const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const dotMember = (base: string, name: string): Expr => ({ k: 'field', base: v(base), name, dot: true });
const U8P = T.ptr(T.u(8));
const U16P = T.ptr(T.u(16));
const bytes = (e: Expr): Expr => cast(U8P, e);
const word = (e: Expr): Expr => cast(T.u(32), e);
const s32 = (e: Expr): Expr => cast(T.s(32), e);
/** an untyped global's word: through `(u8 *)`, so no float declaration converts it */
const untypedWord = (name: string): Expr => word(bytes(v(name)));

type Opcode = 'add' | 'sub' | 'and' | 'or' | 'shl' | 'logic_and' | 'logic_or';
/** An integer arithmetic op whose result the IR types `result`. */
const op = (opcode: Opcode, result: IrType = T.u(32)): Op =>
  mkOp(opcode, { operands: [mkValue(T.u(32)), mkValue(T.u(32))], results: [mkValue(result)] });
const add = (l: Expr, r: Expr, result?: IrType) => make().arith(op('add', result), l, r, false);
const sub = (l: Expr, r: Expr, result?: IrType) => make().arith(op('sub', result), l, r, false);
/** two ops over one factory, so the second reads the role the first one built */
const chain = <A>(first: (s: ReturnType<typeof make>) => A, then: (s: ReturnType<typeof make>, x: A) => Expr) => {
  const s = make();
  return then(s, first(s));
};

describe('pointer spelling roles', () => {
  const s = make();

  it('reads a constant, an address and a bare name from the leaf', () => {
    expect(s.roleOf(c(4)).k).toBe('literal');
    expect(s.roleOf(addr('gArr')).k).toBe('address');
    expect(s.roleOf(v('gPtr')).k).toBe('name');
  });

  it('reads what the map and the IR say of a bare name', () => {
    const facts = (n: string) => {
      const r = s.roleOf(v(n));
      return r.k === 'name' ? r.facts : undefined;
    };
    expect(facts('gPtr')).toEqual({
      pointer: true,
      undeclared: true,
      mapUndeclared: true,
      pointerLoaded: true,
      wordLoaded: false,
    });
    expect(facts('gP')).toMatchObject({ pointer: true, undeclared: false, mapUndeclared: false });
    expect(facts('gW')).toMatchObject({ pointer: false, undeclared: true, wordLoaded: true });
    expect(facts('i')).toMatchObject({ pointer: false, pointerLoaded: false, wordLoaded: false });
  });

  it('reads a member as a pointer only where the map declares it one', () => {
    expect(s.roleOf(dotMember('gBgPtrs', 'pMap'))).toMatchObject({ k: 'member', pointer: true });
    expect(s.roleOf(dotMember('gBgPtrs', 'count'))).toMatchObject({ k: 'member', pointer: false });
  });

  it('reads any other expression as a value, with whether it is constant or holds an address', () => {
    expect(s.roleOf(bin('<<', c(1), c(2)))).toMatchObject({ k: 'value', made: { constant: true, address: false } });
    expect(s.roleOf(bin('+', addr('gArr'), v('i')))).toMatchObject({ k: 'value', made: { address: true } });
  });

  it('reads back what a value the table built is made of', () => {
    const byteSum = s.arith(op('add', U8P), v('gPtr'), c(4), false);
    expect(s.roleOf(byteSum)).toMatchObject({ k: 'sum', made: { byteSum: { any: true, undeclared: true } } });
    const restored = s.arith(op('add', U8P), v('gPtr'), v('i'), false);
    expect(s.roleOf(restored)).toMatchObject({ k: 'cast', made: { restored: { any: true } } });
  });

  it('does not read a cast printed elsewhere as one the table built', () => {
    expect(s.roleOf(bytes(bin('+', word(v('gPtr')), v('i')))).k).toBe('value');
  });
});

describe('arith: an address operand', () => {
  it('is the `u32` word of the address under every operator', () => {
    expect(add(addr('gArr'), v('i'), U8P)).toEqual(bin('+', word(addr('gArr')), v('i')));
    expect(sub(addr('gArr'), v('i'))).toEqual(bin('-', word(addr('gArr')), v('i')));
    expect(make().arith(op('and'), addr('gArr'), c(3), false)).toEqual(bin('&', word(addr('gArr')), c(3)));
  });
});

describe('arith: the operators that are not additive', () => {
  it('takes a pointer operand of `&&` and `||` as it is', () => {
    expect(make().arith(op('logic_and', T.s(32)), v('gPtr'), v('pb'), false)).toEqual(bin('&&', v('gPtr'), v('pb')));
    expect(make().arith(op('logic_or', T.s(32)), v('pb'), v('i'), false)).toEqual(bin('||', v('pb'), v('i')));
  });

  it('takes every operand of a bitwise or shift operator as an integer', () => {
    const s = make();
    expect(s.arith(op('and'), v('pb'), c(3), false)).toEqual(bin('&', s32(v('pb')), c(3)));
    expect(s.arith(op('or'), v('gPtr'), v('gP'), false)).toEqual(bin('|', word(v('gPtr')), word(v('gP'))));
    expect(s.arith(op('shl'), v('i'), c(2), false)).toEqual(bin('<<', v('i'), c(2)));
    const restored = s.arith(op('add', U8P), v('gPtr'), v('i'), false);
    expect(s.arith(op('and'), restored, c(255), false)).toEqual(bin('&', bin('+', word(v('gPtr')), v('i')), c(255)));
  });
});

describe('arith: a constant right operand', () => {
  it('divides a whole number of the left pointer’s elements into elements', () => {
    expect(add(v('pw'), c(8))).toEqual(bin('+', v('pw'), c(2)));
    expect(sub(v('ph'), c(6))).toEqual(bin('-', v('ph'), c(3)));
  });

  it('walks a wider pointer as bytes for any other constant, and does not cast the sum back', () => {
    expect(add(v('pw'), c(6), T.ptr(T.s(32)))).toEqual(bin('+', bytes(v('pw')), c(6)));
    expect(sub(v('ph'), c(3))).toEqual(bin('-', bytes(v('ph')), c(3)));
  });

  it('adds it to a pointer global or member as bytes', () => {
    expect(add(v('gPtr'), c(16), U8P)).toEqual(bin('+', bytes(v('gPtr')), c(16)));
    expect(add(v('gP'), c(16), U8P)).toEqual(bin('+', bytes(v('gP')), c(16)));
    expect(add(dotMember('gBgPtrs', 'pMap'), c(4), U16P)).toEqual(bin('+', bytes(dotMember('gBgPtrs', 'pMap')), c(4)));
  });

  it('adds it to an untyped global word as bytes where the IR types the sum a pointer', () => {
    expect(add(v('gW'), c(4), U8P)).toEqual(bin('+', bytes(v('gW')), c(4)));
    expect(sub(v('gW'), c(4), U8P)).toEqual(bin('-', bytes(v('gW')), c(4)));
  });

  it('leaves an integer, a byte pointer and an integer sum of a global word as they are', () => {
    expect(add(v('i'), c(4))).toEqual(bin('+', v('i'), c(4)));
    expect(add(v('pb'), c(3), U8P)).toEqual(bin('+', v('pb'), c(3)));
    expect(add(v('gW'), c(4))).toEqual(bin('+', v('gW'), c(4)));
  });
});

describe('arith: a constant left of `+`', () => {
  it('divides a whole number of the right pointer’s elements into elements', () => {
    expect(add(c(8), v('pw'))).toEqual(bin('+', c(2), v('pw')));
  });

  it('walks a wider right pointer as bytes for any other constant', () => {
    expect(add(c(6), v('pw'))).toEqual(bin('+', c(6), bytes(v('pw'))));
  });

  it('adds a byte sum of an undeclared global as the integer it also is, and restores the byte pointer', () => {
    const r = chain(
      (s) => s.arith(op('add', U8P), v('gPtr'), c(16), false),
      (s, x) => s.arith(op('add', U8P), c(4), x, false),
    );
    expect(r).toEqual(bytes(bin('+', c(4), bin('+', word(v('gPtr')), c(16)))));
  });

  it('adds an undeclared pointer global as its word, in that order, and restores the byte pointer', () => {
    expect(add(c(4), v('gPtr'), U8P)).toEqual(bytes(bin('+', c(4), word(v('gPtr')))));
  });

  it('adds a pointer global the map declares as bytes, in that order', () => {
    expect(add(c(4), v('gP'), U8P)).toEqual(bin('+', c(4), bytes(v('gP'))));
  });

  it('adds an untyped global word as its word where the IR types the sum a pointer', () => {
    expect(add(c(4), v('gW'), U8P)).toEqual(bytes(bin('+', c(4), untypedWord('gW'))));
  });

  it('leaves an integer as it is', () => {
    expect(add(c(4), v('i'))).toEqual(bin('+', c(4), v('i')));
  });
});

describe('arith: two rendered pointers', () => {
  it('walks a wider left pointer as bytes plus the right one’s integer, cast back to the left type', () => {
    expect(add(v('ph'), v('pw'), U16P)).toEqual(cast(U16P, bin('+', bytes(v('ph')), s32(v('pw')))));
  });

  it('adds the right pointer’s integer to a byte pointer', () => {
    expect(add(v('pb'), v('pw'), U8P)).toEqual(bin('+', v('pb'), s32(v('pw'))));
  });

  it('subtracts a wider pointer as the byte count', () => {
    expect(sub(v('pb'), v('pw'), T.s(32))).toEqual(bin('-', bytes(v('pb')), bytes(v('pw'))));
    expect(sub(v('pw'), v('pb'), T.s(32))).toEqual(bin('-', bytes(v('pw')), bytes(v('pb'))));
  });

  it('leaves a byte pointer less a byte pointer as it is, the byte count', () => {
    expect(sub(v('pb'), v('pb2'), T.s(32))).toEqual(bin('-', v('pb'), v('pb2')));
    const restored = chain(
      (s) => s.arith(op('add', U8P), v('gQ'), v('i'), false),
      (s, x) => s.arith(op('sub', T.s(32)), v('pb'), x, false),
    );
    expect(restored).toEqual(bin('-', v('pb'), bytes(bin('+', word(v('gQ')), v('i')))));
    const sums = chain(
      (s) => [s.arith(op('add', U8P), v('gPtr'), c(4), false), s.arith(op('add', U8P), v('pb'), v('gW'), false)],
      (s, [l, r]) => s.arith(op('sub', T.s(32)), l, r, false),
    );
    expect(sums).toEqual(bin('-', bin('+', bytes(v('gPtr')), c(4)), bin('+', v('pb'), v('gW'))));
  });
});

describe('arith: a rendered pointer left of a pointer global', () => {
  it('walks a wider pointer as bytes plus the global’s word, cast back to the left type', () => {
    expect(add(v('ph'), v('gPtr'), U16P)).toEqual(cast(U16P, bin('+', bytes(v('ph')), word(v('gPtr')))));
  });

  it('adds the global’s word to a byte pointer', () => {
    expect(add(v('pb'), v('gPtr'), U8P)).toEqual(bin('+', v('pb'), word(v('gPtr'))));
  });

  it('subtracts the global as a byte pointer, so the difference is the byte count', () => {
    expect(sub(v('pw'), v('gPtr'), T.s(32))).toEqual(bin('-', bytes(v('pw')), bytes(v('gPtr'))));
    expect(sub(v('pb'), v('gPtr'), T.s(32))).toEqual(bin('-', v('pb'), bytes(v('gPtr'))));
  });
});

describe('arith: a rendered pointer left of a runtime operand', () => {
  it('walks a wider pointer as bytes and casts the sum back to its type', () => {
    expect(add(v('ph'), v('i'), U16P)).toEqual(cast(U16P, bin('+', bytes(v('ph')), v('i'))));
    expect(sub(v('ph'), v('i'), U16P)).toEqual(cast(U16P, bin('-', bytes(v('ph')), v('i'))));
  });

  it('subtracts a sum of untyped global words from a byte sum word by word', () => {
    const r = chain(
      (s) => [s.arith(op('add', U8P), v('gPtr'), c(4), false), s.arith(op('sub'), v('gB2'), v('gB3'), false)],
      (s, [l, r]) => s.arith(op('sub'), l, r, false),
    );
    expect(r).toEqual(bin('-', bin('+', bytes(v('gPtr')), c(4)), bin('-', untypedWord('gB2'), untypedWord('gB3'))));
  });

  it('leaves a byte pointer plus an integer as it is', () => {
    expect(add(v('pb'), v('i'), U8P)).toEqual(bin('+', v('pb'), v('i')));
  });
});

describe('arith: `int - ptr`', () => {
  const restoredSum = (s: ReturnType<typeof make>) => s.arith(op('add', U8P), v('gQ'), v('i'), false);

  it('takes a restored sum as its integer sum, and a pointer global left of it as bytes', () => {
    const r = chain(restoredSum, (s, x) => s.arith(op('sub', T.s(32)), v('gPtr'), x, false));
    expect(r).toEqual(bin('-', bytes(v('gPtr')), bin('+', word(v('gQ')), v('i'))));
  });

  it('takes a restored sum as its integer sum, and an untyped global word left of it as its word', () => {
    expect(chain(restoredSum, (s, x) => s.arith(op('sub', T.s(32)), v('j'), x, false))).toEqual(
      bin('-', v('j'), bin('+', word(v('gQ')), v('i'))),
    );
    expect(chain(restoredSum, (s, x) => s.arith(op('sub', T.s(32)), v('gW'), x, false))).toEqual(
      bin('-', untypedWord('gW'), bin('+', word(v('gQ')), v('i'))),
    );
  });

  it('takes a rendered pointer as an `s32` from a pointer global as bytes', () => {
    expect(sub(v('gPtr'), v('pb'), U8P)).toEqual(bin('-', bytes(v('gPtr')), s32(v('pb'))));
  });

  it('takes a rendered pointer as an `s32` from an untyped global word as bytes, where the IR types it a pointer', () => {
    expect(sub(v('gW'), v('pb'), U8P)).toEqual(bin('-', bytes(v('gW')), s32(v('pb'))));
  });

  it('takes a rendered pointer as an `s32` from an integer', () => {
    expect(sub(v('i'), v('pb'), T.s(32))).toEqual(bin('-', v('i'), s32(v('pb'))));
  });
});

describe('arith: a rendered pointer right of `+`', () => {
  it('adds an undeclared pointer global as its word to the walked pointer’s word, cast back to the right type', () => {
    expect(add(v('gPtr'), v('ph'), U16P)).toEqual(cast(U16P, bin('+', word(v('gPtr')), word(bytes(v('ph'))))));
  });

  it('adds an undeclared pointer global as its word to a byte pointer’s word, restoring the byte pointer', () => {
    expect(add(v('gPtr'), v('pb'), U8P)).toEqual(bytes(bin('+', word(v('gPtr')), word(v('pb')))));
  });

  it('adds a declared pointer global as its word to a wider pointer walked as bytes, cast back to its type', () => {
    expect(add(v('gP'), v('ph'), U16P)).toEqual(cast(U16P, bin('+', word(v('gP')), bytes(v('ph')))));
  });

  it('adds a declared pointer global as its word to a byte pointer', () => {
    expect(add(v('gP'), v('pb'), U8P)).toEqual(bin('+', word(v('gP')), v('pb')));
  });

  it('walks a wider pointer right of an integer as bytes and casts the sum back to its type', () => {
    expect(add(v('i'), v('ph'), U16P)).toEqual(cast(U16P, bin('+', v('i'), bytes(v('ph')))));
  });

  it('adds a byte sum of an undeclared global right of an integer as the integer it also is', () => {
    const r = chain(
      (s) => s.arith(op('add', U8P), v('gPtr'), c(4), false),
      (s, x) => s.arith(op('add', U8P), v('i'), x, false),
    );
    expect(r).toEqual(bytes(bin('+', v('i'), bin('+', word(v('gPtr')), c(4)))));
  });

  it('leaves an integer plus a byte pointer as it is', () => {
    expect(add(v('i'), v('pb'), U8P)).toEqual(bin('+', v('i'), v('pb')));
  });
});

describe('arith: `+` with no rendered pointer', () => {
  it('adds an undeclared pointer global plus a runtime offset as its word, the asm’s order on CodeWarrior too, and restores the byte pointer', () => {
    expect(add(v('gPtr'), v('i'), U8P)).toEqual(bytes(bin('+', word(v('gPtr')), v('i'))));
  });

  it('walks the left of two declared pointer globals as bytes and adds the right one’s word', () => {
    expect(add(v('gP'), v('gR'), U8P)).toEqual(bin('+', bytes(v('gP')), word(v('gR'))));
  });

  it('walks a declared pointer global as bytes, the asm’s order on agbcc, KMC gcc and IDO', () => {
    expect(add(v('gP'), v('i'), U8P)).toEqual(bin('+', bytes(v('gP')), v('i')));
  });

  it('adds an undeclared pointer global right of an integer as its word, the asm’s order on agbcc, KMC gcc and IDO too, and restores the byte pointer', () => {
    expect(add(v('i'), v('gPtr'), U8P)).toEqual(bytes(bin('+', v('i'), word(v('gPtr')))));
  });

  it('walks a declared pointer global right of an integer as bytes, the asm’s order on CodeWarrior', () => {
    expect(add(v('i'), v('gP'), U8P)).toEqual(bin('+', v('i'), bytes(v('gP'))));
  });

  it('adds an untyped global word plus a runtime offset as integers and restores the byte pointer', () => {
    expect(add(v('gW'), v('i'), U8P)).toEqual(bytes(bin('+', untypedWord('gW'), v('i'))));
  });

  it('walks an untyped global word as bytes plus a constant-valued integer', () => {
    const k = bin('<<', c(1), c(2));
    expect(add(v('gW'), k, U8P)).toEqual(bin('+', bytes(v('gW')), k));
  });

  it('adds an untyped global word right of an integer as its word, the asm’s order on agbcc, KMC gcc and IDO too, and restores the byte pointer', () => {
    expect(add(v('i'), v('gW'), U8P)).toEqual(bytes(bin('+', v('i'), untypedWord('gW'))));
  });

  it('leaves two integers as they are', () => {
    expect(add(v('i'), v('j'))).toEqual(bin('+', v('i'), v('j')));
  });
});

describe('arith: `-` with no rendered pointer', () => {
  it('subtracts two pointer globals as byte pointers, the byte count', () => {
    expect(sub(v('gPtr'), v('gQ'), T.s(32))).toEqual(bin('-', bytes(v('gPtr')), bytes(v('gQ'))));
  });

  it('walks a pointer global as bytes less an integer', () => {
    expect(sub(v('gPtr'), v('i'), T.s(32))).toEqual(bin('-', bytes(v('gPtr')), v('i')));
  });

  it('subtracts a pointer global from an integer as its word', () => {
    expect(sub(v('i'), v('gPtr'), T.s(32))).toEqual(bin('-', v('i'), word(v('gPtr'))));
  });

  it('walks an untyped global word as bytes less an integer where the IR types it a pointer', () => {
    expect(sub(v('gW'), v('i'), U8P)).toEqual(bin('-', bytes(v('gW')), v('i')));
  });

  it('subtracts a sum of untyped global words from a byte difference word by word', () => {
    const r = chain(
      (s) => [s.arith(op('sub', T.s(32)), v('gPtr'), v('gQ'), false), s.arith(op('sub'), v('gB2'), v('gB3'), false)],
      (s, [l, r]) => s.arith(op('sub'), l, r, false),
    );
    expect(r).toEqual(
      bin('-', bin('-', bytes(v('gPtr')), bytes(v('gQ'))), bin('-', untypedWord('gB2'), untypedWord('gB3'))),
    );
  });

  it('leaves two integers as they are', () => {
    expect(sub(v('i'), v('j'))).toEqual(bin('-', v('i'), v('j')));
  });
});
