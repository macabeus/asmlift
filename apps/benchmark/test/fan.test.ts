import type { BenchOutput } from '@asmlift/bench-schema';
import type { RankedCandidate, RankedResult } from '@asmlift/cli/rank';
import { rankedSummaryLine } from '@asmlift/cli/score-format';
import { FrontendUnsupportedError } from '@asmlift/core/frontend/errors';
import { NoScorableCandidateError, NoSpellableCandidateError } from '@asmlift/core/rank';
import { describe, expect, it } from 'vitest';

import type { Case } from '../src/cases/types';
import {
  FAN_SCORE_LIMIT,
  SCORE_SECONDS_PER_CANDIDATE,
  estimatedScoreTime,
  fanDiffLine,
  noFanReport,
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
// enumerates 800 candidates and scores them in 47.9 s cold. A limit at or below that refuses a row
// this command is FOR, so tightening it has to come with a new measurement rather than a hunch.
it('will score a fan the size of the largest row measured through it', () => {
  expect(FAN_SCORE_LIMIT).toBeGreaterThan(800);
});

// The `[ranked]` line is the one line the briefs tell a round to PASTE, and it has two producers —
// the CLI's ranked run and this command. The fields at risk are the ones that are not counts of the
// fan, because a hand-spelling drops them: `synthesized` (the score rests on declarations asmlift
// invented) and the source stamp (which tree produced it).
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

// Under `--enumerate` nothing is scored, so `best` would name whatever enumeration emitted first —
// a near-worst spelling under the winner's name, to a round both briefs have told that `--show
// best` is the winner.
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

// The refusal's job is to price the run it is refusing, from this row's own count and tier. A fan
// at the limit answers in minutes (800 candidates score in 47.9 s cold), and a scare sentence that
// calls that "well over an hour" steers a reader off `--force` on a row that would have answered.
describe('estimatedScoreTime', () => {
  it('prices the limit itself in minutes, not hours', () => {
    expect(estimatedScoreTime(FAN_SCORE_LIMIT, 'synthetic')).toBe('about 2 min');
  });

  it('is the measured cold rate, and the constant is what was measured', () => {
    expect(SCORE_SECONDS_PER_CANDIDATE.synthetic * 800).toBeCloseTo(48, 0);
    expect(estimatedScoreTime(800, 'synthetic')).toBe('about 48 s');
  });

  // The second measurement, and the reason the constant is a per-tier record: ONE rate priced
  // `kleod:CountCollectedGems:agbcc` — a REAL row, and the row the refusal's own example is — at
  // 6 min, against two cold runs of 518 s and 483 s of scoring. A real candidate escalates through
  // up to three preludes in `makeRealCompile`; a synthetic one is one small prelude, so the gap is
  // structural. The bound is the two measurements, not a third decimal place.
  it('prices a REAL row at the real tier`s rate, which is the slower one', () => {
    expect(SCORE_SECONDS_PER_CANDIDATE.real).toBeGreaterThan(SCORE_SECONDS_PER_CANDIDATE.synthetic);
    const priced = SCORE_SECONDS_PER_CANDIDATE.real * 5952;
    expect(priced).toBeGreaterThanOrEqual(483);
    expect(priced).toBeLessThanOrEqual(518);
    expect(estimatedScoreTime(5952, 'real')).toBe('about 8 min');
  });

  // LoadBGTilemapData: the row this guard exists for, and the run nobody starts by accident. It is
  // a REAL row, so it is priced at the real rate; the synthetic rate would call it 3.8 h.
  it('prices LoadBGTilemapData`s fan in hours', () => {
    expect(estimatedScoreTime(225792, 'real')).toBe('about 5.3 h');
  });
});

// A dropped candidate's source is what a reader most wants (it is the spelling that failed to
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

  // …and on a row where nothing scored there ARE no `[score]` lines, so the caller names the list
  // that does exist. Hard-coding one table's name sends a reader to look for a line that cannot
  // be there.
  it('names the list it was given, not always the [score] table', () => {
    expect(unshowable('nope', ranked, 'the [dropped] lines above')).toContain('the [dropped] lines above');
  });
});

