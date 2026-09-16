// A REL module's symbol map (src/module-elf.ts + loadModuleSymbolMap).
//
// A GameCube module builds to a RELOCATABLE `<module>.plf` whose allocated sections all start at
// address 0. Read as an ordinary ELF, such a file yields a map where the first function, the first
// data word and the first BSS variable share the address 0x0 — silently, since a map full of
// aliases loads exactly like a map full of symbols. These tests pin the two halves of the answer:
// such a file is REFUSED as `tools.asmlift.elf`, and the module map reached with `--module` places
// each section at a base of its own and inherits only what a module may refer to in the base ELF.
import { symbolsByName } from '@asmlift/core/symbols';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { runCli } from '../../src/main';
import {
  assertPlaced,
  globalSymbolKeys,
  moduleElfPath,
  moduleFunctionLocations,
  placeModuleSections,
  symbolKey,
} from '../../src/module-elf';
import { loadModuleSymbolMap, loadSymbolMap } from '../../src/symbols-provider';

const ET_REL = 1;
const ET_EXEC = 2;
const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHF_ALLOC = 0x2;
const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STT_OBJECT = 1;
const STT_FUNC = 2;

interface SecSpec {
  name: string;
  type?: number;
  flags?: number;
  addr?: number;
  size: number;
}
interface SymSpec {
  name: string;
  value: number;
  /** 1-based index into `sections` */
  shndx: number;
  size?: number;
  type?: number;
  bind?: number;
}

/** A big-endian ELF32 with the given allocated sections plus `.symtab`/`.strtab`/`.shstrtab` —
 *  every part the symbol reader and the placer look at. PROGBITS bodies are zero-filled: nothing
 *  here reads section CONTENT, only the headers and the symbol table. */
function elf32(type: number, sections: readonly SecSpec[], symbols: readonly SymSpec[]): Buffer {
  const strings = (items: readonly string[]) => {
    const at = new Map<string, number>();
    const bytes: number[] = [0];
    for (const s of items) {
      at.set(s, bytes.length);
      bytes.push(...Buffer.from(s, 'latin1'), 0);
    }
    return { at, buf: Buffer.from(bytes) };
  };
  const strtab = strings(symbols.map((s) => s.name));
  const symtab = Buffer.alloc(16 * (symbols.length + 1));
  symbols.forEach((s, i) => {
    const at = 16 * (i + 1);
    symtab.writeUInt32BE(strtab.at.get(s.name)!, at);
    symtab.writeUInt32BE(s.value, at + 4);
    symtab.writeUInt32BE(s.size ?? 4, at + 8);
    symtab[at + 12] = ((s.bind ?? STB_GLOBAL) << 4) | (s.type ?? STT_FUNC);
    symtab.writeUInt16BE(s.shndx, at + 14);
  });
  const names = [...sections.map((s) => s.name), '.symtab', '.strtab', '.shstrtab'];
  const shstrtab = strings(names);

  // section 0 is the null entry; then the spec'd sections, .symtab, .strtab, .shstrtab
  const bodies = [
    ...sections.map((s) => (s.type === SHT_NOBITS ? Buffer.alloc(0) : Buffer.alloc(s.size))),
    symtab,
    strtab.buf,
    shstrtab.buf,
  ];
  const offsets: number[] = [];
  let at = 52;
  for (const b of bodies) {
    offsets.push(at);
    at += b.length;
  }
  const shnum = sections.length + 4;
  const shoff = at;
  const out = Buffer.alloc(shoff + 40 * shnum);
  out.writeUInt32BE(0x7f454c46, 0);
  out[4] = 1; // ELFCLASS32
  out[5] = 2; // ELFDATA2MSB
  out[6] = 1;
  out.writeUInt16BE(type, 0x10);
  out.writeUInt16BE(20, 0x12); // EM_PPC
  out.writeUInt32BE(shoff, 0x20);
  out.writeUInt16BE(52, 0x28);
  out.writeUInt16BE(40, 0x2e);
  out.writeUInt16BE(shnum, 0x30);
  out.writeUInt16BE(shnum - 1, 0x32); // e_shstrndx
  bodies.forEach((b, i) => b.copy(out, offsets[i]));
  const header = (i: number, name: string, secType: number, flags: number, addr: number, size: number, link = 0) => {
    const sh = shoff + 40 * i;
    out.writeUInt32BE(shstrtab.at.get(name)!, sh);
    out.writeUInt32BE(secType, sh + 4);
    out.writeUInt32BE(flags, sh + 8);
    out.writeUInt32BE(addr, sh + 12);
    out.writeUInt32BE(offsets[i - 1], sh + 16);
    out.writeUInt32BE(size, sh + 20);
    out.writeUInt32BE(link, sh + 24);
    out.writeUInt32BE(secType === 2 ? 16 : 0, sh + 36);
  };
  sections.forEach((s, i) => header(i + 1, s.name, s.type ?? SHT_PROGBITS, s.flags ?? SHF_ALLOC, s.addr ?? 0, s.size));
  header(sections.length + 1, '.symtab', 2, 0, 0, symtab.length, sections.length + 2);
  header(sections.length + 2, '.strtab', 3, 0, 0, strtab.buf.length);
  header(sections.length + 3, '.shstrtab', 3, 0, 0, shstrtab.buf.length);
  return out;
}

