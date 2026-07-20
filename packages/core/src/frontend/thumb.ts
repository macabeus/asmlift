// asmlift ISA frontend — ARMv4T / Thumb (agbcc). Decode GNU-as text → CFG of basic
// blocks → L1 with multi-block SSA via Braun et al. 2013 ("Simple and Efficient
// Construction of SSA Form"), emitting block-arguments at joins.
//
// `cmp`+`b<cond>` become `cond_br` over a real join. Loops: a back-edge target is read
// before its back-edge predecessor is filled, so Braun's incomplete-phi + sealBlock
// schedule handles it — a block's phis are wired only once all its predecessors are
// filled. Trivial phis (one real operand) are removed afterwards so a loop-invariant
// register does not leak a spurious block parameter.
//
// Callee-saved stack frames: `push`/`pop` (and the `pop {rN}; bx rN` return idiom) are
// transparent to dataflow — the pushed registers are restored to the same values, and a
// callee-saved register is always written in the body before it is read — so no explicit
// modelling is needed; they simply fall through the decode/fill switch. Because agbcc may
// copy a callee-saved argument (e.g. into r4) before touching r0, entry parameters are
// ordered by ABI register (r0, r1, …), not by the order they were first read.
import { Fn, Successor, Value, mkOp, mkValue } from '../ir/core';
import type { Opcode } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Prototypes, protoArity } from '../proto';
import { RUNTIME_HELPERS } from '../raise/softdiv';
import type { TargetDescription } from '../target';
import { pushSwitchBr } from './emit';
import { FrontendUnsupportedError } from './errors';
import { assertInputFormat } from './format';
import type { Frontend } from './frontend';
import { opaqueDest } from './opaque';
import { abiSortEntryParams, fallbackArgc, makeSsaBuilder } from './ssa';

interface Instr {
  mnemonic: string;
  ops: string[];
}
interface AsmBlock {
  label: string;
  instrs: Instr[];
}

// Map a Thumb conditional-branch mnemonic to the icmp opcode for "branch taken". The signed forms
// (`blt`/`ble`/`bgt`/`bge`) follow a signed `cmp`; the UNSIGNED forms carry the carry/borrow sense:
// `bhi` = unsigned > (higher), `bls` = unsigned <= (lower-or-same), `bcc`/`blo` = unsigned <
// (carry-clear / lower), `bcs`/`bhs` = unsigned >= (carry-set / higher-or-same).
const COND_OPCODE: Record<string, Opcode> = {
  beq: 'icmp_eq',
  bne: 'icmp_ne',
  blt: 'icmp_slt',
  ble: 'icmp_sle',
  bgt: 'icmp_sgt',
  bge: 'icmp_sge',
  bhi: 'icmp_ugt',
  bls: 'icmp_ule',
  bcc: 'icmp_ult',
  blo: 'icmp_ult',
  bcs: 'icmp_uge',
  bhs: 'icmp_uge',
};

// Classify a block-terminating control transfer, or `null` for a non-transfer instruction (the block
// falls through). The SINGLE source of truth for "what ends a Thumb block and how", used by decode
// (block splitting), succLabels (CFG edges), the fill loop (skip transfers), and the terminator
// emitter — so a transfer form can't be modelled in one place and missed in another. A return via a
// restored link register is distinguished from a COMPUTED/loaded PC write (jump table / computed
// goto / register tail call), which this frontend does not model and must LOUD-FAIL rather than
// silently drop — mirroring the MIPS `jr` and PPC `bctr` guards. (agbcc dispatches a dense switch
// via `mov pc, rN`.)
type XferKind = 'return' | 'uncond' | 'cond' | 'indirect';
function classifyXfer(ins: Instr): XferKind | null {
  const mn = ins.mnemonic;
  if (mn === 'b') {
    return 'uncond';
  }
  if (COND_OPCODE[mn]) {
    return 'cond';
  }
  // `bx rN`: agbcc's return is `bx lr` or `pop {rN}; bx rN` (rN holds the restored LR) — a return.
  // (agbcc emits jump tables via `mov pc`, NOT `bx`; a computed tail-call `bx rN` is out of scope and
  // would need call modelling — accepted limitation, not a jump-table dispatch form.)
  if (mn === 'bx') {
    return 'return';
  }
  // A write to PC is a control transfer. `mov pc, lr` restores the link register → return; any other
  // computed/loaded PC write (`mov pc, rN` rN≠lr, `ldr pc, …`, `add/sub pc, …`) is an indirect jump.
  const dest = ins.ops[0]?.replace(/[[\]]/g, '');
  if (dest === 'pc') {
    if ((mn === 'mov' || mn === 'movs') && ins.ops[1] === 'lr') {
      return 'return';
    }
    return 'indirect';
  }
  // `pop {…, pc}` restores the saved LR into PC → return. `ldmia rN!, {…, pc}` is a return iff the base
  // is sp (a stack unwind); any other base is a computed multi-load jump → indirect. The register
  // list is EXPANDED first, so `pc` inside a fused range (`{r4-pc}`) is seen — an unexpanded
  // detection silently deleted the return.
  const popsPc =
    (mn === 'pop' || mn === 'ldmia' || mn === 'ldmfd') &&
    expandRegList(
      ins.ops
        .join(' ')
        .replace(/[{}!]/g, '')
        .split(/[,\s]+/)
        .filter(Boolean),
    ).includes('pc');
  if (popsPc) {
    if (mn === 'pop') {
      return 'return';
    }
    return ins.ops[0]?.replace(/!$/, '') === 'sp' ? 'return' : 'indirect';
  }
  return null;
}

