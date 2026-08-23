// asmlift — ISA-neutral on-the-fly SSA construction (Braun et al. 2013, "Simple and
// Efficient Construction of SSA Form"), shared by every frontend. The frontend supplies the
// CFG (predecessors per block) and, per block, emits ops through `readVar`/`writeVar`; this
// module materialises block-argument phis at joins and back-edges.
//
// `preds` is an EDGE list, not a block list: it carries one entry per CFG edge, so a `switch_br`
// with several case values reaching one block appears there several times. Both readings are
// needed and they are not interchangeable — phi wiring wants the distinct predecessor BLOCKS (one
// value each), while the args it appends belong to the EDGES (every one of them). `distinctPreds`
// names the first; `appendSuccessorArg` walks the second. (ir/core.ts `predecessors` and
// structure.ts `predecessorBlocks` have the same duality, and structure.ts already dedups ad hoc
// at its two join sites.)
//
// Protocol: create the builder, then fill blocks in index order. For each block, emit its
// computation via read/writeVar, push its terminator op last (successors referencing
// `irBlocks`, args left empty — phi wiring appends them), then call `markFilled(b)`. When all
// blocks are filled, call `finish()` to remove trivial phis.
import { Block, Fn, Op, Value, mkOp, mkValue } from '../ir/core';
import { pruneDeadParams, simplifyTrivialPhis } from '../ir/simplify';
import { T } from '../ir/types';
import { FrontendUnsupportedError } from './errors';

export interface SsaBuilder {
  fn: Fn;
  irBlocks: Block[];
  /** Current SSA value of `reg` on entry to block `b` (creating phis/params as needed). */
  readVar(reg: string, b: number): Value;
  /** Record that `reg` now holds `v` within block `b`. */
  writeVar(reg: string, b: number, v: Value): void;
  /** Mark block `b` fully emitted (terminator pushed); seals any now-ready successors. */
  markFilled(b: number): void;
  /** Live-in parameter value → the key it arrived on (for calling-convention order). Usually an
   *  ABI register name, but a frontend's virtual key (see the module header) ranks here too. */
  paramReg: Map<Value, string>;
  /** Assert that block `b` takes a parameter for `key`, whether or not anything reads it.
   *
   *  `readVar` cannot express this. It asks "what value does `key` hold here?", so a key the block
   *  DEFINES before any read answers with that local definition and no parameter is created — to it
   *  "never read" and "written before first read" are the same thing. When a calling convention
   *  proves an argument exists, that is an obligation on the SIGNATURE, independent of whether the
   *  body happens to use it, so it needs its own verb.
   *
   *  Never touches the block's definitions: the parameter is added and left unused, so any local
   *  value already flowing keeps flowing. Only meaningful on a block with no predecessors —
   *  elsewhere a parameter is a phi whose position is aligned with its predecessors' terminator
   *  args, and appending an unpaired one would corrupt that. */
  ensureParam(key: string, b: number): void;
  /** Whether `reg` has a definition reaching block `b` (best-effort call-arity heuristic). */
  hasReachingDef(reg: string, b: number, seen?: Set<number>): boolean;
  /** Record that block `b` makes a call HERE: the ABI's caller-saved registers stop being ones the
   *  caller set up. Call it AFTER `recordGuessedCall` for the same instruction, and after writing
   *  the call's own result — the result is the CALLEE's, so it must not count as caller-side
   *  argument setup for whatever call comes next. */
  noteCall(b: number): void;
  /** Register a `call` op whose arity was GUESSED (no prototype), so `finish` can cut it back to the
   *  argument registers that were actually set up on every path (see {@link trimClobberedCallArgs}).
   *  `abi` is the target's argument-register order and its return register. */
  recordGuessedCall(op: Op, b: number, abi: { argRegs: string[]; returnReg: string }): void;
  /** Remove trivial phis and enforce the frontend's postconditions; call once every block is
   *  filled. Throws FrontendUnsupportedError if a stack slot escaped as an entry parameter. */
  finish(): void;
}

