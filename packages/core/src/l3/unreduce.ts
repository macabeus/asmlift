// L3 re-spelling lever: UN-REDUCE a loop-carried accumulator — delete `v = INIT; … v = v + K;`
// and spell each read as the closed form `INIT[start := counter]`.
//
//     v0 = (a0 << 6) + a1;                    while (v1 <= 31) {
//     while (v1 <= 31) {              ⇒          *(s32 *)REG = (v1 << 6) + a1;
//       *(s32 *)REG = v0;                        v1 = v1 + 1;
//       v0 = v0 + 64; v1 = v1 + 1; }           }
//
// WHY IT IS A SPELLING AND NOT A FIX. Strength reduction is a compiler pass, so the accumulated
// form is what the ASM shows whichever form the source had — a source `a[i]` and a source
// `p = a; … p++` compile to the same induction variable. asmlift recovers the reduced form
// because that is what the machine ran; the un-reduced form is the other pre-image, and the differ
// referees. (l3/reindex.ts makes the same argument for a POINTER WALK; this is its scalar-value
// sibling, and the two do not overlap — `reindexWalks` refuses a function with no pointer local.)
//
// WHAT IT BUYS, and it is not readability. A compiler-created giv init is emitted by
// `emit_iv_add_mult` at `loop_start` (gcc/loop.c:4761, inserted at :6985) — during
// `strength_reduce`, which agbcc runs AFTER `move_movables` hoists the loop invariants
// (gcc/loop.c:1151 then :1173). Both insert immediately before the loop, so the giv's init lands
// BELOW everything the invariant hoist put there. No C statement can reach that slot: statement
// order forces a user-written assignment above the whole preheader. Measured on
// synthetic:dmafill, holding the rest fixed — a plain statement before the loop scores 19, the
// same statement under an explicit guard 15, and letting the compiler create the giv 0.
//
// SEMANTICS. The rewrite rests on one invariant: at every read, `acc == g(ctr)`, where `g` is the
// init expression with the counter's own start substituted by the counter. It holds at entry
// because `ctr == start` there, and is preserved because the two steps run together at the bottom
// of the body and `g` is linear with exactly the accumulator's stride — `g(x + D) - g(x) = K` is
// checked structurally rather than assumed (`relate` below: a shift by `s` with `K = D · 2^s`, a
// product by `M` with `K = D · M`, or the bare counter with `K = D`). Every way the invariant
// could be broken is a gate that DECLINES: another write to either name, an address taken, a read
// at or below the step, a read outside the loop, a `continue` (which runs a `for`'s increment but
// skips the body's tail), and a step this file cannot relate to the init.
//
// THE SECOND HALF IS RE-EVALUATION, and it is the dangerous one. The closed form is spelled at
// each read, so whatever the init expression READ is read again there. Three gates carry it:
//   • MOVED-EFFECT — a call or a marker would run once per read instead of once. Refused.
//   • MOVED-VOLATILE — a `volatile` access is one the source pinned precisely so it would not be
//     duplicated or moved. Refused. No corpus row reaches it today (nothing on the base spelling
//     this lever rides carries a qualifier on a READ), so it is guarded by its unit test alone.
//   • MOVED-READ-ALIASABLE — an ordinary memory read moved into a loop sees whatever the loop
//     wrote. asmlift can only rule that out for writes it can NAME, so a moved read is admitted on
//     one configuration: every write in the loop goes to a compile-time-constant address INSIDE
//     the target's declared device-register window, and every read the closed form performs is
//     rooted at a constant OUTSIDE it. A device register is not the backing store of any object a
//     C program declares (target.ts `deviceRegisters`), so such a loop cannot change what an
//     ordinary read sees; and the read-side half is what keeps a DEVICE read from being duplicated
//     into N of them. Anything else — a store through a local pointer, a call, a read rooted at no
//     constant at all — REFUSES, which is `ir/alias.ts`'s posture ("unknown BARS") applied where
//     there is no symbol map to resolve a name through.
//
// Nothing qualifying ⇒ decline (null), never a duplicate of the primary.
import {
  type Expr,
  type SFn,
  type Stmt,
  exprEquals,
  exprHasEffect,
  mapExprChildren,
  stmtChildren,
  stmtExprs,
  walkExprs,
} from './ast';
import { type Gate, firstRejection } from './gates';