const imm = (s: string) => parseInt(s.replace(/^#/, ''), s.includes('0x') ? 16 : 10);

// Expand fused register-range tokens (`r4-r7` → r4,r5,r6,r7) in a register list. Ranges are
// numeric-endpoint only (`rN-rM`); a range whose endpoint is an ALIAS (`r4-pc`/`-lr`/`-sp`) is
// ambiguous and left UNEXPANDED — but its endpoints ARE surfaced as separate tokens so pc/lr
// detection sees them, and any consumer that needs the exact list rejects the leftover `-` token
// loudly rather than treating the fused range as one phantom register.
const REG_NUM: Record<string, number> = { sp: 13, lr: 14, pc: 15 };
const regNum = (r: string) => (r[0] === 'r' ? Number(r.slice(1)) : REG_NUM[r]);
function expandRegList(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const dash = t.indexOf('-');
    if (dash === -1) {
      out.push(t);
      continue;
    }
    const lo = t.slice(0, dash);
    const hi = t.slice(dash + 1);
    const a = regNum(lo);
    const b = regNum(hi);
    if (/^r\d+$/.test(lo) && /^r\d+$/.test(hi) && Number.isFinite(a) && Number.isFinite(b) && a <= b) {
      for (let i = a; i <= b; i++) {
        out.push(`r${i}`);
      }
    } else {
      // alias-endpoint or malformed range: surface both endpoints (so pc/lr is visible) AND keep
      // the raw token (so a list consumer sees the unexpanded `-` and declines).
      out.push(lo, hi, t);
    }
  }
  return out;
}

// Split an operand list on commas that are NOT inside brackets, so a memory operand like
// `[r0, #0x8]` (base + offset) stays a single token instead of being torn at its comma.
function splitOperands(s: string): string[] {
  const out: string[] = [];
  let depth = 0,
    cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out;
}

// Parse a Thumb memory addressing operand `[base]` or `[base, #off]` into base register +
// constant byte offset. (Register-scaled indices like `[base, r1, lsl #2]` are not handled
// yet — agbcc materialises those as explicit add/lsl before the load in the cases we target.)
function parseAddr(operand: string): { base: string; off: number } {
  const inner = operand.replace(/[[\]]/g, '').trim();
  const parts = inner.split(',').map((s) => s.trim());
  const base = parts[0];
  const off = parts[1]?.startsWith('#') ? imm(parts[1]) : 0;
  return { base, off };
}

/** Parse one function's GNU-as text into labelled basic blocks + the CFG, plus the inline `.word`
 *  data tables (label → the list of label operands under it) — the jump-table target arrays agbcc
 *  emits in `.text` (Regime B). Non-`.word` directives are skipped, EXCEPT sub-word data
 *  directives, which fail loud: disassembler-extracted asm (pret projects' `.s` splits) spells
 *  raw undecoded instructions as `.2byte 0xD101` — skipping one would silently delete a branch.
 *
 *  Two input dialects share this parser: agbcc compiler output (`.thumb_func` + `.L` labels) and
 *  pret-project splits (luvdis-extracted: `thumb_func_start NAME` macros, `_08xxxxxx` labels,
 *  `LABEL: .4byte VALUE` literal pools on one line). The pret function macros are bookkeeping
 *  (they expand to `.align`/`.global`/`.thumb_func`/`.type`) except for the mode they declare:
 *  `arm_func_start` marks an ARM-mode body this Thumb frontend must refuse to lift. */
interface FlatItem {
  label?: string;
  instr?: Instr;
  /** a data directive's payload, kept in-stream so byte layout is computable */
  data?: { halfwords: boolean; values: string[]; inCode: boolean };
}

function decode(name: string, asm: string): { blocks: AsmBlock[]; dataWords: Map<string, string[]> } {
  // Flatten to (label | instr | data) items, then split into blocks at labels / after branches.
  // `.word LABEL` directives are captured into dataWords keyed by the most recent label (the
  // jump table); ALL word/halfword data also stays in-stream as items, so the raw-halfword and
  // pc-relative resolution below can compute byte-accurate layout.
  let flat: FlatItem[] = [];
  const dataWords = new Map<string, string[]>();
  const funcLabels: string[] = []; // labels marked as function starts (.thumb_func / pret macros)
  const armLabels = new Set<string>(); // function starts declared ARM-mode (arm_func_start)
  const subwordData = new Map<string, string>(); // label → sub-word data directive under it
  // Directives whose byte size we cannot know, recorded by allFlat POSITION so the layout check
  // is scoped to the SELECTED function's slice — a `.align` between two functions must not
  // poison a sibling that needs byte-accurate layout.
  const hazards: { at: number; what: string }[] = [];
  let dataLabel: string | null = null;
  let pendingFn = false;
  let pendingArm = false;
  for (const rawLine of asm.split('\n')) {
    let rest = rawLine.split('@')[0].trim();
    if (!rest) {
      continue;
    }
    // A label may share the line with what follows it (pret pools: `_08x: .4byte 0x…`) — peel it.
    const lm = rest.match(/^([A-Za-z_.$][\w.$]*):\s*(.*)$/);
    if (lm) {
      const lab = lm[1];
      if (pendingFn || pendingArm) {
        funcLabels.push(lab);
        if (pendingArm) {
          armLabels.add(lab);
        }
        pendingFn = pendingArm = false;
      }
      dataLabel = lab;
      flat.push({ label: lab });
      rest = lm[2];
      if (!rest) {
        continue;
      }
    }
    if (rest.startsWith('.')) {
      if (rest === '.thumb_func') {
        pendingFn = true;
      }
      const wm = rest.match(/^\.(word|4byte|long)\s+(.+)$/);
      if (wm) {
        const values = wm[2].split(',').map((w) => w.trim()); // one-per-line and comma lists
        if (dataLabel) {
          const arr = dataWords.get(dataLabel) ?? dataWords.set(dataLabel, []).get(dataLabel)!;
          arr.push(...values);
        }
        flat.push({ data: { halfwords: false, values, inCode: dataLabel === null } });
        continue;
      }
      const hw = rest.match(/^\.(2byte|hword|short)\s+(.+)$/);
      if (hw) {
        // In the instruction stream these are raw undecoded instructions (luvdis emits branches
        // this way) — kept as items and DECODED (or declined) below. Under a label: a sub-word
        // data table — declines below iff the selected function references it.
        if (dataLabel !== null) {
          subwordData.set(dataLabel, hw[1]);
        }
        flat.push({
          data: { halfwords: true, values: hw[2].split(',').map((w) => w.trim()), inCode: dataLabel === null },
        });
        continue;
      }
      const raw = rest.match(
        /^\.(byte|ascii|asciz|string|space|skip|quad|8byte|octa|double|float|single|incbin|fill|zero)\b/,
      );
      if (raw) {
        if (dataLabel === null) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': raw data directive '.${raw[1]}' in the code stream — ` +
              `it may encode an instruction the disassembler left undecoded (skipping it would silently delete its effect)`,
          );
        }
        subwordData.set(dataLabel, raw[1]);
        hazards.push({ at: flat.length - 1, what: `.${raw[1]}` }); // byte size unknown / non-word
        continue;
      }
      if (/^\.align\b/.test(rest)) {
        hazards.push({ at: flat.length - 1, what: '.align' });
      }
      continue; // other directives skipped
    }
    // pret function macros (asm/macros.inc): pure bookkeeping except the declared mode.
    const macro = rest.match(/^(non_word_aligned_thumb_func_start|thumb_func_start|arm_func_start)\s+\S+$/);
    if (macro) {
      pendingFn = macro[1] !== 'arm_func_start';
      pendingArm = macro[1] === 'arm_func_start';
      continue;
    }
    if (/^(thumb_func_end|arm_func_end)\b/.test(rest)) {
      continue;
    }
    const m = rest.match(/^(\w+)\s*(.*)$/);
    if (!m) {
      continue;
    }
    dataLabel = null; // a real instruction ends a data run
    flat.push({ instr: { mnemonic: m[1], ops: m[2] ? splitOperands(m[2]) : [] } });
  }
  if (
    armLabels.has(name) ||
    (funcLabels.length === 1 && armLabels.has(funcLabels[0]) && !flat.some((f) => f.label === name))
  ) {
    throw new FrontendUnsupportedError(
      `cannot lift '${name}': ARM-mode function (arm_func_start) — this frontend lifts Thumb only`,
    );
  }

  // FUNCTION SELECTION. `.thumb_func`-marked labels are function starts; when any exist, the
  // requested `name` must resolve to exactly one of them and the text is sliced to it — emitting
  // some OTHER symbol's body under `name` is precisely the silent miscompile the cardinal rule
  // forbids. A fragment with no `.thumb_func` markers is lifted whole, as a single body.
  //
  // A slice may END without a terminator because the function genuinely FALLS THROUGH into the
  // next `.thumb_func` entry (a shared tail — splitters mark the tail as its own function). The
  // build below then retries with the slice extended through that next function: the machine
  // code executed IS the continuation, so including it is the faithful lift. Falling into an
  // ARM-mode function declines.
  const allFlat = flat;
  let sliceStart = 0;
  let boundaries: number[] = [allFlat.length];
  if (funcLabels.length > 0) {
    const fi = funcLabels.indexOf(name);
    if (fi !== -1) {
      sliceStart = allFlat.findIndex((f) => f.label === name);
      const starts = funcLabels
        .map((l) => allFlat.findIndex((f) => f.label === l))
        .filter((s) => s > sliceStart)
        .sort((a, b) => a - b);
      boundaries = [...starts, allFlat.length];
    } else if (funcLabels.length >= 2) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': not a function label in this asm (functions present: ${funcLabels.join(', ')})`,
      );
    } else if (allFlat.some((f) => f.label === name)) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': '${name}' is a label here but not a function (the function is '${funcLabels[0]}')`,
      );
    } else {
      // `name` absent entirely + exactly one function: an intentional rename of that function —
      // slice from its start so preceding data labels never masquerade as its code.
      sliceStart = allFlat.findIndex((f) => f.label === funcLabels[0]);
      boundaries = [allFlat.length];
    }
  }
  let boundaryIdx = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    flat = allFlat.slice(sliceStart, boundaries[boundaryIdx]);

    // Sub-word data tables are unmodelled: lifting a load through one fabricates values (the old
    // silent-skip emitted wrong-but-compiling code). Decline iff the SELECTED code reaches such a
    // table — via a direct label operand, or via a literal-pool word naming the table's symbol.
    if (subwordData.size > 0) {
      const reachable = new Set<string>();
      const labelShape = /^([A-Za-z_.$][\w.$]*)/;
      for (const f of flat) {
        if (f.label && dataWords.has(f.label)) {
          for (const w of dataWords.get(f.label)!) {
            const wm = w.match(labelShape);
            if (wm) {
              reachable.add(wm[1]);
            }
          }
        }
        for (const op of f.instr?.ops ?? []) {
          const om = op.match(labelShape);
          if (om) {
            reachable.add(om[1]);
          }
        }
      }
      for (const [lab, directive] of subwordData) {
        if (reachable.has(lab)) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': reads the sub-word data table '${lab}' (.${directive}) — sub-word table data is not modelled`,
          );
        }
      }
    }

    // ── luvdis raw-encoding mode ─────────────────────────────────────────────────────────────
    // Disassembler-extracted splits carry two things only byte-accurate LAYOUT can resolve:
    // raw branch halfwords (`.2byte 0xD10E` — the target exists only as an encoded offset) and
    // pc-relative literal loads (`ldr rD, [pc, #off]` into an unlabelled pool). Both are decoded
    // here against computed byte offsets and rewritten into the labelled forms the rest of the
    // frontend already models; anything the decoder cannot prove declines loud.
    const isPcRelLdr = (ins?: Instr) =>
      ins?.mnemonic === 'ldr' && /^\[pc,\s*#(0x[0-9a-fA-F]+|\d+)\]$/.test(ins.ops[1] ?? '');
    const needsLayout = flat.some((f) => (f.data?.inCode ?? false) || isPcRelLdr(f.instr));
    if (needsLayout) {
      // Only a hazard WITHIN this function's slice makes its layout unknowable.
      const sliceHazard = hazards.find((h) => h.at >= sliceStart && h.at < boundaries[boundaryIdx]);
      if (sliceHazard) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': raw-encoded input needs byte-accurate layout, but '${sliceHazard.what}' makes item sizes unknowable`,
        );
      }
      // Byte offset of every item (Thumb-1: 2 bytes per instruction, `bl` is the 4-byte pair).
      const itemOff: number[] = [];
      const labelOff = new Map<string, number>();
      const codeStart = new Set<number>(); // offsets that begin an instruction or carry a label
      let off = 0;
      flat.forEach((f, i) => {
        itemOff[i] = off;
        if (f.label && !labelOff.has(f.label)) {
          labelOff.set(f.label, off);
          codeStart.add(off);
        }
        if (f.instr) {
          codeStart.add(off);
          off += f.instr.mnemonic === 'bl' ? 4 : 2;
        }
        if (f.data) {
          off += f.data.values.length * (f.data.halfwords ? 2 : 4);
        }
      });
      const labelAt = new Map<number, string>();
      for (const [lab, lo] of labelOff) {
        if (!labelAt.has(lo)) {
          labelAt.set(lo, lab);
        }
      }
      // Thumb-1 branch encodings this frontend models (cond codes 4–7 = mi/pl/vs/vc have no
      // lifted comparison semantics here; 14 is undefined, 15 is swi — all decline).
      const COND_MN = ['beq', 'bne', 'bcs', 'bcc', '', '', '', '', 'bhi', 'bls', 'bge', 'blt', 'bgt', 'ble'];
      const decodeHalfword = (v: number, at: number): { mnemonic: string; target: number } | null => {
        if (v >= 0xd000 && v <= 0xddff) {
          const mn = COND_MN[(v >> 8) & 0xf];
          if (!mn) {
            return null;
          }
          const d = (v & 0xff) - (v & 0x80 ? 0x100 : 0);
          return { mnemonic: mn, target: at + 4 + d * 2 };
        }
        if (v >= 0xe000 && v <= 0xe7ff) {
          const d = (v & 0x7ff) - (v & 0x400 ? 0x800 : 0);
          return { mnemonic: 'b', target: at + 4 + d * 2 };
        }
        return null;
      };
      // Pass 1: decode every in-code halfword; collect synthesized labels for branch targets.
      const synthLabels = new Map<number, string>(); // target offset → label to ensure there
      const decoded = new Map<number, Instr>(); // flat index → replacement branch instr
      flat.forEach((f, i) => {
        if (!f.data?.inCode) {
          return;
        }
        if (!f.data.halfwords) {
          return; // unlabelled word pool — layout bytes only (reached via [pc, #off] below)
        }
        f.data.values.forEach((raw, k) => {
          const at = itemOff[i] + k * 2;
          const v = parseInt(raw, 16);
          const br = Number.isFinite(v) ? decodeHalfword(v, at) : null;
          if (!br) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': raw halfword '${raw}' in the code stream is not a decodable branch — ` +
                `skipping it would silently delete its effect`,
            );
          }
          if (!codeStart.has(br.target)) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': raw branch '${raw}' targets byte offset 0x${br.target.toString(16)}, which is not an instruction boundary`,
            );
          }
          if (f.data!.values.length > 1) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': multi-value raw halfword directive mixing branches is not supported`,
            );
          }
          const lab = labelAt.get(br.target) ?? synthLabels.get(br.target) ?? `.Lraw_${br.target.toString(16)}`;
          synthLabels.set(br.target, lab);
          decoded.set(i, { mnemonic: br.mnemonic, ops: [lab] });
        });
      });
      // Pass 2: pc-relative literal loads → rewrite to a synthesized pool label so the existing
      // resolvePoolConst/resolvePoolSymbol machinery applies. `(pc & ~3) + off` depends on the
      // function's absolute alignment (mod 4) — derived STRUCTURALLY: pool words are 4-aligned in
      // the ROM, so the file-relative offset of any `.4byte` word fixes the base parity (the
      // luvdis `@ address` comments are not trusted).
      let basePar: number | undefined;
      flat.forEach((g, j) => {
        if (g.data && !g.data.halfwords) {
          const p = (4 - (itemOff[j] % 4)) % 4;
          if (basePar === undefined) {
            basePar = p;
          } else if (basePar !== p) {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': literal pools at inconsistent alignments — cannot determine the function's base alignment`,
            );
          }
        }
      });
      flat.forEach((f, i) => {
        if (!isPcRelLdr(f.instr)) {
          return;
        }
        if (basePar === undefined) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': pc-relative literal load with no literal pool in the function to resolve into`,
          );
        }
        const imm = parseInt(
          f.instr!.ops[1].match(/#(0x[0-9a-fA-F]+|\d+)/)![1],
          f.instr!.ops[1].includes('0x') ? 16 : 10,
        );
        const wordOff = ((basePar + itemOff[i] + 4) & ~3) - basePar + imm;
        // locate the word: a 4-byte data item covering [wordOff, wordOff+4)
        let value: string | undefined;
        flat.forEach((g, j) => {
          if (!g.data || g.data.halfwords) {
            return;
          }
          const rel = wordOff - itemOff[j];
          if (rel >= 0 && rel < g.data.values.length * 4 && rel % 4 === 0) {
            value = g.data.values[rel / 4];
          }
        });
        if (value === undefined) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': pc-relative load at offset 0x${itemOff[i].toString(16)} resolves to byte offset ` +
              `0x${wordOff.toString(16)}, which is not a word in a literal pool`,
          );
        }
        const poolLab = `.Lpcpool_${wordOff.toString(16)}`;
        dataWords.set(poolLab, [value]);
        f.instr = { mnemonic: 'ldr', ops: [f.instr!.ops[0], poolLab] };
      });
      // Pass 3: rebuild flat — insert synthesized target labels, replace decoded halfwords.
      const next: FlatItem[] = [];
      flat.forEach((f, i) => {
        const lab = synthLabels.get(itemOff[i]);
        if (lab && f.label !== lab && !labelAt.has(itemOff[i])) {
          next.push({ label: lab });
        }
        const br = decoded.get(i);
        if (br) {
          next.push({ instr: br });
        } else {
          next.push(f);
        }
      });
      flat = next;
    }

    const blocks: AsmBlock[] = [];
    const fallsIntoData = new Set<string>(); // blocks whose straight-line next bytes are data
    let cur: AsmBlock | null = null;
    let anon = 0,
      first = true;
    for (const f of flat) {
      if (f.label) {
        cur = { label: f.label, instrs: [] };
        blocks.push(cur);
        first = false;
        continue;
      }
      if (f.data) {
        // Data in the stream: never part of a block. Find the nearest preceding block WITH
        // instructions (a bare `LABEL:` on the data — a labelled pool/table — pushes an empty
        // block that must NOT hide the real code block behind it; skipping that was the silent
        // deletion of a branch that fell into labelled data). If that block's straight-line path
        // continues (open, or a conditional branch), it falls into these bytes — record it;
        // reachable ⇒ decline below, unreachable ⇒ luvdis pool-alignment padding, pruned.
        let prev: AsmBlock | null = cur && cur.instrs.length > 0 ? cur : null;
        for (let j = blocks.length - 1; prev === null && j >= 0; j--) {
          if (blocks[j].instrs.length > 0) {
            prev = blocks[j];
          }
        }
        if (prev) {
          const k = classifyXfer(prev.instrs[prev.instrs.length - 1]);
          if (k === null || k === 'cond') {
            fallsIntoData.add(prev.label);
          }
        }
        cur = null;
        continue;
      }
      if (!cur) {
        cur = { label: first ? name : `.L_anon${anon++}`, instrs: [] };
        blocks.push(cur);
        first = false;
      }
      cur.instrs.push(f.instr!);
      // Any control transfer ends a block (see classifyXfer — the single source of truth: `b`, a
      // conditional branch, a `bx`/PC-write return, and a computed/loaded PC write).
      if (classifyXfer(f.instr!)) {
        cur = null;
      }
    }
    // Raw data INTERLEAVED with instructions under one label: the lifted block would silently
    // omit whatever the data encodes — decline instead.
    const mixed = blocks.find((b) => b.instrs.length > 0 && subwordData.has(b.label));
    if (mixed) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': block '${mixed.label}' interleaves raw data (.${subwordData.get(mixed.label)}) with instructions`,
      );
    }
    let live = blocks.filter((b) => b.instrs.length > 0);
    // Alignment-pad NOPs a splitter emits around returns and literal pools: `lsls r0, r0, #0`
    // is the 0x0000 halfword, `mov r8, r8` is 0x46C0, plus a literal `nop`. A block made ONLY
    // of these is pool/section padding when unreachable — pruned below. A REACHABLE pad block
    // is a real (degenerate) instruction and is kept.
    const isPadInstr = (i: Instr) =>
      i.mnemonic === 'nop' ||
      ((i.mnemonic === 'lsl' || i.mnemonic === 'lsls') &&
        i.ops[0] === 'r0' &&
        i.ops[1] === 'r0' &&
        /^#0x?0*$/.test(i.ops[2] ?? '')) ||
      ((i.mnemonic === 'mov' || i.mnemonic === 'movs') && i.ops[0] === 'r8' && i.ops[1] === 'r8');
    const padBlocks = new Set(live.filter((b) => b.instrs.every(isPadInstr)).map((b) => b.label));
    if (fallsIntoData.size > 0 || padBlocks.size > 0) {
      // Targeted reachability: a block that falls into data is either luvdis's unreachable
      // pool-alignment padding (pruned) or genuinely reachable (decline — its fall-through
      // successor would silently skip over the data bytes); an all-pad block after the final
      // return (before a labelled pool or EOF) is pruned when unreachable. Other unreachable
      // blocks are LEFT ALONE — this pass judges only those two sets, so genuine truncation
      // still declines "falls off the end".
      const idx = new Map(live.map((b, i) => [b.label, i] as const));
      const reach = new Set<number>([0]);
      const work = [0];
      while (work.length > 0) {
        const i = work.pop()!;
        const b = live[i];
        const last = b.instrs[b.instrs.length - 1];
        const kind = last ? classifyXfer(last) : null;
        const targets: string[] = [];
        if (kind === 'cond' || kind === 'uncond') {
          targets.push(last.ops[0]);
        }
        if (kind === null || kind === 'cond') {
          const fall = live[i + 1]?.label;
          if (fall !== undefined && !fallsIntoData.has(b.label)) {
            targets.push(fall);
          }
        }
        for (const t of targets) {
          const ti = idx.get(t);
          if (ti !== undefined && !reach.has(ti)) {
            reach.add(ti);
            work.push(ti);
          }
        }
      }
      for (const b of live) {
        if (fallsIntoData.has(b.label) && reach.has(idx.get(b.label)!)) {
          const last = b.instrs[b.instrs.length - 1];
          if (!last || classifyXfer(last) === null || classifyXfer(last) === 'cond') {
            throw new FrontendUnsupportedError(
              `cannot lift '${name}': reachable code in block '${b.label}' falls through into data bytes`,
            );
          }
        }
      }
      live = live.filter(
        (b) => (!fallsIntoData.has(b.label) && !padBlocks.has(b.label)) || reach.has(idx.get(b.label)!),
      );
    }
    // Fall-through into the NEXT function (shared tail): the slice's last block has no
    // terminator, and a further function region exists — retry with the slice extended.
    const lastLive = live[live.length - 1];
    const lastInstr = lastLive?.instrs[lastLive.instrs.length - 1];
    if (lastInstr && classifyXfer(lastInstr) === null && boundaryIdx + 1 < boundaries.length) {
      const nextLab = allFlat[boundaries[boundaryIdx]]?.label;
      if (nextLab !== undefined && armLabels.has(nextLab)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': control falls through into the ARM-mode function '${nextLab}'`,
        );
      }
      boundaryIdx++;
      continue;
    }
    return { blocks: live, dataWords };
  }
}

