// The bodies of a real row's callees that `bench vendor` freezes out of the project's linked ELF
// (cases/callee-bodies.ts): one byte-stable file per project, a refusal where a project vendors an
// ELF's symbol map and no bodies, and the CLI's own selection rule over what is frozen.
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  CALLEE_BODIES_FILE,
  type VendoredCalleeBodies,
  calleeBodiesBytes,
  readVendoredCalleeBodies,
  writeVendoredCalleeBodies,
} from '../src/cases/callee-bodies';

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
  unread: ['memcpy', '__divsi3'],
};

describe('the frozen callee bodies of a project', () => {
  test('one value is one byte string, whatever order its keys were built in', () => {
    const reordered: VendoredCalleeBodies = {
      unread: ['__divsi3', 'memcpy'],
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
    expect(back.unread).toEqual(['__divsi3', 'memcpy']);
    expect(back.objdump).toBe(frozen.objdump);
    const first = readFileSync(join(dir, CALLEE_BODIES_FILE));
    writeVendoredCalleeBodies(dir, frozen);
    expect(readFileSync(join(dir, CALLEE_BODIES_FILE)).equals(first)).toBe(true);
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
