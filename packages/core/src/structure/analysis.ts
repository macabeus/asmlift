// asmlift structurer — the ANALYSIS phase. Pure derivation over the lifted fn — nothing here
// mutates the IR or depends on naming/emission state:
//   • use-site registry — every use of a value, POSITIONED (op + block + index);
//   • per-block SSA value liveness (backward dataflow) — consumed by the coalescing
//     interference check in structure.ts;
//   • the effect-ordering model — which defs must MATERIALIZE as named temps at their own
//     program position instead of inlining at their use (calls/loads for effect order, plus
//     the pure defs the homing rules claim).
import { globalCellOf, mayWriteGlobal } from '../ir/alias';
import { Block, Fn, Op, Value, defOpMap, successorsOf } from '../ir/core';
import { EFFECTFUL_OPS } from '../ir/opcodes';

export interface UseSite {
  blk: Block;
  idx: number;
  op: Op;
}

/** the ops whose operands[0] is a memory-access BASE — the address-home axis's slot model */
const MEM_BASE_OPS = new Set(['load', 'store', 'aload', 'astore']);

/** Any gaddr/laddr in the op's operand cone (the op included). Rendered standalone, an address
 *  computation over one loses the memAccess's inline byte-stride cast — the value changes, so a
 *  homing rule asking this refuses the cone (the cast-aware machinery in l3/basecse.ts,
 *  scopebase.ts and nearbase.ts serves those bases instead). The walk deliberately crosses loads —
 *  a gaddr reachable only through a load's address keeps its cast at that load's own deref, so
 *  over-refusal there costs a candidate, never soundness. That over-refusal is why the
 *  derived-read-home axis asks its own pair instead (an address in the cone OUTSIDE a read, plus
 *  `rendersAsAddress` on the value): reads over named globals are its whole clientele. */
function coneHoldsAddr(op0: Op, defOf: Map<Value, Op>): boolean {
  const seen = new Set<Value>();
  const cone = [op0];
  while (cone.length) {
    const d = cone.pop()!;
    if (d.opcode === 'gaddr' || d.opcode === 'laddr') {
      return true;
    }
    for (const x of d.operands) {
      if (!seen.has(x)) {
        seen.add(x);
        const dd = defOf.get(x);
        if (dd) {
          cone.push(dd);
        }
      }
    }
  }
  return false;
}

/** rank.ts's enumeration gate for the `/addr-home` axis: does the function HAVE a value the axis
 *  would home — a non-const pure def consumed only as the base of 2+ memory accesses, with no
 *  gaddr/laddr in its cone? Mirrors the axis's scope rule in `analyze`, minus the loop-header
 *  seat refusal (that needs the loop model; a false positive costs one duplicate-collapsed
 *  candidate, never a wrong one). */
export function hasHomeableSharedAddress(fn: Fn): boolean {
  const defOf = defOpMap(fn);
  const baseUses = new Map<Value, Set<Op>>();
  const otherUse = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'ret') {
        // A `ret` operand may be a void phantom (analyze() skips it under returnsVoid, which this
        // gate cannot know) — never a disqualifier here. For a genuinely returned base the axis's
        // own rule still refuses, costing one duplicate-collapsed candidate — the same trade the
        // gate's doc names for the loop-header divergence.
        continue;
      }
      op.operands.forEach((o, i) => {
        if (i === 0 && MEM_BASE_OPS.has(op.opcode)) {
          (baseUses.get(o) ?? baseUses.set(o, new Set()).get(o)!).add(op);
        } else {
          otherUse.add(o);
        }
      });
      for (const s of op.successors) {
        for (const a of s.args) {
          otherUse.add(a);
        }
      }
    }
  }
  for (const [v, users] of baseUses) {
    if (users.size < 2 || otherUse.has(v)) {
      continue;
    }
    const d = defOf.get(v);
    if (
      d &&
      d.opcode !== 'const' &&
      d.opcode !== 'call' &&
      d.opcode !== 'load' &&
      d.opcode !== 'aload' &&
      !coneHoldsAddr(d, defOf)
    ) {
      return true;
    }
  }
  return false;
}

/** rank.ts's enumeration gate for the `/expr-home` axis: does the function HAVE a value the
 *  axis would home — a pure non-const def with 2+ distinct consumers, at least one of them inside
 *  a loop the def sits outside, cone-free? Loops here are LAYOUT ranges (a successor at an
 *  equal-or-earlier block position closes one) where the axis's own rule uses the dominator model,
 *  and consumers here come from op operands only, where the rule counts `useSitesOf` and so counts
 *  branch args too — unlike hasHomeableSharedAddress this therefore diverges in BOTH directions. A
 *  false positive costs one duplicate-collapsed candidate. A false negative silently skips the arm:
 *  on IR whose block layout does not follow dominance, which every frontend avoids by laying blocks
 *  out in address order (a natural loop's back edge points backward), and on a value EITHER of
 *  whose two consumers is a branch arg, which the rule would home and this never enumerates. The
 *  second is unwitnessed over the 856-row bench, and costs a missing candidate, never a wrong
 *  one. */
export function hasLoopSharedPureValue(fn: Fn): boolean {
  const defOf = defOpMap(fn);
  const pos = new Map<Block, number>(fn.blocks.map((b, i) => [b, i]));
  const ranges: [number, number][] = [];
  for (const b of fn.blocks) {
    for (const sx of successorsOf(b)) {
      if (pos.get(sx)! <= pos.get(b)!) {
        ranges.push([pos.get(sx)!, pos.get(b)!]);
      }
    }
  }
  if (ranges.length === 0) {
    return false;
  }
  const consumers = new Map<Value, Set<Op>>();
  const opPos = new Map<Op, number>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      opPos.set(op, pos.get(b)!);
      for (const o of op.operands) {
        (consumers.get(o) ?? consumers.set(o, new Set()).get(o)!).add(op);
      }
    }
  }
  for (const [v, cs] of consumers) {
    const d = defOf.get(v);
    if (!d || d.opcode === 'const' || d.opcode === 'call' || d.opcode === 'load' || d.opcode === 'aload') {
      continue;
    }
    const dp = opPos.get(d)!;
    if (
      cs.size >= 2 &&
      ranges.some(
        ([lo, hi]) => (dp < lo || dp > hi) && [...cs].some((c) => opPos.get(c)! >= lo && opPos.get(c)! <= hi),
      ) &&
      !coneHoldsAddr(d, defOf)
    ) {
      return true;
    }
  }
  return false;
}

/** rank.ts's enumeration gate for the `/derived-home` axis: does the function HAVE a value the
 *  axis would home — a pure non-const, non-pointer def with 2+ consumers standing on a same-block
 *  memory read that is used nowhere else and reaches it with no write in between, and with no call
 *  or standalone address in the cone? A TRUE here DOUBLES the whole structuring cross for the
 *  function — not one candidate — so every refusal cheap enough to state without the positioned
 *  model is mirrored here; only the loop-header seat stays out.
 *
 *  Diverges in BOTH directions, like `hasLoopSharedPureValue` and unlike `hasHomeableSharedAddress`.
 *  Over: the write scan is straight-line within the one block, where the rule's is cycle-aware, so
 *  a write reaching only around a back edge is invisible here — a false positive costs a doubled
 *  cross whose every candidate the source dedup then collapses. Under: use counting here is by SLOT
 *  over operands and successor args, where `analyze` drops a void function's `ret` operand — so a
 *  read whose second use is a suppressed return is refused here and admitted there, silently
 *  skipping the arm. That shape is a void function returning the very halfword it read, which no
 *  caller can observe; the axis's clientele reads to compute, not to return. */
