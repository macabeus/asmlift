/** THE POLL-READ PIN: a memory read a loop makes each time round, at an address the loop never
 *  changes, in a loop that makes no call, was `volatile` in the source, so it is stamped `volatile`
 *  (the `device` placement, ir/discipline.ts) and the structurer spells it through a qualified
 *  pointer or declines.
 *
 *  The claim is the COMPILER's: at a level that moves loop-invariant code (where target.ts
 *  `keepsLoopInvariantReads` is absent), a plain read at an invariant address in a loop that stores
 *  nothing and calls nothing is invariant, and the compiler loads it once, ahead of the loop.
 *  agbcc's loop pass takes a `MEM` for invariant when it is not volatile and no store in the loop
 *  may alias it (loop.c `invariant_p`, and `load_mems` past it), so `while (*(s32 *)0x4000004 &
 *  3);` becomes `.L3: cmp r0, #0; bne .L3`. COMPILED, the same source on each compiler, the read
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
 *     decides on (`testedReads`): a poll's. Not a read the compiler provably keeps beside an access
 *     whose address moves: under alias sets (target.ts `strictAliasing`, agbcc at `-O2`), the ones
 *     `keptBesideMoving` proves; without them (IDO, KMC, agbcc at `-O1`), every read beside a STORE
 *     whose address moves, while a READ whose address moves keeps none (`while (REG & 3) { B[1] =
 *     a0; s += *q++; }` branches to itself on KMC gcc 2.7.2 and agbcc at `-O1` when REG is plain).
 *     Where every access is at a fixed address, whether a store keeps a plain read in the loop is
 *     the compiler's alias analysis, decided on register history the lift cannot see — agbcc keeps
 *     `while (((volatile s32 *)0x40000d4)[2] & M) ((s32 *)0x40000d4)[5] = a0;`'s read but moves the
 *     plain spelling of it, and IDO 7.1 keeps `while (*(s32 *)A & 3) ((s32 *)B)[1] = a0;`'s read
 *     while moving `while (gF == 0) gW = a0;`'s — so the read is pinned, which is right whichever
 *     the compiler decided, and the store is the poll-store rule's (contracts.ts `sunkPollStore`).
 *     A pinned read the loop's condition renders makes the loop a poll to that rule, which refuses
 *     a plain store no rule proves kept: a counted loop's `u8` bound beside DMA stores (sa3's
 *     `ProcessOamBuffers`) declines though agbcc kept its stores, since a byte read keeps no store
 *     its addresses prove apart from (`for (;;) { DMA[5] = a0; if (++i >= *(volatile u8 *)&gIdx)
 *     break; }` sinks it), and leaving the bound plain lets `do { …; i++; } while (i < gIdx);` load
 *     it once. KNOWN GAP: a header read no exit tests is left as it was, though `scan_loop` moves it
 *     whatever tests it (`do { if (VCOUNT == 3) DMA[6] = a0; } while (DMA[2] & M);` loads VCOUNT
 *     once when plain): pinning it forecloses the base-pointer spelling three matched rows need
 *     (`synthetic:fieldbase`, `dmafield`, `dmaflat`), whose constant-address plain read agbcc
 *     moves. Not on a compiler that keeps the read beside any store (target.ts
 *     `keepsInvariantReadsBesideStores`: mwcc, in every probe);
 *   • the read is in the loop's header, the block every time round starts with, ahead of every
 *     branch the loop takes, or one of the reads past a branch below. A read past a branch is
 *     `maybe_never` to agbcc's loop pass (loop.c, under a label or a conditional jump), which on
 *     Thumb, where any load may trap (rtlanal.c `may_trap_p`), leaves it in the loop, and so do
 *     KMC gcc 2.7.2 and mwcc, COMPILED (`for (i = 0; i < gCount; i++) { if (gTab[i] == x) …; }`,
 *     `synthetic:retpost_tail`, matches with its bound plain). But a rotated poll's read, which is
 *     itself passed as the block argument the loop's test reads, is the read ahead of the loop
 *     again with no store between, which agbcc's `gcse` deletes: `v1 = *(s32 *)0x4000104; while
 *     ((v1 & 3) != 0) { if (v0 + 1 > 99) break; v0++; v1 = *(s32 *)0x4000104; }` reads REG once.
 *     So is a read the loop's exit tests of a cell the loop's entry reads, its guard or the
 *     straight-line blocks between (`sameRead`), whichever block argument it is passed as: agbcc
 *     and KMC gcc 2.7.2 delete it as the entry's read again, COMPILED — `if (REG & 1) v0 = 0; else
 *     { v0 = a0; while (v0 + 3 <= 200) { v0 += 3; if (REG & 1) return v0; } v0 = 1; }` tests a
 *     constant in the loop when REG is plain. Only in a loop that stores nothing, in it or where
 *     its exits go (`storesNearLoop`, a KNOWN GAP beside a store). And on IDO 7.1, which moves a read from past a
 *     branch (target.ts `movesReadsPastBranches`: `do { … } while ((*(vu32 *)A & 3) || (*(u32 *)B
 *     & 1));` loads B once ahead of the loop when B is plain), every read the loop's exit tests;
 *   • its address is invariant: every value it is computed from is a constant, a symbol's address,
 *     or a value defined outside the loop, through pure arithmetic — no read, no block argument of
 *     a loop block;
 *   • it is no read of the function's own frame (`laddr`): the frame audit owns the qualifier of a
 *     frame object (frontend/frame-objects.ts);
 *   • the compiler could have made it of a `volatile` (target.ts `readCouldBeVolatile`): a
 *     sign-extending narrow load on agbcc is a plain read's, and stays plain.
 *  The guard a rotated `while` duplicates its test into ahead of the loop reads the same cell, and
 *  is pinned with it (`sameRead`): it is the source's one condition, and only two reads alike let
 *  the structurer fuse the guard back into the loop: without it, `synthetic:onepoll`'s `/volatile`
 *  pointer spelling loses its `while`.
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
    // a loop left for several places included: `while (VCOUNT != 160) { if (DISPSTAT & 1) return
    // 1; }` loads DISPSTAT once, ahead of the loop, when it is plain
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
      if (d === undefined) {
        // a loop block's argument, passed one constant on every edge: a constant address the
        // register allocator re-materialised (`v0 = 0xA0000000` ahead of the loop and in it)
        const from = incoming.get(v) ?? [];
        return (
          depth < 16 && from.length > 0 && from.every((o) => sameValue(o, from[0], defOf) && invariant(o, depth + 1))
        );
      }
      return depth < 16 && PURE_ADDRESS_OPS.has(d.opcode) && d.operands.every((o) => invariant(o, depth + 1));
    };
    const moves = (op: Op): boolean =>
      MEM_BASE_OPS.has(op.opcode) &&
      !op.operands.slice(0, op.opcode === 'aload' || op.opcode === 'astore' ? 2 : 1).every((o) => invariant(o));
    // The reads a moving access keeps in the loop stay as they were (the module comment's second
    // bound): under alias sets, those `keptBesideMoving` proves; without them, every read beside a
    // STORE whose address moves.
    const kept = !stores
      ? undefined
      : target.compilerBehaviors.strictAliasing === true
        ? keptBesideMoving(ops, moves, defOf, incoming)
        : ops.some((op) => (op.opcode === 'store' || op.opcode === 'astore') && moves(op))
          ? () => true
          : undefined;
    const decided = testedReads(loop, defOf, defBlock, incoming);
    const tested = stores ? decided.tested : undefined;
    const fromFrame = (v: Value, depth = 0): boolean => {
      const d = defOf.get(v);
      return (
        d !== undefined &&
        depth < 16 &&
        (d.opcode === 'laddr' ||
          ((d.opcode === 'add' || d.opcode === 'sub') && d.operands.some((o) => fromFrame(o, depth + 1))))
      );
    };
    // The blocks ahead of the loop its entry runs: its guard and the straight-line blocks between
    // (a preheader), as the guard twin below walks them.
    const entry: Block[] = [];
    for (let guard of loop.forwardPreds) {
      entry.push(guard);
      for (let n = 0; terminator(guard)?.opcode === 'br' && (preds.get(guard) ?? []).length === 1 && n < 8; n++) {
        guard = (preds.get(guard) ?? [])[0];
        entry.push(guard);
      }
    }
    const entryReads = entry
      .filter((b) => !loop.body.has(b))
      .flatMap((b) => b.ops)
      .filter((op) => op.opcode === 'load' || op.opcode === 'aload');
    // and, past one of the loop's branches, a rotated poll's read, a tested read of a cell the
    // loop's entry reads, and on a compiler that moves one from there every read the loop's exit
    // tests
    const past =
      target.compilerBehaviors.movesReadsPastBranches === true
        ? decided.tested
        : [
            ...decided.rotated,
            ...(storesNearLoop(loop)
              ? []
              : [...decided.tested].filter((op) => entryReads.some((e) => sameRead(op, e, defOf, true)))),
          ];
    const candidates = [...new Set([...loop.header.ops, ...past])];
    const pinned: Op[] = [];
    for (const op of candidates) {
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
    // The read a rotated poll's entry makes ahead of the loop, which its test reads the first time
    // round, is the same cell's (`v0 = REG; while (v0 & M) v0 = REG;`): pinned with it, as the
    // source's one read.
    for (const p of loop.header.params) {
      for (const a of incoming.get(p) ?? []) {
        const d = defOf.get(a);
        const at = defBlock.get(a);
        if (
          d !== undefined &&
          at !== undefined &&
          !loop.body.has(at) &&
          (d.opcode === 'load' || d.opcode === 'aload') &&
          d.attrs.volatile !== true &&
          pinned.some((x) => sameRead(x, d, defOf))
        ) {
          d.attrs = { ...d.attrs, volatile: true };
        }
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
 *  value or one constant computed alike. `a` is the pinned one, or with `either` either may be
 *  plain. */
