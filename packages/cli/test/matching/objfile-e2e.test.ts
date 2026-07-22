// Object-file CLI input, END TO END with real toolchains: compile reference C → a real .o →
// run the CLI on the OBJECT (no asm text anywhere) → the emitted source is the same as the
// text path's, and a dense switch proves the AsmData side-table was extracted automatically.
import { compileMipsTarget } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { runCli } from '../../src/main';

const readBytes = (p: string) => new Uint8Array(readFileSync(p));

describe('CLI .o input (IDO, real objdump)', () => {
  test('straight-line function from a real object matches the text path', async () => {
    const { obj, asm } = compileMipsTarget('int add1(int x){ return x + 1; }', 'add1');
    const viaObj = await runCli([obj, '--target', 'ido7.1', '--name', 'add1'], readBytes);
    const viaText = await runCli(['in.asm', '--target', 'ido7.1', '--name', 'add1'], () => asm);
    expect(viaObj.code).toBe(0);
    expect(viaObj.stdout).toBe(viaText.stdout);
    expect(viaObj.stdout).toContain('return a0 + 1;');
  });

  test('dense switch recovers from a real object — AsmData extracted automatically', async () => {
    const C = `int swjt(int x){ switch(x){ case 0: return 7; case 1: return 42; case 2: return 9;
      case 3: return 13; case 4: return 5; case 5: return 31; default: return -1; } }`;
    const { obj } = compileMipsTarget(C, 'swjt');
    const r = await runCli([obj, '--target', 'ido7.1', '--name', 'swjt'], readBytes);
    expect(r.stderr).not.toContain('warning'); // the side-table extraction succeeded
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('switch (');
    expect(r.stdout).toContain('case 5:');
  });
});
