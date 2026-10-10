// `structure()` reads `fn` and produces a fresh `SFn`. That was a comment in rank.ts until the
// `/merge-names` variation made it LOAD-BEARING INSIDE `structure()` itself: with the variation on, the
// un-merged structuring runs first so that a candidate can never unlock a function the primary
// declines (`assertDefaultAccepts`). If structuring ever mutated `fn`, the merged run would be
// working on a different function than the one that was checked, silently.
//
// So this pins the promise where nothing else does: two runs of the same options agree, the variation
// does not perturb the graph, and the second run of a function is identical to the first — which is
// also what catches a leaked counter, since `v*`/`t*` numbering would drift immediately.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

import { cBackend } from '../src/backend/c';
import { frontendFor } from '../src/frontend/registry';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { applyIdiomPatterns, raiseRecovered } from '../src/pipeline';
import { STRUCTURE_VARIATIONS } from '../src/rank-variations';
import { type StructureOptions, structure } from '../src/structure/structure';
import type { SymbolInfo } from '../src/symbols';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

// CORPUS-SIZED WORK IN A PARALLEL WORKER POOL: the 5 s default is a LOAD sensitivity here, not a
// budget. Solo these tests run in 0.9-1.7 s; inside a full `pnpm test:offline` at loadavg ~26 this
// file and two siblings went red with `Error: Test timed out in 5000ms` and nothing else, which
// reads like a soundness failure and is not — re-run alone, 11 tests green in under 2 s. A real
// hang is still loud, just 60 s later. (Not caused by the candidate-object cache: nothing under
// packages/core imports it, and the test fence's positive control passed in the same red run.)
vi.setConfig({ testTimeout: 60_000 });

// THE CORPUS IS A CHECKOUT NO SETUP RECIPE PRODUCES ANY MORE. It is kl-eod-decomp's split
// `asm/nonmatchings` (182 `.s` files on the machine that last had it), cloned by `bench setup` into
// `checkouts/klonoa-empire-of-dreams` until kleod's rows moved to testyourmine/kleod on 2026-09-13.
// That decomp's `checkouts/kleod` has no split nonmatchings (one `.inc` under `asm/nonmatching`), so
// it cannot stand in. To run this test, clone `Dream-Atelier/kl-eod-decomp` (branch
// `asmlift-benchmark`, commit `494f499`) there and run its `setup.sh` (python >= 3.11) and `gmake`
// — the same remedy `packages/cli/test/matching/checkout-gate.ts` prints. Without it the test is
// SKIPPED, not passed: a green run over zero functions said nothing and read as if it had.
const ASM_DIR = join(__dirname, '../../../apps/benchmark/checkouts/klonoa-empire-of-dreams/asm/nonmatchings');

/** Every liftable function in the klonoa corpus, or none when the checkout is absent (CI). */
function corpus(): { name: string; asm: string }[] {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.s')) files.push(p);
    }
  };
  try {
    walk(ASM_DIR);
  } catch {
    return [];
  }
  return files.map((f) => ({ name: f.split('/').pop()!.replace(/\.s$/, ''), asm: readFileSync(f, 'utf8') }));
}

const CORPUS = corpus();

test.skipIf(CORPUS.length === 0)('structuring does not mutate the function it reads', () => {
  const opts = structureOptionsFor(ARMV4T_AGBCC, false);
  let checked = 0;
  const defects: string[] = [];
  for (const { name, asm } of CORPUS) {
    let fn;
    try {
      fn = frontendFor(ARMV4T_AGBCC).lift(name, asm, ARMV4T_AGBCC, {}, undefined, undefined);
      verify(fn);
      applyIdiomPatterns(fn, ARMV4T_AGBCC);
      raiseRecovered(fn, ARMV4T_AGBCC);
    } catch {
      continue; // a frontend gap is not this file's subject
    }
    const before = print(fn);
    let first: string;
    try {
      first = cBackend.emit(structure(fn, opts));
    } catch {
      continue; // a decline is a fine outcome; it just has no second run to compare
    }
    checked++;
    if (print(fn) !== before) {
      defects.push(`${name}: the default run mutated the graph`);
    }
    // the variation-on runs, then the default again — a leaked counter or a mutated graph shows here
    for (const [label, variationOpts] of [
      ['/merge-names', { coalesceMergeNames: true }],
      ['/inplace', { materializeJoinFeeds: true }],
      ['/addr-home', { homeSharedAddresses: true }],
    ] as const) {
      try {
        structure(fn, { ...opts, ...variationOpts });
      } catch {
        /* the variation declining is not a purity defect */
      }
      if (print(fn) !== before) {
        defects.push(`${name}: the ${label} run mutated the graph`);
      }
    }
    if (cBackend.emit(structure(fn, opts)) !== first) {
      defects.push(`${name}: structuring is not idempotent`);
    }
  }
  expect(defects).toEqual([]);
  // Not vacuous: the test only runs with the corpus present (skipIf above), so it must reach it.
  expect(checked).toBeGreaterThan(20);
});

