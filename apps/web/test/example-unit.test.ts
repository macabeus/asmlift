// The drawer's "compiled unit" block: readable at the drawer's width, the hole drawn once, and the
// same C the matching suite compiles.
import { EXAMPLE_HOLE, VARIATION_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { describe, expect, test } from 'vitest';

import { HOLE_MARKER, unitForDisplay } from '../src/pages/benchmark/lib/example-unit';

/** The widest line the drawer (`max-w-2xl`, 12px mono, padded) shows without scrolling. */
const DRAWER_COLUMNS = 76;
const CALLEE_DECLARATION = /(?:void|s32) \w+\(\);/g;
const squeezed = (c: string) => c.replace(CALLEE_DECLARATION, '').replace(/\s+/g, '');

const units = Object.entries(VARIATION_DEFINITIONS).map(([name, d]) => ({
  name,
  unit: d.example.unit,
  shown: unitForDisplay(d.example.unit),
}));

describe("the drawer's compiled unit", () => {
  test('fits the drawer without scrolling', () => {
    const wide = units.flatMap(({ name, shown }) =>
      shown.split('\n').flatMap((l) => ([...l].length > DRAWER_COLUMNS ? [`${name}: ${l}`] : [])),
    );
    expect(wide).toEqual([]);
  });

  test('draws the hole once', () => {
    expect(units.filter(({ shown }) => shown.split(HOLE_MARKER).length !== 2).map(({ name }) => name)).toEqual([]);
  });

  test('changes only whitespace and the callee declarations nothing calls', () => {
    for (const { name, unit, shown } of units) {
      expect(squeezed(shown.replace(HOLE_MARKER, EXAMPLE_HOLE)), name).toBe(squeezed(unit));
    }
  });

  test('keeps a callee the unit calls, and drops the ones it does not', () => {
    const shown = unitForDisplay(VARIATION_DEFINITIONS['vol-slot'].example.unit);
    expect(shown).toContain('s32 f();');
    expect(shown).not.toContain('void A();');
  });
});
