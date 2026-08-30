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
// So the width of a carrier is a fact about the emitted code, and it is recovered here rather than
// enumerated for the same reason `paramwidth` recovers its own: an extension states a width and a
// signedness outright. What it does NOT always state is that the source DECLARED them — see
// `edge-extends` below, where two spellings survive and this file picks one.
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
// AND ONE HALF THAT IS EVIDENCE, NOT SOUNDNESS — `edge-extends`, WHERE THE TRUNCATION IS. Both
// spellings compute the same numbers, so nothing here is a correctness argument; what decides it is
// which shape agbcc leaves in the asm. PROMOTE_MODE's write-back truncation is a `zext`, and where
// it LANDS is the whole rule. In a loop it lands on the back edge, so the carrier's in-edge value
// is itself an extension. Across a plain merge gcc SINKS the common truncation past the join, where
// it stops being an in-edge fact and becomes the carrier's own reader — so an in-edge test alone
// reads a real narrow local as a cast. All four spellings compiled with this benchmark's own agbcc,
// each round-tripped through decompile() and scored against its own object:
//
//   SOURCE                              CARRIER'S READER   REFUSED   ADMITTED
//   s16 v; … *out = v;                  zext16 -> sext16       6     0 MATCH
//   s32 v; … *out = (s16)v;             sext16             0 MATCH       6
//   u16 v; … *out = v;                  zext16                 4     0 MATCH
//   s32 v; … *out = (u16)v;             zext16             0 MATCH       4
//
// Rows one and two are DECIDABLE and are decided: a `zext_w` read by a `sext_w` is the write-back
// truncation followed by the declaration's own sign extension, and no cast on a wide local writes
// that pair. Rows three and four are the same IR in this pass's whole vocabulary — same reader,
// same raw in-edges, opposite answers — and differ only in the branch shape agbcc chose, which is
// the score's business and not a raise-level gate's. So the gate admits the decidable half and
// leaves the other refused, and the refusal is a CHOICE this file makes rather than evidence it
// reads.
//
// ITS PRICE IS MEASURED OVER THE SET IT REFUSES, never over the set it admits — a gate priced on
// its own accepts cannot show a cost. Over 2288 per-function sa3 sources, every one lifted, the
// shipped table is `entry-param 1228 · reader-is-extension 2114 · param-typed 33 · raw-reader 13 ·
// forwarded 7 · edge-reader 28 · edge-extends 40 · ACCEPT 60`. Reading the sunk write-back moved 9
// carriers, in 9 functions, out of `edge-extends` and into `ACCEPT`. Of the 40 refusals left, 30
// are a single `zext` (rows three and four) and 10 a single `sext` (row two), and they live in 37
// functions, not one of which is among the 42 sa3 rows the benchmark carries — which is why
// `bench diff` cannot price this gate at all, and why the three `merge*` rows in
// apps/benchmark/dataset/synthetic.ts exist.
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
  /** reads of the RAW parameter by op OPERANDS anywhere in the function. Branch arguments are NOT
   *  counted here — they are `forwarded`'s — which is where this differs from the identically
   *  named field in raise/paramwidth.ts, whose `useCount` sums both. */
  operandReads: number;
  /** the sole reader is a `sext`/`zext` */
  readerIsExtension: boolean;
  /** occurrences of the RAW parameter as a branch argument */
  forwarded: number;
  /** every value arriving on an in-edge is observed only through this carrier's own truncation */
  edgeArgsObservedNarrow: boolean;
  /** every value arriving on an in-edge is itself an extension of at most this width, or a constant */
  edgeArgsExtend: boolean;
  /** the sole reader is a `zext {w}` whose own sole reader is a `sext {w}` — PROMOTE_MODE's
   *  write-back truncation sunk past a join, then the declaration's own sign extension */
  writeBackTruncation: boolean;
  /** the carrier's block is a TWO-ARMED MERGE: exactly two predecessor blocks, and neither of them
   *  branches to the other. `gcc/jump.c:443-445` rewrites `if (…) x = a; else x = b;` into
   *  `x = b; if (…) x = a;` — collapsing the diamond into the hoisted shape, where the join's own
   *  predecessor is the conditional branch that also targets the surviving arm. Its guard at
   *  `:895-902` requires the else arm to be ONE insn holding ONE SET, which `gcc/thumb.h:344`
   *  PROMOTE_MODE forbids for a narrow-DECLARED local (the assignment expands to the arithmetic
   *  plus its truncation pair). So a surviving diamond is evidence FOR a declaration and a hoisted
   *  join is evidence against one. */
  mergeDiamond: boolean;
}

