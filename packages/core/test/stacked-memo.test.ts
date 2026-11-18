// A STACKED MEMBER RUNS ONCE PER INPUT TREE, NOT ONCE PER SUBSET HOLDING IT.
//
// rank.ts derives every STACKED_SUBSETS entry onto each source (rank-variations.ts `applyStacked`),
// and a member sits in up to two dozen of the subsets. The members are pure functions of their
// input tree, so both loops share a `StackedMemo` keyed by the member and the input tree's identity.
// Two facts pin it: every subset's result is the one it gets without the memo (the same fired
// members and the same tree, a throw reported under the same steps), and a member never sees one
// input twice in a loop — enumeration-wide, with the real members, through enumerateCandidates.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { SFn } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import {
  STACKED_SUBSETS,
  STACKED_VARIATIONS,
  StackedMemberThrew,
  type StackedMemo,
  applyStacked,
} from '../src/rank-variations';
import { ARMV4T_AGBCC } from '../src/target';
import type { VariationName } from '../src/variation-tokens';

// every input tree `/narrow-read` (the dearest member that never fires on the row that measured
// this) is handed, counted by identity
const narrowReadInputs = new Map<SFn, number>();
vi.mock('../src/l3/narrowdecl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/l3/narrowdecl')>();
  return {
    ...actual,
    narrowReadDeclarations: (sfn: SFn) => {
      narrowReadInputs.set(sfn, (narrowReadInputs.get(sfn) ?? 0) + 1);
      return actual.narrowReadDeclarations(sfn);
    },
  };
});

const tree = (): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: T.s(32) }],
  locals: [{ name: 'v0', type: T.s(32) }],
  retType: T.s(32),
  body: [{ k: 'return', value: { k: 'var', name: 'a0' } }],
});

type Member = (typeof STACKED_VARIATIONS)[number];

describe('applyStacked with a memo', () => {
  // three members: one that fires (adds a local), one that declines, one that throws on a tree the
  // firing one built — counted per call
  const calls = { fire: 0, decline: 0, throw: 0 };
  const members: Member[] = [
    {
      name: 'initfirst' as VariationName,
      apply: (sfn) => {
        calls.fire++;
        return { ...sfn, locals: [...sfn.locals, { name: `z${sfn.locals.length}`, type: T.s(32) }] };
      },
    },
    {
      name: 'narrow-read' as VariationName,
      apply: () => {
        calls.decline++;
        return null;
      },
    },
    {
      name: 'narrow-range' as VariationName,
      apply: (sfn) => {
        calls.throw++;
        if (sfn.locals.length > 1) {
          throw new Error('member threw');
        }
        return null;
      },
    },
  ];
  const [fire, decline, thrower] = members;
  const subsets: Member[][] = [[fire], [decline], [thrower], [fire, decline], [decline, thrower], [fire, thrower]];
  const run = (memo?: StackedMemo) => {
    const from = tree();
    return subsets.map((subset) => {
      try {
        const r = applyStacked(subset, from, memo);
        return r && { variations: r.variations, c: cBackend.emit(r.out) };
      } catch (e) {
        return { threw: e instanceof StackedMemberThrew ? e.variations : String(e) };
      }
    });
  };

  test('every subset gets the result it gets without the memo, throws included', () => {
    const without = run();
    expect(without).toContainEqual({ threw: ['initfirst', 'narrow-range'] });
    expect(run(new WeakMap())).toEqual(without);
  });

  test('a member runs once per distinct input tree', () => {
    calls.fire = calls.decline = calls.throw = 0;
    run(new WeakMap());
    // `fire` sees the root only; `decline` the root and fire's tree (through the memo's own output,
    // so the hit carries to the next member); `thrower` the root and fire's tree
    expect(calls).toEqual({ fire: 1, decline: 2, throw: 2 });
    calls.fire = calls.decline = calls.throw = 0;
    run();
    expect(calls).toEqual({ fire: 3, decline: 3, throw: 3 });
  });
});

describe('enumeration hands each stacked member an input tree once', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmascope.s'), 'utf8');
  narrowReadInputs.clear();
  const cands = enumerateCandidates('dmascope', asm, ARMV4T_AGBCC, {
    prototypes: { dmascope: { params: ['s32'], returnsVoid: true } },
  });

  test('the fixture runs both stacked loops', () => {
    expect(cands.length).toBeGreaterThan(STACKED_SUBSETS.length);
    expect(narrowReadInputs.size).toBeGreaterThan(1);
  });

  test('no input tree is handed to /narrow-read twice', () => {
    expect([...narrowReadInputs.values()].filter((n) => n > 1)).toEqual([]);
  });
});
