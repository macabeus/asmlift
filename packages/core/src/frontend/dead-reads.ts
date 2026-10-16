/** THE DEAD-READ PIN: a memory read the lifted function never uses was `volatile` in the source, so
 *  it is stamped `volatile` (the `device` placement, ir/discipline.ts) before anything can delete
 *  it, and the structurer spells it through a qualified pointer or declines.
 *
 *  The claim is the COMPILER's, and it is the one ir/discipline.ts `spelledWhenDead` already rests
 *  on: an optimizing compiler's dead-code pass deletes every plain read whose value nothing uses.
 *  A pass that runs after it can still leave one behind — a split, a merge, a spill — and the gates
 *  below name each one found. agbcc expands an expression statement with no target (stmt.c
 *  `expand_expr_stmt`) and its flow pass keeps an insn whose result is dead only when
 *  `volatile_refs_p` says it touches a `MEM_VOLATILE_P` cell
 *  (flow.c:1296, rtlanal.c:1628); measured, agbcc at -O2 and -O0, ido 7.1, gcc 2.7.2 (KMC) and
 *  mwcc 2.4.2 each emit no read for `gR; *p; *(int *)0x4000004;` and keep every one of them
 *  qualified. So a read still in the target whose result is overwritten or never consumed is the
 *  `dmaRegs[2];` that ends a DMA macro, a `REG_KEYINPUT;` acknowledge, an `extern volatile` poll
 *  read once for its side effect — whatever the address, symbol or literal or a pointer parameter.
 *  Left plain, the lift's own dead-code pass (pattern/engine.ts `dce`) drops it, and the recompile
 *  loses an access the machine made. This pin is the ONE place that claim is decided: the structurer
 *  spells a read nothing uses only when it is qualified (structure.ts `volatileQualifiable`).
 *
 *  DEAD means what that pass would delete (ir/discipline.ts `deadOps`, the one definition): a
 *  `load`/`aload` whose result reaches no op the pass keeps, through any chain of ops it would delete
 *  with it — an extension of the read nothing reads is as dead as the read. It is decided on the RAW
 *  lift, after the frontend's SSA is final and before any raise rewrite, so a read only asmlift's
 *  own folds orphan is never counted — save one the frontend orphans itself by dropping a spill
 *  nothing reloads, which `spilled` refuses. One use the pass counts is not one here: the operand of the
 *  `ret` of a function its OWN declaration says is void, which the structurer suppresses — the
 *  read-back that ends `void f(int b) { REG = b; REG; }` is in the return register at `bx lr`.
 *
 *  THE READS ARE DECIDED OUTERMOST FIRST. A dead read whose value, through dead ops, is the address
 *  of another dead read waits until that one is decided: kept, it is a use, and the inner read is
 *  live — `*(volatile int *)*pp;` qualifies the read of `*pp`'s target, not the read of `pp`.
 *
 *  The reads the rule must not claim are tabled (`DEAD_READ_GATES`) and REPORTED: a caller may hand
 *  its own table (`tallying`, l3/gates.ts) to census the refusals.
 *   • a read of a function built at a level where the compiler keeps a plain read nothing uses
 *     (target.ts `keepsUnusedReadsAt`), save one the machine loaded into the register that compiler
 *     discards a volatile read into (`discarded`, target.ts `discardsUnusedReadsInto`): mwcc at
 *     `-O0` keeps `x = p[5]; x = 0;`'s load in r31 and IDO at `-O1` in t6, so a read in a home says
 *     nothing about `volatile`, where `*p;` through a volatile pointer is `lwz r0` and `lw zero` —
 *     and a level no flag names, or one a word the flag table cannot read may set (mwcc
 *     `-opt off`), is judged as keeping;
 *   • a read of a global the project declares with no volatile byte where it reads (`declared-plain`:
 *     the symbol map where it lays the object out, else the declaration context): the source spelled
 *     the read plain, so the compiler kept it for some other reason — agbcc merges the identical
 *     arms of `if (g.c) x = 0x800; else x = 0x800;` (kleod's `sub_08042024`) after flow has decided
 *     which insns are dead, and the read the deleted branch tested survives, plain;
 *   • a read of the function's own frame object (`laddr`): a local nothing outside the function
 *     observes, whose dead read is a reload, not an access to keep;
 *   • any read of a function that holds an unmodelled instruction (`opaque`, frontend/opaque.ts):
 *     the lift does not know what that instruction reads, so it cannot call a value unused —
 *     mwcc's `lbz r0, 76(r3)` + `rlwimi r0, r4, 7, 24, 24` + `stb` reads the byte it inserts into,
 *     and the opaque standing for the `rlwimi` does not name it;
 *   • a read still held, at a return whose width the lift guessed, in the register that carries
 *     the second word of a two-word return (`unreadPairHalf`): asmlift returns one word where no
 *     declaration pins the width, so a value in the pair's second register is unused by the LIFT,
 *     not by the source — agbcc's leaf `long long k(long long *p) { return *p; }` is
 *     `ldr r1, [r0, #4]; ldr r0, [r0]; bx lr`, and stamping the r1 load would publish a one-word
 *     return that drops the high half beside an invented volatile read of RAM, byte-exact;
 *   • a read still held in an argument register at a call whose arity no declaration states
 *     (call-plan.ts `heldAtUndeclaredCall`): the guess passes what it counts, so a value it leaves
 *     out is unused by the lift, not by the source — agbcc's `g(a, c ? p[1] : p[2])` leaves r0 at
 *     its incoming value, the guess passes nothing, and stamping the r1 loads publishes `g();` beside
 *     two invented volatile reads;
 *   • a read a compare consumed (`compared`, gathered by each frontend that fuses a compare into the
 *     branch that reads it): a compare no branch reads leaves no op, so the read looks dead only
 *     because the lift has no op for its consumer — mwcc 2.3.3 at `-O4,s` keeps
 *     `lwz r0, g; cmpwi r0, 0` for `if (g) { (g != 0); }`;
 *   • a read whose value was stored to the function's own stack (`spilled`, ssa.ts `frameWrites`):
 *     each frontend keeps a stack slot as a variable and drops a store nothing reloads, so a read
 *     only that store consumed looks dead because the lift dropped its consumer — KMC's `struct S
 *     s = *p; return s.a;` stores both words to the frame, IDO a `long long` it truncates;
 *   • a read the machine computed with (`computed`): an op other than an extension consumes the
 *     value, or an extension of it — an op dead in the lift too, but one the compiler emitted, so it
 *     did not judge the value unused there. KMC splits a `long long` sum after flow, and keeps the
 *     high word's `addu` of `v += 3; return (int)v;`. A read that is the address of a read the pin
 *     left plain is that read's use, on the same ground;
 *   • a read the compiler could not have made of a `volatile` (target.ts `readCouldBeVolatile`): on
 *     a compiler that extends a qualified narrow read in a register, a sign-extending load is a
 *     plain read in the source, the same rule frontend/device-pins.ts applies to a device read.
 *  RESIDUE, untabled: reads stamped with a `volatile` the source did not write. The first three
 *  recompile byte-exact and compute the same values; the last two inherit a wrong input.
 *   • a bare read an inline `asm("" :: "r"(x))` took whole. agbcc leaves the statement as a bare
 *     `.code 16` the Thumb frontend skips, so the read it keeps alive looks dead; where the asm took
 *     an extraction (sa3's `Task_150_80A619C` reads `gPlayers[0].charFlags.character` with
 *     `lsl`/`lsr` first), `computed` leaves it plain;
 *   • the unused half of a DImode move under a declaration that pins a one-word return. agbcc splits
 *     the move into two word loads AFTER flow has deleted dead insns
 *     (`thumb_load_double_from_address`), so `int f(long long *p) { long long v = *p; return
 *     (int)v; }` keeps `ldr r1, [r0, #4]`. With no such declaration the pair gate refuses it on Thumb
 *     and PowerPC; O32 declines the v0:v1 pair before the pin is asked;
 *   • merged identical arms where no declaration is in evidence: the same instructions as `gR;` on an
 *     object nothing declares, and as `*p;` through a pointer parameter;
 *   • a read returned by a getter wrongly declared void: the declaration is trusted, as the pair
 *     gate trusts a declared width;
 *   • hand-written assembly, which is outside the compiler claim: klonoa's m4a `sub_0804FE6C` returns
 *     a byte in r3, which no ABI the lift models reads, so the lift's return model has already lost
 *     that byte and its read is stamped. */
