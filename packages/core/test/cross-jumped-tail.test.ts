// A RETURN TAIL THE COMPILER CROSS-JUMPED, read off the asm layout.
//
// Six probe pairs, each compiled by scripts/regen-rettail-probes.ts at every toolchain's canonical
// flags. In each pair the source writes one function twice: the return tail in every arm
// (`-copies`), and the tail written once after the construct (`-join`).
//   - `pa`: a three-arm `if` whose arms call `h(10, 0)`, `h(20, 0)` and `h(30, 0)`, the last arm
//     falling into the function's end.
//   - `pb`: a seven-case `switch` whose cases add 256, 512, 528 ×3, 512 and 256 to `p[3]`.
//   - `pc`: an `if` whose first two arms store one register to two different globals, `gT = c` and
//     `gW = c`, before the tail `gV = a; k(a);`. In a relocatable MIPS object the two stores read the
//     same; only the relocation names the global.
//   - `pd`: an `if` nest with two identical `g(2)` arms before the tail `g(5)`. Written once, agbcc
//     keeps the arms apart, one jumping to the tail and the other falling into it.
//   - `pe`: an `if` chain whose tail `h(30, v); k(v);` agbcc leaves split over two blocks: another
//     arm's `k(v)` enters it part-way, so the `h` call falls into the rest, which jumps.
//   - `pf`: an `if` chain whose tail `h(30, v); gArr[v & 15] = a;` agbcc cuts from the call's
//     argument setup, leaving `mov r0, #0x1e` in each arm.
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

import { parseAsmData } from '../src/frontend/asmdata';
import { frontendFor } from '../src/frontend/registry';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { decompile, raiseRecovered } from '../src/pipeline';
import { crossJumpedTail } from '../src/structure/cross-jumped-tail';
import { type JoinPastReturnsSite, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, PPC_MWCC, TOOLCHAIN_TARGETS, type TargetDescription, structureOptionsFor } from '../src/target';

const CORPUS = join(import.meta.dirname, 'corpus');
const fixture = (file: string) => readFileSync(join(CORPUS, file), 'utf8');
type Probe = `${'pa' | 'pb' | 'pc' | 'pd' | 'pe' | 'pf'}-${'copies' | 'join'}`;

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
  pc: { f: { params: 3, returnsVoid: true }, m: { params: 1, returnsVoid: true }, k: { params: 1, returnsVoid: true } },
  pd: { f: { params: 2, returnsVoid: true }, g: { params: 1, returnsVoid: true } },
  pe: {
    f: { params: 3, returnsVoid: true },
    h: { params: 2, returnsVoid: true },
    k: { params: 1, returnsVoid: true },
    m: { params: 1, returnsVoid: true },
  },
  pf: { f: { params: 3, returnsVoid: true }, h: { params: 2, returnsVoid: true }, k: { params: 1, returnsVoid: true } },
} as const;
const protosOf = (p: Probe) => PROTOS[p.slice(0, 2) as keyof typeof PROTOS];
const liftAgbcc = (p: Probe): Fn =>
  frontendFor(ARMV4T_AGBCC).lift('f', fixture(`agbcc-rettail-${p}.s`), ARMV4T_AGBCC, protosOf(p));

