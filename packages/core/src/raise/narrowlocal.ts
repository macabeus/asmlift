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
// SOUNDNESS HAS TWO HALVES, AND THE CARRIER'S OWN READERS ARE ONLY THE FIRST. Typing the carrier
// narrow makes the C TRUNCATE at every incoming edge — `s16 v` assigned a wide expression keeps its
// low 16 bits.
//
//   HALF ONE, THE CARRIER. The truncation is unobservable through the carrier exactly when every
//   reader of the carrier already reads only those bits, i.e. when the carrier's one and only
//   reader is an extension of that width: `ext(trunc_w(x), w) == ext(x, w)` for every `x`. A second
//   reader of the raw carrier, or the carrier forwarded on a branch into another block's parameter,
//   would observe the bits the declaration drops — both refuse.
//
//   HALF TWO, THE INCOMING ARGUMENTS, and it is NOT implied by half one. The C names the edge
//   values with the carrier's variable: `structure.ts`'s `backArgName` hands a loop header's name
//   to the back-edge argument, so every OTHER reader of that argument reads it through the narrow
//   declaration too. Half one says nothing about them. The counterexample is a 9-instruction loop
//   whose header carrier has exactly one reader (its own `sext16`) and whose back-edge value
//   `adds r1, r2, #1` is UNTRUNCATED and also read by the `cmp` at 32 bits: narrowed, the recovered
//   C is `s16 v; do { *a0 = v; v = v + 1; } while (v < 32768);`, and this benchmark's own agbcc
//   compiles it to `b .L3` with `warning: comparison is always true due to limited range of data
//   type` — an infinite loop out of assembly that terminates. So `edge-reader` requires every value
//   arriving on an in-edge to be observed NOWHERE except through an extension of exactly this
//   carrier's width and signedness, which is the same truncation the declaration performs.
//
// AND ONE HALF THAT IS EVIDENCE, NOT SOUNDNESS. `edge-extends`: agbcc holds a narrow local
// sign/zero-extended in its register, so the extension of a REAL narrow local is at its writes, and
// a merge carrier whose in-edges carry no truncation at all is equally faithfully spelled `s32 v` +
// `(s16)v` at the one use. Deciding that with a default would foreclose a spelling no differ ever
// sees — see raise/paramwidth.ts's `not-prologue`, which is the same discrimination for the entry
// parameter. Measured at 0 of 8 accepts over 200 agbcc functions (klonoa's 182 `nonmatchings`
// plus the 18 sa3 sources this pass was built against): every carrier this pass accepts already
// has an extension or a constant on every in-edge.
//
// NO LOOP GATE, deliberately: the extension is what states the width, and it states it whether or
// not the block is a loop header. The loop is where the width is worth something, not where it
// becomes true.
//
// NOT agbcc-GATED, and not target-gated at all — a C declaration is not a target fact. Over the
// benchmark's 894 rows the only ones it moves are agbcc's, which is a measurement, not a rule.
import { type Block, type Fn, type Op, type Value, replaceAllUsesWith } from '../ir/core';
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
  /** every value arriving on an in-edge is observed only through this carrier's own truncation */
  edgeArgsObservedNarrow: boolean;
  /** every value arriving on an in-edge is itself an extension of at most this width, or a constant */
  edgeArgsExtend: boolean;
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
    // ORDERED ABOVE `cast-width` because it is what 331 of this pass's 332 width refusals over 200
    // agbcc functions actually ARE. Fused into `raw-reader` and left below `cast-width`, every one
    // of them was reported as "a width no C type spells" — a gate table that cannot attribute its
    // own declines, which is the one thing a gate table is for.
    id: 'reader-is-extension',
    why: 'a carrier whose sole reader is not an extension states no width at all',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a carrier whose sole reader is not an extension states no width',
    rejects: (c) => !c.readerIsExtension,
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
    rejects: (c) => c.uses !== 1,
  },
  {
    id: 'forwarded',
    why: 'a carrier passed on to another block parameter is read there at its full width',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a carrier forwarded as a branch argument refuses the narrowing',
    rejects: (c) => c.forwarded > 0,
  },
  {
    id: 'edge-reader',
    why: 'the C names the in-edge value with the carrier, so its other readers read the truncation',
    sound: true,
    guardedBy: 'narrow-local.test.ts: an in-edge value read at full width elsewhere refuses the narrowing',
    rejects: (c) => !c.edgeArgsObservedNarrow,
  },
  {
    id: 'edge-extends',
    // NOT sound: `s32 v` + one `(s16)v` at the use computes the same numbers. This is the
    // discrimination `paramwidth`'s `not-prologue` makes for the entry parameter — which of two
    // faithful spellings the SOURCE wrote — and a default that skips it forecloses one of them.
    why: 'agbcc extends a narrow local at its writes, so a merge with no truncating in-edge is a cast',
    sound: false,
    rejects: (c) => !c.edgeArgsExtend,
  },
];

