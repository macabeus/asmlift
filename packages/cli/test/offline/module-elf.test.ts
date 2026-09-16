// A REL module's symbol map (src/module-elf.ts + loadModuleSymbolMap).
//
// A GameCube module builds to a RELOCATABLE `<module>.plf` whose allocated sections all start at
// address 0. Naming one as `tools.asmlift.elf` used to produce a map where the first function, the
// first data word and the first BSS variable share the address 0x0 — silently, since a map full of
// aliases loads exactly like a map full of symbols. These tests pin the two halves of the answer:
// such a file is REFUSED, and the module map that replaces it places each section at a base of its
// own and inherits only what a module may refer to in the base ELF.
import { symbolsByName } from '@asmlift/core/symbols';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { assertPlaced, globalSymbolKeys, placeModuleSections, symbolKey } from '../../src/module-elf';
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

  test('it is the gate on loadSymbolMap: a .plf named as tools.asmlift.elf no longer loads', async () => {
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
