// asmlift — shared objdump-text scaffolding for the MIPS and PPC frontends. The Thumb frontend
// parses GNU-as text, not objdump, so it does not route through here.
import { FrontendUnsupportedError } from './errors';

/** The objdump function-header line, exported through the two readers below so that nothing can
 *  disagree about where a function starts. GREEDY to the LAST `>`: a C++ template symbol contains
 *  `>` of its own (`invoke__Q23zen20NumberPicCallBack<i>FP7P2DPane`), and a header a pattern cannot
 *  see is worse than one it misreads — the PRECEDING function's slice runs on through it, and the
 *  prologue split swallows it. */
const HEADER_LINE = /^[0-9a-f]+\s+<(.+)>:\s*$/i;
const HEADER_SEARCH = new RegExp(HEADER_LINE.source, 'im');

/** Character offset of the FIRST function header in an objdump listing, or -1 — everything before
 *  it is the listing's own prologue (`target.o: file format …`, section headings). */
export function firstFunctionHeader(disasm: string): number {
  return disasm.search(HEADER_SEARCH);
}

/** Slice a multi-symbol objdump listing down to ONE function's lines. objdump marks each
 *  function with an `ADDR <sym>:` header line; when headers are present the input is sliced to
 *  exactly the requested symbol — and an ABSENT symbol declines LOUD, because emitting some
 *  other function's body under the requested name is precisely the silent miscompile the
 *  cardinal rule forbids. Headerless input (a raw instruction fragment) passes through. */
export function sliceSymbol(disasm: string, symbol: string): string {
  const lines = disasm.split('\n');
  const headers: { line: number; sym: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER_LINE);
    if (m) {
      headers.push({ line: i, sym: m[1] });
    }
  }
  if (headers.length === 0) {
    return disasm;
  }
  const at = headers.findIndex((h) => h.sym === symbol);
  if (at === -1) {
    throw new FrontendUnsupportedError(
      `symbol '${symbol}' not found in the disassembly (symbols present: ${headers.map((h) => h.sym).join(', ')})`,
    );
  }
  const end = at + 1 < headers.length ? headers[at + 1].line : lines.length;
  return lines.slice(headers[at].line, end).join('\n');
}

/** A relocation objdump printed (with `-r`) under the instruction whose operand field it fills.
 *  All three fields carry meaning the rest of the listing does not:
 *  the TYPE says WHICH field — an `@ha` immediate half (`R_PPC_ADDR16_HA`), an `@l` half
 *  (`R_PPC_ADDR16_LO`), a small-data memory base (`R_PPC_EMB_SDA21`), a call target
 *  (`R_PPC_REL24`) — and the mnemonic cannot stand in for it; the ADDEND is part of the address,
 *  so `SYM` and `SYM+0x4` are different words; the SYMBOL is the name. */
export interface DisasmReloc {
  type: string;
  sym: string;
  addend: number;
}

/** One disassembled instruction. `target` is a decoded branch-target address (objdump prints the
 *  target as `10 <sym+0x10>` in the last operand); `reloc` is the relocation objdump attached to
 *  this instruction (PPC `-r` output), absent otherwise. */
export interface DisasmInstr {
  addr: number;
  mnemonic: string;
  ops: string[];
  target?: number;
  reloc?: DisasmReloc;
}

export interface DisasmOptions {
  /** Attach relocation lines (`ADDR: R_* <sym>[+addend]`) to the PRECEDING instruction — the
   *  callee symbol for a `bl` whose encoded offset is a 0 placeholder, the named global behind a
   *  printed-as-0 immediate or memory base (PPC `-r` output). Tested BEFORE the instruction regex,
   *  which would otherwise mis-read `R_PPC_…` as a mnemonic. */
  relocs?: boolean;
  /** Strip branch-prediction hint suffixes glued onto the mnemonic (`blt-`, `bge+`, `bgelr-`).
   *  The suffix is a prediction hint, not a different instruction — without stripping, the
   *  mnemonic misses the cond tables and the branch is silently dropped. */
  hintSuffixes?: boolean;
  /** What an all-zero word decodes to on this architecture (MIPS: `nop` — `sll zero,zero,0`).
   *  objdump prints a run of zero words as a bare `...` instead of the words themselves, and the
   *  words it stands for are real program text: a `mflo` hazard pad sits between a multiply and
   *  the branch that reads it. Without a decoding they cannot be recovered, so the listing is
   *  refused rather than parsed one word short (a zero word is not an instruction at all on
   *  PowerPC, whose frontend therefore supplies none). */
  zeroWord?: string;
}

/** Fixed instruction width, in bytes, of every ISA that reaches this reader (MIPS, PowerPC). The
 *  Thumb frontend, the one variable-width target, parses GNU-as text and does not route here. */
const WORD = 4;

/** objdump's elision of a run of zero words: a bare `...` on its own line (`-d` prints it only
 *  for zeroes; `-z` prints the words instead). */
const ELISION_LINE = /^\s*\.\.\.\s*$/;

/** An instruction line's address column, whatever the mnemonic column holds. A line that carries
 *  an address carries a WORD of the function, so one this reader cannot decode must not be
 *  skipped: the words after it would keep their addresses while the list lost one, and every
 *  reader of that list — the delay slot at `branch + 4` above all — would be answering about a
 *  word that is not there. */
const ADDRESSED_LINE = /^\s*[0-9a-f]+:\s/i;

/** Replace an elision with the zero words it stands for: from the word after the last instruction
 *  parsed up to (not including) the address of the line that ends the run. Every way the run's
 *  extent is unknowable refuses by name — a run of unknown length is exactly the silent hole this
 *  exists to remove. A run with NO line after it is not a hole: it is the padding past the last
 *  word objdump printed, it bounds nothing, and nothing is invented for it. */
