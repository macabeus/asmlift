// A NARROW DECLARED LOCAL, extended once at every read.
//
// agbcc has no sub-word register, so an `s16`/`u8` LOCAL lives in a full register and every read of
// it re-extends. Where the local is a loop's counter that extension is not cosmetic, because it
// decides WHICH LOOP the compiler emits:
//
//   `gcc/thumb.h:344` PROMOTE_MODE forces `UNSIGNEDP = 1` on every sub-word mode, so a narrow
//   counter's write-back is an LSHIFTRT; `gcc/loop.c` `basic_induction_var` follows SIGN_EXTEND
//   (`:5876`) and ASHIFTRT (`:5880`) and lets LSHIFTRT fall through to `default: return 0`
//   (`:5902`) — the comment at `:5756-5762` says the ZERO_EXTEND exclusion is deliberate. With no
//   basic induction variable there is no strength reduction, so the narrow counter SURVIVES into
//   the emitted loop as a real index where a wide one becomes a pointer walk. Compiled both ways
//   with this benchmark's own agbcc, same declared `s32` local, same range, same body, only the
//   write-back's RTL shape differing:
//
//     i = ((i + 1) << 16) >> 16;   ASHIFTRT   add r1,r1,#0x2 / add r2,r2,#0x2   index ELIMINATED
//     i = (s32)(u16)(i + 1);       LSHIFTRT   lsl r0,r2,#0x1 / add r1,r0,r4     index SURVIVES
//
// So the width of a carrier is a fact about the emitted code. It is recovered here rather than
// enumerated as a spelling for the same reason `paramwidth` recovers its own: the extension STATES
// the width and the signedness, so there is nothing to guess and nothing for a differ to referee.
//
// WHY THE SOLE-READER RULE IS THE WHOLE SOUNDNESS ARGUMENT. Typing the carrier narrow makes the C
// TRUNCATE at every incoming edge — `s16 v` assigned a wide expression keeps its low 16 bits. That
// is unobservable exactly when every reader of the carrier already reads only those bits, i.e. when
// the carrier's one and only reader is an extension of that width: `ext(trunc_w(x), w) == ext(x, w)`
// for every `x`. A second reader of the raw carrier, or the carrier forwarded on a branch into
// another block's parameter, would observe the bits the declaration drops — both refuse.
//
// NO LOOP GATE, deliberately: the extension is what states the width, and it states it whether or
// not the block is a loop header. The loop is where the width is worth something, not where it
// becomes true.
//
// NOT agbcc-GATED, and not target-gated at all — a C declaration is not a target fact. Over the
// benchmark's 894 rows the only ones it moves are agbcc's, which is a measurement, not a rule.
import { type Fn, type Op, type Value, replaceAllUsesWith } from '../ir/core';
import { CAST_WIDTHS } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** What the gates below judge: one block parameter and the extension that reads it. */
export interface NarrowLocalCandidate {
  /** the block parameter the extension reads */
  param: Value;
  /** the extension's `width` attribute, or 0 when the sole reader is not an extension */
  width: number;
  /** the parameter belongs to the ENTRY block */
  isEntryParam: boolean;
  /** reads of the RAW parameter by ops anywhere in the function */
  uses: number;
  /** the sole reader is a `sext`/`zext` */
  readerIsExtension: boolean;
  /** occurrences of the RAW parameter as a branch argument */
  forwarded: number;
}

export const NARROW_LOCAL_GATES: readonly Gate<NarrowLocalCandidate>[] = [
  {
    id: 'entry-param',
    why: "a function's own arguments are the prologue pass's territory",
    sound: false,
    guardedBy: 'narrow-local.test.ts: an entry parameter is left to raise/paramwidth.ts',
    rejects: (c) => c.isEntryParam,
  },
  {
    id: 'param-typed',
    why: 'the pointer/aggregate recovery already decided this parameter',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a parameter the pointer recovery already typed is left alone',
    rejects: (c) => c.param.type.kind !== 'unknown',
  },
  {
    id: 'cast-width',
    why: 'only 8 and 16 are widths a `zext`/`sext` — and so a C declaration — carries',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a width no C type spells is refused',
    rejects: (c) => !CAST_WIDTHS.has(c.width),
  },
  {
    id: 'raw-reader',
    why: 'a reader of the un-extended carrier observes the bits the declaration would drop',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a second reader of the raw carrier refuses the narrowing',
    rejects: (c) => c.uses !== 1 || !c.readerIsExtension,
  },
  {
    id: 'forwarded',
    why: 'a carrier passed on to another block parameter is read there at its full width',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a carrier forwarded as a branch argument refuses the narrowing',
    rejects: (c) => c.forwarded > 0,
  },
];

/** Every op that reads `v` as an operand, and how many times `v` appears as a branch argument. */
function readersOf(fn: Fn, v: Value): { ops: Op[]; forwarded: number } {
  const ops: Op[] = [];
  let forwarded = 0;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const o of op.operands) {
        if (o === v) {
          ops.push(op);
        }
      }
      for (const s of op.successors) {
        forwarded += s.args.filter((a) => a === v).length;
      }
    }
  }
  return { ops, forwarded };
}

/** Type each block parameter at the width its sole reading extension proves, and drop that
 *  extension. Returns the number of carriers narrowed. */
export function narrowBlockLocals(fn: Fn, gates: readonly Gate<NarrowLocalCandidate>[] = NARROW_LOCAL_GATES): number {
  let narrowed = 0;
  for (const [i, b] of fn.blocks.entries()) {
    for (const p of b.params) {
      const { ops, forwarded } = readersOf(fn, p);
      const ext = ops[0];
      if (ext === undefined) {
        continue;
      }
      const isExt = ext.opcode === 'sext' || ext.opcode === 'zext';
      const c: NarrowLocalCandidate = {
        param: p,
        width: isExt ? (ext.attrs.width as number) : 0,
        isEntryParam: i === 0,
        uses: ops.length,
        readerIsExtension: isExt,
        forwarded,
      };
      if (firstRejection(gates, c) !== null) {
        continue;
      }
      p.type = T.int(c.width, ext.opcode === 'sext');
      replaceAllUsesWith(fn, ext.results[0], p);
      for (const blk of fn.blocks) {
        const at = blk.ops.indexOf(ext);
        if (at >= 0) {
          blk.ops.splice(at, 1);
        }
      }
      narrowed++;
    }
  }
  return narrowed;
}
