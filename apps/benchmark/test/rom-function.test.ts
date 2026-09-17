// The ROM gate's comparison (cases/rom-function.ts) over ELF32 files written here: a relocatable object and a
// linked image holding the same function, with a relocated field, a byte outside it, or a tail changed.
import { placeModuleSections } from '@asmlift/cli/module-elf';
import { describe, expect, test } from 'vitest';

import { compareWithRom, romLocation, targetDigest } from '../src/cases/rom-function';
import { elf32 } from './elf32';

const EM_ARM = 40;
const EM_MIPS = 8;
const EM_PPC = 20;
const ROM = 0x08000100;

/** A Thumb function with a 4-byte `bl` at +0, as an object (relocated) and linked (resolved). */
const thumb = (linkedText: number[], relocType = 10) => ({
  object: elf32({
    machine: EM_ARM,
    littleEndian: true,
    textAddr: 0,
    text: [0x00, 0xf0, 0x00, 0xf8, 0x01, 0x30, 0x70, 0x47],
    symbols: [{ name: 'f', value: 1, size: 8 }],
    relocs: [{ offset: 0, type: relocType }],
  }),
  linked: elf32({
    machine: EM_ARM,
    littleEndian: true,
    textAddr: ROM,
    text: linkedText,
    symbols: [{ name: 'f', value: ROM + 1, size: linkedText.length }],
  }),
});

