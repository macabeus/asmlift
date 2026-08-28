// asmlift structurer — copy coalescing over the interference graph, run once the naming pipeline
// has given every merge value a name and before anything reads those names. Off by default;
// rank.ts enumerates it as the `/merge-names` candidate and the differ referees (StructureOptions
// `coalesceMergeNames`).
//
// WHAT IS LEFT TO COALESCE. Destroying SSA turns each block parameter into a variable and each
// edge argument into a copy into it, so a name shared between a parameter and its argument is a
// copy that disappears. `structure.ts` already shares one where it can: a parameter adopts the
// name of an incoming argument, checked against the same liveness this file uses. But that walk
// runs ONCE, over the blocks in address order, and only ever looks BACKWARD along an edge — so a
// parameter whose arguments are still unnamed takes a fresh name and never revisits it, and a
// parameter with several named arguments can adopt only ONE of them. Both leave the same residue.
// Three switch arms that each compute the same three quantities and feed one join reach it as
// three parameters apiece; the arm the join adopted pays nothing and every other arm pays a copy
// per value.
//
// So this pass asks the question the naming walk cannot: given the FINAL names, which two of them
// would a copy join, and may they be one variable? That is copy coalescing, and the answer is the
// interference graph — not the order the blocks happen to sit in. `l3/coalesce.ts` is a different
// question: two UNRELATED locals whose spans are disjoint, which is register reuse.
//
// WHY THIS IS A CANDIDATE AND NOT A FIX. Removing a copy is worth far less than it looks: the
// compiler coalesces most of them itself, so a function's two spellings compile to nearly the same
// code — the klonoa function this was built for drops 56 of its 74 copies and 6 of its 906
// instructions. What actually moves the score is which values end up sharing a register, and that
// splits per function: there the merged spelling wins by 13 points, on `mergeif` and `mergeloop`
// the un-merged one does. Which of the two a compiler's own coalescer landed on is not derivable
// from the naming, so both are emitted and the differ referees.
//
// WHEN TWO NAMES MAY BE ONE. A name denotes a set of SSA values. Merging names X and Y makes every
// value under either read and write one variable, so it is legal exactly when no value of X is
// live where a value of Y is written, and vice versa. `interferes` is that sentence.
//
// WHERE A VALUE IS WRITTEN, and OVER WHAT RANGE the other one has to be checked, are both places a
// block-granular answer is wrong. A block parameter is written by the edge copies into its block,
// which run at the end of each predecessor: `liveIn` of the block is exact for that, since the
// other arguments of the same edge are what `sequentialize` orders. A materialized definition
// writes MID-block, and there `liveIn` is not exact in either direction — it omits every value
// DEFINED in that block, however long it lives afterwards, which is precisely the range a mid-block
// write lands inside. `liveAt` answers that one per-op. This is the difference between this pass
// and `canTakeName`, which may use `liveIn` because it is only ever asked about a block PARAMETER,
// whose range starts at a block boundary; a name class holds arbitrary members.
//
// The exception to the edge-copy story is a loop emitter MOVING a copy — it rotates the update to
// the bottom of the body and sinks an exit copy in ahead of it — and where that can happen the
// write site widens to every block those predecessors reach in one step, the superset
// `canTakeName` takes everywhere. Function parameters are never written, so they have no write
// sites at all; a merge onto `a0` is still checked in the other direction.
//
// A LOOP VARIABLE'S NAME MEANS DIFFERENT THINGS IN DIFFERENT PLACES, and that is the one thing
// liveness cannot answer. The update sits at the bottom of the body, so on an exiting edge the name
// still holds the value the iteration started with — `structure.ts` refuses to let a merge outside
// the loop adopt it for exactly that reason (`carriesPreUpdate`), and refuses to let an inner
// loop's variable adopt an enclosing one's, which the inner loop would then mutate every iteration.
// `loop-escape` restates both over classes: a class holding a loop header's parameter may absorb
// only values the loop's body contains. Two loops' variables always fail it — a nested pair because
// the outer variable's home is outside the inner body, a disjoint pair in both directions — so the
// enclosing-loop rule needs no gate of its own.
//
// It is NOT marked sound, because it has not been shown to be, and it is BLUNTER than the rule it
// restates: `carriesPreUpdate` branches on which emitter owns the latch and names four shapes that
// are not the hazard, none of which this has. Dropping it over 773 benchmark rows improves 12 and
// regresses none — `nestedloop` is `int s = 0; … s += i*j`, one accumulator the pass currently
// emits as two. Lifting `carriesPreUpdate` itself to name classes is the work that would take those
// 12 rows; it needs the class-level closure, since a merge can reach a loop variable's name through
// an edge that carried no loop variable at all.
//
// TWO KNOWN GAPS, both on the READ side of a relocated write:
//
//   • `sitesOf` widens where a loop emitter may MOVE a copy, but the read side does not follow. For
//     a block parameter `clobbers` falls to `liveIn` of the widened site, and a parameter's SSA def
//     point is its own block's entry, not the position the emitter actually writes it at — so a
//     header definition is not seen to clobber a value the sink copies to the top of the body. The
//     slot that is actually sunk is unreachable (its exit arg is a header parameter, which
//     `loop-escape` rejects); reaching it needs a second, non-loop predecessor of the exit block
//     passing the header's definition into the same slot, and no input has been built that does.
//   • `canTakeName` applies its own widening UNCONDITIONALLY, while `relocatable` applies it only
//     where a loop can move the copy. One of the two is wrong: either that widening is unnecessary
//     on the committed path, where removing it would drop copies from EVERY spelling rather than
//     from an opt-in candidate, or `relocatable` is too narrow. Nothing has measured which.
//
// AND ONE ASYMMETRY THAT IS NOT A GAP. `type` is sound here, and `canTakeName` has no full
// equivalent: it declares a name from its FIRST taker and never re-checks a later adopter, a
// disagreement it reaches 136 times over klonoa's 69 liftable functions. That sounds like the same
// defect on the committed path, and it was measured: adding the check there moves one row better
// and two worse, no match flips. What it tolerates is the 32-BIT scalar case — `s32` against
// `u32`, same width, same bytes at a read — and that is a property of the RULE, not of the corpus:
// `canTakeName` compares signedness below 32 bits, because a narrow declaration IS the extension
// it replaced (the rule carries its own comment in structure.ts). What makes the rule SOUND here
// is the pointer case, where the survivor's declared type decides how its arithmetic scales.
//
// PURE: it reads the analysis maps and returns the renaming. Applying it is the caller's job.
import { type Block, type Op, type Value, successorsOf } from '../ir/core';
import { type IrType, typeEquals } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';
import type { UseSite } from './analysis';