/** `preds` is per-EDGE (see the module header): one entry per CFG edge into each block. */
// VARIABLE NAMES ARE NOT ALWAYS MACHINE REGISTERS. `readVar`/`writeVar` key on an arbitrary string,
// and frontends mint VIRTUAL keys for storage the ISA has no register for — MIPS `sp@<off>` for a
// stack slot (frontend/mips.ts), Thumb `@sarg<k>` for an incoming stack argument (frontend/thumb.ts).
// A virtual key must be outside its ISA's register grammar so it cannot collide with a real one, and
// a key read with no reaching def becomes a function PARAMETER by the live-in path below — which is
// how both of those capabilities get their parameters without a new opcode or pass.
/** What a def-less live-in MEANS here, in two coordinate systems — the frame in slot-key offsets,
 *  the register file by key. RANGES and LISTS rather than a verdict, so the classification below is
 *  checkable here: a frontend that is wrong about its own frame gets refused instead of believed,
 *  and a range that collapses to empty (an unmeasurable frame) stops claiming anything on its own.
 *  Ghidra carries the same partition as compiler-spec data (`<localrange>`, stack `<pentry>`) read
 *  by architecture-neutral code. */
export interface LiveInModel {
  /** Storage this function owns as LOCALS ⇒ a def-less read is an uninitialised local. `[from, to)`.
   *
   *  Asserts more than ownership: that this function's own stores are the ONLY writer. An address
   *  into the frame that escapes to anything which could write it stops that holding, and the
   *  retraction is the frontend's obligation (frontend/thumb.ts, after the frame-object audit). */
  ownedLocals?: { from: number; to: number };
  /** Storage the CALLER wrote — incoming stack arguments ⇒ a def-less read is a parameter.
   *  `[from, to)`. O32's register-parameter home area belongs to NEITHER range: caller-owned, but
   *  not an argument. */
  callerParams?: { from: number; to: number };
  /** Registers the ABI does not pass arguments in ⇒ a def-less read is an uninitialised local the
   *  compiler put in a register (`target.nonArgRegs`). A caller cannot hand a value over in one, so
   *  a read before any write is not an argument however early it happens.
   *
   *  The frame's sole-writer obligation has no counterpart here and needs none: a register has no
   *  address, so nothing outside this function can name it and there is no escape to retract.
   *
   *  LISTED, not derived as "everything outside argRegs", because the complement contains the
   *  VIRTUAL keys too (`@sarg<k>` — an incoming stack argument, which really is a parameter), and a
   *  rule that had to exclude them would be reading a grammar this module does not own. A register
   *  spelling nobody listed keeps its existing treatment, so the list is safe to grow. */
  uninitRegs?: readonly string[];
}