function expandElision(out: DisasmInstr[], next: number, zeroWord: string | undefined): void {
  const prev = out[out.length - 1];
  const hex = (a: number) => `0x${a.toString(16)}`;
  if (!prev) {
    throw new FrontendUnsupportedError(
      `objdump elided a run of zero words ('...') before the first instruction of the listing, ` +
        `ending at ${hex(next)}: where the run begins is unknown`,
    );
  }
  const from = prev.addr + WORD;
  if (zeroWord === undefined) {
    throw new FrontendUnsupportedError(
      `objdump elided a run of zero words ('...') at ${hex(from)}, but a zero word is not a ` +
        `decodable instruction on this architecture`,
    );
  }
  if (next <= from || (next - from) % WORD !== 0) {
    throw new FrontendUnsupportedError(
      `objdump elided a run of zero words ('...') between ${hex(from)} and ${hex(next)}, which is ` +
        `not a whole number of instruction words`,
    );
  }
  for (let addr = from; addr < next; addr += WORD) {
    out.push({ addr, mnemonic: zeroWord, ops: [] });
  }
}

/** Attach a parsed relocation to the instruction it belongs to. The binding is POSITIONAL —
 *  objdump prints a relocation directly beneath its instruction — and both ways that assumption
 *  can break fail LOUD, because each one silently relocates the wrong operand: an offset outside
 *  the preceding instruction's four bytes means the listing is not the assumed shape (the offset
 *  points at the relocated FIELD, so a 16-bit immediate's offset is the instruction's address + 2),
 *  and a second relocation on one instruction would overwrite the first, leaving one symbol
 *  standing for two. */
function attachReloc(out: DisasmInstr[], offset: number, reloc: DisasmReloc): void {
  const ins = out[out.length - 1];
  if (!ins || offset < ins.addr || offset >= ins.addr + 4) {
    throw new FrontendUnsupportedError(
      `relocation '${reloc.type} ${reloc.sym}' at 0x${offset.toString(16)} does not fall inside ` +
        (ins ? `the preceding instruction ('${ins.mnemonic}' at 0x${ins.addr.toString(16)})` : 'any instruction'),
    );
  }
  if (ins.reloc) {
    throw new FrontendUnsupportedError(
      `two relocations on one instruction ('${ins.mnemonic}' at 0x${ins.addr.toString(16)}): ` +
        `'${ins.reloc.type} ${ins.reloc.sym}' and '${reloc.type} ${reloc.sym}'`,
    );
  }
  ins.reloc = reloc;
}

/** Parse objdump `-d --no-show-raw-insn` output into a flat instruction list with addresses. */
export function parseDisasm(disasm: string, opts: DisasmOptions = {}): DisasmInstr[] {
  const out: DisasmInstr[] = [];
  let elided = false;
  for (const raw of disasm.split('\n')) {
    if (ELISION_LINE.test(raw)) {
      elided = true;
      continue;
    }
    if (opts.relocs) {
      const rel = raw.match(/^\s+([0-9a-f]+):\s+(R_\w+)\s+([^\s+-]+)(?:\s*([+-])\s*(0x[0-9a-f]+|\d+))?\s*$/i);
      if (rel) {
        attachReloc(out, parseInt(rel[1], 16), {
          type: rel[2],
          sym: rel[3],
          addend: rel[5] ? parseImm(rel[5]) * (rel[4] === '-' ? -1 : 1) : 0,
        });
        continue;
      }
    }
    const m = opts.hintSuffixes
      ? raw.match(/^\s*([0-9a-f]+):\s+([a-z][a-z0-9._]*)([-+]?)\s*(.*?)\s*$/i)
      : raw.match(/^\s*([0-9a-f]+):\s+([a-z][a-z0-9._]*)\s*(.*?)\s*$/i);
    if (!m) {
      if (ADDRESSED_LINE.test(raw)) {
        throw new FrontendUnsupportedError(
          `objdump line '${raw.trim()}' carries an address but no instruction this reader can decode`,
        );
      }
      continue;
    }
    const addr = parseInt(m[1], 16);
    if (elided) {
      expandElision(out, addr, opts.zeroWord);
      elided = false;
    }
    const mnemonic = m[2]; // hint suffix (group 3), when parsed, is dropped
    const opsStr = opts.hintSuffixes ? m[4] : m[3];
    const ops = opsStr
      ? opsStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    let target: number | undefined;
    const tm = ops.length ? ops[ops.length - 1].match(/^([0-9a-f]+)\s+</i) : null;
    if (tm) {
      target = parseInt(tm[1], 16);
    }
    out.push({ addr, mnemonic, ops, target });
  }
  return out;
}

/** An objdump immediate: decimal or hex (objdump prints hex as 0x…, negatives as -N). */
export const parseImm = (s: string): number => parseInt(s, /^-?0x/i.test(s) ? 16 : 10);

/** A memory operand `off(base)` (e.g. `8(a0)`, `-4(r1)`) → constant byte offset + base register.
 *  `baseRe` narrows what counts as a base (PPC: `r\d+` — a non-register base is an SDA/global
 *  placeholder the caller must decline). A non-matching operand falls back to offset 0 with the
 *  parens stripped. */
export function parseMem(operand: string, baseRe: RegExp = /\w+/): { off: number; base: string } {
  const m = operand.match(new RegExp(`^(-?(?:0x)?[0-9a-f]+)\\((${baseRe.source})\\)$`, 'i'));
  return m ? { off: parseImm(m[1]), base: m[2] } : { off: 0, base: operand.replace(/[()]/g, '') };
}
