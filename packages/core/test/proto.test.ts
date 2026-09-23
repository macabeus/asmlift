// The declared call shape: a callee `params` given as a bare COUNT or as the typed parameter list
// a header extraction produces (`["u8"]`) must BOTH drive call-argument recovery, and they are two
// different vocabularies — the count already speaks argument REGISTERS, the typed list speaks C
// PARAMETERS and has to be converted. `declaredArgRegs` is that conversion and it is the number
// every frontend walks its argument registers by.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { declaredArgRegs, declaredParamWidths, declaredWidth, prototypesFromSymbols } from '../src/proto';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

describe('declaredArgRegs', () => {
  test('normalizes the count form, the typed-list form, and absence', () => {
    expect(declaredArgRegs({ params: 2 })).toBe(2);
    expect(declaredArgRegs({ params: ['u8'] })).toBe(1);
    expect(declaredArgRegs({ params: ['u8', 's32', 'void *'] })).toBe(3);
    // both zero-arity forms must survive the `??` chain as 0 (a void callee gets NO args, never
    // the arg-register fallback), so they are distinct from omitted.
    expect(declaredArgRegs({ params: 0 })).toBe(0);
    expect(declaredArgRegs({ params: [] })).toBe(0);
    expect(declaredArgRegs({ returnsVoid: true })).toBeUndefined(); // no params → frontend heuristic
    expect(declaredArgRegs(undefined)).toBeUndefined();
    // malformed (a bare string, not a list) → undefined (fall back), NOT "u8".length === 3.
    expect(declaredArgRegs({ params: 'u8' as unknown as string[] })).toBeUndefined();
  });

  // THE ONE WITNESS THAT SEPARATES TWO PLAUSIBLE ABIs. A 64-bit parameter occupies two argument
  // registers, and where the second one starts is a per-compiler fact, not a derivation: agbcc's
  // `thumb.h` computes the register from a plain byte counter with NO rounding, so
  // `void f(s32, long long)` passes the pair in r1:r2 and the call occupies THREE registers.
  // AAPCS pads to an even register and would answer FOUR. Both are ABIs a reader could assume;
  // only one is the one asmlift lifts.
  test('a 64-bit parameter is TWO argument registers, packed — three, not four', () => {
    expect(declaredArgRegs({ params: ['s32', 'long long'] })).toBe(3);
    expect(declaredArgRegs({ params: ['long long'] })).toBe(2);
    expect(declaredArgRegs({ params: ['long long', 'unsigned long long'] })).toBe(4);
    expect(declaredParamWidths({ params: ['s32', 'long long'] })).toEqual([32, 64]);
  });

  // A READING THAT FAILED SAYS SO. `declaredWidth` answers `undefined` for a project typedef
  // exactly as it does for a `double`, and calling that one word is the only answer that lays a
  // call out wrongly with nothing said about it — at two registers per wide parameter, one
  // unreadable entry displaces every later argument. The caller then falls back to reading the
  // machine, or refuses; `frontend/thumb.ts` refuses.
  test('one spelling nothing can size refuses the whole list, rather than defaulting to a word', () => {
    expect(declaredParamWidths({ params: ['s32', 'Direction'] })).toBeUndefined();
    expect(declaredArgRegs({ params: ['s32', 'Direction'] })).toBeUndefined();
    expect(declaredArgRegs({ params: ['double'] })).toBeUndefined();
    // …and the COUNT form cannot fail this way: it already speaks argument registers.
    expect(declaredParamWidths({ params: 3 })).toEqual([32, 32, 32]);
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

  test('the 64-bit spellings answer 64, which is a fact and not an absence', () => {
    // A width WIDER than a register is the fact that says how many argument registers a parameter
    // occupies. Read as `undefined` it is indistinguishable from a project typedef, and the only
    // thing a caller can do with that is refuse.
    expect(['long long', 'long long int', 'unsigned long long', 'signed long long'].map(declaredWidth)).toEqual([
      64, 64, 64, 64,
    ]);
    expect(['s64', 'u64', 'const long long', 'unsigned long long int'].map(declaredWidth)).toEqual([64, 64, 64, 64]);
  });

  test('a spelling it cannot read is NO OPINION, never a width', () => {
    // The narrowing consumer treats undefined as "the header said nothing", so guessing here would
    // veto a sound inference on a project typedef.
    expect(['Direction', 'struct Entity', 'float', 'double', 's24', ''].map(declaredWidth)).toEqual([
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

  test('a parameter WIDER THAN A WORD drops the entry — the premise the outgoing-argument licence rests on', () => {
    // A `double`/`long long`/by-value-struct parameter occupies more than one word, which moves
    // every later argument's home and breaks the "one word per parameter" counting the Thumb
    // frontend's outgoing stack-argument block is laid out by (frontend/thumb.ts `declaredCall`).
    // Nothing spells such a parameter here, so nothing derived from a symbol map can carry one:
    // the entry goes, exactly as an unspellable NARROW one does.
    const map: SymbolMap = new Map([
      codeAt(0x08001000, 'Wide', {
        returns: null,
        params: [
          { size: 4, signed: true },
          { size: 8, signed: true },
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
