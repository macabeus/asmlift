// CLI --score-against, END TO END with the real toolchain: the emitted source (and its ranked
// candidates) compile and objdiff-score against a real target object — through a USER compile
// command (decomp.yaml tools.asmlift.compiler) that reproduces the byte-exact match with the
// project's "own" toolchain. The command template is built at runtime from toolchain.ts (never
// hardcoded paths).
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { TOOLCHAIN } from '@asmlift/toolchains';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { runCli } from '../../src/main';

const REFERENCE_C = 'unsigned ushr(unsigned x){ return x >> 1; }';

function fixture() {
  const asm = compileTargetAsm(REFERENCE_C);
  const obj = assembleTarget(asm);
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-sae2e-'));
  const asmPath = join(dir, 'ushr.s');
  writeFileSync(asmPath, asm);
  return { dir, asmPath, obj };
}

describe('CLI --score-against (agbcc, real toolchain)', () => {
  test('user compile command from decomp.yaml reproduces the byte-exact match', async () => {
    const { dir, asmPath, obj } = fixture();
    // The "project's own toolchain": the same agbcc invocation the built-in uses, expressed
    // as a decomp.yaml command template (cpp → agbcc → as, chained under sh).
    const cmd = [
      `cpp -P -nostdinc {{inputPath}} > {{inputPath}}.pp.c`,
      `${TOOLCHAIN.agbcc} {{inputPath}}.pp.c -o {{inputPath}}.s ${TOOLCHAIN.agbccFlags.join(' ')}`,
      `${TOOLCHAIN.as} ${TOOLCHAIN.asFlags.join(' ')} {{inputPath}}.s -o {{outputPath}}`,
    ].join(' && ');
    writeFileSync(
      join(dir, 'decomp.yaml'),
      `platform: gba\ntools:\n  asmlift:\n    compiler: ${JSON.stringify(cmd)}\n`,
    );
    const r = await runCli([asmPath, '--name', 'ushr', '--score-against', obj]);
    expect(r.stderr).toContain('[config] target agbcc'); // resolved from the platform
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ushr(u32 a0)');
    expect(r.stderr).toContain('(match)');
  });

  test('a failing user command is a loud scoring error, never a silent fallback', async () => {
    const { dir, asmPath, obj } = fixture();
    writeFileSync(
      join(dir, 'decomp.yaml'),
      `platform: gba\ntools:\n  asmlift:\n    compiler: "echo wrong-mwcc-version >&2; false # {{inputPath}} {{outputPath}}"\n`,
    );
    const r = await runCli([asmPath, '--name', 'ushr', '--score-against', obj]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('wrong-mwcc-version');
    expect(r.stdout).toBe(''); // nothing pretending to be scored
  });
});