export interface NameCoalesceDeps {
  /** the function's blocks, in address order — the iteration order that makes merges deterministic */
  blocks: readonly Block[];
  /** `blocks[0]`; its parameters are the function's own, and are never written */
  entry: Block;
  preds: ReadonlyMap<Block, Block[]>;
  /** values read at-or-after each block's entry (analysis.ts) */
  liveIn: ReadonlyMap<Block, Set<Value>>;
  /** op → the block holding it (analysis.ts) */
  opBlock: ReadonlyMap<Op, Block>;
  /** op → its position within its block (analysis.ts) */
  opIndex: ReadonlyMap<Op, number>;
  /** every positioned use of a value (analysis.ts) */
  useSitesOf: ReadonlyMap<Value, UseSite[]>;
  /** value → defining op (defOpMap) */
  defs: ReadonlyMap<Value, Op>;
  /** the defs the structurer bound to a local instead of re-rendering at each use */
  materialize: ReadonlySet<Op>;
  /** value → the name the naming pipeline settled on */
  varName: ReadonlyMap<Value, string>;
  /** name → the type it is declared with */
  varType: ReadonlyMap<string, IrType>;
  /** every natural loop, as its header and the blocks its body contains (structure/loops.ts) */
  loops: readonly { header: Block; body: ReadonlySet<Block> }[];
}

