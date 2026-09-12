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

import { cBackend } from '../src/backend/c';
import type { Fn } from '../src/ir/core';
import { verify } from '../src/ir/verify';
import type { SFn } from '../src/l3/ast';
import { type Gate, without } from '../src/l3/gates';
import { recoverTypes } from '../src/raise/recover';
import { CARRIER_NAME_GATES, type CarrierName, structure } from '../src/structure/structure';
import {
  BREATHE_EVERY,
  type Event,
  IR_RESIDUAL_SEEDS,
  breathe,
  generateSsaFn,
  irTraceOf,
  traceOf,
  tracesDiffer,
} from './helpers';

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

// SIZED, not maximal: 4,000 is the size the sibling fuzz's arms run, and the cost of matching it is
// single-digit seconds of CPU against `test:offline`'s ~102 s. Arm A is the expensive half — it
// structures every generated function TWICE, at three depths; arm B is near-flat in SEEDS, since it
// stops at the first seed that proves a gate load-bearing.
//
// WHAT THE SIZE BUYS HERE IS ARM A's BREADTH, NOT GATE COVERAGE. Measured: cut to 250 all four
// tests still pass, because every sound gate keeps a witness under it — `sibling-param`'s first
// ACYCLIC witness is seed 289, but depth 1's seed 52 proves it anyway; `carrier-live` lands at seed
// 6 and `re-derives` at 22. Gate coverage is what a small size costs NEXT DOOR: `namecoalesce-fuzz`
// goes red at 250, its `sibling-params` having no witness before seed 299 at any depth.
//
// RAISING THIS DOES NOT REACH `namecoalesce`'s `loop-escape`, and never could — the arm that would
// ablate it filters on `sound`, which that table denies the gate. The barrier is a predicate, not a
// range, and its witnesses are frozen as IR in `loop-escape-witnesses.ts` instead.
const SEEDS = 4000;

/** A write-order record under which every block was measured and wrote nothing, so every edge
 *  argument reads as carried in the register it arrived in. Generated IR has no record at all, and
 *  the one naming rule that asks for it — a nested loop's carried value adopting the enclosing
 *  header's name (`enclosingCarrierName`) — refuses on an unmeasured function, so without this the
 *  sweep never reaches it. The most permissive record there is, which is what a soundness sweep
 *  wants: the rule then fires wherever the CFG lets it, and only `canTakeName` stands in its way. */
const passThrough = (fn: Fn): void => {
  fn.writeOrder = { lastWrite: new Map(), writes: new Map(fn.blocks.map((b) => [b, 0] as const)) };
};

/** Both spellings of one seed and what the IR itself does, or null when the shape is not one this
 *  can judge. `ir` is the ORACLE — the observables read off the IR rather than off a structured
 *  tree, so an EMISSION defect the reference spelling shares is visible to it and invisible to
 *  `off`. It found one: a call whose only consumer was itself dropped vanished from every spelling
 *  at once (`dead-effect.test.ts`). */
function spellings(
  seed: number,
  depth: 0 | 1 | 2 | 3,
  drop?: string,
  nested?: { measured: boolean },
): { off: Event[]; on: Event[]; ir: Event[]; src: string } | null {
  let fn: Fn;
  try {
    fn = generateSsaFn(seed, depth, nested !== undefined);
    if (nested?.measured) {
      passThrough(fn);
    }
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
    return { off: traceOf(off, seed), on: traceOf(on, seed), ir: irTraceOf(fn, seed), src: cBackend.emit(on) };
  } catch {
    return null; // step cap, or a construct the interpreter does not model
  }
}

// WHAT THE IR ORACLE STILL DISAGREES WITH is `IR_RESIDUAL_SEEDS` in `helpers.ts`, shared with
// `namecoalesce-fuzz` — a LIST of seeds rather than a count, and one quantity rather than a copy per
// file. Its docblock carries the three defects behind it and the measurement that folded the two
// copies together.

