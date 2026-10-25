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

// fixtures/elf-bodies/veneers-arm.elf is built from the .s and .ld beside it:
//   arm-none-eabi-as -mcpu=arm7tdmi -o veneers-arm.o veneers-arm.s
//   arm-none-eabi-ld -T arm.ld -e thunk_rnd -o veneers-arm.elf veneers-arm.o
// Each thunk_* is kleod's veneer shape, size 0 and ending at the `$a` mapping symbol of its `b`:
// thunk_rnd enters kleod's GetRandomValue body (reads no argument), thunk_rd1 one reading r0,
// thunk_br/_cond/_call one that branches, executes conditionally or calls; thunk_wk is weak and
// `plain` is a Thumb function that is no veneer. No objdump is run on this path.
describe('CLI (agbcc): a guessed callee behind a Thumb->ARM veneer is bounded by the ARM body it enters', () => {
  const ARM_ELF = readFileSync(fixture('veneers-arm.elf'));
  const project = (elf: boolean, asm: string) => {
    const root = scratch();
    copyFileSync(fixture('veneers-arm.elf'), join(root, 'veneers-arm.elf'));
    writeFileSync(
      join(root, 'decomp.yaml'),
      'name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    target: agbcc\n' +
        (elf ? '    elf: veneers-arm.elf\n' : ''),
    );
    writeFileSync(join(root, 'f.s'), asm);
    return join(root, 'f.s');
  };
  test('the veneers in the image', () => {
    const image = readElfImage(ARM_ELF)!;
    expect(functionRange(image, 'thunk_rnd')).toMatchObject({ start: 0x08000000, end: 0x08000004, thumb: true });
    const read = calleeBodiesFromElf(
      'x.elf',
      ARM_ELF,
      ['thunk_rnd', 'thunk_rd1', 'thunk_br', 'thunk_cond', 'thunk_call', 'thunk_wk', 'plain', 'last'],
      TOOLCHAIN_TARGETS.agbcc.description,
      () => {
        throw new Error('no objdump on the ARM path');
      },
    );
    // the weak veneer, a Thumb function that is none, and an ARM function called directly give none
    expect(Object.keys(read.bodies)).toEqual(['thunk_rnd', 'thunk_rd1', 'thunk_br', 'thunk_cond', 'thunk_call']);
    expect(read.bodies.thunk_rd1).toEqual({ kind: 'arm', words: [0xe2800001, 0xe12fff1e] });
  });
  // `extern int gp; f() { gp = 3; g(); }`: the store leaves its 3 in r0 and gp's address in r1
  const stored = (callee: string) =>
    '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n' +
    `\tbl\t${callee}\n\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgp\n`;
  const call = async (callee: string, elf: boolean) => {
    const r = await runCli([project(elf, stored(callee))]);
    return r.stdout
      .split('\n')
      .find((l) => l.includes(`${callee}(`))
      ?.trim();
  };
  test.each([
    ['thunk_rnd', 'return thunk_rnd();'],
    ['thunk_rd1', 'return thunk_rd1(3);'],
    ['thunk_br', 'return thunk_br(3, &gp);'],
    ['thunk_cond', 'return thunk_cond(3, &gp);'],
    ['thunk_call', 'return thunk_call(3, &gp);'],
    ['thunk_wk', 'return thunk_wk(3, &gp);'],
    ['plain', 'return plain(3, &gp);'],
  ])('%s', async (callee, withElf) => {
    expect(await call(callee, true)).toBe(withElf);
    expect(await call(callee, false)).toBe(`return ${callee}(3, &gp);`);
  });
  // `u8 thunk_rnd(); void jt_rndsame(s32 i){ switch (i) { case 0: gH = 5; gA = thunk_rnd(); … } }`
  // (synthetic:jt_rndst:agbcc with the callee behind a veneer, as kleod's thunk_GetRandomValue is):
  // case 0 leaves its store's 5 in r0 at the call, which the dispatch gate refuses to guess at
  test('a jump-table case calling it lifts, and still declines with no ELF', async () => {
    const asm =
      '\t.code\t16\n\t.text\n\t.thumb_func\njt_rndsame:\n\tpush\t{r4, lr}\n\tcmp\tr0, #0x6\n\tbhi\t.L6\n' +
      '\tlsl\tr0, r0, #0x2\n\tldr\tr1, .L17\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n\t.align\t2, 0\n' +
      '.L17:\n\t.word\t.L14\n\t.align\t2, 0\n.L14:\n\t.word\t.L7\n\t.word\t.L8\n\t.word\t.L9\n\t.word\t.L10\n' +
      '\t.word\t.L11\n\t.word\t.L12\n\t.word\t.L13\n.L7:\n\tldr\tr1, .L19\n\tmov\tr0, #0x5\n\tstrh\tr0, [r1]\n' +
      '\tbl\tthunk_rnd\n\tldr\tr1, .L19+0x4\n\tb\t.L16\n\t.align\t2, 0\n.L19:\n\t.word\tgH\n\t.word\tgA\n.L8:\n' +
      '\tldr\tr1, .L21\n\tmov\tr0, #0x1\n\tb\t.L16\n\t.align\t2, 0\n.L21:\n\t.word\tgB\n.L9:\n\tldr\tr4, .L23\n' +
      '\tbl\tthunk_rnd\n\tmov\tr1, #0x3\n\tand\tr1, r1, r0\n\tstrb\tr1, [r4]\n\tb\t.L6\n\t.align\t2, 0\n.L23:\n' +
      '\t.word\tgA\n.L10:\n\tldr\tr1, .L25\n\tmov\tr0, #0x7\n\tb\t.L16\n\t.align\t2, 0\n.L25:\n\t.word\tgC\n.L11:\n' +
      '\tbl\tthunk_rnd\n\tldr\tr1, .L27\n\tb\t.L16\n\t.align\t2, 0\n.L27:\n\t.word\tgB\n.L12:\n\tldr\tr1, .L29\n' +
      '\tmov\tr0, #0x9\n\tstrh\tr0, [r1]\n\tb\t.L6\n\t.align\t2, 0\n.L29:\n\t.word\tgH\n.L13:\n\tbl\tthunk_rnd\n' +
      '\tldr\tr1, .L31\n.L16:\n\tstrb\tr0, [r1]\n.L6:\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n\t.align\t2, 0\n.L31:\n' +
      '\t.word\tgC\n';
    const proto = '{"jt_rndsame":{"returnsVoid":true},"thunk_rnd":{"returns":"u8"}}';
    const lifted = await runCli([project(true, asm), '--proto', proto]);
    expect(lifted.code).toBe(0);
    expect(lifted.stdout).toContain('thunk_rnd()');
    expect(lifted.stdout).not.toMatch(/thunk_rnd\([^)]/);
    const declined = await runCli([project(false, asm), '--proto', proto]);
    expect(declined.code).toBe(1);
    expect(declined.stderr).toMatch(/has no prototype, and r0, which the count takes, holds a value an effect/);
  });
});