/** One (loop, accumulator) pair as the gates read it. */
interface AccCtx {
  /** the accumulator is assigned exactly twice: its init above the loop and its step inside */
  assigns: number;
  addrTaken: boolean;
  /** the local carries a qualifier or a frame slot — an asm fact rather than a spelling */
  pinned: boolean;
  /** the accumulator is mentioned outside the loop, other than by its own init */
  liveOutside: boolean;
  /** the accumulator is mentioned at or below its own step, or in the loop's control parts */
  readAtOrBelowStep: boolean;
  /** the counter is assigned exactly twice: its init above the loop and its step inside */
  counterAssigns: number;
  counterAddrTaken: boolean;
  /** a `continue` anywhere in the body */
  hasContinue: boolean;
  /** the init relates to the counter's start by the accumulator's own stride */
  related: boolean;
  /** the closed form contains a call or a marker */
  movedEffect: boolean;
  /** the closed form reads a `volatile` object */
  movedVolatile: boolean;
  /** the closed form reads memory the loop's own writes cannot be told apart from */
  movedAliasable: boolean;
}

export const UNREDUCE_GATES: readonly Gate<AccCtx>[] = [
  {
    id: 'acc-multi-assign',
    why: 'a name written anywhere but its init and its step is not one induction sequence',
    sound: true,
    guardedBy: 'unreduce.test.ts: a third assignment to the accumulator declines',
    rejects: (c) => c.assigns !== 2,
  },
  {
    id: 'acc-addr-taken',
    why: 'a deleted local has no address to take',
    sound: true,
    guardedBy: 'unreduce.test.ts: an address-taken accumulator declines',
    rejects: (c) => c.addrTaken,
  },
  {
    id: 'acc-pinned',
    why: 'a volatile or frame-homed local is an asm fact, not a spelling to undo',
    sound: true,
    guardedBy: 'unreduce.test.ts: a volatile or frame-homed accumulator declines',
    rejects: (c) => c.pinned,
  },
  {
    id: 'acc-live-outside',
    why: 'a read outside the loop wants a value the closed form no longer computes',
    sound: true,
    guardedBy: 'unreduce.test.ts: an accumulator read after the loop declines',
    rejects: (c) => c.liveOutside,
  },
  {
    id: 'acc-read-at-step',
    why: 'below its own step the accumulator is one stride ahead of the counter',
    sound: true,
    guardedBy: 'unreduce.test.ts: a read below the step declines',
    rejects: (c) => c.readAtOrBelowStep,
  },
  {
    id: 'counter-multi-assign',
    why: 'a counter written elsewhere breaks the relation the closed form is read through',
    sound: true,
    guardedBy: 'unreduce.test.ts: a counter assigned inside an arm declines',
    rejects: (c) => c.counterAssigns !== 2,
  },
  {
    id: 'counter-addr-taken',
    why: 'an address-taken counter can be stepped by anything the address reaches',
    sound: true,
    guardedBy: 'unreduce.test.ts: an address-taken counter declines',
    rejects: (c) => c.counterAddrTaken,
  },
  {
    id: 'continue-in-body',
    why: 'a `continue` runs a `for`’s increment but skips the body’s tail, desynchronizing the pair',
    sound: true,
    guardedBy: 'unreduce.test.ts: a `continue` in the body declines',
    rejects: (c) => c.hasContinue,
  },
  {
    id: 'unrelated-step',
    why: 'an init this file cannot relate to the counter’s start by the stride proves nothing',
    sound: true,
    guardedBy: 'unreduce.test.ts: a stride that does not match the init’s scale declines',
    rejects: (c) => !c.related,
  },
  {
    id: 'moved-effect',
    why: 'a call or a marker in the closed form would run once per read instead of once',
    sound: true,
    guardedBy: 'unreduce.test.ts: a call in the init declines',
    rejects: (c) => c.movedEffect,
  },
  {
    id: 'moved-volatile',
    why: 'a volatile access is one the source pinned so it would not be duplicated or moved',
    sound: true,
    guardedBy: 'unreduce.test.ts: a volatile read in the init declines',
    rejects: (c) => c.movedVolatile,
  },
  {
    id: 'moved-read-aliasable',
    why: 'a read moved into a loop sees whatever writes the loop cannot be proved apart from',
    sound: true,
    guardedBy: 'unreduce.test.ts: a moved read declines unless the loop writes only device cells',
    rejects: (c) => c.movedAliasable,
  },
];