// HOW MANY SEEDS EACH DEPTH ACTUALLY JUDGES. `spellings` returns null — silently, by design — when
// a seed declines or runs the tree interpreter past its step cap, and everything below then skips
// it. Pinned rather than floored at `judged > SEEDS / 10`, because depth 3 sits at 647: a change
// that pushed another 250 seeds past the cap would leave both arms green over nothing, which is
// exactly the vacuity `generator-shape.test.ts` refuses one level up. A change to what the emitter
// spells moves these populations by a few seeds at a time, which a floor does not record.
//
// THESE NUMBERS ARE THIS FILE'S, not a shared quantity, and THIS FILE IS THE OUTLIER. It judges
// 2,502 at depth 1 where `namecoalesce-fuzz` judges 2,508 — six FEWER, not six more — and the cause
// is the REFERENCE table above, not the sibling. `ADMIT_NOTHING` declines on 6 seeds the shipped
// spelling structures (291, 1089, 1489, 1724, 3021, 3923, each `unrecovered back-edge into block
// #k`), and `spellings` needs both, so those six leave here and stay there. Instrumented per depth:
// declines are 1,337 for `ADMIT_NOTHING` against 1,349 for the shipped spelling, and there is no
// seed this file judges that `namecoalesce-fuzz` does not (onlyC = 0 at all four depths).
//
// The sibling's extra `structure()` call costs it NOTHING: `coalesceMergeNames` declines on exactly
// the set the shipped spelling does — 1,349/1,349 at depth 1, 224/224 at depth 2, 551/551 at
// depth 3.
//
// RE-DERIVE, don't reason: classify every seed by which of `structure(fn, {}, {carrierNameGates:
// ADMIT_NOTHING})`, `structure(fn, {})` and `structure(fn, {coalesceMergeNames: true})` throws, and
// whether `traceOf`/`irTraceOf` cap. Verified deterministic forward and in reversed seed order at
// every depth, and `bad` is the identical seed list both ways.
const JUDGED: Readonly<Record<0 | 1 | 2 | 3, number>> = { 0: 4000, 1: 2502, 2: 1556, 3: 647 };

describe.each([
  ['acyclic', 0],
  ['loop-bearing', 1],
  ['nested', 2],
  ['multi-child', 3],
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
    expect(judged, 'the sweep judges the population it measured').toBe(JUDGED[depth]);
    expect(bad).toEqual([]);
  });

  // THE ARM THAT IS NOT A SPELLING COMPARISON. The one above asks whether the walk's spelling and
  // the reference spelling agree; both are trees this structurer emitted, so a defect they share
  // is invisible to it by construction. This one asks whether the emitted tree computes what the
  // IR does.
  test("the walk's spelling computes what the IR computes", async () => {
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
    // THE SEEDS, not how many: a count is green on a change that fixes one defect and adds
    // another. A fix is meant to shorten this list, and a swap is meant to redden it.
    expect(bad).toEqual(IR_RESIDUAL_SEEDS[depth]);
  });
});