describe('compareWithRom', () => {
  test('a relocated field may differ; every other byte must not', () => {
    const resolved = thumb([0x12, 0xf3, 0x34, 0xfa, 0x01, 0x30, 0x70, 0x47]);
    const rom = compareWithRom(resolved.object, 'f', resolved.linked, ROM);
    expect(rom).toEqual({ equal: true, digest: targetDigest(resolved.object, 'f') });
    const changed = thumb([0x12, 0xf3, 0x34, 0xfa, 0x02, 0x30, 0x70, 0x47]);
    expect(compareWithRom(changed.object, 'f', changed.linked, ROM)).toEqual({
      equal: false,
      detail: 'object 8 B, ROM 8 B, first difference at +0x4',
    });
  });

  test('a Thumb short branch relocation masks its 16-bit instruction only', () => {
    const past = thumb([0x12, 0xf3, 0x34, 0xfa, 0x01, 0x30, 0x70, 0x47], 102);
    expect(compareWithRom(past.object, 'f', past.linked, ROM)).toMatchObject({ equal: false });
  });

  test('MIPS: a jump keeps its opcode compared, a HI16/LO16 pair its upper half', () => {
    const object = elf32({
      machine: EM_MIPS,
      littleEndian: false,
      textAddr: 0,
      text: [0x0c, 0x00, 0x00, 0x00, 0x3c, 0x04, 0x00, 0x00, 0x03, 0xe0, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00],
      symbols: [{ name: 'g', value: 0, size: 16 }],
      relocs: [
        { offset: 0, type: 4 },
        { offset: 4, type: 5 },
      ],
    });
    const linked = (text: number[]) =>
      elf32({
        machine: EM_MIPS,
        littleEndian: false,
        textAddr: 0x80001000,
        text,
        symbols: [{ name: 'g', value: 0x80001000, size: 16 }],
      });
    const resolved = [0x0c, 0x01, 0x23, 0x45, 0x3c, 0x04, 0x80, 0x02, 0x03, 0xe0, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00];
    expect(compareWithRom(object, 'g', linked(resolved), 0x80001000)).toEqual({
      equal: true,
      digest: targetDigest(object, 'g'),
    });
    const otherOpcode = [0x08, 0x01, 0x23, 0x45, ...resolved.slice(4)];
    expect(compareWithRom(object, 'g', linked(otherOpcode), 0x80001000)).toMatchObject({ equal: false });
    const otherRegister = [...resolved.slice(0, 4), 0x3c, 0x05, 0x80, 0x02, ...resolved.slice(8)];
    expect(compareWithRom(object, 'g', linked(otherRegister), 0x80001000)).toMatchObject({ equal: false });
  });

  // POWERPC: the machine the GameCube projects build for, and the one whose relocations rewrite more
  // of an instruction than a displacement. `elf32` writes SHT_REL where CodeWarrior writes SHT_RELA;
  // the mask reads both, and what is under test is which BITS each type leaves compared.
  describe('PowerPC', () => {
    const ppcObject = (text: number[], relocs: { offset: number; type: number }[]) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: 0,
        text,
        symbols: [{ name: 'p', value: 0, size: text.length }],
        relocs,
      });
    const ppcLinked = (text: number[]) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: 0x80003000,
        text,
        symbols: [{ name: 'p', value: 0x80003000, size: text.length }],
      });

    test('a bl keeps its opcode and link bit compared, an address pair its upper half', () => {
      // bl 0 ; lis r3,0 ; lwz r3,0(r3) ; blr — an ADDR16 relocation sits on the HALF-WORD it
      // rewrites, two bytes into the instruction, and a branch relocation on the instruction.
      const object = ppcObject(
        [0x48, 0x00, 0x00, 0x01, 0x3c, 0x60, 0x00, 0x00, 0x80, 0x63, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20],
        [
          { offset: 0, type: 10 },
          { offset: 6, type: 6 },
          { offset: 10, type: 4 },
        ],
      );
      const resolved = [0x48, 0x00, 0x12, 0x35, 0x3c, 0x60, 0x80, 0x0a, 0x80, 0x63, 0x12, 0x34, 0x4e, 0x80, 0x00, 0x20];
      expect(compareWithRom(object, 'p', ppcLinked(resolved), 0x80003000)).toEqual({
        equal: true,
        digest: targetDigest(object, 'p'),
      });
      // the `bl`'s own opcode is not the linker's to write
      const otherOpcode = [0x4c, 0x00, 0x12, 0x35, ...resolved.slice(4)];
      expect(compareWithRom(object, 'p', ppcLinked(otherOpcode), 0x80003000)).toMatchObject({ equal: false });
      // nor the destination register of the `lis`
      const otherRegister = [...resolved.slice(0, 4), 0x3c, 0x80, 0x80, 0x0a, ...resolved.slice(8)];
      expect(compareWithRom(object, 'p', ppcLinked(otherRegister), 0x80003000)).toMatchObject({ equal: false });
    });

    test('a small-data relocation masks the BASE REGISTER as well as the displacement', () => {
      // EMB_SDA21 rewrites rA to r2/r13 at link time, so a comparison that masked only the
      // displacement would call every small-data read a difference. CodeWarrior writes its offset
      // BOTH ways — at the instruction and two bytes into it — and the field is the whole
      // instruction either way, so both spellings are pinned.
      for (const offset of [0, 2]) {
        const object = ppcObject([0x80, 0x60, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20], [{ offset, type: 109 }]);
        const resolved = [0x80, 0x6d, 0x81, 0x00, 0x4e, 0x80, 0x00, 0x20];
        expect(compareWithRom(object, 'p', ppcLinked(resolved), 0x80003000)).toMatchObject({ equal: true });
        // the LOADED register still is: r4 is a different instruction
        const otherRegister = [0x80, 0x8d, 0x81, 0x00, 0x4e, 0x80, 0x00, 0x20];
        expect(compareWithRom(object, 'p', ppcLinked(otherRegister), 0x80003000)).toMatchObject({ equal: false });
      }
    });

    test('a relocation type nothing has measured is refused, not masked by guesswork', () => {
      // 3 is R_PPC_ADDR24, which no object in the corpus carries — the table states only the six
      // types something has measured.
      const object = ppcObject([0x80, 0x60, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20], [{ offset: 0, type: 3 }]);
      expect(() =>
        compareWithRom(object, 'p', ppcLinked([0x80, 0x60, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20]), 0x80003000),
      ).toThrow(/no PowerPC relocation mask for type 3/);
    });
  });

  test('an unsized function ends at the next label, and a short zero tail is padding', () => {
    const object = elf32({
      machine: EM_ARM,
      littleEndian: true,
      textAddr: 0,
      text: [0x01, 0x30, 0x70, 0x47, 0x00, 0x00, 0x02, 0x30, 0x70, 0x47],
      symbols: [
        { name: 'f', value: 1, size: 0 },
        { name: 'next', value: 7, size: 0 },
      ],
    });
    const linked = (text: number[]) =>
      elf32({
        machine: EM_ARM,
        littleEndian: true,
        textAddr: ROM,
        text,
        symbols: [{ name: 'f', value: ROM + 1, size: text.length }],
      });
    expect(compareWithRom(object, 'f', linked([0x01, 0x30, 0x70, 0x47]), ROM)).toEqual({
      equal: true,
      digest: targetDigest(object, 'f'),
    });
    expect(compareWithRom(object, 'f', linked([0x01, 0x30, 0x70, 0x47, 0x00, 0x00, 0x70, 0x47]), ROM)).toEqual({
      equal: false,
      detail: 'object 6 B, ROM 8 B, equal over the shorter',
    });
  });

  test('a digest names the bytes and the relocations: another relocation, or another byte, is another digest', () => {
    const { object } = thumb([]);
    const unrelocated = thumb([], 102).object;
    expect(targetDigest(object, 'f')).toMatch(/^[0-9a-f]{64}$/);
    expect(targetDigest(unrelocated, 'f')).not.toBe(targetDigest(object, 'f'));
    const otherByte = elf32({
      machine: EM_ARM,
      littleEndian: true,
      textAddr: 0,
      text: [0x00, 0xf0, 0x00, 0xf8, 0x02, 0x30, 0x70, 0x47],
      symbols: [{ name: 'f', value: 1, size: 8 }],
      relocs: [{ offset: 0, type: 10 }],
    });
    expect(targetDigest(otherByte, 'f')).not.toBe(targetDigest(object, 'f'));
    expect(() => targetDigest(object, 'h')).toThrow('the object defines no h');
  });

  test('a function missing from either side is a difference, named', () => {
    const { object, linked } = thumb([0x12, 0xf3, 0x34, 0xfa, 0x01, 0x30, 0x70, 0x47]);
    expect(compareWithRom(object, 'h', linked, ROM)).toEqual({ equal: false, detail: 'the object defines no h' });
    expect(compareWithRom(object, 'f', linked, ROM + 0x40)).toEqual({
      equal: false,
      detail: 'the linked ELF has no function at 0x8000140',
    });
  });

  test('a machine with no relocation mask is refused', () => {
    // EM_386, a machine the real tier builds for on no project: three do (ARM, MIPS, PowerPC) and
    // every other one has to say so rather than compare bits nobody has read.
    const object = elf32({
      machine: 3,
      littleEndian: true,
      textAddr: 0,
      text: [0, 0, 0, 0],
      symbols: [{ name: 'p', value: 0, size: 4 }],
      relocs: [{ offset: 0, type: 1 }],
    });
    const linked = elf32({
      machine: 3,
      littleEndian: true,
      textAddr: 0x80003000,
      text: [0, 0, 0, 0],
      symbols: [{ name: 'p', value: 0x80003000, size: 4 }],
    });
    expect(() => compareWithRom(object, 'p', linked, 0x80003000)).toThrow('no relocation mask for ELF machine 3');
  });
});

