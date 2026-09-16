// Which ELF a row is read with (cases/project-elf.ts). A row with a linked address is read with
// the ELF decomp.yaml names; a row in a GameCube REL module is read with that module's own ELF,
// which the project's build writes beside it. These pin the three answers a caller acts on:
// the base ELF, a module's ELF, and a module with no ELF built — refused by the path looked for.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { resolveProjectElf } from '../src/cases/project-elf';

/** A dtk checkout: decomp.yaml naming the base ELF, and one module ELF beside it. */
function checkout(withModule: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-projelf-'));
  mkdirSync(join(root, 'build', 'GMPE01_00'), { recursive: true });
  writeFileSync(join(root, 'build', 'GMPE01_00', 'main.elf'), '');
  if (withModule) {
    mkdirSync(join(root, 'build', 'GMPE01_00', 'm416Dll'));
    writeFileSync(join(root, 'build', 'GMPE01_00', 'm416Dll', 'm416Dll.plf'), '');
  }
  writeFileSync(join(root, 'decomp.yaml'), 'platform: gc\ntools:\n  asmlift:\n    elf: build/GMPE01_00/main.elf\n');
  return root;
}

describe('resolveProjectElf', () => {
  test('no module: the ELF decomp.yaml names', () => {
    const root = checkout(true);
    expect(resolveProjectElf('marioparty4', root)).toEqual({
      elf: join(root, 'build', 'GMPE01_00', 'main.elf'),
      elfRel: 'build/GMPE01_00/main.elf',
    });
  });

  test("a module: the module's own ELF, beside the base one", () => {
    const root = checkout(true);
    expect(resolveProjectElf('marioparty4', root, 'm416Dll')).toEqual({
      elf: join(root, 'build', 'GMPE01_00', 'm416Dll', 'm416Dll.plf'),
      elfRel: 'build/GMPE01_00/m416Dll/m416Dll.plf',
    });
  });

  test("the base ELF's own name is no module: it is its own symbol source", () => {
    const root = checkout(true);
    expect(resolveProjectElf('marioparty4', root, 'main')).toEqual(resolveProjectElf('marioparty4', root));
  });

  test('a module with no ELF built is refused by the path looked for', () => {
    const root = checkout(false);
    const res = resolveProjectElf('marioparty4', root, 'm416Dll');
    expect(res.elf).toBeNull();
    expect(res.elfRel).toBe('build/GMPE01_00/m416Dll/m416Dll.plf');
    expect(res).toMatchObject({ reason: expect.stringContaining('build/GMPE01_00/m416Dll/m416Dll.plf') });
  });

  test('no declared ELF: no module can be resolved either', () => {
    const root = mkdtempSync(join(tmpdir(), 'asmlift-projelf-'));
    writeFileSync(join(root, 'decomp.yaml'), 'platform: gc\ntools:\n  asmlift:\n    target: mwcc_242_81\n');
    expect(resolveProjectElf('marioparty4', root, 'm416Dll')).toEqual({
      elf: null,
      elfRel: null,
      reason: 'decomp.yaml declares no tools.asmlift.elf',
    });
  });
});
