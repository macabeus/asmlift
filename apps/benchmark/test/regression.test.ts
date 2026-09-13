// Pin tests for the match-regression gate: a lost match or a vanished row FAILS; every other
// outcome movement (gains, nonmatch reshuffles, new rows) is reported but never a failure.
import type { BenchOutput, DecompilerResult, FunctionResult, Outcome } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

import { sameRun } from '../src/report/committed';
import { notRegenerated } from '../src/report/diff';
import { compareOutcomes, rowsAddedSince } from '../src/report/regression';

const res = (outcome: Outcome): DecompilerResult => ({
  decompiler: 'asmlift',
  outcome,
  source: '',
  score: outcome === 'match' ? 0 : null,
  maxScore: null,
  compileErrors: null,
  quality: { score: 0, lines: 0, gotos: 0, casts: 0, unkGlue: 0, rawMem: 0, addrDeref: 0 },
});

const row = (id: string, asmlift: Outcome, m2c: Outcome): FunctionResult =>
  ({ id, asmlift: res(asmlift), m2c: { ...res(m2c), decompiler: 'm2c' } }) as FunctionResult;

const out = (...results: FunctionResult[]): BenchOutput => ({ meta: {}, results }) as unknown as BenchOutput;

describe('compareOutcomes (the mechanical zero-lost gate)', () => {
  test('identical runs pass', () => {
    const r = compareOutcomes(out(row('a', 'match', 'nonmatch')), out(row('a', 'match', 'nonmatch')));
    expect(r.ok).toBe(true);
    expect(r.lost).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test('an asmlift match→nonmatch flip FAILS and names the row', () => {
    const r = compareOutcomes(out(row('a', 'match', 'declined')), out(row('a', 'nonmatch', 'declined')));
    expect(r.ok).toBe(false);
    expect(r.lost).toEqual([{ id: 'a', decompiler: 'asmlift', from: 'match', to: 'nonmatch' }]);
  });

  test('EVERY match→non-match destination fails, not just nonmatch', () => {
    for (const to of ['declined', 'noncompile', 'failed'] as const) {
      expect(compareOutcomes(out(row('a', 'match', 'failed')), out(row('a', to, 'failed'))).ok).toBe(false);
    }
  });

  test('an m2c lost match ALSO fails — m2c is pinned, so the flip means the harness regressed', () => {
    const r = compareOutcomes(out(row('a', 'declined', 'match')), out(row('a', 'declined', 'nonmatch')));
    expect(r.ok).toBe(false);
    expect(r.lost[0]).toMatchObject({ decompiler: 'm2c' });
  });

  test('a committed row missing from the fresh run fails — a skipped toolchain must be LOUD', () => {
    const r = compareOutcomes(
      out(row('a', 'match', 'match'), row('b', 'nonmatch', 'failed')),
      out(row('a', 'match', 'match')),
    );
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['b']);
  });

  test('gains and non-match reshuffles are informational, never failures', () => {
    const r = compareOutcomes(
      out(row('gain', 'nonmatch', 'declined'), row('shuffle', 'declined', 'noncompile')),
      out(row('gain', 'match', 'declined'), row('shuffle', 'noncompile', 'noncompile')),
    );
    expect(r.ok).toBe(true);
    expect(r.gained).toEqual([{ id: 'gain', decompiler: 'asmlift', from: 'nonmatch', to: 'match' }]);
    expect(r.changed).toEqual([{ id: 'shuffle', decompiler: 'asmlift', from: 'declined', to: 'noncompile' }]);
  });

  test('rows ADDED in the fresh run are fine (dataset growth is not a regression)', () => {
    const r = compareOutcomes(
      out(row('a', 'match', 'match')),
      out(row('a', 'match', 'match'), row('new', 'failed', 'failed')),
    );
    expect(r.ok).toBe(true);
    expect(r.added).toEqual(['new']);
  });
});

// THE ADDRESS MIGRATION. A real row is joined by its address (bench-schema rowIdentity). The base a
// branch compares against may predate addresses entirely, and a gate that keyed the two sides
// differently would print every real row MISSING and every real row ADDED — and still exit 0 on
// "0 lost". These pin that it joins instead, and says it did.
describe('compareOutcomes across row identity', () => {
  const realRow = (sym: string, a: Outcome, m: Outcome, over: Partial<FunctionResult> = {}): FunctionResult =>
    ({
      ...row(`kleod:${sym}:agbcc`, a, m),
      project: 'kleod',
      sym,
      toolchain: 'agbcc',
      tier: 'real',
      sourceUrl: 'https://github.com/macabeus/kleod/blob/6f149e3/src/x.c#L1-L2',
      ...over,
    }) as FunctionResult;

  test('a name-keyed base against an address-keyed fresh run: 0 missing, 0 added, every row bridged', () => {
    const r = compareOutcomes(
      out(realRow('MultiplyQ8', 'match', 'nonmatch'), realRow('DivideQ8', 'match', 'match')),
      out(
        realRow('MultiplyQ8', 'match', 'nonmatch', { addr: '0x08000948' }),
        realRow('DivideQ8', 'match', 'match', { addr: '0x08000960' }),
      ),
    );
    expect({ missing: r.missing, added: r.added, bridged: r.bridged, ok: r.ok }).toEqual({
      missing: [],
      added: [],
      bridged: 2,
      ok: true,
    });
  });

  test('a bridged row is still POLICED: its lost match fails the gate', () => {
    const r = compareOutcomes(
      out(realRow('MultiplyQ8', 'match', 'nonmatch')),
      out(realRow('MultiplyQ8', 'nonmatch', 'nonmatch', { addr: '0x08000948' })),
    );
    expect(r.ok).toBe(false);
    expect(r.lost).toEqual([{ id: 'kleod:MultiplyQ8:agbcc', decompiler: 'asmlift', from: 'match', to: 'nonmatch' }]);
  });

  test('an upstream rename is the same row — and a lost match on it is reported under the NEW name', () => {
    const r = compareOutcomes(
      out(realRow('sub_0804B254', 'match', 'noncompile', { addr: '0x0804b254' })),
      out(realRow('ReadU16', 'nonmatch', 'noncompile', { addr: '0x0804b254', aliases: ['sub_0804B254'] })),
    );
    expect(r.missing).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.lost).toEqual([{ id: 'kleod:ReadU16:agbcc', decompiler: 'asmlift', from: 'match', to: 'nonmatch' }]);
  });
});

