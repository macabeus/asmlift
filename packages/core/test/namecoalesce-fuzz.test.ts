// The differential fuzz behind NAME_COALESCE_GATES — the evidence the pass rests on.
//
// The benchmark cannot see this pass's failure mode. A byte score rewards a MATCH, and a candidate
// that merged two variables it should not have still compiles, still scores, and simply computes
// something else — every defect this file has caught moved zero benchmark rows. So the oracle has
// to be the program's own behaviour: structure the same IR twice — once with the axis, once
// without — interpret both emitted trees, and require the same observable trace.
//
// Arm A: no merge the pass makes changes what the function does. Arm B drops each gate the table
// calls SOUND and requires that one of them DOES — without which arm A is also what "merged
// nothing" looks like. Arm B is written over the table, so a rule added later is held to the same
// bar without anyone remembering to.
//
// The generator, the interpreter and the trace comparison live in `helpers.ts` — `carrier-name-fuzz`
// asks the same oracle a different question. The generator emits LOOPS by default: every defect
// this has caught has been a loop or a mid-block shape, and a fuzz that cannot reach them would be
// a green test for the thing it exists to check.
import { describe, expect, test, vi } from 'vitest';

import type { Fn } from '../src/ir/core';
import { verify } from '../src/ir/verify';
import type { SFn } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { NAME_COALESCE_GATES } from '../src/structure/namecoalesce';
import { structure } from '../src/structure/structure';
import { BREATHE_EVERY, type Event, breathe, generateSsaFn, traceOf, tracesDiffer } from './helpers';

// CORPUS-SIZED WORK IN A PARALLEL WORKER POOL: the 5 s default is a LOAD sensitivity here, not a
// budget. Solo these tests run in 0.9-1.7 s; inside a full `pnpm test:offline` at loadavg ~26 this
// file and two siblings went red with `Error: Test timed out in 5000ms` and nothing else, which
// reads like a soundness failure and is not — re-run alone, 11 tests green in under 2 s. A real
// hang is still loud, just 60 s later. (Not caused by the candidate-object cache: nothing under
// packages/core imports it, and the test fence's positive control passed in the same red run.)
vi.setConfig({ testTimeout: 60_000 });

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
  const hooks = drop ? { nameCoalesceGates: without(NAME_COALESCE_GATES, drop) } : {};
  let off: SFn;
  let on: SFn;
  try {
    off = structure(fn, {});
    on = structure(fn, { coalesceMergeNames: true }, hooks);
  } catch {
    // a decline is not a difference — and with the axis on it can only be the primary's own,
    // which `structure` re-checks first
    return null;
  }
  try {
    return { off: traceOf(off, seed), on: traceOf(on, seed) };
  } catch {
    return null; // step cap, or a construct the interpreter does not model
  }
}

// All three arms sweep the same range. The nested one — whose functions are the largest the
// generator makes — spent two days at 250, because adding it at 4,000 alongside
// `carrier-name-fuzz` produced a fully green `test:offline` that still failed on an unhandled
// `Timeout calling "onTaskUpdate"`. That was a sweep not yielding to the reporter, not a CPU
// ceiling, and #171 fixed it with the `breathe()` call below; the size it forced went back up with
// the sibling's. The table is two columns because all three arms take `SEEDS`: a per-arm size was
// the exception this restore deleted, and a third column re-spelling one constant would be a knob
// claiming an asymmetry the file no longer has.
describe.each([
  ['acyclic', 0],
  ['loop-bearing', 1],
  ['nested', 2],
] as const)('%s', (_name, depth) => {
  test('no merge the pass makes changes what the function does', async () => {
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

// THE ONE PIECE OF EVIDENCE NO SWEEP ABOVE CAN PRODUCE, pinned rather than hunted for.
//
// `namecoalesce.ts` credits this arm with the `loop-escape` finding: dropped, that gate makes some
// nested functions compute something else. No shipped arm has ever ablated it, and raising `SEEDS`
// never will — arm B below iterates `NAME_COALESCE_GATES.filter((x) => x.sound)` and the table
// declares `loop-escape` `sound: false`, so the barrier is a PREDICATE, not a range. (The seeds are
// also outside 4,000: measured, there is no witness at all in 1..4000 at depth 2.) The recipe, for
// whoever comes to reproduce it: drop the gate BY NAME, depth 2, at least 6,437 seeds.
//
// Pinned two-sided — with the gate KEPT both seeds trace identically — so this asserts the gate's
// own work, not a difference the pass would make regardless. Which is also the uncomfortable part:
// a rule whose removal changes what the program COMPUTES is a legality property, while `sound:
// false` in this table means fidelity (its neighbour `param` genuinely is fidelity). Relabelling it
// is not free — arm B would then sweep the gate and go red at `SEEDS` = 4000, since its first
// witness is 5104 — so that stays its own decision, and this coverage does not wait on it.
test('`loop-escape` is load-bearing, at the two seeds no sweep in this file reaches', () => {
  for (const seed of [5104, 6437]) {
    const dropped = spellings(seed, 2, 'loop-escape');
    const kept = spellings(seed, 2);
    expect(dropped, `seed ${seed} must still be a shape this can judge`).not.toBeNull();
    expect(kept, `seed ${seed} must still be a shape this can judge`).not.toBeNull();
    expect(tracesDiffer(dropped!), `seed ${seed}: dropping \`loop-escape\` must change the trace`).toBe(true);
    expect(tracesDiffer(kept!), `seed ${seed}: with \`loop-escape\` kept the trace must not change`).toBe(false);
  }
});

// The one sound rule this generator cannot reach, and why. `type` needs two names whose
// DECLARATIONS disagree, which takes a value pool of more than one width AND a mismatch that
// survives type recovery — every value here is `s32`. Its evidence is the deps-level pair in
// namecoalesce.test.ts instead, which drives the pass at its own boundary. Naming it HERE rather
// than dropping the assertion is the point: exempting a gate is a visible act with a reason
// attached, so a rule added later is still held to the bar unless someone argues it out.
const OUT_OF_REACH = new Set(['type']);

test('every SOUND gate is load-bearing: dropping it changes what some function does', async () => {
  // Written over the TABLE, not over named gates: a rule added later is held to this without
  // anyone remembering to. A gate whose ablation changes nothing is either subsumed or decorative,
  // and either way it must not claim `sound`.
  const inert: string[] = [];
  for (const g of NAME_COALESCE_GATES.filter((x) => x.sound && !OUT_OF_REACH.has(x.id))) {
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
  expect([...OUT_OF_REACH].filter((id) => !NAME_COALESCE_GATES.some((g) => g.id === id && g.sound))).toEqual([]);
});
