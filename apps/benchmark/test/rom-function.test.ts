// The ROM gate's comparison (cases/rom-function.ts) over ELF32 files written here: a relocatable object and a
// linked image holding the same function, with a relocated field, a byte outside it, or a tail changed.
import { describe, expect, test } from 'vitest';

import { compareWithRom } from '../src/cases/rom-function';

interface ElfSpec {
  machine: number;
  littleEndian: boolean;
  textAddr: number;
  text: number[];
  symbols: { name: string; value: number; size: number; type?: number }[];
  relocs?: { offset: number; type: number }[];
}

/** A minimal ELF32: .text, .symtab, .strtab and .rel.text, which is every part the comparison reads. */
function elf32(spec: ElfSpec): Buffer {
  const le = spec.littleEndian;
  const u16 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const u32 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o));
  const text = Buffer.from(spec.text);
  const names = Buffer.from(`\0${spec.symbols.map((s) => `${s.name}\0`).join('')}`, 'latin1');
  const symtab = Buffer.alloc(16 * (spec.symbols.length + 1));
  let nameAt = 1;
  spec.symbols.forEach((s, i) => {
    const at = 16 * (i + 1);
    u32(symtab, at, nameAt);
    u32(symtab, at + 4, s.value);
    u32(symtab, at + 8, s.size);
    symtab[at + 12] = s.type ?? 2;
    u16(symtab, at + 14, 1);
    nameAt += s.name.length + 1;
  });
  const rel = Buffer.alloc(8 * (spec.relocs ?? []).length);
  (spec.relocs ?? []).forEach((r, i) => {
    u32(rel, 8 * i, r.offset);
    u32(rel, 8 * i + 4, r.type);
  });
  const bodies = [text, symtab, names, rel];
  const offsets: number[] = [];
  let at = 52;
  for (const b of bodies) {
    offsets.push(at);
    at += b.length;
  }
  const shoff = at;
  const out = Buffer.alloc(shoff + 40 * 5);
  out.writeUInt32BE(0x7f454c46, 0);
  out[4] = 1;
  out[5] = le ? 1 : 2;
  out[6] = 1;
  u16(out, 0x10, 1);
  u16(out, 0x12, spec.machine);
  u32(out, 0x20, shoff);
  u16(out, 0x2e, 40);
  u16(out, 0x30, 5);
  bodies.forEach((b, i) => b.copy(out, offsets[i]));
  const section = (i: number, type: number, flags: number, addr: number, body: number, link = 0, info = 0) => {
    const sh = shoff + 40 * i;
    u32(out, sh + 4, type);
    u32(out, sh + 8, flags);
    u32(out, sh + 12, addr);
    u32(out, sh + 16, offsets[body]);
    u32(out, sh + 20, bodies[body].length);
    u32(out, sh + 24, link);
    u32(out, sh + 28, info);
  };
  section(1, 1, 0x6, spec.textAddr, 0);
  section(2, 2, 0, 0, 1, 3);
  section(3, 3, 0, 0, 2);
  section(4, 9, 0, 0, 3, 2, 1);
  return out;
}

const EM_ARM = 40;
const EM_MIPS = 8;
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
    expect(compareWithRom(resolved.object, 'f', resolved.linked, ROM)).toEqual({ equal: true, length: 8 });
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
    expect(compareWithRom(object, 'g', linked(resolved), 0x80001000)).toEqual({ equal: true, length: 16 });
    const otherOpcode = [0x08, 0x01, 0x23, 0x45, ...resolved.slice(4)];
    expect(compareWithRom(object, 'g', linked(otherOpcode), 0x80001000)).toMatchObject({ equal: false });
    const otherRegister = [...resolved.slice(0, 4), 0x3c, 0x05, 0x80, 0x02, ...resolved.slice(8)];
    expect(compareWithRom(object, 'g', linked(otherRegister), 0x80001000)).toMatchObject({ equal: false });
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
    expect(compareWithRom(object, 'f', linked([0x01, 0x30, 0x70, 0x47]), ROM)).toEqual({ equal: true, length: 4 });
    expect(compareWithRom(object, 'f', linked([0x01, 0x30, 0x70, 0x47, 0x00, 0x00, 0x70, 0x47]), ROM)).toEqual({
      equal: false,
      detail: 'object 6 B, ROM 8 B, equal over the shorter',
    });
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
    const object = elf32({
      machine: 20,
      littleEndian: false,
      textAddr: 0,
      text: [0, 0, 0, 0],
      symbols: [{ name: 'p', value: 0, size: 4 }],
      relocs: [{ offset: 0, type: 10 }],
    });
    const linked = elf32({
      machine: 20,
      littleEndian: false,
      textAddr: 0x80003000,
      text: [0, 0, 0, 0],
      symbols: [{ name: 'p', value: 0x80003000, size: 4 }],
    });
    expect(() => compareWithRom(object, 'p', linked, 0x80003000)).toThrow('no relocation mask for ELF machine 20');
  });
});
