// `bench flags` over a filter that selects no row reports nothing, so it fails rather than reading as
// "every unit ok, every row EQ".
import { afterEach, describe, expect, test, vi } from 'vitest';

import { flagsReport } from '../src/run/flags';

describe('bench flags', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('a filter that matches no row fails, naming the filter', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(flagsReport({ project: 'pokemerald', write: false })).toBe(false);
    expect(flagsReport({ project: 'sa3', only: 'NoSuchSym', write: false })).toBe(false);
    expect(log.mock.calls.map((c) => c.join(' '))).toEqual([
      'no real row matches --project pokemerald',
      'no real row matches --project sa3 --only NoSuchSym',
    ]);
  });
});
