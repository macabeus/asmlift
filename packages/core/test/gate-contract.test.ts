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

import {
  BASECSE_GATES,
  BASEFOLD_GATES,
  LIVEBASE_BLOCK_GATES,
  LIVEBASE_GATES,
  ORDERBASE_GATES,
  UNFOLDED_GATES,
} from '../src/l3/basecse';
import { ARM_DISJOINT_GATES, COALESCE_GATES } from '../src/l3/coalesce';
import { type Gate, ablateHeuristic, gateTableDefects } from '../src/l3/gates';
import { HOMESPLIT_FAN_GATES, HOMESPLIT_GATES, withholdingKey } from '../src/l3/homesplit';
import { INLINEBASE_GATES } from '../src/l3/inlinebase';
import { OFFMEMBER_GATES } from '../src/l3/offmember';
import { PTR_FIELD_GATES } from '../src/l3/ptrfield';
import { COUNTDOWN_GATES } from '../src/l3/reindex';
import { REGIONBASE_GATES, SCOPEBASE_ELIGIBILITY, SCOPEBASE_GATES } from '../src/l3/scopebase';
import {
  UNMERGE_ARM_GATES,
  UNMERGE_RUNG_GATES,
  UNMERGE_SITE_GATES,
  UNMERGE_TOTALITY_GATES,
  UNMERGE_VALUE_GATES,
} from '../src/l3/unmerge';
import { UNREDUCE_GATES } from '../src/l3/unreduce';
import { VOL_SLOT_GATES } from '../src/l3/volatileval';
import { VOL_STORE_GATES } from '../src/l3/volstore';
import {
  ADDRESS_GATES,
  DECLARATION_ADDRESS_GATES,
  ELEMENT_ADDRESS_GATES,
  ORDER_SHAPE_GATES,
  SHAPE_GATES,
} from '../src/raise/globalshape';
import { LATCH_GATES } from '../src/raise/latch';
import { MEMBER_ARRAY_GATES } from '../src/raise/memberarrays';
import { NARROW_LOCAL_GATES } from '../src/raise/narrowlocal';
import { PARAM_WIDTH_GATES } from '../src/raise/paramwidth';
import { FALL_IN_GATES } from '../src/raise/retsink';
import { PREUPDATE_SINK_GATES } from '../src/structure/hazards';
import { NAME_COALESCE_GATES } from '../src/structure/namecoalesce';
import { CARRIER_NAME_GATES, FRESH_MERGE_GATES } from '../src/structure/structure';