// Resolve an agbcc/Thumb literal-pool reference (`ldr rD, .Lpool` / `.Lpool+byteOff`) to the NUMERIC
// 32-bit word it loads — the `ldr rD, =const` idiom. Returns null when the operand is NOT a numeric
// pool constant: a register/`[base]` memory operand, an unknown label, a misaligned offset, or a
// word that is a SYMBOL (an address / jump-table pointer — left for recoverJumpTable or the normal
// load path). The byte offset selects the word (index = off/4). This keeps a real literal constant
// (`.word 0x8408`) from being lifted as a phantom pointer parameter and dereferenced (`*a2`).
// The label-operand shape shared by BOTH pool paths: agbcc `.Lpool`, pret `_08012358`, with an
// optional `+N` byte offset. Kept in one place so the const and symbol resolvers cannot drift
// (they did — the drift fabricated phantom pointer params on symbol-pool loads).
const POOL_LABEL = /^([A-Za-z_.$][\w.$]*)(?:\s*\+\s*(0x[0-9a-fA-F]+|\d+))?$/;

type PoolRef = { kind: 'const'; value: number } | { kind: 'gaddr'; sym: string } | { kind: 'unmodelled'; why: string };

/** Classify a word-load operand `LABEL[+N]` against the captured literal pools. Returns null when
 *  the operand does NOT name a pool (a real register/memory base → the normal load path). When it
 *  DOES name a pool the outcome is const | gaddr | unmodelled — NEVER a fall-through to the load
 *  path, which would materialise the pool label as a phantom pointer parameter (a silent
 *  miscompile). `unmodelled` (a `sym+N` offset, a misaligned/out-of-range index, a `.L` code
 *  label) is the caller's cue to decline loud. */
