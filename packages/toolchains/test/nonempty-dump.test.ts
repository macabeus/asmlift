// A DUMP STEP THAT EXITS 0 AND SAYS NOTHING has to raise, because nothing downstream can tell it
// apart from a function with no instructions or an object with no data section.
//
// `packages/toolchains` runs those steps and had no test directory: until `vitest.config.ts` grew
// this one, `nonEmptyDump` and its eight call sites were a mechanism no row could reach.
// TOOLCHAIN-FREE by construction — the "objdump" and "cc" here are two-line shell scripts, so every
// case runs on a hosted runner with no Docker, no IDO and no CodeWarrior.
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { mipsObjdumpText } from '../src/asmdata';
import { nonEmptyDump } from '../src/compile';

/** A stand-in binary that exits 0 after printing `out` verbatim (empty for the failure under
 *  test). The text goes through a file rather than the script body, so newlines survive. */
const fakeBin = (name: string, out: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nonempty-dump-'));
  const payload = join(dir, 'out.txt');
  writeFileSync(payload, out);
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\ncat ${JSON.stringify(payload)}\n`);
  chmodSync(p, 0o755);
  return p;
};

const anObject = (): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'nonempty-dump-obj-')), 'a.o');
  writeFileSync(p, 'not really an object');
  return p;
};

describe('nonEmptyDump', () => {
  test('empty and whitespace-only both raise, naming the step', () => {
    expect(() => nonEmptyDump('', 'objdump on a.o')).toThrow(/objdump on a\.o exited 0 but produced NO output/);
    expect(() => nonEmptyDump(' \n\t\n', 'objdump on a.o')).toThrow(/refusing an empty dump/);
  });

  test('any real content passes through unchanged, byte for byte', () => {
    const dump = 'a.o:     file format elf32-tradbigmips\n';
    expect(nonEmptyDump(dump, 'objdump on a.o')).toBe(dump);
  });
});

describe('the dump steps this package runs', () => {
  test('an asmdata objdump that prints nothing raises instead of parsing as empty AsmData', () => {
    expect(() => mipsObjdumpText(anObject(), fakeBin('objdump', ''))).toThrow(/exited 0 but produced NO output/);
  });

  test('the same call with output returns it', () => {
    const dump = 'a.o:     file format elf32-tradbigmips\nSYMBOL TABLE:\n';
    expect(mipsObjdumpText(anObject(), fakeBin('objdump', dump))).toBe(dump);
  });

  // THE REFERENCE-BUILD DISASSEMBLY IS A DIFFERENT OBJDUMP INVOCATION from the asmdata dump above
  // (`-d` versus `-s -r -t`), and it is the one whose silent failure reached a content-keyed cache
  // as a zero-byte `.asm` and surfaced days later as `disasmToM2c: could not parse objdump output`.
  // It went unguarded while the asmdata dumps were guarded, so it gets its own row: a `cc` that
  // writes an empty object and an `objdump` that prints nothing, standing in for the real pair.
  test('a reference build whose disassembly is empty raises', async () => {
    const objdump = fakeBin('objdump', '');
    const cc = join(mkdtempSync(join(tmpdir(), 'nonempty-dump-cc-')), 'cc');
    writeFileSync(cc, '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then shift; : > "$1"; fi; shift; done\n');
    chmodSync(cc, 0o755);
    expect(existsSync(cc)).toBe(true);

    vi.doMock('../src/toolchain', async () => {
      const real = await vi.importActual<typeof import('../src/toolchain')>('../src/toolchain');
      return { ...real, IDO_TOOLCHAIN: { ...real.IDO_TOOLCHAIN, cc, ccFlags: [], objdump, objdumpFlags: [] } };
    });
    vi.resetModules();
    const { compileMipsTarget } = await import('../src/compile');
    expect(() => compileMipsTarget('int f(void){return 0;}', 'f')).toThrow(/exited 0 but produced NO output/);
    vi.doUnmock('../src/toolchain');
    vi.resetModules();
  });
});
