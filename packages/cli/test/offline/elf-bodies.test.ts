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
import { type CalleeBodies, calleeBodyBounds } from '@asmlift/core/frontend/callee-body';
import { liftStamped } from '@asmlift/core/pipeline';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { calleeBodiesFromElf, functionRange, readElfImage } from '../../src/elf-bodies';
import { type ObjInput, runCli } from '../../src/main';
import { disasmRange } from '../../src/objfile';

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
    expect(functionRange(image, 'rd0')).toMatchObject({
      start: 0x80000400,
      end: 0x80000408,
      section: '.text',
      thumb: false,
    });
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
      (_elf, _t, section, start, stop) => {
        asked.push(`${section} ${start.toString(16)}-${stop.toString(16)}`);
        return MIPS_RANGES[`${start.toString(16)}-${stop.toString(16)}`];
      },
    );
    expect(asked).toEqual(['.text 80000400-80000408', '.text 80000418-80000420']);
    expect(Object.keys(read.bodies)).toEqual(['rd0', 'un0']);
  });
  // overlays put several sections at one address (mp3's .minigame, .name_81 and .shared_board all
  // hold code at 0x800d9f10), and objdump prints every one an address range alone selects
  test('the objdump of a range is scoped to the section its symbol names', () => {
    const bin = join(scratch(), 'objdump');
    writeFileSync(bin, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    expect(
      disasmRange('x.elf', TOOLCHAIN_TARGETS['ido7.1'].description, '.minigame', 0x800d9f10, 0x800d9f3c, bin),
    ).toBe('-d --no-show-raw-insn -j .minigame --start-address=0x800d9f10 --stop-address=0x800d9f3c x.elf\n');
  });
  // a symbol inside a sized FUNC (mp3's `*_VRAM_END`, af's `.L800F29C8`) starts a header objdump
  // prints in the range, which the frontend would slice the body at
  test('every header in a range but the callee own is dropped', () => {
    const inner = `${head}80000408 <rd1>:\n80000408:\tjr\tra\n\n8000040c <rd1_VRAM_END>:\n8000040c:\taddiu\tv0,a0,1\n`;
    const read = calleeBodiesFromElf(
      'x.elf',
      MIPS_ELF,
      ['rd1'],
      TOOLCHAIN_TARGETS['gcc2.7.2kmc'].description,
      () => inner,
    );
    expect(read.bodies.rd1).toEqual({
      kind: 'listing',
      text: `${head}80000408 <rd1>:\n80000408:\tjr\tra\n\n8000040c:\taddiu\tv0,a0,1\n`,
    });
    const t = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].description;
    const own = `${head}00000000 <f>:\n   0:\tjr\tra\n   4:\tnop\n`;
    const bound = (bodies: CalleeBodies) =>
      calleeBodyBounds(
        'f',
        own,
        t,
        {},
        (callee, table, entryReadCalls, text) =>
          liftStamped(callee, text, t, table, undefined, undefined, undefined, {
            calleeBodyBound: () => undefined,
            entryReadCalls,
          }),
        bodies,
      )('rd1');
    expect(bound(read.bodies)).toBe(1);
    expect(bound({ rd1: { kind: 'listing', text: inner } })).toBeUndefined();
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
  const seam = (callee: string, ranges: Record<string, string> = MIPS_RANGES): ObjInput => ({
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
    disasmRange: (_elf, _t, _section, start, stop) => {
      const text = ranges[`${start.toString(16)}-${stop.toString(16)}`];
      if (text === undefined) {
        throw new Error(`no recorded range ${start.toString(16)}-${stop.toString(16)}`);
      }
      return text;
    },
  });
  const project = (elf: boolean, image = 'callees-mips.elf') => {
    const root = scratch();
    copyFileSync(fixture(image), join(root, image));
    writeFileSync(
      join(root, 'decomp.yaml'),
      'name: test\nplatform: n64\nversions: []\ntools:\n  asmlift:\n    target: gcc2.7.2kmc\n' +
        (elf ? `    elf: ${image}\n` : ''),
    );
    return join(root, 'f.o');
  };
  const call = async (
    callee: string,
    elf: boolean,
    image?: string,
    ranges?: Record<string, string>,
    more: string[] = [],
  ) => {
    const r = await runCli([project(elf, image), '--name', 'f', ...more], () => MIPS_ELF, seam(callee, ranges));
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

  // fixtures/elf-bodies/calls-mips.elf is built from calls-mips.s, calls-mips-dup.s and calls-mips.ld:
  //   mips-linux-gnu-as -mips2 -o calls-mips.o calls-mips.s
  //   mips-linux-gnu-as -mips2 -o calls-mips-dup.o calls-mips-dup.s
  //   mips-linux-gnu-ld -N -T calls-mips.ld -e cj -o calls-mips.elf calls-mips.o calls-mips-dup.o
  // Each c* body makes one `jal`: cj hands its a0 on to rd1, and the rest zero a0 in the slot, so
  // where the callee is declared one word they read none of their own. A linked image names no
  // call, so the frontend could lift none of them; the call is named off the image's symbols where
  // one name is certain: not for rd1b (aliased as rd1alias), dup (a static of two objects) or ovl_a
  // from .text (.ovl_a and .ovl_b both hold its address), but for ovl_a from its own overlay.
  describe('a body that makes a call', () => {
    const at = (a: number, k: number) => (a + k).toString(16);
    const framed = (name: string, a: number, target: string, slot: string, section = '.text') =>
      `\ncalls-mips.elf:     file format elf32-tradbigmips\n\n\nDisassembly of section ${section}:\n\n` +
      `${at(a, 0)} <${name}>:\n${at(a, 0)}:\taddiu\tsp,sp,-24\n${at(a, 4)}:\tsw\tra,16(sp)\n` +
      `${at(a, 8)}:\tjal\t${target}\n${at(a, 12)}:\t${slot}\n${at(a, 16)}:\tlw\tra,16(sp)\n` +
      `${at(a, 20)}:\tjr\tra\n${at(a, 24)}:\taddiu\tsp,sp,24\n`;
    // what mips-linux-gnu-objdump -d --no-show-raw-insn -j <section> prints for each range
    const CALL_RANGES: Record<string, string> = {
      '80000418-80000434': framed('cj', 0x80000418, '80000400 <rd1>', 'nop'),
      '80000434-80000450': framed('cz', 0x80000434, '80000400 <rd1>', 'move\ta0,zero'),
      '80000450-8000046c': framed('calias', 0x80000450, '80000408 <rd1alias>', 'move\ta0,zero'),
      '8000046c-80000488': framed('cdup', 0x8000046c, '80000410 <dup>', 'move\ta0,zero'),
      '80000488-800004a4': framed('covl', 0x80000488, '80100000 <ovl_a>', 'move\ta0,zero'),
      '80100008-80100024': framed('cin_a', 0x80100008, '80100000 <ovl_a>', 'move\ta0,zero', '.ovl_a'),
    };
    const declared = ['--proto', '{"rd1":{"params":["s32"]},"rd1b":{},"rd1alias":{},"dup":{},"ovl_a":{}}'];
    const declaredNone = declared[1].replace(/\{\}/g, '{"params":[]}');
    test('each call one name is certain for gets its R_MIPS_26, and no other does', () => {
      const read = calleeBodiesFromElf(
        'x.elf',
        readFileSync(fixture('calls-mips.elf')),
        ['cj', 'calias', 'cdup', 'covl', 'cin_a'],
        TOOLCHAIN_TARGETS['ido7.1'].description,
        (_elf, _t, _section, start, stop) => CALL_RANGES[`${start.toString(16)}-${stop.toString(16)}`],
      );
      const relocsOf = (c: string) => (read.bodies[c].kind === 'listing' ? read.bodies[c].relocs : undefined);
      expect(relocsOf('cj')).toEqual([
        { section: '.text', offset: 0x80000420, type: 'R_MIPS_26', sym: 'rd1', addend: 0 },
      ]);
      expect(relocsOf('cin_a')).toEqual([
        { section: '.text', offset: 0x80100010, type: 'R_MIPS_26', sym: 'ovl_a', addend: 0 },
      ]);
      expect([relocsOf('calias'), relocsOf('cdup'), relocsOf('covl')]).toEqual([undefined, undefined, undefined]);
    });
    test.each([
      // hands its a0 on to a callee declared to read it: the 3 stays
      ['cj', 'return cj(3);'],
      // reads none of its a0: the 3 is no argument
      ['cz', 'return cz();'],
      ['cin_a', 'return cin_a();'],
      // a call no one name is certain for leaves the body unliftable, so the guess stands
      ['calias', 'return calias(3);'],
      ['cdup', 'return cdup(3);'],
      ['covl', 'return covl(3);'],
    ])('%s', async (callee, withElf) => {
      const more = ['--proto', declaredNone];
      expect(await call(callee, true, 'calls-mips.elf', CALL_RANGES, more)).toBe(withElf);
      expect(await call(callee, false, 'calls-mips.elf', CALL_RANGES, more)).toBe(`return ${callee}(3);`);
    });
    // a call inside the body that nothing declares is taken at every argument register
    test('a named call nothing declares keeps every argument', async () => {
      expect(await call('cz', true, 'calls-mips.elf', CALL_RANGES)).toBe('return cz(3);');
    });
  });
});

// fixtures/elf-bodies/calls-ppc.elf is built from calls-ppc.s and calls-ppc.ld beside it, with the
// powerpc-eabi binutils the GameCube projects build:
//   powerpc-eabi-as -mgekko -o calls-ppc.o calls-ppc.s
//   powerpc-eabi-ld -N -T calls-ppc.ld -e cj -o calls-ppc.elf calls-ppc.o
// cj hands its r3 on to rd1, cz zeroes r3 first, and cst calls `st`, a static.
describe('PowerPC: a body read off the ELF names its calls in the listing, as `objdump -r` prints them', () => {
  const PPC_ELF = readFileSync(fixture('calls-ppc.elf'));
  const t = TOOLCHAIN_TARGETS.mwcc_242_81.description;
  const at = (a: number, k: number) => (a + k).toString(16);
  const framed = (name: string, a: number, body: string[]) =>
    `\ncalls-ppc.elf:     file format elf32-powerpc\n\n\nDisassembly of section .text:\n\n${at(a, 0)} <${name}>:\n` +
    ['mflr    r0', 'stw     r0,4(r1)', 'stwu    r1,-8(r1)', ...body, 'lwz     r0,12(r1)', 'addi    r1,r1,8']
      .concat(['mtlr    r0', 'blr'])
      .map((ins, k) => `${at(a, 4 * k)}:\t${ins}\n`)
      .join('');
  // what powerpc-eabi-objdump -d -r -M gekko --no-show-raw-insn -j .text prints for each range
  const RANGES: Record<string, string> = {
    '80003010-80003030': framed('cj', 0x80003010, ['bl      80003000 <rd1>']),
    '80003030-80003054': framed('cz', 0x80003030, ['li      r3,0', 'bl      80003000 <rd1>']),
    '80003058-80003078': framed('cst', 0x80003058, ['bl      80003054 <st>']),
  };
  const read = calleeBodiesFromElf('x.elf', PPC_ELF, ['cj', 'cz', 'cst'], t, (_elf, _t, _s, start, stop) => {
    return RANGES[`${start.toString(16)}-${stop.toString(16)}`];
  });
  const own = '\nx.o:     file format elf32-powerpc\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n   0:\tblr\n';
  const bound = (bodies: CalleeBodies, callee: string) =>
    calleeBodyBounds(
      'f',
      own,
      t,
      { rd1: { params: ['s32'] }, st: { params: [] } },
      (c, table, entryReadCalls, text) =>
        liftStamped(c, text, t, table, undefined, undefined, undefined, {
          calleeBodyBound: () => undefined,
          entryReadCalls,
        }),
      bodies,
    )(callee);
  test('each bl gets an R_PPC_REL24 line under it', () => {
    expect(read.bodies.cz).toEqual({
      kind: 'listing',
      text: RANGES['80003030-80003054'].replace(
        '80003040:\tbl      80003000 <rd1>\n',
        '80003040:\tbl      80003000 <rd1>\n\t\t\t80003040: R_PPC_REL24\trd1\n',
      ),
    });
    expect(read.bodies.cst.kind === 'listing' && read.bodies.cst.text).toContain('R_PPC_REL24\tst\n');
  });
  test('so a body that calls bounds, and the same listing unnamed does not', () => {
    expect(['cj', 'cz', 'cst'].map((c) => bound(read.bodies, c))).toEqual([1, 0, 0]);
    const unnamed = Object.fromEntries(
      Object.entries(RANGES).map(([k, text]) => [
        { '80003010-80003030': 'cj', '80003030-80003054': 'cz' }[k] ?? 'cst',
        { kind: 'listing' as const, text },
      ]),
    );
    expect(['cj', 'cz', 'cst'].map((c) => bound(unnamed, c))).toEqual([undefined, undefined, undefined]);
  });
  test('a listing that already prints relocations is handed in as it is', () => {
    const emitted = RANGES['80003030-80003054'].replace(
      '80003040:\tbl      80003000 <rd1>\n',
      '80003040:\tbl      80003000 <rd1>\n\t\t\t80003040: R_PPC_REL24\trd1\n',
    );
    const again = calleeBodiesFromElf('x.elf', PPC_ELF, ['cz'], t, () => emitted);
    expect(again.bodies.cz).toEqual({ kind: 'listing', text: emitted });
  });
});

// fixtures/elf-bodies/veneers-arm.elf is built from the .s and .ld beside it:
//   arm-none-eabi-as -mcpu=arm7tdmi -o veneers-arm.o veneers-arm.s
//   arm-none-eabi-ld -T arm.ld -e thunk_rnd -o veneers-arm.elf veneers-arm.o
// Each thunk_* is kleod's veneer shape, size 0 and ending at the `$a` mapping symbol of its `b`:
// thunk_rnd enters kleod's GetRandomValue body (reads no argument), thunk_rd1 one reading r0,
// thunk_br/_cond/_call one that branches, executes conditionally or calls, thunk_id one that returns
// r0 as the caller left it; thunk_wk is weak and `plain` is a Thumb function that is no veneer. No
// objdump is run on this path.
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
      ['thunk_rnd', 'thunk_rd1', 'thunk_br', 'thunk_cond', 'thunk_call', 'thunk_id', 'thunk_wk', 'plain', 'last'],
      TOOLCHAIN_TARGETS.agbcc.description,
      () => {
        throw new Error('no objdump on the ARM path');
      },
    );
    // the weak veneer, a Thumb function that is none, and an ARM function called directly give none
    expect(Object.keys(read.bodies)).toEqual([
      'thunk_rnd',
      'thunk_rd1',
      'thunk_br',
      'thunk_cond',
      'thunk_call',
      'thunk_id',
    ]);
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
    // returns r0 unwritten: the store's 3 is the argument it hands back
    ['thunk_id', 'return thunk_id(3);'],
    ['thunk_wk', 'return thunk_wk(3, &gp);'],
    ['plain', 'return plain(3, &gp);'],
  ])('%s', async (callee, withElf) => {
    expect(await call(callee, true)).toBe(withElf);
    expect(await call(callee, false)).toBe(`return ${callee}(3, &gp);`);
  });
  // the note names a body only where the lift asked it: a gate questioned a register the call left
  // unset. `mov r0, #5; bl thunk_rnd` sets r0 up, so nothing asks, and the 5 stays an argument the
  // body reads none of; nor does a callee with a parameter list nothing can lay out ask its body
  const NOTE = 'each register the call left unset checked against what its body in tools.asmlift.elf reads: ';
  test('the [proto] note names a callee its ARM body bounds, and leaves the rest guessed', async () => {
    const r = await runCli([project(true, stored('thunk_rnd') + stored('thunk_br').replace(/f:/, 'g:'))]);
    expect(r.stderr).toContain(`${NOTE}thunk_rnd (at most 0 argument words)`);
    const bare = await runCli([project(false, stored('thunk_rnd'))]);
    expect(bare.stderr).toContain('guessed from the argument registers: thunk_rnd —');
    const br = await runCli([project(true, stored('thunk_br'))]);
    expect(br.stderr).toContain('guessed from the argument registers: thunk_br —');
  });
  test('the [proto] note names no body the lift did not ask', async () => {
    const set =
      '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tmov\tr0, #5\n\tbl\tthunk_rnd\n\tpop\t{r1}\n\tbx\tr1\n';
    const r = await runCli([project(true, set)]);
    expect(r.stdout).toContain('thunk_rnd(5)');
    expect(r.stderr).toContain('guessed from the argument registers: thunk_rnd —');
    expect(r.stderr).not.toContain(NOTE);
    const typed = await runCli([project(true, stored('thunk_rnd')), '--proto', '{"thunk_rnd":{"params":["Weird"]}}']);
    expect(typed.stdout).toContain('thunk_rnd(3, &gp)');
    expect(typed.stderr).toContain('guessed from the argument registers: thunk_rnd —');
    expect(typed.stderr).not.toContain(NOTE);
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
