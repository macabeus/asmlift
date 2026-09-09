import type { RankedCandidate, RankedResult } from '@asmlift/cli/rank';
import { rankedSummaryLine } from '@asmlift/cli/score-format';
import { describe, expect, it } from 'vitest';

import type { Case } from '../src/cases/types';
import {
  FAN_SCORE_LIMIT,
  SCORE_SECONDS_PER_CANDIDATE,
  estimatedScoreTime,
  optionRefusal,
  pickCandidate,
  renderFan,
  scoreLine,
  selectCases,
  synthesizedRefs,
  unshowable,
} from '../src/run/fan';

const row = (id: string): Case => ({ id }) as Case;

/** A fan whose winner rests on no invented declaration, from a named tree — the two fields the
 *  `[ranked]` line carries that are claims rather than counts. */
const NO_DECLS = { synthesized: [], stamp: 'asmlift source deadbee' };

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
    const out = renderFan(ranked(), NO_DECLS);
    expect(out).toContain('asmlift: [score] a: 0/12 (match)');
    expect(out).toContain('asmlift: [score] b: 3/12');
    expect(out).toContain('asmlift: [score] c: 4/13');
    expect(out).toContain(
      'asmlift: [ranked] 3 candidate(s) scored, 0 dropped, 0 withheld, 0 synthesized, best a: 0/12 (match) [asmlift source deadbee]',
    );
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
      NO_DECLS,
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

// F1: the `[ranked]` line is the one line the briefs tell a round to PASTE, and it now has two
// producers — the CLI's ranked run and this command. The fields at risk are the ones that are not
// counts of the fan: `synthesized` (the score rests on declarations asmlift invented) and the
// source stamp (which tree produced it). The first spelling of this line here dropped both.
describe('the [ranked] line', () => {
  const ranked = (over: Partial<RankedResult> = {}): RankedResult =>
    ({
      best: cand('a', 0, 12, true),
      candidates: [cand('a', 0, 12, true), cand('b', 3, 12)],
      dropped: [],
      withheld: [],
      ...over,
    }) as RankedResult;

  it('is rendered by the one shared renderer, so the two producers cannot drift', () => {
    const out = renderFan(ranked(), NO_DECLS);
    expect(out.split('\n').at(-1)).toBe(
      rankedSummaryLine({
        scored: 2,
        dropped: 0,
        withheld: 0,
        synthesized: 0,
        best: cand('a', 0, 12, true),
        stamp: 'asmlift source deadbee',
      }),
    );
  });

  // A `(match)` fitted to the target's own asm by declarations asmlift invented is publishable by
  // pasting this line, unless the line says so.
  it('carries the synthesized count and names the declarations it counted', () => {
    const refs = [{ name: 'gFoo', synthesized: true, info: { kind: 'scalar', width: 4, signed: false } }];
    const out = renderFan(ranked(), {
      synthesized: refs as unknown as Parameters<typeof renderFan>[1]['synthesized'],
      stamp: 'asmlift source deadbee+dirty',
    });
    expect(out).toContain('asmlift: [declared] 1 declaration(s) synthesized from the target asm');
    expect(out).toContain('gFoo');
    expect(out.split('\n').at(-1)).toContain('1 synthesized');
    // …and the tree, on the same line, because a stamp anywhere else is a stamp nobody pastes.
    expect(out.split('\n').at(-1)).toContain('[asmlift source deadbee+dirty]');
  });
});

// The world a row's candidates compile in decides whether an invented declaration can affect the
// score at all: a real row is compiled through the project's headers (compile/real.ts drops the
// block), a synthetic row has nothing but the block.
describe('synthesizedRefs', () => {
  const withRefs = {
    label: 'a',
    symbolRefs: [
      { name: 'gA', synthesized: true },
      { name: 'gB', synthesized: false },
    ],
  } as unknown as RankedCandidate;

  it('counts an invented declaration on a synthetic row, where nothing else declares the name', () => {
    expect(synthesizedRefs('synthetic', withRefs).map((r) => r.name)).toEqual(['gA']);
  });

  it('counts none on a real row, whose every scoring rung is the project`s own headers', () => {
    expect(synthesizedRefs('real', withRefs)).toEqual([]);
  });
});

// F2 / the breaker's SHOULD-FIX: `--enumerate --show best` printed `unsigned` on
// `synthetic:sizebound:agbcc`, a near-worst spelling in a fan whose winner scores 8/81 — under the
// name of the winner, to a round both briefs had told that `--show best` is the winner.
describe('optionRefusal', () => {
  it('refuses --show best under --enumerate, where nothing has been scored', () => {
    expect(optionRefusal({ enumerateOnly: true, show: 'best' })).toContain('no winner to name');
  });

  it('allows --show <label> under --enumerate — an enumerated candidate carries its source', () => {
    expect(optionRefusal({ enumerateOnly: true, show: 'unsigned' })).toBeUndefined();
  });

  it('allows --show best on the scored path, which is sorted best-first', () => {
    expect(optionRefusal({ show: 'best' })).toBeUndefined();
  });
});

// The refusal's job is to price the run it is refusing. The sentence this replaces said "well over
// an hour" for any fan over 2,000 while the same file's doc-comment said two and a half minutes;
// measured, 800 candidates score in 47.9 s cold, so the doc-comment was right and the refusal was
// wrong by ~20x — steering a reader off `--force` on a row that answers in minutes.
describe('estimatedScoreTime', () => {
  it('prices the limit itself in minutes, not hours', () => {
    expect(estimatedScoreTime(FAN_SCORE_LIMIT)).toBe('about 2 min');
  });

  it('is the measured cold rate, and the constant is what was measured', () => {
    expect(SCORE_SECONDS_PER_CANDIDATE * 800).toBeCloseTo(48, 0);
    expect(estimatedScoreTime(800)).toBe('about 48 s');
  });

  // LoadBGTilemapData: the row this guard exists for, and the run nobody starts by accident.
  it('prices LoadBGTilemapData`s fan in hours', () => {
    expect(estimatedScoreTime(225792)).toBe('about 3.8 h');
  });
});

// F4: a dropped candidate's source is what a reader most wants (it is the spelling that failed to
// compile) and it is the one `--show` cannot reach — `DroppedCandidate` carries no source at all.
// Sending them to the `[score]` lines for it is sending them to look for a line that is not there.
describe('unshowable', () => {
  const ranked = {
    candidates: [],
    dropped: [{ label: 'raw-globals', error: 'gFoo undeclared' }],
    withheld: [{ label: 'unreduce', score: 2, why: 'needs a byte-exact proof' }],
  } as unknown as RankedResult;

  it('says a label was DROPPED, and names the flag that can still print its source', () => {
    const msg = unshowable('raw-globals', ranked);
    expect(msg).toContain('was dropped');
    expect(msg).toContain('--enumerate --show raw-globals');
  });

  it('says a label was WITHHELD — it scored, so `no such candidate` would be a lie', () => {
    expect(unshowable('unreduce', ranked)).toContain('was withheld');
  });

  it('falls back to the fan listing for a label nothing carries', () => {
    expect(unshowable('nope', ranked)).toContain('see the [score] lines above');
  });
});