/** One candidate merge: the two name classes a would-be copy joins. */
export interface NameMerge {
  /** the name absorbed */
  from: string;
  /** the surviving name */
  into: string;
  /** a class holds a loop variable, and the other holds a value from outside that loop's body */
  loopEscapes: boolean;
  /** either class holds a parameter of the function itself */
  functionParam: boolean;
  /** two values of the merged class are parameters of ONE block */
  siblingParams: boolean;
  /** the two names are declared with the same type */
  sameType: boolean;
  /** some value of one class is live where some value of the other is written */
  interferes: boolean;
}

/** SOUND RULES FIRST. `mayMerge` computes every field eagerly, so the order costs nothing to
 *  evaluate — what it decides is BLAME. With a heuristic first, every pair that both escapes a loop
 *  and interferes is attributed to the heuristic, which is exactly backwards for reading what each
 *  rule actually rejects on its own. */
export const NAME_COALESCE_GATES: readonly Gate<NameMerge>[] = [
  {
    id: 'interference',
    why: 'a value live where the other is written would be clobbered by the merged variable',
    sound: true,
    guardedBy: 'namecoalesce.test.ts: ablating interference clobbers a value live across the copy',
    rejects: (c) => c.interferes,
  },
  {
    id: 'sibling-params',
    why: 'two parameters of one block share every in-edge, so one edge would write the name twice',
    sound: true,
    guardedBy: 'namecoalesce.test.ts: ablating sibling-params puts two parameters of one block under one name',
    rejects: (c) => c.siblingParams,
  },
  {
    id: 'type',
    why: 'the survivor keeps its own declared type, so the two must agree',
    sound: true,
    guardedBy: 'namecoalesce.test.ts: ablating type merges two names the declarations disagree about',
    rejects: (c) => !c.sameType,
  },
  // MIRROR: `structure.ts`'s naming walk asks a carrier-eligibility question about parameters too
  // (`freshParamMerge`, the `/fresh-merge` axis). They are not one predicate and must not be folded
  // into one: this gate refuses merging two already-settled NAME CLASSES and is ON by default
  // (within `/merge-names`); that one refuses ONE carrier at ONE merge slot, is OFF by default, and
  // closes over the homes it mints. Only their `entry.params` membership test coincides.
  {
    id: 'param',
    why: 'a function parameter is the signature the source wrote, not a recovered local',
    sound: false,
    rejects: (c) => c.functionParam,
  },
  {
    id: 'loop-escape',
    why: 'outside the loop a loop variable’s name holds the value from BEFORE the update',
    sound: false,
    rejects: (c) => c.loopEscapes,
  },
];

/** The renaming to apply to the naming maps: absorbed name → survivor. Empty when nothing merges.
 *  `refusals` counts which gate stopped each rejected pair, so a gate nothing ever reaches shows up
 *  as a rule no test can be failing on purpose. */
