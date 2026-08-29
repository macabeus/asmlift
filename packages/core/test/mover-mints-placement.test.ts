// A DEF-MOVING PASS MINTS TOO, and the placement differential has to judge what it minted.
//
// `rank.ts`'s `survives` is handed the OUTER lever's name diff. For a standalone mover
// (`/nearbase`, `/nearbase/sinkinit`) that diff is EMPTY — `before` is the primary tree — and
// `assertPlacementSurvives` returns on its first line while the pass mints and places a cluster
// base of its own. `reindexWalks` mints an induction variable the same way. So the guard built to
// stop a stranded base local did not cover the passes whose whole job is placing one.
//
// The mover is mocked because no corpus input makes the real `nearBaseClusters` do this — the
// guard is for the class, not for a row.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { T } from '../src/ir/types';
import type { SFn } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

vi.mock('../src/l3/nearbase', () => ({
  // mint a cluster base, read it at the top of the body, and assign it AFTER the return — the
  // #106 shape: C that compiles, scores, and can win while reading an unassigned pointer
  nearBaseClusters: (sfn: SFn): SFn => ({
    ...sfn,
    locals: [...sfn.locals, { name: 'nb0', type: T.ptr(T.s(32)) }],
    body: [
      {
        k: 'store',
        lval: { k: 'index', base: { k: 'var', name: 'nb0' }, idx: { k: 'const', value: 0 }, width: 4, signed: true },
        value: { k: 'const', value: 1 },
      },
      ...sfn.body,
      { k: 'assign', name: 'nb0', value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: 67109076 } } },
    ],
  }),
}));

describe('the mover’s OWN minted local is judged', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmascope.s'), 'utf8');
  const errors: { label: string; error: string }[] = [];
  const cands = enumerateCandidates('dmascope', asm, ARMV4T_AGBCC, {
    prototypes: { dmascope: { params: ['s32'], returnsVoid: true } },
    onLeverError: (label, error) => errors.push({ label, error }),
  });

  test('no `/nearbase` spelling reaches the fan', () => {
    expect(cands.filter((c) => c.label.includes('nearbase'))).toEqual([]);
  });

  test('…and every one is REPORTED under a label naming it', () => {
    const named = errors.filter((e) => e.label.includes('nearbase'));
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((e) => /assignment does not reach/.test(e.error))).toBe(true);
  });

  test('the rest of the fan is untouched', () => {
    expect(cands.length).toBeGreaterThan(100);
  });
});
