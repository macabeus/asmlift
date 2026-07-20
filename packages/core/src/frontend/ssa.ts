// asmlift — ISA-neutral on-the-fly SSA construction (Braun et al. 2013, "Simple and
// Efficient Construction of SSA Form"), shared by every frontend. The frontend supplies the
// CFG (predecessors per block) and, per block, emits ops through `readVar`/`writeVar`; this
// module materialises block-argument phis at joins and back-edges.
//
// Protocol: create the builder, then fill blocks in index order. For each block, emit its
// computation via read/writeVar, push its terminator op last (successors referencing
// `irBlocks`, args left empty — phi wiring appends them), then call `markFilled(b)`. When all
// blocks are filled, call `finish()` to remove trivial phis.
import { Block, Fn, Successor, Value, mkValue, replaceAllUsesWith } from '../ir/core';
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
  /** Live-in parameter value → the ABI register it arrived on (for calling-convention order). */
  paramReg: Map<Value, string>;
  /** Whether `reg` has a definition reaching block `b` (best-effort call-arity heuristic). */
  hasReachingDef(reg: string, b: number, seen?: Set<number>): boolean;
  /** Remove trivial phis; call once every block is filled. */
  finish(): void;
}

export function makeSsaBuilder(name: string, blockCount: number, preds: number[][]): SsaBuilder {
  const irBlocks: Block[] = Array.from({ length: blockCount }, () => ({ params: [] as Value[], ops: [] }));
  const fn: Fn = { name, blocks: irBlocks };

  const defs: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const sealed: boolean[] = irBlocks.map(() => false);
  const filled: boolean[] = irBlocks.map(() => false);
  const incompletePhis: Array<Map<string, Value>> = irBlocks.map(() => new Map());
  const phiBlock = new Map<Value, number>();
  const paramReg = new Map<Value, string>();

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
    const ps = preds[b];
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
    for (const p of preds[b]) {
      appendSuccessorArg(p, b, readVar(reg, p));
    }
  };
  // Append `arg` to predecessor p's terminator successor that targets block b.
  const appendSuccessorArg = (p: number, b: number, arg: Value) => {
    const term = irBlocks[p].ops[irBlocks[p].ops.length - 1];
    const s = term.successors.find((su) => su.block === irBlocks[b]);
    if (s) {
      s.args.push(arg);
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
    hasReachingDef,
    markFilled: (b: number) => {
      filled[b] = true;
      sealReadyBlocks();
    },
    finish: () => simplifyTrivialPhis(fn, phiBlock),
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

// Remove block-parameters that are really trivial phis: those whose incoming operands (across
// every predecessor edge, ignoring self-references from a back-edge) are all the same single
// value. Such a parameter carries no join information — a loop-invariant register or a value
// defined before the join — so it is replaced by that value and the corresponding argument
// dropped from each predecessor's terminator. Iterated to fixpoint because removing one phi
// can make another trivial.
function simplifyTrivialPhis(fn: Fn, phiBlock: Map<Value, number>): void {
  const edgesTo = (b: Block): Successor[] => {
    const out: Successor[] = [];
    for (const pb of fn.blocks) {
      for (const op of pb.ops) {
        for (const s of op.successors) {
          if (s.block === b) {
            out.push(s);
          }
        }
      }
    }
    return out;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of fn.blocks) {
      const incoming = edgesTo(b);
      for (let i = b.params.length - 1; i >= 0; i--) {
        const param = b.params[i];
        const operands = incoming.map((s) => s.args[i]);
        const distinct = [...new Set(operands.filter((v) => v !== param))];
        if (distinct.length !== 1) {
          continue;
        } // a genuine join (or unreachable) — keep it
        const v = distinct[0];
        replaceAllUsesWith(fn, param, v);
        b.params.splice(i, 1);
        for (const s of incoming) {
          s.args.splice(i, 1);
        }
        phiBlock.delete(param);
        changed = true;
      }
    }
  }
}
