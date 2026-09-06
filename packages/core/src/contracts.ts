// asmlift — stage boundary contracts: semantic POSTCONDITIONS enforced in production at the
// stage boundaries, in every entry path (decompile / decompileTraced / the cli's
// decompileRanked / decompileWithReport).
// A pass that regresses fails AT its boundary with a diagnostic, not three stages later as
// wrong C.
import { type Block, type Fn, type Value, successorsOf } from './ir/core';
import { type IrType, typeToString } from './ir/types';
import type { BinOp, Expr, SFn, Stmt } from './l3/ast';
import {
  exprChildren,
  fieldSpellsDot,
  gapReasonFor,
  mapExprChildren,
  stmtChildren,
  stmtExprs,
  stmtLists,
} from './l3/ast';
import { declaredTypes, exprCType } from './l3/typing';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

// An `unknown` may hide NESTED inside a pointer (`ptr(unknown)` prints as `unk32 *` — uncompilable,
// since `unk32` isn't a real typedef). Check the whole type, not just its top-level kind.
function hasUnknown(t: IrType): boolean {
  return t.kind === 'unknown' || (t.kind === 'ptr' && hasUnknown(t.to));
}

/** Post type-recovery: no SSA value may still be `unknown` (at any depth). Recovery is total by
 *  construction (it defaults every residual to s32), so a surviving `unknown` means a recovery pass
 *  stopped short — caught here, before it poisons a downstream type decision or the emitted
 *  signature. */
export function assertTypesRecovered(fn: Fn): void {
  const check = (v: Value, what: string) => {
    if (hasUnknown(v.type)) {
      throw new ContractError(`type recovery left ${what} unknown in '${fn.name}'`);
    }
  };
  for (const b of fn.blocks) {
    b.params.forEach((p, i) => check(p, `param #${i}`));
    for (const op of b.ops) {
      op.results.forEach((r, i) => check(r, `${op.opcode} result #${i}`));
    }
  }
}

/** Post structuring: the AST must reference no unresolved name. The structurer emits the sentinel
 *  var `"?"` when it cannot resolve a value (a dropped def, or an opcode it has no lowering for),
 *  which would print as uncompilable source. Fail at the boundary instead of emitting garbage.
 *
 *  `undefined` is the same failure from the other side — not a spelling the structurer chooses
 *  (`Expr` declares `name: string`) but a `varName.get(v)!` whose value was never adopted, printing
 *  as the token `undefined`. Both are checked on every ROUTE a name takes into the AST, and those
 *  are not all expressions: `var` / `addr` / `field` / `call` carry one, and so does an `assign`'s
 *  DESTINATION — a bare string field the expression walk never reaches. */
export function assertResolved(sfn: SFn): void {
  // Derived from the shared exprChildren/stmtExprs/stmtChildren traversal so no statement kind
  // can be missed. A gap `marker` is annotate-mode's DESIGNED spelling of an unresolved value
  // ("resolved" by construction); only its args could still hide a stray name — and args are
  // exactly its children.
  const badName = (n: string | undefined): boolean => n === '?' || n === undefined;
  // Every Expr kind that CARRIES a name, not just `var` — each is read through the same
  // `map.get(d)!` / `attrs.x as string` and prints straight into the source. `carriesName` is asked
  // separately because an ABSENT name is the case being caught: keying off `nameOf` alone refuses nothing.
  const carriesName = (e: Expr): boolean => e.k === 'var' || e.k === 'addr' || e.k === 'field' || e.k === 'call';
  const nameOf = (e: Expr): string | undefined =>
    e.k === 'call' ? e.fn : e.k === 'marker' ? undefined : (e as { name?: string }).name;
  const badExpr = (e: Expr): boolean => (carriesName(e) && badName(nameOf(e))) || exprChildren(e).some(badExpr);
  // An `assign`'s DESTINATION is a bare string field, so the expression walk never reaches it.
  const badStmt = (s: Stmt): boolean =>
    (s.k === 'assign' && badName(s.name)) || stmtExprs(s).some(badExpr) || stmtChildren(s).some(badStmt);
  if (sfn.body.some(badStmt)) {
    throw new ContractError(
      `structuring left an unresolved name ('?' or one never adopted) in '${sfn.name}' — ` +
        `a dropped def, an unlowered opcode, or a name the structurer assumed the naming pipeline gave it`,
    );
  }
}