// WHAT THE DEFAULT-ACCEPTS MEMO RESTS ON (`DefaultAcceptsMemo`), over the committed corpus so it runs
// everywhere. rank.ts structures one fn under every setting in turn, and the memo answers a later
// setting's guard from a reset structured under an earlier one. So after a structuring under ANY
// setting, the fn must read exactly as the next structuring under the same map reads it: under each
// structure variation, the anchors and the follow, and under a map that declares globals volatile,
// whose `declared` stamps every structuring re-derives from the map it is given.
const COMMITTED = readdirSync(join(__dirname, 'corpus'))
  .filter((f) => f.startsWith('agbcc-') && f.endsWith('.s'))
  .map((f) => readFileSync(join(__dirname, 'corpus', f), 'utf8'))
  .map((asm) => ({ name: /\.globl\s+(\w+)/.exec(asm)?.[1], asm }))
  .filter((c): c is { name: string; asm: string } => c.name !== undefined);

const SETTINGS: [string, StructureOptions][] = [
  ...STRUCTURE_VARIATIONS.map((v): [string, StructureOptions] => [`/${v.name}`, v.options(true) ?? {}]),
  ['anchorConstCopies', { anchorConstCopies: true }],
  ['anchorLoopEntryConsts', { anchorLoopEntryConsts: true }],
  ['followEarlyReturns', { followEarlyReturns: true }],
];

test('structuring under any setting leaves the fn as the next structuring under its map reads it', () => {
  const opts = structureOptionsFor(ARMV4T_AGBCC, false);
  const tryStructure = (fn: Parameters<typeof structure>[0], o: StructureOptions): void => {
    try {
      structure(fn, o);
    } catch {
      /* a decline is a fine outcome; what it leaves on the fn is the subject */
    }
  };
  let checked = 0;
  let stamped = 0;
  const defects: string[] = [];
  for (const { name, asm } of COMMITTED) {
    let fn;
    try {
      fn = frontendFor(ARMV4T_AGBCC).lift(name, asm, ARMV4T_AGBCC, {}, undefined, undefined);
      verify(fn);
      applyIdiomPatterns(fn, ARMV4T_AGBCC);
      raiseRecovered(fn, ARMV4T_AGBCC);
    } catch {
      continue; // a frontend gap is not this file's subject
    }
    const unmapped = print(fn);
    const globals = new Set<string>();
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'gaddr') {
          globals.add(op.attrs.sym as string);
        }
      }
    }
    const symbols = new Map<string, SymbolInfo>(
      [...globals].map((g) => [g, { name: g, kind: 'data', volatile: true }]),
    );
    const mapped = { ...opts, symbols };
    tryStructure(fn, mapped);
    const before = print(fn);
    if (before !== unmapped) {
      stamped++;
    }
    checked++;
    for (const [label, setting] of SETTINGS) {
      tryStructure(fn, { ...mapped, ...setting });
      if (print(fn) !== before) {
        defects.push(`${name}: the ${label} run changed the fn`);
      }
    }
    tryStructure(fn, opts);
    if (print(fn) !== unmapped) {
      defects.push(`${name}: a run with no map kept a stamp of the map before it`);
    }
    tryStructure(fn, mapped);
    if (print(fn) !== before) {
      defects.push(`${name}: a run with the map after one with none changed the fn`);
    }
  }
  expect(defects).toEqual([]);
  // Not vacuous: most of the corpus lifts, and some of it reads a global the map stamps.
  expect(checked).toBeGreaterThan(30);
  expect(stamped).toBeGreaterThan(5);
});
