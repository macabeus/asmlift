/** THE DEAD-READ PIN: a memory read the lifted function never uses was `volatile` in the source, so
 *  it is stamped `volatile` (the `device` placement, ir/discipline.ts) before anything can delete
 *  it, and the structurer spells it through a qualified pointer or declines.
 *
 *  The claim is the COMPILER's, and it is the one ir/discipline.ts `spelledWhenDead` already rests
 *  on: an optimizing compiler deletes every plain read whose value nothing uses. agbcc expands an
 *  expression statement with no target (stmt.c `expand_expr_stmt`) and its flow pass keeps an
 *  insn whose result is dead only when `volatile_refs_p` says it touches a `MEM_VOLATILE_P` cell
 *  (flow.c:1296, rtlanal.c:1628); measured, agbcc at -O2 and -O0, ido 7.1, gcc 2.7.2 (KMC) and
 *  mwcc 2.4.2 each emit no read for `gR; *p; *(int *)0x4000004;` and keep every one of them
 *  qualified. So a read still in the target whose result is overwritten or never consumed is the
 *  `dmaRegs[2];` that ends a DMA macro, a `REG_KEYINPUT;` acknowledge, an `extern volatile` poll
 *  read once for its side effect — whatever the address, symbol or literal or a pointer parameter.
 *  Left plain, the lift's own dead-code pass (pattern/engine.ts `dce`) drops it, and the recompile
 *  loses an access the machine made.
 *
 *  DEAD means what that pass would delete: a `load`/`aload` whose result reaches no op the pass
 *  keeps, through any chain of ops it would delete with it — an extension of the read nothing reads
 *  is as dead as the read. It is decided on the RAW lift, after the frontend's SSA is final and
 *  before any raise rewrite, so a read only asmlift's own folds orphan is never counted.
 *
 *  Three reads the rule must not claim are tabled (`DEAD_READ_GATES`) and REPORTED: a caller may hand
 *  its own table (`tallying`, l3/gates.ts) to census the refusals.
 *   • a read of the function's own frame object (`laddr`): a local nothing outside the function
 *     observes, whose dead read is a reload, not an access to keep;
 *   • any read of a function that holds an unmodelled instruction (`opaque`, frontend/opaque.ts):
 *     the lift does not know what that instruction reads, so it cannot call a value unused —
 *     mwcc's `lbz r0, 76(r3)` + `rlwimi r0, r4, 7, 24, 24` + `stb` reads the byte it inserts into,
 *     and the opaque standing for the `rlwimi` does not name it;
 *   • a read the compiler could not have made of a `volatile` (target.ts `readCouldBeVolatile`): on
 *     a compiler that extends a qualified narrow read in a register, a sign-extending load is a
 *     plain read in the source, the same rule frontend/device-pins.ts applies to a device read.
 *  RESIDUE, untabled: a value an inline `asm("" :: "r"(x))` consumes. agbcc leaves the statement as a
 *  bare `.code 16` the Thumb frontend skips, so the read it keeps alive looks dead and is stamped —
 *  sa3's `Task_150_80A619C` reads `gPlayers[0].charFlags.character` that way. The stamp keeps an
 *  access the machine made of ordinary RAM, which changes no value; the spelling then misses the
 *  extraction the asm consumed. */
import type { Block, Op, Value } from '../ir/core';
import { deletableWhenDead } from '../ir/discipline';
import { type Gate, firstRejection } from '../l3/gates';
import { type TargetDescription, readCouldBeVolatile } from '../target';

/** What a dead-read gate judges: the read, and the facts about it the gates read. */
export interface DeadRead {
  readonly op: Op;
  /** its address is this function's own frame object, an offset of a `laddr` */
  readonly fromFrame: boolean;
  /** the function holds an instruction the lift could not model (an `opaque`) */
  readonly unmodelled: boolean;
  readonly target: TargetDescription;
}

export const DEAD_READ_GATES: readonly Gate<DeadRead>[] = [
  {
    id: 'frame-object',
    why: 'a dead read of a local of this function is a reload, which nothing outside it observes',
    sound: false,
    guardedBy: 'dead-reads.test.ts: frame-object: a dead read of a frame object stays deletable',
    rejects: (c) => c.fromFrame,
  },
  {
    id: 'unmodelled-instruction',
    why: 'an instruction the lift could not model may be what reads the value, so the read is not proved dead',
    sound: false,
    guardedBy: 'dead-reads.test.ts: unmodelled-instruction: a read an unmodelled instruction may consume stays plain',
    rejects: (c) => c.unmodelled,
  },
  {
    id: 'not-a-volatile-read',
    why: 'a read that extends in a way the compiler never extends a volatile one was plain in the source',
    sound: false,
    guardedBy: 'dead-reads.test.ts: not-a-volatile-read: a dead sign-extending narrow read stays plain on agbcc',
    rejects: (c) => !readCouldBeVolatile(c.target.compilerBehaviors, c.op),
  },
];

/** The ops pattern/engine.ts `dce` would delete from these blocks, without deleting them: an op it
 *  may delete whose single result no op it keeps reads, to a fixed point. */
function deadOps(irBlocks: readonly Block[]): Set<Op> {
  const dead = new Set<Op>();
  let changed = true;
  while (changed) {
    changed = false;
    const used = new Set<Value>();
    for (const b of irBlocks) {
      for (const op of b.ops) {
        if (dead.has(op)) {
          continue;
        }
        for (const o of op.operands) {
          used.add(o);
        }
        for (const s of op.successors) {
          for (const a of s.args) {
            used.add(a);
          }
        }
      }
    }
    for (const b of irBlocks) {
      for (const op of b.ops) {
        if (!dead.has(op) && deletableWhenDead(op) && op.results.length === 1 && !used.has(op.results[0])) {
          dead.add(op);
          changed = true;
        }
      }
    }
  }
  return dead;
}

/** Stamp `volatile` on every read these blocks never use that no gate refuses. */
export function pinDeadReads(
  irBlocks: readonly Block[],
  target: TargetDescription,
  gates: readonly Gate<DeadRead>[] = DEAD_READ_GATES,
): void {
  const defOf = new Map<Value, Op>();
  for (const b of irBlocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        defOf.set(r, op);
      }
    }
  }
  // An offset of a frame object: the `laddr` itself, or a sum or difference with one beside it.
  const fromFrame = (v: Value, depth = 0): boolean => {
    const d = defOf.get(v);
    if (d === undefined || depth > 8) {
      return false;
    }
    if (d.opcode === 'laddr') {
      return true;
    }
    return (d.opcode === 'add' || d.opcode === 'sub') && d.operands.some((o) => fromFrame(o, depth + 1));
  };
  const unmodelled = irBlocks.some((b) => b.ops.some((op) => op.opcode === 'opaque'));
  for (const op of deadOps(irBlocks)) {
    if (op.opcode !== 'load' && op.opcode !== 'aload') {
      continue;
    }
    if (firstRejection(gates, { op, fromFrame: fromFrame(op.operands[0]), unmodelled, target }) === null) {
      op.attrs = { ...op.attrs, volatile: true };
    }
  }
}
