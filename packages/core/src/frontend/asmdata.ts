// asmlift — the AsmData side-table. MIPS/PPC frontends parse
// `objdump -d` (`.text` only), so a dense-switch's case→target jump table — which lives in a DATA
// section (`.rodata`/`.data`/`.sdata2`) as bytes + relocations — never reaches them. This module is
// an ISA-agnostic bag of `{ section bytes, relocations, symbols }` extracted from a companion
// `objdump -s`/`-r`/`-t` pass on the SAME object, threaded as an OPTIONAL `lift()` parameter.
// Absent ⇒ the frontends decline; only Regime-B recovery reads it. Reloc *interpretation* (MIPS
// gp-relative vs PPC named-symbol) stays per-frontend — this layer is pure parse + a fail-closed
// table reader.
//
// Empirically grounded against the three
// toolchains: IDO stores `.text` offsets in `.rodata` with `R_MIPS_GPREL32 .text` relocs; KMC gcc
// stores them in `.rodata` with `R_MIPS_32 .text`; mwcc stores ZERO bytes in `.data` and carries
// the whole map in `R_PPC_ADDR32 <fn>+<off>` relocs. All three reduce to: target .text offset =
// symbolBase(reloc.sym) + reloc.addend + inlineWord — the reader below.

/** One relocation record (from `objdump -r`). `sym` is the target symbol (a section symbol like
 *  `.text`/`.rodata`, an object symbol like `@15`, or a function symbol like `sw_jt`); `addend` is the
 *  RELA addend (0 for REL relocs, whose addend lives inline in the section bytes). */
export interface Reloc {
  section: string;
  offset: number;
  type: string;
  sym: string;
  addend: number;
}

/** A parsed object's data sections + relocations + symbol offsets. Big-endian for MIPS-N64 / PPC (the
 *  only Regime-B consumers today); `bigEndian` records it so the word reader is not ISA-hardcoded. */
export interface AsmData {
  sections: Map<string, Uint8Array>; // section name → raw bytes (file order)
  relocs: Reloc[];
  symbols: Map<string, { section: string; value: number }>; // symbol name → {section, offset-in-section}
  bigEndian: boolean;
}

const readU32 = (b: Uint8Array, off: number, big: boolean): number =>
  big
    ? ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0
    : ((b[off + 3] << 24) | (b[off + 2] << 16) | (b[off + 1] << 8) | b[off]) >>> 0;

// Parse an `objdump -r` VALUE field: `sw_jt+0x00000020` / `.text` / `@15` → {sym, addend}.
function parseRelocValue(v: string): { sym: string; addend: number } {
  const plus = v.indexOf('+');
  if (plus < 0) {
    return { sym: v, addend: 0 };
  }
  const a = v.slice(plus + 1).trim();
  return { sym: v.slice(0, plus), addend: parseInt(a, /^0x/i.test(a) ? 16 : 10) >>> 0 };
}

/** Parse the three companion objdump dumps into an `AsmData`. Pure (no shell) so it is unit-testable
 *  against captured output; the callers (cli score.ts, benchmark cache.ts) supply the strings. */
