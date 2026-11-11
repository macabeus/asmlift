// The contract every gate table is held to, in one place — so adopting `gates.ts` costs a pass one
// line in `src/gate-registry.ts` rather than a test file of its own.
//
// What is NOT here: the differential check that a SOUND gate is load-bearing. That one needs the
// pass's own oracle (coalesce's lives in coalesce-fuzz.test.ts, driven off its table), so this file
// checks the part that is the same everywhere — the table is well-formed, nothing calls itself sound
// without naming a guard, and the guard it names is a test that still exists.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { GATE_TABLES } from '../src/gate-registry';
import { type Gate, ablateHeuristic, gateTableDefects, guardsOf } from '../src/l3/gates';

// The tables come from `src/gate-registry.ts`, the one list of every table core ships, DERIVED and
// COMPOSED tables included; its header says what an entry holds. `gate-registry.test.ts` reads the
// declarations out of `src/` and fails when an exported table is missing from that list, so a pass
// that adopts gates.ts cannot ship a table this file never checks.
//
// What that scan cannot see is a table that is not an exported const: a MODULE-PRIVATE one
// (scopebase.ts's `COUNTING_RULES` and `LOOP_RULES`, which reach the registry only inside
// `SCOPEBASE_GATES` and `REGIONBASE_GATES`), and one COMPOSED at runtime, like the registry's
// `withholdingKey` entry. Those two shapes stay on the author. Nor does it scan CONSULTATION sites,
// which would answer a different question badly: of the 26 `firstRejection` calls in `src/`, 22
// receive the table as a parameter (`gates`, `gates.shape`, `rules`, `admission`) and only four
// name one, so a scan of the call sites would find four tables and miss every table that is passed
// in.

/** Every core test file's text, by file name, so a guard is looked up in the file it names. */
const testFiles = new Map(
  readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => [f, readFileSync(join(__dirname, f), 'utf8')] as const),
);

describe.each(GATE_TABLES.map((t) => [t.name, t.table] as const))('%s', (_name, gates) => {
  test('is well-formed, and nothing calls itself sound without naming a guard', () => {
    expect(gateTableDefects(gates)).toEqual([]);
  });

  test('every named guard is a test that still exists', () => {
    // `guardedBy` is prose until something reads it: `<file>.test.ts: <title>`. Matching the title
    // against the text of the FILE it names is what stops it from decaying into a comment that names
    // a test deleted two refactors ago, or a file that was since renamed. A rule with two halves
    // names one guard per half, and each is looked up.
    const missing = gates
      .flatMap((g) =>
        guardsOf(g).map((one) => {
          const parts = one.split(':');
          return { id: g.id, file: parts[0].trim(), guard: parts[parts.length - 1].trim() };
        }),
      )
      .filter((g) => !testFiles.get(g.file)?.includes(g.guard));
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