// ── effects: executed once, never dropped ──────────────────────────────────────────────────
//
// The three contracts around this one are about TYPING and SPELLABILITY. Nothing checked the
// property the structurer's materialization model exists to preserve: a call in the asm must run
// exactly as often in the emitted source. Its two failure modes are the two that hurt most —
// asmlift's first rule is that a loud failure beats a silently wrong answer, and both of these are
// silent:
//
//   • DROPPED — a call the asm makes has no counterpart in the tree at all;
//   • RE-RUN  — inlining a call's value at more than one render position (or a structuring copy
//     that duplicates a region onto a single path) makes one call execute twice. The round that
//     recovered switch fall-through hit exactly this shape, and only an adversarial reviewer
//     caught it.
//
// Deliberately narrow, so it never declines a function that is fine:
//
//   • CALLS only. Loads legitimately re-render (that is the whole point of the inline-at-use
//     model, and the alias gate governs it); stores are checked by neither direction here because
//     the readability DCE pass is allowed to drop a provably dead one.
//   • PER PATH, not per tree. Structuring may legitimately emit one block twice — two exclusive
//     switch arms sharing a body, a duplicated return merge — and each path still executes it
//     once. So the duplication rule compares the maximum over syntactic root-to-leaf paths (a
//     branch takes the max of its arms, a loop body counts once, a fall-through arm chains into
//     the next) against the IR's static count.
//   • Names the IR does not have are ignored, and only calls carrying a target symbol are counted
//     (every frontend that emits `call` today stamps one).
type CallCounts = Map<string, number>;

/** per-key combine of two count maps (`sum` for sequence, `max` for exclusive alternatives) */
function combine(a: CallCounts, b: CallCounts, f: (x: number, y: number) => number): CallCounts {
  const out = new Map(a);
  for (const [k, v] of b) {
    out.set(k, f(out.get(k) ?? 0, v));
  }
  return out;
}

/** every `call` expression under `e`, counted by target name */
function callsInExpr(e: Expr, into: CallCounts): void {
  if (e.k === 'call') {
    into.set(e.fn, (into.get(e.fn) ?? 0) + 1);
  }
  exprChildren(e).forEach((c) => callsInExpr(c, into));
}

/** `total` = every occurrence in the tree; `path` = the most any single syntactic path executes */
function countCalls(stmts: Stmt[]): { total: CallCounts; path: CallCounts } {
  let total: CallCounts = new Map();
  let path: CallCounts = new Map();
  const add = (r: { total: CallCounts; path: CallCounts }, pathF: (x: number, y: number) => number) => {
    total = combine(total, r.total, (x, y) => x + y);
    path = combine(path, r.path, pathF);
  };
  for (const s of stmts) {
    const own: CallCounts = new Map();
    stmtExprs(s).forEach((e) => callsInExpr(e, own));
    add({ total: own, path: own }, (x, y) => x + y);
    if (s.k === 'if') {
      const t = countCalls(s.then);
      const e = countCalls(s.else);
      // exclusive arms: the path count is whichever arm runs, the total counts both
      add(
        { total: combine(t.total, e.total, (x, y) => x + y), path: combine(t.path, e.path, Math.max) },
        (x, y) => x + y,
      );
    } else if (s.k === 'switch') {
      const arms = s.cases.map((c) => countCalls(c.body));
      const dflt = countCalls(s.default ?? []);
      // A fall-through arm continues into the NEXT one emitted (the last into `default`), so a
      // path through arm i runs the chain starting at i — the shape the fall-through round's
      // CRITICAL took. Built from the end; `chain[i]` is that arm's per-path count.
      const chain: CallCounts[] = new Array(arms.length);
      for (let i = arms.length - 1; i >= 0; i--) {
        const next = i + 1 < arms.length ? chain[i + 1] : dflt.path;
        chain[i] = s.cases[i].fallsThrough ? combine(arms[i].path, next, (x, y) => x + y) : arms[i].path;
      }
      const armTotal = arms.reduce((acc, a) => combine(acc, a.total, (x, y) => x + y), dflt.total);
      const armPath = chain.reduce((acc, c) => combine(acc, c, Math.max), dflt.path);
      add({ total: armTotal, path: armPath }, (x, y) => x + y);
    } else {
      // Sequenced children (a loop body, a `for`'s init/inc): counted ONCE — a loop's dynamic trip
      // count is not a syntactic occurrence, and the IR side is static too.
      for (const c of stmtChildren(s)) {
        add(countCalls([c]), (x, y) => x + y);
      }
    }
  }
  return { total, path };
}

