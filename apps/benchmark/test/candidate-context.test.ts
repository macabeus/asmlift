// A synthetic row's `candidateContext` (dataset/synthetic.ts): the declarations its candidates compile
// against in place of the block each one synthesizes, so a spelling that is wrong against the row's
// declaration cannot score MATCH by declaring the global its own way.
import { describe, expect, test } from 'vitest';

import { SYNTHETIC } from '../dataset/synthetic';
import { syntheticCases } from '../src/cases/synthetic';

describe('a synthetic row that states the declarations its candidates compile against', () => {
  const stating = SYNTHETIC.filter((s) => s.candidateContext !== undefined);

  test('states only what m2c is told too: every line of it is in the row ctx', () => {
    expect(stating.length).toBeGreaterThan(0);
    for (const s of stating) {
      for (const line of s.candidateContext!.split('\n').filter((l) => l.trim() !== '')) {
        expect(s.ctx?.split('\n'), s.sym).toContain(line);
      }
    }
  });

  test('gets a compile of its own, and a row that states none keeps the tier default', () => {
    const [stated] = syntheticCases({ only: stating[0].sym });
    expect(stated.compile).toBeTypeOf('function');
    const other = SYNTHETIC.find((s) => s.candidateContext === undefined && s.ctx !== undefined)!;
    const [plain] = syntheticCases({ only: other.sym });
    expect(plain.compile).toBeUndefined();
  });
});
