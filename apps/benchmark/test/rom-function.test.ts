// The ROM gate's comparison (cases/rom-function.ts) over ELF32 files written here: a relocatable object and a
// linked image holding the same function, with a relocated field, a byte outside it, or a tail changed.
import { describe, expect, test } from 'vitest';

import { compareWithRom, targetDigest } from '../src/cases/rom-function';
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
      const object = ppcObject([0x80, 0x60, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20], [{ offset: 0, type: 1 }]);
      expect(() =>
        compareWithRom(object, 'p', ppcLinked([0x80, 0x60, 0x00, 0x00, 0x4e, 0x80, 0x00, 0x20]), 0x80003000),
      ).toThrow(/no PowerPC relocation mask for type 1/);
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