export function makeSsaBuilder(
  name: string,
  blockCount: number,
  preds: number[][],
  /** A supplier because the partition is MEASURED, not declared: Thumb's local area comes from a
   *  prologue walk that runs after this call. Evaluated once, on first use. Omitted ⇒ no partition
   *  is claimed, so every slot refuses and every register is a parameter. */
  frameOf: () => LiveInModel = () => ({}),
): SsaBuilder {
  let frameMemo: LiveInModel | null = null;
  const frame = (): LiveInModel => (frameMemo ??= frameOf());
  const inRange = (off: number, r?: { from: number; to: number }) => r !== undefined && off >= r.from && off < r.to;
  const irBlocks: Block[] = Array.from({ length: blockCount }, () => ({ params: [] as Value[], ops: [] }));
  const fn: Fn = { name, blocks: irBlocks };

  const defs: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const sealed: boolean[] = irBlocks.map(() => false);
  const filled: boolean[] = irBlocks.map(() => false);
  const incompletePhis: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const phiBlock = new Map<Value, number>();
  // The key each phi stands for. `paramReg` covers live-ins only, so without this a slot that
  // arrives as a PHI — which is what happens when the entry block is itself a loop header — is
  // invisible to the escape check below. Braun's construction gives no other way to tell.
  const phiKey = new Map<Value, string>();
  const paramReg = new Map<Value, string>();
  // Parameters created by ensureParam that nothing has read yet. They are deliberately NOT in
  // `defs`: a parameter asserted because a calling convention proves it exists is not evidence that
  // a VALUE reaches anything, and writing one into `defs` would say it does. That distinction is
  // load-bearing — `hasReachingDef` feeds `fallbackArgc`, so a def here silently raises the guessed
  // arity of every prototype-less call in the function, making it pass registers the calling block
  // never set up (`unknown(1)` became `unknown(1, a1, a2, a3)`). The first read adopts the value
  // from here instead of minting a second parameter for the same key.
  const obligedParams: Array<Map<string, Value>> = irBlocks.map(() => new Map());

  // `preds` lists an entry per CFG EDGE; these are the distinct predecessor BLOCKS.
  const distinctPreds = (b: number): number[] => [...new Set(preds[b])];

  // CALLER-SAVED CLOBBER, for guessed call arities (see trimClobberedCallArgs). Tracked HERE
  // because every register write in every frontend already goes through `writeVar`: a frontend
  // that gathered this itself would be sound only while it remembered to route each write past a
  // wrapper, and a MISSED write under-counts an arity — which drops a real argument silently.
  const writtenSinceCall: Array<Set<string>> = irBlocks.map(() => new Set());
  const callsIn = new Set<number>();
  const guessedCalls: GuessedCallSite[] = [];
  let abiSeen: { argRegs: string[]; returnReg: string } = { argRegs: [], returnReg: '' };

  const writeVar = (reg: string, b: number, v: Value) => {
    writtenSinceCall[b].add(reg);
    defs[b].set(reg, v);
  };
  const readVar = (reg: string, b: number): Value => defs[b].get(reg) ?? readRecursive(reg, b);

  const newPhi = (reg: string, b: number): Value => {
    const phi = mkValue(T.unk(32));
    irBlocks[b].params.push(phi);
    phiBlock.set(phi, b);
    phiKey.set(phi, reg);
    defs[b].set(reg, phi); // set before wiring operands to break cycles
    return phi;
  };
  const readRecursive = (reg: string, b: number): Value => {
    if (!sealed[b]) {
      // predecessors not all filled yet (e.g. a loop back-edge): defer operand wiring.
      const phi = newPhi(reg, b);
      incompletePhis[b].set(reg, phi);
      return phi;
    }
    // DISTINCT predecessor blocks: a switch_br reaching this block on several case values is one
    // predecessor with several edges, and it supplies ONE value — counting the edges instead would
    // manufacture a join (and a phi) where there is none.
    const ps = distinctPreds(b);
    if (ps.length === 0) {
      // A live-in with no predecessor is a value this function never produced: an incoming argument,
      // or storage it allocated and never wrote. WHICH ONE is the partition's answer, in whichever
      // coordinate the key names. The key spelling cannot decide a slot on its own — `sp@40` is a
      // local on one ABI and the caller's fifth argument on another — so a slot in neither range is
      // refused rather than guessed. A register is decided by the calling convention, which is not
      // measured but declared: a caller cannot pass a value in a register the ABI does not pass
      // arguments in, so a read of one before any write is an uninitialised local. Nothing here is
      // refused, because an unlisted register keeps its existing treatment.
      const off = slotKeyOffset(reg);
      if (off !== null && !inRange(off, frame().ownedLocals) && !inRange(off, frame().callerParams)) {
        throw new FrontendUnsupportedError(
          `cannot lift '${name}': ${reg} is read on a path that never stores it, and lies outside ` +
            `this function's frame partition (uninitialised local, or storage it does not own) — not modelled`,
        );
      }
      const uninitialised =
        off !== null ? inRange(off, frame().ownedLocals) : (frame().uninitRegs?.includes(reg) ?? false);
      if (uninitialised) {
        const op = mkOp('undef', { results: [mkValue(T.unk(32))], attrs: { key: reg } });
        irBlocks[b].ops.unshift(op); // ahead of everything in a block that nothing precedes
        defs[b].set(reg, op.results[0]);
        return op.results[0];
      }
      // an incoming argument register → function parameter.
      // If one was already asserted for this key (ensureParam), adopt it — minting a second
      // parameter for the same key would put the key in the signature twice.
      const obliged = obligedParams[b].get(reg);
      if (obliged !== undefined) {
        obligedParams[b].delete(reg);
        defs[b].set(reg, obliged);
        return obliged;
      }
      const p = mkValue(T.unk(32));
      irBlocks[b].params.push(p);
      defs[b].set(reg, p);
      paramReg.set(p, reg);
      return p;
    }
    if (ps.length === 1) {
      const v = readVar(reg, ps[0]);
      defs[b].set(reg, v);
      return v;
    }
    // sealed join: create the phi and wire every predecessor's terminator arg now.
    const phi = newPhi(reg, b);
    addPhiOperands(reg, b);
    return phi;
  };
  const addPhiOperands = (reg: string, b: number) => {
    for (const p of distinctPreds(b)) {
      appendSuccessorArg(p, b, readVar(reg, p));
    }
  };
  // Append `arg` to EVERY successor edge of predecessor p that targets block b.
  //
  // A predecessor normally has one edge to a given successor, but a `switch_br` has as many as it
  // has case values, and two cases sharing a body (`case 1: case 2:`) is ordinary C. Block args
  // belong to the EDGE, so each of those edges needs its own copy: appending to just the first (a
  // `find`) left the others short, while `preds` listing the block once per edge made the loop run
  // k times and pile k copies onto that same first edge. Both halves of that — every edge, once per
  // predecessor BLOCK — have to hold together, which is why they are fixed in one place.
  const appendSuccessorArg = (p: number, b: number, arg: Value) => {
    const term = irBlocks[p].ops[irBlocks[p].ops.length - 1];
    for (const s of term.successors) {
      if (s.block === irBlocks[b]) {
        s.args.push(arg);
      }
    }
  };
  const sealBlock = (b: number) => {
    if (sealed[b]) {
      return;
    }
    sealed[b] = true; // set first: addPhiOperands may recurse back here
    for (const reg of incompletePhis[b].keys()) {
      addPhiOperands(reg, b);
    }
    incompletePhis[b].clear();
  };
  const sealReadyBlocks = () => {
    for (let b = 0; b < irBlocks.length; b++) {
      if (!sealed[b] && preds[b].every((p) => filled[p])) {
        sealBlock(b);
      }
    }
  };
  sealReadyBlocks(); // seals the entry (no predecessors) up front

  // See the interface docs. Two cases, and the split is the whole point: when nothing defines the
  // key, the ordinary live-in path already does exactly the right thing; when something does, a
  // parameter still has to exist for the signature, and it must be added WITHOUT redirecting the
  // dataflow to it.
  const ensureParam = (key: string, b: number): void => {
    if (preds[b].length > 0) {
      return; // a parameter here is a phi; see the precondition on the interface
    }
    for (const p of irBlocks[b].params) {
      if (paramReg.get(p) === key) {
        return; // already a parameter, however it got there
      }
    }
    const p = mkValue(T.unk(32));
    irBlocks[b].params.push(p);
    paramReg.set(p, key); // ranked by the ABI sort like any other parameter
    obligedParams[b].set(key, p);
  };

  const hasReachingDef = (reg: string, b: number, seen = new Set<number>()): boolean => {
    if (defs[b].has(reg)) {
      return true;
    }
    if (seen.has(b)) {
      return false;
    }
    seen.add(b);
    return preds[b].length > 0 && preds[b].some((p) => hasReachingDef(reg, p, seen));
  };

  return {
    fn,
    irBlocks,
    readVar,
    writeVar,
    paramReg,
    ensureParam,
    hasReachingDef,
    noteCall: (b: number) => {
      callsIn.add(b);
      // the callee clobbers the caller-saved registers, its own result register included — see
      // the ordering contract on the interface
      writtenSinceCall[b] = new Set();
    },
    recordGuessedCall: (op: Op, b: number, abi: { argRegs: string[]; returnReg: string }) => {
      abiSeen = abi;
      guessedCalls.push({
        block: b,
        op,
        freshBefore: new Set(writtenSinceCall[b]),
        afterCallInBlock: callsIn.has(b), // `noteCall` runs after this, so this means an EARLIER call
      });
    },
    markFilled: (b: number) => {
      filled[b] = true;
      sealReadyBlocks();
    },
    finish: () => {
      // Guessed arities counted argument registers by reaching definition alone; now that every
      // block's calls are known, drop the ones an intervening call had already clobbered.
      if (guessedCalls.length) {
        const calleeResults = new Set<Value>();
        for (const b of irBlocks) {
          for (const op of b.ops) {
            if (op.opcode === 'call') {
              for (const r of op.results) {
                calleeResults.add(r);
              }
            }
          }
        }
        trimClobberedCallArgs({
          argRegs: abiSeen.argRegs,
          returnReg: abiSeen.returnReg,
          calleeResults,
          preds,
          freshAtEnd: writtenSinceCall,
          callsIn,
          sites: guessedCalls,
        });
      }
      simplifyTrivialPhis(fn, (p) => {
        phiBlock.delete(p);
        phiKey.delete(p);
      });
      // Then the phis nothing reads at all — a register two paths leave holding different junk
      // (a loop counter after its last use, a scratch the epilogue overwrites) still joins as a
      // phi, and a dead phi is not junk downstream: its edge args become post-loop copies in the
      // emitted C and block gates keyed on "this exit carries nothing". Order matters only for
      // economy: trivial-phi removal can orphan a phi's last reader, never the reverse.
      pruneDeadParams(fn, (p) => {
        phiBlock.delete(p);
        phiKey.delete(p);
      });
      // A STACK SLOT MAY NEVER LEAVE AS AN ENTRY PARAMETER. A slot is memory the function itself
      // allocated, so its value can only come from a store the function made; arriving as a live-in
      // instead means it was read on a path that never stored it, and the signature has grown an
      // argument the function does not take, standing in for uninitialised stack.
      //
      // Checked here, of the FINISHED function, rather than as a precondition at each read. The
      // per-read test available during construction (`hasReachingDef`) asks whether a store reaches
      // on SOME path, which a diamond defeats; strengthening it to "every path" is not answerable
      // mid-fill, because a loop's back-edge predecessor is not filled yet and the query would
      // report "unassigned" for a slot initialised before the loop — the commonest real shape.
      // Asking about the symptom instead costs one pass and cannot be defeated by fill order.
      //
      // It is total because in Braun's construction a value undefined on some path can surface only
      // as a live-in of a block with no predecessors — and BOTH spellings of that are checked:
      // `paramReg` for the live-in path, `phiKey` for the case where the entry block is itself a
      // loop header and the fabricated value arrives as a phi instead. Missing the second is what
      // let this survive on MIPS.
      //
      // In `finish()` and not a helper each frontend remembers to call: this is the frontend's only
      // semantic postcondition, and a postcondition enforced by convention is not enforced.
      for (const p of irBlocks[0].params) {
        const key = paramReg.get(p) ?? phiKey.get(p);
        // The SAME rule the mint site used, over the same ranges, so the two cannot disagree. A
        // slot that reached the signature is either owned storage (which should have become an
        // `undef`) or unclassified — both are bugs, and this is where a per-read test cannot be
        // total, so it is asserted over the finished function.
        const koff = key === undefined ? null : slotKeyOffset(key);
        if (koff !== null && !inRange(koff, frame().callerParams)) {
          throw new FrontendUnsupportedError(
            `cannot lift '${name}': ${key} is read on a path that never stores it ` +
              `(partially-initialised local, or storage this function does not own) — not modelled`,
          );
        }
      }
    },
  };
}

