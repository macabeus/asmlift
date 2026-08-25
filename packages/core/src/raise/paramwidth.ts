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
// WHAT THE PROLOGUE TEST CANNOT SEE, stated because the discriminator above is the whole rule and
// this is the seam in it. The scan steps over the pure materializations agbcc interleaves among the
// extensions, so a constant the scheduler HOISTED above a mid-body cast leaves `pb` looking like
// `pa`: `void pc(s32 a, s32 *out){ s32 t = 7; out[0] = (u8)a; out[1] = t; out[2] = t; }` emits
// `mov r2,#0x7 / lsl / lsr / str / str / str` and is narrowed. Both spellings of `pc` compile to
// BYTE-IDENTICAL code through agbcc, so this is a fidelity claim about the ROM's prototype rather
// than a score: a ranked arm for the wide spelling would be a compile the differ cannot referee.
// Where the two spellings DO differ in bytes, something reads the raw register or the extension is
// behind body code, and the gates below refuse.
import { type Fn, type Op, type Value, replaceAllUsesWith, successorsOf } from '../ir/core';
import { CAST_WIDTHS, type Opcode } from '../ir/opcodes';
import { T } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';

/** Ops the prologue scan steps OVER: the pure, operand-free materializations agbcc interleaves
 *  among the extensions — nothing here depends on a value, so its position says nothing about
 *  where the extensions sit. Named rather than derived from `operands: 0`, which also admits the
 *  EFFECTFUL nullary ops (a zero-argument `call`, an `opaque` with no sources) — and an extension
 *  behind a call is body code, the `pb` case this pass exists to refuse. */
const PROLOGUE_SKIP: ReadonlySet<Opcode> = new Set<Opcode>(['const', 'gaddr', 'laddr', 'undef']);

/** What the gates below judge: one entry parameter and the extension that reads it. */
export interface NarrowParamCandidate {
  /** the parameter the extension reads */
  param: Value;
  /** the extension's `width` attribute */
  width: number;
  /** the entry block has predecessors */
  entryIsJoin: boolean;
  /** the extension is in the entry block's PROLOGUE — see `PROLOGUE_SKIP` */
  inPrologue: boolean;
  /** reads of the RAW parameter anywhere in the function */
  uses: number;
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
 *  Returns the number of parameters narrowed. */
export function narrowEntryParams(fn: Fn, gates: readonly Gate<NarrowParamCandidate>[] = PARAM_WIDTH_GATES): number {
  const entry = fn.blocks[0];
  const entryIsJoin = fn.blocks.some((b) => successorsOf(b).includes(entry));
  const params = new Set(entry.params);
  // The prologue: the entry block's leading parameter extensions, plus the materializations
  // `PROLOGUE_SKIP` names. Scanning stops at the first op that READS a value — body code has run
  // by then, and an extension behind body code is where the SOURCE wrote it.
  const prologue = new Set<Op>();
  for (const op of entry.ops) {
    if (PROLOGUE_SKIP.has(op.opcode as Opcode)) {
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
