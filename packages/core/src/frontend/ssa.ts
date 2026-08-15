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
import { Block, Fn, Value, mkValue } from '../ir/core';
import { simplifyTrivialPhis } from '../ir/simplify';
import { T } from '../ir/types';

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
  /** Remove trivial phis; call once every block is filled. */
  finish(): void;
}

/** `preds` is per-EDGE (see the module header): one entry per CFG edge into each block. */
// VARIABLE NAMES ARE NOT ALWAYS MACHINE REGISTERS. `readVar`/`writeVar` key on an arbitrary string,
// and frontends mint VIRTUAL keys for storage the ISA has no register for — MIPS `sp@<off>` for a
// stack slot (frontend/mips.ts), Thumb `@sarg<k>` for an incoming stack argument (frontend/thumb.ts).
// A virtual key must be outside its ISA's register grammar so it cannot collide with a real one, and
// a key read with no reaching def becomes a function PARAMETER by the live-in path below — which is
// how both of those capabilities get their parameters without a new opcode or pass.
export function makeSsaBuilder(name: string, blockCount: number, preds: number[][]): SsaBuilder {
  const irBlocks: Block[] = Array.from({ length: blockCount }, () => ({ params: [] as Value[], ops: [] }));
  const fn: Fn = { name, blocks: irBlocks };

  const defs: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const sealed: boolean[] = irBlocks.map(() => false);
  const filled: boolean[] = irBlocks.map(() => false);
  const incompletePhis: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const phiBlock = new Map<Value, number>();
  const paramReg = new Map<Value, string>();

  // `preds` lists an entry per CFG EDGE; these are the distinct predecessor BLOCKS.
  const distinctPreds = (b: number): number[] => [...new Set(preds[b])];

  const writeVar = (reg: string, b: number, v: Value) => defs[b].set(reg, v);
  const readVar = (reg: string, b: number): Value => defs[b].get(reg) ?? readRecursive(reg, b);

  const newPhi = (reg: string, b: number): Value => {
    const phi = mkValue(T.unk(32));
    irBlocks[b].params.push(phi);
    phiBlock.set(phi, b);
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
      // live-in with no predecessor: an incoming argument register → function parameter.
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
        return;
      }
    }
    if (!defs[b].has(key)) {
      readVar(key, b);
      return;
    }
    const p = mkValue(T.unk(32));
    irBlocks[b].params.push(p);
    paramReg.set(p, key); // ranked by the ABI sort like any other parameter; deliberately no defs entry
  };

  const hasReachingDef =(reg: string, b: number, seen = new Set<number>()): boolean => {
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
    markFilled: (b: number) => {
      filled[b] = true;
      sealReadyBlocks();
    },
    finish: () => simplifyTrivialPhis(fn, (p) => phiBlock.delete(p)),
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
