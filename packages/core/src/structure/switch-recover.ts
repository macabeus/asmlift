// asmlift structurer — Regime-A SWITCH RECOVERY: recognise a comparison tree over a single
// scrutinee rooted at a cond_br and rebuild the `switch` — or DECLINE (null) to plain
// if-recovery, which is behaviourally identical (a clean nonmatch, never a miscompile). The
// factory takes its dependencies EXPLICITLY (`SwitchRecoverDeps`); `expr`/`structureRegion` are
// late-bound callbacks into the emission phase, so case bodies reuse the ordinary structuring
// machinery (loops/ifs inside cases, the onStack guard).
import { Block, Fn, Op, Value, forwardingTarget, isBodyless, successorsOf } from '../ir/core';
import { ORDER_SENSITIVE_OPS } from '../ir/opcodes';
import { Expr, Stmt, SwitchCase } from '../l3/ast';

export interface SwitchRecoverDeps {
  fn: Fn;
  defs: Map<Value, Op>;
  dom: Map<Block, Set<Block>>;
  ipdom: Map<Block, Block | null>;
  opBlock: Map<Op, Block>;
  /** does this value carry a variable name? (named values are not constants) */
  isNamed: (v: Value) => boolean;
  /** is this opcode an integer comparison? */
  isCmpOpcode: (opcode: string) => boolean;
  switchAllowsNeqCase: boolean;
  /** read a relational test whose BRANCH admits exactly one scrutinee value as that case */
  switchAllowsBoundCase: boolean;
  /** emit the case arms in the ASSEMBLY's block-layout order rather than by ascending case value */
  switchArmsFollowLayout: boolean;
  /** may the emitted SOURCE say "this arm runs on into the next one"? False for a language whose
   *  `case` cannot fall through (Pascal), and then Regime A declines a falling arm to if-recovery
   *  — the behaviourally identical recovery that backend CAN print. See StructureOptions. */
  spellSwitchFallthrough: boolean;
  /** does emitting this block's ops carry a statement beyond the ops themselves? Collapsing a
   *  test block into a `switch` re-renders its ops at their uses and emits no side effects for it,
   *  so any op that renders as a STATEMENT of its own loses that statement. Two produce one: a
   *  def-site ANCHORED merge copy (structure.ts anchorConstCopies), whose edge copy stays
   *  suppressed, and a MATERIALIZED def, whose `v = …` assignment renders only here while its uses
   *  read the bare name — leaving a local declared and never assigned. */
  emitsOwnStatement: (blk: Block) => boolean;
  /** THE DISPATCH HOIST. Collapsing the tree discards its edges, and an edge's only emission is
   *  its parallel copy — so the copies of every edge the tree walk collapsed are merged and
   *  re-emitted ONCE, ahead of the `switch`. `structure.ts hoistedDispatchAssigns` owns the
   *  emission (suppression, identity elision, `undef`, the write-order sort, `sequentialize`), so
   *  this regime takes it as a dependency rather than implementing it a second time, exactly as
   *  Regime B takes `argAssignsFor`. Null ⇒ no single hoisted statement spells them; the caller
   *  declines to if-recovery. `liveAt` are the blocks whose live-in names the hoisted writes must
   *  not clobber. */
  hoistDispatchCopies: (
    edges: readonly { pred: Block; succ: { block: Block; args: Value[] } }[],
    liveAt: readonly Block[],
  ) => Stmt[] | null;
  expr: (v: Value) => Expr;
  structureRegion: (b: Block, stop: Block | null) => Stmt[];
}

/** Where ONE switch arm's region leaves it — the fact that decides whether the arm can be spelled
 *  as C at all, and with or without a `break`.
 *
 *   - `break`        every path out of the arm reaches the switch's merge (or returns / loops
 *                    inside the arm). The ordinary closed arm.
 *   - `fallthrough`  every path out leaves into exactly ONE sibling arm's entry: C's fall-through.
 *                    Only spellable when that sibling is the arm emitted NEXT, which `chainArms`
 *                    below arranges and both regimes then re-read off the emission array (see the
 *                    l3/ast.ts non-neutrality note).
 *   - `unstructurable`  anything else: two different siblings, or a mix of "into a sibling" and
 *                    "out to the merge". C needs a `goto` for those. Regime A declines to
 *                    if-recovery on this verdict; Regime B, having no fallback, fails LOUD. */
export type ArmExit = { kind: 'break' } | { kind: 'fallthrough'; to: Block } | { kind: 'unstructurable'; why: string };

export interface SwitchRecovery {
  recognizeSwitch: (b: Block, stop: Block | null) => Stmt[] | null;
  /** shared with the Regime-B (`switch_br`) path in structure.ts. Both regimes recover the
   *  fall-through this returns; on an `unstructurable` verdict Regime A declines to if-recovery and
   *  Regime B, which has no fallback, fails loud. */
  analyzeArmExit: (entry: Block, b: Block, merge: Block | null, siblings: Set<Block>) => ArmExit;
  /** a block's position in the ASSEMBLY — the arm-order evidence, shared with Regime B so the two
   *  regimes read it from one definition (and one statement of what it rests on). */
  layoutIndex: (blk: Block) => number;
  /** where the `default:` label goes among the EMITTED arms, or `undefined` for C's last position —
   *  shared with Regime B so both regimes state those refusals once. */
  defaultLayoutPos: (
    defaultBlk: Block,
    arms: readonly { entry: Block; fallsThrough: boolean }[],
    opts: { placedByDispatch: boolean; orderIntact: boolean },
  ) => number | undefined;
  /** ONE linear emission order for a set of arms, re-threaded so every falling arm sits directly
   *  above the one it falls into — or null when no linear order spells them. Shared with Regime B,
   *  so the chain, the adjacency it guarantees and the three refusals below it have one definition
   *  (Regime A maps null to if-recovery, Regime B to a loud StructureError). */
  chainArms: (order: Block[], dflt: Block | null, exitOf: Map<Block, ArmExit>) => Block[] | null;
}

