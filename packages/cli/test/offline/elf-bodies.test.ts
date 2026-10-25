// A GUESSED CALLEE'S BODY READ OFF THE LINKED ELF (src/elf-bodies.ts): its range in
// `tools.asmlift.elf`, disassembled with the target's objdump and handed to the core's callee-body
// bound, so a callee the input does not hold bounds its arity as an inline body would.
//
// fixtures/elf-bodies/callees-mips.elf is built from the .s and .ld beside it:
//   mips-linux-gnu-as -mips2 -o callees-mips.o callees-mips.s
//   mips-linux-gnu-ld -T mips.ld -e rd0 -o callees-mips.elf callees-mips.o
// rd0 (reads no argument) and rd1 (reads a0) are sized, wk is weak, un0 and last are FUNCs of size 0,
// un0 with `last` after it and `last` with nothing after it in .text. The objdump spawn is faked
// through runCli's seam with the text `mips-linux-gnu-objdump -d --no-show-raw-insn
// --start-address=… --stop-address=…` printed for each range.
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { calleeBodiesFromElf, functionRange, readElfImage } from '../../src/elf-bodies';
import { type ObjInput, runCli } from '../../src/main';

const fixture = (f: string) => join(import.meta.dirname, 'fixtures/elf-bodies', f);
const MIPS_ELF = readFileSync(fixture('callees-mips.elf'));

const scratchDirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'asmlift-elf-bodies-test-'));
  scratchDirs.push(d);
  return d;
};
afterAll(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const head = '\ncallees-mips.elf:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n';
/** What the target's objdump prints for each range of the fixture, keyed by `start-stop`. */
const MIPS_RANGES: Record<string, string> = {
  '80000400-80000408': `${head}80000400 <rd0>:\n80000400:\tjr\tra\n80000404:\tli\tv0,1\n`,
  '80000408-80000410': `${head}80000408 <rd1>:\n80000408:\tjr\tra\n8000040c:\taddiu\tv0,a0,1\n`,
  '80000418-80000420': `${head}80000418 <un0>:\n80000418:\tjr\tra\n8000041c:\tli\tv0,2\n`,
};

describe('a function range in the linked ELF', () => {
  const image = readElfImage(MIPS_ELF)!;
  test('a sized FUNC is its size, and a size-0 one runs to the next symbol in its section', () => {
    expect(functionRange(image, 'rd0')).toMatchObject({ start: 0x80000400, end: 0x80000408, thumb: false });
    expect(functionRange(image, 'rd1')).toMatchObject({ start: 0x80000408, end: 0x80000410 });
    expect(functionRange(image, 'un0')).toMatchObject({ start: 0x80000418, end: 0x80000420 });
  });
  test('a weak FUNC, a size-0 FUNC with nothing after it, and an absent name have no range', () => {
    expect(functionRange(image, 'wk')).toBeUndefined();
    expect(functionRange(image, 'last')).toBeUndefined();
    expect(functionRange(image, 'absent')).toBeUndefined();
  });
  test('each range with one is disassembled with the target objdump, and nothing else is', () => {
    const asked: string[] = [];
    const read = calleeBodiesFromElf(
      'x.elf',
      MIPS_ELF,
      ['rd0', 'wk', 'last', 'un0', 'absent'],
      TOOLCHAIN_TARGETS['gcc2.7.2kmc'].description,
      (_elf, _t, start, stop) => {
        asked.push(`${start.toString(16)}-${stop.toString(16)}`);
        return MIPS_RANGES[`${start.toString(16)}-${stop.toString(16)}`];
      },
    );
    expect(asked).toEqual(['80000400-80000408', '80000418-80000420']);
    expect(Object.keys(read.bodies)).toEqual(['rd0', 'un0']);
  });
  test('a range objdump cannot disassemble warns, and gives no body', () => {
    const read = calleeBodiesFromElf('x.elf', MIPS_ELF, ['rd0'], TOOLCHAIN_TARGETS['ido7.1'].description, () => {
      throw new Error('no MIPS objdump');
    });
    expect(read.bodies).toEqual({});
    expect(read.warnings.join('')).toContain('cannot disassemble rd0 out of tools.asmlift.elf (no MIPS objdump)');
  });
});

// `extern int gp; f() { gp = 3; g(); }` on O32: the store leaves its 3 in a0 at the `jal`, and the
// guess passes it. A body that reads no argument says it is none; one that reads a0 keeps it.
describe('CLI: a guessed callee absent from the input is bounded by its body in tools.asmlift.elf', () => {
  const caller =
    '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
    '   0:\taddiu\tsp,sp,-24\n   4:\tsw\tra,16(sp)\n   8:\tlui\tv0,0x0\n   c:\tli\ta0,3\n  10:\tsw\ta0,0(v0)\n' +
    '  14:\tjal\t0 <f>\n  18:\tnop\n  1c:\tlw\tra,16(sp)\n  20:\tjr\tra\n  24:\taddiu\tsp,sp,24\n';
  const seam = (callee: string): ObjInput => ({
    disasm: () => caller,
    asmData: () => ({
      sections: new Map(),
      relocs: [
        { section: '.text', offset: 8, type: 'R_MIPS_HI16', sym: 'gp', addend: 0 },
        { section: '.text', offset: 0x10, type: 'R_MIPS_LO16', sym: 'gp', addend: 0 },
        { section: '.text', offset: 0x14, type: 'R_MIPS_26', sym: callee, addend: 0 },
      ],
      symbols: new Map(),
      symbolCount: 0,
      bigEndian: true,
    }),
    disasmRange: (_elf, _t, start, stop) => {
      const text = MIPS_RANGES[`${start.toString(16)}-${stop.toString(16)}`];
      if (text === undefined) {
        throw new Error(`no recorded range ${start.toString(16)}-${stop.toString(16)}`);
      }
      return text;
    },
  });
  const project = (elf: boolean) => {
    const root = scratch();
    copyFileSync(fixture('callees-mips.elf'), join(root, 'callees-mips.elf'));
    writeFileSync(
      join(root, 'decomp.yaml'),
      'name: test\nplatform: n64\nversions: []\ntools:\n  asmlift:\n    target: gcc2.7.2kmc\n' +
        (elf ? '    elf: callees-mips.elf\n' : ''),
    );
    return join(root, 'f.o');
  };
  const call = async (callee: string, elf: boolean) => {
    const r = await runCli([project(elf), '--name', 'f'], () => MIPS_ELF, seam(callee));
    expect(r.stderr).not.toContain('[lift]');
    return r.stdout
      .split('\n')
      .find((l) => l.includes(`${callee}(`))
      ?.trim();
  };
  test.each([
    // reads no argument: the store's 3 is none
    ['rd0', 'return rd0();', 'return rd0(3);'],
    ['un0', 'return un0();', 'return un0(3);'],
    // reads a0: the 3 stays
    ['rd1', 'return rd1(3);', 'return rd1(3);'],
    // weak, and size 0 with no end: no body, so the guess stands
    ['wk', 'return wk(3);', 'return wk(3);'],
    ['last', 'return last(3);', 'return last(3);'],
  ])('%s', async (callee, withElf, without) => {
    expect(await call(callee, true)).toBe(withElf);
    expect(await call(callee, false)).toBe(without);
  });
});
