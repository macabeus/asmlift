// The af recipe's host checks (cases/project-setup.ts) on a Linux host: the big-endian MIPS
// binutils may live anywhere on PATH — Ubuntu's binutils-mips-linux-gnu, not only a /opt/cross
// build — and the Rosetta probe (`arch -x86_64`, a macOS verb that is an invalid option to GNU
// `arch`) must not run at all.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

import { PROJECT_RECIPES } from '../src/cases/project-setup';

const scratch = mkdtempSync(join(tmpdir(), 'af-recipe-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A checkout every `prepare` step already sees as done, so passing the host checks runs nothing. */
const preparedCheckout = (name: string): string => {
  const dir = join(scratch, name);
  for (const d of ['.venv', join('baseroms', 'jp'), join('asm', 'jp'), join('assets', 'jp')]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, 'baseroms', 'jp', 'baserom-decompressed.z64'), '');
  writeFileSync(join(dir, 'asm', 'jp', 'a.s'), '');
  writeFileSync(join(dir, 'assets', 'jp', 'a.bin'), '');
  return dir;
};

describe.runIf(process.platform === 'linux')('the af recipe on a Linux host', () => {
  // afBuildEnv always prepends /usr/bin, so a host with the distro package (the README's own
  // remedy) would pass the check and leave this test with nothing to assert: skip it there, so a
  // vacuous pass reads as a skip. CI's runner has no mips binutils, so it runs there.
  test.skipIf(existsSync('/usr/bin/mips-linux-gnu-ld') || existsSync('/opt/cross/bin/mips-linux-gnu-ld'))(
    'without mips-linux-gnu-ld anywhere, it names the binutils and the apt remedy',
    () => {
      process.env.PATH = join(scratch, 'empty-bin');
      mkdirSync(process.env.PATH, { recursive: true });
      const dir = preparedCheckout('no-binutils');
      let refusal = '';
      try {
        PROJECT_RECIPES.af.prepare?.(dir);
      } catch (e) {
        refusal = String(e);
      }
      expect(refusal).toContain('missing host prerequisite — big-endian mips-linux-gnu binutils');
      expect(refusal).toContain('apt install binutils-mips-linux-gnu');
    },
  );

  test('with mips-linux-gnu-ld on PATH it passes the host checks and never probes for Rosetta', () => {
    const bin = join(scratch, 'bin');
    mkdirSync(bin, { recursive: true });
    const ld = join(bin, 'mips-linux-gnu-ld');
    writeFileSync(ld, '#!/bin/sh\necho "GNU ld (fake) 2.42"\n');
    chmodSync(ld, 0o755);
    // `arch` here is the GNU one, so a Rosetta probe would throw: a clean return proves it is gated
    process.env.PATH = `${bin}:${savedPath ?? ''}`;
    expect(() => PROJECT_RECIPES.af.prepare?.(preparedCheckout('with-binutils'))).not.toThrow();
  });
});