// The nested sweep again, on the arm that reaches `enclosingCarrierName`: the generator lets the
// blocks inside the outer loop read what the outer header defined (without that, no value of it is
// ever live after the inner loop, and `carrier-live` has no collision to refuse), and every edge is
// measured as a pass-through, which is the evidence the rule asks for.
//
// A DIFFERENTIAL AGAINST THE SAME GENERATOR UNMEASURED, not an absolute `bad = []`. That shape
// reaches wrong answers the walk gives with or WITHOUT this rule — 7 of 4,000 seeds, the same 7
// measured or not. KNOWN GAP, not this rule's: ablating `canTakeName`'s `pureAlias` waiver clears 6
// of them (a fact about one value, waiving `carrier-live` for every value under the name), and the
// seventh survives that and the back-edge adoption's ablation alike. What the record may not do is
// ADD one. This arm USED to catch an unguarded rule (no `canTakeName`), at seed 1472; with
// `carriedByBothLoops` in front of it that shape is refused first: dropping `canTakeName` from the
// rule leaves this arm green, and dropping both reddens it at 1472 again. The two `canTakeName`
// refusals the rule reaches are pinned in `nested-carrier.test.ts`, each by a fixture and its
// ablation, rather than here.
//
// WHAT THIS ARM CANNOT SEE: the rule's other collision, where the outer back edge hands the
// enclosing slot a value the inner loop did not produce (`carriedByBothLoops`). It lives in the
// PLAIN depth-2 generator rather than this mode, and past this range at one input per seed —
// measured with the clause ablated, 20,000 seeds x 12 inputs: 9 new wrong answers on the plain
// generator (the first at 1062, whose one input here hits the step cap) and 1 in this mode (18381);
// 0 with it. The two smallest plain witnesses are frozen as IR in `loop-escape-witnesses.ts`, and
// `nested-carrier.test.ts` replays them measured. That rule is `carried-by-one-loop`, the one sound
// gate of `ENCLOSING_CARRIER_GATES` — a SECOND table, which this file's "written over the TABLE"
// bar does not cover: its guard is the frozen pair dropped with `without()`, because no seed in
// this range reaches it.
test('nested, measured: a carried value adopting its enclosing header name adds no wrong answer', async () => {
  const bad: number[] = [];
  const preexisting = new Set<number>();
  let judged = 0;
  let adopted = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    if (seed % BREATHE_EVERY === 0) {
      await breathe();
    }
    const r = spellings(seed, 2, undefined, { measured: true });
    const u = spellings(seed, 2, undefined, { measured: false });
    if (u && tracesDiffer(u)) {
      preexisting.add(seed);
    }
    if (!r) {
      continue;
    }
    judged++;
    if (tracesDiffer(r)) {
      bad.push(seed);
    }
    if (r.src !== u?.src) {
      adopted++;
    }
  }
  // Pinned for the same reason as the sweeps above. A smaller population than depth 2's 1,556:
  // this arm needs BOTH the measured and the unmeasured spelling, and loses a seed either one
  // declines on.
  expect(judged, 'the measured arm judges the population it measured').toBe(1088);
  // PINNED, not floored, for the same reason `judged` is. `adopted` is the FIRING counter — the
  // thing that stops the `bad.filter(...)` arm below being green over nothing — so a floor of 1 is
  // exactly the vacuity the pin above exists to refuse: a change that took `enclosingCarrierName`
  // from 252 firings to 1 would leave both arms green, with `judged` still at 1,088 vouching for it.
  expect(adopted, 'the rule fired on the seeds whose spelling the record changed').toBe(252);
  expect(bad.filter((s) => !preexisting.has(s))).toEqual([]);
});

// The three rules this generator cannot reach, and why — each with the file that carries its
// evidence instead. Two are about a DECLARED WIDTH: every value here is `s32`, so no carrier can be
// narrower than its taker and no pair can disagree about a signedness that only exists below 32
// bits (`fresh-merge.test.ts`, `carrier-name.test.ts`). The third needs a loop whose body holds a
// merge that OUTLIVES it, which this generator's back edges never build — 0 firings over the whole
// sweep, in both arms (`carrier-name.test.ts`). Naming them HERE rather than dropping the assertion
// is the point: exempting a gate is a visible act with a reason attached.
const OUT_OF_REACH = new Set(['carrier-width', 'carrier-sign', 'carrier-write']);

// AGAINST THE IR, not against the reference spelling. "Dropping it changes what some function does"
// was measured as "the two spellings differ", which a rule could satisfy by making the function a
// DIFFERENT RIGHT ANSWER — and which cannot distinguish a gate that prevents a wrong program from
// one that prevents an unusual one. The bar here is the harder one a `sound` claim actually makes:
// some function the shipped table gets RIGHT, the ablated table gets WRONG. Every sound gate in
// reach still clears it (measured: `carrier-live` 900 wrong seeds at depth 0 against a base of 48,
// `re-derives` 152, `sibling-param` 62).
test('every SOUND gate of CARRIER_NAME_GATES is load-bearing — dropping it makes some function disagree with its own IR', async () => {
  const inert: string[] = [];
  for (const g of CARRIER_NAME_GATES.filter((x) => x.sound && !OUT_OF_REACH.has(x.id))) {
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
  expect([...OUT_OF_REACH].filter((id) => !CARRIER_NAME_GATES.some((g) => g.id === id && g.sound))).toEqual([]);
});
