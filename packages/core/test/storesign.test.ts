// raise/storesign.ts: a narrow store's signedness, read off the constant it stores. The table is the
// probe behind `compilerBehaviors.narrowStoreConstantTakesLvalueType`
// (packages/cli/test/matching/narrow-store-constant.test.ts) seen from the reader's side.
import { expect, test } from 'vitest';

import { Fn, defOpMap } from '../src/ir/core';
import type { AsmData } from '../src/frontend/asmdata';
import { applyIdiomPatterns, decompile, liftStamped, raiseRecovered } from '../src/pipeline';
import { seedNarrowStoreSigns, storedConstantSign } from '../src/raise/storesign';
import { bareGlobalAccessFacts } from '../src/rank-declare';
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

/** Lift and raise through every pre-recovery pass, then read each const-offset store's
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

test('refusals: a constant a wider use reads too, or whose value is stored at another width', () => {
  // `s32 v = -1; *q = v; p[1] = v;` with `u16 *p`: gcc shares the register with the word store, ido
  // rematerializes it; either way the register says the variable's sign, not the lvalue's
  expect(stamps(obj('0:\tli\tv0,-1', '4:\tsw\tv0,0(a1)', '8:\tjr\tra', 'c:\tsh\tv0,2(a0)'))).toEqual([
    undefined,
    undefined,
  ]);
  expect(stamps(obj('0:\tli\tt6,-1', '4:\tsw\tt6,0(a1)', '8:\tli\tt7,-1', 'c:\tjr\tra', '10:\tsh\tt7,2(a0)'))).toEqual([
    undefined,
    undefined,
  ]);
  // the same -1 stored as a byte and a half
  expect(stamps(obj('0:\tli\tv0,-1', '4:\tsb\tv0,1(a0)', '8:\tjr\tra', 'c:\tsh\tv0,2(a1)'))).toEqual([
    undefined,
    undefined,
  ]);
  // …but not the return register a `ret` reads before the return type is known
  expect(stamps(obj('0:\tli\tv0,-1', '4:\tjr\tra', '8:\tsh\tv0,12(a0)'))).toEqual([true]);
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

test("a constant both views store alike is spelled through its base's own view, with no cast", () => {
  const src = decompile(
    'f',
    obj('0:\tli\tv0,-1', '4:\tsh\tv0,6(a0)', '8:\tli\tv0,7', 'c:\tjr\tra', '10:\tsh\tv0,10(a0)'),
    MIPS_GCC,
    { prototypes: { f: { params: ['void *'], returnsVoid: true } } },
  ).source;
  expect(src).toContain('void f(s16 *a0) {\n    a0[3] = -1;\n    a0[5] = 7;\n');
});

// A map-less bare global (rank-declare.ts): `gS = v` has no cast to carry the stamp, so the
// declaration the ranked run synthesizes is where the stored constant's view is written.
const globalFacts = (...lines: [string, string][]) => {
  const asmData: AsmData = {
    sections: new Map(),
    relocs: lines.flatMap(([, sym], i) =>
      sym ? [{ section: '.text', offset: 4 * i, type: i === 0 ? 'R_MIPS_HI16' : 'R_MIPS_LO16', sym, addend: 0 }] : [],
    ),
    symbols: new Map(),
    symbolCount: 0,
    bigEndian: true,
  };
  const fn: Fn = liftStamped(
    'f',
    obj(...lines.map(([l], i) => `${(4 * i).toString(16)}:\t${l}`)),
    MIPS_GCC,
    { f: { params: ['void *'], returnsVoid: true } },
    asmData,
    undefined,
  );
  applyIdiomPatterns(fn, MIPS_GCC);
  raiseRecovered(fn, MIPS_GCC);
  return Object.fromEntries(bareGlobalAccessFacts(fn));
};

test('a bare global only ever stored is declared at the view its stamped store reads', () => {
  // `extern s16 gS; gS = -1;` → `li v0,-1; lui at,%hi(gS); jr ra; sh v0,%lo(gS)(at)`
  const store = (k: string) =>
    globalFacts(['lui\tat,0x0', 'gS'], [`li\tv0,${k}`, ''], ['jr\tra', ''], ['sh\tv0,0(at)', 'gS']);
  expect(store('-1')).toEqual({ gS: { width: 2, signed: true } });
  expect(store('0xffff')).toEqual({ gS: { width: 2, signed: false } });
  expect(store('7')).toEqual({ gS: { width: 2, signed: false } }); // no stamp: the unsigned default
  // a load still decides: `u16` read, then stored -1 (a register that is not the load's)
  expect(
    globalFacts(
      ['lui\tat,0x0', 'gS'],
      ['lhu\tv1,0(at)', 'gS'],
      ['li\tv0,-1', ''],
      ['sw\tv1,0(a0)', ''],
      ['jr\tra', ''],
      ['sh\tv0,0(at)', 'gS'],
    ).gS,
  ).toEqual({ width: 2, signed: false });
});

test('an indexed store carries its stamp into the astore', () => {
  const src = decompile(
    'f',
    obj('0:\tsll\ta1,a1,0x1', '4:\taddu\ta1,a1,a0', '8:\tli\tv0,-1', 'c:\tjr\tra', '10:\tsh\tv0,0(a1)'),
    MIPS_GCC,
    { prototypes: { f: { params: ['void *', 's32'], returnsVoid: true } } },
  ).source;
  expect(src).toContain('void f(s16 *a0, s32 a1) {\n    a0[a1] = -1;\n');
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
  // loads that disagree would, and the other store is spelled through a cast to the view it read
  expect(storedStruct('104')).toContain(' u16 field_6;');
  expect(storedStruct('-104', '0xff98')).toContain(' s16 field_6;');
  expect(storedStruct('-104', '0xff98')).toContain('    a0->field_6 = -104;\n    ((u16 *)a0)[3] = 65432;\n');
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
  // the field keeps its load's type, and the stamped store is spelled through the signed cell
  expect(src('lhu')).toContain('    ((s16 *)a0)[3] = -104;\n');
  expect(src('lh')).toContain('    a0->field_6 = -104;\n');
});

// `p->u.h = -1; p->u.b[1] = 3; if (c) *(u16 *)&p->u = 0x8000;` as gcc2.7.2 leaves it: the last
// constant reaches the join `jr ra` reads v0 at
const JOIN = ['0:\tli\tv0,-1', '4:\tsh\tv0,4(a0)', '8:\tli\tv0,3', 'c:\tbeqz\ta1,1c <f+0x1c>', '10:\tsb\tv0,5(a0)'];

test('a constant that reaches a join only the return reads is stamped, as one the `ret` reads is', () => {
  expect(stamps(obj(...JOIN, '14:\tli\tv0,0x8000', '18:\tsh\tv0,4(a0)', '1c:\tjr\tra', '20:\tnop'))).toEqual([
    true,
    undefined,
    false,
  ]);
  // …and not when anything else reads the join: the word store reads the value the half stored
  expect(
    stamps(obj(...JOIN, '14:\tli\tv0,0x8000', '18:\tsh\tv0,4(a0)', '1c:\tsw\tv0,0(a2)', '20:\tjr\tra', '24:\tnop')),
  ).toEqual([true, undefined, undefined, undefined]);
});

test("a union member's view one stamp declared is not spelled for a store the other stamp read", () => {
  const src = decompile(
    'f',
    obj(...JOIN, '14:\tli\tv0,0x8000', '18:\tsh\tv0,4(a0)', '1c:\tjr\tra', '20:\tnop'),
    MIPS_GCC,
    { prototypes: { f: { params: ['void *', 's32'], returnsVoid: true } } },
  ).source;
  expect(src).toContain('union { s16 half; u8 byte[2]; } field_4;');
  expect(src).toContain('    a0->field_4.half = -1;\n');
  expect(src).toContain('((u16 *)a0)[2] = 32768;');
});

test("a struct-array element's field its load declared is not spelled for a store the other stamp read", () => {
  // `*q = (u16)p[i].h; p[i].h = -104; p[i].c = 0;` over `struct { u16 a; s16 h; s32 c; } *p`
  const src = decompile(
    'f',
    obj(
      '0:\tsll\ta1,a1,0x3',
      '4:\taddu\ta1,a1,a0',
      '8:\tlhu\tv0,2(a1)',
      'c:\tsh\tv0,0(a2)',
      '10:\tli\tv0,-104',
      '14:\tsh\tv0,2(a1)',
      '18:\tjr\tra',
      '1c:\tsw\tzero,4(a1)',
    ),
    MIPS_GCC,
    { prototypes: { f: { params: ['void *', 's32', 'void *'], returnsVoid: true } } },
  ).source;
  expect(src).toContain(' u16 field_2;');
  expect(src).toContain('    ((s16 *)(a0 + a1))[1] = -104;\n');
  expect(src).toContain('    a0[a1].field_4 = 0;\n');
});
