// asmlift structurer — Regime-A SWITCH RECOVERY: recognise a comparison tree over a single
// scrutinee rooted at a cond_br and rebuild the `switch` — or DECLINE (null) to plain
// if-recovery, which is behaviourally identical (a clean nonmatch, never a miscompile). The
// factory takes its dependencies EXPLICITLY (`SwitchRecoverDeps`); `expr`/`structureRegion` are
// late-bound callbacks into the emission phase, so case bodies reuse the ordinary structuring
// machinery (loops/ifs inside cases, the onStack guard).
import { Block, Fn, Op, Value, successorsOf } from '../ir/core';
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
    emitsAnchoredWrite,
    expr,
    structureRegion,
  } = deps;

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
  // cond_br terminator (no store/call/load/opaque — its body is DISCARDED when the tree collapses to a
  // switch, so a side effect there would be lost). PRE4 (purity). The root block is exempt from the
  // "only const/icmp" rule because its non-terminator ops are already emitted as sideEffects(b) before
  // the switch; a non-root test block must be strictly pure.
  const SIDE_EFFECTFUL = new Set(['store', 'astore', 'call', 'load', 'aload', 'opaque']);
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
    if (!isRoot && (blk.ops.some((op) => SIDE_EFFECTFUL.has(op.opcode)) || emitsAnchoredWrite(blk))) {
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
    const names = [...into].map((x) => `#${fn.blocks.indexOf(x)}`).join(', ');
    if (into.size > 1) {
      return { kind: 'unstructurable', why: `a case body reaches several sibling cases (${names}) — C needs a goto` };
    }
    if (toMerge || escapes) {
      return {
        kind: 'unstructurable',
        why: `a case body reaches sibling case ${names} on one path and leaves the switch on another — C needs a goto`,
      };
    }
    return { kind: 'fallthrough', to: [...into][0] };
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
    const defaultCands = new Set<Block>();
    // Skip pure forwarding blocks — a block whose only op is an unconditional `br` (no side effects, no
    // params). agbcc's binary-search layout branches to the shared default through such empty `b .Ldef`
    // blocks; without skipping them each becomes a DISTINCT default candidate and the whole tree declines.
    const skipForward = (blk: Block): Block => {
      let cur = blk;
      const guard = new Set<Block>();
      // Only skip a truly empty forwarding block: a lone `br` with no params AND no successor ARGS —
      // an edge that carries a phi arg is NOT transparent (skipping it would drop that assignment).
      while (
        cur.ops.length === 1 &&
        cur.ops[0].opcode === 'br' &&
        cur.params.length === 0 &&
        cur.ops[0].successors[0].args.length === 0 &&
        !guard.has(cur)
      ) {
        guard.add(cur);
        cur = cur.ops[0].successors[0].block;
      }
      return cur;
    };
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
        cur = skipForward(term.successors[taken ? 0 : 1].block);
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
      const taken = skipForward(term.successors[0].block),
        fall = skipForward(term.successors[1].block);
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
    if (defaults.length > 1) {
      return null;
    }
    const defaultBlk = defaults[0] ?? null;
    if (defaultBlk && defaultBlk.params.length) {
      return null;
    } // default entry with a phi → decline
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

    // Build the switch. Cases sorted ascending (safe: no fall-through — PRE2). Bodies delegate to the
    // existing structureRegion (loops/ifs inside cases, the onStack guard — all reused).
    const scrutExpr = expr(scrut);
    const sortedCases = [...cases.entries()].sort((a, c) => a[0] - c[0]);
    const outCases: SwitchCase[] = sortedCases.map(([k, blk]) => ({
      values: [k],
      body: structureRegion(blk, merge),
      fallsThrough: false,
    }));
    const sw: Stmt = {
      k: 'switch',
      scrutinee: scrutExpr,
      cases: outCases,
      ...(defaultBlk ? { default: structureRegion(defaultBlk, merge) } : {}),
    };
    const out: Stmt[] = [sw];
    if (merge && merge !== stop) {
      out.push(...structureRegion(merge, stop));
    }
    return out;
  };
  return { recognizeSwitch, analyzeArmExit };
}
