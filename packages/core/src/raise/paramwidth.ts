// A NARROW DECLARED PARAMETER, extended once in the prologue.
//
// agbcc has no byte/half register move, so a callee whose parameter is declared `u8`/`s16` widens
// it itself, with a shift pair at the very top of the function — the caller passes a full register
// and the extension is part of the prologue. Both spellings below compiled with this benchmark's
// own agbcc, and where each one puts the pair is the whole rule:
//
//     void pa(s32 *out, u8 a)  { out[0]=1; out[1]=2; out[2]=a; }      lsl/lsr mov str mov str str
//     void pb(s32 *out, s32 a) { out[0]=1; out[1]=2; out[2]=(u8)a; }  mov str mov str lsl/lsr str
//
// The idiom patterns fold that pair to one `zext`/`sext` op, so `pa`'s parameter reaches this pass
// as a value whose SOLE use is its own extension — nothing can read the raw register, which is
// exactly what a narrow declaration means. Recovered as a wide parameter instead, the same function
// has to re-spell `(u8)a` at every use; agbcc then elides an extension no use needs, gives the
// extended value no register of its own, and the whole allocation moves.
//
// WIDTH AND SIGNEDNESS ARE READ OFF, NOT GUESSED: the shift pair says both (`lsl/asr #16` ⇒ `s16`,
// `lsl/lsr #24` ⇒ `u8`), so this decides rather than enumerating — it adds no ranked candidate, and
// removes some (rank.ts declines the signedness axis where every scalar parameter is narrow).
//
// NOT agbcc-GATED, because the shape is not agbcc's alone: mwcc's PPC prologue widens a declared
// narrow parameter with the `extsb`/`extsh` the frontend lifts to the same op, and the synthetic
// `sextb`/`tos8` rows keep matching on that toolchain through this pass.
//
// REFUSAL CONDITIONS:
//   - the entry block has predecessors: its params are merge values, not the function's arguments
//   - the parameter is already typed — the pointer/aggregate recovery got there first
//   - the parameter has any use other than the extension — a reader of the raw register proves the
//     declaration was wide
//   - the extension is not in the entry block's PROLOGUE. This is the condition that separates
//     `pa` from `pb`, and it was measured rather than assumed: `pb`'s parameter also has the
//     extension as its sole use, and narrowing it would hoist two instructions to the top of the
//     function
//   - the extension width is not 8 or 16 — the only widths `zext`/`sext` carry
import { type Fn, type Op, type Value, replaceAllUsesWith, successorsOf } from '../ir/core';
import { T } from '../ir/types';

/** Widths a `zext`/`sext` carries, and so the widths a parameter can be declared at. */
const CAST_WIDTHS = new Set([8, 16]);

/** How many times `v` is read anywhere in `fn` — op operands and branch arguments alike. */
function useCount(fn: Fn, v: Value): number {
  let n = 0;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      n += op.operands.filter((o) => o === v).length;
      for (const s of op.successors) {
        n += s.args.filter((a) => a === v).length;
      }
    }
  }
  return n;
}

/** Type an entry parameter at the width its prologue extension proves, and drop the extension.
 *  Returns the number of parameters narrowed. */
export function narrowEntryParams(fn: Fn): number {
  const entry = fn.blocks[0];
  if (entry.params.length === 0 || fn.blocks.some((b) => successorsOf(b).includes(entry))) {
    return 0;
  }
  const params = new Set(entry.params);
  // The prologue: the entry block's leading parameter extensions, plus the operand-less
  // materializations (`const`, `gaddr`, `laddr`, `undef`) agbcc interleaves among them — those
  // depend on nothing, so their position says nothing about where the extensions sit. Scanning
  // stops at the first op that READS a value: body code has run by then, and an extension behind
  // body code is where the SOURCE wrote it.
  const prologue: Op[] = [];
  for (const op of entry.ops) {
    if (op.operands.length === 0 && op.successors.length === 0) {
      continue;
    }
    if ((op.opcode !== 'sext' && op.opcode !== 'zext') || !params.has(op.operands[0])) {
      break;
    }
    prologue.push(op);
  }
  let narrowed = 0;
  for (const op of prologue) {
    const p = op.operands[0];
    const width = op.attrs.width as number;
    if (p.type.kind !== 'unknown' || !CAST_WIDTHS.has(width) || useCount(fn, p) !== 1) {
      continue;
    }
    p.type = T.int(width, op.opcode === 'sext');
    replaceAllUsesWith(fn, op.results[0], p);
    entry.ops.splice(entry.ops.indexOf(op), 1);
    narrowed++;
  }
  return narrowed;
}
