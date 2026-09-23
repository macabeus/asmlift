// The declared call shape: a callee `params` given as a bare COUNT or as the typed parameter list
// a header extraction produces (`["u8"]`) must BOTH drive call-argument recovery, and they are two
// different vocabularies — the count already speaks argument REGISTERS, the typed list speaks C
// PARAMETERS and has to be converted. `declaredArgWidths` is that conversion, and it produces the
// number every frontend walks its argument registers by.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { declaredArgWidths, declaredReturnWidth, declaredWidth, prototypesFromSymbols, wordsOf } from '../src/proto';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

/** the argument registers a declaration occupies, or `undefined` for "this states no layout" — the
 *  two answers a frontend acts on differently, collapsed into one expression so a test can name
 *  which one it means. */
const argRegs = (p: Parameters<typeof declaredArgWidths>[0]): number | undefined => {
  const widths = declaredArgWidths(p);
  return widths === undefined ? undefined : wordsOf(widths);
};

// The RETURN side of the same vocabulary. What it buys that `returnsVoid` cannot is how many
// registers the callee hands back: a value wider than a register comes home in a pair, so after a
// `bl` the second register holds a returned high half rather than the callee's leftovers, and
// nothing in the assembly separates those two readings.
describe('declaredReturnWidth', () => {
  test('a spelled return is read through the same widths a parameter is', () => {
    expect(declaredReturnWidth({ returns: 'long long' })).toBe(64);
    expect(declaredReturnWidth({ returns: 's64' })).toBe(64);
    expect(declaredReturnWidth({ returns: 'int' })).toBe(32);
    expect(declaredReturnWidth({ returns: 'void *' })).toBe(32);
    expect(declaredReturnWidth({ returns: 'u8' })).toBe(8);
  });

  // SILENCE IS SILENCE, and the three ways to be silent must not be three answers. A frontend asks
  // this to decide whether to name a second register, and every "no opinion" has to lift the call
  // the way an undeclared callee is lifted.
  test.each([
    ['no proto at all', undefined],
    ['a proto with no return', { params: 2 }],
    ['a project typedef', { returns: 'Fixed64' }],
    ['a struct', { returns: 'struct Vec' }],
    ['void — an absence of a value, not a width of zero', { returns: 'void' }],
  ])('%s answers undefined', (_label, proto) => {
    expect(declaredReturnWidth(proto)).toBeUndefined();
  });

  // `returnsVoid` IS NOT CONSULTED. It is the other return key and it answers a different
  // question; reading it here would have to invent a width for a function that returns no value.
  test('returnsVoid is not a width', () => {
    expect(declaredReturnWidth({ returnsVoid: true })).toBeUndefined();
    expect(declaredReturnWidth({ returnsVoid: false })).toBeUndefined();
  });

  // THE SAME SAFE-READER CONTRACT `declaredArgWidths` HAS: a frontend indexes `prototypes` by a callee's
  // name, so a callee named `toString` reads a `Function` off `Object.prototype`.
  test('an entry that is not an FnProto answers as an undeclared callee does', () => {
    const table: Record<string, unknown> = {};
    expect(declaredReturnWidth(table['toString'] as never)).toBeUndefined();
    expect(declaredReturnWidth(null as never)).toBeUndefined();
  });
});

