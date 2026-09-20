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
import { CompilerRejection } from '@asmlift/core/compiler-diagnostics';
import { NoScorableCandidateError, enumerateCandidates } from '@asmlift/core/rank';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS, targetFor } from '@asmlift/core/target';
import { parseVariation } from '@asmlift/core/variation-tokens';
import { describe, expect, test, vi } from 'vitest';

import { fanSize, fanSizeOfError, runAsmlift } from '../src/eval/asmlift';
import { comparableRow } from '../src/report/stale-check';
import { costNote, rowLine } from '../src/run/runner';
import type { Toolchain } from '../src/toolchains';

vi.mock('@asmlift/cli/rank', () => ({ decompileRanked: vi.fn() }));

const ranked = vi.mocked(decompileRanked);
const TC = { id: 'agbcc' } as Toolchain;
const CODEGEN = targetFor('agbcc', TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
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
      winner: scored[0],
      candidates: scored,
      dropped: Array.from({ length: nDropped }, (_, i) => ({
        variations: [i % 2 ? 'signed' : 'unsigned', 'raw-globals'],
        error: 'error: boom',
      })),
      withheld: Array.from({ length: nWithheld }, () => ({
        variations: ['signed', 'unreduce'],
        score: 9,
        why: 'proof',
      })),
    };
  });
}

describe('fanSize (pure)', () => {
  // core's `rankBy` puts every enumerated candidate into EXACTLY ONE of the four lists, so the
  // fan is their sum. Counting only `candidates` would under-report a row by its whole refused
  // half — `kleod:ProcessInputAndUpdateEntities:agbcc` publishes 51,840 dropped spellings — and
  // a stillborn fan by everything it never compiled.
  test('is scored + dropped + withheld + not compiled, the four lists rankBy partitions the fan into', () => {
    expect(fanSize({ candidates: [1, 2, 3], dropped: [4], withheld: [5, 6] })).toBe(6);
    expect(fanSize({ candidates: [], dropped: [4], withheld: [], notCompiled: [7, 8] })).toBe(3);
  });
});

