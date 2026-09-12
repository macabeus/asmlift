// THE PRICE OF A ROW'S FAN, recorded on the row (eval/asmlift.ts): how many candidate spellings
// were enumerated, and what the ranked pass cost in wall seconds.
//
// Same rig as symbols-used.test.ts — the ranking is mocked (no compiler in this suite), the
// candidates it ranks are REAL (core's enumeration over the row's own asm), so the partition the
// count rests on is exercised rather than simulated.
import type { DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import { decompileRanked } from '@asmlift/cli/rank';
import type { MatchScore } from '@asmlift/cli/score';
import { NoScorableCandidateError, enumerateCandidates } from '@asmlift/core/rank';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { describe, expect, test, vi } from 'vitest';

import { fanSize, fanSizeOfError, runAsmlift } from '../src/eval/asmlift';
import { rowKey } from '../src/report/stale-check';
import { costNote, rowLine } from '../src/run/runner';
import type { Toolchain } from '../src/toolchains';

vi.mock('@asmlift/cli/rank', () => ({ decompileRanked: vi.fn() }));

const ranked = vi.mocked(decompileRanked);
const TC = { id: 'agbcc', targetDesc: ARMV4T_AGBCC } as Toolchain;
const noCompile = (() => {
  throw new Error('candidate compile must not run in this suite');
}) as unknown as CandidateCompiler;

const SCORE: MatchScore = {
  symbol: 'f',
  score: 3,
  match: false,
  rows: 10,
  matching: 7,
  breakdown: { insert: 0, delete: 0, replace: 0, opMismatch: 3, argMismatch: 0 },
};

const LOADH = 'f:\n\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
/** a gap agbcc's frontend declines on — phase 1 annotates, and the fan is never enumerated */
const GAPPED = 'f:\n\tclz\tr0, r0\n\tbx\tlr\n';

/** Rank-for-real minus the scorer: the row's own enumerated spellings are what SCORES, and the two
 *  refusal lists are stood up beside them. Refusals are synthetic because this row enumerates one
 *  spelling — and that is the shape the count has to get right, since `candidates.length` alone
 *  would call a fan of `1 + nDropped + nWithheld` a fan of 1. */
function rankInto(nDropped: number, nWithheld: number): void {
  ranked.mockImplementation((name, asm, target, _obj, opts) => {
    const scored = enumerateCandidates(name, asm, target, opts).map((c) => ({ ...c, score: SCORE }));
    return {
      best: scored[0],
      candidates: scored,
      dropped: Array.from({ length: nDropped }, (_, i) => ({ label: `d${i}`, error: 'error: boom' })),
      withheld: Array.from({ length: nWithheld }, (_, i) => ({ label: `w${i}`, score: 9, why: 'proof' })),
    };
  });
}

describe('fanSize (pure)', () => {
  // core's `rankBy` puts every enumerated candidate into EXACTLY ONE of the three lists, so the
  // fan is their sum. Counting only `candidates` would under-report a row by its whole refused
  // half — `kleod:ProcessInputAndUpdateEntities:agbcc` publishes 51,840 dropped spellings.
  test('is scored + dropped + withheld, the three lists rankBy partitions the fan into', () => {
    expect(fanSize({ candidates: [1, 2, 3], dropped: [4], withheld: [5, 6] })).toBe(6);
  });
});

describe('fanSizeOfError (pure)', () => {
  // A row whose every spelling was refused is published `noncompile` and the ranking THREW — but
  // the fan is not unknown there, it rides on the error. Not recording it makes exactly the rows
  // whose whole fan failed the rows with no price.
  test('reads the fan off the error a fully-refused row throws', () => {
    const e = new NoScorableCandidateError(
      'no scorable candidate',
      [{ label: 'a', error: 'x' }],
      [{ label: 'b', score: 1, why: 'proof' }],
    );
    expect(fanSizeOfError(e)).toBe(2);
  });

  // …and says nothing about a throw that is not a fan at all. A scorer infrastructure error is
  // caught by the same `catch`, and inventing a 0 there would publish "this row enumerated
  // nothing" for a row nobody counted.
  test('is undefined for a throw that carries no fan', () => {
    expect(fanSizeOfError(new TypeError('x is not a function'))).toBeUndefined();
    expect(fanSizeOfError(null)).toBeUndefined();
  });
});

describe('the ranked row records its own price', () => {
  test('a scored row carries the WHOLE fan, refusals included, and the seconds it cost', () => {
    rankInto(2, 1);
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('nonmatch');
    // the count is the fan, not the published candidate list
    expect(r.candidateCount).toBe((r.droppedCandidates?.length ?? 0) + (r.withheldCandidates?.length ?? 0) + 1);
    expect(r.candidateCount).toBeGreaterThan(1);
    expect(typeof r.rankSeconds).toBe('number');
    expect(r.rankSeconds).toBeGreaterThanOrEqual(0);
  });

  // THE IDENTITY `bench fan --base` RESTS ON at three of its four exits: the number `--enumerate`
  // prints is the number a run RECORDS. They are different calls — `--enumerate` prints
  // `enumerateRanked(...).length`, the run records `fanSize(rankBy(enumerateRanked(...)))` — and
  // they agree only because `rankBy` partitions its input and never filters it. Verified by hand
  // on `synthetic:dma_wait:agbcc` (32 / 32 / 32) and pinned here, with the enumeration real on
  // both sides: a rankBy that dropped a spelling from the fan would compare a published half
  // against a recorded whole and report a shrink nobody caused.
  test('the count a run records is the count --enumerate would print, over the same enumeration', () => {
    rankInto(0, 0);
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.candidateCount).toBe(enumerateCandidates('f', LOADH, ARMV4T_AGBCC, {}).length);
  });

  test('a NONCOMPILE row — every spelling refused — still carries its fan and its seconds', () => {
    ranked.mockImplementation(() => {
      throw new NoScorableCandidateError(
        'no scorable candidate',
        [
          { label: 'a', error: 'error: boom' },
          { label: 'b', error: 'error: boom' },
        ],
        [],
      );
    });
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('noncompile');
    expect(r.candidateCount).toBe(2);
    expect(typeof r.rankSeconds).toBe('number');
  });

  // A scorer that blew up is not a row that enumerated nothing.
  test('a HARNESS throw records the seconds but claims no fan', () => {
    ranked.mockImplementation(() => {
      throw new Error('error: the scorer died');
    });
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('noncompile');
    expect(r).not.toHaveProperty('candidateCount');
    expect(typeof r.rankSeconds).toBe('number');
  });

  // A DECLINED row never reached the ranked pass. Absent is the honest answer; a 0 would read as
  // "this row enumerates nothing", which is a claim about the row rather than about the run.
  test('a declined row carries NEITHER field — it never ranked', () => {
    const r = runAsmlift(TC, 'f', GAPPED, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('declined');
    expect(r).not.toHaveProperty('candidateCount');
    expect(r).not.toHaveProperty('rankSeconds');
  });
});

// A cost recorded on every row reaches TWO gates that walk the whole row, and they must read it
// differently: one number is a measurement and the other is a clock.
describe('what the gates do with a recorded cost', () => {
  const side = (over: Partial<DecompilerResult>): DecompilerResult =>
    ({
      decompiler: 'asmlift',
      outcome: 'nonmatch',
      source: 'int f(){}',
      score: 3,
      maxScore: 10,
      ...over,
    }) as DecompilerResult;
  const row = (asmlift: DecompilerResult): FunctionResult =>
    ({ id: 'x', targetAsm: '', refSource: '', asmlift, m2c: side({ decompiler: 'm2c' }) }) as unknown as FunctionResult;

  // Wall clock differs on every row of every run — machine load, docker, ~5× cold vs warm
  // candidate cache. Compared, `stale-check` would answer `stale` unconditionally and stop being
  // a question.
  test('stale-check ignores rankSeconds — otherwise every run is stale by construction', () => {
    expect(rowKey(row(side({ candidateCount: 96, rankSeconds: 1.2 })))).toBe(
      rowKey(row(side({ candidateCount: 96, rankSeconds: 41.7 }))),
    );
  });

  // …and an artifact written before the field existed must compare equal to a fresh run carrying
  // it, or the first run after this lands reports every row stale over a value nobody can read.
  test('stale-check reads an artifact that predates rankSeconds as unchanged', () => {
    expect(rowKey(row(side({ candidateCount: 96 })))).toBe(rowKey(row(side({ candidateCount: 96, rankSeconds: 3.3 }))));
  });

  // The fan is deterministic, so a fan that moved IS a change worth committing — and is the change
  // this artifact started recording in order to stop losing.
  test('stale-check DOES compare candidateCount', () => {
    expect(rowKey(row(side({ candidateCount: 96 })))).not.toBe(rowKey(row(side({ candidateCount: 384 }))));
  });
});

// …and the line it goes INTO. `costNote` pinned alone is the shape of the incident where the
// `[ranked]` line grew a third count and the only test still asserted two: a round's live view of
// a run is the assembled line, so that is what a test has to hold.
describe('the per-row run line', () => {
  const side = (over: Partial<DecompilerResult>): DecompilerResult =>
    ({ decompiler: 'asmlift', outcome: 'nonmatch', score: 12, maxScore: 40, ...over }) as DecompilerResult;

  test('is index, id, both outcomes, then the cost — fan included', () => {
    const r = {
      id: 'kleod:CountCollectedGems:agbcc',
      asmlift: side({ score: 18, maxScore: 344, candidateCount: 5952 }),
      m2c: side({ decompiler: 'm2c', outcome: 'noncompile', compileErrors: 1 }),
    } as unknown as FunctionResult;
    expect(rowLine(7, 812, ' s3', r, '518.3')).toBe(
      '[7/812] s3 kleod:CountCollectedGems:agbcc  asmlift=diff:18/344 m2c=noncompile(1)  (518.3s, fan 5952)',
    );
  });

  test('a row that never ranked prints no fan, and the rest of the line is unchanged', () => {
    const r = {
      id: 'x:y:agbcc',
      asmlift: side({ outcome: 'declined', errorMarkers: ['gap'] }),
      m2c: side({ decompiler: 'm2c', outcome: 'failed' }),
    } as unknown as FunctionResult;
    expect(rowLine(1, 1, '', r, '1.2')).toBe('[1/1] x:y:agbcc  asmlift=declined(1 gap(s)) m2c=failed  (1.2s)');
  });
});

describe('costNote', () => {
  test('prints the fan beside the seconds, so a run says what it is paying for', () => {
    expect(costNote({ candidateCount: 5952 } as DecompilerResult, '518.3')).toBe('(518.3s, fan 5952)');
  });

  // A row that never ranked has no fan. `fan 0` would read as a claim about its enumeration.
  test('says nothing about a fan on a row that never ranked', () => {
    expect(costNote({} as DecompilerResult, '1.2')).toBe('(1.2s)');
  });
});
