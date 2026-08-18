// The contract every gate table is held to, in one place — so adopting `gates.ts` costs a pass one
// line here rather than a test file of its own.
//
// What is NOT here: the differential check that a SOUND gate is load-bearing. That one needs the
// pass's own oracle (coalesce's lives in coalesce-fuzz.test.ts, driven off its table), so this file
// checks the part that is the same everywhere — the table is well-formed, nothing calls itself sound
// without naming a guard, and the guard it names is a test that still exists.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { BASECSE_GATES } from '../src/l3/basecse';
import { COALESCE_GATES } from '../src/l3/coalesce';
import { type Gate, gateTableDefects } from '../src/l3/gates';
import { PREUPDATE_SINK_GATES } from '../src/structure/hazards';

// Every declared table. A pass that adopts gates.ts and forgets this line gets no contract, which is
// the one hole the pattern cannot close for itself — so keep it short and obvious.
const TABLES: Record<string, readonly Gate<never>[]> = {
  COALESCE_GATES: COALESCE_GATES as readonly Gate<never>[],
  BASECSE_GATES: BASECSE_GATES as readonly Gate<never>[],
  PREUPDATE_SINK_GATES: PREUPDATE_SINK_GATES as readonly Gate<never>[],
};

/** Every `test(...)`/`describe(...)` title in the core suite, as one blob to search. */
const titles = readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => readFileSync(join(__dirname, f), 'utf8'))
  .join('\n');

describe.each(Object.entries(TABLES))('%s', (_name, gates) => {
  test('is well-formed, and nothing calls itself sound without naming a guard', () => {
    expect(gateTableDefects(gates)).toEqual([]);
  });

  test('every named guard is a test that still exists', () => {
    // `guardedBy` is prose until something reads it. Matching it against the suite's own titles is
    // what stops it from decaying into a comment that names a test deleted two refactors ago.
    const missing = gates
      .filter((g) => g.guardedBy)
      .map((g) => ({ id: g.id, guard: g.guardedBy!.split(':').pop()!.trim() }))
      .filter((g) => !titles.includes(g.guard));
    expect(missing).toEqual([]);
  });
});