// Every declared table, DERIVED tables included (LIVEBASE_GATES is basecse's admission with the
// placement heuristics ablated, LIVEBASE_BLOCK_GATES that one plus a selectivity rule —
// well-formedness is inherited, but registering them keeps the roster the one place that answers
// "what tables ship?"). A pass that adopts gates.ts and forgets this line gets no contract.
//
// THE SCANNER AT THE BOTTOM CLOSES MOST OF THAT HOLE, and it is worth knowing where it stops. It
// reads every `export const NAME: Gate<…>[]` out of `src/` and requires the name here, so an
// exported table cannot ship unregistered. What it cannot see is a table that is not an exported
// const with that annotation: a MODULE-PRIVATE one (scopebase.ts's `COUNTING_RULES` and
// `LOOP_RULES`, which reach the roster only inside `SCOPEBASE_GATES` and `REGIONBASE_GATES`), and
// one COMPOSED at runtime, like the `withholdingKey` entry at the end of this record. Those two
// shapes stay on the author. Nor does it scan CONSULTATION sites, which would answer a different
// question badly: of the 26 `firstRejection` calls in `src/`, 22 receive the table as a parameter
// (`gates`, `gates.shape`, `rules`, `admission`) and only four name one, so a scan of the call
// sites would find four tables and miss every table that is passed in.
const TABLES: Record<string, readonly Gate<never>[]> = {
  COALESCE_GATES: COALESCE_GATES as readonly Gate<never>[],
  ARM_DISJOINT_GATES: ARM_DISJOINT_GATES as readonly Gate<never>[],
  BASECSE_GATES: BASECSE_GATES as readonly Gate<never>[],
  BASEFOLD_GATES: BASEFOLD_GATES as readonly Gate<never>[],
  LIVEBASE_GATES: LIVEBASE_GATES as readonly Gate<never>[],
  LIVEBASE_BLOCK_GATES: LIVEBASE_BLOCK_GATES as readonly Gate<never>[],
  UNFOLDED_GATES: UNFOLDED_GATES as readonly Gate<never>[],
  ORDERBASE_GATES: ORDERBASE_GATES as readonly Gate<never>[],
  PREUPDATE_SINK_GATES: PREUPDATE_SINK_GATES as readonly Gate<never>[],
  LATCH_GATES: LATCH_GATES as readonly Gate<never>[],
  FALL_IN_GATES: FALL_IN_GATES as readonly Gate<never>[],
  ADDRESS_GATES: ADDRESS_GATES as readonly Gate<never>[],
  SHAPE_GATES: SHAPE_GATES as readonly Gate<never>[],
  // the two halves `ORDER_LICENCE_GATES` ships — an address table minus the declaration rule, and
  // the shape rules that read the order fact
  ELEMENT_ADDRESS_GATES: ELEMENT_ADDRESS_GATES as readonly Gate<never>[],
  DECLARATION_ADDRESS_GATES: DECLARATION_ADDRESS_GATES as readonly Gate<never>[],
  ORDER_SHAPE_GATES: ORDER_SHAPE_GATES as readonly Gate<never>[],
  MEMBER_ARRAY_GATES: MEMBER_ARRAY_GATES as readonly Gate<never>[],
  NARROW_LOCAL_GATES: NARROW_LOCAL_GATES as readonly Gate<never>[],
  PARAM_WIDTH_GATES: PARAM_WIDTH_GATES as readonly Gate<never>[],
  NAME_COALESCE_GATES: NAME_COALESCE_GATES as readonly Gate<never>[],
  INLINEBASE_GATES: INLINEBASE_GATES as readonly Gate<never>[],
  OFFMEMBER_GATES: OFFMEMBER_GATES as readonly Gate<never>[],
  VOL_SLOT_GATES: VOL_SLOT_GATES as readonly Gate<never>[],
  COUNTDOWN_GATES: COUNTDOWN_GATES as readonly Gate<never>[],
  VOL_STORE_GATES: VOL_STORE_GATES as readonly Gate<never>[],
  UNREDUCE_GATES: UNREDUCE_GATES as readonly Gate<never>[],
  // l3/unmerge.ts's five, one per context it judges — see its header for which is which
  UNMERGE_SITE_GATES: UNMERGE_SITE_GATES as readonly Gate<never>[],
  UNMERGE_ARM_GATES: UNMERGE_ARM_GATES as readonly Gate<never>[],
  UNMERGE_VALUE_GATES: UNMERGE_VALUE_GATES as readonly Gate<never>[],
  UNMERGE_RUNG_GATES: UNMERGE_RUNG_GATES as readonly Gate<never>[],
  UNMERGE_TOTALITY_GATES: UNMERGE_TOTALITY_GATES as readonly Gate<never>[],
  PTR_FIELD_GATES: PTR_FIELD_GATES as readonly Gate<never>[],
  FRESH_MERGE_GATES: FRESH_MERGE_GATES as readonly Gate<never>[],
  CARRIER_NAME_GATES: CARRIER_NAME_GATES as readonly Gate<never>[],
  SCOPEBASE_ELIGIBILITY: SCOPEBASE_ELIGIBILITY as readonly Gate<never>[],
  SCOPEBASE_GATES: SCOPEBASE_GATES as readonly Gate<never>[],
  REGIONBASE_GATES: REGIONBASE_GATES as readonly Gate<never>[],
  HOMESPLIT_GATES: HOMESPLIT_GATES as readonly Gate<never>[],
  HOMESPLIT_FAN_GATES: HOMESPLIT_FAN_GATES as readonly Gate<never>[],
  // A table COMPOSED at runtime — `withholdingKey` prepends its rejection to a caller's own
  // admission, so the shipped table is neither of the two consts. Registered over a representative
  // composition: without it, a `withheld-key` id appearing in the table it wraps is a duplicate
  // nothing checks, and `without()` would then ablate whichever came first.
  WITHHELD_KEY_OVER_LIVEBASE_BLOCK: withholdingKey(LIVEBASE_BLOCK_GATES, 'c:0 4 true') as readonly Gate<never>[],
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

// The roster is hand-maintained and its one failure mode is OMISSION — a table that ships with no
// contract, which no assertion inside this file can notice because the missing table is exactly
// what it never sees. Derive the question instead: read the declarations out of the source.
test('every gate table the source exports is on the roster above', () => {
  const srcFiles: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (p.endsWith('.ts')) {
        srcFiles.push(p);
      }
    }
  };
  walk(join(__dirname, '..', 'src'));
  const declared = srcFiles.flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/^export const ([A-Z][A-Z0-9_]*)\s*:\s*(?:readonly\s+)?Gate</gm)].map(
      (m) => m[1],
    ),
  );
  // REACH: a regex that stops matching would make the check below pass by finding nothing.
  expect(declared.length, 'the declaration scan found no gate tables at all — its regex has rotted').toBeGreaterThan(
    20,
  );
  const unregistered = [...new Set(declared.filter((n) => !(n in TABLES)))].sort();
  expect(unregistered, `exported gate tables absent from TABLES: ${unregistered.join(', ')}`).toEqual([]);
});
