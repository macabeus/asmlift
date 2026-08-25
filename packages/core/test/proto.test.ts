// Prototype arity: a callee `params` given as a bare COUNT or as the typed parameter list a
// header extraction produces (`["u8"]`) must BOTH drive call-argument recovery. The typed-list
// form silently dropped every argument before protoArity normalized it (argc was the array, so
// `k < argc` was NaN → zero args) — a caller of such a callee lost its arguments.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { declaredWidth, protoArity, prototypesFromSymbols } from '../src/proto';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

describe('protoArity', () => {
  test('normalizes the count form, the typed-list form, and absence', () => {
    expect(protoArity({ params: 2 })).toBe(2);
    expect(protoArity({ params: ['u8'] })).toBe(1);
    expect(protoArity({ params: ['u8', 's32', 'void *'] })).toBe(3);
    // both zero-arity forms must survive the `??` chain as 0 (a void callee gets NO args, never
    // the arg-register fallback), so they are distinct from omitted.
    expect(protoArity({ params: 0 })).toBe(0);
    expect(protoArity({ params: [] })).toBe(0);
    expect(protoArity({ returnsVoid: true })).toBeUndefined(); // no params → frontend heuristic
    expect(protoArity(undefined)).toBeUndefined();
    // malformed (a bare string, not a list) → undefined (fall back), NOT "u8".length === 3.
    expect(protoArity({ params: 'u8' as unknown as string[] })).toBeUndefined();
  });
});

describe('declaredWidth', () => {
  test("reads asmlift's own spellings, the C89 base types, and any pointer", () => {
    expect(['u8', 's8', 'char', 'unsigned char', 'signed char'].map(declaredWidth)).toEqual([8, 8, 8, 8, 8]);
    expect(['u16', 's16', 'short', 'unsigned short', 'short int'].map(declaredWidth)).toEqual([16, 16, 16, 16, 16]);
    expect(['u32', 's32', 'int', 'unsigned', 'signed', 'long', 'unsigned long int'].map(declaredWidth)).toEqual([
      32, 32, 32, 32, 32, 32, 32,
    ]);
    expect(['void *', 'struct Entity *', 'const u8 *', 'char**'].map(declaredWidth)).toEqual([32, 32, 32, 32]);
    expect(declaredWidth('const int')).toBe(32);
    expect(declaredWidth('  short   int ')).toBe(16);
  });

  test('a spelling it cannot read is NO OPINION, never a width', () => {
    // The narrowing consumer treats undefined as "the header said nothing", so guessing here would
    // veto a sound inference on a project typedef.
    expect(['Direction', 'struct Entity', 'float', 'double', 'u64', 's24', ''].map(declaredWidth)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('call-argument recovery honors both proto forms', () => {
  const caller = 'caller:\n\tmov\tr0, #0x5\n\tbl\tcallee\n\tbx\tlr\n';
  const dc = (params: number | string[]) =>
    decompile('caller', caller, ARMV4T_AGBCC, {
      prototypes: { caller: { returnsVoid: true }, callee: { params } },
    }).source;

  test('a TYPED-LIST callee proto recovers the argument (the regression this fixes)', () => {
    expect(dc(['u8'])).toContain('callee(5)');
  });

  test('a COUNT callee proto recovers the argument identically', () => {
    expect(dc(1)).toContain('callee(5)');
  });
});

describe('prototypesFromSymbols — the project DWARF fills in what the caller did not state', () => {
  const codeAt = (addr: number, name: string, signature: unknown): [number, SymbolInfo[]] => [
    addr,
    [{ name, kind: 'code', signature } as SymbolInfo],
  ];

  test('a callee signature becomes a typed proto', () => {
    const map: SymbolMap = new Map([
      codeAt(0x08001000, 'Callee', {
        returns: { size: 2, signed: false },
        params: [
          { size: 1, signed: false },
          { size: 4, signed: true },
        ],
      }),
    ]);
    expect(prototypesFromSymbols(map)).toEqual({ Callee: { params: ['u8', 's32'] } });
  });

  test('a void return is recorded as returnsVoid', () => {
    const map: SymbolMap = new Map([codeAt(0x08001000, 'DoThing', { returns: null, params: [] })]);
    expect(prototypesFromSymbols(map)).toEqual({ DoThing: { params: [], returnsVoid: true } });
  });

  test('a pointer parameter spells void * — nothing is guessed about the target', () => {
    const map: SymbolMap = new Map([
      codeAt(0x08001000, 'Copy', { returns: null, params: [{ size: 4, signed: null, pointer: true }] }),
    ]);
    expect(prototypesFromSymbols(map).Copy.params).toEqual(['void *']);
  });

  test('the CALLER always wins — a user/manifest proto is never overwritten', () => {
    const map: SymbolMap = new Map([
      codeAt(0x08001000, 'Callee', { returns: null, params: [{ size: 1, signed: false }] }),
    ]);
    expect(prototypesFromSymbols(map, { Callee: { params: 3 } })).toEqual({ Callee: { params: 3 } });
  });

  test('an unspellable parameter drops the WHOLE entry — a partial list would give a right arity with wrong widths', () => {
    const map: SymbolMap = new Map([
      codeAt(0x08001000, 'Odd', {
        returns: null,
        params: [
          { size: 1, signed: null },
          { size: 4, signed: true },
        ],
      }),
    ]);
    expect(prototypesFromSymbols(map)).toEqual({});
  });

  test('data symbols and unsignatured code symbols contribute nothing', () => {
    const map: SymbolMap = new Map([
      [0x03001000, [{ name: 'gData', kind: 'data' } as SymbolInfo]],
      [0x08001000, [{ name: 'StillAsm', kind: 'code' } as SymbolInfo]],
    ]);
    expect(prototypesFromSymbols(map)).toEqual({});
  });

  test('no map ⇒ the base table, untouched', () => {
    expect(prototypesFromSymbols(undefined, { F: { params: 1 } })).toEqual({ F: { params: 1 } });
  });
});