/**
 * Post structuring: every call the asm makes is emitted, and none is emitted more times than the
 * asm makes it on any one path. See the note above for what this deliberately does not cover.
 */
export function assertEffectsPreserved(fn: Fn, sfn: SFn): void {
  // Reachable blocks only: an unreachable block's call is legitimately never emitted.
  const seen = new Set<Block>([fn.blocks[0]]);
  for (const stack = [fn.blocks[0]]; stack.length;) {
    for (const s of successorsOf(stack.pop()!)) {
      if (!seen.has(s)) {
        seen.add(s);
        stack.push(s);
      }
    }
  }
  const irCalls: CallCounts = new Map();
  // Unmodelled instructions, by the mnemonic the frontend stamped. Same "never dropped" property as
  // a call, and it needs its own tally because an `opaque` carries no `target`.
  const irOpaques = new Set<string>();
  for (const b of seen) {
    for (const op of b.ops) {
      if (op.opcode === 'call' && typeof op.attrs.target === 'string') {
        const t = op.attrs.target;
        irCalls.set(t, (irCalls.get(t) ?? 0) + 1);
      } else if (op.opcode === 'opaque') {
        irOpaques.add(gapReasonFor(op.attrs.mnemonic));
      }
    }
  }
  // DROPPED only, not the RE-RUN half: a gap rendered twice is a diagnostic printed twice, which
  // costs nothing because nothing recompiles it, and structuring legitimately duplicates a shared
  // arm — so a per-path count here would fire on correct output.
  //
  // Bites only in ANNOTATE mode (under `strict` the gap is the `?` sentinel and structure() has
  // already thrown), which is where it is needed: that is the CLI and benchmark default, and the
  // only mode with no other backstop against a silently dropped opaque.
  if (irOpaques.size) {
    const emitted = new Set<string>();
    const we = (e: Expr): void => {
      if (e.k === 'marker') {
        emitted.add(e.reason);
      }
      exprChildren(e).forEach(we);
    };
    const ws = (s: Stmt): void => {
      stmtExprs(s).forEach(we);
      stmtChildren(s).forEach(ws);
    };
    sfn.body.forEach(ws);
    for (const reason of irOpaques) {
      if (!emitted.has(reason)) {
        throw new ContractError(
          `structuring dropped the ${reason} in '${sfn.name}' — an instruction asmlift could not model left no trace`,
        );
      }
    }
  }
  if (!irCalls.size) {
    return;
  }
  const { total, path } = countCalls(sfn.body);
  for (const [name, n] of irCalls) {
    if (!(total.get(name) ?? 0)) {
      throw new ContractError(`structuring dropped the call to '${name}' in '${sfn.name}' — its effect is lost`);
    }
    const p = path.get(name) ?? 0;
    if (p > n) {
      throw new ContractError(
        `structuring emitted ${p} calls to '${name}' on one path in '${sfn.name}', where the asm makes ${n}`,
      );
    }
  }
}

/** Post structuring: a local the body READS must be WRITTEN somewhere in it. A materialized value
 *  renders as one `v = …` statement at its def's position while every use reads the bare name, so
 *  any pass that DISCARDS the statement's position — a collapsed switch test block, a suppressed
 *  edge copy — leaves the reads standing over whatever the register allocator left behind. That is
 *  the one wrongness the byte differ rewards rather than catches: the candidate compiles, scores,
 *  and can win.
 *
 *  PRESENCE, not reaching definitions. The stronger question needs path sensitivity through
 *  `switch` fall-through, `do-while` and `break`, where a false positive DECLINES a function that
 *  is fine; assigned nowhere at all needs none of that and has no legitimate producer. Two local
 *  kinds are exempt and both say so in their declaration: an `uninit` local stands on an `undef`,
 *  where the missing assignment IS the recovery, and a `frame` local is the machine's own slot,
 *  whose store the readability passes between here and L3 may have dropped. */
