/** THE POLL-READ PIN: a memory read a loop makes each time round, at an address the loop never
 *  changes, in a loop that makes no call, was `volatile` in the source, so it
 *  is stamped `volatile` (the `device` placement, ir/discipline.ts) and the structurer spells it
 *  through a qualified pointer or declines.
 *
 *  The claim is the COMPILER's: at a level that moves loop-invariant code
 *  (where target.ts `keepsLoopInvariantReads` is absent), a plain read at an invariant address in a loop that
 *  stores nothing and calls nothing is invariant, and the compiler loads it once, ahead of the
 *  loop. agbcc's loop pass takes a `MEM` for invariant when it is not volatile and no store in the
 *  loop may alias it (loop.c `invariant_p`, and `load_mems` past it), so `while (*(s32 *)0x4000004
 *  & 3);` becomes `.L3: cmp r0, #0; bne .L3`. COMPILED, the same source on each compiler, the read
 *  left in the loop only when it was `volatile`: agbcc and KMC gcc 2.7.2 at `-O1` and `-O2`, IDO 7.1
 *  at `-O2` and `-O3`, mwcc 2.4.2 at `-O3` and `-O4,p` each turn it into a branch to itself; IDO at
 *  `-O1` and mwcc at `-O1` and `-O2` keep the plain read in the loop, and those levels pin nothing.
 *  So a lift that left such a read plain would recompile to a loop that never reads the register
 *  again: kl2dct's DMA waits (`do {} while (((s32 *)0x40000d4)[2] & 0x80 << 24)`) and VCOUNT waits.
 *
 *  THE READS THE COMPILER MAY HAVE MOVED ARE PINNED. Whether it did is decided on more than the
 *  asm shows — the alias analysis's register history, and `move_movables`' cost model, which leaves
 *  a read of a long loop in place (loop.c:1826-1830, `threshold * savings * lifetime` against the
 *  loop's insns) — so a read pinned here may be one a plain source kept. That over-reach costs a
 *  spelling, and in a loop that stores it can cost the store's judgement too (below). The bounds:
 *   • the loop makes no call and holds no unmodelled instruction (`opaque`), in any of its blocks,
 *     nested loops included: the compiler moves nothing out of a loop that calls, and an
 *     unmodelled instruction may be one. A loop left for several places is pinned like any other:
 *     the exit-target gate (loop.c:2512-2525) stops only `load_mems`, and `scan_loop`'s movables
 *     (871-887) do not look at exit targets;
 *   • where the loop stores, only a read a branch that leaves the loop or goes round it again
 *     decides on (`testedReads`): a poll's. Where an access's address moves, not a read the
 *     compiler provably keeps beside it (`keptBesideMoving`): a store through a stepped pointer keeps
 *     a read at a fixed address only where one of the two is a byte, so a copy loop's `u8` bound
 *     beside an `s32` copy stays plain (kl2dct's `AgbMain`), and `while (*(u16 *)0x4000006 != 160)
 *     *p++ = 0;` with `s32 *p`, which agbcc loads once ahead of the loop, is pinned. Where every
 *     access is at a fixed address, whether a store keeps a plain read in the loop is the
 *     compiler's alias analysis, decided on register history the lift cannot see — agbcc keeps
 *     `while (((volatile s32 *)0x40000d4)[2] & M) ((s32 *)0x40000d4)[5] = a0;`'s read but moves
 *     the plain spelling of it, and IDO 7.1 keeps `while (*(s32 *)A & 3) ((s32 *)B)[1] = a0;`'s read
 *     while moving `while (gF == 0) gW = a0;`'s — so the read is pinned, which is right whichever
 *     the compiler decided, and the store is the poll-store rule's (contracts.ts `sunkPollStore`).
 *     A pinned read the loop's condition renders makes the loop a poll to that rule, which refuses
 *     a plain store no rule proves kept: a counted loop's `u8` bound beside DMA stores (sa3's
 *     `ProcessOamBuffers`) declines though agbcc kept its stores, since a byte read keeps no store
 *     its addresses prove apart from (`for (;;) { DMA[5] = a0; if (++i >= *(volatile u8 *)&gIdx)
 *     break; }` sinks it), and leaving the bound plain lets `do { …; i++; } while (i < gIdx);` load it
 *     once. A header read no exit tests is left as it was, though `scan_loop` moves it whatever
 *     tests it (`do { if (VCOUNT == 3) DMA[6] = a0; } while (DMA[2] & M);` loads VCOUNT once when
 *     plain): pinning it forecloses the base-pointer spelling three matched rows need
 *     (`synthetic:fieldbase`, `dmafield`, `dmaflat`), whose constant-address plain read agbcc moves. Not on a compiler that keeps the read beside any store (target.ts
 *     `keepsInvariantReadsBesideStores`: mwcc, in every probe);
 *   • the read is in the loop's header, the block every time round starts with, ahead of every
 *     branch the loop takes. A read past one is `maybe_never` to agbcc (loop.c, under a label or a
 *     conditional jump), which on Thumb, where any load may trap (rtlanal.c `may_trap_p`), stays
 *     in the loop plain;
 *   • its address is invariant: every value it is computed from is a constant, a symbol's address,
 *     or a value defined outside the loop, through pure arithmetic — no read, no block argument of
 *     a loop block;
 *   • it is no read of the function's own frame (`laddr`): the frame audit owns the qualifier of a
 *     frame object (frontend/frame-objects.ts);
 *   • the compiler could have made it of a `volatile` (target.ts `readCouldBeVolatile`): a
 *     sign-extending narrow load on agbcc is a plain read's, and stays plain.
 *  The guard a rotated `while` duplicates its test into ahead of the loop reads the same cell, and
 *  is pinned with it (`sameRead`): it is the source's one condition, and only two reads alike let
 *  the structurer fuse the guard back into the loop. Without it, a `/volatile` pointer spelling
 *  that matched before (`synthetic:onepoll`) lost its `while`.
 *  Over-reach never costs an access, as the device pin's does not: a `volatile` read is made where
 *  the machine made it. */