/** Every value arriving at `blk`'s parameter `idx`, over every edge in the function. */
function incomingArgs(fn: Fn, blk: Block, idx: number): (Value | undefined)[] {
  const args: (Value | undefined)[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        if (s.block === blk) {
          args.push(s.args[idx]);
        }
      }
    }
  }
  return args;
}

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

/** Every block parameter this pass judges, with the extension that would be deleted — the gate
 *  table's INPUT, separated from its application so a test can ask which gate refuses a shape
 *  rather than only whether the pass fired. Attribution is the whole point of a gate table, and
 *  fusing "the sole reader is not an extension" into a width rule cost this one exactly that:
 *  331 of 332 width refusals over 200 agbcc functions were reported as an unspellable width. */
export function narrowLocalCandidates(fn: Fn): { c: NarrowLocalCandidate; ext: Op }[] {
  const out: { c: NarrowLocalCandidate; ext: Op }[] = [];
  const defs = new Map<Value, Op>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        defs.set(r, op);
      }
    }
  }
  for (const [i, b] of fn.blocks.entries()) {
    for (const [pi, p] of b.params.entries()) {
      const { ops, forwarded } = readersOf(fn, p);
      const ext = ops[0];
      if (ext === undefined) {
        continue;
      }
      const isExt = ext.opcode === 'sext' || ext.opcode === 'zext';
      const w = isExt ? (ext.attrs.width as number) : 0;
      const args = incomingArgs(fn, b, pi);
      // HALF TWO of the soundness argument, and the evidence half beside it — both are properties
      // of the values that ARRIVE, and neither is visible from the carrier's own readers.
      const observedNarrow = args.every((a) => {
        if (a === undefined) {
          return false;
        }
        const r = readersOf(fn, a);
        // …read only through an extension NARROWER THAN OR EQUAL TO the bits the declaration
        // keeps. Such a reader re-extends from the name explicitly (`(s16)v`), so it observes
        // exactly what it observed of the raw value; its signedness is its own business. Anything
        // else — an `add`, an `icmp`, a store of a wider width — reads bits the declaration drops.
        if (!r.ops.every((o) => (o.opcode === 'sext' || o.opcode === 'zext') && (o.attrs.width as number) <= w)) {
          return false;
        }
        // …and handed to no block parameter but this one (another would read it full-width)
        return r.forwarded === args.filter((x) => x === a).length;
      });
      const argExtends = args.every((a) => {
        const d = a === undefined ? undefined : defs.get(a);
        if (d === undefined) {
          return false;
        }
        return d.opcode === 'const' || ((d.opcode === 'sext' || d.opcode === 'zext') && (d.attrs.width as number) <= w);
      });
      out.push({
        c: {
          param: p,
          width: w,
          isEntryParam: i === 0,
          uses: ops.length,
          readerIsExtension: isExt,
          forwarded,
          edgeArgsObservedNarrow: observedNarrow,
          edgeArgsExtend: argExtends,
        },
        ext,
      });
    }
  }
  return out;
}

/** Type each block parameter at the width its sole reading extension proves, and drop that
 *  extension. Returns the number of carriers narrowed. */
export function narrowBlockLocals(fn: Fn, gates: readonly Gate<NarrowLocalCandidate>[] = NARROW_LOCAL_GATES): number {
  let narrowed = 0;
  // Re-enumerated after each rewrite: narrowing one carrier deletes an op and re-points its
  // readers, which is exactly the evidence the edge rules of a LATER carrier read. `done` is the
  // re-entry guard and nothing else — `param-typed` is the RULE about an already-typed parameter,
  // and it has to stay ablatable.
  const done = new Set<Value>();
  for (let again = true; again;) {
    again = false;
    for (const { c, ext } of narrowLocalCandidates(fn)) {
      if (done.has(c.param) || firstRejection(gates, c) !== null) {
        continue;
      }
      done.add(c.param);
      c.param.type = T.int(c.width, ext.opcode === 'sext');
      replaceAllUsesWith(fn, ext.results[0], c.param);
      for (const blk of fn.blocks) {
        const at = blk.ops.indexOf(ext);
        if (at >= 0) {
          blk.ops.splice(at, 1);
        }
      }
      narrowed++;
      again = true;
      break;
    }
  }
  return narrowed;
}
