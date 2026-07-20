// Parity tests for the committed toolchain configs (dataset/toolchains/<id>/decomp.yaml).
// Those files are live documentation of how to configure asmlift, but they also DRIVE candidate
// compilation — so their commands must stay equivalent to the built-in invocations in
// @asmlift/toolchains (same binaries, same flags, same order). Parity is the contract: the
// expected strings below are built from the same pins the built-in compile path uses, so a flag
// edited in only one place fails here loudly.
import { GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { shq } from '../src/compile/util';
import { renderScoreCommand } from '../src/decomp-config';

describe('committed decomp.yaml configs mirror the built-in toolchain invocations', () => {
  test('agbcc-arm: cpp → agbcc → as, built-in flags (compileCandAgbcc)', () => {
    expect(renderScoreCommand('agbcc-arm')).toBe(
      [
        `cpp -P -nostdinc {{inputPath}} > {{inputPath}}.pp.c 2>/dev/null;`,
        `${shq(TOOLCHAIN.agbcc)} {{inputPath}}.pp.c -o {{inputPath}}.s ${TOOLCHAIN.agbccFlags.join(' ')} &&`,
        `${shq(TOOLCHAIN.as)} ${TOOLCHAIN.asFlags.join(' ')} {{inputPath}}.s -o {{outputPath}}`,
      ].join(' '),
    );
  });

  test('ido-mips: IDO cc, built-in flags (compileCandIdoC)', () => {
    expect(renderScoreCommand('ido-mips')).toBe(
      `${shq(IDO_TOOLCHAIN.cc)} ${IDO_TOOLCHAIN.ccFlags.join(' ')} -o {{outputPath}} {{inputPath}}`,
    );
  });

  test('gcc-mips: one-shot docker run mirroring kmcCompile (image, mounts, flags)', () => {
    expect(renderScoreCommand('gcc-mips')).toBe(
      [
        `${shq(GCC_KMC_TOOLCHAIN.docker)} run --rm --platform linux/386`,
        `-v ${shq(GCC_KMC_TOOLCHAIN.dir)}:/kmc:ro -v "$(dirname {{inputPath}})":/work -e COMPILER_PATH=/kmc`,
        shq(GCC_KMC_TOOLCHAIN.image),
        `/kmc/gcc ${GCC_KMC_TOOLCHAIN.ccFlags.join(' ')} -c -o "/work/$(basename {{outputPath}})" "/work/$(basename {{inputPath}})"`,
      ].join(' '),
    );
  });

  test("mwcc-ppc: one-shot docker run mirroring ppcContainer's wibo invocation", () => {
    expect(renderScoreCommand('mwcc-ppc')).toBe(
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