export function parseAsmData(
  sectionsDump: string,
  relocsDump: string,
  symbolsDump: string,
  bigEndian: boolean,
): AsmData {
  // --- `objdump -s`: `Contents of section .rodata:` then ` 0000 00000034 0000003c …  ascii` ---
  const sections = new Map<string, Uint8Array>();
  let curSec: string | null = null;
  let bytes: number[] = [];
  const flush = () => {
    if (curSec) {
      sections.set(curSec, Uint8Array.from(bytes));
    }
    curSec = null;
    bytes = [];
  };
  for (const line of sectionsDump.split('\n')) {
    const hdr = line.match(/^Contents of section (\S+):/);
    if (hdr) {
      flush();
      curSec = hdr[1];
      continue;
    }
    if (!curSec) {
      continue;
    }
    // ` 0000 00000034 0000003c 00000044 0000004c  ...4...<...D...L` — hex columns end at the 2-space
    // gap before the ascii gutter; take everything between the offset and that gap.
    const m = line.match(/^\s*[0-9a-f]+\s+([0-9a-f ]+?)\s{2,}/i);
    if (!m) {
      continue;
    }
    for (const grp of m[1].trim().split(/\s+/)) {
      for (let i = 0; i + 1 < grp.length; i += 2) {
        bytes.push(parseInt(grp.slice(i, i + 2), 16));
      }
    }
  }
  flush();

  // --- `objdump -r`: `RELOCATION RECORDS FOR [.text]:` then `OFFSET TYPE VALUE` rows ---
  const relocs: Reloc[] = [];
  let relSec: string | null = null;
  for (const line of relocsDump.split('\n')) {
    const hdr = line.match(/^RELOCATION RECORDS FOR \[(\S+)\]:/);
    if (hdr) {
      relSec = hdr[1];
      continue;
    }
    if (!relSec) {
      continue;
    }
    const m = line.match(/^([0-9a-f]+)\s+(R_\S+)\s+(\S+)/i);
    if (!m) {
      continue;
    }
    const { sym, addend } = parseRelocValue(m[3]);
    relocs.push({ section: relSec, offset: parseInt(m[1], 16), type: m[2], sym, addend });
  }

  // --- `objdump -t`: `VALUE FLAGS SECTION\tSIZE NAME` (section/size split by TAB) ---
  const symbols = new Map<string, { section: string; value: number }>();
  for (const line of symbolsDump.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const left = line.slice(0, tab),
      right = line.slice(tab + 1);
    const lm = left.match(/^([0-9a-f]+)\s+.{6,8}\s(\S+)\s*$/i); // value … flags(7) section
    const rm = right.match(/^[0-9a-f]+\s+(.+?)\s*$/i); // size name
    if (!lm || !rm) {
      continue;
    }
    symbols.set(rm[1], { section: lm[2], value: parseInt(lm[1], 16) });
  }

  return { sections, relocs, symbols, bigEndian };
}

/** Read a dense jump table's N target `.text` byte-offsets, or `null` if ANYTHING doesn't resolve
 *  cleanly (fail-closed — a partial/ambiguous table declines, never a wrong switch).
 *
 *  `tableSym`/`tableAddend` locate the table (from the dispatch's `.text` reloc: MIPS `GOT16`/`HI16`/
 *  `LO16 .rodata`; PPC `ADDR16_HA/LO @tbl`). Each entry resolves to a `.text` offset via
 *  `symbolBase(entryReloc.sym) + entryReloc.addend + inlineWord`, and MUST target `.text`. */
export function readJumpTable(ad: AsmData, tableSym: string, tableAddend: number, n: number): number[] | null {
  if (n < 2) {
    return null;
  }
  const tsym = ad.symbols.get(tableSym);
  const section = tsym ? tsym.section : tableSym; // ".rodata" is its own section symbol
  const baseOff = (tsym ? tsym.value : 0) + tableAddend;
  const secBytes = ad.sections.get(section);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const slot = baseOff + i * 4;
    const r = ad.relocs.find((x) => x.section === section && x.offset === slot);
    if (!r) {
      return null;
    } // every entry must be a relocated pointer
    const rsym = ad.symbols.get(r.sym);
    const rsec = rsym ? rsym.section : r.sym; // ".text" section symbol → ".text"
    if (rsec !== '.text') {
      return null;
    } // only .text-directed entries are valid
    const inline = secBytes && slot + 4 <= secBytes.length ? readU32(secBytes, slot, ad.bigEndian) : 0;
    out.push(((rsym ? rsym.value : 0) + r.addend + inline) >>> 0);
  }
  return out;
}

/** The single `.text` relocation whose *instruction* address is `insnAddr` (a table-base HI/LO/GOT16
 *  or ADDR16 reloc), or `null`. Used by a frontend to find where its dispatch's table lives. */
export function textRelocAt(ad: AsmData, insnAddr: number): Reloc | null {
  return ad.relocs.find((r) => r.section === '.text' && r.offset === insnAddr) ?? null;
}