// The half of a function the masked byte comparison cannot see: a relocated field's bits are left out of
// it, so the SYMBOL the field will hold — and the data behind it — is compared instead. On PowerPC every
// float literal, string and table lives outside the function, and a target reading another literal has
// byte-identical code.
describe('what a relocation points at', () => {
  const FLOAT = [0xc3, 0xe1, 0x00, 0x00]; // -450.0f
  // lis r3,0 ; lfs f1,0(r3) ; blr — an address pair naming a literal in .data, and a call
  const TEXT = [0x3c, 0x60, 0x00, 0x00, 0xc0, 0x23, 0x00, 0x00, 0x48, 0x00, 0x00, 0x01, 0x4e, 0x80, 0x00, 0x20];
  const RELOCS = [
    { offset: 2, type: 6, sym: '@1135', addend: 0 },
    { offset: 6, type: 4, sym: '@1135', addend: 0 },
    { offset: 8, type: 10, sym: 'HuSprSet', addend: 0 },
  ];

  const object = (data: number[], relocs = RELOCS) =>
    elf32({
      machine: EM_PPC,
      littleEndian: false,
      textAddr: 0,
      text: TEXT,
      data,
      symbols: [
        { name: 'p', value: 0, size: TEXT.length },
        { name: '@1135', value: 0, size: 4, type: 1, section: 'data', bind: 'local' as const },
        { name: 'HuSprSet', value: 0, size: 0, section: 'undefined' as const },
        { name: 'HuSprPosSet', value: 0, size: 0, section: 'undefined' as const },
      ],
      relocs,
    });

  /** The module the game loads: the same code with the loader's fields unwritten, its own relocations. */
  const held = (data: number[], relocs = RELOCS) =>
    elf32({
      machine: EM_PPC,
      littleEndian: false,
      textAddr: 0,
      text: TEXT,
      data,
      symbols: [
        { name: 'p', value: 0, size: TEXT.length },
        { name: '@1135', value: 0, size: 4, type: 1, section: 'data', bind: 'local' as const },
        { name: 'HuSprSet', value: 0, size: 0, section: 'undefined' as const },
      ],
      relocs,
    });

  test('the same literal is the same function', () => {
    expect(compareWithRom(object(FLOAT), 'p', held(FLOAT), 0)).toEqual({
      equal: true,
      digest: targetDigest(object(FLOAT), 'p'),
    });
  });

  test('another literal is refused, though every code byte is equal', () => {
    const other = [0xc3, 0xe1, 0x80, 0x00]; // -451.0f
    expect(compareWithRom(object(other), 'p', held(FLOAT), 0)).toEqual({
      equal: false,
      detail: "type 6 at +0x2 points at a local .data datum of 4 B, whose data differs from ROM's at +0x2",
    });
  });

  test('another symbol is refused, though the field that names it is masked out', () => {
    const elsewhere = RELOCS.map((r) => (r.type === 10 ? { ...r, sym: 'HuSprPosSet' } : r));
    expect(compareWithRom(object(FLOAT, elsewhere), 'p', held(FLOAT), 0)).toEqual({
      equal: false,
      detail: 'type 10 at +0x8 names HuSprPosSet, ROM HuSprSet',
    });
  });

  test('another addend into the same symbol is refused', () => {
    const shifted = RELOCS.map((r) => (r.type === 4 ? { ...r, addend: 4 } : r));
    expect(compareWithRom(object(FLOAT, shifted), 'p', held(FLOAT), 0)).toEqual({
      equal: false,
      detail: 'type 4 at +0x6 names @1135+0x4, ROM @1135',
    });
  });

  // CodeWarrior numbers a literal pool per translation unit, so the object built from a unit PREFIX and
  // the module built from the whole unit spell the same literal `@9` and `@1135`. What it holds is the
  // fact about the game; what the compiler called it is not.
  test('a file-local literal the two files number differently is compared by what it holds', () => {
    const renumbered = RELOCS.map((r) => (r.sym === '@1135' ? { ...r, sym: '@9' } : r));
    const asPrefix = (data: number[]) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: 0,
        text: TEXT,
        data,
        symbols: [
          { name: 'p', value: 0, size: TEXT.length },
          { name: '@9', value: 0, size: 4, type: 1, section: 'data', bind: 'local' as const },
          { name: 'HuSprSet', value: 0, size: 0, section: 'undefined' as const },
        ],
        relocs: renumbered,
      });
    expect(compareWithRom(asPrefix(FLOAT), 'p', held(FLOAT), 0)).toMatchObject({ equal: true });
    expect(compareWithRom(asPrefix([0xc3, 0xe1, 0x80, 0x00]), 'p', held(FLOAT), 0)).toMatchObject({
      equal: false,
    });
  });

  // …but only the NUMBER is the compiler's. A file-scope `static` is the name the source wrote, and for
  // a `.bss` datum it is the only thing there is: a NOBITS section holds nothing to compare, so two
  // statics of the same size would otherwise be interchangeable — a function that returns the window's
  // height where the game returns its width.
  test('two file-local statics of the same size in .bss are told apart by their names', () => {
    const bss = (name: string) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: 0,
        text: TEXT,
        data: FLOAT,
        symbols: [
          { name: 'p', value: 0, size: TEXT.length },
          { name: '@1135', value: 0, size: 4, type: 1, section: 'data', bind: 'local' as const },
          { name, value: 0, size: 2, type: 1, bind: 'local' as const },
        ],
        relocs: RELOCS.map((r) => (r.sym === 'HuSprSet' ? { ...r, sym: name } : r)),
      });
    expect(compareWithRom(bss('winMaxWidth'), 'p', bss('winMaxWidth'), 0)).toMatchObject({ equal: true });
    expect(compareWithRom(bss('winMaxWidth'), 'p', bss('winMaxHeight'), 0)).toEqual({
      equal: false,
      detail: 'type 10 at +0x8 names winMaxWidth, ROM winMaxHeight',
    });
  });

  // A function static keeps the name the source wrote in front of its number, so the two files are
  // still held to the same static — `sprHideTbl$11` and `sprHideTbl$797` are one array, and
  // `sprHideTbl$11` and `sprShowTbl$797` are two.
  test('a function static is compared on the name the source wrote, not on its number', () => {
    const stat = (name: string) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: 0,
        text: TEXT,
        data: FLOAT,
        symbols: [
          { name: 'p', value: 0, size: TEXT.length },
          { name: '@1135', value: 0, size: 4, type: 1, section: 'data', bind: 'local' as const },
          { name, value: 0, size: 4, type: 1, bind: 'local' as const },
        ],
        relocs: RELOCS.map((r) => (r.sym === 'HuSprSet' ? { ...r, sym: name } : r)),
      });
    expect(compareWithRom(stat('sprHideTbl$11'), 'p', stat('sprHideTbl$797'), 0)).toMatchObject({
      equal: true,
    });
    expect(compareWithRom(stat('sprHideTbl$11'), 'p', stat('sprShowTbl$797'), 0)).toEqual({
      equal: false,
      detail: 'type 10 at +0x8 names sprHideTbl$11, ROM sprShowTbl$797',
    });
  });

  // …but a symbol one side leaves UNDEFINED is compared by name, which is how the linker resolves it:
  // a unit prefix leaves the statics defined below the row's function undefined, and the module defines
  // them file-locally.
  test('a static the object has not seen yet is compared by name with the one the game defines', () => {
    const defined = (name: string) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: 0,
        text: TEXT,
        data: FLOAT,
        symbols: [
          { name: 'p', value: 0, size: TEXT.length },
          { name: '@1135', value: 0, size: 4, type: 1, section: 'data', bind: 'local' as const },
          { name, value: 0, size: 0, bind: 'local' as const },
        ],
        relocs: RELOCS.map((r) => (r.sym === 'HuSprSet' ? { ...r, sym: name } : r)),
      });
    expect(compareWithRom(object(FLOAT), 'p', defined('HuSprSet'), 0)).toMatchObject({ equal: true });
    expect(compareWithRom(object(FLOAT), 'p', defined('HuSprPosSet'), 0)).toEqual({
      equal: false,
      detail: 'type 10 at +0x8 names HuSprSet, ROM HuSprPosSet',
    });
  });

  test('a field the game does not relocate is refused', () => {
    expect(compareWithRom(object(FLOAT), 'p', held(FLOAT, RELOCS.slice(0, 2)), 0)).toEqual({
      equal: false,
      detail: 'object relocates 3 field(s), ROM 2',
    });
  });

  // A DTK PROJECT'S LINKED ELF places its sections where the game loads them, and keeps its
  // relocations. A referent is named there by its ADDRESS, and its bytes are only found by converting
  // that back into a file offset — the same conversion the code half makes. Without it the datum is
  // read past the end of the file, and an empty buffer compares equal to every literal there is.
  describe("the game's own linked image", () => {
    const TEXT_AT = 0x80003000;
    const DATA_AT = 0x8011dd00;
    const linked = (data: number[], relocs = RELOCS) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: TEXT_AT,
        text: TEXT,
        data,
        dataAddr: DATA_AT,
        symbols: [
          { name: 'p', value: TEXT_AT, size: TEXT.length },
          { name: '@1135', value: DATA_AT, size: 4, type: 1, section: 'data', bind: 'local' as const },
          { name: 'HuSprSet', value: 0, size: 0, section: 'undefined' as const },
        ],
        relocs: relocs.map((r) => ({ ...r, offset: r.offset + TEXT_AT })),
      });

    test('the same literal is the same function', () => {
      expect(compareWithRom(object(FLOAT), 'p', linked(FLOAT), TEXT_AT)).toEqual({
        equal: true,
        digest: targetDigest(object(FLOAT), 'p'),
      });
    });

    test('another literal is refused, though every code byte is equal', () => {
      expect(compareWithRom(object([0xc3, 0xe1, 0x80, 0x00]), 'p', linked(FLOAT), TEXT_AT)).toEqual({
        equal: false,
        detail: "type 6 at +0x2 points at a local .data datum of 4 B, whose data differs from ROM's at +0x2",
      });
    });
  });

  // A REL MODULE is read through `romLocation`, which PLACES it: every section gets a base of its own
  // so the module reads like a linked image. Placement rebases the section-relative coordinates, and a
  // relocation's offset is one of them — leave it behind and the module's own relocations fall outside
  // the function, which reads as a function that relocates nothing and compares no referent at all.
  describe('a REL module, placed', () => {
    const moduleElf = (data: number[]) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: 0,
        text: TEXT,
        data,
        symbols: [
          { name: 'p', value: 0, size: TEXT.length },
          { name: '@1135', value: 0, size: 4, type: 1, section: 'data', bind: 'local' as const },
          { name: 'HuSprSet', value: 0, size: 0, section: 'undefined' as const },
        ],
        relocs: RELOCS,
      });
    const placedAt = (data: number[]) => {
      const placed = placeModuleSections(moduleElf(data), '/p/m437Dll.plf');
      return romLocation('m437Dll:.text+0x00000000', Buffer.alloc(0), () => placed);
    };

    test('the same literal is the same function', () => {
      const { elf, at } = placedAt(FLOAT);
      expect(compareWithRom(object(FLOAT), 'p', elf, at)).toEqual({
        equal: true,
        digest: targetDigest(object(FLOAT), 'p'),
      });
    });

    test('another literal is refused, though every code byte is equal', () => {
      const { elf, at } = placedAt(FLOAT);
      expect(compareWithRom(object([0xc3, 0xe1, 0x80, 0x00]), 'p', elf, at)).toEqual({
        equal: false,
        detail: "type 6 at +0x2 points at a local .data datum of 4 B, whose data differs from ROM's at +0x2",
      });
    });
  });

  // A DATUM CAN BE RELOCATED TOO. A `bctr` jump table is all zeroes in the object with its own
  // relocations over it and resolved addresses in the game's file, so its words have no comparable
  // value — for exactly the reason the instruction stream's relocated fields have none. What is left
  // of the datum is still compared.
  describe('a datum the file relocates', () => {
    // .text: lis r3,0 ; lfs f1,0(r3) ; blr — naming an 8-byte table whose first word is an address
    const TABLE_TEXT = [0x3c, 0x60, 0x00, 0x00, 0xc0, 0x23, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20];
    const TABLE_RELOCS = [
      { offset: 2, type: 6, sym: '@297', addend: 0 },
      { offset: 6, type: 4, sym: '@297', addend: 0 },
    ];
    const withTable = (data: number[], textAt: number, dataAt: number) =>
      elf32({
        machine: EM_PPC,
        littleEndian: false,
        textAddr: textAt,
        text: TABLE_TEXT,
        data,
        dataAddr: dataAt,
        symbols: [
          { name: 'p', value: textAt, size: TABLE_TEXT.length },
          { name: '@297', value: dataAt, size: 8, type: 1, section: 'data', bind: 'local' as const },
        ],
        relocs: TABLE_RELOCS.map((r) => ({ ...r, offset: r.offset + textAt })),
        dataRelocs: [{ offset: dataAt, type: 1, sym: 'p', addend: 0 }],
      });
    // the object leaves the entry for the linker; the game's file holds the address it resolved to
    const UNRESOLVED = [0x00, 0x00, 0x00, 0x00, 0xc3, 0xe1, 0x00, 0x00];
    const RESOLVED = [0x80, 0x00, 0x30, 0x00, 0xc3, 0xe1, 0x00, 0x00];
    const obj = withTable(UNRESOLVED, 0, 0);

    test('the entry the linker writes is not a difference', () => {
      expect(compareWithRom(obj, 'p', withTable(RESOLVED, 0x80003000, 0x8011dd00), 0x80003000)).toMatchObject({
        equal: true,
      });
    });

    test('the rest of the same datum is still compared', () => {
      const other = [0x80, 0x00, 0x30, 0x00, 0xc3, 0xe1, 0x80, 0x00];
      expect(compareWithRom(obj, 'p', withTable(other, 0x80003000, 0x8011dd00), 0x80003000)).toEqual({
        equal: false,
        detail: "type 6 at +0x2 points at a local .data datum of 8 B, whose data differs from ROM's at +0x6",
      });
    });
  });

  // A fully linked image resolved its relocations and dropped the table; there is nothing to compare
  // against, and the proof stays what it was — the code alone.
  test('a file that keeps no relocations is compared on its bytes alone', () => {
    const linked = elf32({
      machine: EM_PPC,
      littleEndian: false,
      textAddr: 0x80003000,
      text: [0x3c, 0x60, 0x80, 0x0a, 0xc0, 0x23, 0x12, 0x34, 0x48, 0x00, 0x12, 0x35, 0x4e, 0x80, 0x00, 0x20],
      symbols: [{ name: 'p', value: 0x80003000, size: TEXT.length }],
    });
    expect(compareWithRom(object(FLOAT), 'p', linked, 0x80003000)).toMatchObject({ equal: true });
  });
});
