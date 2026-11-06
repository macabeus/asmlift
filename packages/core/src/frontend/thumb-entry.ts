// asmlift — how many words of its incoming stack area a Thumb callee's straight-line entry loads.
//
// A call nothing declares that stages words at [sp,#0] upward is refused, because the code alone
// cannot say where its outgoing stack block ends (frontend/stackargs.ts). The callee's body can say
// where it at least reaches: a compiled callee loads incoming stack word k only as its argument
// |argRegs|+k, so a body that loads word n-1 takes at least n stack words. That LOWER bound is
// `StackArgsCall.bodyReads`, and the caller's staged words close it from above.
//
// The callee is not lifted: a body is often one this frontend cannot lift (a `bl` to a label of its
// own, a computed jump), and a lift would answer nothing for it. Its stack arguments are loaded
// first thing, so one pass over its ENTRY says it: the sp delta through `push`, `sub sp, #k` and
// `add sp, #-k`, and a word load `ldr rD, [sp, #k]` with k at or past the delta, of a word nothing
// earlier in the pass stored, is incoming word (k - delta) / 4.
//
// THE PASS STOPS, keeping what it read, at the first instruction after which "the next instruction
// runs with this sp, on every call" or "this frame word holds the caller's word" may no longer hold:
//   - a branch, a call, a `bx`, a `pop`, a write of pc, a label, a directive, or the end of the text;
//   - a frame address copied or added into a register (`mov rD, sp`, `add rD, sp, #k`, `add rD,
//     sp`): the words above it may then be written through that register;
//   - (halfwords) any encoding the decoder below does not model.
// A store through any other base is followed past: a C function addresses its incoming stack words
// only through its own frame address, which stops the pass first, so no pointer it was handed or
// loaded reaches them (`nine` stores to a global between its loads of words 2 and 3).
// Every load before the stop ran on every call, with the delta tracked to it. It gives NO answer at a
// write of sp it does not model (`mov sp, rS`, `add sp, rS`), or a delta that would go negative.
//
// Two front doors read the same pass: GNU-as text holding the callee's label (the input, or a
// listing handed in) and the callee's first halfwords out of a linked image (cli elf-bodies.ts
// `{kind: 'thumb'}`), through a decoder of the prologue subset of the Thumb formats.

/** One instruction as the pass reads it. */
type Step =
  | { readonly kind: 'push'; readonly words: number }
  | { readonly kind: 'sp-add'; readonly bytes: number }
  | { readonly kind: 'load-sp'; readonly off: number }
  | { readonly kind: 'store-sp'; readonly off: number }
  | { readonly kind: 'other' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'refuse' };

/** The most incoming words a scan answers: past it the entry is no call a compiler wrote (the Thumb
 *  frontend's own arity ceiling, 16 words, less the four argument registers). */
const MAX_INCOMING_WORDS = 12;

/** One past the highest incoming stack word `steps` load, or undefined where they load none or the
 *  pass refuses (see the header). */
function incomingWords(steps: Iterable<Step>): number | undefined {
  let delta = 0;
  const stored = new Set<number>();
  let reads = 0;
  for (const s of steps) {
    if (s.kind === 'stop') {
      break;
    }
    switch (s.kind) {
      case 'refuse':
        return undefined;
      case 'push':
        delta += 4 * s.words;
        break;
      case 'sp-add':
        delta -= s.bytes;
        if (delta < 0 || delta % 4 !== 0) {
          return undefined;
        }
        break;
      case 'store-sp':
        if (s.off >= delta) {
          stored.add((s.off - delta) / 4);
        }
        break;
      case 'load-sp': {
        const word = (s.off - delta) / 4;
        if (s.off >= delta && !stored.has(word)) {
          reads = Math.max(reads, word + 1);
        }
        break;
      }
      default:
        break;
    }
  }
  return reads === 0 || reads > MAX_INCOMING_WORDS ? undefined : reads;
}

const SP = /^(?:sp|r13)$/i;
const PC = /^(?:pc|r15)$/i;