/** A Mario-Party-4-shaped module: `.text`, `.data` and `.bss` all at 0, each holding a symbol at
 *  offset 0, plus the `_ctors` every module carries under the same name as the DOL's. */
const modulePlf = () =>
  elf32(
    ET_REL,
    [
      { name: '.text', size: 0x100 },
      { name: '.data', size: 0x20 },
      { name: '.bss', type: SHT_NOBITS, size: 0x10 },
    ],
    [
      { name: 'ObjectSetup', value: 0x0, shndx: 1 },
      { name: '_prolog', value: 0x40, shndx: 1 },
      { name: 'stageSprId', value: 0x0, shndx: 2, type: STT_OBJECT },
      { name: '_ctors', value: 0x10, shndx: 2, type: STT_OBJECT },
      { name: 'timerSec', value: 0x0, shndx: 3, type: STT_OBJECT },
    ],
  );

/** The linked DOL: globals another object may refer to, one file-static that it may not, and a
 *  `_ctors` of its own for the module to shadow. */
const dolElf = () =>
  elf32(
    ET_EXEC,
    [
      { name: '.text', addr: 0x8000_3100, size: 0x200 },
      { name: '.data', addr: 0x8030_0000, size: 0x40 },
    ],
    [
      { name: 'OSReport', value: 0x8000_3100, shndx: 1 },
      { name: 'seqSpeed', value: 0x8000_3200, shndx: 1 },
      { name: 'hostMdl', value: 0x8030_0000, shndx: 2, type: STT_OBJECT, bind: STB_LOCAL },
      { name: '_ctors', value: 0x8030_0020, shndx: 2, type: STT_OBJECT },
    ],
  );

const dir = mkdtempSync(join(tmpdir(), 'asmlift-modelf-'));
const write = (name: string, bytes: Buffer): string => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

describe('moduleElfPath — the layout rule the CLI and the benchmark share', () => {
  test("a module's ELF sits beside the base ELF, at <module>/<module>.plf", () => {
    expect(moduleElfPath('/p/build/GMPE01_00/main.elf', 'm416Dll')).toBe('/p/build/GMPE01_00/m416Dll/m416Dll.plf');
    expect(moduleElfPath('/p/build/GAFE01_00/static.elf', 'foresta')).toBe('/p/build/GAFE01_00/foresta/foresta.plf');
  });

  test("the base ELF's own name names no module: the base ELF IS its symbol source", () => {
    // dtk prefixes the DOL's units too (`main/`, `static/`), so that prefix is a name a caller may
    // hold — and there is no build/main/main.plf for it to look for.
    expect(moduleElfPath('/p/build/GMPE01_00/main.elf', 'main')).toBeUndefined();
    expect(moduleElfPath('/p/build/GAFE01_00/static.elf', 'static')).toBeUndefined();
  });
});

describe('assertPlaced — an unplaced relocatable ELF is refused', () => {
  test('a module .plf, whose allocated sections all sit at 0, is refused by name and address', () => {
    expect(() => assertPlaced(modulePlf(), '/p/m416Dll.plf')).toThrow(
      /m416Dll\.plf: it is a RELOCATABLE ELF whose allocated sections \.text\/\.data\/\.bss all sit at 0x0/,
    );
    expect(() => assertPlaced(modulePlf(), '/p/m416Dll.plf')).toThrow(/pass --module <name>/);
  });

  test('a linked ELF is accepted, and so is a relocatable object with one allocated section', () => {
    expect(() => assertPlaced(dolElf(), '/p/main.elf')).not.toThrow();
    const oneSection = elf32(ET_REL, [{ name: '.text', size: 0x40 }], [{ name: 'add_one', value: 0, shndx: 1 }]);
    expect(() => assertPlaced(oneSection, '/p/add.o')).not.toThrow();
  });

  test('an EMPTY allocated section is not a collision — it can hold no symbol', () => {
    const empty = elf32(
      ET_REL,
      [
        { name: '.text', size: 0x40 },
        { name: '.ctors', size: 0 },
      ],
      [{ name: 'add_one', value: 0, shndx: 1 }],
    );
    expect(() => assertPlaced(empty, '/p/add.o')).not.toThrow();
  });

  test('it is the gate on loadSymbolMap: a .plf named as tools.asmlift.elf is refused', async () => {
    await expect(loadSymbolMap(write('m416Dll.plf', modulePlf()))).rejects.toThrow(/RELOCATABLE ELF/);
  });
});