// ── shared frontend tail helpers ──

/** Best-effort call arity when a callee has no prototype: the count of contiguous argument
 *  registers with a value reaching the call's block. Correct when the arguments are set up in
 *  the calling block; it can under-count pass-through parameters — which is why a prototype's
 *  declared `params` is authoritative when available. */
export function fallbackArgc(
  ssa: { hasReachingDef(reg: string, b: number): boolean },
  argRegs: string[],
  bi: number,
): number {
  let n = 0;
  while (n < argRegs.length && ssa.hasReachingDef(argRegs[n], bi)) {
    n++;
  }
  return n;
}

/** One call site whose arity was GUESSED by {@link fallbackArgc}, with what the lifting scan saw
 *  of its own block up to that instruction. */
export interface GuessedCallSite {
  block: number;
  /** the `call` op — its operands are the guessed arguments, in argument-register order */
  op: Op;
  /** argument registers written between the last call in this block (or the block's start) and here */
  freshBefore: Set<string>;
  /** did this block already make a call before this one? */
  afterCallInBlock: boolean;
}

export interface CallArgTrim {
  argRegs: string[];
  /** the ABI return register. Load-bearing only where it IS `argRegs[0]` (ARM r0, PPC r3) — that
   *  aliasing is what makes a callee's result indistinguishable from caller-side argument setup. */
  returnReg: string;
  /** every value a `call` op produced. Tells a callee's own return apart from a join that merely
   *  PASSES THROUGH one, which the register file cannot: both leave argument 0 unfresh. */
  calleeResults: ReadonlySet<Value>;
  /** one entry per CFG edge, as passed to {@link makeSsaBuilder} */
  preds: number[][];
  /** per block: the keys written since its LAST call (since its start if it makes none). Indexed by
   *  block, and it holds every key the builder saw, not only argument registers. */
  freshAtEnd: Array<Set<string>>;
  /** blocks that make at least one call */
  callsIn: Set<number>;
  sites: GuessedCallSite[];
}