describe('the frontend records where each block was laid out (ir/core.ts `AsmLayout`)', () => {
  test('every block of the agbcc `pa` copies lift has its place, its body and its jump', () => {
    const fn = liftAgbcc('pa-copies');
    const layout = fn.blocks.map((b) => fn.asmLayout?.get(b));
    expect(layout.map((at) => at?.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // the surviving tail, its jump over the else arm, and the else arm with its own copy after it
    expect(layout[4]).toEqual({ index: 4, body: ['mov r1,#0x0', 'bl h'], calls: [1], endsInJump: true });
    expect(layout[5]).toEqual({
      index: 5,
      body: ['mov r0,#0x1e', 'mov r1,#0x0', 'bl h'],
      calls: [2],
      endsInJump: false,
    });
  });

  test.each(GCC_LANES)(
    "$tc: a relocated store's body names its global, so two arms storing to two globals differ",
    ({ tc, slug }) => {
      const fn = liftMips(tc, slug, 'pc-join');
      const bodies = fn.blocks.map((b) => fn.asmLayout?.get(b)?.body.join(' ; ') ?? '');
      // the arms read `lui at,0x0` / `sw a2,0(at)` alike, and only the relocation tells them apart
      expect(bodies.filter((b) => /sw a2,0\(at\)/.test(b))).toEqual([
        expect.stringContaining('sw a2,0(at) <gT>'),
        expect.stringContaining('sw a2,0(at) <gW>'),
      ]);
      // a call names its callee the same way, where `jal 0 <f>` names none
      expect(bodies.some((b) => b.includes('<k>'))).toBe(true);
    },
  );

  test('parsed IR has no layout', () => {
    expect(parse('fn f {\n^bb0():\n  ret\n}\n').asmLayout).toBeUndefined();
  });
});

// The GCC 2.7.2 lanes: a disassembly plus the object's `objdump -s -r -t`, which names the symbol
// behind each relocated load, store and call, as the bench hands it over.
const GCC_LANES = [
  { tc: 'gcc2.7.2', slug: 'gcc272' },
  { tc: 'gcc2.7.2kmc', slug: 'gcc272kmc' },
] as const;
const mipsInput = (slug: string, p: Probe) => {
  const dump = fixture(`${slug}-rettail-${p}.txt`);
  return { asm: fixture(`${slug}-rettail-${p}.asm`), asmData: parseAsmData(dump, dump, dump, true) };
};
const liftMips = (tc: (typeof GCC_LANES)[number]['tc'], slug: string, p: Probe): Fn => {
  const target = TOOLCHAIN_TARGETS[tc].description;
  const { asm, asmData } = mipsInput(slug, p);
  return frontendFor(target).lift('f', asm, target, protosOf(p), asmData);
};

/** Every site the join run takes on the lift of `p`, raised as the pipeline raises it. */
function sitesOf(
  p: Probe,
  target: TargetDescription = ARMV4T_AGBCC,
  lifted?: Fn,
): { fn: Fn; sites: JoinPastReturnsSite[] } {
  const fn = lifted ?? liftAgbcc(p);
  raiseRecovered(fn, target, {}, protosOf(p).f);
  const sites: JoinPastReturnsSite[] = [];
  structure(fn, structureOptionsFor(target, true), { onJoinPastReturns: (site) => sites.push(site) });
  return { fn, sites };
}

describe('the cross-jumped tail, read at each site the join was taken (structure/cross-jumped-tail.ts)', () => {
  test('the hook names each site: the `pa` `if` and the `pb` jump table', () => {
    expect(sitesOf('pa-copies').sites.map((s) => s.kind)).toContain('if');
    expect(sitesOf('pb-copies').sites.map((s) => s.kind)).toEqual(['switch']);
  });

  test.each([
    ['pa-copies', true],
    ['pa-join', false],
    ['pb-copies', true],
    ['pb-join', false],
    ['pc-join', false],
    // the two `g(2)` arms are identical, but only one of them jumps to the tail
    ['pd-join', false],
    // the `h` call falls into the rest of the tail, and that rest jumps over the `gU = b` arm
    ['pe-copies', true],
    // `mov r0, #0x1e` is left in both arms that reach the `bl h` the join starts with
    ['pf-copies', true],
    ['pf-join', false],
  ] as const)('agbcc %s: %s', (p, want) => {
    const { fn, sites } = sitesOf(p);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => crossJumpedTail(fn, s))).toBe(want);
  });

  // `pa` compiles to the same instructions either way on these two, and takes no join past returns.
  test.each(
    GCC_LANES.flatMap(({ tc, slug }) =>
      (
        [
          ['pb-copies', true],
          ['pb-join', false],
          // without the relocation in the body, `gT = c` and `gW = c` would read as identical arms
          ['pc-join', false],
          ['pd-join', false],
        ] as const
      ).map(([p, want]) => ({ tc, slug, p, want })),
    ),
  )('$tc $p: $want', ({ tc, slug, p, want }) => {
    const target = TOOLCHAIN_TARGETS[tc].description;
    const { fn, sites } = sitesOf(p, target, liftMips(tc, slug, p));
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => crossJumpedTail(fn, s))).toBe(want);
  });

  // `if (a) { x(); return; } y(); z();`, the early return with a `ret` of its own. Laid out with the
  // `x` arm after the join `z()`, which ends in a jump to its epilogue: the mark. Laid out with the
  // `x` arm first, the only block of the construct after the join is the early return's bare `ret`,
  // which is laid out last under either spelling: no mark.
  const EPILOGUE = [
    'fn f {',
    '^bb0(%0: s32):',
    '  %1: s32 = const {value=0}',
    '  %2: u32 = icmp_eq %0, %1',
    '  cond_br %2, ^bb1(), ^bb2()',
    '^bb1():',
    '  %3: s32 = call %0 {target="x"}',
    '  br ^bb4()',
    '^bb2():',
    '  %4: s32 = call %0 {target="y"}',
    '  br ^bb3()',
    '^bb3():',
    '  %5: s32 = call %0 {target="z"}',
    '  br ^bb5()',
    '^bb4():',
    '  ret',
    '^bb5():',
    '  ret',
    '}',
    '',
  ].join('\n');
  test('a bare return laid out after the join is no mark, and neither is a missing layout', () => {
    const fn = parse(EPILOGUE);
    const [b0, b1, b2, b3, b4, b5] = fn.blocks;
    const site: JoinPastReturnsSite = { branch: b0, join: b3, kind: 'if' };
    expect(crossJumpedTail(fn, site)).toBe(false); // parsed: no layout at all
    const laidOut = (order: typeof fn.blocks) =>
      new Map(order.map((b, index) => [b, { index, body: [`bl ${index}`], calls: [], endsInJump: b === b3 }]));
    fn.asmLayout = laidOut([b0, b2, b3, b5, b1, b4]);
    expect(crossJumpedTail(fn, site)).toBe(true);
    fn.asmLayout = laidOut([b0, b1, b2, b3, b5, b4]);
    expect(crossJumpedTail(fn, site)).toBe(false);
  });
});

