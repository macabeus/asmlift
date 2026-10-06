// A `/raw-globals` LIFT THAT DECLINES COSTS THAT VARIATION, NEVER THE ROW. The map-less sibling of
// a map-ful row is one spelling among the fan, and it can meet a gap the map answers: here a DMA
// source whose control halfword is stored through `gNamed + 4`, which the map places in IWRAM and
// which, unplaced, may BE the control halfword, so the read is unbounded and the local area is kept
// as one object — where the spilled `&s` at [sp,#0xc] is a store of the address into it, a writer.
// Hand-written in agbcc's idiom: `five(1,2,3,4,5); s.a = x; s.b = y; p = &s; REG_DMA3SAD = p;
// REG_DMA3DAD = gDst; REG_DMA3CNT = 0x85000001; gNamed.g = y; return p->a;`, with `p` in a stack
// slot — the shape sa3's ProcessOamBuffers has.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

const ASM =
  't:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n' +
  '\tmov\tr0, #0x5\n\tstr\tr0, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n' +
  '\tbl\tfive\n\tstr\tr4, [sp, #0x4]\n\tstr\tr5, [sp, #0x8]\n\tadd\tr1, sp, #0x4\n\tstr\tr1, [sp, #0xc]\n' +
  '\tldr\tr0, .L6\n\tstr\tr1, [r0]\n\tldr\tr1, .L6+0x4\n\tldr\tr0, .L6+0x8\n\tstr\tr0, [r1]\n\tadd\tr1, r1, #0x4\n' +
  '\tldr\tr0, .L6+0xc\n\tstr\tr0, [r1]\n\tldr\tr0, .L6+0x10\n\tstr\tr5, [r0, #0x4]\n' +
  '\tldr\tr1, [sp, #0xc]\n\tldr\tr0, [r1]\n' +
  '\tadd\tsp, sp, #0x10\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n.L7:\n\t.align\t2, 0\n.L6:\n' +
  '\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t-0x7affffff\n\t.word\tgNamed\n';
const five = { prototypes: { five: { params: 5, returnsVoid: true } } };
const symbols = new Map([
  [0x03000000, [{ name: 'gNamed', kind: 'data' as const }]],
  [0x03000100, [{ name: 'gDst', kind: 'data' as const }]],
]);
const DECLINE =
  /kept as one object cannot hold every writer — the captured address at \[sp,#4\): the address is published rather than passed as an argument/;

test('the map-less lift declining drops `/raw-globals` and keeps the mapped candidates', () => {
  // CONTROL: the two lifts disagree — the map places `gNamed`, and without it the lift declines
  expect(decompile('t', ASM, ARMV4T_AGBCC, { ...five, symbols }).source).toContain('volatile s32 sp4;');
  expect(() => decompile('t', ASM, ARMV4T_AGBCC, five)).toThrow(DECLINE);

  const dropped: string[] = [];
  const cands = enumerateCandidates('t', ASM, ARMV4T_AGBCC, {
    ...five,
    symbols,
    onEnumerationError: (variations, error) => dropped.push(`${variations.join('/')}: ${error}`),
  });
  expect(cands.length).toBeGreaterThan(0);
  expect(cands.some((c) => hasVariation(c.variations, 'raw-globals'))).toBe(false);
  // …and the drop is REPORTED on the channel every dropped variation uses
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toMatch(/^raw-globals: /);
  expect(dropped[0]).toMatch(DECLINE);
});

test('a map-less row has no sibling to drop: its own lift declining still aborts the enumeration', () => {
  expect(() => enumerateCandidates('t', ASM, ARMV4T_AGBCC, five)).toThrow(DECLINE);
});
