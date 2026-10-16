// EVERY MIPS `jr ra` JUMPS TO THE CALLER'S RETURN ADDRESS, or the lift declines
// (`refuseReturnsNotThroughCallersRa`, frontend/mips.ts). `jr ra` is a return by its operand alone,
// so a function that wrote anything else into `ra` first — hand-written asm; no compiler emits it —
// lifted as a C `return` that jumps somewhere else. Each shape below lifted wrong C on all three
// MIPS toolchains before the proof (`move ra,a1; jr ra; li v0,7` was `return 7;`).
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { type ToolchainId, canonicalFlagsOf, targetFor } from '../src/target';

const TOOLCHAINS: ToolchainId[] = ['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'];

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

/** `.text` relocation records naming each `jal`'s callee. */
const relocs = (rs: [offset: number, sym: string][]): AsmData => ({
  sections: new Map(),
  relocs: rs.map(([offset, sym]) => ({ section: '.text', offset, type: 'R_MIPS_26', sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
});

const NOT_THROUGH_RA = /the 'jr ra' at 0x\w+ may not return through the caller's return address/;

describe.each(TOOLCHAINS)('on %s', (tc) => {
  const { target } = targetFor(tc, canonicalFlagsOf(tc)!);
  const src = (lines: string[], calls: [number, string][] = []) =>
    decompile('f', obj(lines), target, { asmData: relocs(calls) }).source;

  test('a return through a register that is not the return address declines', () => {
    // `retjr`: an argument moved into ra
    expect(() => src(['0:\tmove\tra,a1', '4:\tjr\tra', '8:\tli\tv0,7'])).toThrow(
      /the 'jr ra' at 0x4 may not return through the caller's return address — on some path the 'move' at 0x0 wrote ra/,
    );
    // `m_loadra`: a word loaded from memory
    expect(() => src(['0:\tlw\tra,0(a0)', '4:\tnop', '8:\tjr\tra', 'c:\tli\tv0,7'])).toThrow(NOT_THROUGH_RA);
    // `m_skipret`: the return address moved on two words — returns past the caller's delay slot
    expect(() => src(['0:\taddiu\tra,ra,8', '4:\tjr\tra', '8:\tli\tv0,7'])).toThrow(NOT_THROUGH_RA);
    // `m_luira`
    expect(() => src(['0:\tlui\tra,0x8000', '4:\tjr\tra', '8:\tli\tv0,7'])).toThrow(NOT_THROUGH_RA);
  });

  test('a write to ra on one path only declines at the join', () => {
    // `m_condra`
    expect(() => src(['0:\tbeqz\ta0,c <f+0xc>', '4:\tnop', '8:\tmove\tra,a1', 'c:\tjr\tra', '10:\tli\tv0,7'])).toThrow(
      /the 'jr ra' at 0xc may not return through the caller's return address — on some path the 'move' at 0x8/,
    );
  });

  test('a call whose ra nothing reloaded declines', () => {
    // `m_leafjal2`: a frame, a call, no save — lifted `return ext() + 1;`
    expect(() =>
      src(
        [
          '0:\taddiu\tsp,sp,-24',
          '4:\tjal\t0 <f>',
          '8:\tnop',
          'c:\taddiu\tsp,sp,24',
          '10:\tjr\tra',
          '14:\taddiu\tv0,v0,1',
        ],
        [[4, 'ext']],
      ),
    ).toThrow(/the 'jr ra' at 0x10 may not return through the caller's return address — on some path the 'jal' at 0x4/);
    // saved, but the save word overwritten before the reload: the slot model refuses it first
    expect(() =>
      src(
        [
          '0:\taddiu\tsp,sp,-24',
          '4:\tsw\tra,20(sp)',
          '8:\tjal\t0 <f>',
          'c:\tnop',
          '10:\tsw\tv0,20(sp)',
          '14:\tlw\tra,20(sp)',
          '18:\taddiu\tsp,sp,24',
          '1c:\tjr\tra',
          '20:\tnop',
        ],
        [[8, 'ext']],
      ),
    ).toThrow(/'20\(sp\)' at 0x10 is a word this function both saves a register in and stores a value to/);
  });

  test("a call's delay slot runs after the link and before the callee", () => {
    const frame = (slot: string, ...rest: string[]) =>
      src(
        [
          '0:\taddiu\tsp,sp,-32',
          '4:\tsw\ts0,24(sp)',
          '8:\tmove\ts0,ra',
          'c:\tjal\t0 <f>',
          `10:\t${slot}`,
          ...rest,
          '20:\taddiu\tsp,sp,32',
          '24:\tjr\tra',
          '28:\tli\tv0,7',
        ],
        [[0xc, 'ext']],
      );
    // `m_jaldelaymove`: the slot puts the caller's address back into ra, so ext returns straight to
    // our caller — lifted `ext(); return 7;`
    expect(() => frame('move\tra,s0', '14:\tnop', '18:\tnop', '1c:\tlw\ts0,24(sp)')).toThrow(
      /the 'move' at 0x10 in the delay slot of the 'jal' at 0xc writes ra/,
    );
    // `m_jaldelaylw`: the slot reloads ra from its save word, and sp is never popped
    expect(() =>
      src(
        [
          '0:\taddiu\tsp,sp,-24',
          '4:\tsw\tra,20(sp)',
          '8:\tjal\t0 <f>',
          'c:\tlw\tra,20(sp)',
          '10:\tli\tv0,7',
          '14:\taddiu\tsp,sp,24',
          '18:\tjr\tra',
          '1c:\tnop',
        ],
        [[8, 'ext']],
      ),
    ).toThrow(/the 'lw' at 0xc in the delay slot of the 'jal' at 0x8 writes ra/);
    // `m_jaldelayt0`: a copy into t0 in the slot — ext may destroy t0, lifted `return ext();`
    expect(() => frame('move\tt0,s0', '14:\tmove\tra,t0', '18:\tnop', '1c:\tlw\ts0,24(sp)')).toThrow(
      /the 'jr ra' at 0x24 may not return through the caller's return address — on some path the 'move' at 0x14/,
    );
    // `m_homejal`: a copy stored in the call's home area in the slot — ext may write its a0 home
    expect(() => frame('sw\ts0,0(sp)', '14:\tlw\tra,0(sp)', '18:\tnop', '1c:\tlw\ts0,24(sp)')).toThrow(
      /the 'jr ra' at 0x24 may not return through the caller's return address — on some path the 'lw' at 0x14/,
    );
    // a copy kept in s0 across the call, put back after it, is a return
    expect(frame('nop', '14:\tmove\tra,s0', '18:\tnop', '1c:\tlw\ts0,24(sp)')).toMatch(/return 7;/);
  });

  test("the compilers' own save of ra is a return, and so is a leaf", () => {
    // `m_good`
    expect(
      src(
        [
          '0:\taddiu\tsp,sp,-24',
          '4:\tsw\tra,20(sp)',
          '8:\tjal\t0 <f>',
          'c:\tnop',
          '10:\tlw\tra,20(sp)',
          '14:\taddiu\tsp,sp,24',
          '18:\tjr\tra',
          '1c:\taddiu\tv0,v0,1',
        ],
        [[8, 'ext']],
      ),
    ).toContain('return ext() + 1;');
    // a leaf, with a conditional path, never names ra
    expect(src(['0:\tbeqz\ta0,c <f+0xc>', '4:\tli\tv0,7', '8:\tli\tv0,9', 'c:\tjr\tra', '10:\tnop'])).toMatch(/return/);
  });
});