/** Cut a GUESSED call arity down by the ABI's caller-saved clobber.
 *
 *  `fallbackArgc` counts argument registers that merely have a reaching definition. A call clobbers
 *  r0..r3, so a definition the call sits between cannot be an argument the caller set up — correct
 *  compiled code would have re-materialized it. Counting it anyway INVENTS arguments
 *  (`m4aSongNumStart(0x89, 30, x, &g)` for a one-argument callee) — a hard compile error where the
 *  project's own header is in scope, and silently wrong code where C89's implicit declaration
 *  covers for it.
 *
 *  SCOPE: this closes the arguments an intervening CALL disproves, which is the common case in real
 *  code. It does not close the rest — a dead value the compiler happened to leave in the next
 *  argument register with no call in between still reads as an argument, and nothing about the
 *  register file can say otherwise. A declared prototype closes those outright; short of one, the
 *  narrower reading is recorded here and offered as a ranked candidate ({@link narrowToSetupArgs}).
 *
 *  A must-analysis: a register is FRESH at a point iff on EVERY path reaching it, it was written
 *  after the last call. The entry block starts all-fresh (those are the caller's own arguments).
 *  The result only ever SHRINKS an arity, but two of the shrinks are REFUSALS and not proofs, so a
 *  real argument CAN go with them: a fresh register above a hole stops the run (a 64-bit return
 *  occupies two registers and the frontend cannot express one, so the caller's r2 goes with the
 *  unfillable r1), and a callee's return read as the callee's own drops an argument a `g(f())`
 *  source did pass. A declared prototype is what closes either.
 *
 *  Frontend-agnostic: the caller supplies what its own lifting scan observed, so nothing here
 *  re-derives which instruction writes which register. */
