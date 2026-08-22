// asmlift structurer — Regime-A SWITCH RECOVERY: recognise a comparison tree over a single
// scrutinee rooted at a cond_br and rebuild the `switch` — or DECLINE (null) to plain
// if-recovery, which is behaviourally identical (a clean nonmatch, never a miscompile). The
// factory takes its dependencies EXPLICITLY (`SwitchRecoverDeps`); `expr`/`structureRegion` are
// late-bound callbacks into the emission phase, so case bodies reuse the ordinary structuring
// machinery (loops/ifs inside cases, the onStack guard).
import { Block, Fn, Op, Value, forwardingTarget, successorsOf } from '../ir/core';
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
  /** emit the case arms in the ASSEMBLY's block-layout order rather than by ascending case value */
  switchArmsFollowLayout: boolean;
  /** does emitting this block's ops carry a statement beyond the ops themselves? A def-site
   *  ANCHORED merge copy (structure.ts anchorConstCopies) is attached to a const op and emitted
   *  with the block's side effects — a test block carrying one is not pure however pure its
   *  opcodes look, because collapsing it into a `switch` discards the write while the edge copy
   *  it replaced stays suppressed. */
  emitsAnchoredWrite: (blk: Block) => boolean;
  expr: (v: Value) => Expr;
  structureRegion: (b: Block, stop: Block | null) => Stmt[];
}

/** Where ONE switch arm's region leaves it — the fact that decides whether the arm can be spelled
 *  as C at all, and with or without a `break`.
 *
 *   - `break`        every path out of the arm reaches the switch's merge (or returns / loops
 *                    inside the arm). The ordinary closed arm.
 *   - `fallthrough`  every path out leaves into exactly ONE sibling arm's entry: C's fall-through.
 *                    Only spellable when that sibling is the arm emitted NEXT (the caller checks
 *                    emission adjacency — see the l3/ast.ts non-neutrality note).
 *   - `unstructurable`  anything else: two different siblings, or a mix of "into a sibling" and
 *                    "out to the merge". C needs a `goto` for those, so callers decline LOUD. */
export type ArmExit = { kind: 'break' } | { kind: 'fallthrough'; to: Block } | { kind: 'unstructurable'; why: string };