describe('placeModuleSections — each section gets a base of its own', () => {
  test('sections and their symbols are rebased, on a copy of the caller bytes', () => {
    const bytes = modulePlf();
    const before = Buffer.from(bytes);
    const placed = placeModuleSections(bytes, '/p/m416Dll.plf');
    expect(bytes.equals(before), 'the caller bytes are never written through').toBe(true);
    expect(() => assertPlaced(placed, '/p/m416Dll.plf'), 'placement satisfies the gate').not.toThrow();
    // every symbol is now at its section's base plus its own offset
    expect([...globalSymbolKeys(placed)].sort()).toEqual(
      [
        symbolKey('ObjectSetup', 0x0100_0000),
        symbolKey('_prolog', 0x0100_0040),
        symbolKey('stageSprId', 0x0200_0000),
        symbolKey('_ctors', 0x0200_0010),
        symbolKey('timerSec', 0x0300_0000),
      ].sort(),
    );
  });

  test('a section larger than the stride takes the next base, so nothing overlaps', () => {
    const big = elf32(
      ET_REL,
      [
        { name: '.text', size: 0x0180_0000 },
        { name: '.data', size: 0x10 },
      ],
      [
        { name: 'wide', value: 0, shndx: 1 },
        { name: 'after', value: 0, shndx: 2, type: STT_OBJECT },
      ],
    );
    expect([...globalSymbolKeys(placeModuleSections(big, '/p/big.plf'))].sort()).toEqual(
      [symbolKey('wide', 0x0100_0000), symbolKey('after', 0x0300_0000)].sort(),
    );
  });

  test('a linked ELF is not a module ELF', () => {
    expect(() => placeModuleSections(dolElf(), '/p/main.elf')).toThrow(/a module ELF is a RELOCATABLE ELF32/);
  });
});

// The SECTION half of a `<module>:<section>+0x<offset>` identity exists nowhere else: a placed map
// records a section INDEX, so only the module ELF can say `.text`. This is what `bench vendor`
// proves a REL row against.
describe('moduleFunctionLocations — where a module puts a function', () => {
  test('a function is named by its section and its offset within it', () => {
    const at = moduleFunctionLocations(modulePlf());
    expect(at.get('ObjectSetup')).toEqual([{ section: '.text', offset: 0x0 }]);
    expect(at.get('_prolog')).toEqual([{ section: '.text', offset: 0x40 }]);
  });

  test('DATA symbols are not functions, so a row can never be keyed at one', () => {
    const at = moduleFunctionLocations(modulePlf());
    expect(at.has('stageSprId')).toBe(false);
    expect(at.has('timerSec')).toBe(false);
  });

  // Animal Crossing's `foresta` holds 659 of its 16,051 `.text` names at more than one offset, so
  // a name maps to a LIST — which is the whole reason the offset is part of the identity.
  test('a name held at several offsets keeps every one of them', () => {
    const twice = elf32(
      ET_REL,
      [{ name: '.text', size: 0x200 }],
      [
        { name: 'mSM_move_End', value: 0x20, shndx: 1 },
        { name: 'mSM_move_End', value: 0x140, shndx: 1 },
      ],
    );
    expect(moduleFunctionLocations(twice).get('mSM_move_End')).toEqual([
      { section: '.text', offset: 0x20 },
      { section: '.text', offset: 0x140 },
    ]);
  });

  test('a linked ELF is not a module: it answers nothing rather than answering wrongly', () => {
    expect(moduleFunctionLocations(dolElf()).size).toBe(0);
  });
});

