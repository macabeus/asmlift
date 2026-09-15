// A real row carries the build unit it compiles in and where that unit's flags were copied from; a synthetic
// row compiles at its toolchain's canonical flags and carries neither. The row type says so.
import { type FlagsFrom, type RowTier, rowTier } from '@asmlift/bench-schema';
import { expect, test } from 'vitest';

const FROM: FlagsFrom = {
  from: 'makefile',
  commit: 'a'.repeat(40),
  file: 'Makefile',
  sha256: 'b'.repeat(64),
  command: 'agbcc -O2 -o f.s -',
};

test("a real row's tier names its unit; the tier fields of a wider value are those alone", () => {
  // @ts-expect-error a real row names the unit it compiles in and where its flags came from
  const unitless: RowTier = { tier: 'real' };
  expect(unitless.tier).toBe('real');
  const real = { tier: 'real', unit: 'src/f.c', flagsFrom: FROM, sym: 'f' } as const;
  expect(rowTier(real)).toEqual({ tier: 'real', unit: 'src/f.c', flagsFrom: FROM });
  expect(rowTier({ tier: 'synthetic' })).toEqual({ tier: 'synthetic' });
});
