// The one price model (src/run/price.ts): the cold per-tier floor, the artifact's per-toolchain
// rate, and the estimate every command that refuses or reports a fan quotes.
import type { FunctionResult } from '@asmlift/bench-schema';
import { describe, expect, it } from 'vitest';

import { FAN_SCORE_LIMIT } from '../src/run/fan';
import { SCORE_SECONDS_PER_CANDIDATE, estimatedScoreTime, rankRates, secondsPerCandidate } from '../src/run/price';

// The refusal's job is to price the run it is refusing, from this row's own count and tier. A fan
// at the limit answers in minutes (800 candidates score in 47.9 s cold), and a scare sentence that
// calls that "well over an hour" steers a reader off `--force` on a row that would have answered.
describe('estimatedScoreTime', () => {
  it('prices the limit itself in minutes, not hours', () => {
    expect(estimatedScoreTime(FAN_SCORE_LIMIT, SCORE_SECONDS_PER_CANDIDATE.synthetic)).toBe('about 2 min');
  });

  it('is the measured cold rate, and the constant is what was measured', () => {
    expect(SCORE_SECONDS_PER_CANDIDATE.synthetic * 800).toBeCloseTo(48, 0);
    expect(estimatedScoreTime(800, SCORE_SECONDS_PER_CANDIDATE.synthetic)).toBe('about 48 s');
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
    expect(estimatedScoreTime(5952, SCORE_SECONDS_PER_CANDIDATE.real)).toBe('about 8 min');
  });

  // LoadBGTilemapData: the row this guard exists for, and the run nobody starts by accident. It is
  // a REAL row, so it is priced at the real rate; the synthetic rate would call it 3.8 h.
  it('prices LoadBGTilemapData`s fan in hours', () => {
    expect(estimatedScoreTime(225792, SCORE_SECONDS_PER_CANDIDATE.real)).toBe('about 5.3 h');
  });
});

describe('the artifact rate', () => {
  const row = (toolchain: string, tier: string, fanSize: number, rankSeconds: number, fanNotCompiled?: number) =>
    ({
      toolchain,
      tier,
      asmlift: { fanSize, rankSeconds, ...(fanNotCompiled ? { fanNotCompiled } : {}) },
    }) as FunctionResult;
  const rates = rankRates([
    row('agbcc', 'real', 1000, 12),
    row('mwcc_233_163n', 'real', 100, 50),
    row('mwcc_233_163n', 'real', 1000, 5, 990),
    row('mwcc_233_163n', 'synthetic', 10, 3),
    { toolchain: 'ido7.1', tier: 'real', asmlift: { rankSeconds: 9 } } as FunctionResult,
  ]);

  it('is measured over whole fans only, per toolchain and tier', () => {
    // the stillborn row (990 of 1,000 never compiled) prices nothing
    expect(rates.get('mwcc_233_163n real')).toBeCloseTo(0.5);
    expect(rates.get('mwcc_233_163n')).toBeCloseTo(53 / 110);
    expect(rates.has('ido7.1')).toBe(false);
  });

  it('prices at the slower of that rate and the cold floor', () => {
    expect(secondsPerCandidate('mwcc_233_163n', 'real', rates)).toBeCloseTo(0.5);
    // agbcc's warm 12 ms is under the cold floor, and a fan nobody compiled yet is cold
    expect(secondsPerCandidate('agbcc', 'real', rates)).toBe(SCORE_SECONDS_PER_CANDIDATE.real);
    expect(secondsPerCandidate('ido7.1', 'synthetic', rates)).toBe(SCORE_SECONDS_PER_CANDIDATE.synthetic);
  });
});
