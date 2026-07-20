// Normalize `objdump -d --no-show-raw-insn` output into the GNU-as text m2c parses — plus the
// m2c target map and the context sanitizer. Benchmark-internal.
//
// asmlift's MIPS/PPC frontends consume objdump directly; m2c does NOT (it wants spimdisasm/GNU-as
// text). To keep BOTH decompilers reading from the SAME reference `.o`, we disassemble once with
// objdump and translate that text here. The translation is faithful (same instructions, same
// order) — it only reshapes syntax: drop the ELF header + address columns, turn `ADDR <sym>:`
// into a `glabel`, synthesize `.LADDR` labels for intra-function branch targets, and (MIPS)
// `$`-prefix registers.
//
// When the object's `objdump -s -r -t` dump is provided, DATA the code references is fed too —
// m2c is starved otherwise: jump tables live in data sections `-d` never shows, and mwcc names
// its anonymous rodata `@N`, which no assembler syntax accepts verbatim. With the dump we
//   • rewrite data-referencing operands into macro syntax (`%hi/%lo`, `@ha/@l`, `@sda21`),
//   • name anonymous objects (`@15` → `data_15`),
//   • append the referenced regions as `.rodata` word lists whose relocated entries point at the
//     same `.L` labels the text uses (that is what lets m2c resolve a jump table),
//   • splice real callee names onto MIPS `jal`s (their relocs are only in `-r`).
// Handled reloc types are a WHITELIST — anything else (notably IDO's PIC GOT16/CALL16 family)
// leaves the instruction untouched, preserving the exact no-dump text for those rows.

export type Isa = 'mips' | 'ppc';

/** The m2c `--target` for a benchmark toolchain's compiler ('c++' only differs for mwcc —
 *  m2c has no C++ dialect for the others, and the dataset never pairs them). */
export function m2cTarget(compiler: string, lang: 'c' | 'c++' = 'c'): string {
  const map: Record<string, string> = { agbcc: 'gba', ido: 'mips-ido-c', gcc: 'mips-gcc-c', mwcc: 'ppc-mwcc-c' };
  return compiler === 'mwcc' && lang === 'c++' ? 'ppc-mwcc-c++' : (map[compiler] ?? 'gba');
}

interface Insn {
  addr: number;
  text: string;
  reloc?: string;
}

interface Reloc {
  off: number;
  type: string;
  sym: string;
  addend: number;
}

interface DumpSymbol {
  addr: number;
  section: string;
  size: number;
  name: string;
}

interface AsmDump {
  symbols: DumpSymbol[];
  relocs: Map<string, Reloc[]>; // section → relocs, offset-sorted
  contents: Map<string, Uint8Array>; // section → bytes
}

const MIPS_REGS = new Set([
  'zero',
  'at',
  'v0',
  'v1',
  'a0',
  'a1',
  'a2',
  'a3',
  't0',
  't1',
  't2',
  't3',
  't4',
  't5',
  't6',
  't7',
  't8',
  't9',
  's0',
  's1',
  's2',
  's3',
  's4',
  's5',
  's6',
  's7',
  's8',
  'k0',
  'k1',
  'gp',
  'sp',
  'fp',
  'ra',
  ...Array.from({ length: 32 }, (_, i) => `f${i}`),
  ...Array.from({ length: 32 }, (_, i) => `$${i}`),
]);

/** `$`-prefix a MIPS register token, leaving immediates/hex/labels untouched. Handles `off(base)`
 *  and `%lo(sym)(base)` memory operands by prefixing the base only. */
function mipsReg(tok: string): string {
  const mem = tok.match(/^(-?(?:0x[0-9a-f]+|\d+)|%lo\([^)]+\))\(([a-z0-9]+)\)$/i);
  if (mem) {
    return `${mem[1]}($${mem[2]})`;
  }
  if (tok.startsWith('$')) {
    return tok;
  } // already `$N`
  if (MIPS_REGS.has(tok)) {
    return `$${tok}`;
  }
  return tok; // immediate, hex, label, symbol, macro
}

/** Parse the shared objdump body into (symbol, instruction list). Branch/jump target addresses are
 *  captured from the `<sym+0xNN>` annotation (objdump prints the absolute target as a bare hex). */
