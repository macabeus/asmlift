// The bodies of a real row's callees that `bench vendor` freezes out of the project's linked ELF
// (cases/callee-bodies.ts): one canonical file per project, left alone while its content holds, a
// refusal where a project vendors an ELF's symbol map and no bodies, the CLI's own selection rule
// over what is frozen, and the drift check that holds what is frozen to what the ELF gives today.
import { asmliftBlock } from '@asmlift/cli/config';
import { calleeBodiesFromElf } from '@asmlift/cli/elf-bodies';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { agbccAvailable } from '@asmlift/toolchains';
import { searchDecompYaml } from '@match-kit/decomp-yaml/files';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { calleeBodiesTarget, projectObjdump, readCalleeBodies } from '../src/cases/callee-bodies-elf';
import { allowDirtyCheckout } from '../src/cases/checkout';
import { REAL_DIR, benchCheckoutsDir, loadCompleteManifests, resolveProjectRoot } from '../src/cases/manifests';
import { realCases } from '../src/cases/real';
import { rankOptionsFor } from '../src/eval/asmlift';
import { calleeBodiesDrift } from '../src/run/symbol-drift';

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

// The fidelity gate's half for the bodies (run/symbol-drift.ts `checkCalleeBodiesDrift`): content,
// never gzip bytes, and the callees whose body moved, by name.
describe('callee-body drift', () => {
  test('the same content is no drift, whichever objdump release read it', () => {
    expect(calleeBodiesDrift(frozen, { ...frozen, objdump: 'GNU objdump 2.43' })).toBeNull();
  });
  test('a body that moved, and a callee that gained one, are named', () => {
    const relinked: VendoredCalleeBodies = {
      ...frozen,
      bodies: { ...frozen.bodies, thunk_rnd: { kind: 'arm', words: [0xe12fff1e] }, other: { kind: 'arm', words: [] } },
      unread: ['memcpy', '__divsi3'],
    };
    expect(calleeBodiesDrift(frozen, relinked)).toBe('2 callee bodies differ: other, thunk_rnd');
  });
});

// What `bench fidelity` holds, run wherever a project's linked ELF is built: every frozen file is
// what the CLI's reader reads off that ELF today, for every callee it names. A relinked ELF or a
// change to cli elf-bodies.ts that moves a body the harness hands fails here by project and callee;
// the completeness test above it holds only the names. ASMLIFT_ALLOW_DIRTY_CHECKOUT=1 (a WIP
// checkout, which bench vendor and bench fidelity accept with a warning) skips it.
describe.skipIf(allowDirtyCheckout())(
  "the frozen callee bodies are the ones the CLI reads off each checkout's ELF",
  () => {
    const projects = loadCompleteManifests().filter((m) =>
      existsSync(join(REAL_DIR, 'tu', m.project, CALLEE_BODIES_FILE)),
    );
    test.each(projects.map((m) => [m.project, m] as const))(
      '%s',
      (project, man) => {
        const root = resolveProjectRoot(man);
        const loaded = searchDecompYaml(root);
        const elfRel = asmliftBlock(loaded)?.elf;
        const elf = loaded === null || elfRel === undefined ? undefined : resolve(loaded.dir, elfRel);
        if (elf === undefined || !existsSync(elf)) {
          return; // no checkout, or its ELF is not built: bench fidelity says so by name
        }
        const vendored = readVendoredCalleeBodies(project, join(REAL_DIR, 'tu', project), true)!;
        const target = calleeBodiesTarget(project)!;
        const names = [...Object.keys(vendored.bodies), ...vendored.unread];
        const derived = readCalleeBodies(
          project,
          { elf, elfRel: elfRel! },
          names,
          target,
          projectObjdump(root, target),
        );
        expect(calleeBodiesDrift(vendored, derived)).toBeNull();
      },
      120_000,
    ); // a project's cases and one objdump spawn per listing body: seconds, a minute under load
  },
);
