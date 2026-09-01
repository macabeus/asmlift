// `structure()` reads `fn` and produces a fresh `SFn`. That was a comment in rank.ts until the
// `/merge-names` axis made it LOAD-BEARING INSIDE `structure()` itself: with the axis on, the
// un-merged structuring runs first so that a candidate can never unlock a function the primary
// declines (`assertPrimaryAccepts`). If structuring ever mutated `fn`, the merged run would be
// working on a different function than the one that was checked, silently.
//
// So this pins the promise where nothing else does: two runs of the same options agree, the axis
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

test('structuring does not mutate the function it reads', () => {
  const opts = structureOptionsFor(ARMV4T_AGBCC, false);
  let checked = 0;
  const defects: string[] = [];
  for (const { name, asm } of corpus()) {
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
    // the axis-on runs, then the primary again — a leaked counter or a mutated graph shows here
    for (const [label, axisOpts] of [
      ['/merge-names', { coalesceMergeNames: true }],
      ['/inplace', { materializeJoinFeeds: true }],
      ['/addr-home', { homeSharedAddresses: true }],
    ] as const) {
      try {
        structure(fn, { ...opts, ...axisOpts });
      } catch {
        /* the axis declining is not a purity defect */
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
  // Not vacuous — but the checkout is optional, so this only asserts when the corpus is present.
  expect(checked === 0 || checked > 20).toBe(true);
});
