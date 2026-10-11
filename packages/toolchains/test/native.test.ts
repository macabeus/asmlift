// The decision half of the native path (src/native.ts), which needs no toolchain: how
// `ASMLIFT_NATIVE` parses, which hosts are even probed, and what counts as a binary that runs.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { binaryRuns, hostRunsI386Elf, nativeMode } from '../src/native';

const scratch = mkdtempSync(join(tmpdir(), 'native-probe-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('ASMLIFT_NATIVE', () => {
  test.each([
    [undefined, 'auto'],
    ['', 'auto'],
    ['auto', 'auto'],
    ['0', 'off'],
    ['off', 'off'],
    ['OFF', 'off'],
    ['1', 'on'],
    ['on', 'on'],
    [' true ', 'on'],
  ] as const)('%j is %s', (value, mode) => {
    expect(nativeMode(value)).toBe(mode);
  });

  test('an unrecognized value is an error, not a guess', () => {
    expect(() => nativeMode('of')).toThrow('ASMLIFT_NATIVE="of"');
  });
});

describe('which hosts are probed', () => {
  test.each([
    ['linux', 'x64', true],
    ['linux', 'ia32', true],
    ['linux', 'arm64', false],
    ['darwin', 'arm64', false],
    ['darwin', 'x64', false],
    ['win32', 'x64', false],
  ] as const)('%s/%s → %s', (platform, arch, probed) => {
    expect(hostRunsI386Elf(platform, arch)).toBe(probed);
  });
});

describe('a binary that runs', () => {
  const script = (name: string, body: string): string => {
    const p = join(scratch, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  test('is one the kernel executed and that printed what was expected, whatever its exit status', () => {
    expect(binaryRuns(script('gcc-ok', 'echo 2.7.2'), ['--version'], /2\.7\.2/)).toBe(true);
    // a bare wibo prints its usage and exits 1
    expect(binaryRuns(script('wibo-usage', 'echo "Usage: ./wibo program.exe ..." >&2; exit 1'), [], /usage/i)).toBe(
      true,
    );
  });

  test('is not one that is missing, or that printed something else', () => {
    expect(binaryRuns(join(scratch, 'absent'), ['--version'], /2\.7\.2/)).toBe(false);
    expect(binaryRuns(script('other-gcc', 'echo 13.3.0'), ['--version'], /2\.7\.2/)).toBe(false);
  });
});