function sameRead(a: Op, b: Op, defOf: ReadonlyMap<Value, Op>, either = false): boolean {
  return (
    a.opcode === b.opcode &&
    JSON.stringify(either ? { ...a.attrs, volatile: true } : a.attrs) ===
      JSON.stringify({ ...b.attrs, volatile: true }) &&
    a.operands.length === b.operands.length &&
    a.operands.every((o, i) => sameValue(o, b.operands[i], defOf))
  );
}

/** Are two values one value, or one constant computed alike: through any pure op, `or` among them,
 *  since a MIPS compiler builds a constant address with `lui`/`ori`. */
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
    PURE_ADDRESS_OPS.has(dx.opcode) &&
    dx.operands.length === dy.operands.length &&
    JSON.stringify(dx.attrs) === JSON.stringify(dy.attrs) &&
    dx.operands.every((o, i) => sameValue(o, dy.operands[i], defOf, depth + 1))
  );
}

const widthOf = (op: Op): number =>
  (op.opcode === 'aload' || op.opcode === 'astore' ? op.attrs.elemSize : op.attrs.width) as number;

/** What an address is computed from, through pure arithmetic and the values a block argument is
 *  passed: the symbols (`gaddr`), whether the frame (`laddr`), and whether anything but those and
 *  constants (`other`: a parameter, a read). */