describe('the plain default publishes the copies where the layout shows the merge', () => {
  const reading = (p: Probe, target: TargetDescription, o: object = {}) =>
    decompile('f', fixture(`agbcc-rettail-${p}.s`), target, { prototypes: protosOf(p), ...o }).source;

  test.each(['pa-copies', 'pb-copies'] as const)(
    'agbcc %s: the default is the copies, though the join is shorter',
    (p) => {
      const copies = reading(p, ARMV4T_AGBCC, { copyReturnTails: true });
      const join = reading(p, ARMV4T_AGBCC, { joinPastReturns: true });
      expect(join.split('\n').length).toBeLessThan(copies.split('\n').length);
      expect(reading(p, ARMV4T_AGBCC)).toBe(copies);
    },
  );

  // a tie in size goes to the join, so only the mark publishes these copies
  test.each(['pe-copies', 'pf-copies'] as const)('agbcc %s: the default is the copies, the size a tie', (p) => {
    const copies = reading(p, ARMV4T_AGBCC, { copyReturnTails: true });
    const join = reading(p, ARMV4T_AGBCC, { joinPastReturns: true });
    expect(join).not.toBe(copies);
    expect(join.split('\n').length).toBe(copies.split('\n').length);
    expect(reading(p, ARMV4T_AGBCC)).toBe(copies);
  });

  test.each(['pa-join', 'pb-join', 'pc-join', 'pd-join'] as const)(
    'agbcc %s: no mark, so the size bound keeps the join',
    (p) => {
      expect(reading(p, ARMV4T_AGBCC)).toBe(reading(p, ARMV4T_AGBCC, { joinPastReturns: true }));
    },
  );

  test.each(GCC_LANES)(
    '$tc: the `pb` copies are the default, and every join written once keeps the join',
    ({ tc, slug }) => {
      const target = TOOLCHAIN_TARGETS[tc].description;
      const read = (p: Probe, o: object = {}) => {
        const { asm, asmData } = mipsInput(slug, p);
        return decompile('f', asm, target, { prototypes: protosOf(p), asmData, ...o }).source;
      };
      expect(read('pb-copies')).toBe(read('pb-copies', { copyReturnTails: true }));
      for (const p of ['pb-join', 'pc-join', 'pd-join'] as const) {
        expect(read(p)).toBe(read(p, { joinPastReturns: true }));
      }
    },
  );

  // The same layout on a target that does not declare the merge is no evidence: the bound decides.
  // ido7.1 lays a tail out mid-construct with no cross-jump at all, and mwcc's PPC_MWCC claims none.
  test.each(['pa-copies', 'pb-copies'] as const)('%s on a target claiming no cross-jump: the size bound', (p) => {
    const { crossJumpsReturnTails: _, ...behaviors } = ARMV4T_AGBCC.compilerBehaviors;
    const plain: TargetDescription = { ...ARMV4T_AGBCC, compilerBehaviors: behaviors };
    expect(reading(p, plain)).toBe(reading(p, plain, { joinPastReturns: true }));
  });

  test('mwcc_242_81 `pa` join: the bound reading, unchanged', () => {
    const asm = fixture('mwcc242-rettail-pa-join.asm');
    const read = (o: object) => decompile('f', asm, PPC_MWCC, { prototypes: PROTOS.pa, ...o }).source;
    expect(PPC_MWCC.compilerBehaviors.crossJumpsReturnTails).toBeUndefined();
    expect(read({})).toBe(read({ joinPastReturns: true }));
  });
});
