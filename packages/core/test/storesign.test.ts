// raise/storesign.ts: a narrow store's signedness, read off the constant it stores. The table is the
// probe behind `compilerBehaviors.narrowStoreConstantTakesLvalueType`
// (packages/cli/test/matching/narrow-store-constant.test.ts) seen from the reader's side; every
// refusal is a one-fact edit of the accepted lift below.
import { expect, test } from 'vitest';

import { Fn, defOpMap } from '../src/ir/core';
import { applyIdiomPatterns, decompile, liftStamped, raiseRecovered } from '../src/pipeline';
import { seedNarrowStoreSigns, storedConstantSign } from '../src/raise/storesign';
import { MIPS_GCC, TargetDescription } from '../src/target';

test('the register a narrow constant was materialized into says which lvalue type it was converted to', () => {
  // [value, width, sign]
  const table: [number, number, boolean | null][] = [
    [-1, 2, true], // s16 = 0xFFFF → li -1
    [0xffff, 2, false], // u16 = -1 → li 0xffff
    [-1, 1, true], // s8 = -1
    [255, 1, false], // u8 = -1
    [-32768, 2, true], // s16 = -32768
    [32768, 2, false], // u16 = -32768 → li 0x8000
    [0xffffffff, 2, true], // the same register as -1, spelled unsigned
    [0x7fff, 2, null], // bit 15 clear: both types materialize it alike
    [1, 1, null],
    [0, 2, null],
    [0x1ffff, 2, null], // no conversion to a narrow type leaves bit 16 set over bit 15
    [0xff80, 1, null], // nor 0xff80 for a byte: neither extension of 0x80
    [-1, 4, null], // a word store has nothing above its width
    [-1, 8, null],
    [2 ** 32, 2, null],
    [0.5, 2, null],
  ];
  for (const [value, width, sign] of table) {
    expect([value, width, storedConstantSign(value, width)]).toEqual([value, width, sign]);
  }
});

const obj = (...lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

/** Lift and raise through every pre-recovery pass (storesign is the last), then read each store's
 *  stamp in program order. */
const stamps = (asm: string, target: TargetDescription = MIPS_GCC) => {
  const fn: Fn = liftStamped('f', asm, target, {}, undefined, undefined);
  applyIdiomPatterns(fn, target);
  raiseRecovered(fn, target);
  return fn.blocks.flatMap((b) => b.ops.filter((o) => o.opcode === 'store').map((o) => o.attrs.signed));
};

// `s16 *p; p[6] = 0xFFFF; u16 *q; q[1] = -1;` as gcc2.7.2 leaves it
const PAIR = obj('0:\tli\tv0,-1', '4:\tsh\tv0,12(a0)', '8:\tli\tv0,0xffff', 'c:\tjr\tra', '10:\tsh\tv0,2(a1)');

test('each narrow store of a constant is stamped with the signedness its materialization shows', () => {
  expect(stamps(PAIR)).toEqual([true, false]);
});

test('refusals: a target without the behavior, bit w-1 clear, a word store, a stored register', () => {
  const without: TargetDescription = {
    ...MIPS_GCC,
    compilerBehaviors: { ...MIPS_GCC.compilerBehaviors, narrowStoreConstantTakesLvalueType: undefined },
  };
  expect(stamps(PAIR, without)).toEqual([undefined, undefined]);
  expect(stamps(obj('0:\tli\tv0,32767', '4:\tjr\tra', '8:\tsh\tv0,12(a0)'))).toEqual([undefined]);
  expect(stamps(obj('0:\tli\tv0,-1', '4:\tjr\tra', '8:\tsw\tv0,12(a0)'))).toEqual([undefined]);
  expect(stamps(obj('0:\tjr\tra', '4:\tsh\ta1,12(a0)'))).toEqual([undefined]);
});

test('a store that already carries a signedness keeps it, and the pass reports only what it stamped', () => {
  const fn = liftStamped('f', PAIR, MIPS_GCC, {}, undefined, undefined);
  const first = fn.blocks[0].ops.find((o) => o.opcode === 'store')!;
  first.attrs.signed = false;
  expect(seedNarrowStoreSigns(fn, MIPS_GCC)).toBe(1);
  expect(first.attrs.signed).toBe(false);
  // nothing else moved: the stored values are the same consts
  const defs = defOpMap(fn);
  const values = fn.blocks[0].ops.filter((o) => o.opcode === 'store').map((o) => defs.get(o.operands[1])!.attrs.value);
  expect(values).toEqual([-1, 0xffff]);
});

// `*q = p[6]; p[6] = <k>;` with `p` typed by its sign-extending read: the store spells through the
// same `s16 *` when its constant says signed, and keeps the cast to the unsigned view otherwise
const copyThenStore = (k: string) =>
  decompile(
    'f',
    obj('0:\tlh\tv0,12(a0)', '4:\tsh\tv0,0(a1)', `8:\tli\tv0,${k}`, 'c:\tjr\tra', '10:\tsh\tv0,12(a0)'),
    MIPS_GCC,
    { prototypes: { f: { params: ['s16 *', 's16 *'], returnsVoid: true } } },
  ).source;

test('the structurer spells a stamped store through the view its constant witnessed', () => {
  expect(copyThenStore('-1')).toContain('    a0[6] = -1;\n');
  expect(copyThenStore('0xffff')).toContain('    ((u16 *)a0)[6] = 65535;\n');
});

// A struct recovered from stores alone (raise/structs.ts): the halfword at 6 is never loaded, so its
// declared type is whatever its stamped stores agree on, else the unsigned view.
const storedStruct = (...sixes: string[]) =>
  decompile(
    'f',
    obj(
      '0:\tsh\tzero,4(a0)',
      ...sixes.flatMap((k, i) => [
        `${(4 + 8 * i).toString(16)}:\tli\tv0,${k}`,
        `${(8 + 8 * i).toString(16)}:\tsh\tv0,6(a0)`,
      ]),
      `${(4 + 8 * sixes.length).toString(16)}:\tjr\tra`,
      `${(8 + 8 * sixes.length).toString(16)}:\tsw\tzero,12(a0)`,
    ),
    MIPS_GCC,
    { prototypes: { f: { params: ['void *'], returnsVoid: true } } },
  ).source;

test('a field only ever stored declares the view its stamped stores agree on', () => {
  expect(storedStruct('-104')).toContain(' s16 field_6;');
  expect(storedStruct('-104')).toContain('    a0->field_6 = -104;\n');
  expect(storedStruct('0xff98')).toContain(' u16 field_6;');
  // no stamp (bit 15 clear): the unsigned view; two stamps that disagree: the signed one, as two
  // loads that disagree would
  expect(storedStruct('104')).toContain(' u16 field_6;');
  expect(storedStruct('-104', '0xff98')).toContain(' s16 field_6;');
});

test("a load's signedness wins over a stamped store's at the same field", () => {
  const src = (load: string) =>
    decompile(
      'f',
      obj(
        `0:\t${load}\tv1,6(a0)`,
        '4:\tli\tv0,-104',
        '8:\tsh\tv0,6(a0)',
        'c:\tsw\tzero,12(a0)',
        '10:\tjr\tra',
        '14:\tsh\tv1,0(a1)',
      ),
      MIPS_GCC,
      { prototypes: { f: { params: ['void *', 'u16 *'], returnsVoid: true } } },
    ).source;
  expect(src('lhu')).toContain(' u16 field_6;');
  expect(src('lh')).toContain(' s16 field_6;');
});