import { globalBaseOf, globalCellOf } from '../ir/alias';
import type { Block, Op, Value } from '../ir/core';
import { deadOps } from '../ir/discipline';
import { type Gate, firstRejection } from '../l3/gates';
import { type FnProto, declaresVoidReturn, ownReturnWidth } from '../proto';
import type { ContextGlobals } from '../proto-context';
import { type SymbolInfo, type SymbolMap, declaresVolatile, symbolsByName } from '../symbols';
import { type TargetDescription, readCouldBeVolatile } from '../target';
import type { SsaBuilder } from './ssa';

/** What a dead-read gate judges: the read, and the facts about it the gates read. */
export interface DeadRead {
  readonly op: Op;
  /** its address is this function's own frame object, an offset of a `laddr` */
  readonly fromFrame: boolean;
  /** the function holds an instruction the lift could not model (an `opaque`) */
  readonly unmodelled: boolean;
  /** its value, or a value only it feeds, is still in the return pair's second register at a return
   *  whose width the lift guessed (`unreadPairHalf`) */
  readonly heldAtWordReturn: boolean;
  /** its value, or a value only it feeds, is still in an argument register at a call whose arity no
   *  declaration states (call-plan.ts `heldAtUndeclaredCall`) */
  readonly heldAtUndeclaredCall: boolean;
  /** its value, or a value only it feeds, is an operand of a compare (`DeadReadFacts.compared`) */
  readonly compared: boolean;
  /** its value, or a value only it feeds, was stored to the function's own stack
   *  (`DeadReadFacts.spilled`) */
  readonly spilled: boolean;
  /** its value, or an extension of it, is an operand of an op that is no extension (`computedWith`):
   *  arithmetic the machine emitted, or the address of a read the pin left plain */
  readonly computed: boolean;
  /** its address reaches one global, declared with no volatile byte where it reads (`declaredPlain`) */
  readonly declaredPlain: boolean;
  /** the machine loaded it into the register the compiler discards an unused read into
   *  (`DeadReadFacts.discarded`, target.ts `discardsUnusedReadsInto`) */
  readonly discarded: boolean;
  readonly target: TargetDescription;
}