export function hasDerivedReadHome(fn: Fn): boolean {
  const defOf = defOpMap(fn);
  const consumers = new Map<Value, Set<Op>>();
  const useSlots = new Map<Value, number>();
  const blockOf = new Map<Op, Block>();
  const idxOf = new Map<Op, number>();
  for (const b of fn.blocks) {
    b.ops.forEach((op, i) => {
      blockOf.set(op, b);
      idxOf.set(op, i);
      const use = (v: Value) => {
        (consumers.get(v) ?? consumers.set(v, new Set()).get(v)!).add(op);
        useSlots.set(v, (useSlots.get(v) ?? 0) + 1);
      };
      for (const o of op.operands) {
        use(o);
      }
      for (const s of op.successors) {
        for (const a of s.args) {
          use(a);
        }
      }
    });
  }
  /** any op that writes memory strictly between two ops of one block — the rule's `memWriteBetween`
   *  over the straight line the same-block requirement already pins */
  const writeBetween = (b: Block, lo: number, hi: number): boolean =>
    b.ops.slice(lo + 1, hi).some((x) => EFFECTFUL_OPS.has(x.opcode));
  const standsOnRead = (op0: Op): boolean => {
    const reads: Op[] = [];
    const seen = new Set<Value>();
    const cone = [op0];
    while (cone.length) {
      const d = cone.pop()!;
      if (d.opcode === 'load' || d.opcode === 'aload') {
        reads.push(d);
        continue;
      }
      if (d.opcode === 'call' || d.opcode === 'gaddr' || d.opcode === 'laddr') {
        return false;
      }
      for (const x of d.operands) {
        if (!seen.has(x)) {
          seen.add(x);
          const dd = defOf.get(x);
          if (dd) {
            cone.push(dd);
          }
        }
      }
    }
    const b = blockOf.get(op0)!;
    return (
      reads.length > 0 &&
      reads.every(
        (r) =>
          blockOf.get(r) === b &&
          (useSlots.get(r.results[0]) ?? 0) === 1 &&
          !writeBetween(b, idxOf.get(r)!, idxOf.get(op0)!),
      )
    );
  };
  for (const [v, cs] of consumers) {
    const d = defOf.get(v);
    if (
      cs.size >= 2 &&
      d &&
      d.opcode !== 'const' &&
      d.opcode !== 'call' &&
      d.opcode !== 'load' &&
      d.opcode !== 'aload' &&
      v.type.kind !== 'ptr' &&
      v.type.kind !== 'array' &&
      standsOnRead(d)
    ) {
      return true;
    }
  }
  return false;
}

export interface StructureAnalysis {
  /** every positioned use of a value; a value absent here is dead */
  useSitesOf: Map<Value, UseSite[]>;
  opIndex: Map<Op, number>;
  opBlock: Map<Op, Block>;
  /** SSA values live at each block's entry */
  liveIn: Map<Block, Set<Value>>;
  /** defs that must emit as named temps at their own position — calls/loads for effect order,
   *  plus the pure defs the homing rules claim */
  materialize: Set<Op>;
  /** cached forward reachability (successors-transitive, excluding the start block itself) */
  reachFrom: (b: Block) => Set<Block>;
  /** where a value's expression ultimately renders — the anchored consumer it inlines into,
   *  transitively; null = several places / unresolvable (callers treat conservatively) */
  emitPos: (op: Op) => { blk: Block; idx: number } | null;
  /** may an op `isWrite` accepts execute between `def` and a statement at `render`, on any
   *  def-avoiding path — the fold-ordering gate (see the closure's comment) */
  memWriteBetween: (def: Op, render: { blk: Block; idx: number }, isWrite: (x: Op) => boolean) => boolean;
}

