import { describe, expect, it } from 'vitest';

import { emptySelectionError, tierIsFiltered } from '../src/run/orchestrate';

// A filter that selects no row used to print `✓ real: 0 results` and exit 0, having replaced a
// good 240-row `real.json` with `results: []` — the file `bench merge` reads next. The verdict is
// taken over the whole run because `--toolchain` only selects in `synthetic` and `--project` only
// in `real`, so "0 rows in this tier" is a legitimate answer for a filter that is not this tier's.
describe('tierIsFiltered', () => {
  it('is false with no filter at all — an unfiltered run can never reach the empty verdict', () => {
    expect(tierIsFiltered('synthetic', {})).toBe(false);
    expect(tierIsFiltered('real', {})).toBe(false);
  });

  it('reads --only in both tiers', () => {
    expect(tierIsFiltered('synthetic', { only: 'Foo' })).toBe(true);
    expect(tierIsFiltered('real', { only: 'Foo' })).toBe(true);
  });

  it('scopes --toolchain to synthetic and --project to real', () => {
    expect(tierIsFiltered('synthetic', { toolchain: 'agbcc' })).toBe(true);
    expect(tierIsFiltered('real', { toolchain: 'agbcc' })).toBe(false);
    expect(tierIsFiltered('real', { project: 'klonoa' })).toBe(true);
    expect(tierIsFiltered('synthetic', { project: 'klonoa' })).toBe(false);
  });
});

// The message is fail-loud output, so it must not claim a write did not happen when it did:
// `--project <typo>` with the default `--tier both` leaves real.json alone but runs synthetic
// WHOLE and rewrites it, because --project does not filter synthetic at all.
describe('emptySelectionError', () => {
  it('names only the tier files that were actually left alone', () => {
    expect(emptySelectionError({ project: 'nosuch' }, ['real']).message).toContain(
      'in tier(s) real — nothing was measured there, and results/real.json left unchanged',
    );
    expect(emptySelectionError({ only: 'Nope' }, ['synthetic', 'real']).message).toContain(
      'results/synthetic.json and results/real.json left unchanged',
    );
  });

  it('quotes back every filter that was in force', () => {
    const m = emptySelectionError({ only: 'Nope', toolchain: 'agbcc' }, ['synthetic']).message;
    expect(m).toContain('--only Nope');
    expect(m).toContain('--toolchain agbcc');
  });
});