describe('globalSymbolKeys — which of the base ELF a module may inherit', () => {
  test('GLOBAL bindings only, keyed per symbol rather than per name', () => {
    const keys = globalSymbolKeys(dolElf());
    expect(keys.has(symbolKey('OSReport', 0x8000_3100))).toBe(true);
    expect(keys.has(symbolKey('hostMdl', 0x8030_0000)), 'a file static is not inheritable').toBe(false);
    // the same NAME at another address is a different symbol: a name-keyed filter would keep or
    // drop both together (Mario Party 4's `seqSpeed` is a global function and a local object)
    expect(keys.has(symbolKey('seqSpeed', 0x8000_3200))).toBe(true);
    expect(keys.has(symbolKey('seqSpeed', 0x8030_0040))).toBe(false);
  });
});

describe('loadModuleSymbolMap — the module, placed, over the base ELF globals', () => {
  test('every module symbol gets its own address, and every name resolves to exactly one', async () => {
    const map = await loadModuleSymbolMap(write('m416Dll.plf', modulePlf()), write('main.elf', dolElf()));
    const at = (name: string) => [...map].find(([, infos]) => infos.some((i) => i.name === name))?.[0];
    expect(at('ObjectSetup')).toBe(0x0100_0000);
    expect(at('stageSprId')).toBe(0x0200_0000);
    expect(at('timerSec')).toBe(0x0300_0000);
    // the collision this whole file exists to remove: three sections' first symbols at 0x0
    expect(map.has(0)).toBe(false);
    for (const infos of map.values()) {
      expect(
        infos.map((i) => i.name),
        `one symbol per address at 0x${at(infos[0].name)?.toString(16)}`,
      ).toHaveLength(1);
    }
    const byName = symbolsByName(map);
    expect(byName.get('ObjectSetup')).toMatchObject({ name: 'ObjectSetup', kind: 'code' });
    expect(byName.get('stageSprId')).toMatchObject({ name: 'stageSprId', kind: 'data' });
  });

  test('the base ELF contributes its globals, and only those', async () => {
    const map = await loadModuleSymbolMap(write('m416Dll.plf', modulePlf()), write('main.elf', dolElf()));
    const names = [...map.values()].flat().map((i) => i.name);
    expect(names).toContain('OSReport'); // a DOL global the module calls
    expect(names).toContain('seqSpeed');
    expect(names, 'a DOL file static is not visible to a module').not.toContain('hostMdl');
  });

  test('the MODULE shadows the base: `_ctors` is the module its relocations point at', async () => {
    const map = await loadModuleSymbolMap(write('m416Dll.plf', modulePlf()), write('main.elf', dolElf()));
    const ctors = [...map].filter(([, infos]) => infos.some((i) => i.name === '_ctors'));
    expect(ctors.map(([addr]) => addr)).toEqual([0x0200_0010]);
    // without shadowing the name would be an alias pair, and symbolsByName answers such a name
    // with a bare stub — the module's own definition would be unusable
    expect(symbolsByName(map).get('_ctors')).toMatchObject({ name: '_ctors', kind: 'data' });
  });

  test('an unplaced BASE ELF is refused just as loudly', async () => {
    await expect(
      loadModuleSymbolMap(write('m416Dll.plf', modulePlf()), write('base.plf', modulePlf())),
    ).rejects.toThrow(/base\.plf: it is a RELOCATABLE ELF/);
  });
});

/** A dtk project: decomp.yaml naming the base ELF, one objdiff.json unit under `m416Dll` and one
 *  under the DOL's own prefix `main`, and the build directory dtk writes a module's ELF into.
 *  `plf` is what lands at the module path — absent writes none at all. */
function dtkProject(plf?: Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-modcli-'));
  mkdirSync(join(root, 'build', 'm416Dll'), { recursive: true });
  writeFileSync(join(root, 'build', 'main.elf'), dolElf());
  if (plf) {
    writeFileSync(join(root, 'build', 'm416Dll', 'm416Dll.plf'), plf);
  }
  writeFileSync(
    join(root, 'objdiff.json'),
    JSON.stringify({
      units: [
        {
          name: 'm416Dll/REL/executor',
          target_path: 'build/m416Dll/executor.o',
          scratch: { compiler: 'mwcc_242_81', c_flags: '-O4,p' },
        },
        {
          name: 'main/game/host',
          target_path: 'build/main/host.o',
          scratch: { compiler: 'mwcc_242_81', c_flags: '-O4,p' },
        },
      ],
    }),
  );
  writeFileSync(
    join(root, 'decomp.yaml'),
    'platform: gc\ntools:\n  asmlift:\n    target: mwcc_242_81\n    elf: build/main.elf\n',
  );
  const asm = join(root, 'clamp0.asm');
  writeFileSync(asm, readFileSync(join(import.meta.dirname, '../../../core/test/corpus/ppc-clamp0.asm'), 'utf8'));
  return { root, asm };
}