function poolRef(operand: string, dataWords: Map<string, string[]>): PoolRef | null {
  const m = operand.match(POOL_LABEL);
  if (!m) {
    return null;
  }
  const words = dataWords.get(m[1]);
  if (!words) {
    return null; // not a pool — an ordinary register/memory operand
  }
  const byteOff = m[2] ? Number(m[2]) : 0;
  if (byteOff % 4 !== 0 || byteOff / 4 >= words.length) {
    return { kind: 'unmodelled', why: `offset ${byteOff} is not a whole word in pool '${m[1]}'` };
  }
  const w = words[byteOff / 4].trim();
  if (/^-?(0x[0-9a-fA-F]+|\d+)$/.test(w)) {
    const val = w.startsWith('-') ? -Number(w.slice(1)) : Number(w);
    return Number.isFinite(val) ? { kind: 'const', value: val } : { kind: 'unmodelled', why: `unparsable word '${w}'` };
  }
  // A bare C identifier that is NOT a `.L` code label → the address of a named global. A `sym+N`
  // offset, or a `.L` label (jump table / code address surviving to here), is unmodelled.
  if (/^[A-Za-z_]\w*$/.test(w) && !w.startsWith('.L')) {
    return { kind: 'gaddr', sym: w };
  }
  return { kind: 'unmodelled', why: `pool word '${w}' is a symbol offset or code label` };
}