export const DEAD_READ_GATES: readonly Gate<DeadRead>[] = [
  {
    id: 'keeps-unused-reads',
    why: 'at these flags the compiler keeps a plain read nothing uses, and this one is not in the register it discards a volatile read into',
    sound: false,
    guardedBy: 'dead-reads.test.ts: keeps-unused-reads: mwcc -O0 keeps a dead assignment plain',
    rejects: (c) => c.target.compilerBehaviors.keepsUnusedReads === true && !c.discarded,
  },
  {
    id: 'declared-plain',
    why: 'the declaration of the object read has no volatile byte there, so the source spelled the read plain',
    sound: false,
    guardedBy: 'dead-reads.test.ts: declared-plain: a dead read of a global declared plain stays deletable',
    rejects: (c) => c.declaredPlain,
  },
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
    id: 'held-at-word-return',
    why: 'the value may be the second word of a two-word return the lift lowered as one word',
    sound: false,
    guardedBy: 'dead-reads.test.ts: held-at-word-return: a leaf 64-bit return from memory keeps no volatile high word',
    rejects: (c) => c.heldAtWordReturn,
  },
  {
    id: 'held-at-undeclared-call',
    why: 'the value may be an argument a guessed arity left out of the call',
    sound: false,
    guardedBy: 'dead-reads.test.ts: held-at-undeclared-call: a read the guessed arity leaves out stays plain',
    rejects: (c) => c.heldAtUndeclaredCall,
  },
  {
    id: 'compared',
    why: 'a compare consumed the value; the lift has no op for a compare no branch reads',
    sound: false,
    guardedBy: 'dead-reads.test.ts: compared: a read only a dead compare consumes stays plain',
    rejects: (c) => c.compared,
  },
  {
    id: 'spilled',
    why: 'the machine stored the value to its stack; the lift keeps the slot as a variable and drops a store nothing reloads',
    sound: false,
    guardedBy: 'dead-reads.test.ts: spilled: a read whose value was stored to the frame stays plain',
    rejects: (c) => c.spilled,
  },
  {
    id: 'computed',
    why: 'the machine computed with the value, so the compiler did not judge it unused where it emitted that op',
    sound: false,
    guardedBy: 'dead-reads.test.ts: computed: a read a dead add consumes stays plain',
    rejects: (c) => c.computed,
  },
  {
    id: 'not-a-volatile-read',
    why: 'a read that extends in a way the compiler never extends a volatile one was plain in the source',
    sound: false,
    guardedBy: 'dead-reads.test.ts: not-a-volatile-read: a dead sign-extending narrow read stays plain on agbcc',
    rejects: (c) => !readCouldBeVolatile(c.target.compilerBehaviors, c.op),
  },
];

