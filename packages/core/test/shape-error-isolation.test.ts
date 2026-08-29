// A SHAPE IS ITS OWN CANDIDATE — and it must fail as its own candidate.
//
// `rank.ts`'s `respell` derives the statement shapes (`/initfirst`, `/pollguard`, `/pollread`, and
// all of them together) onto every lever tree. Each subset gets its own try, so two facts hold of
// that loop: a throw deriving one subset leaves the later ones in the fan, and the report names
// `name + suffix + shapeSuffix` — the shape that failed, not the base lever's label.
//
// The shapes are mocked because no committed disassembly fires more than `/initfirst`: the fixture
// that would exercise this naturally is a compiler fact nobody has, and the isolation is a
// property of the loop rather than of any row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { T } from '../src/ir/types';
import type { SFn } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

vi.mock('../src/l3/initfirst', () => ({
  initFirstGuards: (): SFn => {
    throw new Error('mocked shape failure');
  },
}));
vi.mock('../src/l3/pollguard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/l3/pollguard')>();
  return {
    ...actual,
    // fires unconditionally, and changes the emitted text so the dedup keeps it
    pollGuards: (sfn: SFn): SFn => ({ ...sfn, locals: [...sfn.locals, { name: 'zzShape', type: T.s(32) }] }),
  };
});

describe('one throwing shape does not take the others with it', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmascope.s'), 'utf8');
  const errors: { label: string; error: string }[] = [];
  const cands = enumerateCandidates('dmascope', asm, ARMV4T_AGBCC, {
    prototypes: { dmascope: { params: ['s32'], returnsVoid: true } },
    onLeverError: (label, error) => errors.push({ label, error }),
  });

  test('the FIRST subset throws…', () => {
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.error.includes('mocked shape failure'))).toBe(true);
  });

  test('…and the report names the SHAPE SUBSET, not just the lever it was derived onto', () => {
    // the subset is the candidate's identity, so that is what a failure is reported under: the
    // `/initfirst` singleton and the all-shapes subset are two candidates and two reports.
    expect(errors.every((e) => e.label.includes('/initfirst'))).toBe(true);
    const shapeSuffixes = new Set(errors.map((e) => e.label.slice(e.label.indexOf('/initfirst'))));
    expect([...shapeSuffixes].sort()).toEqual(['/initfirst', '/initfirst/pollguard/pollread']);
  });

  test('…while the LATER subsets are still derived ONTO THE LEVER TREES', () => {
    // `/pollguard` on its own comes from the base-tree shape loop, which has always had its own
    // try per subset — the regression this pins is the shapes derived INSIDE `respell`, so the
    // assertion has to name a lever and a shape together.
    expect(
      cands.filter((c) => c.label.includes('/regionbase') && c.label.includes('/pollguard')).length,
    ).toBeGreaterThan(0);
  });

  test('…and the lever spellings the shapes derive FROM are untouched', () => {
    expect(cands.filter((c) => c.label.includes('/regionbase')).length).toBeGreaterThan(0);
  });
});