export interface AnalyzeOptions {
  /** the fn's def map (`defOpMap`) — the structurer already holds one, so it is passed rather than
   *  rebuilt. Absent ⇒ the global-aware alias rule below cannot resolve anything and every write
   *  bars, exactly as before it existed. */
  defs?: Map<Value, Op>;
  /** Dominator sets, when the caller already holds them (structure() does) — consumed by the
   *  live-across-a-loop rule's back-edge detection. Absent ⇒ that rule stands down. */
  dom?: Map<Block, Set<Block>>;
  /** THE value-home axis (rank.ts `/reread-globals`). A read of a named global is barred from
   *  rendering at its use by any write in between — even a store to an unrelated global, which
   *  cannot possibly change what it sees. That over-conservatism is what invents the locals the
   *  round-5 dogfood measured as its highest-cost defect ("hoists what agbcc re-reads"):
   *
   *      gA = v; gB = v;   with `s32 v = gValue;`   where the source said `gA = gValue; gB = gValue;`
   *
   *  With this on, the barrier scan for a load whose address resolves to a named global uses THE
   *  shared disjointness query (ir/alias.ts) instead of "any write at all". Materializing a
   *  global's READ is always sound (the deref and its cast render at the def's position — contrast
   *  homeSharedAddresses below, where the materialized value is an address and soundness is
   *  scoped), so today's spelling is never wrong — only sometimes not the one the compiler was
   *  given.
   *  Which side matches is genuinely per-function (the same dogfood watched agbcc go both ways
   *  inside ONE function), so this is a differ-refereed candidate axis, never a default.
   *
   *  SCOPE, since `readsStayWhereWritten` below now answers the same question — read once and
   *  reuse, or read per use — with the opposite default: this axis owns renders in the read's OWN
   *  block, where nothing about placement is in evidence and both spellings really do compile.
   *  A read whose every render sits in a STRICTLY DOMINATED block is the default's, and on a
   *  target that declares it the axis cannot produce the re-read spelling there (the rule
   *  materializes first). That is a pre-emption, not a conflict: a per-arm source read compiles to
   *  a per-arm load on that compiler, so the sunk spelling is one it did not emit from this asm. */
  rereadGlobals?: boolean;
  /** "does the project declare this global volatile?" — a read of a volatile object may NOT be
   *  duplicated or moved, so the axis above refuses on one. Answers false for a symbol the map
   *  does not carry (and for no map at all), which is the same posture the multi-render rule has
   *  always had: without a declaration nothing here can know, and the differ referees the extra
   *  load. Where the map DOES know, the axis is silent about it rather than wrong. */
  volatileGlobal?: (name: string) => boolean;
  /** The in-place-join axis (rank.ts `/inplace`). A load whose result is a `cond_br` successor
   *  ARG feeds a merge: rendered inline it has no name, so the merge param mints a fresh variable
   *  and BOTH arms must assign it. Materialized, the naming walk can home the merge in the load's
   *  own variable, the identity arm elides, and the `if` renders one-sided — `v = *p; if (v > 31)
   *  v = 32;` — which is also what reuses the load's register when recompiled. Whether the source
   *  spelled the temp or the overwrite is not derivable from the asm, so this is a differ-refereed
   *  candidate axis, never a default. Plain `br` args (loop-carried values) are out of scope:
   *  their homes are the loop-param machinery's question. */
  materializeJoinFeeds?: boolean;
  /** The address-home axis (rank.ts `/addr-home`). A pure computed address the asm derived ONCE
   *  and dereferenced at 2+ sites renders, by default, re-derived at each use — and the loads
   *  through it re-read per use — where the original source may have spelled a pointer local plus
   *  scalar temps (`u8 *entry = (u8 *)((a0 << 2) + base); type = entry[1]; idx = entry[0];`).
   *  The two spellings are codegen-visible (the re-derive folds each deref offset into its OWN
   *  pool literal; the home shares one base register across `[rN, #k]` accesses) and which one
   *  the source used is not derivable from asm, so this is a differ-refereed candidate axis,
   *  never a default. With it on: a non-const pure value consumed ONLY as the base operand of
   *  2+ memory accesses materializes, and so does a multi-render `load` through such a base.
   *  Both rules only ADD materialization, which preserves semantics FOR THE VALUES THE SCOPE
   *  ADMITS — the gaddr/laddr cone refusal is the soundness half of that claim (rendered
   *  standalone, an address cone's value changes: the byte-stride cast lives at the use — see
   *  coneHoldsAddr; those bases stay with l3/basecse.ts, scopebase.ts and nearbase.ts), and the
   *  multi-block-loop-header seat refusal is the decline-avoidance half (same as
   *  liveAcrossLoop's). An L3 re-spell could not host this axis: by structuring's end the loads
   *  have already rendered per-use inside separate arms, and only this phase's positioned
   *  memory model can merge them into pre-branch temps. */
  homeSharedAddresses?: boolean;
  /** The loop-expression-home axis (rank.ts `/expr-home`). A pure computed value defined outside
   *  a loop and consumed by 2+ distinct ops, at least one of them inside that loop, is one the
   *  compiler holds in a (callee-saved) register across the iterations — it never re-derives per
   *  use in a loop —
   *  where the default renders it re-derived at each use; the source may have spelled a typed
   *  local (`u32 size = 16 << t;` driving a loop bound, a product and a shift). The home's
   *  declared type is the IR value's recovered type, so a u32 value's compares stay unsigned
   *  through the local. Straight-line multi-use values stay OUT (the small-constant class the
   *  const-across-call scope's note records); shared memory-access bases are `/addr-home`'s.
   *  Same refusals as that axis: gaddr/laddr cones and multi-block-loop-header seats. Adding
   *  materialization preserves semantics for the admitted values, exactly as above. */
  homeLoopExprs?: boolean;
  /** The derived-read-home axis (rank.ts `/derived-home`). A memory read whose value is not used
   *  directly but through a pure computation with 2+ consumers puts the home on the WRONG node:
   *  the read materializes (its consumer resolves no single render position) and the computation
   *  then re-derives from that local at every use, where the asm computed it ONCE — the read's
   *  register died at the computation and the DERIVED value is what a register carried on
   *  (`eor r1,r1,r0` keeps `0x3FF ^ REG_KEYINPUT`, never the raw halfword). With this on, a pure
   *  non-const value with 2+ consumers whose operand cone bottoms out at a memory read
   *  materializes instead; the read then renders exactly once, inside the home.
   *
   *  A differ-refereed axis, not a fix: agbcc CSEs a re-derived expression back to one
   *  instruction often enough that both spellings do compile, and which one the source spelled is
   *  not derivable. What the cone's read supplies is the evidence the straight-line case otherwise
   *  lacks — `/expr-home` takes a loop as proof the value stayed in a register, and a
   *  freely-re-derivable value (the small-constant class) has no such proof at all, but a value
   *  standing on a read the source could not repeat is one the asm computed from a single access.
   *
   *  Refusals, all of them about the ONE access the home must reproduce. A cone read used anywhere
   *  but the cone (its second use resolves a second render position, so the read would render
   *  twice). A cone read outside this value's own block, barred from it by a write, or barred by a
   *  read outside the cone (moving the access across a branch, into a loop, or past another access
   *  changes which paths read, how often, and in what order). A cone crossing a `call` (homing
   *  would move a side effect). A standalone gaddr/laddr in the cone, or a value that is ITSELF an
   *  address (rendered standalone the byte-stride cast lands outside the sum — see
   *  `rendersAsAddress`). And the multi-block-loop-header seat the sibling axes refuse. */
  homeDerivedReads?: boolean;
  /** DEF-BLOCK PLACEMENT for memory reads — WHERE the read happens, not where the value lives.
   *  The sibling of the homing axes above: there the question is which register or offset holds a
   *  value, here which BLOCK performs the read. A read whose every render sits in a block its own
   *  block STRICTLY DOMINATES has no rule at all above — those axes want 2+ consumers or a shared
   *  base — so it sinks and each arm re-reads it: a second load either way, plus a second pool
   *  literal when the address folded to a constant.
   *
   *  A per-compiler DATA lever (TargetDescription.compilerBehaviors `readsStayWhereWritten`), not
   *  a differ-refereed axis, and that distinction is the argument: an axis exists where the asm
   *  UNDERDETERMINES the source, some pass having collapsed two spellings onto one output
   *  (`/uns-cmp`'s non-negativity proof is the type case). Where the compiler emits a read in the
   *  block the source spelled it in, re-spelling it at the block the asm read in reproduces that
   *  asm while the sunk spelling is one it emits only for a source that read per arm — nothing for
   *  the differ to referee, and the extra candidate is pure cost. Which compilers may declare
   *  that, and on what evidence, is at the target field; absent ⇒ the rule stands down entirely.
   *
   *  Materializing is the conservative DIRECTION — back to the read's own def position, never
   *  forward past a write — so it adds no barrier scan; SINKING is what needs one (the
   *  multi-render rule below) and that scan stays. It is NOT sound by construction: the def block
   *  is the asm's read block only while nothing moved the def and a branch really does lie
   *  between, which is what the refusals are for. Getting that wrong emits a read on a path the
   *  asm never ran it on.
   *
   *  Five refusals:
   *    • a multi-block loop HEADER, whose test-at-top condition seats no temp — `multiBlockHeaders`
   *    • a FALL-THROUGH between def and render, where the dominance is the frontend's
   *      block-per-label and no branch separates them — `fallThroughSeam`
   *    • a loop PREHEADER of the loop the renders are in, where loop invariant motion parks a read
   *      the source wrote in the BODY — `preheaderOfRenderLoop`
   *    • a read C evaluates only under a `&&`/`||`, whose def block raise/shortcircuit.ts made —
   *      `shortCircuitGuarded`
   *    • a read that IS a block parameter's incoming copy, where the seat manufactures a copy the
   *      compiler never emitted — `onlyFeedsBlockParams` */
  readsStayWhereWritten?: boolean;
}