export const NARROW_LOCAL_GATES: readonly Gate<NarrowLocalCandidate>[] = [
  {
    // SOUND, and its safety lives in ANOTHER table — which the `sound` flag has no word for, so it
    // is spelled out here. Dropping this rule does not re-decide an entry parameter, it takes the
    // decision from raise/paramwidth.ts: this pass runs first and deletes the extension, leaving
    // `proto-width` and `not-prologue` nothing to judge. Measured on the shape they exist for — a
    // prologue `sext16` under a caller prototype declaring `u8` — paramwidth narrows 0, this pass
    // narrows 0, this pass WITHOUT this gate narrows 1 to `s16` and paramwidth then sees nothing.
    // A wrong parameter width costs bytes at every prototyped call site, which no per-function
    // differ sees.
    id: 'entry-param',
    why: "a function's own arguments are the prologue pass's territory",
    sound: true,
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
    // ORDERED ABOVE `cast-width`, which is where the attribution lives: over 2288 sa3 functions
    // this rule refuses 2114 carriers and `cast-width` refuses none, and below it every one of
    // those 2114 read as "a width no C type spells".
    //
    // THIS RULE AND `cast-width` ARE ONE SOUNDNESS ARGUMENT IN TWO ENTRIES, and neither is
    // ablatable alone: a non-extension reader gives `width = 0`, which the other refuses, and no
    // producer in the tree emits an extension at a width outside `CAST_WIDTHS` (the pattern engine
    // and frontend/ppc.ts write 8 and 16; raise/narrow.ts re-writes a width already gated on that
    // set), so `cast-width` fires 0 times in this order. Drop BOTH and the pass types a carrier
    // `u0` and deletes the op that read it — which is why the joint ablation is the guard both
    // name, and why neither may rest on an ablation of its own.
    id: 'reader-is-extension',
    why: 'a carrier whose sole reader is not an extension states no width at all',
    sound: true,
    guardedBy: 'narrow-local.test.ts: the width pair is jointly load-bearing and neither half alone',
    rejects: (c) => !c.readerIsExtension,
  },
  {
    id: 'cast-width',
    why: 'only 8 and 16 are widths a `zext`/`sext` — and so a C declaration — carries',
    sound: true,
    guardedBy: 'narrow-local.test.ts: the width pair is jointly load-bearing and neither half alone',
    rejects: (c) => !CAST_WIDTHS.has(c.width),
  },
  {
    id: 'raw-reader',
    // Operand reads ONLY. raise/paramwidth.ts ships this id over a `useCount` that sums operands
    // AND successor arguments; here a forwarded carrier is `forwarded`'s refusal, so the same shape
    // is refused by both tables under two different names.
    why: 'a reader of the un-extended carrier observes the bits the declaration would drop',
    sound: true,
    guardedBy: 'narrow-local.test.ts: a second reader of the raw carrier refuses the narrowing',
    rejects: (c) => c.operandReads !== 1,
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
    // NOT sound: `s32 v` + one `(s16)v` at the use computes the same numbers, so what this decides
    // is a spelling and the header's 2×2 is the evidence for the direction. It is NOT the same
    // judgment as `paramwidth`'s `not-prologue`, which is `sound: true` for a reason this rule has
    // no access to: a parameter's width is its SIGNATURE, and agbcc truncates at every prototyped
    // call site of a narrow-declared callee — bytes in other functions, which no per-function
    // differ sees. A block local's width leaves the function's interface alone, so the worst this
    // rule can do is pick the losing spelling of two that compile, and nothing here is wrong.
    why: 'the write-back truncation is the evidence: no truncation on an in-edge and none sunk to the join',
    sound: false,
    guardedBy: 'narrow-local.test.ts: a merge whose in-edges carry no truncation is a cast, not a declaration',
    rejects: (c) => !c.edgeArgsExtend && !c.writeBackTruncation,
  },
];

/** The blocks that branch to `blk`, deduplicated — hoisted once per `narrowLocalCandidates` call
 *  rather than recomputed per parameter, which is what keeps this an O(E) walk of the function and
 *  not an O(E * params) one. */
function predecessorsOf(fn: Fn): Map<Block, Block[]> {
  const preds = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        const list = preds.get(s.block);
        if (list === undefined) {
          preds.set(s.block, [b]);
        } else if (!list.includes(b)) {
          list.push(b);
        }
      }
    }
  }
  return preds;
}

/** A two-armed merge: exactly two predecessors, neither of which branches to the other. The second
 *  clause is what separates `gcc/jump.c`'s hoisted shape — where the conditional branch itself is a
 *  predecessor of the join AND of the one surviving arm — from the diamond the source's own
 *  `if`/`else` leaves behind. A loop header fails it for the same reason: the header branches to
 *  the latch that branches back. */
function isMergeDiamond(preds: Map<Block, Block[]>, blk: Block): boolean {
  const p = preds.get(blk);
  if (p === undefined || p.length !== 2) {
    return false;
  }
  const [x, y] = p;
  const branchesToBoth = (from: Block, other: Block): boolean =>
    from.ops.some((op) => op.successors.some((s) => s.block === blk) && op.successors.some((s) => s.block === other));
  return !branchesToBoth(x, y) && !branchesToBoth(y, x);
}

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
 *  table's INPUT, separated from its application so a test can ask WHICH gate refuses a shape
 *  rather than only whether the pass fired. */
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
  const preds = predecessorsOf(fn);
  for (const [i, b] of fn.blocks.entries()) {
    const diamond = isMergeDiamond(preds, b);
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
      // …and the same truncation SUNK PAST THE JOIN, which is where gcc puts it when every arm
      // writes the local: the carrier's own reader is the `zext` write-back, and the sole reader of
      // THAT is the sign extension the narrow declaration is read through. A cast on a wide local
      // writes one extension, never this pair.
      const extRead = ext.opcode === 'zext' ? readersOf(fn, ext.results[0]) : undefined;
      const writeBackTruncation =
        extRead !== undefined &&
        extRead.forwarded === 0 &&
        extRead.ops.length === 1 &&
        extRead.ops[0].opcode === 'sext' &&
        extRead.ops[0].attrs.width === w;
      out.push({
        c: {
          param: p,
          width: w,
          isEntryParam: i === 0,
          operandReads: ops.length,
          readerIsExtension: isExt,
          forwarded,
          edgeArgsObservedNarrow: observedNarrow,
          edgeArgsExtend: argExtends,
          writeBackTruncation,
          mergeDiamond: diamond,
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
