// A minimal ELF32 writer for the ROM gate's tests: a code section, an optional data section, .symtab,
// .strtab, those sections' relocations (REL or RELA), any further allocated sections a module-shaped
// image needs, and .shstrtab.

export interface ElfSpec {
  machine: number;
  littleEndian: boolean;
  textAddr: number;
  /** the code section's name, `.text` unless stated — a REL module's function is found by it */
  textName?: string;
  text: number[];
  /** a data section's bytes, where the test's relocations point at data */
  data?: number[];
  /** the data section's name, `.data` unless stated — which section holds a datum is the linker's
   *  choice, so the object's and the game's need not agree */
  dataName?: string;
  /** the data section's address, 0 unless stated — a LINKED image places its data where the game
   *  loads it, and a referent's bytes are only found by converting that back to a file offset */
  dataAddr?: number;
  /** relocations of the data section: a datum that points at something, which is what a jump table is */
  dataRelocs?: Reloc[];
  symbols: {
    name: string;
    value: number;
    size: number;
    type?: number;
    /** where it is defined, `text` unless stated — `undefined` for an extern the linker resolves */
    section?: 'text' | 'data' | 'undefined';
    /** its linkage, global unless stated: a file-local name is the compiler's own bookkeeping */
    bind?: 'local' | 'global';
  }[];
  /** relocations of the code section: REL, or RELA when any of them states an addend */
  relocs?: Reloc[];
  /** allocated sections after the code section, zero-filled — what gives a REL module's `.text` a neighbour */
  moreSections?: { name: string; size: number }[];
}

interface Reloc {
  offset: number;
  type: number;
  sym?: string;
  addend?: number;
}

/** One section as it is written: its name, header fields and body. */
interface Written {
  name: string;
  type: number;
  flags: number;
  addr: number;
  body: Buffer;
  /** the section it links to (a relocation or symbol table's strings/symbols), by name */
  link?: string;
  /** the section it applies to, by name */
  info?: string;
}

/** A minimal ELF32: every part the ROM comparison and the module placer read. A file with no `relocs`
 *  gets no relocation section at all, which is what a fully linked image looks like. */
export function elf32(spec: ElfSpec): Buffer {
  const le = spec.littleEndian;
  const u16 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const u32 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o));
  const rela = [...(spec.relocs ?? []), ...(spec.dataRelocs ?? [])].some((r) => r.addend !== undefined);
  const textName = spec.textName ?? '.text';
  const dataIndex = spec.data === undefined ? undefined : 2;

  const names = Buffer.from(`\0${spec.symbols.map((s) => `${s.name}\0`).join('')}`, 'latin1');
  const symtab = Buffer.alloc(16 * (spec.symbols.length + 1));
  let nameAt = 1;
  spec.symbols.forEach((s, i) => {
    const at = 16 * (i + 1);
    u32(symtab, at, nameAt);
    u32(symtab, at + 4, s.value);
    u32(symtab, at + 8, s.size);
    symtab[at + 12] = ((s.bind === 'local' ? 0 : 1) << 4) | (s.type ?? 2);
    u16(symtab, at + 14, s.section === 'undefined' ? 0 : s.section === 'data' ? dataIndex! : 1);
    nameAt += s.name.length + 1;
  });

  const entsize = rela ? 12 : 8;
  const table = (of: readonly Reloc[]): Buffer => {
    const out = Buffer.alloc(entsize * of.length);
    of.forEach((r, i) => {
      const symIndex = r.sym === undefined ? 0 : spec.symbols.findIndex((s) => s.name === r.sym) + 1;
      u32(out, entsize * i, r.offset);
      u32(out, entsize * i + 4, (symIndex << 8) | r.type);
      if (rela) {
        u32(out, entsize * i + 8, r.addend ?? 0);
      }
    });
    return out;
  };
  const relSection = (of: readonly Reloc[], applies: string): Written => ({
    name: `${rela ? '.rela' : '.rel'}${applies}`,
    type: rela ? 4 : 9,
    flags: 0,
    addr: 0,
    body: table(of),
    link: '.symtab',
    info: applies,
  });

  const sections: Written[] = [
    { name: '', type: 0, flags: 0, addr: 0, body: Buffer.alloc(0) },
    { name: textName, type: 1, flags: 0x6, addr: spec.textAddr, body: Buffer.from(spec.text) },
    ...(spec.data === undefined
      ? []
      : [
          {
            name: spec.dataName ?? '.data',
            type: 1,
            flags: 0x3,
            addr: spec.dataAddr ?? 0,
            body: Buffer.from(spec.data),
          },
        ]),
    { name: '.symtab', type: 2, flags: 0, addr: 0, body: symtab, link: '.strtab' },
    { name: '.strtab', type: 3, flags: 0, addr: 0, body: names },
    ...(spec.relocs === undefined ? [] : [relSection(spec.relocs, textName)]),
    ...(spec.dataRelocs === undefined ? [] : [relSection(spec.dataRelocs, spec.dataName ?? '.data')]),
    ...(spec.moreSections ?? []).map((m) => ({
      name: m.name,
      type: 1,
      flags: 0x2,
      addr: 0,
      body: Buffer.alloc(m.size),
    })),
  ];
  sections.push({ name: '.shstrtab', type: 3, flags: 0, addr: 0, body: Buffer.alloc(0) });
  const shstrtab = Buffer.from(`${sections.map((s) => s.name).join('\0')}\0`, 'latin1');
  sections[sections.length - 1].body = shstrtab;

  const indexOf = (name: string): number => sections.findIndex((s) => s.name === name);
  const nameAtOf = (name: string): number =>
    sections.slice(0, indexOf(name)).reduce((at, s) => at + s.name.length + 1, 0);

  const offsets: number[] = [];
  let at = 52;
  for (const s of sections) {
    offsets.push(at);
    at += s.body.length;
  }
  const shoff = at;
  const out = Buffer.alloc(shoff + 40 * sections.length);
  out.writeUInt32BE(0x7f454c46, 0);
  out[4] = 1;
  out[5] = le ? 1 : 2;
  out[6] = 1;
  u16(out, 0x10, 1);
  u16(out, 0x12, spec.machine);
  u32(out, 0x20, shoff);
  u16(out, 0x2e, 40);
  u16(out, 0x30, sections.length);
  u16(out, 0x32, sections.length - 1);
  sections.forEach((s, i) => {
    s.body.copy(out, offsets[i]);
    const sh = shoff + 40 * i;
    u32(out, sh, i === 0 ? 0 : nameAtOf(s.name));
    u32(out, sh + 4, s.type);
    u32(out, sh + 8, s.flags);
    u32(out, sh + 12, s.addr);
    u32(out, sh + 16, offsets[i]);
    u32(out, sh + 20, s.body.length);
    u32(out, sh + 24, s.link === undefined ? 0 : indexOf(s.link));
    u32(out, sh + 28, s.info === undefined ? 0 : indexOf(s.info));
  });
  return out;
}
