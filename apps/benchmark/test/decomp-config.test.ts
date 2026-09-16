// Parity tests for the committed toolchain configs (dataset/toolchains/<id>/decomp.yaml).
// Those files are live documentation of how to configure asmlift, but they also DRIVE candidate
// compilation — so their commands must stay equivalent to the built-in invocations in
// @asmlift/toolchains (same binaries, same flags, same order). Parity is the contract: the
// expected strings below are built from the same pins the built-in compile path uses, so a flag
// edited in only one place fails here loudly. Every compile passes the harness words first and the
// row's flags, which fill `{{cflags}}`, after them.
import { readCompilerCommand } from '@asmlift/cli/flags';
import { shellJoinFlags } from '@asmlift/core/codegen-flags';
import {
  type CanonicalToolchainId,
  TOOLCHAIN_TARGETS,
  isCanonicalToolchainId,
  isToolchainId,
} from '@asmlift/core/target';
import { GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN, mwccDir } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import YAML from 'yaml';

import { scoringPreludes } from '../src/compile/real';
import { shq } from '../src/compile/util';
import { materializeScoringContext, renderScoreCommand, writeScoreConfig } from '../src/decomp-config';

// The toolchains with canonical flags: the ones a committed config can be rendered at without a
// row to take the flags from.
const IDS = Object.keys(TOOLCHAIN_TARGETS).filter(isToolchainId).filter(isCanonicalToolchainId);
const canonical = (id: CanonicalToolchainId): readonly string[] => TOOLCHAIN_TARGETS[id].canonicalFlags;

