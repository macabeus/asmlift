// A RETURN TAIL THE COMPILER CROSS-JUMPED, read off the asm layout.
//
// Two probe pairs, each compiled by scripts/regen-rettail-probes.ts at every toolchain's canonical
// flags. In each pair the source writes one function twice: the return tail in every arm
// (`-copies`), and the tail written once after the construct (`-join`).
//   - `pa`: a three-arm `if` whose arms call `h(10, 0)`, `h(20, 0)` and `h(30, 0)`, the last arm
//     falling into the function's end.
//   - `pb`: a seven-case `switch` whose cases add 256, 512, 528 ×3, 512 and 256 to `p[3]`.
// Four claims, one per layer:
//   1. which compilers merge a return tail written into every arm (target.ts
//      `crossJumpsReturnTails`), read from the objects themselves;
//   2. the frontend records where each block was laid out (ir/core.ts `AsmLayout`);
//   3. the structurer reports each place it took the join past early returns, and
//      structure/cross-jumped-tail.ts reads the layout there;
//   4. the plain default publishes the copies where that layout shows the merge, on a target that
//      declares it, and the size bound decides everywhere else.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { raiseRecovered } from '../src/pipeline';
import { type JoinPastReturnsSite, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS, structureOptionsFor } from '../src/target';

const CORPUS = join(import.meta.dirname, 'corpus');
const fixture = (file: string) => readFileSync(join(CORPUS, file), 'utf8');
type Probe = 'pa-copies' | 'pa-join' | 'pb-copies' | 'pb-join';

/** The instruction lines of a committed fixture, without its provenance header. */
const instructions = (file: string): string[] =>
  fixture(file)
    .split('\n')
    .filter((l) => !/^[@#]/.test(l) && /^\s+(?:[0-9a-f]+:\s+)?[a-z]/.test(l))
    .map((l) => l.replace(/^\s+[0-9a-f]+:\s+/, '').trim());

const LANES = [
  { tc: 'agbcc', file: (p: Probe) => `agbcc-rettail-${p}.s` },
  { tc: 'gcc2.7.2', file: (p: Probe) => `gcc272-rettail-${p}.asm` },
  { tc: 'gcc2.7.2kmc', file: (p: Probe) => `gcc272kmc-rettail-${p}.asm` },
  { tc: 'ido7.1', file: (p: Probe) => `ido71-rettail-${p}.asm` },
  { tc: 'mwcc_242_81', file: (p: Probe) => `mwcc242-rettail-${p}.asm` },
] as const;

// the tail of `pb`: the store back to `p[3]`, in each ISA's spelling
const TAIL_STORE = /^(?:str\s+\w+, \[\w+, #0xc\]|sw\s+\w+,12\(\w+\)|stw\s+\w+,12\(\w+\))/;
const CALL = /^(?:bl|jal)\s/;

describe('which compilers cross-jump return tails (target.ts `crossJumpsReturnTails`)', () => {
  test.each(LANES)('$tc: the declaration is what its own `pb` copies compile to', ({ tc, file }) => {
    const stores = instructions(file('pb-copies')).filter((l) => TAIL_STORE.test(l)).length;
    // seven `return`s each after its own store, or one store every case reaches
    expect([1, 7]).toContain(stores);
    expect(instructions(file('pb-join')).filter((l) => TAIL_STORE.test(l)).length).toBe(1);
    const declared = TOOLCHAIN_TARGETS[tc].description.compilerBehaviors.crossJumpsReturnTails === true;
    expect(declared).toBe(stores === 1);
  });

  test.each(LANES.filter((l) => l.tc !== 'ido7.1' && l.tc !== 'mwcc_242_81'))(
    '$tc: the merged tail leaves identical case bodies apart, where the join merges them',
    ({ file }) => {
      // the case bodies are the blocks that jump to the tail, plus the one falling into it
      const jumps = (p: Probe) => instructions(file(p)).filter((l) => /^(?:b|j)\s/.test(l)).length;
      expect(jumps('pb-copies')).toBe(5);
      expect(jumps('pb-join')).toBe(2);
    },
  );

  test('agbcc: the `pa` copies keep the tail mid-construct, ending in a jump over the else arm', () => {
    const copies = instructions('agbcc-rettail-pa-copies.s');
    expect(copies.filter((l) => CALL.test(l))).toEqual(['bl\th', 'bl\th']);
    const tail = copies.indexOf('bl\th');
    expect(copies[tail + 1]).toMatch(/^b\s/);
    expect(copies.slice(tail + 2, tail + 5)).toEqual(['mov\tr0, #0x1e', 'mov\tr1, #0x0', 'bl\th']);
    // the join lays its tail out last, falling into the epilogue
    const joined = instructions('agbcc-rettail-pa-join.s');
    expect(joined[joined.lastIndexOf('bl\th') + 1]).toMatch(/^pop\s/);
  });

  test.each(['gcc272', 'gcc272kmc'])('%s: the `pa` copies and join compile to the same instructions', (slug) => {
    expect(instructions(`${slug}-rettail-pa-copies.asm`)).toEqual(instructions(`${slug}-rettail-pa-join.asm`));
  });

  test.each(['ido71', 'mwcc242'])('%s: the `pa` copies keep a call in every arm', (slug) => {
    expect(instructions(`${slug}-rettail-pa-copies.asm`).filter((l) => CALL.test(l))).toHaveLength(3);
  });
});

const PROTOS = {
  pa: { f: { params: 1, returnsVoid: true }, h: { params: 2, returnsVoid: true } },
  pb: { f: { params: 2, returnsVoid: true } },
} as const;
const protosOf = (p: Probe) => PROTOS[p.startsWith('pa') ? 'pa' : 'pb'];
const liftAgbcc = (p: Probe): Fn =>
  frontendFor(ARMV4T_AGBCC).lift('f', fixture(`agbcc-rettail-${p}.s`), ARMV4T_AGBCC, protosOf(p));

describe('the frontend records where each block was laid out (ir/core.ts `AsmLayout`)', () => {
  test('every block of the agbcc `pa` copies lift has its place, its body and its jump', () => {
    const fn = liftAgbcc('pa-copies');
    const layout = fn.blocks.map((b) => fn.asmLayout?.get(b));
    expect(layout.map((at) => at?.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // the surviving tail, its jump over the else arm, and the else arm with its own copy after it
    expect(layout[4]).toEqual({ index: 4, body: ['mov r1,#0x0', 'bl h'], endsInJump: true });
    expect(layout[5]).toEqual({ index: 5, body: ['mov r0,#0x1e', 'mov r1,#0x0', 'bl h'], endsInJump: false });
  });

  test('parsed IR has no layout', () => {
    expect(parse('fn f {\n^bb0():\n  ret\n}\n').asmLayout).toBeUndefined();
  });
});

/** Every site the join run takes on the agbcc lift of `p`, raised as the pipeline raises it. */
function sitesOf(p: Probe): { fn: Fn; sites: JoinPastReturnsSite[] } {
  const fn = liftAgbcc(p);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, protosOf(p).f);
  const sites: JoinPastReturnsSite[] = [];
  structure(fn, structureOptionsFor(ARMV4T_AGBCC, true), { onJoinPastReturns: (site) => sites.push(site) });
  return { fn, sites };
}

describe('the cross-jumped tail, read at each site the join was taken (structure/cross-jumped-tail.ts)', () => {
  test('the hook names each site: the `pa` `if` and the `pb` jump table', () => {
    expect(sitesOf('pa-copies').sites.map((s) => s.kind)).toContain('if');
    expect(sitesOf('pb-copies').sites.map((s) => s.kind)).toEqual(['switch']);
  });
});