export function assertLocalsWritten(sfn: SFn): void {
  const suspect = new Set(sfn.locals.filter((l) => !l.frame && !l.uninit).map((l) => l.name));
  if (!suspect.size) {
    return;
  }
  const read = new Set<string>();
  const written = new Set<string>();
  // `&v` is a write channel this walk cannot follow — the callee/store behind it may fill the
  // object — so it counts as one.
  const walkExpr = (e: Expr): void => {
    if ((e.k === 'var' || e.k === 'addr') && suspect.has(e.name)) {
      (e.k === 'addr' ? written : read).add(e.name);
    }
    exprChildren(e).forEach(walkExpr);
  };
  const walkStmt = (st: Stmt): void => {
    if (st.k === 'assign' && suspect.has(st.name)) {
      written.add(st.name);
    }
    stmtExprs(st).forEach(walkExpr);
    stmtChildren(st).forEach(walkStmt);
  };
  sfn.body.forEach(walkStmt);
  const orphans = [...read].filter((n) => !written.has(n));
  if (orphans.length) {
    throw new ContractError(
      `structuring emitted local(s) ${orphans.map((n) => `'${n}'`).join(', ')} in '${sfn.name}' read but ` +
        `never assigned — a def whose assignment no render position emitted`,
    );
  }
}

/** Post-lever: every read of a MINTED local — its ADDRESS being taken included — must sit where
 *  that local's assignment has already run.
 *
 *  THE failure a placing lever can ship, and the only one the byte differ rewards: a base local whose
 *  assignment does not reach a use is a DIFFERENT VARIABLE — C that compiles, scores, and can win
 *  (the shape #106 shipped). `contracts.ts`'s `assertLocalsWritten` does not see it: it accumulates
 *  reads and writes as SETS over the whole body, so a local assigned in one arm and read after the
 *  `if` is written somewhere and passes.
 *
 *  Checked on the EMITTED tree rather than argued from the plan, because the plan is what a bug
 *  would be in. `rank.ts`'s `respell` catches the throw and drops the candidate, so the wrong
 *  answer becomes a reported lever error instead of a scored spelling.
 *
 *  IT LIVES HERE, beside `assertLocalsWritten`, because it has that check's population and that
 *  check's call site: levers that place a def — l3/sinkinit.ts, l3/basecse.ts's first-use policy,
 *  l3/nearbase.ts, l3/reindex.ts, l3/scopebase.ts, l3/argbase.ts — are the population that can
 *  produce the failure, so the check belongs on every lever tree rather than on one lever's.
 *
 *  ABSOLUTELY, it has one caller (l3/scopebase.ts, over its own plan). Everywhere else it is
 *  reached through `assertPlacementSurvives` below, which is a DIFFERENTIAL — so a placement no
 *  lever's tree ever satisfied is not judged, and a lever that mints nothing is not judged at all.
 *
 *  A nested list gets a COPY of the reaching set, so an assignment inside one arm does not count as
 *  reaching anything after the `if`. */
export function assertHoistsDominate(sfn: SFn, minted: ReadonlySet<string>): void {
  if (minted.size === 0) {
    return;
  }
  const readUndominated = (e: Expr, live: ReadonlySet<string>): string | null => {
    // `&p` COUNTS, the same mention the placing passes query on (l3/hoist.ts): the address is what
    // a callee reads the cell through, so an init has to precede it as surely as it must precede a
    // read.
    if ((e.k === 'var' || e.k === 'addr') && minted.has(e.name) && !live.has(e.name)) {
      return e.name;
    }
    let bad: string | null = null;
    mapExprChildren(e, (c) => {
      bad ??= readUndominated(c, live);
      return c;
    });
    return bad;
  };
  const judge = (heads: readonly Expr[], live: ReadonlySet<string>): void => {
    for (const e of heads) {
      const bad = readUndominated(e, live);
      if (bad) {
        throw new ContractError(
          `'${sfn.name}' reads '${bad}' where its assignment does not reach — ` +
            `a def placed below a use it claims to serve`,
        );
      }
    }
  };
  const walk = (list: Stmt[], live: Set<string>): void => {
    for (const st of list) {
      // A `for`'s INIT runs once, before the condition, the inc and the body — so its assignment
      // reaches all three, and the loop's own parts are statements with their own nested lists.
      // `l3/reindex.ts` mints an induction variable whose ONLY def is that init, so reading the
      // `for` as one flat head list rejects every counted walk it spells.
      if (st.k === 'for') {
        walk([st.init], live);
        judge(stmtExprs(st), live);
        walk([st.inc], new Set(live));
        walk(st.body, new Set(live));
        continue;
      }
      judge(stmtExprs(st), live);
      for (const child of stmtLists(st)) {
        walk(child, new Set(live));
      }
      if (st.k === 'assign' && minted.has(st.name)) {
        live.add(st.name);
      }
    }
  };
  walk(sfn.body, new Set());
}

