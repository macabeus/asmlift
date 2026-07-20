// asmlift — shared objdump-text scaffolding for the MIPS and PPC frontends. The Thumb frontend
// parses GNU-as text, not objdump, so it does not route through here.
import { FrontendUnsupportedError } from './errors';

/** Slice a multi-symbol objdump listing down to ONE function's lines. objdump marks each
 *  function with an `ADDR <sym>:` header line; when headers are present the input is sliced to
 *  exactly the requested symbol — and an ABSENT symbol declines LOUD, because emitting some
 *  other function's body under the requested name is precisely the silent miscompile the
 *  cardinal rule forbids. Headerless input (a raw instruction fragment) passes through. */
export function sliceSymbol(disasm: string, symbol: string): string {
  const lines = disasm.split('\n');
  const headers: { line: number; sym: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[0-9a-f]+\s+<([^>]+)>:\s*$/i);
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

/** One disassembled instruction. `target` is a decoded branch-target address (objdump prints the
 *  target as `10 <sym+0x10>` in the last operand); `sym` is a relocation-attached callee symbol
 *  (PPC `-r` output), absent otherwise. */
export interface DisasmInstr {
  addr: number;
  mnemonic: string;
  ops: string[];
  target?: number;
  sym?: string;
}

export interface DisasmOptions {
  /** Attach relocation lines (`ADDR: R_* <sym>[+addend]`) to the PRECEDING instruction — the
   *  callee symbol for a `bl` whose encoded offset is a 0 placeholder (PPC `-r` output). Tested
   *  BEFORE the instruction regex, which would otherwise mis-read `R_PPC_…` as a mnemonic. */
  relocs?: boolean;
  /** Strip branch-prediction hint suffixes glued onto the mnemonic (`blt-`, `bge+`, `bgelr-`).
   *  The suffix is a prediction hint, not a different instruction — without stripping, the
   *  mnemonic misses the cond tables and the branch is silently dropped. */
  hintSuffixes?: boolean;
}

/** Parse objdump `-d --no-show-raw-insn` output into a flat instruction list with addresses. */
export function parseDisasm(disasm: string, opts: DisasmOptions = {}): DisasmInstr[] {
  const out: DisasmInstr[] = [];
  for (const raw of disasm.split('\n')) {
    if (opts.relocs) {
      const rel = raw.match(/^\s+[0-9a-f]+:\s+R_\w+\s+(\S+)/i);
      if (rel) {
        if (out.length) {
          out[out.length - 1].sym = rel[1].split('+')[0];
        }
        continue;
      }
    }
    const m = opts.hintSuffixes
      ? raw.match(/^\s*([0-9a-f]+):\s+([a-z][a-z0-9._]*)([-+]?)\s*(.*?)\s*$/i)
      : raw.match(/^\s*([0-9a-f]+):\s+([a-z][a-z0-9._]*)\s*(.*?)\s*$/i);
    if (!m) {
      continue;
    }
    const addr = parseInt(m[1], 16);
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
