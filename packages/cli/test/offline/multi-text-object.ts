// A relocatable ELF32 whose code lives in several sections ALL NAMED `.text`, each starting at
// address 0 — the shape every CodeWarrior-built GameCube object has, and the one a name-keyed read
// of a whole-object disassembly cannot tell apart. Built here rather than committed: the real ones
// are split from game binaries.
import { Buffer } from 'node:buffer';

const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_RELA = 4;
const SHT_STRTAB = 3;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

interface Sym {
  name: string;
  shndx: number;
  value: number;
}
interface Sec {
  name: string;
  type: number;
  flags: number;
  info: number;
  link: number;
  body: Buffer;
  entsize?: number;
}

/** A big-endian ELF32 relocatable holding `code.length` sections all named `.text`, one `.rela.text`
 *  per code section, a `.rodata`, and a symbol table naming each code section's function. */
export function multiTextObject(code: readonly Buffer[], relocSymbol: readonly string[]): Buffer {
  const strings = (items: readonly string[]) => {
    const at = new Map<string, number>([['', 0]]);
    const parts = [Buffer.from([0])];
    let n = 1;
    for (const s of items) {
      if (!at.has(s)) {
        at.set(s, n);
        parts.push(Buffer.from(`${s}\0`));
        n += s.length + 1;
      }
    }
    return { at: (s: string) => at.get(s) ?? 0, bytes: Buffer.concat(parts) };
  };

  const funcs = code.map((_, i) => `f${i}`);
  const symNames = ['', ...funcs, 'roData', 'ext'];
  const str = strings(symNames);
  // section layout: NULL, (.text, .rela.text) per code section, .rodata, .symtab, .strtab, .shstrtab
  const textAt = (i: number) => 1 + i * 2;
  const rodataAt = 1 + code.length * 2;
  const symtabAt = rodataAt + 1;
  const strtabAt = symtabAt + 1;
  const shstrtabAt = strtabAt + 1;

  const syms: Sym[] = [
    { name: '', shndx: 0, value: 0 },
    ...funcs.map((f, i) => ({ name: f, shndx: textAt(i), value: 0 })),
    { name: 'roData', shndx: rodataAt, value: 0 },
    { name: 'ext', shndx: 0, value: 0 },
  ];
  const symtab = Buffer.alloc(16 * syms.length);
  syms.forEach((s, i) => {
    symtab.writeUInt32BE(str.at(s.name), i * 16);
    symtab.writeUInt32BE(s.value, i * 16 + 4);
    symtab.writeUInt8(i === 0 ? 0 : 2, i * 16 + 12); // STT_FUNC/STT_OBJECT is immaterial here
    symtab.writeUInt16BE(s.shndx, i * 16 + 14);
  });
  const symIndex = (name: string) => syms.findIndex((s) => s.name === name);
  const rela = (target: string) => {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(0, 0);
    b.writeUInt32BE((symIndex(target) << 8) | 26 /* R_PPC_REL24 */, 4);
    return b;
  };

  const sections: Sec[] = [
    { name: '', type: 0, flags: 0, info: 0, link: 0, body: Buffer.alloc(0) },
    ...code.flatMap((body, i) => [
      { name: '.text', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, info: 0, link: 0, body },
      {
        name: '.rela.text',
        type: SHT_RELA,
        flags: 0,
        info: textAt(i),
        link: symtabAt,
        body: rela(relocSymbol[i]),
        entsize: 12,
      },
    ]),
    { name: '.rodata', type: SHT_PROGBITS, flags: SHF_ALLOC, info: 0, link: 0, body: Buffer.from('ro') },
    { name: '.symtab', type: SHT_SYMTAB, flags: 0, info: 1, link: strtabAt, body: symtab, entsize: 16 },
    { name: '.strtab', type: SHT_STRTAB, flags: 0, info: 0, link: 0, body: str.bytes },
    { name: '.shstrtab', type: SHT_STRTAB, flags: 0, info: 0, link: 0, body: Buffer.alloc(0) },
  ];
  const shstr = strings(sections.map((s) => s.name));
  sections[shstrtabAt].body = shstr.bytes;

  const offsets: number[] = [];
  let at = 52;
  for (const s of sections) {
    offsets.push(at);
    at += s.body.length;
  }
  at += (4 - (at % 4)) % 4;
  const out = Buffer.alloc(at + sections.length * 40);
  out.writeUInt32BE(0x7f454c46, 0);
  out[4] = 1; // ELFCLASS32
  out[5] = 2; // big-endian
  out[6] = 1;
  out.writeUInt16BE(1, 0x10); // ET_REL
  out.writeUInt16BE(20, 0x12); // EM_PPC
  out.writeUInt32BE(at, 0x20);
  out.writeUInt16BE(52, 0x28);
  out.writeUInt16BE(40, 0x2e);
  out.writeUInt16BE(sections.length, 0x30);
  out.writeUInt16BE(shstrtabAt, 0x32);
  sections.forEach((s, i) => {
    s.body.copy(out, offsets[i]);
    const sh = at + i * 40;
    out.writeUInt32BE(shstr.at(s.name), sh);
    out.writeUInt32BE(s.type, sh + 4);
    out.writeUInt32BE(s.flags, sh + 8);
    out.writeUInt32BE(offsets[i], sh + 16);
    out.writeUInt32BE(s.body.length, sh + 20);
    out.writeUInt32BE(s.link, sh + 24);
    out.writeUInt32BE(s.info, sh + 28);
    out.writeUInt32BE(1, sh + 32);
    out.writeUInt32BE(s.entsize ?? 0, sh + 36);
  });
  return out;
}

/** Everything a reader needs back out of an object, read independently of the writer. */
export function readBack(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  const shoff = b.readUInt32BE(0x20);
  const shnum = b.readUInt16BE(0x30);
  const shstrndx = b.readUInt16BE(0x32);
  const sec = (i: number) => {
    const sh = shoff + i * 40;
    return {
      name: b.readUInt32BE(sh),
      type: b.readUInt32BE(sh + 4),
      flags: b.readUInt32BE(sh + 8),
      offset: b.readUInt32BE(sh + 16),
      size: b.readUInt32BE(sh + 20),
      link: b.readUInt32BE(sh + 24),
      info: b.readUInt32BE(sh + 28),
    };
  };
  const sections = Array.from({ length: shnum }, (_, i) => sec(i));
  const shstr = sections[shstrndx].offset;
  const name = (base: number, off: number) => b.toString('latin1', base + off, b.indexOf(0, base + off));
  const named = sections.map((s) => ({ ...s, nm: name(shstr, s.name) }));
  const symtab = named.find((s) => s.type === SHT_SYMTAB)!;
  const strtab = sections[symtab.link].offset;
  const symbols: { name: string; value: number; shndx: number }[] = [];
  for (let at = symtab.offset; at + 16 <= symtab.offset + symtab.size; at += 16) {
    symbols.push({
      name: name(strtab, b.readUInt32BE(at)),
      value: b.readUInt32BE(at + 4),
      shndx: b.readUInt16BE(at + 14),
    });
  }
  const relocationTargets = named
    .filter((s) => s.type === SHT_RELA)
    .flatMap((s) => {
      const out: { section: number; target: string }[] = [];
      for (let at = s.offset; at + 12 <= s.offset + s.size; at += 12) {
        out.push({ section: s.info, target: symbols[b.readUInt32BE(at + 4) >>> 8].name });
      }
      return out;
    });
  const body = (s: { offset: number; size: number }) => b.subarray(s.offset, s.offset + s.size);
  return { sections: named, symbols, relocationTargets, body };
}