import { type Block, type Op, type Value, dominators, predecessors, reachableBlocks, terminator } from '../ir/core';
import { effectful } from '../ir/discipline';
import { type NaturalLoop, analyzeLoops } from '../ir/loops';
import { MEM_BASE_OPS } from '../ir/opcodes';
import { type TargetDescription, readCouldBeVolatile } from '../target';

/** Ops whose value is computed from their operands alone: an address built of these over invariant
 *  values is invariant. */
const PURE_ADDRESS_OPS: ReadonlySet<string> = new Set([
  'const',
  'gaddr',
  'add',
  'sub',
  'shl',
  'shr_u',
  'or',
  'and',
  'mul',
]);

/** Stamp `volatile` on every read the module comment describes, in place. A no-op on a target whose
 *  flags move no loop-invariant code. */
export function pinPollReads(irBlocks: readonly Block[], target: TargetDescription): void {
  if (target.compilerBehaviors.keepsLoopInvariantReads === true) {
    return;
  }
  const reached = reachableBlocks({ blocks: irBlocks });
  const blocks = irBlocks.filter((b) => reached.has(b));
  if (blocks.length === 0) {
    return;
  }
  const fn = {
    name: '',
    blocks,
    writeOrder: undefined,
    slotHomes: undefined,
    paramEvidence: undefined,
    localObjects: undefined,
    asmLayout: undefined,
  };
  const loops = analyzeLoops(fn, dominators(fn));
  const preds = predecessors(fn);
  if (loops.byHeader.size === 0) {
    return;
  }
  const defOf = new Map<Value, Op>();
  const defBlock = new Map<Value, Block>();
  const incoming = new Map<Value, Value[]>();
  for (const b of blocks) {
    for (const edge of terminator(b)?.successors ?? []) {
      edge.block.params.forEach((p, i) => {
        const a = edge.args[i];
        if (a !== undefined) {
          incoming.set(p, [...(incoming.get(p) ?? []), a]);
        }
      });
    }
  }
  for (const b of blocks) {
    b.params.forEach((p) => defBlock.set(p, b));
    for (const op of b.ops) {
      for (const r of op.results) {
        defOf.set(r, op);
        defBlock.set(r, b);
      }
    }
  }
  for (const loop of loops.byHeader.values()) {
    // A loop left for more than one place — an early `return`, a `break` past a tail — is no
    // exception: the exit-target gate (loop.c:2512-2525) stops only `load_mems`, and `scan_loop`'s
    // movables (871-887) do not look at exit targets, so `while (VCOUNT != 160) { if (DISPSTAT &
    // 1) return 1; }` loads DISPSTAT once, ahead of the loop, when it is plain.
    const ops = [...loop.body].flatMap((b) => b.ops);
    if (ops.some((op) => op.opcode === 'call' || op.opcode === 'opaque')) {
      continue;
    }
    // A loop that stores: only the reads its exit tests, and not where the compiler keeps them.
    const stores = ops.some(effectful);
    if (stores && target.compilerBehaviors.keepsInvariantReadsBesideStores === true) {
      continue;
    }
    const invariant = (v: Value, depth = 0): boolean => {
      const at = defBlock.get(v);
      if (at === undefined || !loop.body.has(at)) {
        return true; // a function parameter, or defined outside the loop
      }
      const d = defOf.get(v);
      return (
        d !== undefined &&
        depth < 16 &&
        PURE_ADDRESS_OPS.has(d.opcode) &&
        d.operands.every((o) => invariant(o, depth + 1))
      );
    };
    const moves = (op: Op): boolean =>
      MEM_BASE_OPS.has(op.opcode) &&
      !op.operands.slice(0, op.opcode === 'aload' || op.opcode === 'astore' ? 2 : 1).every((o) => invariant(o));
    const kept = stores && ops.some(moves) ? keptBesideMoving(ops, moves, defOf, incoming) : undefined;
    const tested = stores ? testedReads(loop, defOf) : undefined;
    const fromFrame = (v: Value, depth = 0): boolean => {
      const d = defOf.get(v);
      return (
        d !== undefined &&
        depth < 16 &&
        (d.opcode === 'laddr' ||
          ((d.opcode === 'add' || d.opcode === 'sub') && d.operands.some((o) => fromFrame(o, depth + 1))))
      );
    };
    const pinned: Op[] = [];
    for (const op of loop.header.ops) {
      if (
        (op.opcode === 'load' || op.opcode === 'aload') &&
        op.attrs.volatile !== true &&
        (tested === undefined || tested.has(op)) &&
        !(kept?.(op) ?? false) &&
        op.operands.every((o) => invariant(o)) &&
        !fromFrame(op.operands[0]) &&
        readCouldBeVolatile(target.compilerBehaviors, op)
      ) {
        op.attrs = { ...op.attrs, volatile: true };
        pinned.push(op);
      }
    }
    // The guard a rotated `while` duplicates its test into ahead of the loop reads the same cell
    // (agbcc, IDO and KMC copy the exit test to the loop's entry): it is the source's one
    // condition, so it is the qualified read too, and the structurer fuses the guard back into the
    // loop only when the two reads are alike (l3/ast.ts `FusedGuard`).
    for (let guard of loop.forwardPreds) {
      // past the straight-line blocks between the guard and the loop (a preheader)
      for (let n = 0; terminator(guard)?.opcode === 'br' && (preds.get(guard) ?? []).length === 1 && n < 8; n++) {
        guard = (preds.get(guard) ?? [])[0];
      }
      if (terminator(guard)?.opcode !== 'cond_br') {
        continue;
      }
      for (const op of guard.ops) {
        if (
          (op.opcode === 'load' || op.opcode === 'aload') &&
          op.attrs.volatile !== true &&
          pinned.some((p) => sameRead(p, op, defOf))
        ) {
          op.attrs = { ...op.attrs, volatile: true };
        }
      }
    }
  }
}