describe('committed decomp.yaml configs mirror the built-in toolchain invocations', () => {
  test('agbcc: cpp → agbcc → as, built-in flags (compileCandAgbcc)', () => {
    expect(renderScoreCommand('agbcc', canonical('agbcc'))).toBe(
      [
        `cpp -P -nostdinc {{inputPath}} > {{inputPath}}.pp.c 2>/dev/null;`,
        `${shq(TOOLCHAIN.agbcc)} {{inputPath}}.pp.c -o {{inputPath}}.s`,
        `${[...TOOLCHAIN.harnessFlags, ...canonical('agbcc')].join(' ')} &&`,
        `${shq(TOOLCHAIN.as)} ${TOOLCHAIN.asFlags.join(' ')} {{inputPath}}.s -o {{outputPath}}`,
      ].join(' '),
    );
  });

  test('ido7.1: IDO cc, built-in flags (compileCandIdoC)', () => {
    expect(renderScoreCommand('ido7.1', canonical('ido7.1'))).toBe(
      [
        shq(IDO_TOOLCHAIN.cc),
        ...IDO_TOOLCHAIN.harnessFlags,
        ...canonical('ido7.1'),
        '-o {{outputPath}} {{inputPath}}',
      ].join(' '),
    );
  });

  test('gcc2.7.2kmc: one-shot docker run mirroring kmcCompile (image, mounts, flags)', () => {
    expect(renderScoreCommand('gcc2.7.2kmc', canonical('gcc2.7.2kmc'))).toBe(
      [
        `${shq(GCC_KMC_TOOLCHAIN.docker)} run --rm --platform linux/386`,
        `-v ${shq(GCC_KMC_TOOLCHAIN.dir)}:/kmc:ro -v "$(dirname {{inputPath}})":/work -e COMPILER_PATH=/kmc`,
        shq(GCC_KMC_TOOLCHAIN.image),
        '/kmc/gcc',
        ...GCC_KMC_TOOLCHAIN.harnessFlags,
        ...canonical('gcc2.7.2kmc'),
        `-c -o "/work/$(basename {{outputPath}})" "/work/$(basename {{inputPath}})"`,
      ].join(' '),
    );
  });

  test("mwcc_242_81: one-shot docker run mirroring ppcContainer's wibo invocation", () => {
    expect(renderScoreCommand('mwcc_242_81', canonical('mwcc_242_81'))).toBe(
      [
        `${shq(MWCC_PPC_TOOLCHAIN.docker)} run --rm`,
        `-v ${shq(mwccDir('mwcc_242_81'))}:/mwcc:ro -v "$(dirname {{inputPath}})":/work`,
        shq(MWCC_PPC_TOOLCHAIN.image),
        `${MWCC_PPC_TOOLCHAIN.wibo} /mwcc/mwcceppc.exe`,
        MWCC_PPC_TOOLCHAIN.harnessFlags.map(shq).join(' '),
        shellJoinFlags(canonical('mwcc_242_81')),
        `-o "/work/$(basename {{outputPath}})" "/work/$(basename {{inputPath}})"`,
      ].join(' '),
    );
  });

  // The CLI reads a project's flags off its compile command. A command rendered at a row's flags
  // must read back as exactly those flags, or a reproduction would report a different profile
  // from the one the row compiled at.
  test.each(IDS)('%s: the command rendered at a row’s flags reads back as those flags', (id) => {
    const { family } = TOOLCHAIN_TARGETS[id];
    const read = (cflags: readonly string[]) =>
      readCompilerCommand(renderScoreCommand(id, cflags), family)?.flagWords.map((w) => w.value);
    expect(read(canonical(id))).toEqual(canonical(id));
    const level = family === 'mwcc' ? '-O0,p' : '-O1';
    expect(read([...canonical(id), level, '-g'])).toEqual([...canonical(id), level, '-g']);
  });

  // The two real-only CodeWarrior builds have no canonical flags to render at, so the checks above
  // cannot reach them — and the one thing their configs must get right is the very thing that makes
  // them three configs rather than one: which compiler directory is mounted at /mwcc.
  test.each([
    ['mwcc_233_163n', ['-proc', 'gekko', '-O4,p', '-char', 'unsigned', '-lang=c++']],
    ['mwcc_247_107', ['-proc', 'gekko', '-O0,p', '-char', 'unsigned', '-lang=c']],
  ] as const)('%s: mounts its own build, and its command reads back the flags it was rendered at', (id, cflags) => {
    const cmd = renderScoreCommand(id, cflags);
    expect(cmd).toContain(`-v ${shq(mwccDir(id))}:/mwcc:ro`);
    for (const other of ['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as const) {
      expect(cmd.includes(`-v ${shq(mwccDir(other))}:/mwcc:ro`)).toBe(other === id);
    }
    expect(readCompilerCommand(cmd, 'mwcc')?.flagWords.map((w) => w.value)).toEqual([...cflags]);
    const template = readCompilerCommand(renderScoreCommand(id, ['{{cflags}}']), 'mwcc');
    expect(template?.takesCflags).toBe(true);
    expect(template?.flagWords).toEqual([]);
  });

  test.each(IDS)('%s: the template spells no codegen flag beside {{cflags}}', (id) => {
    const reading = readCompilerCommand(renderScoreCommand(id, ['{{cflags}}']), TOOLCHAIN_TARGETS[id].family);
    expect(reading?.takesCflags).toBe(true);
    expect(reading?.flagWords).toEqual([]);
  });
});

describe('writeScoreConfig (the repro decomp.yaml)', () => {
  interface Doc {
    tools: { asmlift: { target: string; compiler?: string; elf?: string } };
  }
  const written = (elf?: string, cflags: readonly string[] = canonical('agbcc')): Doc => {
    const dir = mkdtempSync(join(tmpdir(), 'score-config-'));
    try {
      writeScoreConfig('agbcc', cflags, dir, { elf });
      return YAML.parse(readFileSync(join(dir, 'decomp.yaml'), 'utf8')) as Doc;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('symbol-fed rows: the project ELF lands as tools.asmlift.elf beside the compile command', () => {
    const doc = written('/checkouts/pokeemerald/pokeemerald-syms.elf');
    expect(doc.tools.asmlift.elf).toBe('/checkouts/pokeemerald/pokeemerald-syms.elf');
    expect(doc.tools.asmlift.compiler).toBe(renderScoreCommand('agbcc', canonical('agbcc')));
    expect(doc.tools.asmlift.target).toBe('agbcc');
  });

  test('map-free rows: no elf key at all', () => {
    expect('elf' in written().tools.asmlift).toBe(false);
  });

  test("the command spells the row's flags", () => {
    const flags = ['-mthumb-interwork', '-O1'];
    expect(written(undefined, flags).tools.asmlift.compiler).toBe(renderScoreCommand('agbcc', flags));
  });
});

// Real rows are SCORED inside ONE rung of compile/real.ts's escalation ladder — `bench target`
// materializes that exact prelude as ctx.i and the generated compile command concatenates it
// ahead of every candidate, so the repro scripts grade in the same world the benchmark did.
// The ctx.i CONTENT is scoringPreludes' business (one definition, shared with the scorer);
// materializeScoringContext only puts the chosen rung on disk under the agreed name.
describe('real-row scoring context (ctx.i + wrapped compile command)', () => {
  interface Doc {
    tools: { asmlift: { target: string; compiler?: string; elf?: string } };
  }
  const inDir = <T>(f: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'score-ctx-'));
    try {
      return f(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  /** the richest rung — what `bench target` materializes for all but the escalation-stopped rows */
  const vendoredRung = (ctxI: string, sym: string, prependC = ''): string =>
    scoringPreludes(prependC, ctxI, sym).at(-1)!;

  test('every rung re-provides NULL (the vendored context is preprocessed — the macro is gone)', () => {
    for (const p of scoringPreludes('', 'typedef short s16;\n', 'f')) {
      expect(p.startsWith('#define NULL ((void *)0)\n')).toBe(true);
    }
  });

  test("the vendored rung strips the function's own prototype and keeps the rest verbatim", () => {
    const text = vendoredRung('typedef unsigned char u8;\ns32 keepMe(s32);\ns32 sq(s32);\n', 'sq');
    expect(text.endsWith('typedef unsigned char u8;\ns32 keepMe(s32);\n\n')).toBe(true); // verbatim, own proto gone
    expect(text).not.toContain('typedef unsigned char u8;typedef'); // the ctx already owns u8
    expect(text).toContain('typedef int s32;'); // …but not s32, so the prelude supplies it
  });

  test('the typedef guard is PER NAME — a context owning only s16 keeps the rest of the family', () => {
    // af's manifests are header-less (host cpp cannot preprocess them), so their vendored
    // context is literally `typedef short s16;`. An all-or-nothing guard either re-typedefs
    // s16 (C89 hard error → every candidate noncompiles) or leaves u8/u32/… undeclared.
    const text = vendoredRung('typedef short s16;\n', 'f');
    expect(text.match(/typedef short s16;/g)).toHaveLength(1);
    expect(text).toContain('typedef unsigned char u8;');
    expect(text).toContain('typedef int s32;');
  });

  test("a context that does not own u8 (af's header-less manifests) gets the typedef prelude", () => {
    // mirror of makeRealCompile's proDefsU8 guard, generalized to the vendored context: a
    // duplicate typedef is a C89 hard error, a missing one makes every candidate noncompile
    expect(vendoredRung('typedef struct { unsigned int w0; } Gfx;\n', 'sq')).toContain('typedef unsigned char u8;');
    // and one that already owns u8 must NOT get a second copy
    expect(vendoredRung('typedef uint8_t u8;\n', 'sq')).not.toContain('typedef unsigned char u8;');
  });

  test('materializeScoringContext writes the CHOSEN rung verbatim as ctx.i', () => {
    inDir((dir) => {
      // the rung is not always the richest: a project prototype can reject what bare typedefs
      // accept, and materializing the vendored ctx for such a row leaves NO scorable candidate
      const rung1 = scoringPreludes('', 'u32 thunk(void);\n', 'f')[0];
      expect(materializeScoringContext(rung1, dir)).toBe('ctx.i');
      expect(readFileSync(join(dir, 'ctx.i'), 'utf8')).toBe(rung1);
      expect(readFileSync(join(dir, 'ctx.i'), 'utf8')).not.toContain('u32 thunk(void);');
    });
  });

  test('the generated compile command concatenates ctx.i ahead of the candidate', () => {
    inDir((dir) => {
      writeScoreConfig('agbcc', canonical('agbcc'), dir, { ctxFile: 'ctx.i' });
      const doc = YAML.parse(readFileSync(join(dir, 'decomp.yaml'), 'utf8')) as Doc;
      expect(doc.tools.asmlift.compiler).toBe(
        'cat ctx.i {{inputPath}} > {{inputPath}}.ctx.c && ' +
          renderScoreCommand('agbcc', canonical('agbcc')).replaceAll('{{inputPath}}', '{{inputPath}}.ctx.c'),
      );
    });
  });

  test("a CodeWarrior row's command states its dialect, and a C++ row's encloses the candidate", () => {
    inDir((dir) => {
      // The reproduction writes its candidate to a `.c` path, so the dialect cannot be left to the
      // extension — and a C++ row's candidate must be enclosed in the same linkage block the
      // scorer compiles it in, or it mangles a second time and aligns to nothing.
      writeScoreConfig('mwcc_242_81', canonical('mwcc_242_81'), dir, { ctxFile: 'ctx.i', language: 'c++' });
      const cpp = (YAML.parse(readFileSync(join(dir, 'decomp.yaml'), 'utf8')) as Doc).tools.asmlift.compiler;
      expect(cpp).toContain(`{ cat ctx.i; echo 'extern "C" {'; cat {{inputPath}}; echo '}'; } > {{inputPath}}.ctx.c`);
      expect(cpp).toContain('-lang=c++');

      writeScoreConfig('mwcc_242_81', canonical('mwcc_242_81'), dir, { ctxFile: 'ctx.i', language: 'c' });
      const c = (YAML.parse(readFileSync(join(dir, 'decomp.yaml'), 'utf8')) as Doc).tools.asmlift.compiler;
      expect(c).toContain('cat ctx.i {{inputPath}} > {{inputPath}}.ctx.c');
      expect(c).toContain('-lang=c');
      expect(c).not.toContain('extern "C"');
    });
  });

  test('every toolchain template stays substitutable after the wrap (placeholders intact)', () => {
    inDir((dir) => {
      for (const id of ['agbcc', 'ido7.1', 'gcc2.7.2', 'gcc2.7.2kmc'] as const) {
        writeScoreConfig(id, canonical(id), dir, { ctxFile: 'ctx.i' });
        const doc = YAML.parse(readFileSync(join(dir, 'decomp.yaml'), 'utf8')) as Doc;
        expect(doc.tools.asmlift.compiler, id).toContain('{{inputPath}}');
        expect(doc.tools.asmlift.compiler, id).toContain('{{outputPath}}');
        expect(doc.tools.asmlift.compiler, id).toContain('cat ctx.i {{inputPath}}');
      }
    });
  });
});
