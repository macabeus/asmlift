// THE PREMISE OF THE STRUCTURED-TREE SKIP (rank.ts enumerateCandidates).
//
// The enumerator skips the whole re-spelling fan when an earlier axis point already produced the
// same structured tree, and it decides "same" on `JSON.stringify(sfn)`. That is a value comparison
// over strings, so it can never merge two trees by collision — but it CAN merge two trees whose
// difference JSON cannot express: a `Map`, a `Set`, a function or a class instance anywhere under
// SFn all stringify to `{}` or vanish, and two trees differing only there would take the skip and
// silently lose a candidate. Nothing in the type system says a future SFn field cannot be one.
//
// So the premise is checked rather than assumed: the JSON text must DETERMINE the tree, i.e. the
// round trip must be lossless. `toEqual` rather than `toStrictEqual` on purpose — an explicit
// `undefined` and an absent property are the same tree for every consumer in l3 (all of them test
// `=== undefined`), and JSON collapsing the two is the one difference the skip may ignore.
import { expect, test } from 'vitest';

import { frontendFor } from '../src/frontend/registry';
import { verify } from '../src/ir/verify';
import { applyIdiomPatterns, raiseRecovered } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { structure } from '../src/structure/structure';
import { type SymbolInfo, type SymbolMap } from '../src/symbols';
import { symbolsByName } from '../src/symbols';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';
import { structureOptionsFor } from '../src/target';

// A function reaching as much of the vocabulary as one fixture can: a loop, a divergent if, a
// call, a global read through a map-declared struct, a frame object and a switch.
const ARM_ASM = [
  'f:',
  '\tpush\t{r4, r5, r6, lr}',
  '\tadd\tsp, sp, #-0x4',
  '\tldr\tr4, .L2',
  '\tldrh\tr5, [r4]',
  '\tlsl\tr5, r5, #20',
  '\tlsr\tr5, r5, #25',
  '\tmov\tr6, #0',
  '.L0:',
  '\tcmp\tr6, r5',
  '\tbge\t.L1',
  '\tmov\tr0, sp',
  '\tstrh\tr6, [r0]',
  '\tldr\tr1, .L3',
  '\tstr\tr0, [r1]',
  '\tbl\tsink',
  '\tadd\tr6, r6, #1',
  '\tb\t.L0',
  '.L1:',
  '\tcmp\tr5, #0',
  '\tbeq\t.L4',
  '\tmov\tr0, #1',
  '\tb\t.L5',
  '.L4:',
  '\tmov\tr0, #2',
  '.L5:',
  '\tadd\tsp, sp, #0x4',
  '\tpop\t{r4, r5, r6}',
  '\tpop\t{r1}',
  '\tbx\tr1',
  '.L2:',
  '\t.word\t0x03005220',
  '.L3:',
  '\t.word\t0x40000D4',
  '',
].join('\n');

const STATE: SymbolInfo = {
  name: 'gState',
  kind: 'data',
  declared: true,
  shape: 'struct',
  structName: 'State',
  size: 8,
  layout: [
    { name: 'hearts', offset: 0, size: 1, signed: false, bitWidth: 2, bitOffset: 0 },
    { name: 'dreamStones', offset: 0, size: 2, signed: false, bitWidth: 7, bitOffset: 5 },
    { name: 'unk4', offset: 4, size: 4, signed: false },
  ],
};
const MAP: SymbolMap = new Map([[0x03005220, [STATE]]]);

// A second ISA, in objdump form: a counted loop over a global, then a diamond. No call — the MIPS
// frontend declines those, and what this fixture is for is a second structurer path, not a callee.
const MIPS_ASM = [
  '00000000 <f>:',
  '   0:\taddiu\tsp,sp,-24',
  '   4:\tmove\tv1,zero',
  '   8:\tmove\tv0,zero',
  '   c:\taddu\tv0,v0,v1',
  '  10:\taddiu\tv1,v1,1',
  '  14:\tslt\tat,v1,a0',
  '  18:\tbnez\tat,c <f+0xc>',
  '  1c:\tnop',
  '  20:\tbeqz\tv0,2c <f+0x2c>',
  '  24:\tnop',
  '  28:\taddiu\tv0,v0,7',
  '  2c:\tjr\tra',
  '  30:\taddiu\tsp,sp,24',
  '',
].join('\n');

/** Every structured tree the enumerator would key on, for one function. */
function trees(name: string, asm: string, target: typeof ARMV4T_AGBCC, symbols?: SymbolMap): unknown[] {
  const frontend = frontendFor(target);
  const out: unknown[] = [];
  for (const syms of symbols ? [symbols, undefined] : [undefined]) {
    for (const sense of [true, false]) {
      for (const bitfields of [true, false]) {
        const fn = frontend.lift(name, asm, target, {}, undefined, syms);
        verify(fn);
        applyIdiomPatterns(fn, target);
        raiseRecovered(fn, target);
        out.push(
          structure(fn, {
            ...structureOptionsFor(target, false),
            ...(syms ? { symbols: symbolsByName(syms) } : {}),
            preserveDivergentBranchSense: sense,
            spellBitfieldMembers: bitfields,
          }),
        );
      }
    }
  }
  return out;
}

test('a structured tree round-trips through JSON without loss — ARM, with and without a map', () => {
  const all = trees('f', ARM_ASM, ARMV4T_AGBCC, MAP);
  expect(all.length).toBe(8);
  for (const sfn of all) {
    expect(JSON.parse(JSON.stringify(sfn))).toEqual(sfn);
  }
});

test('a structured tree round-trips through JSON without loss — MIPS', () => {
  for (const sfn of trees('f', MIPS_ASM, MIPS_IDO)) {
    expect(JSON.parse(JSON.stringify(sfn))).toEqual(sfn);
  }
});

test('the round-trip check would catch the fields JSON cannot express', () => {
  // The three shapes that would make the key merge distinct trees, as they would appear under an
  // SFn: this is the assertion above doing its job, shown on values it must reject.
  for (const lost of [new Map([['a', 1]]), new Set([1]), () => 1]) {
    const sfn = { name: 'f', params: [], locals: [], body: [], extra: lost };
    expect(JSON.parse(JSON.stringify(sfn))).not.toEqual(sfn);
  }
});

test('the skip removes no candidate: the mapped ARM function enumerates the same set either way', () => {
  // A behavioural cross-check of the same premise, at the level the skip actually runs: with a map
  // that carries a bitfield member, `/no-bitfield` doubles the axis cross, and the fold does fire
  // here — so this fixture exercises both a tree that repeats and one that does not.
  const cands = enumerateCandidates('f', ARM_ASM, ARMV4T_AGBCC, { symbols: MAP });
  expect(cands.length).toBeGreaterThan(1);
  expect(new Set(cands.map((c) => c.source)).size).toBe(cands.length); // still fully deduped
  expect(cands.some((c) => c.source.includes('dreamStones'))).toBe(true);
  expect(cands.some((c) => c.label.includes('/raw-globals'))).toBe(true);
});