describe('fanSizeOfError (pure)', () => {
  // A row whose every spelling was refused is published `noncompile` and the ranking THREW — but
  // the fan is not unknown there, it rides on the error. Not recording it makes exactly the rows
  // whose whole fan failed the rows with no price.
  test('reads the fan off the error a fully-refused row throws', () => {
    const e = new NoScorableCandidateError(
      'no scorable candidate',
      [{ variations: ['a'], error: 'x' }],
      [{ variations: ['b'], score: 1, why: 'proof' }],
      [{ variations: ['c'] }],
    );
    expect(fanSizeOfError(e)).toBe(3);
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
    const r = runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('nonmatch');
    // the count is the fan, not the published candidate list
    expect(r.fanSize).toBe((r.droppedCandidates?.length ?? 0) + (r.withheldCandidates?.length ?? 0) + 1);
    expect(r.fanSize).toBeGreaterThan(1);
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
    const r = runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.fanSize).toBe(enumerateCandidates('f', LOADH, ARMV4T_AGBCC, {}).length);
  });

  test('a NONCOMPILE row — every spelling refused — still carries its fan and its seconds', () => {
    ranked.mockImplementation(() => {
      throw new NoScorableCandidateError(
        'no scorable candidate',
        [
          { variations: ['unsigned'], error: 'error: boom' },
          { variations: ['signed', 'raw-globals'], error: 'error: boom' },
        ],
        [],
        [],
      );
    });
    const r = runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('noncompile');
    expect(r.fanSize).toBe(2);
    expect(r.fanVariations).toEqual({
      unsigned: { candidates: 1, dropped: 1 },
      signed: { candidates: 1, dropped: 1 },
      'raw-globals': { candidates: 1, dropped: 1 },
    });
    expect(typeof r.rankSeconds).toBe('number');
  });

  // A STILLBORN fan (core stillborn.ts): the default and one probe per variation were compiled and
  // the rest never was. The row says how many, on the row and per variation, and its markers are
  // the default candidate's compiler lines — the error's own message opens on the verdict.
  test('a STILLBORN row publishes what was not compiled, and its markers are the compiler’s lines', () => {
    const ARITY = "agbcc failed: c.c:12: too many arguments to function `g'";
    ranked.mockImplementation(() => {
      throw new NoScorableCandidateError(
        "no scorable candidate for 'f': 3 of 5 candidates were NOT COMPILED: the default candidate and one probe " +
          `per variation (2 compiled) were all rejected for the same reason, which no variation changed:\n` +
          `  too many arguments to function \`g'\nThe default candidate's compile: ${ARITY}`,
        [
          { variations: ['unsigned'], error: ARITY },
          { variations: ['unsigned', 'raw-globals'], error: ARITY },
        ],
        [],
        [{ variations: ['signed'] }, { variations: ['signed', 'raw-globals'] }, { variations: ['signed', 'unreduce'] }],
        { cause: new CompilerRejection(ARITY) },
      );
    });
    const r = runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('noncompile');
    expect(r.fanNotCompiled).toBe(3);
    // the ENUMERATED count: the two that were compiled and the three that were not
    expect(r.fanSize).toBe(2 + 0 + 3);
    expect(r.fanVariations).toEqual({
      unsigned: { candidates: 2, dropped: 2 },
      signed: { candidates: 3, notCompiled: 3 },
      'raw-globals': { candidates: 2, dropped: 1, notCompiled: 1 },
      unreduce: { candidates: 1, notCompiled: 1 },
    });
    expect(r.errorMarkers).toEqual([ARITY]);
    expect(r.compileErrors).toBe(1);
  });

  test('a row whose every candidate WAS compiled carries no fanNotCompiled at all', () => {
    ranked.mockImplementation(() => {
      throw new NoScorableCandidateError('no scorable candidate', [{ variations: ['unsigned'], error: 'x' }], [], []);
    });
    const r = runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.fanSize).toBe(1);
    expect(r).not.toHaveProperty('fanNotCompiled');
  });

  // A scorer that blew up is not a row that enumerated nothing.
  test('a HARNESS throw records the seconds but claims no fan', () => {
    ranked.mockImplementation(() => {
      throw new Error('error: the scorer died');
    });
    const r = runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('noncompile');
    expect(r).not.toHaveProperty('fanSize');
    expect(r).not.toHaveProperty('fanVariations');
    expect(typeof r.rankSeconds).toBe('number');
  });

  test("a scored row's fanVariations tally its whole fan, and hold every variation the winner carries", () => {
    rankInto(3, 2);
    const r = runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    const t = r.fanVariations!;
    expect((t.unsigned?.candidates ?? 0) + (t.signed?.candidates ?? 0)).toBe(r.fanSize);
    expect(t['raw-globals']).toEqual({ candidates: 3, dropped: 3 });
    expect(t.unreduce).toEqual({ candidates: 2, withheld: 2 });
    const winner = r.winnerVariations!.map((part) => parseVariation(part).name);
    expect(winner.filter((name) => t[name] === undefined)).toEqual([]);
  });

  // The tally parses every candidate's variations, and a name the registry does not hold throws. That
  // is a harness defect: caught with the ranking's throws, it would publish a match as `noncompile`.
  // It must throw on both paths, the scored and the fully refused, and never become an outcome.
  test('an unregistered variation in a SCORED fan throws, rather than rewriting the verdict', () => {
    ranked.mockImplementation((name, asm, target, _obj, opts) => {
      const scored = enumerateCandidates(name, asm, target, opts).map((c) => ({
        ...c,
        score: { ...SCORE, match: true, score: 0 },
      }));
      return {
        winner: scored[0],
        candidates: scored,
        dropped: [{ variations: ['unsigned', 'nosuch'], error: 'error: boom' }],
        withheld: [],
      };
    });
    expect(() => runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile)).toThrow(/nosuch/);
  });

  test('an unregistered variation in a fully REFUSED fan throws too', () => {
    ranked.mockImplementation(() => {
      throw new NoScorableCandidateError('no scorable candidate', [{ variations: ['nosuch'], error: 'x' }], [], []);
    });
    expect(() => runAsmlift(TC, CODEGEN, 'f', LOADH, '/nonexistent.o', undefined, noCompile)).toThrow(/nosuch/);
  });

  // A DECLINED row never reached the ranked pass. Absent is the honest answer; a 0 would read as
  // "this row enumerates nothing", which is a claim about the row rather than about the run.
  test('a declined row carries NEITHER field — it never ranked', () => {
    const r = runAsmlift(TC, CODEGEN, 'f', GAPPED, '/nonexistent.o', undefined, noCompile);
    expect(r.outcome).toBe('declined');
    expect(r).not.toHaveProperty('fanSize');
    expect(r).not.toHaveProperty('fanVariations');
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
    expect(comparableRow(row(side({ fanSize: 96, rankSeconds: 1.2 })))).toBe(
      comparableRow(row(side({ fanSize: 96, rankSeconds: 41.7 }))),
    );
  });

  // …and an artifact written before the field existed must compare equal to a fresh run carrying
  // it, or the first run after this lands reports every row stale over a value nobody can read.
  test('stale-check reads an artifact that predates rankSeconds as unchanged', () => {
    expect(comparableRow(row(side({ fanSize: 96 })))).toBe(comparableRow(row(side({ fanSize: 96, rankSeconds: 3.3 }))));
  });

  // The fan is deterministic, so a fan that moved IS a change worth committing — and is the change
  // this artifact started recording in order to stop losing.
  test('stale-check DOES compare fanSize', () => {
    expect(comparableRow(row(side({ fanSize: 96 })))).not.toBe(comparableRow(row(side({ fanSize: 384 }))));
  });
});