function addressRoots(
  v: Value,
  defOf: ReadonlyMap<Value, Op>,
  incoming: ReadonlyMap<Value, readonly Value[]>,
): { syms: Set<string>; frame: boolean; other: boolean } {
  const out = { syms: new Set<string>(), frame: false, other: false };
  const seen = new Set<Value>();
  const walk = (x: Value): void => {
    if (seen.has(x) || seen.size > 64) {
      return;
    }
    seen.add(x);
    const d = defOf.get(x);
    const from = incoming.get(x);
    if (d === undefined && from !== undefined) {
      from.forEach(walk);
    } else if (d?.opcode === 'gaddr') {
      out.syms.add(String(d.attrs.sym));
    } else if (d?.opcode === 'laddr') {
      out.frame = true;
    } else if (d !== undefined && PURE_ADDRESS_OPS.has(d.opcode)) {
      d.operands.forEach(walk);
    } else if (d?.opcode !== 'const') {
      out.other = true; // a parameter, a read, a call's result
    }
  };
  walk(v);
  return out;
}

/** In a loop that stores, on a compiler with alias sets (target.ts `strictAliasing`): the header
 *  reads the compiler provably keeps in the loop, which stay as they were. Each proof is an access
 *  whose address MOVES and whose alias set conflicts with the read's cell — under `-O2`'s strict
 *  aliasing (toplev.c:3616), whatever the two addresses, only where one of the two is a byte
 *  (c-common.c:1969-1974, the character types' set 0). Two accesses of one width are no proof:
 *  `int`, `long`, a pointer and an enum are sets of their own. Nor is an access of the frame
 *  (alias.c:814-820). And only a read at a constant address: one through a symbol or a parameter is
 *  told apart from the access by base and register history (alias.c `base_alias_check`,
 *  `canon_rtx`), COMPILED — `do { p[1] = 0; p[0] = 31; p += 40; } while (++i < *(u8 *)&gA);` with
 *  `u8 *p` a parameter, and `while (q[3] != 160) *p++ = 0;`, load the byte once ahead of the loop,
 *  while the same loops reading `*(u8 *)0x30040C0` keep it. Such an access keeps the read:
 *   • where it is a store: the read is no loop invariant (loop.c `invariant_p` over
 *     `loop_store_mems`, alias.c `true_dependence`) — `while (*(u8 *)0x4000006 != 160) *p++ = 0;`
 *     keeps its read, `while (*(u16 *)0x4000006 != 160) *p++ = 0;` with `s32 *p` loads it once
 *     ahead of the loop, and so does a 2-byte store beside a 4-byte read;
 *   • where the loop also writes the read's cell at a fixed address: `load_mems` keeps a written
 *     cell another access conflicts with (loop.c:8958-8976), and otherwise moves the read and the
 *     write together — `while (*(u16 *)0x3000100 != 50) { *(u16 *)0x3000100 = 7; *q++ = 0; }`
 *     with `s32 *q` loads and stores the cell once and branches to itself, while a `u8` cell keeps
 *     both. A cell no rule keeps is pinned, and the poll-store rule judges its write
 *     (contracts.ts `sunkPollStore`): sa3's `Sio32MultiLoadMain`, whose `s32` counter the loop
 *     writes beside its `s32` data read, keeps it by the `int` set the two share, which the lift
 *     cannot see, and declines. */
