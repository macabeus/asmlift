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
import { BREATHE_EVERY, type Event, breathe, generateSsaFn, irTraceOf, traceOf, tracesDiffer } from './helpers';

// CORPUS-SIZED WORK IN A PARALLEL WORKER POOL: the 5 s default is a LOAD sensitivity here, not a
// budget. Solo these tests run in 0.9-1.7 s; inside a full `pnpm test:offline` at loadavg ~26 this
// file and two siblings went red with `Error: Test timed out in 5000ms` and nothing else, which
// reads like a soundness failure and is not — re-run alone, 11 tests green in under 2 s. A real
// hang is still loud, just 60 s later. (Not caused by the candidate-object cache: nothing under
// packages/core imports it, and the test fence's positive control passed in the same red run.)
vi.setConfig({ testTimeout: 60_000 });

const SEEDS = 4000;

/** Both spellings of one seed and what the IR itself does, or null when the shape is not one this
 *  can judge. `ir` is the ORACLE — the observables read off the IR rather than off a structured
 *  tree, so an EMISSION defect the axis-off spelling shares is visible to it and invisible to
 *  `off`. It found one: a call whose only consumer was itself dropped vanished from every spelling
 *  at once (`dead-effect.test.ts`). */
function spellings(
  seed: number,
  depth: 0 | 1 | 2 | 3,
  drop?: string,
): { off: Event[]; on: Event[]; ir: Event[] } | null {
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
    return { off: traceOf(off, seed), on: traceOf(on, seed), ir: irTraceOf(fn, seed) };
  } catch {
    return null; // step cap, or a construct the interpreter does not model
  }
}

// WHAT THE IR ORACLE STILL DISAGREES WITH, per depth, on the shipped spelling — a ratchet, not a
// clean bill, and the same three residual emission defects `carrier-name-fuzz` names beside its own
// copy of this constant (a call inlined beside another call and rendered in the other order; a call
// rendered as an edge copy inside one arm, so an unconditional execution becomes a conditional one;
// a call rendered at two positions). The number is here so the next one cannot be added silently.
const IR_RESIDUAL: Readonly<Record<0 | 1 | 2 | 3, number>> = { 0: 48, 1: 31, 2: 6, 3: 5 };

// HOW MANY SEEDS EACH DEPTH ACTUALLY JUDGES — `spellings` returns null silently on a decline or a
// step cap, and every arm below then skips the seed. Pinned rather than floored (`> SEEDS / 10`)
// because depth 3 judges 647: another 250 seeds over the cap would leave both arms green over
// nothing. See `carrier-name-fuzz`'s copy for the four depth-2 seeds that left silently once
// already.
//
// DIFFERENT FROM `carrier-name-fuzz`'s BY SIX AT DEPTH 1 (2,508 here, 2,502 there), because this
// file's `spellings` structures the function TWICE and loses a seed either spelling declines on.
// The residual constant above matching that file's at every depth is a coincidence of two
// populations, not one measurement — neither belongs in `helpers.ts` as one shared number.
const JUDGED: Readonly<Record<0 | 1 | 2 | 3, number>> = { 0: 4000, 1: 2508, 2: 1556, 3: 647 };

// All three arms sweep `SEEDS`, the nested one included even though its functions are the largest
// the generator makes: it costs a couple of seconds, and a per-arm size would be a knob claiming an
// asymmetry that is not there.
describe.each([
  ['acyclic', 0],
  ['loop-bearing', 1],
  ['nested', 2],
  ['multi-child', 3],
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
    expect(judged, 'the sweep judges the population it measured').toBe(JUDGED[depth]);
    expect(bad).toEqual([]);
  });

  // THE ARM THAT IS NOT A SPELLING COMPARISON. The one above asks whether the merged spelling and
  // the unmerged one agree; both are trees this structurer emitted, so a defect they share is
  // invisible to it by construction. This one asks whether the emitted tree computes what the IR
  // does.
  test('the merged spelling computes what the IR computes', async () => {
    const bad: number[] = [];
    let judged = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      if (seed % BREATHE_EVERY === 0) await breathe();
      const r = spellings(seed, depth);
      if (!r) continue;
      judged++;
      if (tracesDiffer({ off: r.ir, on: r.on })) bad.push(seed);
    }
    expect(judged, 'the sweep judges the population it measured').toBe(JUDGED[depth]);
    // EXACT, not a ceiling: `<=` lets a change that fixes N defects and adds N stay green, and the
    // ceilings are tight today (measured 48/31/6/5, declared 48/31/6/5). A fix is meant to move a
    // number here.
    expect(bad.length, `first disagreeing seed: ${bad[0] ?? '-'}`).toBe(IR_RESIDUAL[depth]);
  });
});

// `loop-escape` IS LOAD-BEARING AND NO SIZE HERE SHOWS IT. Arm B below iterates
// `NAME_COALESCE_GATES.filter((x) => x.sound)`, and that gate is `sound: false` — as is `param`,
// and `type` is exempted below — so raising `SEEDS` never reaches it. Unlike the other two, its
// ablation changes what a function computes; the witnesses are frozen as IR in
// `loop-escape-witnesses.ts`, which also carries how to re-hunt them. Why the flag stays `false` is
// argued in `namecoalesce.ts`'s header, where it is set.

// The one sound rule this generator cannot reach, and why. `type` needs two names whose
// DECLARATIONS disagree, which takes a value pool of more than one width AND a mismatch that
// survives type recovery — every value here is `s32`. Its evidence is the deps-level pair in
// namecoalesce.test.ts instead, which drives the pass at its own boundary. Naming it HERE rather
// than dropping the assertion is the point: exempting a gate is a visible act with a reason
// attached, so a rule added later is still held to the bar unless someone argues it out.
const OUT_OF_REACH = new Set(['type']);

// AGAINST THE IR, not against the axis-off spelling. "Dropping it changes what some function does"
// was measured as "the two spellings differ", which a rule could satisfy by producing a DIFFERENT
// RIGHT ANSWER, and which cannot tell a gate that prevents a wrong program from one that prevents
// an unusual one. The bar here is the harder one a `sound` claim actually makes: some function the
// shipped table gets RIGHT, the ablated table gets WRONG. Both sound gates in reach still clear it
// (measured: `interference` 825 wrong seeds at depth 0 against a base of 48, `sibling-params` 59).
test('every SOUND gate is load-bearing: dropping it makes some function disagree with its own IR', async () => {
  // Written over the TABLE, not over named gates: a rule added later is held to this without
  // anyone remembering to. A gate whose ablation changes nothing is either subsumed or decorative,
  // and either way it must not claim `sound`.
  const inert: string[] = [];
  for (const g of NAME_COALESCE_GATES.filter((x) => x.sound && !OUT_OF_REACH.has(x.id))) {
    let found = false;
    for (const depth of [0, 1, 2, 3] as const) {
      for (let seed = 1; seed <= SEEDS && !found; seed++) {
        if (seed % BREATHE_EVERY === 0) await breathe();
        const r = spellings(seed, depth, g.id);
        if (!r || !tracesDiffer({ off: r.ir, on: r.on })) continue;
        const base = spellings(seed, depth);
        if (base && !tracesDiffer({ off: base.ir, on: base.on })) found = true;
      }
      if (found) break;
    }
    if (!found) inert.push(g.id);
  }
  expect(inert).toEqual([]);
  // and the exemption list stays honest: every name on it is a gate that still exists and is sound
  expect([...OUT_OF_REACH].filter((id) => !NAME_COALESCE_GATES.some((g) => g.id === id && g.sound))).toEqual([]);
});
