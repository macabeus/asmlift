// `/copy-defpos` — the EDGE-COPY ORDER axis (rank.ts STRUCTURING_AXES, structure.ts
// `preferDefPosCopyOrder`).
//
// The frontend measures the order each predecessor wrote its successors' keys, and the default
// lays an edge's copies out in it. That is licensed for a CYCLIC copy set (the spill has to be the
// register whose old value was displaced first) and only ASSUMED for an acyclic one — and the
// benchmark answers the assumption both ways inside a single compiler: `synthetic:gcd:mwcc_242_81`
// matches with the record while `memcpy1:mwcc_242_81` and `memset1:mwcc_242_81` score worse with
// it. So the def-position spelling is enumerated BESIDE the record's and the differ referees,
// rather than a per-compiler boolean declaring one of them right.
//
// What this file pins: the sibling exists and is a genuinely different program where the two
// orders differ, and the gate withholds it where they do not.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { parse } from '../src/ir/parse';
import { enumerateCandidates } from '../src/rank';
import { edgeCopyOrdersDiffer } from '../src/structure/structure';
import { ARMV4T_AGBCC } from '../src/target';

const GCD = readFileSync(join(import.meta.dirname, 'corpus/agbcc-gcd.s'), 'utf8');
// No CFG edge carries two copies at all, so the two orders cannot differ.
const HALF = [
  '\t.code\t16',
  '\t.thumb_func',
  'half:',
  '\tlsr\tr1, r0, #31',
  '\tadd\tr0, r0, r1',
  '\tasr\tr0, r0, #1',
  '\tbx\tlr',
  '',
].join('\n');

test('the axis offers the def-position spelling beside the record-ordered one', () => {
  const cands = enumerateCandidates('gcd', GCD, ARMV4T_AGBCC, {});
  const base = cands.find((c) => c.label === 'signed');
  const sibling = cands.find((c) => c.label === 'signed/copy-defpos');
  expect(base).toBeDefined();
  expect(sibling).toBeDefined();
  // The record spills the DIVISOR's home (agbcc's own `add r4, r0, #0` — the loop's first
  // instruction); the def-position proxy, which cannot compare an incoming param with an in-block
  // def, spills the other member. Two correct sequentializations of one parallel copy, and only
  // the differ can say which the compiler wrote.
  expect(base!.source).toContain('t0 = v0;\n        v0 = v1 % v0;\n        v1 = t0;');
  expect(sibling!.source).toContain('t0 = v1;\n        v1 = v0;\n        v0 = t0 % v0;');
});

test('…and it is a real product: every spelling gets the sibling, never just the base', () => {
  const labels = enumerateCandidates('gcd', GCD, ARMV4T_AGBCC, {}).map((c) => c.label);
  const withAxis = labels.filter((l) => l.endsWith('/copy-defpos'));
  expect(withAxis.length).toBeGreaterThan(0);
  for (const l of withAxis) {
    expect(labels).toContain(l.slice(0, -'/copy-defpos'.length));
  }
});

test('the gate withholds the sibling where the two orders cannot differ', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('half', HALF, ARMV4T_AGBCC, {}, undefined, undefined);
  expect(edgeCopyOrdersDiffer(fn)).toBe(false);
  expect(enumerateCandidates('half', HALF, ARMV4T_AGBCC, {}).some((c) => c.label.includes('copy-defpos'))).toBe(false);
});

test('an UNMEASURED fn has no question to ask: parsed IR never admits the axis', () => {
  // The record is the frontend's measurement; a parsed fn carries none, so the def-position proxy
  // is already what runs and the sibling would be the same tree.
  const fn = parse(`fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = add %0, %1
  %3: s32 = add %1, %0
  br ^bb1(%2, %3)
^bb1(%4: s32, %5: s32):
  ret %4
}`);
  expect(fn.writeOrder).toBeUndefined();
  expect(edgeCopyOrdersDiffer(fn)).toBe(false);
});