describe('--module at the CLI surface', () => {
  test("--module is how a module's symbols are read; the same file as tools.asmlift.elf is refused", async () => {
    const { root, asm } = dtkProject(modulePlf());
    expect(await runCli([asm, '--module', 'm416Dll'])).toMatchObject({ code: 0 });
    // the same bytes as tools.asmlift.elf: the map this gate exists to stop building
    writeFileSync(
      join(root, 'decomp.yaml'),
      'platform: gc\ntools:\n  asmlift:\n    target: mwcc_242_81\n    elf: build/m416Dll/m416Dll.plf\n',
    );
    const direct = await runCli([asm]);
    expect(direct.code).toBe(66);
    expect(direct.stderr).toMatch(/cannot load symbols from tools\.asmlift\.elf .*RELOCATABLE ELF/s);
  });

  test('the module map is read OVER the base ELF — a failure names both files', async () => {
    const { root, asm } = dtkProject(modulePlf());
    rmSync(join(root, 'build', 'main.elf'));
    const r = await runCli([asm, '--module', 'm416Dll']);
    expect(r.code).toBe(66);
    expect(r.stderr).toContain(
      `cannot load symbols from module m416Dll (${join(root, 'build', 'm416Dll', 'm416Dll.plf')} over ${join(root, 'build', 'main.elf')})`,
    );
  });

  test('a module with no ELF at the dtk path is refused with the path asmlift looked for', async () => {
    const { root, asm } = dtkProject();
    expect(await runCli([asm, '--module', 'm416Dll'])).toEqual({
      code: 66,
      stdout: '',
      stderr: `asmlift: --module m416Dll: no module ELF at ${join(root, 'build', 'm416Dll', 'm416Dll.plf')}\n`,
    });
  });

  test('an unreadable module ELF names the module, not the project ELF', async () => {
    const { root, asm } = dtkProject(Buffer.from('not an ELF at all'));
    const r = await runCli([asm, '--module', 'm416Dll']);
    expect(r.code).toBe(66);
    expect(r.stderr).toContain(
      `asmlift: cannot load symbols from module m416Dll (${join(root, 'build', 'm416Dll', 'm416Dll.plf')} over `,
    );
    expect(r.stderr).toContain('a module ELF is a RELOCATABLE ELF32');
  });

  test('--cflags takes over the flags job, and --module still names the map', async () => {
    const { asm } = dtkProject(modulePlf());
    expect(await runCli([asm, '--module', 'm416Dll', '--cflags', '-O4,p'])).toMatchObject({ code: 0 });
  });

  test('the DOL is a module name too, and its map is tools.asmlift.elf itself', async () => {
    // dtk gives the DOL's units a prefix (`main/`) and names the base ELF after it, so `main` is a
    // name --module takes — there is no build/main/main.plf and there must not need to be.
    const { asm } = dtkProject(modulePlf());
    const dol = await runCli([asm, '--module', 'main']);
    expect(dol.code).toBe(0);
    expect(dol.stdout).toBe((await runCli([asm, '--cflags', '-O4,p'])).stdout);
  });

  test('--cflags alone still runs when objdiff.json cannot be read; --module needs it', async () => {
    // --cflags is the way past a project whose objdiff.json asmlift cannot use, so it must not be
    // read on that path. --module is a claim ABOUT that file, so there it is read and refused.
    const { root, asm } = dtkProject(modulePlf());
    writeFileSync(join(root, 'objdiff.json'), '{ not json');
    expect(await runCli([asm, '--cflags', '-O4,p'])).toMatchObject({ code: 0 });
    expect((await runCli([asm])).stderr).toMatch(/^asmlift: cannot read objdiff\.json: /);
    expect((await runCli([asm, '--module', 'm416Dll', '--cflags', '-O4,p'])).stderr).toMatch(
      /^asmlift: cannot read objdiff\.json: /,
    );
  });

  test('a name that is no module of this project is still refused before anything is read', async () => {
    const { root, asm } = dtkProject(modulePlf());
    expect(await runCli([asm, '--module', 'm999Dll'])).toEqual({
      code: 64,
      stdout: '',
      stderr: `asmlift: --module m999Dll: ${join(root, 'objdiff.json')} has no unit in it\n`,
    });
  });
});