// Recover an agbcc Thumb jump-table dispatch. Given a dispatch block `disp` ending in `mov pc, rV`
// and its unique bounds predecessor `bounds` ending in `cmp rX,#(N-1); bhi DEF`, verify the exact
// idiom and read the inline table — else return null (→ the indirect-jump loud-fail fires). The
// recovered switch REPLACES both blocks: `bounds` emits a `switch_br` (scrutinee rX; successors =
// case blocks + DEF).
//
//   bounds:  cmp rX,#(N-1); bhi DEF          disp: lsl rY,rX,#2 ; ldr rP,=PTR ; add rA,rY,rP
//                                                  ; ldr rV,[rA] ; mov pc,rV
//   PTR: .word TABLE     TABLE: .word C0 … C_{N-1}
//
// Index IDENTITY-OR-DECLINE guard: the value feeding the table load must be EXACTLY the
// bounds-checked scrutinee scaled only by `<<2` — any other op (xor/neg/extra offset) → decline.
interface JumpTable {
  scrutReg: string;
  caseLabels: string[];
  defaultLabel: string;
}
function recoverJumpTable(
  bounds: AsmBlock,
  disp: AsmBlock,
  dataWords: Map<string, string[]>,
  blockLabels: Set<string>,
): JumpTable | null {
  // bounds: last two instrs must be `cmp rX,#M` then `bhi DEF` (unsigned upper-bound guard).
  const bi = bounds.instrs;
  const bhi = bi[bi.length - 1],
    cmp = bi[bi.length - 2];
  if (!bhi || !cmp || bhi.mnemonic !== 'bhi' || cmp.mnemonic !== 'cmp') {
    return null;
  }
  const scrutReg = cmp.ops[0];
  const m = cmp.ops[1];
  if (!m?.startsWith('#')) {
    return null;
  }
  const n = imm(m) + 1; // cases 0..M  → N = M+1
  const defaultLabel = bhi.ops[0];

  // disp: exactly the 5-op idiom, threading a single index register from `lsl rY,rX,#2`.
  const d = disp.instrs;
  if (d.length !== 5) {
    return null;
  }
  const [lsl, ldrP, add, ldrV, movpc] = d;
  if (lsl.mnemonic !== 'lsl' || lsl.ops[1] !== scrutReg || (lsl.ops[2] !== '#0x2' && lsl.ops[2] !== '#2')) {
    return null;
  }
  const idxReg = lsl.ops[0]; // rY = rX << 2  (index*4, identity guard)
  if (ldrP.mnemonic !== 'ldr') {
    return null;
  }
  const ptrReg = ldrP.ops[0],
    ptrLabel = ldrP.ops[1]; // rP = *(PTR literal)
  if (add.mnemonic !== 'add' || add.ops[0] !== idxReg) {
    return null;
  }
  // add rY, rY, rP  (either operand order) — the address = table_base + index*4, nothing else.
  const addSrcs = [add.ops[1], add.ops[2]];
  if (!(addSrcs.includes(idxReg) && addSrcs.includes(ptrReg))) {
    return null;
  }
  if (ldrV.mnemonic !== 'ldr') {
    return null;
  }
  const { base } = parseAddr(ldrV.ops[1]); // rV = *(rY)
  if (base !== idxReg || ldrV.ops[0] !== movpc.ops[1]) {
    return null;
  }
  if (movpc.mnemonic !== 'mov' || movpc.ops[0] !== 'pc') {
    return null;
  }

  // Read the table: the ldr loads a POINTER word (PTR: .word TABLE); the table is TABLE: .word C0…
  const ptrWords = dataWords.get(ptrLabel);
  if (!ptrWords || ptrWords.length !== 1) {
    return null;
  }
  const caseLabels = dataWords.get(ptrWords[0]);
  if (!caseLabels || caseLabels.length !== n) {
    return null;
  } // table length must equal the bound
  // Every case target and the default must resolve to a real decoded block; a label that is an
  // expression (`.L4+4`) or points outside the function would otherwise crash later — decline cleanly.
  if (!blockLabels.has(defaultLabel) || caseLabels.some((l) => !blockLabels.has(l))) {
    return null;
  }
  return { scrutReg, caseLabels, defaultLabel };
}

/** Lift decoded asm → an L1 Fn with block-argument SSA. `prototypes` supplies each callee's
 *  declared parameter count (from the project's headers); it is authoritative for recovering
 *  how many argument registers a `bl` passes (falling back to a heuristic when absent). */
