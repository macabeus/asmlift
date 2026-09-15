// A minimal ELF32 writer for the ROM gate's tests: .text, .symtab, .strtab and .rel.text.

export interface ElfSpec {
  machine: number;
  littleEndian: boolean;
  textAddr: number;
  text: number[];
  symbols: { name: string; value: number; size: number; type?: number }[];
  relocs?: { offset: number; type: number }[];
}

/** A minimal ELF32: .text, .symtab, .strtab and .rel.text, which is every part the comparison reads. */
export function elf32(spec: ElfSpec): Buffer {
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
