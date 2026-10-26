// The bodies of a real row's callees that `bench vendor` freezes out of the project's linked ELF
// (cases/callee-bodies.ts): one canonical file per project, left alone while its content holds, a
// refusal where a project vendors an ELF's symbol map and no bodies, and the CLI's own selection
// rule over what is frozen.
import { calleeBodiesFromElf } from '@asmlift/cli/elf-bodies';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { agbccAvailable } from '@asmlift/toolchains';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import {
  CALLEE_BODIES_FILE,
  type VendoredCalleeBodies,
  calleeBodiesBytes,
  calleeBodiesJson,
  readVendoredCalleeBodies,
  selectCalleeBodies,
  writeVendoredCalleeBodies,
} from '../src/cases/callee-bodies';
import { benchCheckoutsDir } from '../src/cases/manifests';
import { realCases } from '../src/cases/real';
import { rankOptionsFor } from '../src/eval/asmlift';

const listing = '\nbuild/x.elf:     file format elf32-tradbigmips\n\n80000400 <rd0>:\n80000400:\tjr\tra\n';
const frozen: VendoredCalleeBodies = {
  objdump: 'GNU objdump (GNU Binutils) 2.42',
  bodies: {
    thunk_rnd: { kind: 'arm', words: [0xe3a00000, 0xe12fff1e] },
    rd0: {
      kind: 'listing',
      text: listing,
      relocs: [{ section: '.text', offset: 4, type: 'R_MIPS_26', sym: 'g', addend: 0 }],
    },
  },
  unread: ['memcpy', '__divsi3', 'other'],
};

describe('the frozen callee bodies of a project', () => {
  test('one value is one byte string, whatever order its keys were built in', () => {
    const reordered: VendoredCalleeBodies = {
      unread: ['other', '__divsi3', 'memcpy'],
      bodies: { rd0: frozen.bodies.rd0, thunk_rnd: frozen.bodies.thunk_rnd },
      objdump: frozen.objdump,
    };
    expect(calleeBodiesBytes(reordered).equals(calleeBodiesBytes(frozen))).toBe(true);
    // the gzip header names no platform: zlib writes the one it was built for
    expect(calleeBodiesBytes(frozen)[9]).toBe(3);
  });

  test('written and read back, every body is the one frozen, MIPS relocations included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callee-bodies-'));
    writeVendoredCalleeBodies(dir, frozen);
    const back = readVendoredCalleeBodies('p', dir, true)!;
    expect(back.bodies).toEqual(frozen.bodies);
    expect(back.unread).toEqual(['__divsi3', 'memcpy', 'other']);
    expect(back.objdump).toBe(frozen.objdump);
    const first = readFileSync(join(dir, CALLEE_BODIES_FILE));
    writeVendoredCalleeBodies(dir, frozen);
    expect(readFileSync(join(dir, CALLEE_BODIES_FILE)).equals(first)).toBe(true);
  });

  test('a file already holding the bodies is left alone, whatever zlib wrote it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callee-bodies-'));
    // the same content through another deflate (level 1, not the writer's 9): other bytes
    const other = gzipSync(Buffer.from(calleeBodiesJson(frozen)), { level: 1 });
    expect(other.equals(calleeBodiesBytes(frozen))).toBe(false);
    writeFileSync(join(dir, CALLEE_BODIES_FILE), other);
    writeVendoredCalleeBodies(dir, frozen);
    expect(readFileSync(join(dir, CALLEE_BODIES_FILE)).equals(other)).toBe(true);
    writeVendoredCalleeBodies(dir, { ...frozen, unread: ['memcpy'] });
    expect(
      readFileSync(join(dir, CALLEE_BODIES_FILE)).equals(calleeBodiesBytes({ ...frozen, unread: ['memcpy'] })),
    ).toBe(true);
  });

  test('a project with no linked ELF keeps no file, and a stale one is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callee-bodies-'));
    writeFileSync(join(dir, 'symbols.json.gz'), '');
    writeVendoredCalleeBodies(dir, frozen);
    writeVendoredCalleeBodies(dir, undefined);
    expect(readdirSync(dir)).toEqual(['symbols.json.gz']);
  });

  test('a project vendoring no ELF has no bodies; one vendoring its map and no bodies is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'callee-bodies-'));
    expect(readVendoredCalleeBodies('af', dir, false)).toBeUndefined();
    expect(() => readVendoredCalleeBodies('af', dir, true)).toThrow(
      /af: a linked ELF is vendored \(symbols\.json\.gz\) but no callee bodies from it — run `pnpm bench vendor --project af --callee-bodies-only`/,
    );
  });
});

// A lift is handed the bodies the CLI's own rule selects (cli elf-bodies.ts `elfBodyCallees`): the
// guessed callees, never one a prototype declares, and nothing at all where none is frozen.
describe('the bodies a lift is handed', () => {
  const t = TOOLCHAIN_TARGETS.agbcc.description;
  const asm =
    '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tbl\tthunk_rnd\n\tbl\tother\n\tbl\trd0\n' +
    '\tpop\t{r0}\n\tbx\tr0\n';
  test('every guessed callee with a frozen body, and none a prototype declares', () => {
    expect(Object.keys(selectCalleeBodies(asm, 'f', t, undefined, undefined, undefined, frozen)!)).toEqual([
      'thunk_rnd',
      'rd0',
    ]);
    expect(Object.keys(selectCalleeBodies(asm, 'f', t, { rd0: { params: 0 } }, undefined, undefined, frozen)!)).toEqual(
      ['thunk_rnd'],
    );
    const unasked = { ...frozen, bodies: {}, unread: ['other', 'rd0', 'thunk_rnd'] };
    expect(selectCalleeBodies(asm, 'f', t, undefined, undefined, undefined, unasked)).toBeUndefined();
  });
  test('a selected callee the vendoring never read is refused, not handed nothing', () => {
    const older = { ...frozen, unread: ['__divsi3'] };
    expect(() => selectCalleeBodies(asm, 'f', t, undefined, undefined, undefined, older)).toThrow(
      /f: its lift reads the body of other out of the linked ELF, and the vendored callee bodies name no such callee/,
    );
  });
});

// kleod's WorldMapScreenUnlockNewWorld calls thunk_GetRandomValue, a Thumb->ARM interworking veneer
// nothing declares: the CLI hands its lift the ARM body behind it, and so must the harness.
describe.skipIf(!agbccAvailable())("the harness hands a real row's lift its ELF callee bodies", () => {
  const [c] = realCases({ project: 'kleod', only: 'WorldMapScreenUnlockNewWorld' });
  const built = c.build();
  const vendored = c.calleeBodies!()!;
  const opts = rankOptionsFor(
    c.toolchain,
    c.codegen,
    built.obj,
    c.sym,
    c.proto,
    c.compile,
    c.symbols,
    c.contextGlobals,
    { asm: built.asm, vendored },
  );
  test('the guessed veneer, and only it', () => {
    expect(Object.keys(opts.calleeBodies ?? {})).toEqual(['thunk_GetRandomValue']);
    expect(opts.calleeBodies!.thunk_GetRandomValue.kind).toBe('arm');
  });
  const elf = join(benchCheckoutsDir(), 'kleod', 'kleod-syms.elf');
  test.skipIf(!existsSync(elf))("the body is the one the CLI reads off the checkout's ELF", () => {
    const live = calleeBodiesFromElf(elf, readFileSync(elf), ['thunk_GetRandomValue'], c.codegen.target, () => {
      throw new Error('no objdump on the ARM path');
    });
    expect(opts.calleeBodies).toEqual(live.bodies);
  });
});
