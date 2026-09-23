// The declared call shape: a callee `params` given as a bare COUNT or as the typed parameter list
// a header extraction produces (`["u8"]`) must BOTH drive call-argument recovery, and they are two
// different vocabularies — the count already speaks argument REGISTERS, the typed list speaks C
// PARAMETERS and has to be converted. `declaredArgLayout` is that conversion and `resolveArgLayout`
// spends whatever freedom it leaves; between them they produce the number every frontend walks its
// argument registers by.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import {
  type DeclaredArgLayout,
  declaredArgLayout,
  declaredWidth,
  minArgRegs,
  prototypesFromSymbols,
  resolveArgLayout,
  unresolvedArgLayout,
  wordsOf,
} from '../src/proto';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

/** the argument registers a declaration occupies once resolved, or `undefined` for "not read" and
 *  `null` for "read, and the machine does not settle it" — the two answers a frontend acts on
 *  differently, collapsed here into one expression so a test can name which one it means. */
const argRegs = (p: Parameters<typeof declaredArgLayout>[0], setUp = 0): number | null | undefined => {
  const layout = declaredArgLayout(p);
  if (layout === undefined) {
    return undefined;
  }
  const resolved = resolveArgLayout(layout, setUp);
  return resolved === null ? null : wordsOf(resolved);
};

describe('declaredArgLayout', () => {
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
    expect(minArgRegs(declaredArgLayout({ params: ['s32', 'long long'] }) as DeclaredArgLayout)).toBe(3);
    expect(argRegs({ params: ['long long'] })).toBe(2);
    expect(argRegs({ params: ['long long', 'unsigned long long'] })).toBe(4);
    expect(declaredArgLayout({ params: ['s32', 'long long'] })?.widths).toEqual([32, 64]);
  });

  // A SPELLING NOTHING CAN SIZE IS CARRIED, NOT RESOLVED AND NOT THROWN AWAY. `declaredWidth`
  // answers `undefined` for a project typedef exactly as it does for a `double`, and the question
  // the layout is asking is whether the parameter is one argument register or two. The list
  // records the freedom; the machine spends it.
  test('an unsizable spelling is a null width and a recorded spelling, not a failed list', () => {
    expect(declaredArgLayout({ params: ['s32', 'Direction'] })).toEqual({
      widths: [32, null],
      unsizable: ['Direction'],
    });
    expect(declaredArgLayout({ params: ['TaskFunc'] })).toEqual({ widths: [null], unsizable: ['TaskFunc'] });
    // the MINIMUM is what the machine is weighed against, and an unreadable entry contributes one
    expect(minArgRegs(declaredArgLayout({ params: ['s32', 'Direction'] }) as DeclaredArgLayout)).toBe(2);
    // …and the COUNT form cannot be unsizable: it already speaks argument registers.
    expect(declaredArgLayout({ params: 3 })).toEqual({ widths: [32, 32, 32], unsizable: [] });
  });
});

describe('resolveArgLayout — the machine settles what the declaration leaves open', () => {
  const layout = (params: string[]): DeclaredArgLayout => declaredArgLayout({ params }) as DeclaredArgLayout;

  // THE ACCEPTING ARM. `void g(s32, Direction)` against a call that set up exactly two argument
  // registers: the only reading that reaches two is the one where `Direction` is a single
  // register, so the layout is determined and this is the answer the base of this branch gave for
  // free. Declaring MORE must never make asmlift do LESS.
  test('a count that only the one-register-each reading reaches IS the layout', () => {
    expect(resolveArgLayout(layout(['s32', 'Direction']), 2)).toEqual([32, 32]);
    expect(resolveArgLayout(layout(['void *', 'const void *', 'size_t']), 3)).toEqual([32, 32, 32]);
    expect(resolveArgLayout(layout(['bool8']), 1)).toEqual([32]);
  });

  // THE REFUSING ARM, AND IT IS THE ONE THAT MAKES THE ACCEPTING ARM SAFE. The same declaration
  // against a call that set up THREE registers fits two readings — `Direction` as a pair, or a
  // third argument the header omits — and they disagree about the value the callee is handed.
  test('a count both readings reach settles nothing', () => {
    expect(resolveArgLayout(layout(['s32', 'Direction']), 3)).toBeNull();
    expect(resolveArgLayout(layout(['Direction']), 2)).toBeNull();
    // an UNDER-count is below the minimum and refuses too — the scan under-counts a pass-through
    // parameter, and that is the direction that must not lift.
    expect(resolveArgLayout(layout(['s32', 'Direction']), 1)).toBeNull();
  });

  // A FULLY READABLE LIST IS AUTHORITY AND THE SCAN IS AN INFERENCE, so the scan never overrides
  // it — otherwise a pass-through argument the scan cannot see would silently shorten a call the
  // project's own header describes.
  test('a readable list ignores the machine entirely', () => {
    for (const setUp of [0, 1, 2, 3, 4]) {
      expect(resolveArgLayout(layout(['s32', 'long long']), setUp)).toEqual([32, 64]);
    }
  });

  // The refusal has to be true about its own inputs and has to name the way past itself; a message
  // that blamed an absent prototype for a present one is the defect this replaces.
  test('the refusal names the spelling, both counts and the escape hatch', () => {
    const why = unresolvedArgLayout('g', layout(['s32', 'Direction']), 3);
    expect(why).toContain('`g` is declared with 2 parameter(s)');
    expect(why).toContain('`Direction` is a spelling asmlift cannot size');
    expect(why).toContain('sets up 3 argument register(s)');
    expect(why).toContain('accounts for 2');
    expect(why).toContain('{"g": {"params": 3}}');
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

  // THE FLOATING TYPES ARE WIDTHS, because every target here is soft-float and the question the
  // width answers is how many CORE registers the argument occupies. Read as absences, a `double`
  // was the one spelling `resolveArgLayout` could resolve to a reading known to be false — one
  // register — whenever the machine's count happened to agree.
  test('float and double are widths, and `long double` is not', () => {
    expect(['float', 'const float', 'double'].map(declaredWidth)).toEqual([32, 32, 64]);
    expect(declaredWidth('long double')).toBeUndefined();
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