export function trimClobberedCallArgs(inp: CallArgTrim): void {
  const { argRegs, returnReg, calleeResults, preds, freshAtEnd, callsIn, sites } = inp;
  const blockCount = freshAtEnd.length;
  const all = () => new Set(argRegs);
  const localEnd = (b: number) => freshAtEnd[b] ?? new Set<string>();
  // freshOut[b]: registers fresh where b ends. A block that calls forgets everything before its
  // last call; one that does not passes its input through, plus what it wrote.
  const freshOut: Set<string>[] = Array.from({ length: blockCount }, () => all());
  const freshIn: Set<string>[] = Array.from({ length: blockCount }, () => all());
  const inOf = (b: number): Set<string> => {
    // A block with NO predecessors is the function entry (or unreachable): its argument registers
    // are the ones the caller set up. An entry that DOES have predecessors — an entry that is also
    // a loop header — gets the ordinary intersection instead, because on the back edge the caller's
    // setup is long gone and an intervening call may have clobbered it.
    const ps = [...new Set(preds[b] ?? [])];
    if (ps.length === 0) {
      return all();
    }
    const acc = new Set(freshOut[ps[0]]);
    for (const p of ps.slice(1)) {
      for (const r of [...acc]) {
        if (!freshOut[p].has(r)) {
          acc.delete(r);
        }
      }
    }
    return acc;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let b = 0; b < blockCount; b++) {
      const fin = inOf(b);
      const fout = callsIn.has(b) ? localEnd(b) : new Set([...fin, ...localEnd(b)]);
      if (fout.size !== freshOut[b].size || [...fout].some((r) => !freshOut[b].has(r))) {
        changed = true;
      }
      freshIn[b] = fin;
      freshOut[b] = fout;
    }
  }
  const runOfFresh = (fresh: Set<string>, from: number): number => {
    let n = from;
    while (n < argRegs.length && fresh.has(argRegs[n])) {
      n++;
    }
    return n;
  };
  // A LATER argument register this caller set up proves the call takes arguments at all, and
  // argument 0 sits below one that is proven — so it is being passed too, whatever put it there
  // (`bl __mulsf3; add r1,r4,#0; bl __addsf3` is `__addsf3(__mulsf3(a, b), c)`).
  const setsUpLater = (fresh: Set<string>): boolean => argRegs.some((r, i) => i > 0 && fresh.has(r));
  // THE RETURN REGISTER IS NOT ARGUMENT SETUP. Where the ABI aliases it onto argument 0, the
  // frontends record a call's clobber AFTER its own result, so the result leaves the register
  // UNfresh here. That disproves caller setup only where the callee's return is BOTH what the
  // register still holds and all the site has to go on: with a later register set up (above), or
  // with a value no call produced — a join of one path's return with another path's caller-computed
  // value — argument 0 is a real argument, and dropping the second kind would delete the
  // instructions that computed it.
  //
  // With neither, the site carries no argument evidence at all: `bl f; bl g` is `f(); g();` as
  // readily as `g(f())`, the two spell the same bytes on this ABI, and only the nested one needs
  // `f` to return a value and `g` to accept one — a spelling the project's own header rejects
  // outright when it does not. A declared prototype never reaches here, and stays the way `g(f())`
  // is recovered.
  const argcAt = (fresh: Set<string>, op: Op): number => {
    if (argRegs[0] !== returnReg || fresh.has(argRegs[0])) {
      return runOfFresh(fresh, 0);
    }
    if (setsUpLater(fresh) || !calleeResults.has(op.operands[0])) {
      return runOfFresh(new Set([argRegs[0], ...fresh]), 0);
    }
    return 0;
  };
  for (const s of sites) {
    const fresh = s.afterCallInBlock ? s.freshBefore : new Set([...freshIn[s.block], ...s.freshBefore]);
    const n = argcAt(fresh, s.op);
    if (n < s.op.operands.length) {
      s.op.operands.length = n;
    }
    // The SHORTER arity the same evidence also allows, recorded for {@link narrowToSetupArgs}: the
    // run over what THIS BLOCK wrote, dropping the registers that are fresh only because no call
    // stands between here and wherever they were last written. Both readings stay live, so this one
    // is recorded rather than applied. A survivor is what it drops, so the join clause above has no
    // place here — but `setsUpLater` still does: a register this block set up two instructions
    // before the call is not something the narrower reading may call dead.
    const localFresh = setsUpLater(s.freshBefore) ? new Set([argRegs[0], ...s.freshBefore]) : s.freshBefore;
    const local = Math.min(runOfFresh(localFresh, 0), s.op.operands.length);
    if (local < s.op.operands.length) {
      setupArgc.set(s.op, local);
    }
  }
}

