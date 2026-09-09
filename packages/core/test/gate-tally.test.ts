// `tallying` — the census a caller outside core can take off any pass that accepts its gate table.
//
// The behaviour under test is a CONTRACT, not a heuristic: the wrapped table has to be the same
// table (same verdicts, same metadata, still ablatable) and the census has to read the way the
// shipped hand-rolled ones read — first rejecter only, so an absent id is starved or shadowed.
import { describe, expect, test } from 'vitest';

import { type Gate, ablateHeuristic, firstRejection, gateTableDefects, tallying, without } from '../src/l3/gates';

interface Ctx {
  readonly n: number;
}

const table: readonly Gate<Ctx>[] = [
  { id: 'too-small', why: 'anything under two is not a candidate', sound: false, rejects: (c) => c.n < 2 },
  {
    id: 'odd',
    why: 'an odd count cannot be halved',
    sound: true,
    guardedBy: 'ablates odd',
    rejects: (c) => c.n % 2 === 1,
  },
  { id: 'too-big', why: 'above eight the table has no inhabitant', sound: false, rejects: (c) => c.n > 8 },
];

describe('tallying', () => {
  test('counts the gate that ACTUALLY rejected, once per evaluation', () => {
    const t = tallying(table);
    for (const n of [0, 1, 3, 5, 7, 10]) {
      firstRejection(t.gates, { n });
    }
    expect(t.refusals()).toEqual([
      ['odd', 3], // 3, 5 and 7
      ['too-small', 2], // 0 and 1 — 1 is ALSO odd, and `too-small` is first
      ['too-big', 1],
    ]);
  });

  test('an admitted ctx adds nothing, and the census accumulates across calls', () => {
    const t = tallying(table);
    expect(firstRejection(t.gates, { n: 4 })).toBeNull();
    expect(t.refusals()).toEqual([]);
    firstRejection(t.gates, { n: 0 });
    firstRejection(t.gates, { n: 0 });
    expect(t.refusals()).toEqual([['too-small', 2]]);
  });

  test('a SHADOWED rule is absent from the census, exactly as `firstRejection` is documented', () => {
    // `n: 1` rejects on both `too-small` and `odd`; only the first appears. Run alone, `odd` does
    // reject it — which is the experiment that tells shadowed from starved.
    const shadowed = tallying(table);
    firstRejection(shadowed.gates, { n: 1 });
    expect(shadowed.refusals().map(([id]) => id)).toEqual(['too-small']);

    const alone = tallying(without(table, 'too-small'));
    firstRejection(alone.gates, { n: 1 });
    expect(alone.refusals()).toEqual([['odd', 1]]);
  });

  test('the wrapped table is still the same table — same verdicts, metadata, and ablations', () => {
    const t = tallying(table);
    for (const n of [0, 1, 2, 3, 4, 9, 10]) {
      expect(firstRejection(t.gates, { n })).toEqual(firstRejection(table, { n }));
    }
    expect(gateTableDefects(t.gates)).toEqual([]);
    expect(t.gates.map((g) => [g.id, g.sound, g.guardedBy])).toEqual(table.map((g) => [g.id, g.sound, g.guardedBy]));
    expect(ablateHeuristic(t.gates, 'too-small').map((g) => g.id)).toEqual(['odd', 'too-big']);
    expect(() => ablateHeuristic(t.gates, 'odd')).toThrow(/sound/);
  });

  test('ties break in TABLE order, so the census of a uniform corpus is stable', () => {
    const t = tallying(table);
    firstRejection(t.gates, { n: 0 });
    firstRejection(t.gates, { n: 3 });
    firstRejection(t.gates, { n: 10 });
    expect(t.refusals()).toEqual([
      ['too-small', 1],
      ['odd', 1],
      ['too-big', 1],
    ]);
  });
});