function parse(disasm: string): { sym: string; insns: Insn[] } | null {
  const lines = disasm.split('\n');
  let sym = '';
  const insns: Insn[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const label = line.match(/^([0-9a-f]+)\s+<([^>]+)>:$/i);
    if (label) {
      if (!sym) {
        sym = label[2];
      }
      continue;
    }
    // interleaved relocation line (objdump -r): "\t\t\tR_PPC_REL24  symbol"
    const rel = line.match(/^\s+[0-9a-f]+:\s+(R_[A-Z0-9_]+)\s+(\S+)/);
    if (rel && insns.length) {
      insns[insns.length - 1].reloc = rel[2];
      continue;
    }
    const ins = line.match(/^\s*([0-9a-f]+):\t(.+)$/);
    if (ins) {
      insns.push({ addr: parseInt(ins[1], 16), text: ins[2].trim() });
    }
  }
  return sym ? { sym, insns } : null;
}

/** Parse an `objdump -s -r -t` dump into symbols, per-section relocations and section bytes. */
function parseAsmDump(dump: string): AsmDump {
  const symbols: DumpSymbol[] = [];
  const relocs = new Map<string, Reloc[]>();
  const contents = new Map<string, Uint8Array>();
  let mode: 'sym' | 'reloc' | 'contents' | null = null;
  let current = '';
  const bytes: number[] = [];
  const flushContents = () => {
    if (mode === 'contents' && current) {
      contents.set(current, Uint8Array.from(bytes));
      bytes.length = 0;
    }
  };
  for (const line of dump.split('\n')) {
    if (/^SYMBOL TABLE:/.test(line)) {
      flushContents();
      mode = 'sym';
      continue;
    }
    const rh = line.match(/^RELOCATION RECORDS FOR \[(\S+)\]:/);
    if (rh) {
      flushContents();
      mode = 'reloc';
      current = rh[1];
      relocs.set(current, []);
      continue;
    }
    const ch = line.match(/^Contents of section (\S+):/);
    if (ch) {
      flushContents();
      mode = 'contents';
      current = ch[1];
      continue;
    }
    if (mode === 'sym') {
      const m = line.match(/^([0-9a-f]{8})\s+\S+\s+\S*\s*(\S+)\t([0-9a-f]{8})\s+(\S+)$/);
      if (m) {
        symbols.push({ addr: parseInt(m[1], 16), section: m[2], size: parseInt(m[3], 16), name: m[4] });
      }
    } else if (mode === 'reloc') {
      const m = line.match(/^([0-9a-f]{8})\s+(R_[A-Z0-9_]+)\s+(\S+?)(?:\+0x([0-9a-f]+))?$/);
      if (m) {
        relocs.get(current)!.push({
          off: parseInt(m[1], 16),
          type: m[2],
          sym: m[3],
          addend: m[4] ? parseInt(m[4], 16) : 0,
        });
      }
    } else if (mode === 'contents') {
      const m = line.match(/^ ([0-9a-f]{4,8}) ((?:[0-9a-f]{2,8} ?){1,4})/);
      if (m) {
        for (const group of m[2].trim().split(' ')) {
          for (let i = 0; i + 1 < group.length + 1; i += 2) {
            bytes.push(parseInt(group.slice(i, i + 2), 16));
          }
        }
      }
    }
  }
  flushContents();
  return { symbols, relocs, contents };
}

/** The branch/jump target address embedded in an operand's `<sym+0xNN>`/`<sym>` annotation.
 *  Returns the absolute address or null. */
function branchTarget(text: string): number | null {
  const m = text.match(/<[^>+]+\+0x([0-9a-f]+)>/i);
  if (m) {
    return parseInt(m[1], 16);
  }
  const m0 = text.match(/<[^>+]+>$/); // target is the function entry (offset 0)
  if (m0) {
    return 0;
  }
  return null;
}

interface DataRegion {
  name: string;
  section: string;
  start: number;
  size: number;
}

/** One run's dump-derived state: the parsed dump plus what the text passes accumulate into it —
 *  the data regions referenced by rewritten operands and the jump-table targets their relocated
 *  entries name. Absent entirely (null) when no dump was provided. */
interface DataEmission {
  dump: AsmDump;
  fnSym: string; // the function symbol — its relocs mark jump-table entries alongside `.text`
  regions: Map<string, DataRegion>;
  jtblTargets: Set<number>;
}

/** m2c resolves an indirect jump only through a table symbol named jtbl/jpt_/lbl_/jumptable_ —
 *  a region whose entries carry text relocs IS a jump table, so name it accordingly. */
function isJtbl(e: DataEmission, section: string, start: number, size: number): boolean {
  return (e.dump.relocs.get(section) ?? []).some(
    (x) => x.off >= start && x.off < start + size && (x.sym === '.text' || x.sym === e.fnSym),
  );
}

