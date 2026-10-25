// asmlift — what a straight-line ARM (A32) body reads of its argument registers, and the Thumb
// interworking veneer that reaches one.
//
// A GBA callee written in ARM is reached from Thumb through a veneer (`bx pc; nop` then ARM `b sym`),
// and the Thumb frontend lifts no ARM, so the callee-body bound (frontend/callee-body.ts) has nothing
// to lift. Where the body is straight-line, though, what it reads needs no lift: one pass over its
// instruction words, in order, says which argument register it reads before writing it.
//
// THE SCAN ANSWERS ONLY WHERE EVERY PATH IS THE ONE IT READ. It reads instruction words from the
// entry to the first `bx lr`, and answers nothing (undefined) on:
//   - any instruction whose condition is not AL: a conditional one makes the body two paths;
//   - any branch, call or other write of pc but that final `bx lr` (`b`, `bl`, `bx` of another
//     register, `mov pc, …`, `ldr pc, …`, `ldm`/`stm`): the body is no longer the words that follow;
//   - any write of lr, which makes the final `bx lr` go somewhere else;
//   - any use of sp: a stack argument read is a fifth word, and a frame is no straight-line scratch;
//   - any instruction it does not model (coprocessor, swi, status register moves, swap, long
//     multiply, the halfword forms ARMv4T leaves undefined), and running out of words before `bx lr`.
// What it answers is the number of argument words read: one past the highest of r0-r3 that some
// instruction reads before any instruction writes it. That is an UPPER bound on what the body
// reads of its arguments, as the callee-body bound is.

/** The argument words a straight-line ARM body reads at most, or undefined (see the header). `words`
 *  are its instruction words from the entry, in order. */
export function armArgumentWords(words: readonly number[]): number | undefined {
  const written = new Set<number>();
  let reads = 0;
  for (const w of words) {
    if (w >>> 28 !== 0xe) {
      return undefined;
    }
    if (w >>> 0 === 0xe12fff1e) {
      return reads; // bx lr
    }
    const effect = decode(w >>> 0);
    if (effect === undefined) {
      return undefined;
    }
    const regs = [...effect.reads, ...effect.writes];
    if (regs.includes(SP) || effect.writes.includes(LR) || effect.writes.includes(PC)) {
      return undefined;
    }
    for (const r of effect.reads) {
      if (r < 4 && !written.has(r)) {
        reads = Math.max(reads, r + 1);
      }
    }
    effect.writes.forEach((r) => written.add(r));
  }
  return undefined;
}

const SP = 13;
const LR = 14;
const PC = 15;

interface Effect {
  reads: number[];
  writes: number[];
}

const reg = (w: number, at: number): number => (w >>> at) & 0xf;

/** The registers one unconditional ARMv4T instruction reads and writes, or undefined for one this
 *  scan does not model. */
function decode(w: number): Effect | undefined {
  // MUL / MLA: 0000 00AS dddd nnnn ssss 1001 mmmm
  if ((w & 0x0fc000f0) === 0x00000090) {
    const accumulate = (w >>> 21) & 1;
    const reads = [reg(w, 0), reg(w, 8), ...(accumulate ? [reg(w, 12)] : [])];
    return { reads, writes: [reg(w, 16)] };
  }
  // LDRH / STRH / LDRSB / LDRSH: 000P UIWL nnnn dddd oooo 1SH1 mmmm, SH ≠ 00
  if ((w & 0x0e000090) === 0x00000090) {
    const sh = (w >>> 5) & 3;
    const load = (w >>> 20) & 1;
    if (sh === 0 || (!load && sh !== 1)) {
      return undefined; // swap, or a store form ARMv4T leaves undefined
    }
    const immediate = (w >>> 22) & 1;
    return transfer(w, load === 1, immediate === 1 ? [] : [reg(w, 0)]);
  }
  // data processing: 00I oooo S nnnn dddd operand2
  if ((w & 0x0c000000) === 0) {
    const op = (w >>> 21) & 0xf;
    const setsFlags = (w >>> 20) & 1;
    const compare = op >= 8 && op <= 11;
    if (compare && !setsFlags) {
      return undefined; // MRS, MSR, BX and the rest of that space
    }
    const reads: number[] = [];
    if (op !== 13 && op !== 15) {
      reads.push(reg(w, 16)); // every op but MOV and MVN reads Rn
    }
    if (((w >>> 25) & 1) === 0) {
      reads.push(reg(w, 0));
      if ((w >>> 4) & 1) {
        reads.push(reg(w, 8)); // shift by a register
      }
    }
    return { reads, writes: compare ? [] : [reg(w, 12)] };
  }
  // LDR / STR / LDRB / STRB: 01I PUBW L nnnn dddd offset
  if ((w & 0x0c000000) === 0x04000000) {
    const registerOffset = (w >>> 25) & 1;
    if (registerOffset && (w >>> 4) & 1) {
      return undefined; // the undefined-instruction space
    }
    return transfer(w, ((w >>> 20) & 1) === 1, registerOffset ? [reg(w, 0)] : []);
  }
  return undefined;
}

/** A single load or store: it reads its base and `offset`, a store its source too; a load writes
 *  its destination, and a post-indexed or write-back form its base. */
function transfer(w: number, load: boolean, offset: number[]): Effect | undefined {
  const base = reg(w, 16);
  const data = reg(w, 12);
  const writeBack = ((w >>> 24) & 1) === 0 || ((w >>> 21) & 1) === 1;
  if (data === PC || (writeBack && base === PC)) {
    return undefined;
  }
  return {
    reads: [base, ...offset, ...(load ? [] : [data])],
    writes: [...(load ? [data] : []), ...(writeBack ? [base] : [])],
  };
}

/** Where a Thumb interworking veneer at a word-aligned `entry` branches to: its two halfwords are
 *  `bx pc` (0x4778) and `nop` (`mov r8, r8`, 0x46c0), which enter ARM state at `entry + 4`, and the
 *  ARM word there is an unconditional `b`. Undefined for anything else: the veneer is then some
 *  other code, and nothing here reads it. */
export function thumbToArmVeneerTarget(entry: number, h0: number, h1: number, armWord: number): number | undefined {
  if (entry % 4 !== 0 || h0 !== 0x4778 || h1 !== 0x46c0 || (armWord & 0xff000000) >>> 0 !== 0xea000000) {
    return undefined;
  }
  const offset = ((armWord & 0x00ffffff) << 8) >> 6; // sign-extended, in bytes
  return (entry + 4 + 8 + offset) >>> 0;
}