export function coalesceNames(
  deps: NameCoalesceDeps,
  gates: readonly Gate<NameMerge>[] = NAME_COALESCE_GATES,
): { renames: Map<string, string>; refusals: Map<string, number> } {
  const { blocks, entry, preds, liveIn, opBlock, opIndex, useSitesOf, defs, materialize, varName, varType, loops } =
    deps;
  const refusals = new Map<string, number>();

  const valuesOf = new Map<string, Value[]>();
  const order = new Map<string, number>();
  for (const [v, n] of varName) {
    if (!order.has(n)) {
      order.set(n, order.size);
    }
    const vs = valuesOf.get(n) ?? [];
    vs.push(v);
    valuesOf.set(n, vs);
  }
  if (valuesOf.size < 2) {
    return { renames: new Map(), refusals };
  }

  const paramBlock = new Map<Value, Block>();
  for (const b of blocks) {
    for (const p of b.params) {
      paramBlock.set(p, b);
    }
  }
  /** A block whose in-edge copies a loop emitter may MOVE off the edge that carries them. */
  const loopBlocks = new Set<Block>(loops.flatMap((l) => [...l.body]));
  const relocatable = (blk: Block): boolean =>
    loops.some((l) => l.header === blk) || (preds.get(blk) ?? []).some((pr) => loopBlocks.has(pr));
  // Where a write to this value's variable can land — see the file header.
  const writeSites = new Map<Value, Block[]>();
  const sitesOf = (v: Value): Block[] => {
    let s = writeSites.get(v);
    if (s) {
      return s;
    }
    const blk = paramBlock.get(v);
    if (blk && blk !== entry) {
      s = relocatable(blk) ? [blk, ...(preds.get(blk) ?? []).flatMap((pr) => successorsOf(pr))] : [blk];
    } else if (!blk) {
      const d = defs.get(v);
      s = d && materialize.has(d) ? [opBlock.get(d)!] : [];
    } else {
      s = [];
    }
    writeSites.set(v, s);
    return s;
  };
  // WHAT READING A VALUE ACTUALLY SPELLS. A def the structurer did not bind to a local is
  // RE-RENDERED at each use, so the names its operand tree reads are read wherever that expression
  // lands — arbitrarily far past the point SSA liveness says those operands died. Liveness of SSA
  // VALUES is therefore not liveness of the emitted program, and the gap is a silent clobber: the
  // fuzz found `v0 = v0 - a1;` emitted ahead of an `f1(a0 + (v0 - a1))` that still wanted the old
  // `v0`. Every live set below is expanded through this.
  const renderCache = new Map<Value, Set<Value>>();
  const renders = (v: Value): ReadonlySet<Value> => {
    const hit = renderCache.get(v);
    if (hit) {
      return hit;
    }
    const out = new Set<Value>([v]);
    renderCache.set(v, out); // before recursing: a def tree is acyclic, but this costs nothing
    if (!varName.has(v)) {
      for (const o of defs.get(v)?.operands ?? []) {
        for (const x of renders(o)) {
          out.add(x);
        }
      }
    }
    return out;
  };
  const expand = (vs: Iterable<Value>): Set<Value> => {
    const out = new Set<Value>();
    for (const v of vs) {
      for (const x of renders(v)) {
        out.add(x);
      }
    }
    return out;
  };
  // Which values' RENDERING reads `v` — so a use of one of them is a read of `v`, wherever it sits.
  const renderedBy = new Map<Value, Set<Value>>();
  for (const b of blocks) {
    for (const op of b.ops) {
      for (const r of op.results) {
        for (const x of renders(r)) {
          const set = renderedBy.get(x) ?? new Set<Value>();
          set.add(r);
          renderedBy.set(x, set);
        }
      }
    }
  }
  const liveInR = new Map<Block, Set<Value>>(blocks.map((b) => [b, expand(liveIn.get(b) ?? [])]));
  // Values live OUT of a block: what its successors read, plus what its terminator hands them.
  const liveOut = new Map<Block, Set<Value>>();
  for (const b of blocks) {
    const out = new Set<Value>();
    for (const sc of b.ops[b.ops.length - 1]?.successors ?? []) {
      for (const v of liveInR.get(sc.block) ?? []) {
        out.add(v);
      }
      for (const a of expand(sc.args)) {
        out.add(a);
      }
    }
    liveOut.set(b, out);
  }
  // Is `v` live ACROSS position `at` in `b`? `liveIn` alone cannot say: it is block-granular, so a
  // value DEFINED in `b` is absent from it however long it lives afterwards. That is exactly the
  // range a mid-block write lands in the middle of — and the reason `canTakeName` can use `liveIn`
  // and this cannot. `canTakeName` is only ever asked about a block PARAMETER, whose range starts
  // at a block boundary; a name class holds arbitrary members, materialized defs included.
  const liveAt = (v: Value, b: Block, at: number): boolean => {
    const d = defs.get(v);
    const dIdx = d !== undefined && opBlock.get(d) === b ? opIndex.get(d) : undefined;
    const started = liveInR.get(b)!.has(v) || b.params.includes(v) || (dIdx !== undefined && dIdx < at);
    if (!started) {
      return false;
    }
    if (liveOut.get(b)!.has(v)) {
      return true;
    }
    // a use of anything whose RENDERING reads `v` is a read of `v` at that position
    for (const w of [v, ...(renderedBy.get(v) ?? [])]) {
      if ((useSitesOf.get(w) ?? []).some((u) => u.blk === b && u.idx >= at)) {
        return true;
      }
    }
    return false;
  };
  // A block parameter's copies run before its block starts, so `liveIn` is exact for them. A
  // materialized definition writes mid-block and needs the range above.
  const clobbers = (writer: Value, other: Value): boolean => {
    const d = paramBlock.get(writer) === undefined ? defs.get(writer) : undefined;
    const at = d !== undefined ? opIndex.get(d) : undefined;
    // `liveAt` folds in the block's own parameters; an edge copy's site does not, because it runs
    // before the block starts. Two parameters of ONE block are written by the same edge copies and
    // so are invisible here by construction — that is `sibling-params`, not this rule.
    return sitesOf(writer).some((b) =>
      at !== undefined && opBlock.get(d!) === b ? liveAt(other, b, at) : liveInR.get(b)!.has(other),
    );
  };

  // Union-find over names. The survivor is the name introduced FIRST, which makes the result
  // independent of the order the pairs happen to be visited in.
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    let r = n;
    while (parent.get(r) !== undefined) {
      r = parent.get(r)!;
    }
    return r;
  };
  const members = new Map<string, Value[]>([...valuesOf].map(([n, vs]) => [n, [...vs]]));

  const mayMerge = (x: string, y: string): NameMerge => {
    const vx = members.get(x)!;
    const vy = members.get(y)!;
    // A loop variable is the parameter of a header; the loops it belongs to decide what its name
    // may absorb. `homeOf` is the block a value's variable is written in, which for these two rules
    // is all "inside the loop" needs to mean.
    const homeOf = (v: Value): Block | undefined => paramBlock.get(v) ?? opBlock.get(defs.get(v)!);
    const loopsOf = (vs: readonly Value[]): typeof loops =>
      loops.filter((l) => vs.some((v) => l.header.params.includes(v)));
    const lx = loopsOf(vx);
    const ly = loopsOf(vy);
    // Two loops' variables always escape each other: a nested pair because the outer variable's
    // home is not in the inner body, a disjoint pair in both directions. So the enclosing-loop rule
    // needs no gate of its own.
    const escapes = (ls: typeof loops, other: readonly Value[]): boolean =>
      ls.some((l) => other.some((v) => !l.body.has(homeOf(v)!)));
    const loopEscapes = escapes(lx, vy) || escapes(ly, vx);
    const functionParam = [...vx, ...vy].some((v) => entry.params.includes(v));
    let siblingParams = false;
    let interferes = false;
    for (const u of vx) {
      for (const w of vy) {
        if (paramBlock.get(u) !== undefined && paramBlock.get(u) === paramBlock.get(w)) {
          siblingParams = true;
        }
        if (clobbers(u, w) || clobbers(w, u)) {
          interferes = true;
        }
      }
    }
    const tx = varType.get(x);
    const ty = varType.get(y);
    return {
      from: y,
      into: x,
      loopEscapes,
      functionParam,
      siblingParams,
      sameType: tx !== undefined && ty !== undefined && typeEquals(tx, ty),
      interferes,
    };
  };

  // Every would-be copy, in block/slot/edge order: a parameter and the argument one edge hands it.
  for (const b of blocks) {
    if (b === entry) {
      continue;
    }
    for (const pr of new Set(preds.get(b) ?? [])) {
      for (const s of pr.ops[pr.ops.length - 1].successors) {
        if (s.block !== b) {
          continue;
        }
        b.params.forEach((p, i) => {
          const np = varName.get(p);
          const na = varName.get(s.args[i]);
          if (np === undefined || na === undefined) {
            return;
          }
          const rp = find(np);
          const ra = find(na);
          if (rp === ra) {
            return;
          }
          // survivor first
          const [x, y] = order.get(rp)! < order.get(ra)! ? [rp, ra] : [ra, rp];
          const refused = firstRejection(gates, mayMerge(x, y));
          if (refused !== null) {
            refusals.set(refused, (refusals.get(refused) ?? 0) + 1);
            return;
          }
          parent.set(y, x);
          members.get(x)!.push(...members.get(y)!);
          members.set(y, []);
        });
      }
    }
  }

  const renames = new Map<string, string>();
  for (const n of valuesOf.keys()) {
    const r = find(n);
    if (r !== n) {
      renames.set(n, r);
    }
  }
  return { renames, refusals };
}