/** Resolve a data-referencing reloc to a named region, registering it for emission. */
function resolveData(e: DataEmission, r: Reloc): string | null {
  let region: DataRegion | null = null;
  if (r.sym.startsWith('@')) {
    const s = e.dump.symbols.find((x) => x.name === r.sym);
    if (s) {
      const prefix = isJtbl(e, s.section, s.addr, s.size) ? 'jtbl' : 'data';
      region = { name: `${prefix}_${r.sym.slice(1)}`, section: s.section, start: s.addr, size: s.size };
    }
  } else if (r.sym.startsWith('.') && r.sym !== '.text') {
    // section-relative (MIPS REL): the region spans from the addend base to the section end
    const bytes = e.dump.contents.get(r.sym);
    if (bytes) {
      const size = bytes.length - r.addend;
      const prefix = isJtbl(e, r.sym, r.addend, size) ? 'jtbl' : 'data';
      region = {
        name: `${prefix}_${r.sym.slice(1)}_${r.addend.toString(16)}`,
        section: r.sym,
        start: r.addend,
        size,
      };
    }
  }
  if (!region || region.size === 0) {
    return null;
  }
  e.regions.set(region.name, region);
  return region.name;
}

/** Word entries of a region, resolving entry relocs to `.L` text labels; collects the label
 *  targets into `e.jtblTargets`. */
function regionLines(e: DataEmission, region: DataRegion): string[] {
  const bytes = e.dump.contents.get(region.section);
  const rels = e.dump.relocs.get(region.section) ?? [];
  const lines: string[] = ['.rodata', `glabel ${region.name}`];
  for (let off = region.start; off < region.start + region.size; off += 4) {
    const rel = rels.find((x) => x.off === off);
    if (rel && (rel.sym === '.text' || rel.sym === e.fnSym)) {
      // RELA (PPC) carries the addend on the record; REL (MIPS) stores it in the section word
      const word = bytes
        ? ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0
        : 0;
      const target = rel.addend !== 0 ? rel.addend : word;
      e.jtblTargets.add(target);
      lines.push(`.word .L${target.toString(16)}`);
    } else if (bytes) {
      const val = ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
      lines.push(`.word 0x${val.toString(16).toUpperCase()}`);
    }
  }
  return lines;
}

/** Rewrite one instruction's data-referencing operand into macro syntax. Whitelisted reloc
 *  types only — anything else leaves the text untouched. A reloc against a NAMED symbol (an
 *  extern the context declares) takes the symbol name directly, with no region to emit —
 *  dropping it would feed m2c literal zeros (`lui a0,0x0`), poisoning every argument built
 *  from a named global's address. */