// THE POPULATION THE BASE COMPARISON CANNOT SEE. `compareOutcomes` walks the BASE's rows, so a row
// the branch added is compared against nothing at all — for as long as the branch lives, however
// many times it republishes its own artifact. Measured on this branch: with base `origin/main` the
// gate reads `0 lost` while two rows it had itself published at m2c MATCH have become noncompiles;
// against the branch's own artifact the same fresh run is `2 lost`.
describe('rowsAddedSince (the branch own rows, which the base comparison never reaches)', () => {
  test('it is exactly the rows the base does not have', () => {
    const base = out(row('a', 'match', 'match'));
    const self = out(row('a', 'match', 'match'), row('b', 'match', 'match'), row('c', 'nonmatch', 'match'));
    expect(rowsAddedSince(base, self).results.map((r) => r.id)).toEqual(['b', 'c']);
  });

  test('the flip the base comparison misses is LOST against this population', () => {
    const base = out(row('a', 'match', 'match'));
    const self = out(row('a', 'match', 'match'), row('b', 'match', 'match'));
    const fresh = out(row('a', 'match', 'match'), row('b', 'match', 'noncompile'));
    // against the BASE, the added row is invisible
    expect(compareOutcomes(base, fresh).ok).toBe(true);
    // against the added population, the same fresh run is seen
    const added = compareOutcomes(rowsAddedSince(base, self), fresh);
    expect(added.ok).toBe(false);
    expect(added.lost).toEqual([{ id: 'b', decompiler: 'm2c', from: 'match', to: 'noncompile' }]);
  });

  // Rows in BOTH artifacts are already policed by the base comparison; asking them again would
  // report one flip twice and make the two numbers un-addable.
  test('a row the base also has is not counted twice', () => {
    const base = out(row('a', 'match', 'match'));
    const self = out(row('a', 'match', 'match'));
    const fresh = out(row('a', 'nonmatch', 'match'));
    expect(compareOutcomes(base, fresh).lost.length).toBe(1);
    expect(compareOutcomes(rowsAddedSince(base, self), fresh).lost).toEqual([]);
  });

  // A branch that added a row and then stopped running it: the row vanishes from the fresh run and
  // must read as MISSING, never as "no regression".
  test('an added row absent from the fresh run is MISSING, not silence', () => {
    const base = out(row('a', 'match', 'match'));
    const self = out(row('a', 'match', 'match'), row('b', 'match', 'match'));
    const r = compareOutcomes(rowsAddedSince(base, self), out(row('a', 'match', 'match')));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['b']);
  });
});

// THE WINDOW THE ADDED-ROW COMPARISON IS A COMPARISON IN. `rowsAddedSince` reads the branch's own
// committed artifact, and after the regenerated artifact is committed that file IS the one the gate
// reads off disk — so the section compares a file with itself and prints `0 lost` in a millisecond,
// which reads exactly like the ~30-minute run it is meant to summarise. Reproduced by command: at
// the branch's artifact commit, with a clean tree, an unguarded
// `pnpm bench regression --base origin/main` prints `added-row regression: 0 lost, 0 missing,
// 0 gained, 0 other flips (6 rows this branch added since origin/main)` and exits 0, having
// compared nothing. `diff.ts` guards the same vacuity on the BASE side (`notRegenerated`); this is
// the same predicate asked of the SELF side.
describe('sameRun — the artifact-compared-with-itself guard both added-row sections ask', () => {
  const at = (generatedAt: string): BenchOutput => ({ meta: { generatedAt }, results: [] }) as unknown as BenchOutput;

  test('equal generatedAt means no merge ran between them — nothing to compare', () => {
    expect(sameRun(at('2026-09-02T00:46:16.025Z'), at('2026-09-02T00:46:16.025Z'))).toBe(true);
  });

  test('a merge re-mints it, so a real run is not mistaken for a self-comparison', () => {
    expect(sameRun(at('2026-09-02T00:46:16.025Z'), at('2026-09-02T01:12:03.881Z'))).toBe(false);
  });

  // ONE IMPLEMENTATION, not two: `diff.ts`'s `notRegenerated` IS this predicate, so a change to
  // the rule cannot reach one caller and miss the other.
  test('diff.ts notRegenerated is this same predicate', () => {
    expect(notRegenerated(at('x'), at('x'))).toBe(sameRun(at('x'), at('x')));
    expect(notRegenerated(at('x'), at('y'))).toBe(sameRun(at('x'), at('y')));
  });
});