export function analyze(fn: Fn, returnsVoid: boolean, opts: AnalyzeOptions = {}): StructureAnalysis {
  const {
    defs,
    dom,
    rereadGlobals = false,
    volatileGlobal,
    materializeJoinFeeds = false,
    homeSharedAddresses = false,
    homeLoopExprs = false,
    homeDerivedReads = false,
    readsStayWhereWritten = false,
  } = opts;
  // ── use registry ────────────────────────────────────────────────────────────────────────
  // Every use of a value, POSITIONED: the consuming op and its block/index. Successor args are
  // uses AT the terminator (they render in argAssigns at block end). A void function's `ret`
  // operand is a phantom, not a real use — skipping it lets a call whose result ONLY flows into
  // the suppressed return read as a dead (side-effect) call, so `sideEffects()` emits it.
  // One operand SLOT = one entry (an op reading a value twice records two uses — that count is
  // what decides whether an inlined call would EXECUTE twice).
  const useSitesOf = new Map<Value, UseSite[]>();
  const opIndex = new Map<Op, number>();
  const opBlock = new Map<Op, Block>();
  const blockPos = new Map<Block, number>();
  for (const b of fn.blocks) {
    blockPos.set(b, blockPos.size);
    b.ops.forEach((op, i) => {
      opIndex.set(op, i);
      opBlock.set(op, b);
    });
  }
  // Linear program position (block order, then op order): a call "between" a def and a use is one
  // whose position lies strictly between them. This is a PROXY for "a call on a def→use path", not
  // the real dataflow: it checks position order only, not reachability. It can therefore FALSE-
  // POSITIVE — a call in a forward SIBLING branch (never traversed on the def→use path) still sits
  // between them by position (e.g. `def; if(c){call;ret} else {…use…use}`), and back-edges are not
  // modelled either. That is SAFE ONLY BECAUSE the caller materializes exactly `const` ops: a const
  // is a relocation-invariant leaf whose def dominates every use, so binding it to a local is
  // UNCONDITIONALLY semantics-preserving on every path — a false positive costs at most a match (an
  // extra `v =` the compiler would have re-inlined), caught by the zero-lost gate, never wrong C.
  // RE-VERIFY this before widening the whitelist to any value that is not path-independent or that
  // carries a use-site cast (an address computation `&g + i`), for which a false positive is unsound.
  const linPos = (op: Op): number => blockPos.get(opBlock.get(op)!)! * 1e6 + opIndex.get(op)!;
  const callPos: number[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'call') {
        callPos.push(linPos(op));
      }
    }
  }
  // The `/inplace` axis reads: which values ride a `cond_br` edge as a successor ARG. Built
  // once; plain `br` args deliberately not collected (see AnalyzeOptions).
  const condBrArgFed = new Set<Value>();
  if (materializeJoinFeeds) {
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'cond_br') {
          for (const s of op.successors) {
            for (const a of s.args) {
              condBrArgFed.add(a);
            }
          }
        }
      }
    }
  }
  /** True if `def`'s value is still needed after a call — a call lies strictly between the def and
   *  one of its `consumers`. Such a value survives in a callee-saved register (a local), which is
   *  what materializing it reproduces. */
  const liveAcrossCall = (def: Op, consumers: Op[]): boolean => {
    const dp = linPos(def);
    const usePos = consumers.map(linPos);
    return callPos.some((c) => c > dp && usePos.some((u) => u > c));
  };
  for (const b of fn.blocks) {
    b.ops.forEach((op, i) => {
      if (returnsVoid && op.opcode === 'ret') {
        return;
      }
      const site: UseSite = { blk: b, idx: i, op };
      const add = (v: Value) => {
        const arr = useSitesOf.get(v);
        if (arr) {
          arr.push(site);
        } else {
          useSitesOf.set(v, [site]);
        }
      };
      for (const u of op.operands) {
        add(u);
      }
      for (const s of op.successors) {
        for (const a of s.args) {
          add(a);
        }
      }
    });
  }

  // ── per-block liveness of SSA values ──────────────────────────────────────────────────────
  // Backward dataflow. Successor args count as uses at the END of the predecessor (they render
  // in the predecessor's argAssigns), so liveIn(B) means precisely "read at-or-after B's entry".
  // Consumed by the coalescing interference check: merging two values that are ever
  // simultaneously live into one variable name is the textbook silent clobber.
  const liveIn = new Map<Block, Set<Value>>();
  for (const b of fn.blocks) {
    liveIn.set(b, new Set());
  }
  for (let liveChanged = true; liveChanged;) {
    liveChanged = false;
    for (let bi = fn.blocks.length - 1; bi >= 0; bi--) {
      const b = fn.blocks[bi];
      const live = new Set<Value>();
      for (const s of successorsOf(b)) {
        for (const v of liveIn.get(s)!) {
          live.add(v);
        }
      }
      for (let oi = b.ops.length - 1; oi >= 0; oi--) {
        const op = b.ops[oi];
        for (const r of op.results) {
          live.delete(r);
        }
        for (const s of op.successors) {
          for (const a of s.args) {
            live.add(a);
          }
        }
        if (!(returnsVoid && op.opcode === 'ret')) {
          for (const u of op.operands) {
            live.add(u);
          }
        }
      }
      for (const p of b.params) {
        live.delete(p);
      }
      const cur = liveIn.get(b)!;
      if (live.size !== cur.size || ![...live].every((v) => cur.has(v))) {
        liveIn.set(b, live);
        liveChanged = true;
      }
    }
  }

  // ── the effect-ordering model — inline-at-use barriers ────────────────────────────────────
  // `expr()` renders a def's computation AT ITS USE, which silently MOVES it: a call executes
  // once per rendered copy (`foo(a0)+foo(a0)`), a load reads memory at the render point (it can
  // textually sink past an aliasing store). The model: a call/load/aload def may inline ONLY
  // when rendering cannot change behavior — exactly one render position, and the program-order
  // gap between def and render crosses no memory write (loads) / no memory access at all (calls,
  // whose own reads+writes must not reorder against anything). Every other case gets a NAMED
  // TEMP assigned at the def's own program position (sideEffects) — which is precisely the
  // register the compiler used.
  const materialize = new Set<Op>();
  const reachCache = new Map<Block, Set<Block>>();
  const reachFrom = (b: Block): Set<Block> => {
    let r = reachCache.get(b);
    if (r) {
      return r;
    }
    r = new Set<Block>();
    const stack = [...successorsOf(b)];
    while (stack.length) {
      const x = stack.pop()!;
      if (r.has(x)) {
        continue;
      }
      r.add(x);
      stack.push(...successorsOf(x));
    }
    reachCache.set(b, r);
    return r;
  };
  // Reachability that never passes THROUGH `avoid` — the def-block-avoiding variant for
  // per-iteration path checks: a path that re-enters the def's block re-executes the def, so
  // writes on it belong to the NEXT dynamic instance (which re-renders anyway) and must not
  // count against this one. Uncached (per-decision graphs are small).
  const reachAvoiding = (from: Block, avoid: Block): Set<Block> => {
    const r = new Set<Block>();
    const stack = successorsOf(from).filter((s) => s !== avoid);
    while (stack.length) {
      const x = stack.pop()!;
      if (r.has(x)) {
        continue;
      }
      r.add(x);
      for (const s of successorsOf(x)) {
        if (s !== avoid && !r.has(s)) {
          stack.push(s);
        }
      }
    }
    return r;
  };
  // Where a value's expression is ultimately EMITTED: the anchored consumer (statement op,
  // terminator, materialized def) it inlines into, transitively through single-use pure ops.
  // null = renders in several places / unresolvable (treated conservatively by the caller).
  const emitPosCache = new Map<Op, { blk: Block; idx: number } | null>();
  /** an op that renders AT ITS OWN position: a statement, a terminator, a materialized or dead def */
  const anchored = (op: Op): boolean =>
    op.successors.length > 0 ||
    op.opcode === 'ret' ||
    op.opcode === 'store' ||
    op.opcode === 'astore' ||
    materialize.has(op) ||
    !op.results.length ||
    !useSitesOf.has(op.results[0]);
  const consumersOf = (op: Op): Op[] => [...new Set((useSitesOf.get(op.results[0]) ?? []).map((s) => s.op))];
  const emitPos = (op: Op): { blk: Block; idx: number } | null => {
    if (emitPosCache.has(op)) {
      return emitPosCache.get(op)!;
    }
    let res: { blk: Block; idx: number } | null;
    if (anchored(op)) {
      res = { blk: opBlock.get(op)!, idx: opIndex.get(op)! };
    } else {
      const consumers = consumersOf(op);
      res = consumers.length === 1 ? emitPos(consumers[0]) : null;
    }
    emitPosCache.set(op, res);
    return res;
  };
  // EVERY position a value's expression renders at — `emitPos` generalized to the whole set (it
  // answers one place or gives up), by following ALL consumers transitively. That matters for
  // the value-home axis: a pure expression with two consumers (`gOut = e; return e;`) has no single
  // emit position, so `emitPos` answers null and every memory read feeding it is forced into a
  // local — even when re-reading at both places is provably equivalent. Null only for a genuine
  // cycle (defensive: SSA use-def is acyclic through ops), which the caller treats as unresolvable.
  //
  // NEVER for a call: two render positions mean two executions, so a call whose consumer renders in
  // several places must keep answering null and materialize.
  const emitPosSetCache = new Map<Op, { blk: Block; idx: number }[] | null>();
  const emitPositions = (op: Op, visiting: Set<Op> = new Set()): { blk: Block; idx: number }[] | null => {
    const hit = emitPosSetCache.get(op);
    if (hit !== undefined) {
      return hit;
    }
    if (visiting.has(op)) {
      return null;
    }
    let res: { blk: Block; idx: number }[] | null;
    if (anchored(op)) {
      res = [{ blk: opBlock.get(op)!, idx: opIndex.get(op)! }];
    } else {
      visiting.add(op);
      const seenPos = new Set<string>();
      const acc: { blk: Block; idx: number }[] = [];
      res = acc;
      for (const c of consumersOf(op)) {
        const sub = emitPositions(c, visiting);
        if (!sub) {
          res = null;
          break;
        }
        for (const p of sub) {
          const key = `${blockPos.get(p.blk)}:${p.idx}`;
          if (!seenPos.has(key)) {
            seenPos.add(key);
            acc.push(p);
          }
        }
      }
      visiting.delete(op);
    }
    emitPosSetCache.set(op, res);
    return res;
  };
  // THE def→render path discipline — one implementation, three callers (the two materialization
  // rules below and structure.ts's bitfield fold, which imports it). May an op `isWrite` accepts
  // execute between `def` and a statement at `render`, on any def-avoiding path? The def block's
  // tail, the render block's head, and every between-block on a path; a path re-crossing the def
  // is the NEXT dynamic instance and does not count. Path-based on purpose: `fn.blocks` is ADDRESS
  // order, so a linear-position scan misses a block laid out after the render that executes
  // between def and render on the taken path (an audit round broke exactly that way).
  const memWriteBetween = (def: Op, render: { blk: Block; idx: number }, isWrite: (x: Op) => boolean): boolean => {
    const b = opBlock.get(def)!;
    const oi = opIndex.get(def)!;
    const wDirty = (list: Op[], from: number, to: number): boolean => {
      for (let k = from; k < to; k++) {
        if (isWrite(list[k])) {
          return true;
        }
      }
      return false;
    };
    // Same block: the only def-avoiding path is the straight line between the two indices
    // (leaving and re-entering the block re-crosses the def). A render BEFORE the def cannot
    // happen — within a block, uses follow defs — and falls through to the path walk, whose
    // answer is the conservative one.
    if (render.blk === b && oi < render.idx) {
      return wDirty(b.ops, oi + 1, render.idx);
    }
    if (wDirty(b.ops, oi + 1, b.ops.length) || wDirty(render.blk.ops, 0, render.idx)) {
      return true;
    }
    for (const x of reachAvoiding(b, b)) {
      if (x === render.blk && !reachAvoiding(render.blk, b).has(render.blk)) {
        continue; // acyclic render block: head checked
      }
      if (x !== render.blk && !reachAvoiding(x, b).has(render.blk)) {
        continue; // not on a def→render path
      }
      if (wDirty(x.ops, 0, x.ops.length)) {
        return true;
      }
    }
    return false;
  };
  // ── interdependent parallel-copy args ─────────────────────────────────────────────────────
  // A terminator's successor args are ONE parallel copy (argAssigns), whose every read means the
  // PRE-copy value. An arg whose def-tree reads a SIBLING arg of the same edge cannot read it by
  // name there — so the sibling's whole expression is re-derived inside this arg's copy, and
  // `sequentialize` spills old-value temps to untangle the order: arithmetic the compiler
  // performed once, emitted per reader (the coupled-recurrence loop, `a += b*c; d += a;`). The
  // read sibling is the register the copy machinery cannot represent — materialize its def. The
  // walk crosses pure defs only (a call/load render is those rules' question) and stops at
  // params, which always carry a name.
  const defOf = defs ?? defOpMap(fn);
  const copyInterdependent = new Set<Value>();
  const pureReads = (root: Value, acc: Set<Value>) => {
    const stack = [root];
    while (stack.length) {
      const x = stack.pop()!;
      const d = defOf.get(x);
      if (!d || acc.has(x)) {
        continue;
      }
      acc.add(x);
      if (d.opcode !== 'call' && d.opcode !== 'load' && d.opcode !== 'aload') {
        stack.push(...d.operands);
      }
    }
  };
  for (const b of fn.blocks) {
    for (const s of b.ops[b.ops.length - 1]?.successors ?? []) {
      if (s.args.length < 2) {
        continue;
      }
      for (const w of s.args) {
        const d = defOf.get(w);
        if (!d || d.opcode === 'call' || d.opcode === 'load' || d.opcode === 'aload') {
          continue;
        }
        const reads = new Set<Value>();
        for (const o of d.operands) {
          pureReads(o, reads);
        }
        for (const v of s.args) {
          if (v !== w && reads.has(v)) {
            copyInterdependent.add(v);
          }
        }
      }
    }
  }
  // ── natural loops, for the live-across-a-loop rule ────────────────────────────────────────
  // From the caller's dominators (a back edge is `latch → header` with the header dominating the
  // latch); the body is the backward closure from the latch. With no `dom` the rule stands
  // down — the same posture as the `defs`-carried rules.
  const predsOf = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    predsOf.set(b, []);
  }
  for (const b of fn.blocks) {
    for (const s of successorsOf(b)) {
      predsOf.get(s)!.push(b);
    }
  }
  const loopBodies: { header: Block; body: Set<Block> }[] = [];
  if (dom) {
    for (const latch of fn.blocks) {
      for (const header of successorsOf(latch)) {
        if (!dom.get(latch)?.has(header)) {
          continue;
        }
        const body = new Set<Block>([header]);
        const work = [latch];
        while (work.length) {
          const x = work.pop()!;
          if (!body.has(x)) {
            body.add(x);
            work.push(...(predsOf.get(x) ?? []));
          }
        }
        loopBodies.push({ header, body });
      }
    }
  }
  /** The def's value enters some loop's header live and every consumer sits outside that loop,
   *  as does the def: the value is carried ACROSS the loop, not into it. */
  // Never for a def in a MULTI-BLOCK loop header: a test-at-top `while`'s condition has no seat
  // for a materialized temp (the structurer's headerPure gate), so materializing there trades a
  // structuring function for a decline. Self-loop headers stay eligible — their kept-guard
  // do-while form hosts the temp.
  const multiBlockHeaders = new Set(loopBodies.filter((L) => L.body.size > 1).map((L) => L.header));
  const liveAcrossLoop = (def: Op, r: Value, consumers: Op[]): boolean =>
    !multiBlockHeaders.has(opBlock.get(def)!) &&
    loopBodies.some(
      (L) =>
        liveIn.get(L.header)!.has(r) &&
        !L.body.has(opBlock.get(def)!) &&
        consumers.every((c) => !L.body.has(opBlock.get(c)!)),
    );
  /** Would naming THIS op's own result change its value? Yes when the result is an ADDRESS built
   *  over a gaddr/laddr: rendered standalone an `&g + i` loses the memAccess's inline byte-stride
   *  cast, and the cast-aware base machinery in l3/ serves those bases instead. Asked by the rules
   *  that home an address; a rule homing the SCALAR a load returns is not this case — the name
   *  holds the loaded value and the address stays inline at the deref, which is why the load rules
   *  (live-across-a-loop, join feeds, /addr-home's, def-block placement) do not ask it. */
  const addressCone = (op0: Op): boolean => coneHoldsAddr(op0, defOf);
  /** Is the op's own value an ADDRESS — a pointer the standalone rendering must cast? The same
   *  hazard `addressCone` covers, asked of the value instead of its cone, for the derived-read-home
   *  axis: that axis cannot use `addressCone` (it crosses reads, so it refuses every value over a
   *  named global's load — the axis's clientele), and a pointer LOADED from memory puts its gaddr
   *  under the read where the cone walk stops. Homed, `add(p, 8)` renders `(u16 *)(gPtr + 8)` — the
   *  cast lands outside the sum, so a byte offset becomes element arithmetic and the address moves
   *  (+16 where the inline `*(v0 + 4)` reads +8). */
  const rendersAsAddress = (op: Op): boolean => {
    const t = op.results[0]?.type;
    return t?.kind === 'ptr' || t?.kind === 'array';
  };
  // ── the address-home axis's scope predicate ───────────────────────────────────────────────
  // A value consumed ONLY as the base (operands[0]) of 2+ distinct memory accesses — the shape
  // the axis homes. Any other use (a store's value slot, an aload index, arithmetic, a successor
  // arg) disqualifies it: the home is justified by the shared-base reuse alone.
  const usedOnlyAsSharedBase = (v: Value): boolean => {
    const sites = useSitesOf.get(v) ?? [];
    const consumers = new Set(sites.map((s) => s.op));
    return (
      consumers.size >= 2 &&
      [...consumers].every(
        (c) => MEM_BASE_OPS.has(c.opcode) && c.operands[0] === v && !c.operands.some((o, i) => i > 0 && o === v),
      )
    );
  };
  /** result values the address-home axis materialized — the load rule's admission key */
  const axisHomedBases = new Set<Value>();
  /** The loop-expression-home axis's scope: 2+ distinct consumers of the value, at least one of
   *  them inside a loop the def's block is outside (loop model = the caller's dominators; absent ⇒
   *  never).
   *
   *  The two counts carry different halves of the evidence. ONE consumer inside the loop is what
   *  says the compiler held the value in a callee-saved register across the iterations — it does
   *  not re-derive per use in a loop, and a value crossing the loop boundary is pinned for the
   *  whole nest. The SECOND consumer, anywhere, is what makes the home observable at all: a
   *  single-use value inlines at its one use with the same bytes either way, so homing it can only
   *  add a copy. Values consumed only OUTSIDE any loop are the straight-line class `/derived-home`
   *  serves on its own evidence. */
  const loopSharedConsumers = (v: Value, defBlk: Block): boolean => {
    const consumers = [...new Set((useSitesOf.get(v) ?? []).map((s) => s.op))];
    return (
      consumers.length >= 2 &&
      loopBodies.some((L) => !L.body.has(defBlk) && consumers.some((c) => L.body.has(opBlock.get(c)!)))
    );
  };
  /** The derived-read-home axis's scope: does `op0` stand on a memory READ that may render at
   *  `op0`'s own position?
   *
   *  The cone walk STOPS at a read — its address stays inline at the deref, so nothing below it is
   *  ever rendered standalone — and refuses on anything else that cannot move to `op0`: a `call`
   *  (a side effect), and a gaddr/laddr reached OUTSIDE a read's address (rendered standalone an
   *  `&g + i` loses the memAccess's byte-stride cast). `coneHoldsAddr` cannot answer this: it
   *  crosses reads, so it refuses every value standing on a named global's load — which is this
   *  axis's whole clientele.
   *
   *  At least one read is required. A value derivable from locals and constants alone is one the
   *  compiler re-materializes for free, and homing it only adds copies — the small-constant class
   *  the const scope's note records.
   *
   *  Each read must then sit in `op0`'s OWN BLOCK, and reach `op0`'s position with nothing that
   *  writes memory able to execute in between — homing renders the read at `op0`, so both are
   *  about moving it there.
   *
   *  A read OUTSIDE the cone bars it too. The default's "loads never bar a load" holds for reads
   *  the compiler leaves unsequenced inside ONE expression, which is what the cone's own reads
   *  become; a foreign read renders in a different statement, so moving past it reorders two
   *  accesses — for two MMIO cells (this axis's clientele) an observable swap, as when `A`'s
   *  derived value sits below `B`'s and homing both puts `B`'s read first.
   *
   *  And each read's value must go NOWHERE BUT the cone: exactly one use site. Homing resolves a
   *  render position for a read that had none, so a SECOND use resolves a second one, and the
   *  multi-render load rule then inlines the read at BOTH — two accesses where the asm has one
   *  `ldrh`, which for a volatile cell is precisely the duplication `volatileGlobal` refuses. Two
   *  homed values over one read is the same shape from the other side (each is the other's second
   *  use), so one test covers both. This is what makes "renders once, inside the home" a property
   *  rather than an aspiration: without it the axis silently doubles a hardware read.
   *
   *  The same block is what makes the axis's claim true at all: the register handoff it reproduces
   *  is one straight-line run of the asm, `ldrh` into `eor` into three uses. Across blocks WHICH
   *  BLOCK reads is `readsStayWhereWritten`'s question, not this one, and answering it here goes
   *  wrong in both directions — a value below a branch pulls the read into an arm that may not
   *  run, a value inside a loop pulls it in to run per iteration. Neither is a write, so no
   *  barrier sees either; for an ordinary cell they are worse spellings, and for a volatile one
   *  they are a missing access and a duplicated one. */
  const standsOnMovableRead = (op0: Op, blk: Block): boolean => {
    const reads: Op[] = [];
    const seen = new Set<Value>();
    const cone = [op0];
    while (cone.length) {
      const d = cone.pop()!;
      if (d.opcode === 'load' || d.opcode === 'aload') {
        reads.push(d);
        continue;
      }
      if (d.opcode === 'call' || d.opcode === 'gaddr' || d.opcode === 'laddr') {
        return false;
      }
      for (const x of d.operands) {
        if (!seen.has(x)) {
          seen.add(x);
          const dd = defOf.get(x);
          if (dd) {
            cone.push(dd);
          }
        }
      }
    }
    const at = { blk, idx: opIndex.get(op0)! };
    const coneReads = new Set(reads);
    const bars = (x: Op): boolean =>
      EFFECTFUL_OPS.has(x.opcode) || ((x.opcode === 'load' || x.opcode === 'aload') && !coneReads.has(x));
    return (
      reads.length > 0 &&
      reads.every(
        (r) =>
          opBlock.get(r) === blk && (useSitesOf.get(r.results[0])?.length ?? 0) === 1 && !memWriteBetween(r, at, bars),
      )
    );
  };
  /** 2+ distinct consuming ops — the multi-use the pure-op rule reads as a reused register. */
  const multiConsumer = (v: Value): boolean => new Set((useSitesOf.get(v) ?? []).map((s) => s.op)).size >= 2;
  /** THE def-block placement rule's loop refusal: is `b` a PREHEADER of some loop whose body holds
   *  one of the render blocks — outside the body, and a predecessor of the header?
   *
   *  Loop invariant motion (loop.c, which agbcc does compile and run at -O2) is the pass whose
   *  landing spot the source could not have spelled: it parks the read BELOW the loop guard, where
   *  a read the source wrote above the loop sits above it. Compiled,
   *  `for (i=0;i<n;i++) t += gK*i;` emits `mov r2,#0 / cmp r2,r3 / bge .L4 / ldr r0,.L8 /
   *  ldr r4,[r0]` — guard first, read after — while hoisting `gK` into a local above the loop by
   *  hand puts both `ldr`s ahead of the guard. So a read in the preheader is evidence of a read in
   *  the BODY, and inferring def-block placement there spells the one source the asm rules out.
   *  (With an aliasing store in the loop agbcc hoists only the address constant and leaves the
   *  `ldr` in the body — same conclusion, weaker premise.)
   *
   *  Narrow on purpose: a loop merely lying between def and render is not this shape. */
  const preheaderOfRenderLoop = (b: Block, renders: readonly Block[]): boolean =>
    loopBodies.some((L) => !L.body.has(b) && successorsOf(b).includes(L.header) && renders.some((x) => L.body.has(x)));
  /** THE def-block placement rule's seam refusal: does a FALL-THROUGH alone put a render below
   *  `b` — a chain of unconditional `br` edges, each into a block whose only predecessor is the
   *  one before it?
   *
   *  The frontends start a block at every LABEL, so a label nothing branches to cuts one straight
   *  line of asm in two and the upper half dominates the lower with no control flow between. The
   *  rule's premise is that the compiler will not move a read ACROSS a branch, which says nothing
   *  there — while WITHIN a straight line agbcc picks the order itself. Compiled, klonoa's
   *  StreamCmd_SetMusicParams (a stray `sub_0804E9AC:` between its last `ldrh r2,[r4]` and the
   *  `bl` consuming it) assembles byte-identical to its object from the inlined read and four
   *  bytes off from the named one, which swaps that `ldrh` with the `ldr r0,pool` beside it. Of
   *  the rule's 20 firings over the 464 klonoa agbcc functions, 13 were across such a seam. */
  const fallThroughSeam = (b: Block, renders: readonly Block[]): boolean => {
    const seen = new Set<Block>([b]);
    for (let cur = b; ;) {
      const t = cur.ops[cur.ops.length - 1];
      if (t?.opcode !== 'br') {
        return false;
      }
      const next = t.successors[0].block;
      if (predsOf.get(next)!.length !== 1 || seen.has(next)) {
        return false;
      }
      if (renders.includes(next)) {
        return true;
      }
      seen.add(next);
      cur = next;
    }
  };
  /** THE def-block placement rule's short-circuit refusal: values C evaluates only under a
   *  `&&`/`||` — the SECOND operand of every `logic_and`/`logic_or`, and everything it reads.
   *
   *  raise/shortcircuit.ts recovers a connective by hoisting the guarded arm's whole pure body,
   *  memory reads included, into the block ABOVE the branch (its value form and its control-flow
   *  form both splice that body into the head). ir/opcodes.ts states the safety argument as the
   *  reason a read is deliberately absent from HOIST_UNSAFE_OPS: the structurer inlines it back
   *  into the `&&`/`||` right-hand side, where C's own short circuit re-guards it. So for a value
   *  in that cone the def block is a FOLD ARTIFACT rather than the block the asm read in, and the
   *  whole premise this rule reads placement under does not hold there. Naming it also breaks the
   *  re-guard: `p != 0 && *p != 0` would emit `v0 = *p;` above its own null check.
   *
   *  An operand[0] cone is unconditional and keeps the rule; only the guarded side is collected. */
  const shortCircuitGuarded = new Set<Value>();
  /** THE def-block placement rule's copy refusal: is every use of the value a successor ARGUMENT,
   *  i.e. is the value nothing but a block parameter's incoming copy?
   *
   *  Then the parameter IS the read's home. Inlined, the edge assignment is the read
   *  (`v1 = mplay->tracks;`); materialized it becomes two names and a copy between them
   *  (`v0 = mplay->tracks; … v1 = v0;`) where the asm loaded straight into the register the
   *  parameter became — `ldr r1,[r4,#0x2C]` once, never a `mov`. Six of klonoa's matched m4a
   *  functions are that shape, and the manufactured copy costs more than the placement gains:
   *  scored against their own objects, dropping the refusal takes m4aMPlayVolumeControl 26→33,
   *  m4aMPlayPitchControl 36→39, m4aMPlayLFOSpeedSet 28→31 and FadeOutBody 69→73.
   *
   *  Note what this does NOT claim: those reads really do sit above the loop guard in the asm, so
   *  the placement inference was right and the SPELLING is what fails. Seating the read above the
   *  guard AND as the loop variable is loop-init hoisting, a capability this rule does not have. */
  const argUsedValues = new Set<Value>();
  const operandUsedValues = new Set<Value>();
  // Both sets serve that rule alone, so they are built only where it can fire — the same posture
  // `condBrArgFed` takes above (every other target pays nothing for a behavior it never declares).
  if (readsStayWhereWritten) {
    const guarded: Value[] = [];
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        for (const v of op.operands) {
          operandUsedValues.add(v);
        }
        for (const sc of op.successors) {
          for (const v of sc.args) {
            argUsedValues.add(v);
          }
        }
        if (op.opcode === 'logic_and' || op.opcode === 'logic_or') {
          guarded.push(op.operands[1]);
        }
      }
    }
    while (guarded.length) {
      const v = guarded.pop()!;
      if (shortCircuitGuarded.has(v)) {
        continue;
      }
      shortCircuitGuarded.add(v);
      guarded.push(...(defOf.get(v)?.operands ?? []));
    }
  }
  const onlyFeedsBlockParams = (v: Value): boolean => argUsedValues.has(v) && !operandUsedValues.has(v);
  // Decide in REVERSE program order so a consumer's own materialization is settled before any
  // producer asks for its emit position (SSA: uses follow defs in dominance/layout order) — and
  // iterate to a fixpoint for IR whose block layout does not follow dominance (hand-built IR):
  // materialize only GROWS, and growing it only moves render positions closer / adds barriers,
  // so the loop is monotone and converges.
  for (let sizeBefore = -1; sizeBefore !== materialize.size;) {
    sizeBefore = materialize.size;
    emitPosCache.clear();
    emitPosSetCache.clear(); // both render-position caches read `materialize`, which just grew
    for (let bi = fn.blocks.length - 1; bi >= 0; bi--) {
      const b = fn.blocks[bi];
      for (let oi = b.ops.length - 1; oi >= 0; oi--) {
        const op = b.ops[oi];
        if (materialize.has(op)) {
          continue;
        }
        if (op.opcode !== 'call' && op.opcode !== 'load' && op.opcode !== 'aload') {
          // PURE value-producing op (a constant, an address computation, arithmetic — NOT a
          // memory access). A value with ≥2 distinct-STATEMENT uses in the SSA is one the compiler
          // kept in a register and reused: the frontend never dedups, so multi-use exists ONLY
          // because the asm loaded/computed the value once and read the same register again.
          // Inlining it re-derives the value at each use (a fresh pool load / repeated address
          // arithmetic) — which the compiler did NOT do — so materialize it into a local instead,
          // reproducing that register. Pure ⇒ every render is value-identical, so (unlike a load)
          // no intervening memory write can invalidate a later render: multi-consumer suffices, no
          // barrier scan. Scope: a `const` that is LIVE ACROSS A CALL. A value the compiler needs
          // after a call must survive in a CALLEE-SAVED register — i.e. a local — because the call
          // clobbers the caller-saved ones; the compiler therefore loads it ONCE and keeps it,
          // exactly what materializing into a local reproduces (the base of `((s32 *)C)[i]` reused
          // across `foo(...)` calls). WITHOUT a call in its live range the const is instead cheaply
          // re-materialized at each use (a bare `movs r, #0` per init), so materializing it would
          // ADD pointless copies and MISS — hence the call gate (the small-constant regression).
          // Cheap deref casts still land on the `index` node at the use, preserving byte strides.
          // Second scope: a NON-const read by a sibling parallel-copy arg (`copyInterdependent`) —
          // the one place a pure value's inlining is not value-identical rendering but a
          // re-derivation the copy machinery is forced into. Address cones are excluded from it
          // (an `&g + i` rendered standalone loses the memAccess's inline `(u8 *)` cast —
          // cast-aware base materialization is separate), and consts are not in it at all: a
          // re-derived const is re-materialization, which is the compiler's own behavior.
          const pr = op.results[0];
          if (op.opcode === 'const' && pr && useSitesOf.has(pr)) {
            const cons = [...new Set((useSitesOf.get(pr) ?? []).map((s) => s.op))];
            if (cons.length > 1 && liveAcrossCall(op, cons)) {
              materialize.add(op);
            }
          } else if (op.opcode !== 'const' && pr && copyInterdependent.has(pr) && !addressCone(op)) {
            materialize.add(op);
          }
          // The three AXIS scopes below are one `materialize.add(op)` behind three shared refusals,
          // differing only in an eligibility predicate, and rank.ts already carries them as a data
          // table — folding them into one is BOOKED in docs/level-tower.md and unpaid.
          // Third scope, under the address-home axis only (see AnalyzeOptions.homeSharedAddresses):
          // a non-const pure value consumed ONLY as the base of 2+ memory accesses.
          if (
            homeSharedAddresses &&
            op.opcode !== 'const' &&
            pr &&
            usedOnlyAsSharedBase(pr) &&
            !addressCone(op) &&
            !multiBlockHeaders.has(b)
          ) {
            materialize.add(op);
            axisHomedBases.add(pr);
          }
          // Fourth scope, under the loop-expression-home axis (AnalyzeOptions.homeLoopExprs): a
          // pure non-const value with 2+ distinct consumers, at least one of them inside a loop the
          // def sits outside. Shared bases stay the previous scope's (its load rule needs the
          // registration).
          if (
            homeLoopExprs &&
            op.opcode !== 'const' &&
            pr &&
            !usedOnlyAsSharedBase(pr) &&
            loopSharedConsumers(pr, b) &&
            !addressCone(op) &&
            !multiBlockHeaders.has(b)
          ) {
            materialize.add(op);
          }
          // Fifth scope, under the derived-read-home axis (AnalyzeOptions.homeDerivedReads): a
          // pure non-const value with 2+ consumers standing on a memory read. Shared bases stay
          // the third scope's and values consumed across a loop the fourth's; what this one adds
          // is the straight-line case, which neither reaches.
          if (
            homeDerivedReads &&
            op.opcode !== 'const' &&
            pr &&
            !usedOnlyAsSharedBase(pr) &&
            !rendersAsAddress(op) &&
            multiConsumer(pr) &&
            standsOnMovableRead(op, b) &&
            !multiBlockHeaders.has(b)
          ) {
            materialize.add(op);
          }
          continue;
        }
        const r = op.results[0];
        if (!r || !useSitesOf.has(r)) {
          continue;
        } // dead call → exprstmt (unchanged)
        // Under the value-home axis: which named global cell this op reads, if any. A constant-
        // offset `load` only — an `aload`'s runtime index names no single cell, and a call reads
        // everything. Null ⇒ every write bars, exactly as before.
        const cell =
          rereadGlobals && defs && op.opcode === 'load'
            ? globalCellOf(defs, op.operands[0], op.attrs.off as number)
            : null;
        const barsThisRead = cell && defs && !volatileGlobal?.(cell.name) ? mayWriteGlobal(defs, cell.name) : null;
        if (materializeJoinFeeds && op.opcode === 'load' && condBrArgFed.has(r)) {
          materialize.add(op);
          continue;
        }
        const sites = useSitesOf.get(r)!;
        const consumers = [...new Set(sites.map((s) => s.op))];
        const isCall = op.opcode === 'call';
        // A call must EXECUTE once — any second operand slot duplicates it → named temp.
        if (isCall && sites.length > 1) {
          materialize.add(op);
          continue;
        }
        // Live across a LOOP neither side belongs to: the access ran before the loop and the
        // value crossed it in a callee-saved register (hipress's `keep = p[1]`, homed in r8 and
        // touched only by `mov`). Rendering at the use would re-schedule the access to the far
        // side of the loop — the same refusal liveAcrossCall makes for a call, applied to a loop.
        if (liveAcrossLoop(op, r, consumers)) {
          materialize.add(op);
          continue;
        }
        // ── DEF-BLOCK PLACEMENT (readsStayWhereWritten; see AnalyzeOptions) ──────────────────
        // Every render in a block this one strictly dominates, with a branch between ⇒ the asm
        // read once above that branch, and re-spelling the read there reproduces it. ONE render
        // suffices — the short-circuit-into-a-call shape has exactly one — and an unresolvable
        // render position refuses, as everywhere else. Both memory reads, spelled positively: a
        // `call` is the enclosing arm's other member and has its own execute-once rules above.
        if (
          (op.opcode === 'load' || op.opcode === 'aload') &&
          readsStayWhereWritten &&
          dom &&
          !multiBlockHeaders.has(b) &&
          !shortCircuitGuarded.has(r) &&
          !onlyFeedsBlockParams(r)
        ) {
          const at = consumers.map((c) => emitPos(c));
          const rb = at.some((p) => p === null) ? null : [...new Set(at.map((p) => p!.blk))];
          if (
            rb &&
            rb.length > 0 &&
            rb.every((x) => x !== b && dom.get(x)!.has(b)) &&
            !preheaderOfRenderLoop(b, rb) &&
            !fallThroughSeam(b, rb)
          ) {
            materialize.add(op);
            continue;
          }
        }
        // Address-home axis: a multi-render load THROUGH a base this axis homed re-reads what the
        // asm read once into the register the home just reproduced — home the value too, at the
        // load's own position. Only through axis-homed bases (the fixpoint's later sweep sees them
        // even though reverse order visits the load first); the general multi-render re-read stays
        // the default rule below. axisHomedBases registers on the same sweep that materializes the
        // base — safe because no other rule can pre-empt a value the axis would home: base-slot-only
        // means no successor-arg use (outside copyInterdependent's read set), and the axis's scope
        // excludes consts, the const arm's only clientele.
        if (
          homeSharedAddresses &&
          op.opcode === 'load' &&
          consumers.length > 1 &&
          axisHomedBases.has(op.operands[0]) &&
          !multiBlockHeaders.has(b)
        ) {
          materialize.add(op);
          continue;
        }
        // A MULTI-RENDER load re-reads memory at each render — which is exactly what the original
        // per-use source spelling did (`while (*s != EOS) *d = *s;` reads *s twice per iteration),
        // so it is sound iff every render still sees the def-time memory: NO write anywhere
        // between the def and ANY render (cycle-aware, conservative write set). Otherwise a temp.
        //
        // WHERE it renders. Without the axis: one position per consumer, and a consumer with no
        // single position (its own value renders in several places) refuses. With the axis a load
        // resolves the whole SET instead — the second half of the value-home defect, where the
        // local is invented not by a barrier but because the pure expression downstream is itself
        // duplicated (`gOut = (gValue << 1) + gValue; return (gValue << 1) + gValue;`). Never for a
        // call: several positions there mean several executions.
        const poss =
          rereadGlobals && !isCall
            ? emitPositions(op)
            : consumers.length > 1
              ? consumers.map((c) => emitPos(c))
              : [emitPos(consumers[0])];
        if (!poss || poss.some((p) => p === null)) {
          materialize.add(op);
          continue;
        }
        if (poss.length > 1) {
          const isWrite = barsThisRead ?? ((x: Op) => EFFECTFUL_OPS.has(x.opcode));
          if (poss.some((p) => memWriteBetween(op, p!, isWrite))) {
            materialize.add(op);
          }
          continue;
        }
        const pos = poss[0]!;
        // A between-op is a BARRIER when it renders as a sequenced statement the def would cross:
        // stores/opaque always; a call/load that is dead (statement), materialized (statement), or
        // inlined into a DIFFERENT statement. A sibling effect inlined into the SAME statement is
        // not a reorder — the recompiling compiler orders unsequenced operands of one expression
        // exactly as it originally chose to. Loads never bar a load (reads don't conflict).
        const samePos = (q: { blk: Block; idx: number } | null) => q !== null && q.blk === pos.blk && q.idx === pos.idx;
        const isBarrier = (x: Op): boolean => {
          // Value-home axis: a store/astore this read is PROVABLY disjoint from (a different named
          // global) does not sequence against it, so the read may still render at its use.
          if (barsThisRead && (x.opcode === 'store' || x.opcode === 'astore') && !barsThisRead(x)) {
            return false;
          }
          if (x.opcode === 'store') {
            // A store to a PROVABLY-DISJOINT slot of the same base never aliases the load: same
            // base SSA value, both constant offset+width, ranges non-overlapping (the everyday
            // struct interleave `… = p->field_0; p->field_4 = …`). Anything less certain bars.
            if (!isCall && op.opcode === 'load' && x.operands[0] === op.operands[0]) {
              const lo = op.attrs.off as number,
                lw = op.attrs.width as number;
              const so = x.attrs.off as number,
                sw = x.attrs.width as number;
              if (so + sw <= lo || lo + lw <= so) {
                return false;
              }
            }
            return true;
          }
          if (x.opcode === 'astore' || x.opcode === 'opaque') {
            return true;
          }
          if (x.opcode === 'call') {
            return !x.results.length || !useSitesOf.has(x.results[0]) || materialize.has(x) || !samePos(emitPos(x));
          }
          if (!isCall) {
            return false;
          } // a load never bars a load
          if (x.opcode === 'load' || x.opcode === 'aload') {
            return !x.results.length || !useSitesOf.has(x.results[0])
              ? false // dead load: never emitted at all
              : materialize.has(x) || !samePos(emitPos(x));
          }
          return false;
        };
        // A CROSS-BLOCK call's execution would become path-dependent — always materialize. Within
        // its own block a call is judged like everything else, by the barrier scan below.
        if (isCall && pos.blk !== b) {
          materialize.add(op);
          continue;
        }
        // Otherwise: inline only if no barrier stands on any def-avoiding def→render path.
        if (memWriteBetween(op, pos, isBarrier)) {
          materialize.add(op);
        }
      }
    }
  }
  return { useSitesOf, opIndex, opBlock, liveIn, materialize, reachFrom, emitPos, memWriteBetween };
}