function rewriteData(e: DataEmission, ins: Insn, r: Reloc): string | null {
  const named = !r.sym.startsWith('@') && !r.sym.startsWith('.');
  const name = named ? r.sym : resolveData(e, r);
  if (name === null) {
    return null;
  }
  const t = ins.text;
  switch (r.type) {
    case 'R_MIPS_HI16':
      return t.replace(/0x[0-9a-f]+$|\d+$/, `%hi(${name})`);
    case 'R_MIPS_LO16':
      return /\(/.test(t)
        ? t.replace(/(-?(?:0x[0-9a-f]+|\d+))\(/, `%lo(${name})(`)
        : t.replace(/(-?(?:0x[0-9a-f]+|\d+))$/, `%lo(${name})`);
    case 'R_PPC_ADDR16_HA':
      return t.replace(/(-?(?:0x[0-9a-f]+|\d+))$/, `${name}@ha`);
    case 'R_PPC_ADDR16_LO':
      return /\(/.test(t)
        ? t.replace(/(-?(?:0x[0-9a-f]+|\d+))\(/, `${name}@l(`)
        : t.replace(/(-?(?:0x[0-9a-f]+|\d+))$/, `${name}@l`);
    case 'R_PPC_EMB_SDA21': {
      if (named) {
        return null; // base register needs the region's section — stay conservative for externs
      }
      const base = e.regions.get(name)?.section.endsWith('2') ? 'r2' : 'r13';
      return t.replace(/(-?(?:0x[0-9a-f]+|\d+))\(\s*0?r?0?\s*\)/, `${name}@sda21(${base})`);
    }
    default:
      return null;
  }
}

export function disasmToM2c(disasm: string, isa: Isa, asmDump?: string): string {
  const parsed = parse(disasm);
  if (!parsed) {
    throw new Error('disasmToM2c: could not parse objdump output');
  }
  const { sym, insns } = parsed;
  const emission: DataEmission | null = asmDump
    ? { dump: parseAsmDump(asmDump), fnSym: sym, regions: new Map(), jtblTargets: new Set() }
    : null;
  const textRelocs = new Map<number, Reloc>();
  if (emission) {
    for (const r of emission.dump.relocs.get('.text') ?? []) {
      textRelocs.set(r.off & ~3, r);
    }
  }

  // Pass 1 — which addresses need `.LADDR:` labels. Any b*/j* with a local target, EXCEPT calls
  // (`bl`; MIPS `jal` resolves through its reloc below) and register-target forms.
  const targets = new Set<number>();
  for (const ins of insns) {
    if (
      /^[bj]/.test(ins.text) &&
      !/^(bl|blr|blelr|bgelr|bltlr|bgtlr|beqlr|bnelr|bdnzlr|bctr|bctrl|jal|jalr|jr)\b/.test(ins.text)
    ) {
      const t = branchTarget(ins.text);
      if (t !== null) {
        targets.add(t);
      }
    }
  }

  // Pass 2 — render instructions (data rewrites register the referenced regions)…
  const rendered: { addr: number; text: string }[] = [];
  for (const ins of insns) {
    rendered.push({ addr: ins.addr, text: rewriteInsn(ins, isa, textRelocs, emission) });
  }
  // …then materialize the data blocks FIRST: their relocated entries name the `.L` case labels
  // the text must carry.
  const dataBlocks: string[] = [];
  if (emission) {
    for (const region of emission.regions.values()) {
      dataBlocks.push(...regionLines(emission, region));
    }
    for (const t of emission.jtblTargets) {
      targets.add(t);
    }
  }

  const out: string[] = [`glabel ${sym}`];
  for (const r of rendered) {
    if (targets.has(r.addr)) {
      out.push(`.L${r.addr.toString(16)}:`);
    }
    out.push('    ' + r.text);
  }
  out.push(...dataBlocks);
  return out.join('\n') + '\n';
}

function rewriteInsn(ins: Insn, isa: Isa, textRelocs: Map<number, Reloc>, emission: DataEmission | null): string {
  let text = ins.text;
  const dumpReloc = textRelocs.get(ins.addr);
  const isCall = /^(bl|jal)\b/.test(text);
  let dataRewritten = false;
  if (emission && dumpReloc && !isCall) {
    const rw = rewriteData(emission, ins, dumpReloc);
    if (rw !== null) {
      text = rw;
      dataRewritten = true;
    }
  }
  const t = branchTarget(text);
  if (!dataRewritten && t !== null) {
    // Replace the `<sym+0xNN>`/`<sym>` annotation (and the numeric target objdump prints before
    // it): calls take their reloc symbol — the real callee; local branches always take `.L`.
    const label = isCall ? (ins.reloc ?? dumpReloc?.sym ?? `.L${t.toString(16)}`) : `.L${t.toString(16)}`;
    text = text.replace(/(,\s*)?(0x[0-9a-f]+|[0-9a-f]+)?\s*<[^>]+>/i, (_m, comma) => `${comma ?? ' '}${label}`);
  } else if (!dataRewritten && ins.reloc && !dumpReloc && t === null) {
    // no-dump fallback: a non-branch inline reloc (PPC `-d -r`) splices its symbol over the
    // zero placeholder (anonymous `@N` symbols resolve correctly only via the dump path)
    text = text.replace(/\b0x0+\b|\b0+\b/, ins.reloc);
    if (!text.includes(ins.reloc)) {
      text = `${text} ${ins.reloc}`;
    }
  }
  if (isa === 'mips') {
    const sp = text.match(/^(\S+)\s+(.*)$/);
    if (sp) {
      const ops = sp[2]
        .split(',')
        .map((o) => mipsReg(o.trim()))
        .join(', ');
      text = `${sp[1]}\t${ops}`;
    }
  }
  return text;
}

// GCC attributes survive project preprocessing but m2c's C context parser (pycparser) cannot
// read them — the m2c ecosystem strips them when generating a context. ONE pattern, used by the
// harness (sanitizeM2cContext) and embedded as the perl expression in the reproduction scripts;
// the script-fidelity gate byte-compares m2c's output, so the two copies cannot drift silently.
export const M2C_CTX_ATTRIBUTE_RE = String.raw`__attribute__\s*\(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\)`;

/** A project context as m2c can parse it: GCC attributes stripped, nothing else touched. */
export function sanitizeM2cContext(ctx: string): string {
  return ctx.replaceAll(new RegExp(M2C_CTX_ATTRIBUTE_RE, 'g'), '');
}