/** What a frontend knows about its lift that the IR does not carry, for `pinDeadReads`. */
export interface DeadReadFacts {
  /** the function's own declaration: a declared void return's `ret` operand is no use */
  readonly own?: FnProto;
  /** what the return pair's second register may hold at a guessed word return (`unreadPairHalf`) */
  readonly atWordReturn?: ReadonlySet<Value>;
  /** what an argument register may hold at a call of undeclared arity (call-plan.ts) */
  readonly atUndeclaredCall?: ReadonlySet<Value>;
  /** every value a compare consumed, where a compare leaves no op of its own: Thumb's `cmp` and
   *  PowerPC's `cmpw`/`cmpwi`/`cmplw`/`cmplwi` and record forms fuse into the branch that reads
   *  them, and one no branch reads is gone */
  readonly compared?: ReadonlySet<Value>;
  /** every value the machine stored to its own stack, which the lift keeps as a slot variable
   *  (ssa.ts `frameWrites`) */
  readonly spilled?: ReadonlySet<Value>;
  /** every value a load put in the register the compiler discards an unused read into
   *  (target.ts `discardsUnusedReadsInto`): mwcc's `lwz r0`, IDO's `lw zero` */
  readonly discarded?: ReadonlySet<Value>;
  /** where a read's object is declared: the project's symbol map and the declaration context */
  readonly declarations?: Declarations;
}

/** The declarations `declared-plain` reads. */
export interface Declarations {
  readonly symbols?: SymbolMap;
  readonly context?: ContextGlobals;
}

/** IS THE GLOBAL `sym` DECLARED WITH NO VOLATILE BYTE AT `byte`? (`declared-plain`) `null` is an
 *  access that names no byte, which is plain only where no byte of the object is qualified. The map
 *  answers before the context where it lays the object out, as raise/declared-volatile.ts reads them;
 *  a struct the map names with no layout, and an object neither declares, answer no — nothing is in
 *  evidence. So does an array whose element the map does not name a base type (no `elemSigned`):
 *  the map carries the qualifiers of the array's element chain and no element layout, so klonoa's
 *  `struct EntityAnimationInfo gEntityAnimationInfo[]`, whose `frame` member is `volatile u8`,
 *  reads as an array with no volatile byte. A struct member that nests a struct holding a volatile
 *  field is still judged by the member's own qualifier: the map's member facts do not tell it from
 *  an enum, and calling every enum member unknown would stamp the merged-arm reads this gate
 *  refuses. */
export function declaredPlain(
  sym: string,
  byte: number | null,
  info: SymbolInfo | undefined,
  context: ContextGlobals | undefined,
): boolean {
  const layout = Array.isArray(info?.layout) ? info.layout : [];
  if (layout.length > 0) {
    return byte === null
      ? info?.volatile !== true && !layout.some((f) => f.volatile === true)
      : !declaresVolatile(info, byte);
  }
  if (context?.volatiles.has(sym) === true) {
    return false;
  }
  if (info?.declared === true && info.shape !== undefined && info.shape !== 'struct') {
    if (info.shape === 'array' && typeof info.elemSigned !== 'boolean') {
      return info.volatile !== true && context?.declared.has(sym) === true;
    }
    return info.volatile !== true;
  }
  return context?.declared.has(sym) === true;
}

/** THE RETURN PAIR'S SECOND REGISTER AT A WORD RETURN, gathered by a frontend as it emits a `ret`
 *  of one word (`held-at-word-return`): every value `pairReg` may hold at the end of block `bi`,
 *  added to `into` — asked through `holdsValue`, which reads no register (a read of one some path
 *  leaves undefined would mint a parameter) and ends a path where a call destroyed it.
 *
 *  Nothing is gathered where the function's own declaration pins the return: a void one, or a
 *  scalar whose width it states. A declared one-word return leaves the pair's second register
 *  unused by the source too, and a declared wider one is refused after the lift (pipeline.ts
 *  `refuseNarrowReturnsOfWideDeclaration`). */
export function unreadPairHalf(
  ssa: Pick<SsaBuilder, 'holdsValue'>,
  own: FnProto | undefined,
  pairReg: string,
  bi: number,
  into: Set<Value>,
): void {
  if (declaresVoidReturn(own) || ownReturnWidth(own) !== undefined) {
    return;
  }
  ssa.holdsValue(pairReg, bi, (v) => {
    into.add(v);
    return false; // keep walking: every path's value, not the first
  });
}