// ── the induction shapes ────────────────────────────────────────────────────────────────────

/** `name = name + <expr>` as a step, or null. */
function stepOf(s: Stmt, name: string): Expr | null {
  if (s.k !== 'assign' || s.name !== name || s.value.k !== 'bin' || s.value.op !== '+') {
    return null;
  }
  const { l, r } = s.value;
  return l.k === 'var' && l.name === name ? r : r.k === 'var' && r.name === name ? l : null;
}

/** THE relation check: is `init` a function of `start` whose value grows by `k` per `d` of the
 *  counter? Returns the closed form (init with the counter's start replaced by the counter
 *  variable) or null. The three accepted shapes are the three ways a compiler's own giv is
 *  spelled — a scaled shift, a product, and the bare index — and each is verified rather than
 *  assumed: the substituted subterm must be structurally the counter's start, and the stride must
 *  come out of the scale. */
function relate(init: Expr, start: Expr, ctr: string, k: Expr, d: number): Expr | null {
  const occurrences = [...subterms(init)].filter((x) => exprEquals(x, start)).length;
  if (occurrences !== 1) {
    return null; // zero: the init does not depend on the counter. two: which one is the index?
  }
  const kConst = k.k === 'const' ? k.value : null;
  let matched: Expr | null = null;
  const scaled = (x: Expr): Expr | null => {
    // (a) `start << s` — the stride is `d << s`, so `k` has to be that constant
    if (x.k === 'bin' && x.op === '<<' && exprEquals(x.l, start) && x.r.k === 'const') {
      const s = x.r.value;
      return s >= 0 && s < 31 && kConst === d * 2 ** s
        ? { k: 'bin', op: '<<', l: { k: 'var', name: ctr }, r: x.r }
        : null;
    }
    // (b) `start * M` in either order — the stride is `d · M`, checkable when `d` is 1 and `M`
    //     is structurally `k`, or when both are constants. The OPERAND ORDER is kept: which side
    //     a product's index sits on is a spelling the differ referees on its own (`/mulfirst`),
    //     so rebuilding it in a canonical order would answer that question here instead.
    if (x.k === 'bin' && x.op === '*') {
      const startLeft = exprEquals(x.l, start);
      const m = startLeft ? x.r : x.l;
      if (!startLeft && !exprEquals(x.r, start)) {
        return null;
      }
      const ok = d === 1 ? exprEquals(m, k) : m.k === 'const' && kConst !== null && d * m.value === kConst;
      const idx: Expr = { k: 'var', name: ctr };
      return ok ? { k: 'bin', op: '*', l: startLeft ? idx : m, r: startLeft ? m : idx } : null;
    }
    // (c) the bare counter — the stride is `d` itself
    return exprEquals(x, start) && kConst === d ? { k: 'var', name: ctr } : null;
  };
  const sub = (x: Expr): Expr => {
    const hit = scaled(x);
    if (hit !== null) {
      matched = matched === null ? hit : matched; // one occurrence, so one match
      return hit;
    }
    return mapExprChildren(x, sub);
  };
  const closed = sub(init);
  return matched === null ? null : closed;
}