export function lift(name: string, asm: string, target: TargetDescription, prototypes: Prototypes = {}): Fn {
  assertInputFormat('thumb', 'gnu-as', asm);
  const { blocks: rawBlocks, dataWords } = decode(name, asm);

  // Regime B: recover agbcc jump tables. A dispatch block (`mov pc, rN`) plus its bounds
  // predecessor (`cmp; bhi DEF`) collapse into a `switch_br` emitted from the BOUNDS block; the
  // dispatch block is ELIDED from the CFG. A `mov pc` that is NOT a recognised table falls through
  // to the loud-fail below.
  const blockLabels = new Set(rawBlocks.map((b) => b.label));
  // Any label referenced as a branch target (so we can tell if an elided dispatch block has a SECOND
  // predecessor — a `b disp` from elsewhere — which would dangle after elision; decline if so).
  const branchTargets = new Set<string>();
  for (const b of rawBlocks) {
    for (const ins of b.instrs) {
      if ((ins.mnemonic === 'b' || COND_OPCODE[ins.mnemonic]) && ins.ops.length) {
        branchTargets.add(ins.ops[ins.ops.length - 1]);
      }
    }
  }
  const tables = new Map<AsmBlock, JumpTable>(); // bounds block → recovered table
  const elided = new Set<AsmBlock>(); // dispatch blocks removed from the CFG
  rawBlocks.forEach((d, i) => {
    const last = d.instrs[d.instrs.length - 1];
    if (last && last.mnemonic === 'mov' && last.ops[0] === 'pc' && last.ops[1] !== 'lr') {
      const bounds = rawBlocks[i - 1];
      // The dispatch block must be reached ONLY by falling through from its bounds predecessor — a
      // `b disp` target elsewhere would leave a dangling edge after elision, so decline (→ loud-fail).
      const jt = bounds && !branchTargets.has(d.label) ? recoverJumpTable(bounds, d, dataWords, blockLabels) : null;
      if (jt) {
        tables.set(bounds, jt);
        elided.add(d);
      }
    }
  });
  const asmBlocks = rawBlocks.filter((b) => !elided.has(b));

  // TRUSTWORTHINESS: loud-fail on a control transfer this frontend cannot model, rather than
  // silently dropping it. A computed/loaded PC write (`mov pc, rN`, `ldr pc, …`, `add/sub pc`,
  // `ldmia rN!,{…,pc}` with rN≠sp) is a jump table / computed goto / register tail call — decode
  // ends the block at it, but it has no static successor, so it must be a catchable "out of scope"
  // signal, not a vanished branch. Mirrors MIPS `jr`/PPC `bctr`. (A RECOGNISED jump table's
  // dispatch block is already elided above, so it is not scanned here.)
  for (const ab of asmBlocks) {
    for (const ins of ab.instrs) {
      if (classifyXfer(ins) === 'indirect') {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': indirect/computed jump '${ins.mnemonic} ${ins.ops.join(', ')}' ` +
            `— jump tables / computed gotos / register tail calls not supported`,
        );
      }
    }
  }

  // --- CFG (successors per block) as label lists; fallthrough + branch targets (via classifyXfer) ---
  const buildCfg = (blocks: AsmBlock[]) => {
    const labelIndex = new Map<string, number>();
    blocks.forEach((b, i) => labelIndex.set(b.label, i));
    const succLabels: string[][] = blocks.map((b, i) => {
      // A recovered jump-table BOUNDS block dispatches to its case blocks + default (the elided
      // dispatch block's targets); its `bhi`/fall-through successors are replaced entirely.
      const jt = tables.get(b);
      if (jt) {
        return [...jt.caseLabels, jt.defaultLabel];
      }
      const last = b.instrs[b.instrs.length - 1];
      const fall = i + 1 < blocks.length ? blocks[i + 1].label : null;
      const kind = last ? classifyXfer(last) : null;
      if (kind === 'return') {
        return [];
      } // bx lr / pop {…,pc} / mov pc,lr
      if (kind === 'uncond') {
        return [last!.ops[0]];
      } // unconditional
      if (kind === 'cond') {
        return [last!.ops[0], fall!];
      } // taken, fallthrough
      return fall ? [fall] : []; // fallthrough (or non-transfer last op / EMPTY synthetic block)
    });
    const preds: number[][] = blocks.map(() => []);
    // A branch to a label that is not a code block (a data label, or a target outside the sliced
    // function) cannot be modelled — fail loud, mirroring the MIPS/PPC non-block-boundary guards.
    succLabels.forEach((ss, i) =>
      ss.forEach((s) => {
        const ti = labelIndex.get(s);
        if (ti === undefined) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': branch target '${s}' is not a code block in this function (a data label, or outside the sliced function)`,
          );
        }
        preds[ti].push(i);
      }),
    );
    return { labelIndex, succLabels, preds };
  };

  // A function whose ENTRY block is itself a loop header (some block branches back to it — the tight
  // `strcpy`/`strlen`/`memset` shape where block 0 IS the loop) has no preheader to carry the
  // incoming argument registers into the header's phis. Braun SSA would then build each loop-carried
  // register's phi from the back-edge ALONE, dropping the entry value → a use-before-def on the
  // header's first op. Insert a synthetic EMPTY preheader that falls through to the old entry: it
  // becomes the true entry (its arg-register reads create the params), and the old header now has a
  // forward predecessor supplying the entry operand of each phi. Guarded on `preds[0]` so ordinary
  // functions (entry not a branch target) are untouched.
  let { labelIndex, preds } = buildCfg(asmBlocks);
  if (preds[0].length > 0) {
    let ph = '.Lasmlift_preheader';
    while (labelIndex.has(ph)) {
      ph += '_';
    }
    asmBlocks.unshift({ label: ph, instrs: [] });
    ({ labelIndex, preds } = buildCfg(asmBlocks));
  }

  // --- ISA-neutral SSA construction (shared Braun builder) ---
  const ssa = makeSsaBuilder(name, asmBlocks.length, preds);
  const { fn, irBlocks, readVar, writeVar, paramReg } = ssa;

  const constVal = (n: number, b: number): Value => {
    const v = mkValue(T.unk(32));
    irBlocks[b].ops.push(mkOp('const', { results: [v], attrs: { value: n } }));
    return v;
  };
  const reg = (s: string) => s.replace(/[[\]]/g, '');

  // Reading sp as a DATA operand means an address-taken local (`add rD, sp, #N` = `&local`),
  // an sp-relative spill slot (`ldr/str …, [sp, #N]`), or frame-pointer arithmetic — none
  // modellable without a stack abstraction. sp is never WRITTEN (sp-dest ops are transparent
  // frame bookkeeping), so Braun SSA would materialize it as a fabricated PHANTOM parameter that
  // scrambles the signature. Fail LOUD instead, mirroring MIPS (`isStackPtr`) and PPC (`r1`).
  const readData = (r: string, b: number): Value => {
    if (r === 'sp' || r === 'r13') {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': stack pointer used as data (address-taken local / sp-relative slot / frame arithmetic) — local stack frames not supported`,
      );
    }
    if (r === 'pc' || r === 'r15') {
      // A pc-relative literal load is rewritten to a pool label before reaching here (decode's
      // isPcRelLdr pass); a `pc`/`r15` base that survives to a data read is an unmodelled shape
      // (`ldr [pc]` with no `#imm`, computed-pc arithmetic) — decline, never fabricate a param.
      throw new FrontendUnsupportedError(`cannot lift '${name}': program counter used as a data base — not modelled`);
    }
    if (dataWords.has(r)) {
      // The operand is a literal-pool / data LABEL, not a register — reading it as dataflow would
      // fabricate a phantom parameter. Word-pool loads are resolved by poolRef upstream; anything
      // else reaching here (a sub-word load off a pool label, a label used in arithmetic) declines.
      throw new FrontendUnsupportedError(`cannot lift '${name}': data label '${r}' used as a register — not modelled`);
    }
    return readVar(r, b);
  };

  // Best-effort call arity via the shared helper (frontend/ssa.ts).
  const fallbackArgcHere = (b: number): number => fallbackArgc(ssa, target.argRegs, b);

  // --- fill each block in order, sealing blocks as their predecessors complete ---
  const fillBlock = (ab: AsmBlock, bi: number) => {
    const irb = irBlocks[bi];
    let pendingCmp: { lhs: Value; rhs: Value } | null = null;

    // TRUSTWORTHINESS GUARD (mirrors the MIPS/PPC frontends): an unmodelled instruction must not
    // silently drop its destination register — emit an honest `opaque`: dead ⇒ it vanishes; live ⇒
    // assertResolved fails LOUD (see frontend/opaque.ts for the policy). Push/pop and sp
    // adjustments have no low-register data destination, so they fall through harmlessly;
    // terminators are handled in the terminator section below.
    const isThumbReg = (s: string | undefined): s is string => /^r\d+$/.test(s ?? '');
    const emitOpaqueDest = (ins: { mnemonic: string; ops: string[] }) => {
      // storeClass: unmodelled Thumb stores are str*/stm* — `stmia rN!, {…}`'s dest token `r0!`
      // fails isReg, so without this it would be skipped as "no reg dest", silently deleting the
      // memory writes AND the base writeback. push/pop stay transparent frame ops (they don't match).
      // skipSafe: push/pop stay transparent frame ops (the deliberate policy);
      // everything else with no register destination (swi, …) throws in opaqueDest.
      const od = opaqueDest(ins.mnemonic, ins.ops, {
        isReg: isThumbReg,
        normalize: reg,
        storeClass: /^(str|stm)/,
        skipSafe: /^(push|pop|nop)$/,
        context: name,
      });
      if (!od) {
        return;
      }
      const operands = od.srcRegs.map((r) => readVar(r, bi));
      const res = mkValue(T.unk(32));
      // carry the mnemonic so annotate mode can name the gap (`ASMLIFT_ERROR("unmodelled 'rsb'")`)
      irb.ops.push(mkOp('opaque', { operands, results: [res], attrs: { mnemonic: ins.mnemonic } }));
      writeVar(od.dst, bi, res);
    };
    // 2-operand ALU form `op rD, op2` (rD = rD ⟨op⟩ op2). `op2` is an immediate (`#N`) or a
    // register. A destination that is NOT a low data register (`add sp, #8` / `sub sp, #N` frame
    // adjustments) is transparent to dataflow — the frame is push/pop-based — so it falls through
    // harmlessly, matching the documented sp handling. A malformed operand (missing / non-register
    // non-immediate) degrades to a loud opaque rather than a crash or a silent data-dest drop.
    const emit2op = (opc: Opcode, dReg: string, op2: string | undefined, bi: number) => {
      if (!isThumbReg(reg(dReg))) {
        return;
      } // sp/pc frame adjustment: transparent
      if (op2 === undefined) {
        emitOpaqueDest({ mnemonic: opc, ops: [dReg] });
        return;
      }
      const rhs = op2.startsWith('#') ? constVal(imm(op2), bi) : readData(reg(op2), bi);
      const res = mkValue(T.unk(32));
      irb.ops.push(mkOp(opc, { operands: [readData(reg(dReg), bi), rhs], results: [res] }));
      writeVar(reg(dReg), bi, res);
    };

    for (const ins of ab.instrs) {
      // Control transfers (branches, returns) are emitted in the terminator section below — skip them
      // here so a return-form PC write (`mov pc, lr`, `pop {…,pc}`) is not decoded as a data write to a
      // phantom `pc` register (a silent drop of the return). `cmp` is not a transfer, so it still runs.
      if (classifyXfer(ins)) {
        continue;
      }
      const [a, b, c] = ins.ops;
      switch (ins.mnemonic) {
        case 'mov':
        case 'movs': {
          const v = b?.startsWith('#') ? constVal(imm(b), bi) : readData(reg(b), bi);
          writeVar(reg(a), bi, v);
          break;
        }
        case 'add':
        case 'adds': {
          // `add rD, rS, #0` is agbcc's low-register copy idiom (Thumb `mov rD, rS` between
          // low regs isn't always available). Model it as a pure copy — same SSA value — not
          // an `x + 0` add. This keeps output clean and, crucially, makes a value copied to a
          // callee-saved register before a call read as still-live *after* the call, which is
          // how call-argument liveness tells a passed argument from a preserved one.
          if (c === '#0') {
            writeVar(reg(a), bi, readData(reg(b), bi));
            break;
          }
          // 2-operand form `add rD, op2` (rD = rD + op2): op2 in `b`, no third operand.
          // A malformed 1-operand `add` degrades to a loud opaque.
          if (c === undefined) {
            emit2op('add', a, b, bi);
            break;
          }
          const rhs = c?.startsWith('#') ? constVal(imm(c), bi) : readData(reg(c), bi);
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('add', { operands: [readData(reg(b), bi), rhs], results: [res] }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'sub':
        case 'subs': {
          if (c === undefined) {
            emit2op('sub', a, b, bi);
            break;
          } // `sub rD, op2` → rD = rD - op2
          const rhs = c?.startsWith('#') ? constVal(imm(c), bi) : readData(reg(c), bi);
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('sub', { operands: [readData(reg(b), bi), rhs], results: [res] }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'lsr':
        case 'lsl':
        case 'asr':
        case 'lsrs':
        case 'lsls':
        case 'asrs': {
          const shiftMn = ins.mnemonic.replace(/s$/, ''); // pret spells the flag-setting forms lsls/lsrs/asrs
          const opc = shiftMn === 'lsr' ? 'shr_u' : shiftMn === 'asr' ? 'shr_s' : 'shl';
          // A missing SECOND operand is malformed — degrade to a loud opaque like emit2op does.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const res = mkValue(T.unk(32));
          if (c === undefined) {
            // 2-operand register form `lsl rD, rS` → rD = rD << rS
            irb.ops.push(mkOp(opc, { operands: [readData(reg(a), bi), readData(reg(b), bi)], results: [res] }));
          } else if (c.startsWith('#')) {
            // immediate form `lsl rD, rS, #n`
            irb.ops.push(mkOp(opc, { operands: [readData(reg(b), bi)], results: [res], attrs: { imm: imm(c) } }));
          } else {
            // register form `lsl rD, rS, rN` → rD = rS << rN
            irb.ops.push(mkOp(opc, { operands: [readData(reg(b), bi), readData(reg(c), bi)], results: [res] }));
          }
          writeVar(reg(a), bi, res);
          break;
        }
        case 'neg':
        case 'negs': {
          // `neg rD, rS` (and `rsb rD, rS, #0`) = arithmetic negation → -x
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('neg', { operands: [readData(reg(b), bi)], results: [res] }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'rsb':
        case 'rsbs': {
          // Reverse subtract. `rsb rD, rS, #0` is the negate idiom (0 - rS) → -x. Any other form
          // (`rsb rD, rS, #N`, N≠0 — not a Thumb-1 encoding, but be safe) is NOT modelled: degrade
          // to a loud `opaque` rather than silently leaving rD unwritten (a silent miscompile).
          if (c === '#0') {
            const res = mkValue(T.unk(32));
            irb.ops.push(mkOp('neg', { operands: [readData(reg(b), bi)], results: [res] }));
            writeVar(reg(a), bi, res);
          } else {
            emitOpaqueDest(ins);
          }
          break;
        }
        case 'mvn':
        case 'mvns': {
          // `mvn rD, rS` = bitwise NOT → ~x
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('not', { operands: [readData(reg(b), bi)], results: [res] }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'bic':
        case 'bics': {
          // `bic rD, rM` (2-op) / `bic rD, rD, rM` (agbcc's redundant 3-op spelling) = rD & ~rM —
          // emitted verbatim by agbcc for the C idiom `x & ~y` (kleod's ReadKeyInput
          // key-transition mask), so the not+and pair recompiles to bic.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const [xr, mr] = c !== undefined ? [reg(b), reg(c)] : [reg(a), reg(b)];
          const inv = mkValue(T.unk(32));
          irb.ops.push(mkOp('not', { operands: [readData(mr, bi)], results: [inv] }));
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('and', { operands: [readData(xr, bi), inv], results: [res] }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'ror':
        case 'rors': {
          // `ror rD, rS` (2-op) / `ror rD, rD, rS` (redundant 3-op) = rotate right → the rotr
          // op; the structurer spells the C rotate idiom, which agbcc compiles back to this ror.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const [xr, nr] = c !== undefined ? [reg(b), reg(c)] : [reg(a), reg(b)];
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('rotr', { operands: [readData(xr, bi), readData(nr, bi)], results: [res] }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'ldmia':
        case 'stmia': {
          // Load/store-multiple with writeback: `ldmia rN!, {rA, rB…}` = one word access per
          // listed register at ascending offsets, then rN += 4×count. splitOperands is
          // brace-depth-aware, so the register list arrives as ONE token ('{rA, rB}'); the
          // rejoin below also tolerates a split list defensively. Thumb-1 LDMIA skips the
          // writeback when rN is itself in the list (the loaded value wins) — modelled; any
          // malformed shape degrades to the loud opaque.
          // `!` = writeback (`ldmia rN!, {…}`); its absence is the valid no-writeback form
          // (`ldmia rN, {…}` — same transfers, base unchanged). A missing register list is
          // malformed → loud opaque.
          const baseTok = a;
          const writeback = !!baseTok?.endsWith('!');
          if (baseTok === undefined || b === undefined || !b.startsWith('{')) {
            emitOpaqueDest(ins);
            break;
          }
          const baseReg = reg(writeback ? baseTok.slice(0, -1) : baseTok);
          const list = expandRegList(
            ins.ops
              .slice(1)
              .join(',')
              .replace(/[{}]/g, '')
              .split(',')
              .map((r) => r.trim())
              .filter(Boolean),
          );
          // An unexpandable range (alias endpoint, e.g. `r4-lr`) leaves a raw `-` token — the
          // exact transfer set is ambiguous, so degrade to the loud opaque rather than guess.
          if (list.some((r) => r.includes('-'))) {
            emitOpaqueDest(ins);
            break;
          }
          if (list.length === 0) {
            emitOpaqueDest(ins);
            break;
          }
          // SNAPSHOT the base ONCE: hardware performs every transfer from the ORIGINAL base, but
          // a base-in-list ldmia overwrites that register mid-list — re-reading it per iteration
          // loaded the siblings from the freshly-loaded value instead (silent wrong addresses,
          // adversarially reproduced). All accesses and the writeback read this snapshot.
          const base0 = readData(baseReg, bi);
          list.forEach((r, i) => {
            if (ins.mnemonic === 'ldmia') {
              const res = mkValue(T.unk(32));
              irb.ops.push(
                mkOp('load', { operands: [base0], results: [res], attrs: { off: 4 * i, signed: true, width: 4 } }),
              );
              writeVar(reg(r), bi, res);
            } else {
              irb.ops.push(mkOp('store', { operands: [base0, readData(reg(r), bi)], attrs: { off: 4 * i, width: 4 } }));
            }
          });
          // Writeback advances the base by 4×count — SUPPRESSED when there is no `!`, or (ldmia)
          // when the base is itself in the list (the loaded value wins, ARMv4T).
          const wroteBase = ins.mnemonic === 'ldmia' && list.some((r) => reg(r) === baseReg);
          if (writeback && !wroteBase) {
            const adv = mkValue(T.unk(32));
            irb.ops.push(mkOp('add', { operands: [base0, constVal(4 * list.length, bi)], results: [adv] }));
            writeVar(baseReg, bi, adv);
          }
          break;
        }
        case 'mul':
        case 'muls':
        case 'and':
        case 'ands':
        case 'orr':
        case 'orrs':
        case 'eor':
        case 'eors': {
          const opc = (
            {
              mul: 'mul',
              muls: 'mul',
              and: 'and',
              ands: 'and',
              orr: 'or',
              orrs: 'or',
              eor: 'xor',
              eors: 'xor',
            } as Record<string, Opcode>
          )[ins.mnemonic]!;
          // 3-operand (rD, rS, rM) or 2-operand (rD, rM) flag-setting form. A 1-operand form is
          // malformed — loud opaque, not a crash.
          if (b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const [x, y] =
            c !== undefined
              ? [readData(reg(b), bi), readData(reg(c), bi)]
              : [readData(reg(a), bi), readData(reg(b), bi)];
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp(opc, { operands: [x, y], results: [res] }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'cmp': {
          if (a === undefined || b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const rhs = b.startsWith('#') ? constVal(imm(b), bi) : readData(reg(b), bi);
          pendingCmp = { lhs: readData(reg(a), bi), rhs };
          break;
        }
        case 'ldr':
        case 'ldrb':
        case 'ldrh':
        case 'ldrsb':
        case 'ldrsh': {
          // A word load whose operand NAMES a literal pool is a pool reference, not a memory base:
          // a numeric word → `const`, a bare global → `gaddr` (structure.ts lowers a load/store
          // through it to `gSym`), anything else → loud decline. It must NEVER fall to the load
          // path below, which would materialise the pool label as a phantom pointer parameter.
          if (ins.mnemonic === 'ldr' && b !== undefined) {
            const pr = poolRef(b, dataWords);
            if (pr?.kind === 'const') {
              const res = mkValue(T.unk(32));
              irb.ops.push(mkOp('const', { results: [res], attrs: { value: pr.value } }));
              writeVar(reg(a), bi, res);
              break;
            }
            if (pr?.kind === 'gaddr') {
              const res = mkValue(T.unk(32));
              irb.ops.push(mkOp('gaddr', { results: [res], attrs: { sym: pr.sym } }));
              writeVar(reg(a), bi, res);
              break;
            }
            if (pr?.kind === 'unmodelled') {
              throw new FrontendUnsupportedError(
                `cannot lift '${name}': literal-pool load of ${pr.why} — not modelled`,
              );
            }
          }
          // rD, [base, #off] — a typed load. Width/signedness come from the mnemonic; the
          // base becomes a pointer to that element type during type recovery.
          if (a === undefined || b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const width = /b/.test(ins.mnemonic) ? 1 : /h/.test(ins.mnemonic) ? 2 : 4;
          const signed = ins.mnemonic === 'ldr' || /s/.test(ins.mnemonic.slice(3));
          const { base, off } = parseAddr(b);
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('load', { operands: [readData(base, bi)], results: [res], attrs: { off, width, signed } }));
          writeVar(reg(a), bi, res);
          break;
        }
        case 'str':
        case 'strb':
        case 'strh': {
          // rS, [base, #off] — a typed store (a side-effecting statement, no result).
          if (a === undefined || b === undefined) {
            emitOpaqueDest(ins);
            break;
          }
          const width = /b/.test(ins.mnemonic) ? 1 : /h/.test(ins.mnemonic) ? 2 : 4;
          const { base, off } = parseAddr(b);
          irb.ops.push(mkOp('store', { operands: [readData(base, bi), readData(reg(a), bi)], attrs: { off, width } }));
          break;
        }
        case 'bl':
        case 'blx': {
          // A call: read the argument registers (r0..), produce the return value in r0. The
          // callee's caller-saved clobber (r1..r3, lr) needs no modelling — agbcc has already
          // moved anything live across the call into a callee-saved register (a copy we alias).
          const targetSym = a;
          // Caller-supplied prototype wins; otherwise a known runtime helper (`__divsi3` &c.)
          // supplies its arity so its arguments are recovered; only then fall back to guessing.
          const argc =
            protoArity(prototypes[targetSym]) ?? protoArity(RUNTIME_HELPERS[targetSym]) ?? fallbackArgcHere(bi);
          const args: Value[] = [];
          for (let k = 0; k < argc; k++) {
            args.push(readVar(`r${k}`, bi));
          }
          const res = mkValue(T.unk(32));
          irb.ops.push(mkOp('call', { operands: args, results: [res], attrs: { target: targetSym } }));
          writeVar('r0', bi, res);
          break;
        }
        default:
          // Control transfers are already skipped above; any other unmodelled op fails loud (opaque)
          // instead of silently dropping its destination.
          emitOpaqueDest(ins);
          break;
      }
    }

    // terminator (via classifyXfer — the single source of truth shared with decode/succLabels)
    const last = ab.instrs[ab.instrs.length - 1];
    const kind = last ? classifyXfer(last) : null;
    const succ = (label: string): Successor => ({ block: irBlocks[labelIndex.get(label)!], args: [] });
    const jt = tables.get(ab);
    if (jt) {
      // Regime B: the bounds block dispatches a `switch_br` over the scrutinee — N case blocks (values
      // 0..N-1, dense) followed by the default block (last successor). The `cmp`/`bhi` are subsumed.
      pushSwitchBr(irb.ops, readVar(reg(jt.scrutReg), bi), [...jt.caseLabels.map(succ), succ(jt.defaultLabel)]);
    } else if (!last) {
      // an EMPTY block is only ever the synthetic entry preheader (decoded blocks are non-empty):
      // fall through to the real entry, whose loop-header phis take their entry operand from here.
      irb.ops.push(mkOp('br', { successors: [succ(fallLabel(bi))] }));
    } else if (kind === 'return') {
      // bx lr / pop {…,pc} / mov pc,lr
      irb.ops.push(mkOp('ret', { operands: [readVar(target.returnReg, bi)] }));
    } else if (kind === 'uncond') {
      irb.ops.push(mkOp('br', { successors: [succ(last.ops[0])] }));
    } else if (kind === 'cond') {
      // `pendingCmp` is block-local; a `cmp` split from its branch by a label means the flags
      // cross a block boundary — not modelled. Decline loud.
      if (!pendingCmp) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': conditional branch '${last.mnemonic}' has no reaching compare in its block`,
        );
      }
      const cond = mkValue(T.unk(32));
      irb.ops.push(mkOp(COND_OPCODE[last.mnemonic], { operands: [pendingCmp.lhs, pendingCmp.rhs], results: [cond] }));
      irb.ops.push(mkOp('cond_br', { operands: [cond], successors: [succ(last.ops[0]), succ(fallLabel(bi))] }));
    } else {
      // fallthrough (last instruction is a call / data op, no control transfer)
      irb.ops.push(mkOp('br', { successors: [succ(fallLabel(bi))] }));
    }
  };

  // The fall-through label after block `bi` — a LAST block needing one means control runs off
  // the end of the function (truncated/misparsed input): decline loud, never a TypeError.
  const fallLabel = (bi: number): string => {
    const nb = asmBlocks[bi + 1];
    if (!nb) {
      throw new FrontendUnsupportedError(
        `cannot lift '${name}': control falls off the end (block '${asmBlocks[bi].label}' has no terminator and no successor)`,
      );
    }
    return nb.label;
  };
  asmBlocks.forEach((ab, bi) => {
    fillBlock(ab, bi);
    ssa.markFilled(bi);
  });

  ssa.finish();

  // Order the entry block's parameters by ABI register (r0, r1, r2, …) so downstream
  // naming (`a0`, `a1`, …) matches the calling convention, not the read order. Safe only
  // for the true entry (no predecessors) — a loop header's params are phis whose position
  // is index-aligned with predecessor terminator args and must not be reordered.
  const entry = irBlocks[0];
  // non-ABI live-in ranks LAST (99) — deliberate Thumb tie-break; MIPS/PPC's is -1/first
  abiSortEntryParams(entry, preds[0].length > 0, (v) => {
    const m = /^r(\d+)$/.exec(paramReg.get(v) ?? '');
    return m ? +m[1] : 99;
  });
  return fn;
}

/** The ARMv4T / Thumb (agbcc) frontend, registered for the `armv4t` target. */
export const thumbFrontend: Frontend = { id: 'thumb', inputFormat: 'gnu-as', lift };