// The sentence is chosen by the ERROR, never by which call site caught it, and that is what these
// pin: `--force` skips the guarded pre-count enumeration, so a DECLINED row's lift error arrives at
// the scoring catch — where a call-site guess prints "every candidate was refused … this is what
// the published row's noncompile outcome means" under zero `[dropped]` lines. Both briefs tell a
// round to pass `--force`.
describe('noFanReport', () => {
  const dropped = [{ label: 'unsigned', error: 'agbcc failed: c.c:12' }];
  const withheld = [{ label: 'unreduce', score: 2, why: 'needs a byte-exact proof' }];

  it('reads NOTHING SCORED off the error class, and prints the drop list that rides on it', () => {
    const e = new NoScorableCandidateError("no scorable candidate for 'f': agbcc failed", dropped, []);
    const r = noFanReport('sa3:f:agbcc', e);
    expect(r.fan).toEqual(['asmlift: [dropped] unsigned: agbcc failed: c.c:12']);
    expect(r.notes.join('\n')).toContain('"noncompile"');
    expect(r.harnessDefect).toBe(false);
  });

  // The all-withheld branch of core's `rankBy` ("N candidate(s) withheld, none scored") is
  // reachable, and a dropped-only count reads "the 0 [dropped] line(s) above ARE this row's fan"
  // printed directly under N withheld lines.
  it('counts BOTH refusal lists, not just the dropped one', () => {
    const e = new NoScorableCandidateError("no scorable candidate for 'f': 1 withheld", [], withheld);
    const r = noFanReport('sa3:f:agbcc', e);
    expect(r.fan).toHaveLength(1);
    expect(r.notes.join('\n')).toContain('0 [dropped] and 1 [withheld]');
  });

  // THE REGRESSION. A decline reaching the scoring catch must still read as a decline.
  it('reads a DECLINE as the row`s gap, from whichever call site caught it', () => {
    const e = new FrontendUnsupportedError("cannot lift 'absi': unmodelled control transfer 'bltzl'");
    const r = noFanReport('synthetic:absi:gcc2.7.2kmc', e);
    const notes = r.notes.join('\n');
    expect(notes).toContain('DECLINES on');
    expect(notes).not.toContain('noncompile');
    expect(notes).not.toContain('every candidate was refused');
    expect(r.fan).toEqual([]);
    expect(r.harnessDefect).toBe(false);
  });

  it('reads a BACKEND refusal as its own fact — nothing was spelled, so nothing was dropped', () => {
    const r = noFanReport('synthetic:f:agbcc', new NoSpellableCandidateError("no spellable candidate for 'f': x"));
    expect(r.notes.join('\n')).toContain('before anything was');
    expect(r.harnessDefect).toBe(false);
  });

  // The guard must not become a story generator: an unclassified throw is the harness, and saying
  // so with the stack is the whole point of the class-based branch. A `TypeError` silently
  // reported as this row's outcome is worse than the crash the guard replaced.
  it('calls an unclassified throw a HARNESS defect, and asks the caller for the stack', () => {
    const r = noFanReport('sa3:f:agbcc', new TypeError('x is not a function'));
    expect(r.harnessDefect).toBe(true);
    expect(r.notes.join('\n')).toContain('HARNESS defect');
  });

  // A thrown `null` turned the no-fan ANSWER back into the crash it replaced.
  it('survives a throw that is not an Error at all', () => {
    expect(() => noFanReport('sa3:f:agbcc', null)).not.toThrow();
  });

  // `--show` was silently dropped here — on a `noncompile` row, i.e. the one row class where
  // EVERY candidate is unshowable and the advice earns its keep.
  it('answers --show instead of ignoring it, and names --enumerate for a dropped label', () => {
    const e = new NoScorableCandidateError("no scorable candidate for 'f': agbcc failed", dropped, []);
    expect(noFanReport('sa3:f:agbcc', e, 'unsigned').notes.join('\n')).toContain('--enumerate --show unsigned');
  });

  it('says --show cannot be answered when the row produced no candidates at all', () => {
    const e = new FrontendUnsupportedError('cannot lift');
    expect(noFanReport('synthetic:absi:gcc2.7.2kmc', e, 'unsigned').notes.join('\n')).toContain('cannot be answered');
  });
});

// THE FAN MULTIPLIER — this tree's enumeration against what the artifact at a base recorded for
// the same row. `LoadBGTilemapData` went 59,904 → 225,792 in six days and that series exists only
// because rounds happened to type it into commit subjects; this is the command that asks.
describe('fanDiffLine', () => {
  const artifact = (rows: { id: string; candidateCount?: number }[]): BenchOutput =>
    ({
      results: rows.map((r) => ({
        id: r.id,
        asmlift: r.candidateCount === undefined ? {} : { candidateCount: r.candidateCount },
      })),
    }) as unknown as BenchOutput;

  it('prints the move and the multiplier a round is asked to report', () => {
    const line = fanDiffLine(
      'proj:Fn:agbcc',
      225792,
      'origin/main',
      artifact([{ id: 'proj:Fn:agbcc', candidateCount: 59904 }]),
    );
    expect(line).toBe('asmlift: [fan-diff] proj:Fn:agbcc: 59904 → 225792 (3.77×) vs origin/main');
  });

  // A fan that SHRANK is the same line under 1 — a round that prunes an axis is reporting a
  // multiplier too, and a renderer that only knows growth makes it invisible.
  it('reports a shrink as a multiplier under 1', () => {
    expect(fanDiffLine('r', 48, 'origin/main', artifact([{ id: 'r', candidateCount: 96 }]))).toContain(
      '96 → 48 (0.50×)',
    );
  });

  // Three ways there is no comparison, and they are three different facts. A silence would let a
  // round paste "no change" for a question that was never asked.
  it('says the base artifact predates the field, rather than reading it as a fan of zero', () => {
    const line = fanDiffLine('r', 96, 'origin/main', artifact([{ id: 'r' }]));
    expect(line).toContain('records no candidate count');
    expect(line).toContain('96');
  });

  it('says a row the base never had was ADDED since, not that its fan grew from nothing', () => {
    const line = fanDiffLine('r', 96, 'origin/main', artifact([{ id: 'other', candidateCount: 4 }]));
    expect(line).toContain('is not in the artifact at origin/main');
  });

  it('says a ref it cannot read is a ref it cannot read', () => {
    const line = fanDiffLine('r', 96, 'nope', { error: "cannot read …: fatal: invalid object name 'nope'" });
    expect(line).toContain('cannot read the artifact at nope');
  });
});
