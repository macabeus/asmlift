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
// orders differ, the gate withholds it where they do not — and the gate is a question about ONE
// lift, not about the function, which is why rank asks it per symbol variant on the fn it is about
// to structure rather than once on the shared probe.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { applyIdiomPatterns, raiseRecovered } from '../src/pipeline';
import { foldEmptyLatches } from '../src/raise/latch';
import { enumerateCandidates } from '../src/rank';
import { edgeCopyOrdersDiffer } from '../src/structure/structure';
import type { SymbolMap } from '../src/symbols';
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

// WHY THE GATE IS A `variantGate` AND NOT A `probeGate`, in the two ways the probe position was
// wrong. Neither costs a candidate today — every arm the move adds structures a tree its OFF
// sibling already spelled, measured over 1,298 corpus functions — so these pin the FACTS, which are
// what a reader checking the axis entry's argument needs.

// (1) THE SYMBOL VARIANT. One asm, two lifts: with a map naming its two pool addresses the record
// and the proxy agree, without one they do not. rank enumerates both lifts, so a gate asked once on
// the map-ful probe answers for a program the `/raw-globals` sibling is not.
const HUD = readFileSync(join(import.meta.dirname, 'corpus/agbcc-hudcount.s'), 'utf8');
const HUD_MAP: SymbolMap = new Map([
  [
    0x03000900,
    [
      {
        name: 'gBgTilemapBufs',
        kind: 'data',
        declared: true,
        shape: 'array',
        elemSize: 2,
        elemSigned: false,
        size: 8192,
        dims: [4, 1024],
      },
    ],
  ],
  [
    0x03005220,
    [
      {
        name: 'gHud',
        kind: 'data',
        declared: true,
        shape: 'struct',
        structName: 'Hud',
        size: 100,
        layout: [{ name: 'count', offset: 0x4c, size: 1, signed: false }],
      },
    ],
  ],
]);

test('the same function answers the gate differently with and without a symbol map', () => {
  // Asked where rank now asks it: on the variant's own FULLY RAISED fn, which is what structure()
  // reads. (On the bare lift both variants answer true — the disagreement is made by the tower.)
  const raised = (symbols: SymbolMap | undefined) => {
    const fn = frontendFor(ARMV4T_AGBCC).lift('UpdateHUDCollectibleCount', HUD, ARMV4T_AGBCC, {}, undefined, symbols);
    applyIdiomPatterns(fn, ARMV4T_AGBCC);
    raiseRecovered(fn, ARMV4T_AGBCC);
    return fn;
  };
  expect(edgeCopyOrdersDiffer(raised(HUD_MAP))).toBe(false);
  expect(edgeCopyOrdersDiffer(raised(undefined))).toBe(true);
});

// (2) THE STAGE. rank's probe stops after `recoverTypes`; `foldEmptyLatches` runs after that and
// repoints a predecessor's edge onto the header, carrying the latch's args — so the edge the gate
// judges did not exist when the probe was asked. Here `^bb2` reaches the header only through the
// empty `^bb4`, whose own edge ties; after the fold `^bb2` carries those two copies itself, and its
// record disagrees with its def positions.
const LATCH_FOLD = `fn latchfold {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: s32 = const {value=1}
  br ^bb1(%1, %2)
^bb1(%3: s32, %4: s32):
  %5: u32 = icmp_slt %3, %0
  cond_br %5, ^bb2(%3, %4), ^bb3(%3)
^bb2(%6: s32, %7: s32):
  %8: s32 = add %6, %7
  %9: s32 = add %7, %7
  br ^bb4()
^bb4():
  br ^bb1(%8, %9)
^bb3(%10: s32):
  ret %10
}`;

test('the latch fold changes the answer after the probe has been asked', () => {
  const fn = parse(LATCH_FOLD);
  verify(fn);
  const [entry, header, body, latch, exit] = fn.blocks;
  fn.writeOrder = {
    lastWrite: new Map([
      [
        body,
        new Map([
          [header.params[0], 1],
          [header.params[1], 0],
        ]),
      ],
    ]),
    writes: new Map([
      [entry, 2],
      [header, 0],
      [body, 2],
      [latch, 0],
      [exit, 0],
    ]),
  };
  verify(fn);
  expect(edgeCopyOrdersDiffer(fn)).toBe(false);
  expect(foldEmptyLatches(fn)).toBe(1);
  verify(fn);
  expect(edgeCopyOrdersDiffer(fn)).toBe(true);
});