/** every node of an expression tree, itself included */
function* subterms(e: Expr): Generator<Expr> {
  yield e;
  for (const c of exprChildrenOf(e)) {
    yield* subterms(c);
  }
}

const exprChildrenOf = (e: Expr): Expr[] => {
  const out: Expr[] = [];
  mapExprChildren(e, (c) => {
    out.push(c);
    return c;
  });
  return out;
};

// ── what a tree does to a name ──────────────────────────────────────────────────────────────

/** assignments to `name` anywhere in these statements, `for` init/inc included */
function assignCount(stmts: readonly Stmt[], name: string): number {
  let n = 0;
  for (const s of stmts) {
    if (s.k === 'assign' && s.name === name) {
      n++;
    }
    n += assignCount(stmtChildren(s), name);
  }
  return n;
}

/** does any expression in these statements read `name`? */
function mentions(stmts: readonly Stmt[], name: string): boolean {
  for (const e of walkExprs(stmts as Stmt[])) {
    if (e.k === 'var' && e.name === name) {
      return true;
    }
  }
  return false;
}

const mentionsIn = (e: Expr, name: string): boolean => [...subterms(e)].some((x) => x.k === 'var' && x.name === name);

const addrTakenIn = (stmts: readonly Stmt[], name: string): boolean => {
  for (const e of walkExprs(stmts as Stmt[])) {
    if (e.k === 'addr' && e.name === name) {
      return true;
    }
  }
  return false;
};

const hasContinueIn = (stmts: readonly Stmt[]): boolean =>
  stmts.some((s) => s.k === 'continue' || hasContinueIn(stmtChildren(s)));

// ── the re-evaluation gates ─────────────────────────────────────────────────────────────────

/** the numeric address behind a deref base, through scalar pointer casts only */
const baseConst = (e: Expr): number | null =>
  e.k === 'const'
    ? e.value
    : e.k === 'cast' && !(e.to.kind === 'ptr' && e.to.to.kind === 'struct')
      ? baseConst(e.e)
      : null;

const inWindow = (a: number | null, w?: readonly [number, number]): boolean =>
  w !== undefined && a !== null && a >= w[0] && a < w[1];

/** every memory access in an expression, as its own node */
const accessesIn = (e: Expr): (Extract<Expr, { k: 'index' }> | Extract<Expr, { k: 'field' }>)[] =>
  [...subterms(e)].filter((x): x is Extract<Expr, { k: 'index' | 'field' }> => x.k === 'index' || x.k === 'field');

/** Does the closed form read a `volatile` object? Three spellings assert one: a `volatile` cast
 *  (which is where a raw address carries it), a pointer local declared to point at volatile data,
 *  and a read of a `volatile` local object. */
function readsVolatile(e: Expr, sfn: SFn): boolean {
  const pointee = new Set(sfn.locals.filter((l) => l.pointeeVolatile).map((l) => l.name));
  const object = new Set(sfn.locals.filter((l) => l.volatile).map((l) => l.name));
  return [...subterms(e)].some(
    (x) =>
      (x.k === 'cast' && x.volatile === true) ||
      (x.k === 'var' && object.has(x.name)) ||
      ((x.k === 'index' || x.k === 'field') && namesUnder(x).some((n) => pointee.has(n))),
  );
}

const namesUnder = (e: Expr): string[] =>
  [...subterms(e)].filter((y): y is Extract<Expr, { k: 'var' }> => y.k === 'var').map((y) => y.name);

/** The whole address a memory access denotes, or null when any part of it is not constant — the
 *  same reading l3/volstore.ts takes of a store lvalue. A `field` never resolves: its offset is
 *  the struct's, which this file has no layout for. */
function constAddress(e: Expr): number | null {
  if (e.k !== 'index' || e.lead !== undefined || e.idx.k !== 'const') {
    return null;
  }
  const base = baseConst(e.base);
  return base === null ? null : base + e.idx.value * e.width;
}

