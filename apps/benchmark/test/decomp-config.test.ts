// Parity tests for the committed toolchain configs (dataset/toolchains/<id>/decomp.yaml).
// Those files are live documentation of how to configure asmlift, but they also DRIVE candidate
// compilation — so their commands must stay equivalent to the built-in invocations in
// @asmlift/toolchains (same binaries, same flags, same order). Parity is the contract: the
// expected strings below are built from the same pins the built-in compile path uses, so a flag
// edited in only one place fails here loudly.
import { GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN } from '@asmlift/toolchains';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import YAML from 'yaml';

import { shq } from '../src/compile/util';
import { renderScoreCommand, writeScoreConfig } from '../src/decomp-config';

describe('committed decomp.yaml configs mirror the built-in toolchain invocations', () => {
  test('agbcc: cpp → agbcc → as, built-in flags (compileCandAgbcc)', () => {
    expect(renderScoreCommand('agbcc')).toBe(
      [
        `cpp -P -nostdinc {{inputPath}} > {{inputPath}}.pp.c 2>/dev/null;`,
        `${shq(TOOLCHAIN.agbcc)} {{inputPath}}.pp.c -o {{inputPath}}.s ${TOOLCHAIN.agbccFlags.join(' ')} &&`,
        `${shq(TOOLCHAIN.as)} ${TOOLCHAIN.asFlags.join(' ')} {{inputPath}}.s -o {{outputPath}}`,
      ].join(' '),
    );
  });

  test('ido7.1: IDO cc, built-in flags (compileCandIdoC)', () => {
    expect(renderScoreCommand('ido7.1')).toBe(
      `${shq(IDO_TOOLCHAIN.cc)} ${IDO_TOOLCHAIN.ccFlags.join(' ')} -o {{outputPath}} {{inputPath}}`,
    );
  });

  test('gcc2.7.2kmc: one-shot docker run mirroring kmcCompile (image, mounts, flags)', () => {
    expect(renderScoreCommand('gcc2.7.2kmc')).toBe(
      [
        `${shq(GCC_KMC_TOOLCHAIN.docker)} run --rm --platform linux/386`,
        `-v ${shq(GCC_KMC_TOOLCHAIN.dir)}:/kmc:ro -v "$(dirname {{inputPath}})":/work -e COMPILER_PATH=/kmc`,
        shq(GCC_KMC_TOOLCHAIN.image),
        `/kmc/gcc ${GCC_KMC_TOOLCHAIN.ccFlags.join(' ')} -c -o "/work/$(basename {{outputPath}})" "/work/$(basename {{inputPath}})"`,
      ].join(' '),
    );
  });

  test("mwcc_242_81: one-shot docker run mirroring ppcContainer's wibo invocation", () => {
    expect(renderScoreCommand('mwcc_242_81')).toBe(
      [
        `${shq(MWCC_PPC_TOOLCHAIN.docker)} run --rm`,
        `-v ${shq(MWCC_PPC_TOOLCHAIN.dir)}:/mwcc:ro -v "$(dirname {{inputPath}})":/work`,
        shq(MWCC_PPC_TOOLCHAIN.image),
        `${MWCC_PPC_TOOLCHAIN.wibo} /mwcc/mwcceppc.exe ${MWCC_PPC_TOOLCHAIN.ccFlags.map(shq).join(' ')}`,
        `-o "/work/$(basename {{outputPath}})" "/work/$(basename {{inputPath}})"`,
      ].join(' '),
    );
  });
});

describe('writeScoreConfig (the repro decomp.yaml)', () => {
  interface Doc {
    tools: { asmlift: { target: string; compiler?: string; elf?: string } };
  }
  const written = (elf?: string): Doc => {
    const dir = mkdtempSync(join(tmpdir(), 'score-config-'));
    try {
      writeScoreConfig('agbcc', dir, elf);
      return YAML.parse(readFileSync(join(dir, 'decomp.yaml'), 'utf8')) as Doc;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('symbol-fed rows: the project ELF lands as tools.asmlift.elf beside the compile command', () => {
    const doc = written('/checkouts/pokeemerald/pokeemerald-syms.elf');
    expect(doc.tools.asmlift.elf).toBe('/checkouts/pokeemerald/pokeemerald-syms.elf');
    expect(doc.tools.asmlift.compiler).toBe(renderScoreCommand('agbcc'));
    expect(doc.tools.asmlift.target).toBe('agbcc');
  });

  test('map-free rows: no elf key at all', () => {
    expect('elf' in written().tools.asmlift).toBe(false);
  });
});