/** The same guarantee across a re-spelling that MOVES statements over a placement another pass
 *  already made — `rank.ts`'s statement shapes (`/initfirst`, `/pollguard`, `/pollread`), derived
 *  onto every lever tree after the lever placed its defs, and the lever-on-lever compositions in
 *  the same file where a def-moving pass (`sinkInitsToFirstUse`, `nearBaseClusters`,
 *  `reindexWalks`) runs on a tree a placing lever built. `pollReads` folds a materialized re-read
 *  back into a loop condition, which is exactly such a move.
 *
 *  A DIFFERENTIAL, which is what makes it safe on every lever: the walk judges the reshaped tree
 *  only where it already described the unshaped one, so a placement it cannot model (a def inside
 *  a loop body read earlier in the same body is assigned on every iteration but the first) is not
 *  judged either way. `minted` may name a local `before` does not carry — a mover mints its own —
 *  and that one is judged absolutely, which is the same thing: a name absent from `before` is
 *  never read there. */
export function assertPlacementSurvives(before: SFn, after: SFn, minted: ReadonlySet<string>): void {
  if (minted.size === 0) {
    return;
  }
  try {
    assertHoistsDominate(before, minted);
  } catch {
    return;
  }
  assertHoistsDominate(after, minted);
}

/** Post structuring: the AST's memory accesses and operators must be SPELLABLE — a `field`
 *  node's base a pointer-to-struct (`->`) or a struct value (`.`, an array element) carrying
 *  that field; no pointer operand under an operator C rejects; and every SCALAR `index` node's
 *  width a real C scalar width (a regressing pass emitting width 3 would print as the
 *  nonexistent `(u24 *)` typedef and fail at candidate compile three stages later). Index BASES
 *  are deliberately not checked: the width-carrying node makes every base legalizable — the C
 *  family casts at the node's width, Pascal declines loud — so a non-pointer base is a backend
 *  spelling decision, not an ill-formed tree. Only DEFINITE violations throw: an expression
 *  whose C type is not statically knowable here (a call's return, a gap marker) passes. */
