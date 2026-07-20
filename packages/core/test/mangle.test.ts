// CodeWarrior (Metrowerks) name mangling — offline. The golden symbols are captured from REAL
// mwcceppc `.cp` compiles (objdump -t of the .o): free functions, member functions, unsigned/
// pointer/void argument codes. Each is asserted in BOTH directions (mangle and demangle) and for
// round-trip stability — the property the C++ backend relies on to generate a symbol that objdiff
// will align to the target.
import { describe, expect, test } from 'vitest';

import { type CppSig, demangle, mangle, spellType } from '../src/mangle';

// sym ↔ signature, golden from real mwcceppc output where noted.
const CASES: { sym: string; sig: CppSig; note: string }[] = [
  {
    sym: 'dot__3VecFP3Vec',
    sig: { name: 'dot', cls: 'Vec', params: [{ base: 'Vec', ptr: 1 }] },
    note: 'member Vec::dot(Vec*) — REAL mwcc symbol',
  },
  {
    sym: 'dot__FP3VecP3Vec',
    sig: {
      name: 'dot',
      params: [
        { base: 'Vec', ptr: 1 },
        { base: 'Vec', ptr: 1 },
      ],
    },
    note: 'free dot(Vec*,Vec*) — REAL mwcc symbol',
  },
  {
    sym: 'Vec_scale__FP3Veci',
    sig: {
      name: 'Vec_scale',
      params: [
        { base: 'Vec', ptr: 1 },
        { base: 'int', ptr: 0 },
      ],
    },
    note: 'free Vec_scale(Vec*,int) — REAL mwcc symbol',
  },
  {
    sym: 'add__Fii',
    sig: {
      name: 'add',
      params: [
        { base: 'int', ptr: 0 },
        { base: 'int', ptr: 0 },
      ],
    },
    note: 'free add(int,int)',
  },
  { sym: 'get__3FooFv', sig: { name: 'get', cls: 'Foo', params: [] }, note: 'member Foo::get() — no args ⇒ Fv' },
  {
    sym: 'umul__FUiUi',
    sig: {
      name: 'umul',
      params: [
        { base: 'unsigned int', ptr: 0 },
        { base: 'unsigned int', ptr: 0 },
      ],
    },
    note: 'unsigned args (Ui)',
  },
  {
    sym: 'at__3ArrFPi',
    sig: { name: 'at', cls: 'Arr', params: [{ base: 'int', ptr: 1 }] },
    note: 'member with a pointer-to-builtin arg (Pi)',
  },
];

describe('CodeWarrior mangling — mangle/demangle round-trip on real symbols', () => {
  for (const { sym, sig, note } of CASES) {
    test(note, () => {
      expect(mangle(sig)).toBe(sym); // signature → symbol
      expect(demangle(sym)).toEqual(sig); // symbol → signature
      expect(mangle(demangle(sym)!)).toBe(sym); // round-trip stable
    });
  }
});

test('demangle returns null for an unmangled C symbol (so it reads as plain C)', () => {
  expect(demangle('plain_c_func')).toBeNull();
  expect(demangle('half')).toBeNull();
});

test('demangle returns null (not throw) for a valid symbol using an unmodelled type code', () => {
  // `constp__FPC3Vec` (pointer-to-const) and `reffn__FR3Vec` (reference) are REAL mwcc symbols whose
  // `C`/`R` codes this scheme-subset doesn't model. Per the documented contract they degrade to null
  // rather than crashing the caller — const/reference support is out-of-scope tail work (cpp.ts).
  expect(demangle('constp__FPC3Vec')).toBeNull();
  expect(demangle('reffn__FR3Vec')).toBeNull();
});

test('spellType spells pointers and builtins for C++ source', () => {
  expect(spellType({ base: 'Vec', ptr: 1 })).toBe('Vec *');
  expect(spellType({ base: 'int', ptr: 0 })).toBe('int');
  expect(spellType({ base: 'unsigned int', ptr: 0 })).toBe('unsigned int');
});
