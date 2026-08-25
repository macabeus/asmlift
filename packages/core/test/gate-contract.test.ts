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

import { BASECSE_GATES, LIVEBASE_BLOCK_GATES, LIVEBASE_GATES } from '../src/l3/basecse';
import { ARM_DISJOINT_GATES, COALESCE_GATES } from '../src/l3/coalesce';
import { type Gate, ablateHeuristic, gateTableDefects } from '../src/l3/gates';
import { INLINEBASE_GATES } from '../src/l3/inlinebase';
import { COUNTDOWN_GATES } from '../src/l3/reindex';
import { VOL_SLOT_GATES } from '../src/l3/volatileval';
import { LATCH_GATES } from '../src/raise/latch';
import { PARAM_WIDTH_GATES } from '../src/raise/paramwidth';
import { PREUPDATE_SINK_GATES } from '../src/structure/hazards';
import { NAME_COALESCE_GATES } from '../src/structure/namecoalesce';

// Every declared table, DERIVED tables included (LIVEBASE_GATES is basecse's admission with the
// placement heuristics ablated, LIVEBASE_BLOCK_GATES that one plus a selectivity rule —
// well-formedness is inherited, but registering them keeps the roster the one place that answers
// "what tables ship?"). A pass that adopts gates.ts and forgets this line gets no contract, which
// is the one hole the pattern cannot close for itself — so keep it short and obvious.
const TABLES: Record<string, readonly Gate<never>[]> = {
  COALESCE_GATES: COALESCE_GATES as readonly Gate<never>[],
  ARM_DISJOINT_GATES: ARM_DISJOINT_GATES as readonly Gate<never>[],
  BASECSE_GATES: BASECSE_GATES as readonly Gate<never>[],
  LIVEBASE_GATES: LIVEBASE_GATES as readonly Gate<never>[],
  LIVEBASE_BLOCK_GATES: LIVEBASE_BLOCK_GATES as readonly Gate<never>[],
  PREUPDATE_SINK_GATES: PREUPDATE_SINK_GATES as readonly Gate<never>[],
  LATCH_GATES: LATCH_GATES as readonly Gate<never>[],
  PARAM_WIDTH_GATES: PARAM_WIDTH_GATES as readonly Gate<never>[],
  NAME_COALESCE_GATES: NAME_COALESCE_GATES as readonly Gate<never>[],
  INLINEBASE_GATES: INLINEBASE_GATES as readonly Gate<never>[],
  VOL_SLOT_GATES: VOL_SLOT_GATES as readonly Gate<never>[],
  COUNTDOWN_GATES: COUNTDOWN_GATES as readonly Gate<never>[],
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

describe('ablateHeuristic', () => {
  const table: readonly Gate<{ x: number }>[] = [
    { id: 'heuristic-rule', why: 'a codegen preference the differ referees', sound: false, rejects: () => false },
    { id: 'sound-rule', why: 'removing it makes a candidate wrong', sound: true, guardedBy: 'x', rejects: () => false },
  ];

  test('ablates a heuristic gate', () => {
    expect(ablateHeuristic(table, 'heuristic-rule').map((g) => g.id)).toEqual(['sound-rule']);
  });

  test('refuses to ablate a sound gate', () => {
    expect(() => ablateHeuristic(table, 'sound-rule')).toThrow(/sound/);
  });

  test('still throws on an unknown id', () => {
    expect(() => ablateHeuristic(table, 'no-such-gate')).toThrow(/no gate/);
  });
});
