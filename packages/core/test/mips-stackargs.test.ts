// O32 INCOMING STACK ARGUMENTS (frontend/mips.ts `emitLoad`, `frameDepths`): argument word k >= 4
// sits at entry sp + 4k, above the caller's 16-byte home of a0..a3, so a word `lw` or `sw` at or
// past entry + 16 is `@sarg<k>`: a parameter, as on Thumb, that a store assigns to. Every other
// never-stored read keeps its refusal, and so does every shape whose depth is not one number.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

const obj = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

const relocs = (rs: [offset: number, type: string, sym: string][]): AsmData => ({
  sections: new Map(),
  relocs: rs.map(([offset, type, sym]) => ({ section: '.text', offset, type, sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

const src = (lines: string[], rs: [number, string, string][] = [], target = MIPS_IDO) =>
  decompile('f', obj(lines), target, { asmData: relocs(rs), prototypes: { k1: { params: 1 } } }).source;
const lift =
  (...args: Parameters<typeof src>) =>
  () =>
    src(...args);

describe('an incoming stack word is a parameter', () => {
  test('frameless: `return e + i` for nine int arguments reads 16(sp) and 32(sp)', () => {
    // in9e at ido7.1 / gcc2.7.2kmc / gcc2.7.2 alike
    expect(src(['0:\tlw\tv0,16(sp)', '4:\tlw\tt6,32(sp)', '8:\tjr\tra', 'c:\taddu\tv0,v0,t6'])).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8) {\n    return a4 + a8;\n}\n',
    );
  });

  test('framed: the pushed size comes off the offset, in every block the push dominates', () => {
    // in9 at gcc2.7.2kmc: `lw s0,40(sp)` is `e` and `lw a0,56(sp)`, past the branch, is `i`
    const out = src(
      [
        '0:\taddiu\tsp,sp,-24',
        '4:\tsw\ts0,16(sp)',
        '8:\tlw\ts0,40(sp)',
        'c:\tmove\tv0,a1',
        '10:\tbeqz\ta0,28 <f+0x28>',
        '14:\tsw\tra,20(sp)',
        '18:\tlw\ta0,56(sp)',
        '1c:\tjal\t0 <f>',
        '20:\tnop',
        '24:\taddu\tv0,v0,s0',
        '28:\tlw\tra,20(sp)',
        '2c:\tlw\ts0,16(sp)',
        '30:\tjr\tra',
        '34:\taddiu\tsp,sp,24',
      ],
      [[0x1c, 'R_MIPS_26', 'k1']],
      MIPS_GCC,
    );
    expect(out).toMatch(/^s32 f\(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8\)/);
    expect(out).toContain('k1(a8) + a4');
  });

  test('a stack parameter this function assigns to on one path is the incoming value on the other', () => {
    // IDO stores an assigned stack parameter back in place (owns2: `if (a) e = b; g1(e);` is
    // `beqz a0; sw a1,40(sp); lw a0,40(sp)`). Load and store are one variable, `@sarg4`, so the
    // read merges the caller's word with the stored one.
    expect(
      src(['0:\tbeqz\ta0,c <f+0xc>', '4:\tnop', '8:\tsw\ta1,16(sp)', 'c:\tlw\tv0,16(sp)', '10:\tjr\tra', '14:\tnop']),
    ).toBe('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    if (a0 != 0) a4 = a1;\n    return a4;\n}\n');
  });

  test('a stack parameter stored at one depth is read back at another as the same word', () => {
    // the entry-relative key, not the raw `sp@<off>`: 16(sp) at entry is 24(sp) under an 8-byte push
    expect(
      src(['0:\tsw\ta1,16(sp)', '4:\taddiu\tsp,sp,-8', '8:\tlw\tv0,24(sp)', 'c:\tjr\tra', '10:\taddiu\tsp,sp,8']),
    ).toBe('s32 f(s32 a0, s32 a1) {\n    return a1;\n}\n');
  });

  test('after the pop the block runs at the entry depth again', () => {
    expect(
      src(['0:\taddiu\tsp,sp,-8', '4:\tsw\ta0,8(sp)', '8:\taddiu\tsp,sp,8', 'c:\tjr\tra', '10:\tlw\tv0,16(sp)']),
    ).toBe('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    return a4;\n}\n');
  });
});

describe('every other never-stored read keeps its refusal', () => {
  const NEVER = /that was never stored/;

  test("a word of the caller's home of a0..a3 is no argument", () => {
    expect(lift(['0:\tlw\tv0,4(sp)', '4:\tjr\tra', '8:\tnop'])).toThrow(NEVER);
  });

  // A word BELOW the pushed size is no argument: it is a word of the frame this leaf owns, and
  // reads as an uninitialised local (mips-uninit.test.ts, `ownedFrame` in frontend/mips.ts).
  test('a word below the pushed size is an uninitialised local, not an argument', () => {
    expect(src(['0:\taddiu\tsp,sp,-24', '4:\tlw\tv0,8(sp)', '8:\tjr\tra', 'c:\taddiu\tsp,sp,24'])).toBe(
      's32 f(void) {\n    s32 uninit_sp8;\n    return uninit_sp8;\n}\n',
    );
  });

  test('a second push leaves the depth unproven', () => {
    expect(
      lift([
        '0:\taddiu\tsp,sp,-8',
        '4:\taddiu\tsp,sp,-8',
        '8:\tlw\tv0,32(sp)',
        'c:\taddiu\tsp,sp,16',
        '10:\tjr\tra',
        '14:\tnop',
      ]),
    ).toThrow(NEVER);
  });

  test('so does a push outside the entry block', () => {
    expect(
      lift([
        '0:\tbeqz\ta0,10 <f+0x10>',
        '4:\tnop',
        '8:\taddiu\tsp,sp,-8',
        'c:\taddiu\tsp,sp,8',
        '10:\tlw\tv0,16(sp)',
        '14:\tjr\tra',
        '18:\tnop',
      ]),
    ).toThrow(NEVER);
  });

  test('so does any other write to sp', () => {
    expect(lift(['0:\tmove\tsp,a1', '4:\tlw\tv0,16(sp)', '8:\tjr\tra', 'c:\tnop'])).toThrow(NEVER);
  });

  test('a sub-word incoming argument is not modelled: `short e` reads lh 18(sp)', () => {
    expect(lift(['0:\tlh\tv0,18(sp)', '4:\tjr\tra', '8:\taddu\tv0,v0,a0'])).toThrow(/stack pointer used as data/);
  });

  test('nor is a float argument beside a stack word', () => {
    expect(lift(['0:\tlw\tt6,16(sp)', '4:\tsw\tt6,0(a0)', '8:\tjr\tra', 'c:\tadd.s\t$f0,$f12,$f12'])).toThrow(
      /floating-point argument beside the incoming stack argument/,
    );
  });
});

// THE LOADED-WORD BOUND AT AN UNDECLARED CALL (`lowerJal` guess, `compilerBehaviors.
// outgoingAreaNeverLoadedFrom`). A guess that fills a0..a3 cannot say where the list ends, so a word
// of the outgoing area that reaches the call refuses — unless the function LOADS a frame word at
// or below it, from 16(sp) up: no O32 compiler loads a word of its outgoing area there, so that
// word and every one above it is a local's. The shape is `bigdead` (`void bigdead(int k, int *p)`
// at -O2: values spilled to the frame, reloaded only inside a loop the first test may skip, then
// `done4(s, k, s + 1, s + 2)`), cut to one spill.
describe('an undeclared call that fills a0..a3 past a frame word the function loads', () => {
  /** One straight-line prologue, a loop the first test may skip, and the call — each line gets the
   *  next address, and the `blez` lands on the `li a2,1` that sets the call up. */
  const shape = (pre: string[], loop: string[]) => {
    const body = [
      'addiu\tsp,sp,-40',
      'sw\tra,36(sp)',
      ...pre,
      'blez\ta0,@CALL',
      'nop',
      ...loop,
      'li\ta2,1',
      'jal\t0 <f>',
      'li\ta3,2',
      'lw\tra,36(sp)',
      'jr\tra',
      'addiu\tsp,sp,40',
    ];
    const call = body.indexOf('li\ta2,1') * 4;
    const jal = body.indexOf('jal\t0 <f>') * 4;
    const lines = body.map(
      (l, i) => `${(i * 4).toString(16)}:\t${l.replace('@CALL', `${call.toString(16)} <f+0x${call.toString(16)}>`)}`,
    );
    return { lines, rs: [[jal, 'R_MIPS_26', 'done4']] as [number, string, string][] };
  };
  const spilled = shape(['sw\ta1,24(sp)'], ['lw\ta1,24(sp)', 'addu\ta0,a0,a1']);

  test.each([MIPS_IDO, MIPS_GCC])('a spill reloaded on one path is a local, not argument 5 ($compiler)', (target) => {
    const out = src(spilled.lines, spilled.rs, target);
    expect(out).toContain('done4(');
    expect(out).not.toMatch(/done4\([^)]*,[^)]*,[^)]*,[^)]*,/);
  });

  test('…and without the premise, the word may be argument 5', () => {
    const weak = {
      ...MIPS_IDO,
      compilerBehaviors: { ...MIPS_IDO.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
    };
    expect(lift(spilled.lines, spilled.rs, weak)).toThrow(
      /the word stored to 24\(sp\) reaches it where an argument past/,
    );
  });

  test('a word staged beneath the bound still refuses: it may be argument 5 (`bigdead8`)', () => {
    const staged = shape(['sw\ta1,24(sp)', 'sw\tt0,16(sp)'], ['lw\ta1,24(sp)', 'addu\ta0,a0,a1']);
    expect(lift(staged.lines, staged.rs)).toThrow(/the word stored to 16\(sp\) reaches it where an argument past/);
  });

  test('a load at another sp depth names other storage: the word staged at 16(sp) may be argument 5', () => {
    // `lw t0,16(sp)` runs before the push, so it reads the caller's frame, not this one's 16(sp)
    const body = [
      'lw\tt0,16(sp)',
      'addiu\tsp,sp,-40',
      'sw\tra,36(sp)',
      'sw\tt0,16(sp)',
      'li\ta0,5',
      'li\ta1,7',
      'li\ta2,1',
      'jal\t0 <f>',
      'li\ta3,2',
      'lw\tra,36(sp)',
      'jr\tra',
      'addiu\tsp,sp,40',
    ];
    const lines = body.map((l, i) => `${(i * 4).toString(16)}:\t${l}`);
    const rs: [number, string, string][] = [[body.indexOf('jal\t0 <f>') * 4, 'R_MIPS_26', 'g5']];
    for (const target of [MIPS_IDO, MIPS_GCC]) {
      expect(lift(lines, rs, target)).toThrow(/the word stored to 16\(sp\) reaches it where an argument past/);
    }
  });

  test("a load in the a0..a3 home proves nothing: ido loads a by-value aggregate's words back there", () => {
    const home = shape(['sw\tt0,16(sp)', 'sw\tt1,4(sp)'], ['lw\ta1,4(sp)', 'addu\ta0,a0,a1']);
    expect(lift(home.lines, home.rs)).toThrow(/the word stored to 16\(sp\) reaches it where an argument past/);
  });
});
