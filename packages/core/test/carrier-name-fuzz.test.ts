// The differential fuzz behind CARRIER_NAME_GATES — the naming walk's own admission table.
//
// `canTakeName` decides whether a block parameter may be SPELLED with a name that already exists,
// which is what makes an in-edge copy disappear. Get it wrong and nothing throws: the emitted
// function reads a variable something else has since written, compiles, scores, and computes
// another program. So the oracle is behaviour, not bytes — the same one `namecoalesce-fuzz` uses,
// and the generator, interpreter and comparison are shared in `helpers.ts`.
//
// The REFERENCE here is not "the axis off", because there is no axis: the walk is the committed
// path. It is a table that admits NOTHING, under which every parameter mints a name of its own and
// every edge copy is written out — the SSA-destruction spelling that is correct by construction.
//
// Arm A: no name the table admits changes what the function does. Arm B drops each gate the table
// calls SOUND and requires that one of them DOES, without which arm A is also what "adopted
// nothing" looks like. Arm B is written over the TABLE, so a rule added later is held to the same
// bar without anyone remembering to.
import { describe, expect, test, vi } from 'vitest';

import type { Fn } from '../src/ir/core';
import { verify } from '../src/ir/verify';
import type { SFn } from '../src/l3/ast';
import { type Gate, without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { CARRIER_NAME_GATES, type CarrierName, structure } from '../src/structure/structure';
import { BREATHE_EVERY, type Event, breathe, generateSsaFn, traceOf, tracesDiffer } from './helpers';

// Same load sensitivity as the sibling fuzz: solo these run in a couple of seconds, and under a
// full parallel suite the 5 s default times out on machine load rather than on a defect.
vi.setConfig({ testTimeout: 60_000 });

/** The reference table: every parameter takes a fresh name, every edge copy is emitted. A gate that
 *  can never be reached is the honest way to spell "admit nothing" — the shipped path has no flag
 *  for it, and a flag would be a test-only branch in production code. */
const ADMIT_NOTHING: readonly Gate<CarrierName>[] = [
  {
    id: 'admit-nothing',
    why: 'the reference spelling: no parameter adopts any existing name',
    sound: false,
    rejects: () => true,
  },
];

// SIZED, not maximal, but the size is now a statement about the sweep rather than about the
// runner. This stood at 250 for two days: at 4,000 this file plus the nested arm next door put 30%
// more CPU into `test:offline` than vitest's own reporter could keep up with, and two of three runs
// ended `2696 passed` plus an unhandled `[vitest-worker]: Timeout calling "onTaskUpdate"`, which
// fails the job. That was never a CPU ceiling — the birpc reply had already arrived, and its 60 s
// timer matured first only because the sweep never yielded. `breathe()` below fixed the cause, so
// the number it forced is no longer owed to anyone.
//
// Back to 4,000, the size the two arms that predate this file have always run. Arm A is the
// expensive half — it structures every generated function TWICE, three depths — and 16x of it
// costs this file a few seconds; arm B is flat in SEEDS, since it stops at the first seed that
// proves a gate load-bearing and every reachable one does that within the first handful. RAISE IT
// FURTHER when hunting: the `loop-escape` finding next door was taken at 8,000, and its two seeds
// (5104 and 6437) are outside even this range.
const SEEDS = 4000;

/** Both spellings of one seed, or null when the shape is not one this can judge. */
function spellings(seed: number, depth: 0 | 1 | 2, drop?: string): { off: Event[]; on: Event[] } | null {
  let fn: Fn;
  try {
    fn = generateSsaFn(seed, depth);
    verify(fn);
    recoverTypes(fn);
  } catch {
    return null;
  }
  let off: SFn;
  let on: SFn;
  try {
    off = structure(fn, {}, { carrierNameGates: ADMIT_NOTHING });
    on = structure(fn, {}, drop ? { carrierNameGates: without(CARRIER_NAME_GATES, drop) } : {});
  } catch {
    return null; // a decline is not a difference
  }
  try {
    return { off: traceOf(off, seed), on: traceOf(on, seed) };
  } catch {
    return null; // step cap, or a construct the interpreter does not model
  }
}

describe.each([
  ['acyclic', 0],
  ['loop-bearing', 1],
  ['nested', 2],
] as const)('%s', (_name, depth) => {
  test('no name the walk adopts changes what the function does', async () => {
    const bad: number[] = [];
    let judged = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      if (seed % BREATHE_EVERY === 0) await breathe();
      const r = spellings(seed, depth);
      if (!r) continue;
      judged++;
      if (tracesDiffer(r)) bad.push(seed);
    }
    expect(judged).toBeGreaterThan(SEEDS / 10); // the sweep is not vacuous
    expect(bad).toEqual([]);
  });
});

// The three rules this generator cannot reach, and why — each with the file that carries its
// evidence instead. Two are about a DECLARED WIDTH: every value here is `s32`, so no carrier can be
// narrower than its taker and no pair can disagree about a signedness that only exists below 32
// bits (`fresh-merge.test.ts`, `carrier-name.test.ts`). The third needs a loop whose body holds a
// merge that OUTLIVES it, which this generator's back edges never build — 0 firings over the whole
// sweep, in both arms (`carrier-name.test.ts`). Naming them HERE rather than dropping the assertion
// is the point: exempting a gate is a visible act with a reason attached.
const OUT_OF_REACH = new Set(['carrier-width', 'carrier-sign', 'carrier-write']);

test('every SOUND gate of CARRIER_NAME_GATES is load-bearing — dropping it changes what some function does', async () => {
  const inert: string[] = [];
  for (const g of CARRIER_NAME_GATES.filter((x) => x.sound && !OUT_OF_REACH.has(x.id))) {
    let found = false;
    for (const depth of [0, 1, 2] as const) {
      for (let seed = 1; seed <= SEEDS && !found; seed++) {
        if (seed % BREATHE_EVERY === 0) await breathe();
        const r = spellings(seed, depth, g.id);
        if (r && tracesDiffer(r)) found = true;
      }
      if (found) break;
    }
    if (!found) inert.push(g.id);
  }
  expect(inert).toEqual([]);
  // and the exemption list stays honest: every name on it is a gate that still exists and is sound
  expect([...OUT_OF_REACH].filter((id) => !CARRIER_NAME_GATES.some((g) => g.id === id && g.sound))).toEqual([]);
});