/** The constant an ACCESS CHAIN is rooted at, through any pointer cast and any number of
 *  subscripts and field selections — enough to place the object in the address map even when the
 *  element it reaches is not known. Wider than `baseConst` on purpose: a struct-pointer cast is
 *  excluded there because re-spelling THROUGH it would collapse the stride, and nothing here
 *  re-spells. */
const rootConst = (e: Expr): number | null =>
  e.k === 'const'
    ? e.value
    : e.k === 'cast'
      ? rootConst(e.e)
      : e.k === 'index' || e.k === 'field'
        ? rootConst(e.base)
        : null;

/** Can the loop's own writes change what a read in the closed form sees? Only "no" when every
 *  write goes to a constant address inside the declared device window and every read is based
 *  outside it — see the file header. A closed form that reads nothing is never aliasable. */
function movedReadAliasable(closed: Expr, loopBody: readonly Stmt[], window?: readonly [number, number]): boolean {
  const reads = accessesIn(closed);
  if (reads.length === 0) {
    return false; // pure arithmetic re-evaluates to the same value whatever the loop wrote
  }
  for (const s of allStmts(loopBody)) {
    // a call or an unmodelled instruction may write anything
    if (stmtExprs(s).some(exprHasEffect)) {
      return true;
    }
    if (s.k === 'store' && !inWindow(constAddress(s.lval), window)) {
      return true;
    }
  }
  return reads.some((r) => {
    const b = rootConst(r);
    return b === null || inWindow(b, window);
  });
}

function* allStmts(stmts: readonly Stmt[]): Generator<Stmt> {
  for (const s of stmts) {
    yield s;
    yield* allStmts(stmtChildren(s));
  }
}

// ── the pass ────────────────────────────────────────────────────────────────────────────────

/** the loop's counter step statement (a `for`'s `inc`, or the body's last statement) */
const counterStepStmt = (loop: Extract<Stmt, { k: 'while' | 'dowhile' | 'for' }>): Stmt | undefined =>
  loop.k === 'for' ? loop.inc : loop.body[loop.body.length - 1];

/** the statements a loop evaluates outside its body — the parts a substitution must not touch */
const controlStmts = (loop: Extract<Stmt, { k: 'while' | 'dowhile' | 'for' }>): Stmt[] =>
  loop.k === 'for' ? [loop.init, loop.inc] : [];

/** The `/unreduce` candidate, or null when no accumulator qualifies. Read-only: returns a fresh
 *  SFn whose body is rebuilt, leaving the input untouched. `window` is the target's declared
 *  device-register range (TargetDescription.capabilities.deviceRegisters) — absent, the lever
 *  still fires on a closed form that reads no memory. */
