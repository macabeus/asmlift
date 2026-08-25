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
// WIDTH AND SIGNEDNESS ARE READ OFF, NOT GUESSED: the extension states both (agbcc's shift pair by
// its amount and its `asr`/`lsr`, PPC's by the opcode), so no width is ever enumerated here.
//
// NOT agbcc-GATED, because the shape is not agbcc's alone: mwcc's PPC prologue widens a declared
// narrow parameter with the `extsb`/`extsh` the frontend lifts to the same op, and the synthetic
// `sextb`/`tos8` rows keep matching on that toolchain through this pass.
//
// WHAT THE PROLOGUE TEST CANNOT SEE, and why the declaration settles it. The scan steps over the
// pure materializations agbcc interleaves among the extensions, so a constant the scheduler HOISTED
// above a mid-body cast leaves `pb` looking like `pa`:
//
//     void pc(s32 a, s32 *out) { s32 t = 7; out[0] = (u8)a; out[1] = t; out[2] = t; }
//         movs r2,#7 / lsls r0,#24 / lsrs r0,#24 / str / str / str
//     void pc(u8 a, s32 *out)  { s32 t = 7; out[0] = a;     out[1] = t; out[2] = t; }
//         lsls r0,#24 / lsrs r0,#24 / movs r2,#7 / str / str / str
//
// Those two ROM sources are DIFFERENT BYTES — the const moves across the shift pair — so the width
// is a fact here and not a spelling, while no reader of the raw register and no body code is
// present to make the gates below refuse. Nor does the ORDER decide it: sa3's `sub_802DFC8` really
// is declared `s16 direction` and agbcc emits its `movs r5, #0` before the `lsl/asr` too, so the
// hoisted-const shape arrives from both source spellings and reaches this pass as the same IR.
//
// The tiebreak is therefore not in the asm, and the SCORE cannot supply it either: asmlift
// re-materializes a small constant at each use instead of binding it to a local, so its own two
// spellings of `pc` emit the same instruction order and score alike. `proto-width` takes the
// tiebreak from the caller's declaration instead, and where none was supplied the extension stands.
// What that refusal protects is a function this pass never compiles: agbcc truncates at every
// PROTOTYPED CALL SITE of a narrow-declared callee — `lsl/asr` ahead of the `bl`, two Thumb
// instructions per site — so a wrong width here costs bytes the per-function differ cannot see.
import { type Fn, type Op, type Value, replaceAllUsesWith, successorsOf } from '../ir/core';
import { CAST_WIDTHS, MATERIALIZING_OPS } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';
import { type FnProto, declaredWidth } from '../proto';

/** What the gates below judge: one entry parameter and the extension that reads it. */
export interface NarrowParamCandidate {
  /** the parameter the extension reads */
  param: Value;
  /** the extension's `width` attribute */
  width: number;
  /** the entry block has predecessors */
  entryIsJoin: boolean;
  /** the extension is in the entry block's PROLOGUE — see the scan in `narrowEntryParams` */
  inPrologue: boolean;
  /** reads of the RAW parameter anywhere in the function */
  uses: number;
  /** the width the caller's own prototype declares for this parameter, if it declares one */
  declared: number | undefined;
}

export const PARAM_WIDTH_GATES: readonly Gate<NarrowParamCandidate>[] = [
  {
    id: 'entry-is-join',
    why: "a joined entry's params are merge values, not the function's arguments",
    sound: true,
    guardedBy: 'param-width.test.ts: an entry block with a predecessor carries merge values, not arguments',
    rejects: (c) => c.entryIsJoin,
  },
  {
    id: 'param-typed',
    why: 'the pointer/aggregate recovery already decided this parameter',
    sound: true,
    guardedBy: 'param-width.test.ts: a parameter the pointer recovery already typed is left alone',
    rejects: (c) => c.param.type.kind !== 'unknown',
  },
  {
    id: 'cast-width',
    why: 'only 8 and 16 are widths a `zext`/`sext` — and so a C declaration — carries',
    sound: true,
    guardedBy: 'param-width.test.ts: a width no C type spells is refused',
    rejects: (c) => !CAST_WIDTHS.has(c.width),
  },
  {
    id: 'raw-reader',
    why: 'a reader of the un-extended register proves the declaration was wide',
    sound: true,
    guardedBy: 'param-width.test.ts: a second reader of the raw parameter proves the declaration was wide',
    rejects: (c) => c.uses !== 1,
  },
  {
    id: 'proto-width',
    why: "the caller's headers declare this parameter, and a declaration outranks an inference",
    sound: true,
    guardedBy: 'param-width.test.ts: a declared width the extension contradicts refuses the narrowing',
    rejects: (c) => c.declared !== undefined && c.declared !== c.width,
  },
  {
    id: 'not-prologue',
    why: 'an extension behind body code is where the SOURCE wrote the cast',
    sound: true,
    guardedBy: 'param-width.test.ts: an extension behind a nullary call is body code',
    rejects: (c) => !c.inPrologue,
  },
];

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
 *  `self` is the prototype the caller supplied for THIS function, if any. Returns the number of
 *  parameters narrowed. */
export function narrowEntryParams(
  fn: Fn,
  self?: FnProto,
  gates: readonly Gate<NarrowParamCandidate>[] = PARAM_WIDTH_GATES,
): number {
  const entry = fn.blocks[0];
  const declared = Array.isArray(self?.params) ? self.params.map(declaredWidth) : [];
  const entryIsJoin = fn.blocks.some((b) => successorsOf(b).includes(entry));
  const params = new Set(entry.params);
  // The prologue: the entry block's leading parameter extensions, plus the `MATERIALIZING_OPS`
  // agbcc interleaves among them. Scanning stops at the first op that READS a value — body code
  // has run by then, and an extension behind body code is where the SOURCE wrote it.
  const prologue = new Set<Op>();
  for (const op of entry.ops) {
    if (MATERIALIZING_OPS.has(op.opcode)) {
      continue;
    }
    if ((op.opcode !== 'sext' && op.opcode !== 'zext') || !params.has(op.operands[0])) {
      break;
    }
    prologue.add(op);
  }
  let narrowed = 0;
  for (const op of [...entry.ops]) {
    if (op.opcode !== 'sext' && op.opcode !== 'zext') {
      continue;
    }
    const p = op.operands[0];
    if (!params.has(p)) {
      continue;
    }
    const width = op.attrs.width as number;
    const c: NarrowParamCandidate = {
      param: p,
      width,
      entryIsJoin,
      inPrologue: prologue.has(op),
      uses: useCount(fn, p),
      declared: declared[entry.params.indexOf(p)],
    };
    if (firstRejection(gates, c) !== null) {
      continue;
    }
    p.type = T.int(width, op.opcode === 'sext');
    replaceAllUsesWith(fn, op.results[0], p);
    entry.ops.splice(entry.ops.indexOf(op), 1);
    narrowed++;
  }
  return narrowed;
}
