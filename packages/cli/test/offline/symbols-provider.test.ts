// The ELF symbol-map provider's POLICIES, pinned offline (the loader itself needs an ELF and is
// exercised by the checkout-gated matching suite; these rules are pure and had no coverage).
//
//  1. the ALIAS ORDER — which of several symbols sharing an address is the canonical pick, i.e.
//     the name every downstream spelling will actually emit;
//  2. the LAYOUT MAPPING — which of @gba-kit/debug-info's member facts are carried, and which
//     absences are meaningful rather than defaultable;
//  3. the CAPABILITY GATE — what counts as a witness that the installed package reports the
//     facts the spelling rules read, and when an unwitnessed package is refused;
//  4. the PLACEHOLDER shape — `sub_08xxxxxx`-style names are real symbols that no header
//     declares, so emitting one produces output that cannot compile.
import type { SymbolInfo } from '@asmlift/core/symbols';
import { describe, expect, test } from 'vitest';

import { PLACEHOLDER, assertPointeeCapabilityWitnessed, canonicalOrder, layoutOf } from '../../src/symbols-provider';

const sym = (name: string, declared?: true): SymbolInfo => ({
  name,
  kind: 'data',
  ...(declared ? { declared } : {}),
});

const pick = (...names: SymbolInfo[]): string => [...names].sort(canonicalOrder)[0].name;

describe('canonicalOrder — which alias wins an address', () => {
  test('a header-declared (DIE-joined) name beats an undeclared one, in either input order', () => {
    expect(pick(sym('gRawName'), sym('gPlayerState', true))).toBe('gPlayerState');
    expect(pick(sym('gPlayerState', true), sym('gRawName'))).toBe('gPlayerState');
  });

  test('a placeholder name loses to any other undeclared name', () => {
    expect(pick(sym('sub_08001234'), sym('gSomething'))).toBe('gSomething');
    expect(pick(sym('gSomething'), sym('sub_08001234'))).toBe('gSomething');
  });

  test('declared beats non-placeholder, and placeholder-ness never outranks declaredness', () => {
    // a DECLARED placeholder still wins over an undeclared ordinary name: `declared` means the
    // project's own headers carry it, which is the only thing that makes a name compilable
    expect(pick(sym('sub_08001234', true), sym('gSomething'))).toBe('sub_08001234');
  });

  test('otherwise the tie breaks by name — deterministic, so a vendored map is reproducible', () => {
    expect(pick(sym('gB'), sym('gA'))).toBe('gA');
    expect(
      ['gA', 'gB', 'gC']
        .map((n) => sym(n))
        .sort(canonicalOrder)
        .map((s) => s.name),
    ).toEqual(['gA', 'gB', 'gC']);
  });
});

describe('layoutOf — the package facts a layout is allowed to carry', () => {
  // The ONE mapping from @gba-kit/debug-info's members to core's `SymbolStructField`, shared by a
  // struct global's own layout and by a pointer global's pointee. Every fact is kept only when
  // the package STATES it — an absent fact must stay absent rather than become a default, because
  // the spelling rules read absence as a meaning ("not an array", "signedness unknown").
  const di = (members: unknown[]) => ({ struct: () => ({ members }) }) as Parameters<typeof layoutOf>[0];

  test('keeps each stated fact and omits every unstated one', () => {
    const out = layoutOf(
      di([
        { name: 'flag', offset: 0, size: 1, signed: false },
        { name: 'vreg', offset: 2, size: 2, signed: false, volatile: true },
        { name: 'kind', offset: 4, size: 4, signed: true, const: true },
        { name: 'next', offset: 8, size: 4, signed: null, pointer: true },
        { name: 'slots', offset: 12, size: 16, signed: null, elemSize: 1, elemSigned: false, length: 16 },
      ]),
      'S',
      '/tmp/x.elf',
    );
    expect(out).toEqual([
      { name: 'flag', offset: 0, size: 1, signed: false },
      { name: 'vreg', offset: 2, size: 2, signed: false, volatile: true },
      { name: 'kind', offset: 4, size: 4, signed: true, const: true },
      { name: 'next', offset: 8, size: 4, pointer: true }, // a null signedness is NOT a fact
      { name: 'slots', offset: 12, size: 16, elemSize: 1, elemSigned: false, length: 16 },
    ]);
  });

  test('drops BITFIELD members — no read width ever equals their size', () => {
    // a bitfield must fall through to the honest cast spelling, never to a wrong field name
    const out = layoutOf(
      di([
        { name: 'bits', offset: 0, size: 1, signed: false, bitWidth: 3, bitOffset: 0 },
        { name: 'plain', offset: 4, size: 4, signed: true },
      ]),
      'S',
      '/tmp/x.elf',
    );
    expect(out?.map((m) => m.name)).toEqual(['plain']);
  });

  test('an unnamed type, or one the sidecar has no layout for, yields null — never a guess', () => {
    expect(layoutOf(di([]), null, '/tmp/x.elf')).toBeNull();
    expect(layoutOf({ struct: () => null }, 'Missing', '/tmp/x.elf')).toBeNull();
  });

  test('REFUSES LOUDLY when the package reports no member signedness at all', () => {
    // key presence, not a version string: a package that omits `signed` would have every
    // synthesized member declared at a GUESSED signedness, which changes the bytes a load
    // compiles to — so the map is refused rather than silently emitted partial
    expect(() => layoutOf(di([{ name: 'x', offset: 0, size: 4 }]), 'S', '/tmp/x.elf')).toThrow(
      /struct-member signedness/,
    );
  });
});

describe('assertPointeeCapabilityWitnessed — the end-of-load capability settlement', () => {
  // The per-variable probe only fires on a POINTER shape, so an ELF with none never exercises it;
  // and the release's member-level array facts can never be witnessed by ABSENCE at all, since a
  // non-array member legitimately has none. The witness therefore has to be positive, and is
  // settled once for the whole ELF rather than per variable.
  const settle = (witnessed: boolean, layouts: number) =>
    assertPointeeCapabilityWitnessed(witnessed, layouts, '/tmp/x.elf');

  test('a witnessed capability passes, however many layouts were read', () => {
    expect(() => settle(true, 0)).not.toThrow();
    expect(() => settle(true, 12)).not.toThrow();
  });

  test('REFUSES when layouts were read but nothing ever witnessed the facts', () => {
    // the silent failure this stops: with `elemSize` missing every array member reads as a plain
    // one, so a one-element array would be spelled `->x` for a member that is not an lvalue of
    // that width — plausible, wrong, and invisible
    expect(() => settle(false, 3)).toThrow(/never demonstrated the pointer-target\/array-member facts/);
    expect(() => settle(false, 3)).toThrow(/3 struct layout\(s\) read/);
  });

  test('an ELF with NO layouts at all is not refused — nothing could depend on the facts', () => {
    // a names-only map (no DWARF sidecar, or no struct/pointee layouts) spells no member, so an
    // unwitnessed package cannot mislead it
    expect(() => settle(false, 0)).not.toThrow();
  });
});

describe('PLACEHOLDER — the rename-leftover shape', () => {
  test('matches the leftover forms', () => {
    for (const n of ['sub_08001234', 'sub_8001234', '_08001234', 'sub_080012', '_030012AB']) {
      expect(PLACEHOLDER.test(n), n).toBe(true);
    }
  });

  test('never matches a real project name', () => {
    for (const n of ['gPlayerState', 'sub_routine', 'sub_08001234x', '_start', 'gUnk_030034D8', 'Sub_08001234']) {
      expect(PLACEHOLDER.test(n), n).toBe(false);
    }
  });
});