/** The narrower arity {@link narrowToSetupArgs} would cut each guessed call to. A SIDE table and
 *  not an attr: this is a fact about one LIFT, not part of the IR the rest of the pipeline compares
 *  and prints — `structure/hazards.ts` decides two ops equal by comparing their attrs verbatim, so
 *  an attr only one of an otherwise-matching pair carries would cost a recovery. */
const setupArgc = new WeakMap<Op, number>();

/** Whether anything in `fn` HAS the narrower reading — the lever's gate, so the ~99% of functions
 *  with no narrowable call cost no re-lift. Read it off the lift itself: a later pipeline stage may
 *  replace a `call` op (softdiv rewrites one to a division), and the table is keyed by op. */
export function hasSetupArgsNarrowing(fn: Fn): boolean {
  return fn.blocks.some((b) => b.ops.some((op) => setupArgc.has(op)));
}

/** Cut every guessed call to the arity its OWN BLOCK set up, and report whether anything moved.
 *
 *  `trimClobberedCallArgs` keeps an argument register whose value merely survives from an earlier
 *  block, because compiled code really does pass one that way: agbcc leaves a value already in r0
 *  where it is and branches to the call (`if (x) f(x);` is `cmp r0,#0; beq; bl f`, no setup at
 *  all). Those are also the bytes `if (x) f();` compiles to, so usually neither reading is
 *  refutable — but where the guard is an EQUALITY the compiler proves the argument constant and
 *  has to materialize it (`if (x == 0) f(x);` opens the arm with `mov r0,#0`), and the absence of
 *  that instruction rules the wider reading out. Which case a function is in is not knowable from
 *  the register file, and is exactly what a differ decides. Hence a ranked candidate rather than a
 *  default: the arm that passes only what the calling block itself put there.
 *
 *  Applies only to arities that were GUESSED — a declared prototype never recorded the fact. */