/** Do two reads read one cell: one opcode, width and displacement, through addresses that are one
 *  value or one constant computed alike. */
function sameRead(a: Op, b: Op, defOf: ReadonlyMap<Value, Op>): boolean {
  return (
    a.opcode === b.opcode &&
    JSON.stringify(a.attrs) === JSON.stringify({ ...b.attrs, volatile: true }) &&
    a.operands.length === b.operands.length &&
    a.operands.every((o, i) => sameValue(o, b.operands[i], defOf))
  );
}

/** Are two values one value, or one constant computed alike. */
function sameValue(x: Value, y: Value, defOf: ReadonlyMap<Value, Op>, depth = 0): boolean {
  if (x === y) {
    return true;
  }
  const dx = defOf.get(x);
  const dy = defOf.get(y);
  if (dx === undefined || dy === undefined || depth > 8 || dx.opcode !== dy.opcode) {
    return false;
  }
  if (dx.opcode === 'const' || dx.opcode === 'gaddr') {
    return dx.attrs.value === dy.attrs.value && dx.attrs.sym === dy.attrs.sym;
  }
  return (
    (dx.opcode === 'add' || dx.opcode === 'sub' || dx.opcode === 'shl') &&
    dx.operands.length === dy.operands.length &&
    JSON.stringify(dx.attrs) === JSON.stringify(dy.attrs) &&
    dx.operands.every((o, i) => sameValue(o, dy.operands[i], defOf, depth + 1))
  );
}

const widthOf = (op: Op): number =>
  (op.opcode === 'aload' || op.opcode === 'astore' ? op.attrs.elemSize : op.attrs.width) as number;

/** What an address is computed from, through pure arithmetic and the values a block argument is
 *  passed: the symbols (`gaddr`), whether the frame (`laddr`), and whether anything else. */