export function unreduceAccumulators(sfn: SFn, window?: readonly [number, number]): SFn | null {
  const body = [...sfn.body];
  const deletedInits = new Set<Stmt>();
  const deletedLocals = new Set<string>();
  let changed = false;

  for (let li = 0; li < body.length; li++) {
    const loop = body[li];
    if (loop.k !== 'while' && loop.k !== 'dowhile' && loop.k !== 'for') {
      continue;
    }
    // the counter: one name stepped by a constant, whose start stands above the loop
    const ctrStep = counterStepStmt(loop);
    if (ctrStep === undefined || ctrStep.k !== 'assign') {
      continue;
    }
    const ctr = ctrStep.name;
    const d = stepOf(ctrStep, ctr);
    if (d === null || d.k !== 'const' || d.value === 0) {
      continue;
    }
    const startStmt =
      loop.k === 'for'
        ? loop.init
        : [...sfn.body.slice(0, li)].reverse().find((s) => s.k === 'assign' && s.name === ctr);
    if (startStmt === undefined || startStmt.k !== 'assign' || startStmt.name !== ctr) {
      continue;
    }
    const outside = [...sfn.body.slice(0, li), ...sfn.body.slice(li + 1)];
    const rewrites = new Map<string, Expr>();
    for (const cand of sfn.locals) {
      const initStmt = sfn.body.slice(0, li).find((s) => s.k === 'assign' && s.name === cand.name);
      const stepIdx = loop.body.findIndex((s) => stepOf(s, cand.name) !== null);
      if (initStmt === undefined || initStmt.k !== 'assign' || stepIdx < 0 || cand.name === ctr) {
        continue;
      }
      const k = stepOf(loop.body[stepIdx], cand.name)!;
      const closed = relate(initStmt.value, startStmt.value, ctr, k, d.value);
      const ctx: AccCtx = {
        assigns: assignCount(sfn.body, cand.name),
        addrTaken: addrTakenIn(sfn.body, cand.name),
        pinned: cand.volatile !== undefined || cand.frame !== undefined || cand.uninit !== undefined,
        liveOutside: mentions(
          outside.filter((s) => s !== initStmt),
          cand.name,
        ),
        readAtOrBelowStep:
          mentions(loop.body.slice(stepIdx + 1), cand.name) ||
          mentionsIn(k, cand.name) ||
          mentionsIn(loop.cond, cand.name) ||
          mentions(controlStmts(loop), cand.name),
        counterAssigns: assignCount(sfn.body, ctr),
        counterAddrTaken: addrTakenIn(sfn.body, ctr),
        hasContinue: hasContinueIn(loop.body),
        related: closed !== null,
        movedEffect: closed !== null && exprHasEffect(closed),
        movedVolatile: closed !== null && readsVolatile(closed, sfn),
        movedAliasable: closed !== null && movedReadAliasable(closed, loop.body, window),
      };
      if (firstRejection(UNREDUCE_GATES, ctx) !== null) {
        continue;
      }
      rewrites.set(cand.name, closed!);
      deletedInits.add(initStmt);
      deletedLocals.add(cand.name);
    }
    if (rewrites.size === 0) {
      continue;
    }
    changed = true;
    const sub = (e: Expr): Expr => {
      if (e.k === 'var') {
        const hit = rewrites.get(e.name);
        if (hit !== undefined) {
          return clone(hit); // a FRESH node per use — identity-keyed rules downstream read it
        }
      }
      return mapExprChildren(e, sub);
    };
    const strip = (stmts: readonly Stmt[]): Stmt[] =>
      stmts.filter((s) => !(s.k === 'assign' && rewrites.has(s.name))).map((s) => mapStmts(s, sub, strip));
    body[li] = { ...loop, body: strip(loop.body) } as Stmt;
  }
  if (!changed) {
    return null;
  }
  return {
    ...sfn,
    locals: sfn.locals.filter((l) => !deletedLocals.has(l.name)),
    body: body.filter((s) => !deletedInits.has(s)),
  };
}

const clone = (e: Expr): Expr => mapExprChildren({ ...e }, clone);

/** map a statement's own expressions and its nested lists in one step */
function mapStmts(s: Stmt, f: (e: Expr) => Expr, list: (l: readonly Stmt[]) => Stmt[]): Stmt {
  switch (s.k) {
    case 'assign':
      return { ...s, value: f(s.value) };
    case 'store':
      return { ...s, lval: f(s.lval), value: f(s.value) };
    case 'exprstmt':
      return { ...s, value: f(s.value) };
    case 'return':
      return s.value === undefined ? s : { ...s, value: f(s.value) };
    case 'if':
      return { ...s, cond: f(s.cond), then: list(s.then), else: list(s.else) };
    case 'while':
    case 'dowhile':
      return { ...s, cond: f(s.cond), body: list(s.body) };
    case 'for':
      return {
        ...s,
        cond: f(s.cond),
        init: mapStmts(s.init, f, list),
        inc: mapStmts(s.inc, f, list),
        body: list(s.body),
      };
    case 'switch':
      return {
        ...s,
        scrutinee: f(s.scrutinee),
        cases: s.cases.map((c) => ({ ...c, body: list(c.body) })),
        ...(s.default ? { default: list(s.default) } : {}),
      };
    default:
      return s;
  }
}