describe('declaredArgWidths', () => {
  test('normalizes the count form, the typed-list form, and absence', () => {
    expect(argRegs({ params: 2 })).toBe(2);
    expect(argRegs({ params: ['u8'] })).toBe(1);
    expect(argRegs({ params: ['u8', 's32', 'void *'] })).toBe(3);
    // both zero-arity forms must survive as 0 (a void callee gets NO args, never the arg-register
    // fallback), so they are distinct from omitted.
    expect(argRegs({ params: 0 })).toBe(0);
    expect(argRegs({ params: [] })).toBe(0);
    expect(argRegs({ returnsVoid: true })).toBeUndefined(); // no params → frontend heuristic
    expect(argRegs(undefined)).toBeUndefined();
    // malformed (a bare string, not a list) → undefined (fall back), NOT "u8".length === 3.
    expect(argRegs({ params: 'u8' as unknown as string[] })).toBeUndefined();
  });

  // THE ONE WITNESS THAT SEPARATES TWO PLAUSIBLE ABIs. A 64-bit parameter occupies two argument
  // registers, and where the second one starts is a per-compiler fact, not a derivation: agbcc's
  // `thumb.h` computes the register from a plain byte counter with NO rounding, so
  // `void f(s32, long long)` passes the pair in r1:r2 and the call occupies THREE registers.
  // AAPCS pads to an even register and would answer FOUR. Both are ABIs a reader could assume;
  // only one is the one asmlift lifts.
  test('a 64-bit parameter is TWO argument registers, packed — three, not four', () => {
    expect(argRegs({ params: ['s32', 'long long'] })).toBe(3);
    expect(argRegs({ params: ['long long'] })).toBe(2);
    expect(argRegs({ params: ['long long', 'unsigned long long'] })).toBe(4);
    expect(declaredArgWidths({ params: ['s32', 'long long'] })).toEqual([32, 64]);
  });

  // ONE SPELLING NOTHING CAN SIZE AND THE WHOLE LIST STATES NO LAYOUT. A parameter of unknown
  // width occupies one argument register or two, and the choice moves every later argument's home
  // — so there is no partial answer to hand a caller that is laying out registers. Abstaining puts
  // the callee back where an undeclared one already is, at the frontend's own guess, which is the
  // one behaviour that can never be worse than saying nothing.
  //
  // THE ALTERNATIVE WAS MEASURED AND IT WAS WRONG IN BOTH DIRECTIONS. Spending the freedom against
  // the machine's contiguous scan accepted a narrow reading for a real pair (agbcc passes a
  // pass-through high half in r1 with no definition in the function, and the scan answers 1), and
  // refused a correct narrow declaration whenever an earlier call had left a dead value in the
  // next argument register. Neither error is visible from here, which is why the witness is gone
  // rather than repaired.
  test('a spelling it cannot size makes the whole list state nothing', () => {
    expect(declaredArgWidths({ params: ['s32', 'Direction'] })).toBeUndefined();
    expect(declaredArgWidths({ params: ['TaskFunc'] })).toBeUndefined();
    expect(declaredArgWidths({ params: ['void *', 'struct Foo'] })).toBeUndefined();
    // …and the COUNT form can never abstain: it already speaks argument registers, so it is the
    // way past a header asmlift cannot size.
    expect(declaredArgWidths({ params: 3 })).toEqual([32, 32, 32]);
  });

  // A READABLE LIST IS AUTHORITY AND NOTHING ELSE IS CONSULTED FOR IT: this takes no witness, no
  // target and no SSA, so there is nothing an inference could override it with.
  test('a readable list is a pure reading of the declaration', () => {
    expect(declaredArgWidths({ params: ['s32', 'long long'] })).toEqual([32, 64]);
    expect(declaredArgWidths({ params: ['void *', 'const void *', 'size_t'] })).toEqual([32, 32, 32]);
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
    expect(['Direction', 'struct Entity', 's24', ''].map(declaredWidth)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  // THE FLOATING TYPES ARE NOT WIDTHS HERE, and the reason is the reader rather than the type. How
  // many argument registers one occupies is a TARGET fact: `target.ts` sets `hwFloat` on three of
  // its four descriptions, and on a PowerPC EABI with an FPU a `double` argument travels in f1..f8
  // and occupies no general argument register at all. "One register" and "a pair" are both wrong
  // there, and `declaredArgWidths` has only those two readings to give.
  test('the floating types are absences, `long double` among them', () => {
    expect(['float', 'const float', 'double', 'long double'].map(declaredWidth)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // …and the absence spreads to the layout, so nothing downstream reads a GPR count off one.
    expect(declaredArgWidths({ params: ['int', 'double'] })).toBeUndefined();
  });

  // FIXED BY THE STANDARD, NOT BY A PROJECT — the same reason `STANDARD_SIGNATURES` exists. These
  // are the spellings a header extraction produces most, and reading them as project typedefs put
  // `size_t` and `int64_t` into the population that cannot be sized at all.
  test('the fixed-width and pointer-sized standard names', () => {
    expect(['int8_t', 'uint8_t', 'int16_t', 'uint16_t'].map(declaredWidth)).toEqual([8, 8, 16, 16]);
    expect(['int32_t', 'uint32_t', 'int64_t', 'uint64_t'].map(declaredWidth)).toEqual([32, 32, 64, 64]);
    expect(['size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t'].map(declaredWidth)).toEqual([
      32, 32, 32, 32, 32,
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