function keptBesideMoving(
  ops: readonly Op[],
  moves: (op: Op) => boolean,
  defOf: ReadonlyMap<Value, Op>,
  incoming: ReadonlyMap<Value, readonly Value[]>,
): (read: Op) => boolean {
  const stores = ops.filter((op) => op.opcode === 'store' || op.opcode === 'astore');
  const off = (op: Op) => (op.opcode === 'load' || op.opcode === 'store' ? (op.attrs.off as number) : 0);
  return (read) => {
    const bytes = widthOf(read);
    const at = addressRoots(read.operands[0], defOf, incoming);
    if (at.syms.size > 0 || at.frame || at.other || read.opcode !== 'load') {
      return false; // no constant address
    }
    const conflicts = (m: Op): boolean =>
      m !== read &&
      MEM_BASE_OPS.has(m.opcode) &&
      moves(m) &&
      (bytes === 1 || widthOf(m) === 1) &&
      !addressRoots(m.operands[0], defOf, incoming).frame;
    const written = stores.some(
      (st) =>
        st.opcode === 'store' &&
        !moves(st) &&
        sameValue(st.operands[0], read.operands[0], defOf) &&
        off(st) < off(read) + bytes &&
        off(read) < off(st) + widthOf(st),
    );
    return (written ? ops : stores).some(conflicts);
  };
}