/** Stamp `volatile` on every read these blocks never use that no gate refuses, outermost first.
 *  `facts` is what the frontend gathered while it filled the blocks.
 *
 *  CALLED BY EACH FRONTEND, at the end of its lift, and not once in pipeline.ts `liftStamped`: the
 *  pair, call and compare gates need what a return, a call or a compare left in a register no op
 *  reads, which only the frontend's SSA builder answers, and only while it is filling the blocks.
 *  The IR it hands back has no register left to ask. */
export function pinDeadReads(
  irBlocks: readonly Block[],
  target: TargetDescription,
  facts: DeadReadFacts = {},
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
  let byName: Map<string, SymbolInfo> | undefined;
  const plainGlobal = (op: Op): boolean => {
    const sym = globalBaseOf(defOf, op.operands[0]);
    if (sym === null) {
      return false;
    }
    const symbols = facts.declarations?.symbols;
    byName ??= symbols === undefined ? new Map() : symbolsByName(symbols);
    const cell = op.opcode === 'load' ? globalCellOf(defOf, op.operands[0], op.attrs.off as number) : null;
    return declaredPlain(sym, cell?.byte ?? null, byName.get(sym), facts.declarations?.context);
  };
  const voidReturn = declaresVoidReturn(facts.own);
  const usesOperands = (op: Op): boolean => !(voidReturn && op.opcode === 'ret');
  const isRead = (op: Op): boolean => op.opcode === 'load' || op.opcode === 'aload';
  const decided = new Set<Op>();
  for (;;) {
    const dead = deadOps(irBlocks, usesOperands);
    // The dead ops whose value reaches one of `values`, through the dead ops it feeds: an extension
    // of the read a register holds is the read held.
    const reaching = (values: ReadonlySet<Value> | undefined): Set<Op> => {
      const out = new Set<Op>();
      const walk = (v: Value): void => {
        const d = defOf.get(v);
        if (d !== undefined && dead.has(d) && !out.has(d)) {
          out.add(d);
          d.operands.forEach(walk);
        }
      };
      values?.forEach(walk);
      return out;
    };
    const open = [...dead].filter((op) => isRead(op) && !decided.has(op));
    // A read that, through dead ops, computes another open read's address waits for it.
    const feeds = new Set<Op>();
    const feed = (v: Value): void => {
      const d = defOf.get(v);
      if (d !== undefined && dead.has(d) && !feeds.has(d)) {
        feeds.add(d);
        if (!isRead(d)) {
          d.operands.forEach(feed);
        }
      }
    };
    open.forEach((r) => r.operands.forEach(feed));
    const ready = open.filter((r) => !feeds.has(r));
    if (ready.length === 0) {
      return; // nothing open, or (never in SSA) only reads that wait on each other
    }
    const held = reaching(facts.atWordReturn);
    const atCall = reaching(facts.atUndeclaredCall);
    const compared = reaching(facts.compared);
    const spilled = reaching(facts.spilled);
    const discarded = reaching(facts.discarded);
    // Who consumes a value among the dead ops: an extension passes the read on, any other op the
    // machine computed with it. A read among them was decided before this one (outermost first)
    // and left plain, so the address it took was the compiler's use.
    const usersOf = new Map<Value, Op[]>();
    for (const d of dead) {
      for (const o of d.operands) {
        usersOf.set(o, [...(usersOf.get(o) ?? []), d]);
      }
    }
    const computedWith = (v: Value, depth = 0): boolean =>
      (usersOf.get(v) ?? []).some((u) =>
        (u.opcode === 'zext' || u.opcode === 'sext') && depth < 8 ? computedWith(u.results[0], depth + 1) : true,
      );
    for (const op of ready) {
      decided.add(op);
      const read: DeadRead = {
        op,
        fromFrame: fromFrame(op.operands[0]),
        unmodelled,
        heldAtWordReturn: held.has(op),
        heldAtUndeclaredCall: atCall.has(op),
        compared: compared.has(op),
        spilled: spilled.has(op),
        computed: computedWith(op.results[0]),
        declaredPlain: plainGlobal(op),
        discarded: discarded.has(op),
        target,
      };
      if (firstRejection(gates, read) === null) {
        op.attrs = { ...op.attrs, volatile: true };
      }
    }
  }
}