export function narrowToSetupArgs(fn: Fn): boolean {
  let changed = false;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const setup = setupArgc.get(op);
      if (setup !== undefined && setup < op.operands.length) {
        op.operands.length = setup;
        changed = true;
      }
    }
  }
  if (changed) {
    // A dropped argument can be a join's last reader, and `finish()` pruned the dead phis before
    // this reading existed. Left in, the phi's edge args render as assignments to a local nothing
    // reads (`v0 = UpdateWorldMapCursor();`) — see the note on the prune in `finish`.
    pruneDeadParams(fn);
  }
  return changed;
}

/** The stack-slot key both the MIPS and Thumb frontends use for a word-sized local in the
 *  function's own frame. Shared so the two spell it identically and the frame-partition rule can
 *  recognise either frontend's slots. See the virtual-key note in the module header. */
const SLOT_PREFIX = 'sp@';
export const stackSlotKey = (off: number): string => `${SLOT_PREFIX}${off}`;
/** The byte offset a slot key names, or null if `key` is not a slot key at all (an ordinary
 *  register). The grammar stays owned by this module — {@link LiveInModel} is expressed in the same
 *  coordinate, so the classification rule can be generic. */
export const slotKeyOffset = (key: string): number | null =>
  key.startsWith(SLOT_PREFIX) ? Number(key.slice(SLOT_PREFIX.length)) : null;

/** Order the TRUE entry block's parameters by ABI argument register, so downstream naming
 *  (`a0`, `a1`, …) matches the calling convention, not first-read order (a callee-saved copy can
 *  read a later argument register first). No-op when the entry has predecessors — a loop
 *  header's params are phis position-aligned with predecessor terminator args and must not be
 *  reordered. `rank` is per-ISA: the tie-break for a non-ABI live-in deliberately differs
 *  (Thumb sorts it LAST via 99, MIPS/PPC FIRST via indexOf's -1) to keep each frontend's
 *  output byte-exact. */
export function abiSortEntryParams(
  entry: { params: Value[] },
  entryHasPreds: boolean,
  rank: (v: Value) => number,
): void {
  if (entryHasPreds) {
    return;
  }
  entry.params.sort((x, y) => rank(x) - rank(y));
}