export interface SwitchRecovery {
  recognizeSwitch: (b: Block, stop: Block | null) => Stmt[] | null;
  /** shared with the Regime-B (`switch_br`) path in structure.ts, which recovers the fall-through
   *  this returns; Regime A only accepts `break` arms and otherwise declines to if-recovery. */
  analyzeArmExit: (entry: Block, b: Block, merge: Block | null, siblings: Set<Block>) => ArmExit;
  /** a block's position in the ASSEMBLY — the arm-order evidence, shared with Regime B so the two
   *  regimes read it from one definition (and one statement of what it rests on). */
  layoutIndex: (blk: Block) => number;
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
    switchArmsFollowLayout,
    emitsAnchoredWrite,
    expr,
    structureRegion,
  } = deps;

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

  /** Are these two blocks the SAME bare jump — no params, one `br`, same target, same args? Such a
   *  block has no body of its own, so two of them are indistinguishable at emission. */
  const sameBareJump = (a: Block, c: Block): boolean => {
    if (a === c) {
      return true;
    }
    for (const blk of [a, c]) {
      if (blk.params.length || blk.ops.length !== 1 || blk.ops[0].opcode !== 'br') {
        return false;
      }
    }
    const [x, y] = [a, c].map((blk) => blk.ops[0].successors[0]);
    return x.block === y.block && x.args.length === y.args.length && x.args.every((v, i) => v === y.args[i]);
  };

  // --- Regime A: comparison-tree switch recovery ----------------------------------------------------
  // Every ambiguity declines. Four preconditions are enforced below, annotated PRE1..PRE4:
  // scrutinee identity/dominance, no fall-through, concrete interval consistency, test purity.

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

  // A "pure test block": its only computation is constants + one integer comparison feeding its
  // cond_br terminator. PRE4 (purity). The block does not VANISH when the tree collapses to a
  // switch — its ops re-render at whichever use inlines them, at a point the switch decides — so
  // the question is motion, not deletion, and `ORDER_SENSITIVE_OPS` is the set that asks it. NOT
  // the trapping divides: a use is dominated by its def, so the re-rendered op runs on a subset of
  // the paths it already ran on — nothing is speculated.
  // The root block is exempt from the
  // "only const/icmp" rule because its non-terminator ops are already emitted as sideEffects(b) before
  // the switch; a non-root test block must be strictly pure.
  interface TestInfo {
    x: Value;
    k: number;
    cls: 'eq' | 'ne' | 'rel';
    opcode: string;
    xOnLeft: boolean;
  }
  const testInfo = (blk: Block, isRoot: boolean): TestInfo | null => {
    const term = blk.ops[blk.ops.length - 1];
    if (term.opcode !== 'cond_br') {
      return null;
    }
    const cmp = defs.get(term.operands[0]);
    if (!cmp || !isCmpOpcode(cmp.opcode)) {
      return null;
    }
    if (!isRoot && (blk.ops.some((op) => ORDER_SENSITIVE_OPS.has(op.opcode)) || emitsAnchoredWrite(blk))) {
      return null;
    } // PRE4 — anchored writes included: discarded with the block, while their edge copies stay suppressed
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

  /** Every arm closed (`break`)? The precondition Regime A needs — it has a behaviourally identical
   *  fallback (if-recovery), so it declines on anything else instead of recovering fall-through. */
  const allArmsClosed = (targets: Set<Block>, b: Block, merge: Block | null): boolean => {
    const siblings = new Set([...targets].filter((t) => t !== merge));
    return [...siblings].every((t) => analyzeArmExit(t, b, merge, siblings).kind === 'break');
  };

  const recognizeSwitch = (b: Block, stop: Block | null): Stmt[] | null => {
    const root = testInfo(b, true);
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
        const ti = testInfo(cur, cur === b);
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
      const ti = testInfo(blk, blk === b);
      if (!ti || ti.x !== scrut) {
        return null;
      } // PRE1: every test is on the SAME Value
      const term = blk.ops[blk.ops.length - 1];
      const taken = forwardingTarget(term.successors[0].block),
        fall = forwardingTarget(term.successors[1].block);
      const asLeafOrTest = (child: Block, role: 'case' | 'nav', k?: number) => {
        const isTest = !!testInfo(child, false) && testInfo(child, false)!.x === scrut;
        if (role === 'case') {
          if (isTest) {
            return false;
          } // a case target that's a test → decline
          if (child.params.length) {
            return false;
          } // case entry with a phi → decline
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
        // relational → pure navigation
        if (!asLeafOrTest(taken, 'nav')) {
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
    const defaults = [...defaultCands].filter((d) => !caseBlocks.has(d));
    // ONE default reached by SEVERAL leaves. `balance_case_nodes`/`emit_case_nodes` give each
    // subtree that runs out of case values its own jump to the default, so agbcc's four-case tree
    // reaches it through two `b .Ldefault` blocks — and comparing candidates by BLOCK counted that
    // one default as two and declined the whole tree. Two leaves are the same default when each is
    // a BARE jump (no params, one `br`, no body of its own) to the same block passing the same
    // values: nothing about them can then differ, so the representative emits what either would.
    // Anything else — a leaf with a body, two leaves passing different values — is still two
    // defaults and still declines.
    if (defaults.length > 1 && !defaults.every((d) => sameBareJump(defaults[0], d))) {
      return null;
    }
    const defaultBlk = defaults[0] ?? null;
    // A default entry that takes BLOCK PARAMETERS. Collapsing the tree DISCARDS its edges, and an
    // edge's only emission is its parallel copy (structure.ts argAssignsFor) — so an entry the
    // dispatch hands values to would lose them: `switch (x) { case 1: … case 2: … }` where the
    // fall-out edge also carried `w = 0` would drop that write silently. Case entries are held to
    // the same rule where the walk records them (`asLeafOrTest`), by the same argument.
    //
    // The refusal is deliberately structural rather than "would these copies elide anyway", and
    // strictness costs nothing here for a reason about the compiler rather than about a corpus:
    // agbcc's `emit_case_nodes` reaches the default through a jump of its OWN — the bare
    // `b .Ldefault` blocks collapsed above — and that jump carries the copies into the default ARM,
    // so a dispatch branch handing the default entry its values directly is not a shape agbcc
    // emits. A compiler that does emit it declines LOUD to if-recovery, which spells every copy
    // the asm performs.
    if (defaultBlk && defaultBlk.params.length) {
      return null;
    }
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

    // PRE2 (fall-through): only NON-fall-through switches are handled — decline if any case body
    // can reach ANOTHER case body (or a default that has its own block) while staying inside the
    // region. (The SAME analysis serves the Regime-B path, which RECOVERS the adjacent-sibling
    // case as C fall-through instead of declining; A has if-recovery to fall back on, B does not.)
    const merge = ipdom.get(b) ?? stop;
    const targets = new Set<Block>([...caseBlocks, ...(defaultBlk ? [defaultBlk] : [])]);
    if (!allArmsClosed(targets, b, merge)) {
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

    // Build the switch. Bodies delegate to the existing structureRegion (loops/ifs inside cases,
    // the onStack guard — all reused).
    //
    // ARM ORDER. Every arm here is CLOSED (`allArmsClosed` above — Regime A declines fall-through
    // outright, unlike the `switch_br` path in structure.ts where emission order is load-bearing
    // for correctness), and the case values are disjoint (PRE3 simulates the tree per value), so
    // the order is free of meaning and pure matching evidence. Two orders are available:
    //   - ascending case VALUE, the neutral default, and all a compiler that reorders blocks
    //     leaves behind;
    //   - the order the ASSEMBLY lays the bodies out, which is the SOURCE's arm order for a
    //     compiler that emits case bodies as it walks the arms and never moves them afterwards.
    //     `switchArmsFollowLayout` is where such a compiler declares that (TargetDescription
    //     .compilerBehaviors), on its own evidence — never inherited.
    // Two case VALUES can share one body block, and they then have the same layout index — so
    // ascending value stays the tie-break. What produces such a tie on agbcc is jump.c's
    // CROSS-JUMP, which merges two arms with identical bodies into one block both `beq`s reach
    // (arms written 4, 0, 5, 3 with cases 4 and 3 both `n + 9` lay out as case 0, case 5, then one
    // shared block). Stacked labels are NOT that source: agbcc compiles `case 2: case 3: foo();`
    // to a range test (`cmp #3 / bgt`), which the walk reads as navigation and declines. So the
    // tie-break orders arms whose relative order the MERGE erased, where ascending value is the
    // neutral spelling rather than a recovered one.
    // The other way an arm has no layout evidence: one the source wrote with no body of its own
    // (`case k: break;`). Its dispatch edge resolves to the MERGE, so it inherits the merge's index
    // and sorts after every arm that HAS a body, wherever the source put it. That position is a
    // fallback, not a recovery — the assembly says nothing about it either way.
    const scrutExpr = expr(scrut);
    const sortedCases = [...cases.entries()].sort((a, c) =>
      switchArmsFollowLayout ? layoutIndex(a[1]) - layoutIndex(c[1]) || a[0] - c[0] : a[0] - c[0],
    );
    const outCases: SwitchCase[] = sortedCases.map(([k, blk]) => ({
      values: [k],
      body: structureRegion(blk, merge),
      fallsThrough: false,
    }));
    // An empty default arm is not a default (see the Regime-B note in structure.ts): the label
    // would carry no statement, which says nothing and is not valid C89.
    const defBody = defaultBlk ? structureRegion(defaultBlk, merge) : [];
    // The `default:` arm is an ARM, and where a default block is laid out is the same evidence the
    // case bodies carry: verified by compiling, `case 0, case 1, default, case 2, case 3` puts the
    // default's block third, and each of the five positions of a 3- and a 4-case switch lands its
    // block exactly where the source wrote it. Emitting the label last regardless moves every
    // instruction after it. The position is a COUNT of the arms laid out before the default; every
    // arm here is closed, so the label diverts nothing wherever it lands.
    //
    // SCOPE — a default the dispatch FALLS INTO has no position of its own. `emit_case_nodes`
    // reaches the default by a jump from each exhausted subtree, but when the last test simply
    // runs out, its fall-through block is the default's first block, placed there by the dispatch
    // rather than by the arm. Measured: `switch (x) { case 0: … case 1: … default: … }` lays that
    // block right after the tests with the REST of the same arm last, and writing the default
    // first compiles to identical instructions — the asm cannot tell the two spellings apart. So
    // recovery keeps the C-conventional last position there instead of inventing evidence.
    const fellInto = new Set<Block>();
    for (const t of seen) {
      const succ = t.ops[t.ops.length - 1].successors;
      if (succ.length > 1) {
        fellInto.add(succ[1].block);
      }
    }
    const defaultAt =
      switchArmsFollowLayout && defaultBlk && !fellInto.has(defaultBlk)
        ? sortedCases.filter(([, blk]) => layoutIndex(blk) < layoutIndex(defaultBlk)).length
        : undefined;
    const sw: Stmt = {
      k: 'switch',
      scrutinee: scrutExpr,
      cases: outCases,
      ...(defBody.length ? { default: defBody, ...(defaultAt !== undefined ? { defaultAt } : {}) } : {}),
    };
    const out: Stmt[] = [sw];
    if (merge && merge !== stop) {
      out.push(...structureRegion(merge, stop));
    }
    return out;
  };
  return { recognizeSwitch, analyzeArmExit, layoutIndex };
}
