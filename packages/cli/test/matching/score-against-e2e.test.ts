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
    // WHICH TREE produced the score, on the score's own line — the wiring, not just the formatter
    // (src/provenance.ts, provenance.test.ts). A run against different sources used to leave
    // evidence identical to a clean one, and this is the only line anyone is told to quote.
    expect(r.stderr).toMatch(
      /asmlift: \[ranked\] \d+ candidate\(s\) scored, \d+ dropped, best [^\n]*\[asmlift source [0-9a-f]{7}[^\]]*\]\n/,
    );
  });

  test("--progress reports where the run's time went; without it the log is unchanged", async () => {
    const { dir, asmPath, obj } = fixture();
    const cmd = [
      `cpp -P -nostdinc {{inputPath}} > {{inputPath}}.pp.c`,
      `${TOOLCHAIN.agbcc} {{inputPath}}.pp.c -o {{inputPath}}.s ${TOOLCHAIN.agbccFlags.join(' ')}`,
      `${TOOLCHAIN.as} ${TOOLCHAIN.asFlags.join(' ')} {{inputPath}}.s -o {{outputPath}}`,
    ].join(' && ');
    writeFileSync(
      join(dir, 'decomp.yaml'),
      `platform: gba\ntools:\n  asmlift:\n    compiler: ${JSON.stringify(cmd)}\n`,
    );

    // pooled: compile and score are separate awaits, so the two are charged apart
    const pooled = await runCli([asmPath, '--name', 'ushr', '--score-against', obj, '--jobs', '2', '--progress']);
    expect(pooled.code).toBe(0);
    expect(pooled.stderr).toMatch(
      /asmlift: \[phase] wall \d+\.\d+s · enumerate \d+\.\d+s \(1 call\) · compile \d+\.\d+s over 2 workers \(\d+ calls\) · score \d+\.\d+s \(\d+ calls\) · rank \d+\.\d+s \(1 call\) · main-thread idle\+other \d+\.\d+s\n/,
    );
    // serial: the compile happens inside the call that scores, and is charged apart anyway —
    // and, having held the main thread, it is not counted as idle on top (phase.ts)
    const serial = await runCli([asmPath, '--name', 'ushr', '--score-against', obj, '--progress']);
    expect(serial.stderr).toMatch(
      /asmlift: \[phase] .* compile \d+\.\d+s \(\d+ calls\) · score \d+\.\d+s \(\d+ calls\)/,
    );

    const quiet = await runCli([asmPath, '--name', 'ushr', '--score-against', obj]);
    expect(quiet.stderr).not.toContain('[phase]');
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