function addressRoots(
  v: Value,
  defOf: ReadonlyMap<Value, Op>,
  incoming: ReadonlyMap<Value, readonly Value[]>,
): { syms: Set<string>; frame: boolean } {
  const out = { syms: new Set<string>(), frame: false };
  const seen = new Set<Value>();
  const walk = (x: Value): void => {
    if (seen.has(x) || seen.size > 64) {
      return;
    }
    seen.add(x);
    const d = defOf.get(x);
    if (d === undefined) {
      (incoming.get(x) ?? []).forEach(walk);
    } else if (d.opcode === 'gaddr') {
      out.syms.add(String(d.attrs.sym));
    } else if (d.opcode === 'laddr') {
      out.frame = true;
    } else if (PURE_ADDRESS_OPS.has(d.opcode)) {
      d.operands.forEach(walk);
    }
  };
  walk(v);
  return out;
}

/** In a loop that stores, where an access's address moves: the header reads the compiler provably
 *  keeps in the loop, which stay as they were. A read at an invariant address is loop-invariant to
 *  agbcc only when no store in the loop may alias it (loop.c `invariant_p` over `loop_store_mems`,
 *  alias.c `true_dependence`), so a store whose address moves keeps it where their alias sets
 *  conflict — and under `-O2`'s strict aliasing (toplev.c:3616) they conflict, whatever the store's
 *  address, only where one of the two is a byte (c-common.c:1969-1974, the character types' set 0):
 *  `while (*(u8 *)0x4000006 != 160) *p++ = 0;` keeps its read, `while (*(u16 *)0x4000006 != 160)
 *  *p++ = 0;` with `s32 *p` loads it once ahead of the loop, and so does a 2-byte store beside a
 *  4-byte read. Two accesses of one width are no proof: `int`, `long`, a pointer and an enum are
 *  sets of their own. Nor is a store into the frame (alias.c:814-820), nor one a read of a symbol
 *  may be told apart from by its base, another symbol's (alias.c:798-811). A read of a cell the loop
 *  also writes at a fixed address is no `invariant_p` read at all but `load_mems`' (sa3's
 *  `Sio32MultiLoadMain`, `while (counter < n) sum += datap[counter++];`, keeps the struct's
 *  counter by its conflict with the data read), and is left as it was. */
function keptBesideMoving(
  ops: readonly Op[],
  moves: (op: Op) => boolean,
  defOf: ReadonlyMap<Value, Op>,
  incoming: ReadonlyMap<Value, readonly Value[]>,
): (read: Op) => boolean {
  const stores = ops.filter((op) => op.opcode === 'store' || op.opcode === 'astore');
  return (read) => {
    const bytes = widthOf(read);
    const sym = addressRoots(read.operands[0], defOf, incoming).syms;
    return stores.some((st) => {
      if (!moves(st)) {
        const off = (op: Op) => (op.opcode === 'load' || op.opcode === 'store' ? (op.attrs.off as number) : 0);
        return (
          read.opcode === 'load' &&
          st.opcode === 'store' &&
          sameValue(st.operands[0], read.operands[0], defOf) &&
          off(st) < off(read) + bytes &&
          off(read) < off(st) + widthOf(st)
        );
      }
      const roots = addressRoots(st.operands[0], defOf, incoming);
      return (
        (bytes === 1 || widthOf(st) === 1) &&
        !roots.frame &&
        (sym.size === 0 || [...roots.syms].every((s) => sym.has(s)))
      );
    });
  };
}

/** The header's reads a branch that leaves the loop, or goes round it again, decides on: the ops
 *  its condition is computed from, through every op but a read, and the reads where that walk
 *  ends. A read the loop only computes or stores with is none of them. */
function testedReads(loop: NaturalLoop, defOf: ReadonlyMap<Value, Op>): Set<Op> {
  const deciding = new Set([...loop.latches, ...loop.exitEdges.map((e) => e.from)]);
  const out = new Set<Op>();
  const seen = new Set<Value>();
  const walk = (v: Value, depth: number): void => {
    const d = defOf.get(v);
    if (d === undefined || seen.has(v) || depth > 16) {
      return;
    }
    seen.add(v);
    if (d.opcode === 'load' || d.opcode === 'aload') {
      out.add(d);
      return;
    }
    d.operands.forEach((o) => walk(o, depth + 1));
  };
  for (const b of deciding) {
    const t = terminator(b);
    if (t?.opcode === 'cond_br' && loop.body.has(b)) {
      walk(t.operands[0], 0);
    }
  }
  return new Set([...out].filter((op) => loop.header.ops.includes(op)));
}
