// The ELF symbol-map provider's two POLICIES, pinned offline (the loader itself needs an ELF and
// is exercised by the checkout-gated matching suite; these rules are pure and had no coverage).
//
//  1. the ALIAS ORDER — which of several symbols sharing an address is the canonical pick, i.e.
//     the name every downstream spelling will actually emit;
//  2. the PLACEHOLDER shape — `sub_08xxxxxx`-style names are real symbols that no header
//     declares, so emitting one produces output that cannot compile.
import type { SymbolInfo } from '@asmlift/core/symbols';
import { describe, expect, test } from 'vitest';

import { PLACEHOLDER, canonicalOrder } from '../../src/symbols-provider';

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
