// The declared call shape: a callee `params` given as a bare COUNT or as the typed parameter list
// a header extraction produces (`["u8"]`) must BOTH drive call-argument recovery, and they are two
// different vocabularies — the count already speaks argument REGISTERS, the typed list speaks C
// PARAMETERS and has to be converted. `declaredArgWidths` is that conversion, and it produces the
// number every frontend walks its argument registers by.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import {
  declaredArgWidths,
  declaredReturnWidth,
  declaredWidth,
  prototypesFromSymbols,
  spellableProto,
  spellableType,
  wordsOf,
} from '../src/proto';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC, C_TYPEDEFS } from '../src/target';

/** the argument registers a declaration occupies, or `undefined` for "this states no layout" — the
 *  two answers a frontend acts on differently, collapsed into one expression so a test can name
 *  which one it means. */
const argRegs = (p: Parameters<typeof declaredArgWidths>[0]): number | undefined => {
  const widths = declaredArgWidths(p);
  return widths === undefined ? undefined : wordsOf(widths);
};

// WHAT ASMLIFT MAY PRINT is a SMALLER set than what it can size, and the difference is a candidate
// that does not compile. Measured with the project agbcc, prelude included: `Fixed64 DoThing(void);`
// and `int (*)(void) DoThing(void);` both exit 1 on a syntax error, while `long long DoThing(void);`
// and `struct Sprite * DoThing(struct Sprite *);` exit 0.
describe('spellableType', () => {
  test.each([
    'void',
    'int',
    'unsigned',
    'unsigned int',
    'long long',
    'unsigned long long',
    'signed char',
    'short int',
    'u8',
    's32',
    'u64',
    'void *',
    'u16 *',
    'const char *',
  ])('%s is a spelling a candidate compiles', (t) => {
    expect(spellableType(t)).toBe(true);
  });

  // THE SIZABLE-BUT-UNPRINTABLE SET IS THE POINT. Each of these has a width `declaredWidth` reads
  // and a spelling nothing in the candidate's translation unit declares, so each assertion is
  // paired with the width to show the two questions really do part.
  test.each([
    ['int32_t', 32],
    ['uint64_t', 64],
    ['size_t', 32],
  ])('%s sizes and does NOT print — no candidate includes a header', (t, w) => {
    expect(declaredWidth(t)).toBe(w);
    expect(spellableType(t)).toBe(false);
  });

  test.each(['Fixed64', 'struct Vec', 'Fixed64 *', 'int (*)(void)', 'float', '', '*'])(
    '%s is not a spelling this may print',
    (t) => {
      expect(spellableType(t)).toBe(false);
    },
  );

  // A SIGNEDNESS KEYWORD QUALIFIES A C89 BASE AND NOTHING ELSE — `unsigned u32` is not a type,
  // and stripping the keyword before the typedef lookup would have admitted it.
  test('a signedness keyword on a typedef is not a type', () => {
    expect(spellableType('unsigned u32')).toBe(false);
  });

  // THE PRELUDE'S TYPEDEF NAMES ARE LISTED IN `proto.ts` AND DECLARED IN `target.ts`, because
  // `proto.ts` sits below `target.ts` in the import graph and reading them there would close a
  // cycle. A copy that can disagree with its original is a defect, so the divergence is a red test
  // rather than a candidate that does not compile: every name `C_TYPEDEFS` declares must be
  // spellable, and every spelling that is NOT a C89 base must be one of those names.
  test('the spellable typedefs are exactly the ones the candidate prelude declares', () => {
    const declared = [...C_TYPEDEFS.matchAll(/(\w+)\s*;/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(spellableType(name)).toBe(true);
    }
    // …and the converse: a name the prelude stops declaring must stop being spellable.
    for (const name of ['u128', 'f32', 'bool8']) {
      expect(declared).not.toContain(name);
      expect(spellableType(name)).toBe(false);
    }
  });
});

// The RETURN side of the same vocabulary. What it buys that `returnsVoid` cannot is how many
// registers the callee hands back: a value wider than a register comes home in a pair, so after a
// `bl` the second register holds a returned high half rather than the callee's leftovers, and
// nothing in the assembly separates those two readings.
describe('declaredReturnWidth', () => {
  test('a spelled return is read through the same widths a parameter is', () => {
    expect(declaredReturnWidth({ params: [], returns: 'long long' })).toBe(64);
    expect(declaredReturnWidth({ params: [], returns: 's64' })).toBe(64);
    expect(declaredReturnWidth({ params: [], returns: 'int' })).toBe(32);
    expect(declaredReturnWidth({ params: [], returns: 'void *' })).toBe(32);
    expect(declaredReturnWidth({ params: ['u8', 's32'], returns: 'u8' })).toBe(8);
  });

  // SILENCE IS SILENCE, and the ways to be silent must not be several answers. A frontend asks
  // this to decide whether to name a second register, and every "no opinion" has to lift the call
  // the way an undeclared callee is lifted.
  test.each([
    ['no proto at all', undefined],
    ['a proto with no return', { params: 2 }],
    ['a project typedef', { params: [], returns: 'Fixed64' }],
    ['a struct', { params: [], returns: 'struct Vec' }],
    ['void — an absence of a value, not a width of zero', { params: [], returns: 'void' }],
  ])('%s answers undefined', (_label, proto) => {
    expect(declaredReturnWidth(proto)).toBeUndefined();
  });

  // A WIDTH THIS READS AND CANNOT GET DECLARED IS NOT A WIDTH IT MAY REPORT, because the two are
  // one decision: the frontend names a second register only if the candidate's own translation
  // unit declares the callee the same way, and `spellableProto` is the single gate on both. A
  // count above zero names no C type; a parameter spelling nothing can print poisons the list
  // whatever the return says.
  test.each([
    ['a bare argument count', { params: 2, returns: 'long long' }],
    ['a parameter this cannot print', { params: ['Fixed64'], returns: 'long long' }],
    ['a POINTER to something this cannot print', { params: ['Fixed64 *'], returns: 'long long' }],
    ['a return this can size but not print', { params: [], returns: 'int64_t' }],
  ])('%s is silence even though the width is readable', (_label, proto) => {
    expect(declaredWidth(String(proto.returns))).toBe(64);
    expect(declaredReturnWidth(proto)).toBeUndefined();
  });

  // …and the zero-argument COUNT form is the one count that CAN be printed: `params: 0` and
  // `params: []` are the same `(void)`.
  test('a zero-argument count is the same declaration as an empty list', () => {
    expect(declaredReturnWidth({ params: 0, returns: 'long long' })).toBe(64);
    expect(spellableProto({ params: 0, returns: 'long long' })).toEqual({ params: [], returns: 'long long' });
  });

  // `returnsVoid` IS NOT CONSULTED. It is the other return key and it answers a different
  // question; reading it here would have to invent a width for a function that returns no value.
  test('returnsVoid is not a width', () => {
    expect(declaredReturnWidth({ params: [], returnsVoid: true })).toBeUndefined();
    expect(declaredReturnWidth({ params: [], returnsVoid: false })).toBeUndefined();
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
