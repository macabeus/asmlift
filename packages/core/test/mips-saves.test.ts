// The MIPS frame's SAVES (frontend/mips.ts): a word store of `ra`, or of a register the O32 callee
// must preserve, while it still holds what the caller left there. The word holds the caller's
// value, which no C value names, so the store mints no parameter, the reload into the same
// register writes nothing a read may use, and every other use of the word refuses.
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (...lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

const src = (...lines: string[]) => decompile('f', obj(...lines), MIPS_IDO).source;
const lift =
  (...lines: string[]) =>
  () =>
    src(...lines);

test('a saved s0 is no parameter: `f(a) { s = a + 1; return s + s; }` takes one argument', () => {
  expect(
    src(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\taddiu\ts0,a0,1',
      'c:\taddu\tv0,s0,s0',
      '10:\tlw\ts0,4(sp)',
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,8',
    ),
  ).toMatch(/^s32 f\(s32 a0\) \{/);
});

test('a saved ra is no parameter either', () => {
  expect(
    decompile(
      'f',
      obj(
        '0:\taddiu\tsp,sp,-24',
        '4:\tsw\tra,20(sp)',
        '8:\taddiu\tv0,a0,1',
        'c:\tlw\tra,20(sp)',
        '10:\tjr\tra',
        '14:\taddiu\tsp,sp,24',
      ),
      MIPS_GCC,
    ).source,
  ).toMatch(/^s32 f\(s32 a0\) \{/);
});

test('a read of the register its restore wrote refuses: it holds the caller s0', () => {
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\taddiu\ts0,a0,1',
      'c:\tsw\ts0,0(a1)',
      '10:\tlw\ts0,4(sp)',
      '14:\taddu\tv0,s0,s0',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/s0 is read after the 'lw' at 0x10 restores the caller's s0 into it/);
});

test('a restored value that reaches a merge someone reads refuses at the end of the lift', () => {
  // The read at the join resolves to the block parameter, not to the restore, so only the check of
  // the finished function sees the caller's s0 flowing into it. (No path writes s0: a write the
  // taken edge carries past the restore would refuse first, as a write the caller sees.)
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\tbeqz\ta0,18 <f+0x18>',
      'c:\tnop',
      '10:\tlw\ts0,4(sp)',
      '14:\tnop',
      '18:\tmove\tv0,s0',
      '1c:\tjr\tra',
      '20:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/the caller's s0, which the 'lw' at 0x10 restores, reaches a value this function computes with/);
});

test('a save slot reloaded into another register refuses', () => {
  expect(
    lift('0:\taddiu\tsp,sp,-8', '4:\tsw\ts0,4(sp)', '8:\tlw\tv0,4(sp)', 'c:\tjr\tra', '10:\taddiu\tsp,sp,8'),
  ).toThrow(/reload of '4\(sp\)' into v0, a slot s0 was saved into/);
});

test('a value stored into a save slot refuses: the word is one kind for the whole function', () => {
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,4(sp)',
      '8:\tsw\ta0,4(sp)',
      'c:\tlw\tv0,4(sp)',
      '10:\tjr\tra',
      '14:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/'4\(sp\)' at 0x8 is a word this function both saves a register in and stores a value to/);
});

test('a save into a slot an earlier block stored a value to refuses the same way', () => {
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\tbeqz\ta0,10 <f+0x10>',
      '8:\tsw\ta1,4(sp)',
      'c:\tsw\ts0,4(sp)',
      '10:\tlw\ts0,4(sp)',
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/'4\(sp\)' at 0xc is a word this function both saves a register in and stores a value to/);
});

test('a callee-saved register stored after it was written is a value, reloaded like any spill', () => {
  // …so the store is no save, and the write it follows is one the caller sees: s0 leaves the
  // function changed, which no C local spells
  expect(
    lift(
      '0:\taddiu\tsp,sp,-8',
      '4:\taddiu\ts0,a0,1',
      '8:\tsw\ts0,4(sp)',
      'c:\tlw\tv0,4(sp)',
      '10:\tjr\tra',
      '14:\taddiu\tsp,sp,8',
    ),
  ).toThrow(/it writes callee-saved s0, and no store in its entry block saves s0/);
  // saved first, the same value is an ordinary spill
  expect(
    src(
      '0:\taddiu\tsp,sp,-8',
      '4:\tsw\ts0,0(sp)',
      '8:\taddiu\ts0,a0,1',
      'c:\tsw\ts0,4(sp)',
      '10:\tlw\tv0,4(sp)',
      '14:\tlw\ts0,0(sp)',
      '18:\tjr\tra',
      '1c:\taddiu\tsp,sp,8',
    ),
  ).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
});

test('a caller-saved t-register stored with nothing in it is no save, so reloading it elsewhere is no save refusal', () => {
  // `t0` is not one the callee preserves, so the store says nothing about the caller: the word is
  // an ordinary value slot, and a save's cross-register refusal would be the wrong reading of it.
  // What does refuse is the value: a t0 entry value no definition meets at a join is an input
  // (MIPS_IDO `hiddenInputRegs`).
  expect(
    lift('0:\taddiu\tsp,sp,-8', '4:\tsw\tt0,4(sp)', '8:\tlw\tv0,4(sp)', 'c:\tjr\tra', '10:\taddiu\tsp,sp,8'),
  ).toThrow(/t0 is read before anything writes it, and no join meets it with a definition of its own/);
});

// $30 is `s8` and `fp` both: saved under one name and used under the other, it is still saved. Read
// as two registers, the body's write would go to a global register variable the epilogue undoes
// (`greg_r30 = a0 + 1`), and on IDO, which can spell none, the lift would refuse a function it reads
// right.
test('one register spelt `s8` and `fp` in one function is one saved register', () => {
  for (const [save, use] of [
    ['s8', 'fp'],
    ['fp', 's8'],
  ]) {
    const lines = [
      '0:\taddiu\tsp,sp,-8',
      `4:\tsw\t${save},0(sp)`,
      `8:\taddiu\t${use},a0,1`,
      `c:\tmove\tv0,${use}`,
      `10:\tlw\t${save},0(sp)`,
      '14:\tjr\tra',
      '18:\taddiu\tsp,sp,8',
    ];
    for (const target of [MIPS_GCC, MIPS_IDO]) {
      expect(decompile('f', obj(...lines), target).source).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
    }
  }
});

// A file-scope global register variable passed as an outgoing stack argument is STORED, never saved:
// gcc 2.7.2 and KMC, `register int g __asm__("$16"); int k(int,int,int,int,int);`, put the store in
// the entry block. Read as s0's save, the fifth argument would vanish from the call — `int se(void){
// return k(1,2,3,4,g) + g; }` would lift `k(1, 2, 3, 4) + uninit_s0`, and `void sf(int a){ g = a;
// k(1,2,3,4,g); }` `greg_r16 = a0; k(1, 2, 3, 4)`. The word is a value, so the call either
// takes it (declared) or refuses (undeclared).
test('a global register variable stored as a stack argument is that argument, not a save', () => {
  const se = [
    '0:\taddiu\tsp,sp,-32',
    '4:\tli\ta0,1',
    '8:\tli\ta1,2',
    'c:\tli\ta2,3',
    '10:\tli\ta3,4',
    '14:\tsw\tra,24(sp)',
    '18:\tjal\t0 <f>',
    '1c:\tsw\ts0,16(sp)',
    '20:\tlw\tra,24(sp)',
    '24:\taddu\tv0,v0,s0',
    '28:\tjr\tra',
    '2c:\taddiu\tsp,sp,32',
  ];
  const sf = [
    '0:\taddiu\tsp,sp,-32',
    '4:\tmove\ts0,a0',
    '8:\tli\ta0,1',
    'c:\tli\ta1,2',
    '10:\tli\ta2,3',
    '14:\tli\ta3,4',
    '18:\tsw\tra,24(sp)',
    '1c:\tjal\t0 <f>',
    '20:\tsw\ts0,16(sp)',
    '24:\tlw\tra,24(sp)',
    '28:\tjr\tra',
    '2c:\taddiu\tsp,sp,32',
  ];
  const call = (at: number): AsmData => ({
    sections: new Map(),
    relocs: [{ section: '.text', offset: at, type: 'R_MIPS_26', sym: 'k', addend: 0 }],
    symbols: new Map(),
    symbolCount: 0,
    bigEndian: true,
  });
  const k5 = { prototypes: { k: { params: 5 } } };
  expect(decompile('f', obj(...se), MIPS_GCC, { ...k5, asmData: call(0x18) }).source).toBe(
    's32 f(void) {\n    return k(1, 2, 3, 4, greg_r16) + greg_r16;\n}\n',
  );
  expect(decompile('f', obj(...sf), MIPS_GCC, { ...k5, asmData: call(0x1c) }).source).toBe(
    's32 f(s32 a0) {\n    greg_r16 = a0;\n    return k(1, 2, 3, 4, greg_r16);\n}\n',
  );
  for (const [body, at] of [
    [se, 0x18],
    [sf, 0x1c],
  ] as const) {
    expect(() => decompile('f', obj(...body), MIPS_GCC, { asmData: call(at) })).toThrow(
      /outgoing stack arguments not modelled — the undeclared call to 'k' at 0x1[8c] fills a0..a3, and the word stored to 16\(sp\)/,
    );
  }
});

// A SAVE HOLDS ONLY WHILE EVERY PATH RESTORES IT AFTER ITS LAST WRITE (`refuseSavedRegisterLeaks`).
// Each of these leaves the caller's s0 changed, which the C — s0 a local — never says: a write past
// the restore would lift `void f(s32 a0) { return; }`, and a reload from a word that is not the
// save `return;` as well. Hand-written shapes: compiled code restores in its epilogue, after every write.
test('a write to a saved register that reaches a return with no restore after it refuses', () => {
  const leak = /the write to saved s0 at 0x(c|10) reaches a return with no restore of s0 after it/;
  for (const target of [MIPS_GCC, MIPS_IDO]) {
    const at =
      (...lines: string[]) =>
      () =>
        decompile('f', obj(...lines), target).source;
    // written again past the restore
    expect(
      at(
        '0:\taddiu\tsp,sp,-8',
        '4:\tsw\ts0,4(sp)',
        '8:\taddiu\ts0,a0,1',
        'c:\tlw\ts0,4(sp)',
        '10:\tmove\ts0,a0',
        '14:\tjr\tra',
        '18:\taddiu\tsp,sp,8',
      ),
    ).toThrow(leak);
    // "restored" from a word that holds the body's value, not the caller's
    expect(
      at(
        '0:\taddiu\tsp,sp,-8',
        '4:\tsw\ts0,4(sp)',
        '8:\taddiu\ts0,a0,1',
        'c:\tsw\ts0,0(sp)',
        '10:\tlw\ts0,0(sp)',
        '14:\tjr\tra',
        '18:\taddiu\tsp,sp,8',
      ),
    ).toThrow(leak);
    // a path that skips the restore after writing
    expect(
      at(
        '0:\taddiu\tsp,sp,-8',
        '4:\tsw\ts0,4(sp)',
        '8:\taddiu\ts0,a0,1',
        'c:\tbnez\ta0,1c <f+0x1c>',
        '10:\tmove\tv0,s0',
        '14:\tlw\ts0,4(sp)',
        '18:\tmove\tv0,zero',
        '1c:\tjr\tra',
        '20:\taddiu\tsp,sp,8',
      ),
    ).toThrow(/the write to saved s0 at 0x8 reaches a return/);
    // a path that never writes s0 needs no restore
    expect(
      at(
        '0:\taddiu\tsp,sp,-8',
        '4:\tsw\ts0,4(sp)',
        '8:\tbeqz\ta0,1c <f+0x1c>',
        'c:\tmove\tv0,zero',
        '10:\taddiu\ts0,a0,1',
        '14:\taddu\tv0,s0,s0',
        '18:\tlw\ts0,4(sp)',
        '1c:\tjr\tra',
        '20:\taddiu\tsp,sp,8',
      )(),
    ).toMatch(/^s32 f\(s32 a0\) \{/);
  }
});