export function makeSwitchRecovery(deps: SwitchRecoverDeps): SwitchRecovery {
  const {
    fn,
    defs,
    dom,
    ipdom,
    opBlock,
    isNamed,
    isCmpOpcode,
    switchAllowsNeqCase,
    switchAllowsBoundCase,
    switchArmsFollowLayout,
    spellSwitchFallthrough,
    emitsOwnStatement,
    hoistDispatchCopies,
    expr,
    structureRegion,
  } = deps;

  /** Which block declares a given value as a PARAMETER — the half of "where is this defined"
   *  `defs` does not answer, needed to ask whether a hoisted argument is available at the root. */
  const paramBlock = new Map<Value, Block>();
  for (const blk of fn.blocks) {
    for (const p of blk.params) {
      paramBlock.set(p, blk);
    }
  }

  // A block's index in `fn.blocks` as its position in the ASSEMBLY — the sole warrant for reading a
  // source's arm order off block indices below, and true PER FRONTEND rather than of the IR:
  //   - thumb.ts and mips.ts build the list by scanning the instruction stream in address order;
  //   - ppc.ts does not. It APPENDS a synthetic return block (`synthReturn`) at the end of the list
  //     for every conditional-return branch, wherever in the stream that branch sits, so its list
  //     is not address order at all;
  //   - raising only ever REMOVES blocks from the list (raise/{divpow2,latch,retsink,shortcircuit}
  //     .ts all `filter`), never inserts or reorders, so the frontend's order is what survives.
  // `switchArmsFollowLayout` is therefore a claim about a target's FRONTEND as much as about its
  // compiler, and a target opts in on both — which is why PPC_MWCC, whose frontend fails the first
  // half, does not.
  const blockIndex = new Map(fn.blocks.map((blk, i) => [blk, i] as const));
  const layoutIndex = (blk: Block): number => blockIndex.get(blk) ?? -1;

  /** A block with no body of its own: no params, and one op that only LEAVES. `ret` qualifies as
   *  well as `br` because raise/retsink.ts rewrites the one into the other — a cross-jumped arm
   *  body has two dispatch preds, which is exactly the shape that makes retsink sink the merge's
   *  return into every leaf, the fall-out jumps included. */
  const isBareExit = (blk: Block): boolean =>
    isBodyless(blk) && (blk.ops[0].opcode === 'br' || blk.ops[0].opcode === 'ret');

  /** Are these two blocks the SAME bare exit — the same jump with the same args, or the same return
   *  of the same values? Neither has a body, so two of them are indistinguishable at emission. */
  const sameBareExit = (a: Block, c: Block): boolean => {
    if (a === c) {
      return true;
    }
    if (!isBareExit(a) || !isBareExit(c) || a.ops[0].opcode !== c.ops[0].opcode) {
      return false;
    }
    const same = (x: readonly Value[], y: readonly Value[]) => x.length === y.length && x.every((v, i) => v === y[i]);
    if (a.ops[0].opcode === 'ret') {
      return same(a.ops[0].operands, c.ops[0].operands);
    }
    const [x, y] = [a, c].map((blk) => blk.ops[0].successors[0]);
    return x.block === y.block && same(x.args, y.args);
  };

  // Where the `default:` label goes among the arms, as a COUNT of the arms laid out before it — the
  // same evidence the case bodies carry, read the same way. Compiled at every position of a 3- to
  // 8-case switch, the default's block lands where the source wrote it. `undefined` ⇒ C's
  // conventional last position, which is what every other producer of this node means.
  //
  // THREE refusals. One is about a block the walk already read as a CASE arm — a dense table sends
  // every unwritten value's slot to the default's block, so grouping the slots gives that block an
  // arm of its own and its index is where THAT arm sits. The other two are about a block the
  // DISPATCH placed rather than the arm:
  //   - a block with no body of its own is one the dispatch minted (`b .Ldefault`), and which of
  //     several such the collapse below keeps is a walk-order accident;
  //   - `emit_case_nodes` ends every exhausted subtree with `emit_jump_if_reachable (default_label)`
  //     and `expand_end_case` reorders the whole dispatch, those jumps included, ahead of the arm
  //     bodies — so a jump survives as a plain FALL-THROUGH exactly when the default's body is the
  //     arm the source wrote FIRST. That reading holds only while a second subtree still names the
  //     label: a two-case chain names it once, and agbcc then lays that block right after the tests
  //     whatever the source wrote, both spellings compiling to identical instructions.
  //
  // THREE further withholdings, all about fall-through and all stated here so both regimes state
  // them once. The first is about the LIST the count would index; the other two are about the
  // POSITION it names:
  //   - the chain RE-THREADED the arm order (`orderIntact` false), so the emitted list is no longer
  //     the one the layout count describes and no position in it means what the count says. This
  //     one is whole-switch because the re-threading is. A per-position reading — bracket the label
  //     between the two arms that straddle it in LAYOUT, then map that into the emitted list — is
  //     possible and unbuilt, and hard to need: a compiler that lays bodies out in source order
  //     already writes a falling arm directly above its target, so the order it declares is a chain
  //     order too;
  //   - the LAST emitted arm falls through, which can only be into the default (the adjacency
  //     check leaves no other target) — the label must then be last, which IS `undefined`;
  //   - the position lands directly after a falling arm, where printing the label would divert
  //     that arm into the default. cfamily.ts fails loud on exactly that, and this is the producer
  //     side of the same rule.
  // A switch with a chain elsewhere keeps its evidence: the reason to withhold is the position,
  // never "some arm somewhere falls".
  const defaultLayoutPos = (
    defaultBlk: Block,
    arms: readonly { entry: Block; fallsThrough: boolean }[],
    opts: { placedByDispatch: boolean; orderIntact: boolean },
  ): number | undefined => {
    if (
      !switchArmsFollowLayout ||
      isBareExit(defaultBlk) ||
      arms.some((a) => a.entry === defaultBlk) ||
      opts.placedByDispatch ||
      !opts.orderIntact ||
      arms[arms.length - 1]?.fallsThrough
    ) {
      return undefined;
    }
    const at = arms.filter((a) => layoutIndex(a.entry) < layoutIndex(defaultBlk)).length;
    return at > 0 && arms[at - 1].fallsThrough ? undefined : at;
  };

  // --- Regime A: comparison-tree switch recovery ----------------------------------------------------
  // Every ambiguity declines. Four preconditions are enforced below, annotated PRE1..PRE4:
  // scrutinee identity/dominance, ARM EXITS (per site: `break`, `fallthrough` — which `chainArms`
  // then places — or a decline), concrete interval consistency, test purity.

  // Fold a value that is a compile-time constant (a `const`, or a synthesized immediate like agbcc's
  // `250 << 2` for a large sparse case) to a number — else null.
  const evalConst = (v: Value): number | null => {
    if (isNamed(v)) {
      return null;
    } // a named variable is not a constant
    const d = defs.get(v);
    if (!d) {
      return null;
    }
    if (d.opcode === 'const') {
      return (d.attrs.value as number) | 0;
    }
    // Resolve the two operands of a binary op to constants (2-operand → both; 1-operand → operand +
    // `imm` attr, which MUST be present, else decline — a missing imm would wrongly fold `and x` to 0).
    const operands2 = (): [number, number] | null => {
      const a = evalConst(d.operands[0]);
      if (a === null) {
        return null;
      }
      let c: number | null;
      if (d.operands.length === 2) {
        c = evalConst(d.operands[1]);
      } else if (typeof d.attrs.imm === 'number') {
        c = d.attrs.imm | 0;
      } else {
        return null;
      }
      return c === null ? null : [a, c];
    };
    const bin = (f: (a: number, c: number) => number): number | null => {
      const p = operands2();
      return p === null ? null : f(p[0], p[1]) | 0;
    };
    const shift = (f: (a: number, c: number) => number): number | null => {
      const p = operands2();
      if (p === null || p[1] < 0 || p[1] >= 32) {
        return null;
      } // out-of-range shift amount → decline
      return f(p[0], p[1]) | 0;
    };
    switch (d.opcode) {
      case 'shl':
        return shift((a, c) => a << c);
      case 'shr_u':
        return shift((a, c) => a >>> c);
      case 'shr_s':
        return shift((a, c) => a >> c);
      case 'or':
        return bin((a, c) => a | c);
      case 'and':
        return bin((a, c) => a & c);
      case 'xor':
        return bin((a, c) => a ^ c);
      case 'add':
        return bin((a, c) => a + c);
      case 'sub':
        return bin((a, c) => a - c);
      case 'neg': {
        const a = evalConst(d.operands[0]);
        return a === null ? null : -a | 0;
      }
      case 'not': {
        const a = evalConst(d.operands[0]);
        return a === null ? null : ~a | 0;
      }
      default:
        return null;
    }
  };

  // TWO QUESTIONS about a block, asked separately because the answers diverge and the walk needs
  // both: WHAT does it test (`testInfo`), and may this recovery DISCARD it (`collapsible`)?
  //
  // PRE4 (purity) is the second. A collapsed test block's ops re-render at whichever use inlines
  // them, at a point the switch decides — so the question is motion, not deletion, and
  // `ORDER_SENSITIVE_OPS` is the set that asks it. NOT the trapping divides: a use is dominated by
  // its def, so the re-rendered op runs on a subset of the paths it already ran on — nothing is
  // speculated. `emitsOwnStatement` covers what motion cannot save: a statement belonging to the
  // block rather than to a use. The root is exempt from all of it — its ops are already emitted as
  // sideEffects(b) before the switch.
  //
  // A block that tests the scrutinee and is NOT collapsible is still dispatch, so the walk must
  // read it as dispatch and decline, never re-read it as a case body — that would spell an arm
  // whose guard the dispatch has already decided.
  interface TestInfo {
    x: Value;
    k: number;
    cls: 'eq' | 'ne' | 'rel';
    opcode: string;
    xOnLeft: boolean;
  }
  const collapsible = (blk: Block): boolean =>
    !blk.ops.some((op) => ORDER_SENSITIVE_OPS.has(op.opcode)) && !emitsOwnStatement(blk);
  const testInfo = (blk: Block): TestInfo | null => {
    const term = blk.ops[blk.ops.length - 1];
    if (term.opcode !== 'cond_br') {
      return null;
    }
    const cmp = defs.get(term.operands[0]);
    if (!cmp || !isCmpOpcode(cmp.opcode)) {
      return null;
    }
    // Which operand is the scrutinee, which is the constant?
    const [lo, ro] = cmp.operands;
    const lc = evalConst(lo),
      rc = evalConst(ro);
    let x: Value, k: number, xOnLeft: boolean;
    if (lc === null && rc !== null) {
      x = lo;
      k = rc;
      xOnLeft = true;
    } else if (rc === null && lc !== null) {
      x = ro;
      k = lc;
      xOnLeft = false;
    } else {
      return null;
    } // both/neither const
    const cls = cmp.opcode === 'icmp_eq' ? 'eq' : cmp.opcode === 'icmp_ne' ? 'ne' : 'rel';
    return { x, k, cls, opcode: cmp.opcode, xOnLeft };
  };

  // Evaluate a test predicate for a CONCRETE scrutinee value — used to SIMULATE the decision tree and
  // verify recovered case values (below). Returns true iff the `taken` (successors[0]) edge is followed.
  // Signed/unsigned per the icmp opcode (PRE3, done concretely rather than via interval lattices).
  const evalCmp = (opcode: string, xOnLeft: boolean, xv: number, k: number): boolean => {
    const uns = opcode.startsWith('icmp_u');
    const [xn, kn] = uns ? [xv >>> 0, k >>> 0] : [xv | 0, k | 0];
    const [l, r] = xOnLeft ? [xn, kn] : [kn, xn]; // put the scrutinee where it textually appears
    switch (opcode) {
      case 'icmp_eq':
        return l === r;
      case 'icmp_ne':
        return l !== r;
      case 'icmp_slt':
      case 'icmp_ult':
        return l < r;
      case 'icmp_sle':
      case 'icmp_ule':
        return l <= r;
      case 'icmp_sgt':
      case 'icmp_ugt':
        return l > r;
      case 'icmp_sge':
      case 'icmp_uge':
        return l >= r;
      default:
        return false;
    }
  };

  // Which single scrutinee value does this relational test's BRANCH admit, if exactly one? A
  // relational side is a HALF-LINE in the compare's own ordering, so it can hold one value only at
  // a domain endpoint — which is why testing the two endpoints and their neighbours decides it,
  // with no interval lattice. `x < 1` over an unsigned scrutinee admits `{0}` and is agbcc's
  // spelling of `case 0` in a balanced search: `emit_case_nodes` tests the subtree BOUND, not the
  // value, whenever the remaining range has collapsed to one. Read as navigation instead, that
  // arm's body becomes a second default candidate and the whole tree declines.
  //
  // THE BRANCH, never the fall-through. Every jump in `emit_case_nodes` that lands on a case body
  // is its test's BRANCH — for a single-valued node, LT to `node->left->code_label` and GT to
  // `node->right->code_label`, each guarded by `node_is_bounded` on that side — while the
  // fall-through always continues into more dispatch, so a fall-side reading has no producer in
  // this dispatch — and none turns up in 3176 generated agbcc dispatches.
  //
  // TWO PREMISES ABOUT THE DOMAIN. It is the 32-bit REGISTER's, not the scrutinee's recovered
  // type, so a narrower type has a nearer endpoint this misses — which costs a case and never
  // invents one. And it is the WHOLE of that domain, so an ancestor that already excluded the
  // value makes the reading wrong; PRE3 is what catches that, simulating the original tree for
  // every recovered case value and declining unless it lands on the recorded body, exactly as it
  // does for the `eq` cases. Null when the branch admits none, several, or the whole domain.
  const singletonTaken = (ti: TestInfo): number | null => {
    const [min, max] = ti.opcode.startsWith('icmp_u') ? [0, -1] : [-0x80000000, 0x7fffffff];
    for (const [v, next] of [
      [min, min + 1],
      [max, max - 1],
    ]) {
      if (evalCmp(ti.opcode, ti.xOnLeft, v, ti.k) && !evalCmp(ti.opcode, ti.xOnLeft, next, ti.k)) {
        return v;
      }
    }
    return null;
  };

  // Where does one arm's region LEAVE? Walk it from `entry`, never stepping THROUGH the merge or a
  // sibling arm's entry, and classify what it steps INTO. `siblings` is every OTHER arm entry the
  // caller can emit a `case`/`default` label for — the merge is deliberately not among them, so a
  // switch whose default block IS the merge (agbcc's usual "the default just leaves") reads as an
  // ordinary `break`, not as falling into the default.
  //
  // Region membership is `dom(blk) ∋ b` as before: a block NOT dominated by the switch is outside
  // this switch's region and is not walked. It IS recorded as an escape, because an arm that can
  // leave sideways does not fall into the next case — but only the fall-through verdict consults
  // that, so no arm that used to be accepted as closed becomes a decline.
  //
  // A CONSEQUENCE, not a hole: a sibling reachable only THROUGH such a block is never seen, so the
  // arm reads as closed and `structureRegion` walks into the sibling's blocks and emits them again
  // under this arm. That is duplication, not a wrong dispatch — the same duplication the structurer
  // already does for any tail two arms share, and how the case bodies agbcc tail-merged are put
  // back. Costly for matching, correct to run.
  const analyzeArmExit = (entry: Block, b: Block, merge: Block | null, siblings: Set<Block>): ArmExit => {
    if (entry === merge) {
      return { kind: 'break' }; // an empty arm (a table slot pointing straight at the switch's end)
    }
    const into = new Set<Block>(); // sibling entries this arm flows into
    let toMerge = false,
      escapes = false;
    const seen = new Set<Block>([entry]);
    const q = [entry];
    while (q.length) {
      const cur = q.pop()!;
      for (const s of successorsOf(cur)) {
        if (s === merge) {
          toMerge = true;
        } else if (s !== entry && siblings.has(s)) {
          into.add(s);
        } else if (s !== entry && !seen.has(s)) {
          if (!dom.get(s)!.has(b)) {
            escapes = true;
            continue;
          }
          seen.add(s);
          q.push(s);
        }
      }
    }
    if (into.size === 0) {
      return { kind: 'break' };
    }
    if (into.size === 1 && !toMerge && !escapes) {
      return { kind: 'fallthrough', to: [...into][0] };
    }
    // Name what is actually missing. These three are different facts, and only the first is a shape
    // C has no spelling for — the other two are asmlift's own limits, so say so rather than blame C.
    const names = () => [...into].map((x) => `#${fn.blocks.indexOf(x)}`).join(', ');
    if (into.size > 1) {
      return {
        kind: 'unstructurable',
        why: `a case body reaches several sibling cases (${names()}) — C fall-through reaches only one, so this needs a goto`,
      };
    }
    if (escapes) {
      return {
        kind: 'unstructurable',
        why: `a case body reaches sibling case ${names()} on one path and, on another, a block the switch does not dominate`,
      };
    }
    return {
      kind: 'unstructurable',
      // `case 0: if (c) { …; break; } /* fall through */ case 1:` is the C for this, and the reason
      // asmlift cannot write it is its own: `{k:'break'}` is emitted only for the innermost LOOP
      // (l3/ast.ts), never switch-scoped. That is the capability this shape is waiting on.
      why: `a case body reaches sibling case ${names()} on one path and the end of the switch on another — a switch-scoped \`break\` inside a case body is not emitted yet`,
    };
  };

  /** Re-thread `order` so every FALLING arm sits directly above the arm it falls into. Each
   *  fall-through chain is emitted contiguously and takes the position of its HEAD in `order`,
   *  which is the caller's own arm-order policy — so with no fall-through every chain is a
   *  singleton and `order` comes back unchanged. `dflt` is the `default:` arm's block when it has
   *  one, and it is pinned LAST because that is where C prints the label.
   *
   *  THREE REFUSALS (null ⇒ the caller declines), each a shape no single linear order spells:
   *    - two arms falling into the SAME arm — C drops into an arm from above along one edge only;
   *    - the `default:` arm falling into a case, since nothing is emitted below it;
   *    - a fall-through CYCLE, whose members are all fallen-into and so are never a chain head. */
  const chainArms = (order: Block[], dflt: Block | null, exitOf: Map<Block, ArmExit>): Block[] | null => {
    const next = new Map<Block, Block>();
    const fallenInto = new Set<Block>();
    for (const e of [...order, ...(dflt ? [dflt] : [])]) {
      const x = exitOf.get(e);
      if (x?.kind !== 'fallthrough') {
        continue;
      }
      if (e === dflt || fallenInto.has(x.to)) {
        return null;
      }
      fallenInto.add(x.to);
      next.set(e, x.to);
    }
    const chains: Block[][] = [];
    const seen = new Set<Block>();
    let intoDefault = -1;
    for (const head of order) {
      if (fallenInto.has(head)) {
        continue;
      }
      const chain: Block[] = [];
      for (
        let cur: Block | undefined = head;
        cur !== undefined && cur !== dflt && !seen.has(cur);
        cur = next.get(cur)
      ) {
        seen.add(cur);
        chain.push(cur);
      }
      if (dflt !== null && next.get(chain[chain.length - 1]) === dflt) {
        intoDefault = chains.length;
      }
      chains.push(chain);
    }
    // A cycle's every member is fallen-into, so none of them is a head and none is walked.
    if (seen.size !== order.length) {
      return null;
    }
    if (intoDefault >= 0) {
      chains.push(...chains.splice(intoDefault, 1));
    }
    return chains.flat();
  };

  const recognizeSwitch = (b: Block, stop: Block | null): Stmt[] | null => {
    const root = testInfo(b);
    if (!root) {
      return null;
    }
    const scrut = root.x;
    // PRE1 (scrutinee identity + dominance): the scrutinee is a single raw SSA Value that must DOMINATE
    // the whole region. A block param (phi) is rejected — it is not one definition across the region.
    // Params are seeded into names (isNamed); a value defined by an op has a defining block that must dominate
    // b. Function params (entry params) dominate everything.
    const scrutDef = defs.get(scrut);
    const entryBlk = fn.blocks[0];
    if (scrutDef) {
      const defBlk = opBlock.get(scrutDef)!;
      if (!dom.get(b)!.has(defBlk)) {
        return null;
      }
    } else if (!entryBlk.params.includes(scrut)) {
      return null; // a non-entry block param → decline
    }

    // Walk the test tree. `cases`: value → case-entry block. `defaultCands`: leaves reached without an
    // equality pin. A test-block DAG cycle, or a `!=` case when the compiler disallows it, declines.
    const cases = new Map<number, Block>();
    // Reached through `forwardingTarget`: agbcc's binary-search layout branches to the shared default
    // through empty `b .Ldef` blocks, and without resolving them each becomes a DISTINCT default
    // candidate and the whole tree declines.
    const defaultCands = new Set<Block>();
    // Concretely SIMULATE the decision tree for a scrutinee value `xv`, returning the leaf block it
    // reaches (or null on an unexpected cycle). This is PRE3 done concretely: it lets us verify each
    // recovered case value actually routes to its recorded body in the ORIGINAL tree.
    const simulateTree = (xv: number): Block | null => {
      let cur = b;
      const guard = new Set<Block>();
      for (;;) {
        const ti = testInfo(cur);
        if (!ti || ti.x !== scrut) {
          return cur;
        } // reached a leaf (case body / default)
        if (guard.has(cur)) {
          return null;
        }
        guard.add(cur);
        const term = cur.ops[cur.ops.length - 1];
        const taken = evalCmp(ti.opcode, ti.xOnLeft, xv, ti.k);
        cur = forwardingTarget(term.successors[taken ? 0 : 1].block);
      }
    };
    const seen = new Set<Block>();
    const work: Block[] = [b];
    while (work.length) {
      const blk = work.pop()!;
      if (seen.has(blk)) {
        return null;
      } // a test-block DAG cycle → decline
      seen.add(blk);
      const ti = testInfo(blk);
      if (!ti || ti.x !== scrut) {
        return null;
      } // PRE1: every test is on the SAME Value
      if (blk !== b && !collapsible(blk)) {
        return null;
      } // PRE4
      const term = blk.ops[blk.ops.length - 1];
      const taken = forwardingTarget(term.successors[0].block),
        fall = forwardingTarget(term.successors[1].block);
      const isTestOn = (child: Block) => {
        const t = testInfo(child);
        return !!t && t.x === scrut;
      };
      const asLeafOrTest = (child: Block, role: 'case' | 'nav', k?: number) => {
        const isTest = isTestOn(child);
        if (role === 'case') {
          if (isTest) {
            return false;
          } // a case target that's a test → decline
          // A case entry with a PHI is admitted: the dispatch edge binds those parameters, and
          // `hoistDispatchCopies` re-emits that binding once above the `switch` (or declines the
          // whole recovery). Refusing it here cost `sw_fall` its `switch` outright — a
          // fall-through chain's accumulator crosses every arm as exactly such a parameter.
          if (cases.has(k!)) {
            return false;
          } // duplicate case value → decline
          cases.set(k!, child);
          return true;
        }
        // navigation edge
        if (isTest) {
          work.push(child);
          return true;
        }
        defaultCands.add(child); // a non-test leaf reached by nav = default
        return true;
      };
      if (ti.cls === 'eq') {
        if (!asLeafOrTest(taken, 'case', ti.k)) {
          return null;
        } // x==k → taken is case k
        if (!asLeafOrTest(fall, 'nav')) {
          return null;
        }
      } else if (ti.cls === 'ne') {
        if (!switchAllowsNeqCase) {
          return null;
        } // per-compiler gate
        if (!asLeafOrTest(fall, 'case', ti.k)) {
          return null;
        } // x!=k → the EQUAL side (fall) is case k
        if (!asLeafOrTest(taken, 'nav')) {
          return null;
        }
      } else {
        // relational → navigation, except where the BRANCH has collapsed to a single value and
        // lands on a BODY, on a compiler that declared the spelling. Two more refusals:
        //   - a bound test at the ROOT. `emit_case_nodes` emits a single-valued node's own
        //     `do_jump_if_equal` before either descent test, so a bound test always sits under
        //     another test of the same tree; one that OPENS the region did not come from this
        //     dispatch, and reading it as a case turns a comparison chain into a `switch`;
        //   - a singleton branch onto another TEST of the scrutinee, which is the search
        //     descending to pin the value. It is dispatch, so the walk reads it as dispatch —
        //     recovering it, or declining at PRE4 if it is not collapsible.
        const k = switchAllowsBoundCase && blk !== b && !isTestOn(taken) ? singletonTaken(ti) : null;
        if (!asLeafOrTest(taken, k === null ? 'nav' : 'case', k ?? undefined)) {
          return null;
        }
        if (!asLeafOrTest(fall, 'nav')) {
          return null;
        }
      }
    }

    if (cases.size < 2) {
      return null;
    } // not worth a switch (m2c: ≥2 cases)
    // The default is the single non-test leaf that is NOT a case body. 0 → no default; ≥2 distinct → decline.
    const caseBlocks = new Set(cases.values());
    const leaves = [...defaultCands].filter((d) => !caseBlocks.has(d));
    // RESOLVE THROUGH a bare jump onto another candidate. `forwardingTarget` (ir/core.ts) stops at
    // a `br` that carries block ARGUMENTS — skipping it would drop the values it supplies — so a
    // leaf holding `b .Ldefault(v)` and `.Ldefault` itself arrive here as two distinct candidates
    // even though one merely jumps to the other. They are not two defaults: the jumping leaf emits
    // nothing of its own, and the values its `br` hands the other's parameters are the values the
    // DISPATCH hands them. So it is one more dispatch edge — hoisted with the rest, where the
    // hoist's disagreement rule decides whether the two paths can share one statement.
    //
    // A cycle of such jumps has no target to resolve to and declines. Leaves that pass DIFFERENT
    // values, or that have a body, are untouched by this and are still two defaults below.
    const throughEdges: { pred: Block; succ: { block: Block; args: Value[] } }[] = [];
    const resolveDefault = (d: Block): Block | null => {
      const walked = new Set<Block>();
      let cur = d;
      for (;;) {
        if (walked.has(cur)) {
          return null;
        }
        walked.add(cur);
        const t = cur.ops[0];
        if (!isBareExit(cur) || t.opcode !== 'br' || !leaves.includes(t.successors[0].block)) {
          return cur;
        }
        throughEdges.push({ pred: cur, succ: t.successors[0] });
        cur = t.successors[0].block;
      }
    };
    const defaults: Block[] = [];
    for (const d of leaves) {
      const r = resolveDefault(d);
      if (r === null) {
        return null;
      }
      if (!defaults.includes(r)) {
        defaults.push(r);
      }
    }
    // ONE default reached by SEVERAL leaves. `balance_case_nodes`/`emit_case_nodes` give each
    // subtree that runs out of case values its own jump to the default, so agbcc's four-case tree
    // reaches it through two `b .Ldefault` blocks, which comparing candidates by BLOCK would count
    // as two different defaults and decline. Two leaves are the same default when each is
    // a bare EXIT to the same place carrying the same values: nothing about them can then differ,
    // so the representative emits what either would. Anything else — a leaf with a body, two
    // leaves passing different values — is still two defaults and still declines.
    if (defaults.length > 1 && !defaults.every((d) => sameBareExit(defaults[0], d))) {
      return null;
    }
    const defaultBlk = defaults[0] ?? null;
    // A default entry that takes BLOCK PARAMETERS is admitted on the same terms a case entry is:
    // the dispatch edge binds them and `hoistDispatchCopies` re-emits that binding above the
    // `switch`. It was refused while nothing re-emitted it — `switch (x) { case 1: … case 2: … }`
    // whose fall-out edge also carried `w = 0` would have dropped that write silently — and the
    // hoist is exactly what makes the fall-out arm spell the value the dispatch handed it.
    // A default candidate that is ALSO a case body means a relational edge hit a case leaf → ambiguous.
    if ([...defaultCands].some((d) => caseBlocks.has(d))) {
      return null;
    }

    // PRE1 dominance of the whole region: b must dominate every case body + the default (single-entry).
    for (const cb of caseBlocks) {
      if (!dom.get(cb)!.has(b)) {
        return null;
      }
    }
    if (defaultBlk && !dom.get(defaultBlk)!.has(b)) {
      return null;
    }

    // PRE2 (arm exits), per SITE. A `break` arm closes; a `fallthrough` arm runs on into the one
    // sibling it reaches, which `chainArms` then places directly under it. `unstructurable` is a
    // shape no single linear switch spells — a body reaching two siblings, or a sibling on one path
    // and the switch's end on another — and Regime A declines to if-recovery, which spells every
    // one of those edges. (Regime B reads the same verdicts and fails LOUD on either.)
    const merge = ipdom.get(b) ?? stop;
    const targets = new Set<Block>([...caseBlocks, ...(defaultBlk ? [defaultBlk] : [])]);
    const siblings = new Set([...targets].filter((t) => t !== merge));
    const exitOf = new Map<Block, ArmExit>();
    for (const t of siblings) {
      exitOf.set(t, analyzeArmExit(t, b, merge, siblings));
    }
    // A language with no fall-through in its `case` (Pascal) cannot print a falling arm at all, so
    // for it a falling arm is exactly as unspellable as an `unstructurable` one — and takes the
    // same exit: if-recovery, which that backend prints fine. Asked HERE rather than left to the
    // backend because the backend's refusal is terminal (the whole function becomes a stub) while
    // this one costs nothing but the `switch` spelling.
    if (
      [...exitOf.values()].some(
        (e) => e.kind === 'unstructurable' || (!spellSwitchFallthrough && e.kind === 'fallthrough'),
      )
    ) {
      return null;
    }

    // PRE3 (concrete interval consistency): a `case k` is only sound if the ORIGINAL tree
    // actually routes x==k to its recorded body. A relational guard can make an `x==k` test DEAD (e.g.
    // `if(x<5){ if(x==20) … }` — x==20 is unreachable under x<5); a naive switch would resurrect `case 20`
    // and misroute x==20. Simulating the tree per case value catches exactly this — decline on any mismatch.
    for (const [k, blk] of cases) {
      if (simulateTree(k) !== blk) {
        return null;
      }
    }

    // ARM ORDER. The case values are disjoint (PRE3), so where no arm falls through the order
    // carries no meaning and is pure matching evidence: ascending case VALUE is the neutral
    // spelling, and where a compiler has declared `switchArmsFollowLayout` the layout of the bodies
    // is the SOURCE's arm order instead. A FALLING arm's position is not free, and `chainArms`
    // below re-threads this order for those — reading it for the chain HEADS only.
    //
    // TWO arms the layout cannot order, both falling back rather than recovering:
    //   - two case VALUES sharing one body block share its index, so the tie is one the merge (or
    //     the source's own stacked labels) erased, and ascending value breaks it. They become ONE
    //     arm below, so the tie only orders that arm against the others. ADJACENT stacked labels
    //     never get here: `case 2: case 3:` compiles to a range test the walk reads as navigation
    //     and declines, while `case 0: case 2:` compiles to the two equality tests it recovers —
    //     both checked against agbcc;
    //   - an arm with no body of its own (`case k: break;`) has its edge resolve to the MERGE, so it
    //     inherits the merge's index and sorts after every arm that HAS a body.
    //
    // BOOKED, UNPAID: the grouping makes arm ORDER observable on a shape the ascending-value
    // fallback did not have before, and IDO turns out to lay case bodies out in SOURCE order too —
    // the same function with `case 1:` written first and last differ (.text md5 ec39af99 against
    // 689f34ec, 144 bytes each), which is what `switchArmsFollowLayout` recovers. target.ts sets
    // the bar for opting a compiler in at a SOURCE-level argument about its passes, not at two
    // objects, and that argument is unpaid for IDO; nothing here changes while it is. What the
    // grouping cannot do is make a non-agbcc row worse, because the ungrouped spelling is not a
    // rival there: under IDO it compiles to two copies and a different ROM entirely.
    const scrutExpr = expr(scrut);
    const sortedCases = [...cases.entries()].sort((a, c) =>
      switchArmsFollowLayout ? layoutIndex(a[1]) - layoutIndex(c[1]) || a[0] - c[0] : a[0] - c[0],
    );
    // TWO VALUES ONE BODY IS ONE ARM. `SwitchCase.values` stacks labels for exactly this, and the
    // jump-table regime groups the same way (structure.ts's `armOf`). Emitting the body once per
    // label is `structureRegion` run twice over one block: a duplication, not a spelling choice.
    //
    // WHY BLOCK IDENTITY IS THE KEY, and not a body-equality one like `sameBareExit` above. agbcc
    // MERGES two written-out copies into one block — target.ts's `switchArmsFollowLayout` note
    // says so from agbcc's own sources, SRCS compiling jump.c — and compiling both directions at
    // TOOLCHAIN.agbccFlags says WHERE the merged block lands: at the last copy's position. So
    // `case 0: A break; case 1: … case 2: A break;` and the grouped arm placed THERE are one
    // object (.text md5 555abb1a), while the grouped arm placed at the first value is not
    // (fe4d7d35). That is why the grouped spelling round-trips rather than merely reading shorter:
    // agbcc declares `switchArmsFollowLayout`, so the arm goes exactly where the merged block sits.
    // IDO does not merge at all — 224 bytes against the grouped 144 — so on MIPS a shared block can
    // only have come from stacked labels. Two DISTINCT blocks with equal bodies therefore mean one
    // arm on neither compiler: under agbcc that ROM is unreachable, under IDO it is what two arms
    // compile to. Sound also because a case entry with a phi already declined above
    // (`asLeafOrTest`), so two edges onto one body bind nothing that could differ.
    //
    // An arm takes the position of its FIRST value, which keeps the sort above. `defaultLayoutPos`
    // is handed the GROUPED entry list because what it returns is an INDEX INTO the arm array, so
    // the list it counts and the list it indexes must be one list.
    const armsByBlock = new Map<Block, number[]>();
    for (const [k, blk] of sortedCases) {
      const prev = armsByBlock.get(blk);
      if (prev) {
        prev.push(k);
      } else {
        armsByBlock.set(blk, [k]);
      }
    }
    // The `default:` arm is a chain member too — an arm may run on into it, and C prints it last.
    const dfltArm = defaultBlk !== null && defaultBlk !== merge ? defaultBlk : null;
    const preChain = [...armsByBlock.keys()];
    const entries = chainArms(preChain, dfltArm, exitOf);
    if (entries === null) {
      return null;
    }
    // Did the chain move anything? The arm-order POLICY above produced `preChain`; where the chain
    // left it alone, every position still means what that policy said it meant.
    const orderIntact = entries.every((e, i) => e === preChain[i]);
    const fallsInto = (blk: Block): Block | null => {
      const x = exitOf.get(blk);
      return x?.kind === 'fallthrough' ? x.to : null;
    };
    // THE DISPATCH HOIST. Every edge the tree walk is about to COLLAPSE — from any test block, to
    // a case entry, a default candidate, the merge, or another test block — carries the parallel
    // copy that binds its target's parameters, and collapsing the tree is what would discard it.
    // Merge those copies and emit them ONCE, above the `switch`. Placed FIRST because it is
    // emitted first and `argAssignsFor` mints swap-cycle temp names as it goes.
    //
    // TWO CONDITIONS ARE THIS REGIME'S OWN, and both must hold before the emission is asked for:
    //
    //  - AVAILABILITY AT THE ROOT. A hoisted copy is evaluated at `b`, not on its edge, so every
    //    argument it reads must be defined at a block that DOMINATES `b`. An argument computed
    //    inside a collapsed test block is not: the tree reaches that block only on some paths,
    //    while the hoist runs on all of them, and re-rendering it above the dispatch would
    //    SPECULATE it. (That is the one invariant PRE4's "a use is dominated by its def, so a
    //    collapsed op runs on a subset of the paths it already ran on" does not give the hoist,
    //    which is why the hoist asks for it here rather than inheriting it.)
    //  - The emission's own two refusals, stated at `hoistedDispatchAssigns`: edges disagreeing
    //    about one name, and a hoisted name whose value is still live at the switch or into an arm.
    //
    // Either way the answer is a decline to if-recovery, which spells every copy the asm performs.
    const availableAtRoot = (v: Value): boolean => {
      const d = defs.get(v);
      const home = d ? opBlock.get(d) : paramBlock.get(v);
      return home !== undefined && dom.get(b)!.has(home);
    };
    const dispatchEdges: { pred: Block; succ: { block: Block; args: Value[] } }[] = [];
    for (const t of [...seen, ...throughEdges.map((e) => e.pred)]) {
      for (const e of t.ops[t.ops.length - 1].successors) {
        if (e.block.params.length === 0) {
          continue;
        }
        if (!e.args.every(availableAtRoot)) {
          return null;
        }
        dispatchEdges.push({ pred: t, succ: e });
      }
    }
    const hoisted = hoistDispatchCopies(dispatchEdges, [
      b,
      ...caseBlocks,
      ...(defaultBlk ? [defaultBlk] : []),
      ...(merge ? [merge] : []),
    ]);
    if (hoisted === null) {
      return null;
    }
    // Bodies are structured in EMISSION order — `argAssignsFor` mints swap-cycle temp names as it
    // goes, so building them out of order changes the output — and each falling arm's target is
    // re-read off that order rather than trusted from the ordering above: this is the seam where a
    // POSITION acquires control-flow meaning (the l3/ast.ts non-neutrality note).
    const outCases: SwitchCase[] = [];
    for (const [i, blk] of entries.entries()) {
      const to = fallsInto(blk);
      if (to !== null && to !== (entries[i + 1] ?? dfltArm)) {
        return null;
      }
      // The arm fallen INTO may take block parameters, and the TWO paths that reach it are spelled
      // in two different places: entering by its own case value takes the hoisted copy above the
      // `switch` (`hoistDispatchCopies`), while FALLING in takes the copies the falling arm's own
      // `br` emits as its last statements (`structureRegion(blk, to)` walks that terminator, so
      // they are already there). This is the seam where breaking the rule would be SILENT, which
      // is why it was the conservative refusal until the hoist existed to pay for it.
      //
      // Regime B still refuses the same hazard LOUD at its own `switch_br` path, on the weaker
      // predicate that fits it (the copies `argAssignsFor` actually produced): its arms take their
      // edge copies PER ARM, so a fall-through path would re-run them over what the falling arm
      // computed. Hoisting is what removes that hazard, and Regime B does not hoist — booked there,
      // not built, and no row asks for it (`sw_jtfall`/`sw_jtfalldesc` match today).
      outCases.push({
        values: armsByBlock.get(blk)!,
        body: structureRegion(blk, to ?? merge),
        fallsThrough: to !== null,
      });
    }
    // An empty default arm is not a default (see the Regime-B note in structure.ts): the label
    // would carry no statement, which says nothing and is not valid C89.
    const defBody = defaultBlk ? structureRegion(defaultBlk, merge) : [];
    // The `default:` arm is an ARM: where its block is laid out is read exactly as a case body's is
    // (`defaultLayoutPos`). The dispatch placed that block itself when the last test simply RAN OUT
    // into it and no other subtree jumps there — the two references the tree walk can count.
    const dispatchTargets = [...seen].flatMap((t) =>
      t.ops[t.ops.length - 1].successors.map((e) => forwardingTarget(e.block)),
    );
    const ranOutInto = (blk: Block) =>
      [...seen].some((t) => {
        const succ = t.ops[t.ops.length - 1].successors;
        return succ.length > 1 && succ[1].block === blk;
      }) && dispatchTargets.filter((e) => e === blk).length < 2;
    // `defaultLayoutPos` owns which POSITIONS a chain makes unreadable — see its three
    // fall-through withholdings. A chain elsewhere in the switch does not delete the evidence for
    // where the label goes, and reading it off the emitted arms is what lets a `default:` written
    // between two closed arms keep its place while a chain runs beside it.
    const defaultAt = defaultBlk
      ? defaultLayoutPos(
          defaultBlk,
          entries.map((e, i) => ({ entry: e, fallsThrough: outCases[i].fallsThrough })),
          { placedByDispatch: ranOutInto(defaultBlk), orderIntact },
        )
      : undefined;
    const sw: Stmt = {
      k: 'switch',
      scrutinee: scrutExpr,
      cases: outCases,
      ...(defBody.length ? { default: defBody, ...(defaultAt !== undefined ? { defaultAt } : {}) } : {}),
    };
    const out: Stmt[] = [...hoisted, sw];
    if (merge && merge !== stop) {
      out.push(...structureRegion(merge, stop));
    }
    return out;
  };
  return { recognizeSwitch, analyzeArmExit, layoutIndex, defaultLayoutPos, chainArms };
}
