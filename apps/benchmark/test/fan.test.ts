import type { RankedCandidate, RankedResult } from '@asmlift/cli/rank';
import { describe, expect, it } from 'vitest';

import type { Case } from '../src/cases/types';
import { FAN_SCORE_LIMIT, pickCandidate, renderFan, scoreLine, selectCases } from '../src/run/fan';

const row = (id: string): Case => ({ id }) as Case;

const cand = (label: string, score: number, rows: number, match = false): RankedCandidate =>
  ({
    label,
    source: `/* ${label} */`,
    group: 0,
    score: { symbol: 'f', score, rows, match, matching: rows - score, breakdown: {} },
  }) as unknown as RankedCandidate;

describe('selectCases', () => {
  // `--only` elsewhere in the harness is a substring match, so a round types a symbol name here.
  it('takes a substring of the row id', () => {
    const cases = [row('kleod:Foo:agbcc'), row('pokeemerald:Bar:agbcc')];
    expect(selectCases(cases, 'Foo').map((c) => c.id)).toEqual(['kleod:Foo:agbcc']);
  });

  // The case a bare substring match gets wrong: one row's whole id is a substring of another's, so
  // naming a row EXACTLY has to resolve to that row rather than to an ambiguity error the caller
  // cannot escape — there is no longer id to type.
  it('prefers an exact id over the longer ids that contain it', () => {
    const cases = [row('kleod:Sub:agbcc'), row('kleod:Sub_2:agbcc')];
    expect(selectCases(cases, 'kleod:Sub:agbcc').map((c) => c.id)).toEqual(['kleod:Sub:agbcc']);
  });

  // …and one symbol across four toolchains is four DIFFERENT measurements. Every match comes back
  // so the caller can print them; silently picking one answers a question nobody asked.
  it('returns every match, so an ambiguous name can be reported rather than guessed', () => {
    const cases = [row('synthetic:dma_wait:agbcc'), row('synthetic:dma_wait:mwcc_242_81')];
    expect(selectCases(cases, 'dma_wait')).toHaveLength(2);
  });

  it('returns nothing for a name no row carries', () => {
    expect(selectCases([row('kleod:Foo:agbcc')], 'Nope')).toEqual([]);
  });
});

describe('scoreLine', () => {
  // PR #174's rule, in the new surface: a score prints against the denominator it was measured
  // against, because two candidates of one row do not share a scale. Measured on
  // `pokeemerald:MathUtil_Mul16:agbcc`, whose fan contains both `3/12` and `3/13`.
  it('carries the denominator and the match flag, through the CLI renderer', () => {
    expect(scoreLine(cand('unsigned', 3, 12))).toBe('asmlift: [score] unsigned: 3/12');
    expect(scoreLine(cand('unsigned/flip-join', 3, 13))).toBe('asmlift: [score] unsigned/flip-join: 3/13');
    expect(scoreLine(cand('unsigned/regcopy-ret', 0, 12, true))).toBe(
      'asmlift: [score] unsigned/regcopy-ret: 0/12 (match)',
    );
  });
});

describe('renderFan', () => {
  const ranked = (over: Partial<RankedResult> = {}): RankedResult =>
    ({
      best: cand('a', 0, 12, true),
      candidates: [cand('a', 0, 12, true), cand('b', 3, 12), cand('c', 4, 13)],
      dropped: [],
      withheld: [],
      ...over,
    }) as RankedResult;

  // THE POINT OF THE COMMAND. `eval/asmlift.ts` publishes the winner and discards
  // `RankedResult.candidates`; six rounds hand-wrote a script to get the rest back.
  it('prints every candidate, not only the winner', () => {
    const out = renderFan(ranked());
    expect(out).toContain('asmlift: [score] a: 0/12 (match)');
    expect(out).toContain('asmlift: [score] b: 3/12');
    expect(out).toContain('asmlift: [score] c: 4/13');
    expect(out).toContain('asmlift: [ranked] 3 candidate(s) scored, 0 dropped, 0 withheld, best a: 0/12 (match)');
  });

  // The CLI prints "N candidate(s) failed to score; first: …" — a footnote under a score someone
  // is reading. Here the fan IS the output, and "first: …" is precisely the shape that sent rounds
  // back to a hand-written script, so both refusal lists are printed whole.
  it('lists every dropped and every withheld candidate, not a count and the first', () => {
    const out = renderFan(
      ranked({
        dropped: [
          { label: 'd1', error: 'error: x undeclared\nmore' },
          { label: 'd2', error: 'error: y undeclared' },
        ],
        withheld: [
          { label: 'w1', score: 2, why: 'needs a byte-exact proof' },
          { label: 'w2', score: 5, why: 'needs a byte-exact proof' },
        ],
      }),
    );
    expect(out).toContain('asmlift: [dropped] d1: error: x undeclared');
    expect(out).toContain('asmlift: [dropped] d2: error: y undeclared');
    expect(out).toContain('asmlift: [withheld] w1 at 2: needs a byte-exact proof');
    expect(out).toContain('asmlift: [withheld] w2 at 5: needs a byte-exact proof');
    // …and only the first line of a multi-line compiler error, so one drop cannot flood the table
    expect(out).not.toContain('more');
  });
});

describe('pickCandidate', () => {
  const cands = [cand('a', 0, 12, true), cand('b', 3, 12)];

  it('finds a candidate by its exact label — the whole `--show` feature', () => {
    expect(pickCandidate(cands, 'b')?.source).toBe('/* b */');
  });

  it('spells the winner `best`, so the published row can be quoted without knowing its label', () => {
    expect(pickCandidate(cands, 'best')?.label).toBe('a');
  });

  // A typo'd label and a lever that produced no candidate at all are the same silence otherwise.
  it('returns undefined for a label nothing carries, so the caller can say so', () => {
    expect(pickCandidate(cands, 'nope')).toBeUndefined();
  });
});

// The scope guard, pinned against the measurement that set it: `synthetic:sizebound:agbcc`
// enumerates 800 candidates and scores them in 57 s cold. A limit at or below that refuses a row
// this command is FOR, so tightening it has to come with a new measurement rather than a hunch.
it('will score a fan the size of the largest row measured through it', () => {
  expect(FAN_SCORE_LIMIT).toBeGreaterThan(800);
});
