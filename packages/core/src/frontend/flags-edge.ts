// The edge rule for condition state: when a block may begin with the compare its predecessor left.
//
// Two frontends carry a compare across a block boundary, and their STATE and CLOBBER rules differ
// (one implicit flags register and `FLAG_SETTING` on Thumb; eight `cr` fields and the record-form
// `.` suffix on PowerPC, each also cleared by a call). The EDGE rule is the same thing on both, and it is
// where the soundness lives, so it is written once, here.

/** What an ISA tells the edge rule about its blocks. `exit` holds what each block left at its last
 *  instruction: the frontend writes it as it fills blocks in order, so a lookup finds only blocks
 *  filled EARLIER, and an unlifted predecessor answers "not known" rather than "none". */
export interface FlagsEdges<S> {
  preds: readonly (readonly number[])[];
  exit: ReadonlyMap<number, S>;
  label: (bi: number) => string;
  /** The block ends in a jump-table dispatch, so its edges are switch edges. */
  dispatches: (bi: number) => boolean;
  /** The block ends in a conditional branch AND this ISA's model does not carry the flags across
   *  that branch's edges. */
  refusesConditional: (bi: number) => boolean;
}

/** The condition state a block starts with, inherited from its predecessor, or the sentence saying
 *  why it starts with none. One call answers both, so a refusal and its reason cannot drift apart.
 *
 *  A block entered from exactly one predecessor begins with exactly the flags that predecessor
 *  left. agbcc depends on it: a function long enough to need a mid-function literal pool gets a `b`
 *  over the pool between a `cmp` and the branch that reads it, leaving the branch alone under a
 *  label. mwcc depends on it across a CONDITIONAL edge: its binary-search switch dispatch is
 *  `cmpwi r0,1; beq- case1; bge- default`, one compare read by the `beq-` and then by the `bge-` on
 *  the `beq-`'s fall-through, which starts a block of its own.
 *
 *  What crosses the edge is the compare's SSA values, never its register names. A lone
 *  predecessor dominates, so those values dominate every use on this side, while re-reading `r0`
 *  here would pick up whatever this block redefined it to.
 *
 *  TRANSITIVE, over as many edges as the chain has: each block runs this and writes its own exit
 *  state, so a compare reaches the end of a run of straight-line blocks and refuses at the first
 *  one that breaks the chain.
 *
 *  NOT THE BLOCK-PARAMETER MACHINERY, though both frontends have SSA with block parameters. Three
 *  reasons, and the last is the one a later "improvement" would get wrong:
 *    * the flags are not a register anything reads, so there is nothing for `readVar` to look up.
 *      The compare is consumed by the terminator, never by a named operand;
 *    * the value a phi would carry does not exist yet on the predecessor's side. WHICH comparison
 *      it is comes from the branch's mnemonic, at the SUCCESSOR's terminator, while the
 *      predecessor is filled first. Flags are not a condition until a branch names one, so at the
 *      edge there is nothing yet to phi;
 *    * `preds.length === 1` is deliberately STRONGER than dominance. A dominating predecessor's
 *      flags can still be overwritten on a longer path that rejoins here, so answering this from
 *      the dominator tree would state a condition that holds on one path in.
 *
 *  Refuses when either half of that sentence fails:
 *    * the block has no predecessor, or more than one. The flags on two paths need not agree, and
 *      picking one states a condition the machine does not promise;
 *    * the only predecessor has not been filled yet, so this pass has nothing to read;
 *    * the edge leaves a jump-table dispatch. The edge into a case is a switch edge, and the bounds
 *      guard is not the branch that made it;
 *    * the edge leaves a conditional branch the ISA's model does not carry across. A branch writes
 *      no flags on either ISA, so this is UNBUILT rather than unsound where it refuses: Thumb
 *      refuses it because no ARM row inhabits it, and PowerPC carries it (a `bc` writes no CR
 *      field) because the mwcc dispatch above does.
 *
 *  It does NOT refuse when no compare survives to the predecessor's last instruction, because that
 *  is not this function's gap to report: the predecessor already wrote down what took the flags,
 *  and that is what crosses the edge.
 *
 *  Not a `Gate` table, on docs/level-tower.md's structural bar rather than on cost: every refusal
 *  reads `exit`, which exists only because of the order the frontend fills blocks in, so its input
 *  cannot be prepared as a getter at any price. */
export function inheritFlags<S>(bi: number, edges: FlagsEdges<S>): S | string {
  const here = edges.label(bi);
  const ps = edges.preds[bi];
  if (ps.length !== 1) {
    return ps.length === 0
      ? `no compare reaches '${here}', and it has no predecessor to inherit any from`
      : `no compare crosses the edges into '${here}': ${ps.length} meet there, and the flags need not agree on all of them`;
  }
  const p = ps[0];
  const carried = edges.exit.get(p);
  // Named for the fill order that decides it, not for a loop: this is true of any predecessor not
  // yet lifted, and a CFG with no cycle in it can be laid out so that one is (`f: b .L2` /
  // `.L1: bge` / `.L2: cmp; b .L1`). Saying "a back edge" sent a reader to look for a loop that is
  // not there, and named a property of the CFG for a property of the walk over it. A
  // reverse-postorder fill is what would close this, which is why the sentence points at the walk.
  if (carried === undefined) {
    return `no compare crosses the edge into '${here}': its only predecessor '${edges.label(p)}' is lifted after it`;
  }
  // Asked BEFORE the conditional-branch arm. On Thumb every dispatch block also ends in a
  // conditional branch (`recoverJumpTable` only recognises a bounds block ending in `bhi`/`bls`),
  // so there this arm buys the truer sentence and not the verdict — `thumb-frontend.test.ts` runs
  // that ablation. On PowerPC the conditional arm carries, so this arm is the one that refuses.
  if (edges.dispatches(p)) {
    return `no compare crosses the edge into '${here}': it leaves the jump-table dispatch in '${edges.label(p)}'`;
  }
  if (edges.refusesConditional(p)) {
    return `no compare crosses the edge into '${here}': it leaves '${edges.label(p)}' through a conditional branch`;
  }
  // Whatever the predecessor left, verbatim. A reason already names the block the chain broke in,
  // so it is as true here as it was there, and a run of ten straight-line blocks reports the one
  // instruction that took the flags rather than the last edge it crossed.
  return carried;
}
