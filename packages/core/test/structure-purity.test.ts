// `structure()` reads `fn` and produces a fresh `SFn`. That was a comment in rank.ts until the
// `/merge-names` variation made it LOAD-BEARING INSIDE `structure()` itself: with the variation on, the
// un-merged structuring runs first so that a candidate can never unlock a function the primary
// declines (`assertPrimaryAccepts`). If structuring ever mutated `fn`, the merged run would be
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
import { structure } from '../src/structure/structure';
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
      defects.push(`${name}: the primary run mutated the graph`);
    }
    // the variation-on runs, then the default again — a leaked counter or a mutated graph shows here
    for (const [label, axisOpts] of [
      ['/merge-names', { coalesceMergeNames: true }],
      ['/inplace', { materializeJoinFeeds: true }],
      ['/addr-home', { homeSharedAddresses: true }],
    ] as const) {
      try {
        structure(fn, { ...opts, ...axisOpts });
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