/** The register count of a `{…}` list (`{r4-r7, lr}`), or undefined for one it cannot read. */
function listWords(op: string): number | undefined {
  const m = /^\{(.*)\}$/.exec(op.trim());
  if (m === null) {
    return undefined;
  }
  let n = 0;
  for (const part of m[1].split(',').map((p) => p.trim())) {
    const range = /^r(\d+)\s*-\s*r(\d+)$/i.exec(part);
    if (range !== null) {
      n += Number(range[2]) - Number(range[1]) + 1;
    } else if (/^(?:r\d+|lr|sp|pc|ip|fp|sl|sb)$/i.test(part)) {
      n += 1;
    } else {
      return undefined;
    }
  }
  return n;
}

const imm = (op: string | undefined): number | undefined => {
  const m = op === undefined ? null : /^#\s*(-?)(0x[0-9a-f]+|\d+)$/i.exec(op.trim());
  return m === null ? undefined : (m[1] === '-' ? -1 : 1) * Number(m[2]);
};

/** `[sp]` / `[sp, #k]` → k; undefined for any other address. */
function spAddress(op: string): number | undefined {
  const m = /^\[\s*(\w+)\s*(?:,\s*(#[^\]]+))?\]$/.exec(op.trim());
  if (m === null || !SP.test(m[1])) {
    return undefined;
  }
  return m[2] === undefined ? 0 : imm(m[2]);
}

/** Split an operand list at its top-level commas. */
function operands(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') {
    out.push(cur.trim());
  }
  return out;
}

/** One GNU-as Thumb line, read as a step. */
function textStep(line: string): Step {
  const m = /^([a-z.]+)\s*(.*)$/i.exec(line);
  if (m === null) {
    return { kind: 'stop' };
  }
  const mn = m[1].toLowerCase();
  const ops = operands(m[2]);
  if (mn.startsWith('.')) {
    return { kind: 'stop' };
  }
  if (mn === 'push') {
    const n = ops.length === 1 ? listWords(ops[0]) : undefined;
    return n === undefined ? { kind: 'stop' } : { kind: 'push', words: n };
  }
  const dest = ops[0] ?? '';
  // `add sp, #k` / `add sp, sp, #k` / `sub …`: the only writes of sp the pass follows
  if ((mn === 'add' || mn === 'sub') && SP.test(dest) && (ops.length === 2 || (ops.length === 3 && SP.test(ops[1])))) {
    const k = imm(ops[ops.length - 1]);
    if (k === undefined) {
      return { kind: 'refuse' };
    }
    return { kind: 'sp-add', bytes: mn === 'add' ? k : -k };
  }
  if (
    /^(?:b|bl|blx|bx|pop|swi|svc|bkpt)$/.test(mn) ||
    /^b(?:eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)$/.test(mn)
  ) {
    return { kind: 'stop' };
  }
  if (PC.test(dest)) {
    return { kind: 'stop' };
  }
  if (mn === 'ldr' && ops.length === 2) {
    const off = spAddress(ops[1]);
    if (off !== undefined) {
      return { kind: 'load-sp', off };
    }
  }
  if (mn === 'str' && ops.length === 2) {
    const off = spAddress(ops[1]);
    if (off !== undefined) {
      return { kind: 'store-sp', off };
    }
  }
  if (SP.test(dest) && !/^(?:cmp|cmn|tst)$/.test(mn)) {
    return { kind: 'refuse' };
  }
  // a frame address copied out (`mov rD, sp`, `add rD, sp, #k`), sp read as data any other way, or
  // a frame access this does not read as a word
  if (ops.slice(1).some((o) => SP.test(o) || /^\[\s*(?:sp|r13)\b/i.test(o))) {
    return { kind: 'stop' };
  }
  return REGISTER_ONLY.test(mn) ? { kind: 'other' } : { kind: 'stop' };
}

/** The mnemonics, in both their UAL and pre-UAL spellings, that touch no frame word the pass
 *  tracks once a sp base has been ruled out: the data-processing forms, the loads and the stores
 *  (see the header). Any other one stops it. */
const REGISTER_ONLY =
  /^(?:(?:mov|mvn|add|adc|sub|sbc|neg|rsb|mul|and|orr|eor|bic|lsl|lsr|asr|ror)s?|cmp|cmn|tst|nop|ldr|ldrh|ldrb|ldrsh|ldrsb|ldsh|ldsb|str|strh|strb|ldm|ldmia|stm|stmia)$/;

const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The incoming stack words the entry of `callee` loads, read out of GNU-as `text` holding its
 *  `callee:` label: the lines after it, to the first stop (see the header). Undefined where the
 *  text holds no such label or the entry loads none. */
export function thumbEntryWordsFromText(callee: string, text: string): number | undefined {
  const lines = text.split('\n');
  const head = new RegExp(`^\\s*${escaped(callee)}\\s*:(.*)$`);
  const at = lines.findIndex((l) => head.test(l.replace(/@.*$/, '')));
  if (at < 0) {
    return undefined;
  }
  const rest = head.exec(lines[at].replace(/@.*$/, ''))![1].trim();
  function* steps(): Generator<Step> {
    for (const raw of [rest, ...lines.slice(at + 1)]) {
      const line = raw.replace(/@.*$/, '').trim();
      if (line === '') {
        continue;
      }
      if (/^[\w.$]+\s*:/.test(line)) {
        yield { kind: 'stop' };
        return;
      }
      yield textStep(line);
    }
    yield { kind: 'stop' };
  }
  return incomingWords(steps());
}

/** One Thumb halfword of the prologue subset, read as a step: every format but the branches, the
 *  calls, `pop` and the software interrupt, which stop the pass, as do `bl`'s two halves and any
 *  encoding this does not name. */
function halfwordStep(h: number): Step {
  // format 14: push {rlist[, lr]} / pop
  if ((h & 0xfe00) === 0xb400) {
    let n = (h >> 8) & 1;
    for (let r = 0; r < 8; r++) {
      n += (h >> r) & 1;
    }
    return { kind: 'push', words: n };
  }
  // format 13: add sp, #±imm7*4
  if ((h & 0xff00) === 0xb000) {
    const bytes = (h & 0x7f) * 4;
    return { kind: 'sp-add', bytes: (h & 0x80) !== 0 ? -bytes : bytes };
  }
  // format 11: ldr / str rD, [sp, #imm8*4]
  if ((h & 0xf000) === 0x9000) {
    const off = (h & 0xff) * 4;
    return (h & 0x0800) !== 0 ? { kind: 'load-sp', off } : { kind: 'store-sp', off };
  }
  // format 12: add rD, sp, #imm (a frame address copied out) / add rD, pc, #imm
  if ((h & 0xf000) === 0xa000) {
    return (h & 0x0800) !== 0 ? { kind: 'stop' } : { kind: 'other' };
  }
  // formats 1-4: shifts, add/sub, the 8-bit immediates, the ALU: low registers only
  if (h < 0x4400) {
    return { kind: 'other' };
  }
  // format 5: the high-register add/cmp/mov, and bx
  if ((h & 0xfc00) === 0x4400) {
    const op = (h >> 8) & 3;
    const rs = ((h >> 3) & 7) + ((h >> 6) & 1) * 8;
    const rd = (h & 7) + ((h >> 7) & 1) * 8;
    if (op === 3 || ((op === 0 || op === 2) && rd === 15)) {
      return { kind: 'stop' };
    }
    if ((op === 0 || op === 2) && rd === 13) {
      return { kind: 'refuse' };
    }
    return rs === 13 ? { kind: 'stop' } : { kind: 'other' };
  }
  // format 6: ldr rD, [pc, #imm]
  if ((h & 0xf800) === 0x4800) {
    return { kind: 'other' };
  }
  // formats 7-10: transfers through a low register, which holds no frame address (see the header);
  // format 15: ldmia / stmia through one
  if ((h & 0xf000) === 0x5000 || (h & 0xe000) === 0x6000 || (h & 0xf000) === 0x8000 || (h & 0xf000) === 0xc000) {
    return { kind: 'other' };
  }
  return { kind: 'stop' };
}

/** The incoming stack words the entry whose halfwords, from the entry on, are `halfwords` loads
 *  (see the header). Undefined where it loads none. */
export function thumbEntryWordsFromHalfwords(halfwords: readonly number[]): number | undefined {
  function* steps(): Generator<Step> {
    for (const h of halfwords) {
      yield halfwordStep(h & 0xffff);
    }
    yield { kind: 'stop' };
  }
  return incomingWords(steps());
}