/** Does the loop, or a block one of its exits goes to, store? Where it does, a tested read past
 *  a branch of a cell the loop's entry reads is left as it was: a KNOWN GAP, not a proof the
 *  compiler keeps it. agbcc's and KMC gcc 2.7.2's `cse` take that read for the entry's again
 *  along the path through the loop, and whether a store on the way stops it is decided by the
 *  shape of that path, COMPILED with the read plain: `for (i = 0; i < gCount; i++) { if (gTab[i]
 *  == x) { *out = r; return; } } gMiss = 1; *out = r;` keeps its `u8` bound in the loop
 *  (`synthetic:retpost_tail`, which matches with it plain and loses the match on agbcc, KMC and
 *  gcc 2.7.2 when it is pinned), while `for (i = 0; i < REG; i++) { if (i * 3 == x) { *out = 1;
 *  return 5; } } return 2;` with an `s32` REG, and `if (REG & 1) return 0; do { s += 3; if (s >
 *  200) { *p = s; return 1; } } while (!(REG & 1));`, do not, with a byte store or a word one. */
function storesNearLoop(loop: NaturalLoop): boolean {
  return [...loop.body, ...loop.exitEdges.map((e) => e.to)]
    .flatMap((b) => b.ops)
    .some((op) => op.opcode === 'store' || op.opcode === 'astore');
}

/** The loop's reads a branch that leaves the loop, or goes round it again, decides on: the ops
 *  its condition is computed from, through every op but a read and through the values a block
 *  argument is passed, and the reads where that walk ends, in the loop's own blocks. A read the
 *  loop only computes or stores with is none of them. */
function testedReads(
  loop: NaturalLoop,
  defOf: ReadonlyMap<Value, Op>,
  defBlock: ReadonlyMap<Value, Block>,
  incoming: ReadonlyMap<Value, readonly Value[]>,
): { tested: Set<Op>; rotated: Set<Op> } {
  // A branch to a block that only goes on to the header goes round again too: a MIPS
  // branch-likely's delay slot is such a block on the taken edge.
  const roundAgain = (b: Block): boolean => {
    for (let n = 0; n < 4; n++) {
      if (b === loop.header) {
        return true;
      }
      const t = terminator(b);
      if (!loop.body.has(b) || t?.opcode !== 'br') {
        return false;
      }
      b = t.successors[0].block;
    }
    return false;
  };
  const deciding = new Set([
    ...loop.latches,
    ...loop.exitEdges.map((e) => e.from),
    ...[...loop.body].filter((b) => (terminator(b)?.successors ?? []).some((e) => roundAgain(e.block))),
  ]);
  const out = new Set<Op>();
  const rotated = new Set<Op>();
  const seen = new Set<Value>();
  const walk = (v: Value, depth: number, viaArg: boolean): void => {
    if (seen.has(v) || depth > 16) {
      return;
    }
    seen.add(v);
    const d = defOf.get(v);
    if (d === undefined) {
      // a block argument: the values it is passed, and a read passed as one is a rotated poll's
      (incoming.get(v) ?? []).forEach((o) => {
        const od = defOf.get(o);
        walk(o, depth + 1, od?.opcode === 'load' || od?.opcode === 'aload');
      });
      return;
    }
    if (d.opcode === 'load' || d.opcode === 'aload') {
      out.add(d);
      if (viaArg) {
        rotated.add(d);
      }
      return;
    }
    d.operands.forEach((o) => walk(o, depth + 1, viaArg));
  };
  for (const b of deciding) {
    const t = terminator(b);
    if (t?.opcode === 'cond_br' && loop.body.has(b)) {
      walk(t.operands[0], 0, false);
    }
  }
  const inLoop = (op: Op) => op.results.some((r) => loop.body.has(defBlock.get(r) as Block));
  return { tested: new Set([...out].filter(inLoop)), rotated: new Set([...rotated].filter(inLoop)) };
}