// …and the line it goes INTO. `costNote` pinned alone leaves the assembled line free to drift
// from the test that asserts its shape, and a round's live view of a run IS the assembled line.
describe('the per-row run line', () => {
  const side = (over: Partial<DecompilerResult>): DecompilerResult =>
    ({ decompiler: 'asmlift', outcome: 'nonmatch', score: 12, maxScore: 40, ...over }) as DecompilerResult;

  test('is index, id, both outcomes, then the cost — fan included', () => {
    const r = {
      id: 'kleod:CountCollectedGems:agbcc',
      asmlift: side({ score: 18, maxScore: 344, fanSize: 5952 }),
      m2c: side({ decompiler: 'm2c', outcome: 'noncompile', compileErrors: 1 }),
    } as unknown as FunctionResult;
    expect(rowLine(7, 812, ' s3', r, '518.3')).toBe(
      '[7/812] s3 kleod:CountCollectedGems:agbcc  asmlift=diff:18/344 m2c=noncompile(1)  (518.3s, fan 5952)',
    );
  });

  test('a stillborn row prints how much of its fan was compiled', () => {
    const r = {
      id: 'x:y:agbcc',
      asmlift: side({ outcome: 'noncompile', compileErrors: 1, fanSize: 8, fanNotCompiled: 3 }),
      m2c: side({ decompiler: 'm2c', outcome: 'failed' }),
    } as unknown as FunctionResult;
    expect(rowLine(1, 1, '', r, '1.2')).toBe(
      '[1/1] x:y:agbcc  asmlift=noncompile(1) m2c=failed  (1.2s, fan 8 (5 compiled))',
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
    expect(costNote({ fanSize: 5952 } as DecompilerResult, '518.3')).toBe('(518.3s, fan 5952)');
  });

  // On a stillborn fan the enumerated count is not what was paid for.
  test('prints how much of a stillborn fan was compiled, beside the count that was enumerated', () => {
    expect(costNote({ fanSize: 30240, fanNotCompiled: 30205 } as DecompilerResult, '97.0')).toBe(
      '(97.0s, fan 30240 (35 compiled))',
    );
  });

  // A row that never ranked has no fan. `fan 0` would read as a claim about its enumeration.
  test('says nothing about a fan on a row that never ranked', () => {
    expect(costNote({} as DecompilerResult, '1.2')).toBe('(1.2s)');
  });
});