export function assertDerefsTyped(sfn: SFn): void {
  const vt = declaredTypes(sfn);
  const ctype = (e: Expr): IrType | undefined => exprCType(e, vt);
  const bad: string[] = [];
  // A `void` function must not RETURN A VALUE. Holds by construction today — returnType() answers
  // void only when every `ret` is operand-less — but `retType` has two producers (the recovered
  // type and the prototype's `returnsVoid`) and the value-suppression lives in a third place
  // (structure.ts's return lowering), so a regressing edit to any of them prints `return expr;`
  // inside a void function. That is ill-formed C the candidate compiler only rejects two stages
  // later, with a diagnostic pointing at the symptom rather than the pass. Cheap to state here.
  if (sfn.retType.kind === 'void') {
    const valued = (stmts: Stmt[]): boolean =>
      stmts.some((s) => (s.k === 'return' && s.value !== undefined) || valued(stmtChildren(s)));
    if (valued(sfn.body)) {
      bad.push(`function '${sfn.name}' is typed void but a return carries a value`);
    }
  }
  // Ops C rejects outright on a pointer operand (the additive ops and &&/|| are legal C).
  const NO_PTR_OPS = new Set<BinOp>(['&', '|', '^', '<<', '>>', '>>>', '*', '/', '/u', '%', '%u']);
  // The comparison operators — where a bare `&SYM` operand is SIGN-ambiguous, not ill-formed.
  const CMP_OPS = new Set(['<', '<=', '>', '>=', '==', '!=']);
  // 1/2/4 only: the decomp typedef vocabulary (C_TYPEDEFS) has no 64-bit scalar, so a width-8
  // access would print as the nonexistent `(s64 *)` — exactly the three-stages-later failure
  // this rule pre-empts. (If f64 loads ever land they are floats, not a scalar width here.)
  const SCALAR_WIDTHS = new Set([1, 2, 4]);
  // Dot-form field bases (struct-array elements) carry the struct STRIDE as their width — any
  // stride matching the element size is legal there (the tree-level struct cast governs the
  // spelling; a stride/size MISMATCH types scalar in exprCType and the field rule flags it).
  // Collected as fields are visited, BEFORE recursing into their children. Identity-keyed: a
  // future subtree-SHARING pass (CSE-style) would leak the exemption to aliased bare uses —
  // trees are freshly built per node today (structure.ts), which this relies on.
  const structElem = new Set<Expr>();
  const checkExpr = (e: Expr): void => {
    if (e.k === 'index' && !structElem.has(e) && !SCALAR_WIDTHS.has(e.width)) {
      bad.push(`index width ${e.width} is not a C scalar width`);
    }
    // The emitter legalizes pointer operands away from these ops (structure.ts intify); a
    // pointer surviving here is ill-typed C the compiler will reject.
    if (e.k === 'bin' && NO_PTR_OPS.has(e.op)) {
      for (const side of [e.l, e.r]) {
        if (ctype(side)?.kind === 'ptr') {
          bad.push(`pointer operand under '${e.op}'`);
        }
      }
    }
    // A bare global ADDRESS `&SYM` under `+`/`-` is an ESCAPING interior pointer: C scales the byte
    // offset by sizeof(SYM), which is unknown for a header-typed global, so `&SYM + N` is byte-
    // inexact. Nothing emits this shape anymore: a load/store base folds byte-correctly (globalOf
    // turns `&SYM + N` into an `index`/`field` node whose base is a bare `addr`), and the additive
    // lowering intifies every other `addr` operand to `(u32)&SYM` (structure.ts intifyAddr — the
    // cast types int, so it never lands here). A bare `addr` reaching a `+`/`-` operand is therefore
    // a lowering REGRESSION — flag it rather than emit wrong bytes.
    if (e.k === 'bin' && (e.op === '+' || e.op === '-')) {
      const addrSide = e.l.k === 'addr' ? e.l : e.r.k === 'addr' ? e.r : undefined;
      if (addrSide) {
        bad.push(`interior pointer arithmetic on the global address '&${addrSide.name}'`);
      }
    }
    // A bare global address `&SYM` as a COMPARISON operand is the same unspelled escape under a
    // different operator — and worse than ill-formed: the compare's SIGNEDNESS is spelled by the
    // operand TYPES (the structurer maps icmp_ult and icmp_slt to the same '<'), and `&SYM`'s C
    // type is the project's own declaration, unknowable here — so the emitted compare can flip
    // signedness against the asm's, silently. The cmp lowering intifies it signedness-aware
    // (`(u32)`/`(s32)&SYM` — structure.ts intifyAddrCmp; the cast types int, so it never lands
    // here). A bare `addr` reaching a comparison operand is therefore a lowering REGRESSION —
    // flag it rather than emit sign-ambiguous C.
    if (e.k === 'bin' && CMP_OPS.has(e.op)) {
      for (const side of [e.l, e.r]) {
        if (side.k === 'addr') {
          bad.push(`bare global address '&${side.name}' as a comparison operand`);
        }
      }
    }
    // `!p` is legal C (pointer truthiness); `-p`/`~p` are not.
    if (e.k === 'un' && e.op !== '!' && ctype(e.e)?.kind === 'ptr') {
      bad.push(`pointer operand under unary '${e.op}'`);
    }
    if (e.k === 'field') {
      if (fieldSpellsDot(e)) {
        structElem.add(e.base);
      }
      const bt = ctype(e.base);
      if (bt) {
        // type-check against the same dot-vs-arrow spelling the printer will use (shared rule)
        const st = fieldSpellsDot(e) ? bt : bt.kind === 'ptr' ? bt.to : undefined;
        if (!st || st.kind !== 'struct') {
          bad.push(`member access '${e.name}' on a non-struct base (C type '${typeToString(bt)}')`);
        } else if (!st.fields.some((f) => f.name === e.name)) {
          bad.push(`member access '${e.name}' not declared on '${st.name}'`);
        }
      }
    }
    exprChildren(e).forEach(checkExpr);
  };
  const checkStmt = (s: Stmt): void => {
    stmtExprs(s).forEach(checkExpr);
    stmtChildren(s).forEach(checkStmt);
  };
  sfn.body.forEach(checkStmt);
  if (bad.length) {
    throw new ContractError(
      `structuring emitted ill-typed C in '${sfn.name}': ${bad[0]}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}`,
    );
  }
}
