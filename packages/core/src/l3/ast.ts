// asmlift L3 — the language-NEUTRAL structured AST. A LanguageBackend lowers this to a
// concrete language (C / Pascal / C++) and prints it. "Return a value" and binary ops
// are neutral nodes here; each backend owns its own spelling.
import type { IrType } from '../ir/types';

export type Expr =
  | { k: 'var'; name: string }
  | { k: 'const'; value: number }
  | { k: 'bin'; op: BinOp; l: Expr; r: Expr }
  | { k: 'un'; op: '-' | '~' | '!'; e: Expr }
  // A C-style value cast `(T)e`. Tree-level producers: a width-narrowing cast `(u8)e` (the
  // recovered form of a byte/half extend idiom — zext/sext IR ops), the STRUCT-pointer cast
  // (structure.ts memAccess/arrayAccess struct paths — see the note on `field` below), and the
  // integer legalization of a pointer operand under an operator C rejects (structure.ts intify,
  // `3 & (s32)p`). Scalar deref casts are backend-owned — the C-family printer synthesizes
  // them from the `index` node's width. Each backend spells the cast in its own syntax
  // (C: `(u8)e`; Pascal: no spelling yet → fails loud).
  | { k: 'cast'; to: IrType; e: Expr }
  | { k: 'call'; fn: string; args: Expr[] }
  // The ADDRESS of a named global, `&gSym` (agbcc pool `.word gSym`, frontend `gaddr` op). A
  // DEREF of it collapses to the bare global: memAccess/arrayAccess spell `*(&gSym)` as `gSym`
  // and `(&gSym)[i]` as `gSym[i]` (a global name decays to a pointer). Only a genuinely
  // address-TAKEN global (passed by address, `&gSym` as a call arg) prints the `&` form. The
  // global's type comes from the project headers, so it is never declared as a local.
  | { k: 'addr'; name: string }
  // A memory access `base[idx]` (printed `*base` when idx is the constant 0), CARRYING the
  // access's element width (bytes) and signedness. `idx` counts elements of `width` bytes.
  // Because the node carries the width, EACH BACKEND owns its own legalization: the C family
  // checks whether `base`'s rendered C type strides `width` and inserts the reinterpret cast
  // itself when it does not (`*(u8 *)(a0 + a1)`); Pascal loud-declines a base it cannot spell
  // faithfully (see also cpp.ts's sub-word guard and `field`'s name-encoded offset).
  //
  // Still not fully language-neutral — the idx ≠ 0 form is a known C-idiom:
  //   • C backend: `*base` (idx 0) and `base[idx]` (idx ≠ 0) — both valid.
  //   • Pascal backend: `base^` (idx 0) is valid IDO Pascal, but `base[idx]` (idx ≠ 0) is
  //     REJECTED by `upas` — SGI Pascal has no bare-pointer indexing
  //     (packages/cli/test/matching/mips-memory.test.ts).
  // Variable-index `a[i]` is recovered at the IR level (`aload`/`astore` carry elemSize;
  // raise/arrays.ts) but still LOWERS to this one C-shaped `index` node, so it stays C-only
  // (a Pascal array-access spelling is future work). Treat `index` with idx ≠ 0 as C-shaped.
  // `lead` prefixes CONSTANT subscripts before `idx` — `g[0][i]` rather than `g[i]`. It exists for
  // exactly one inhabitant: the bare-name spelling of a MULTIDIMENSIONAL array global, where one
  // subscript reaches a row and the element needs the leading dimensions pinned first. The node
  // still denotes ONE `width`-byte element, so its type, its legalization and its stride contract
  // are unchanged — this is a spelling of the same address, not a new kind of access. Absent for
  // every rank-1 access, which is why it is optional rather than an empty array.
  | { k: 'index'; base: Expr; idx: Expr; width: number; signed: boolean; lead?: number[] }
  // A named struct-field access `base->name` (raise/structs.ts recovered `base` as a struct
  // pointer, so the byte offset resolves to a named field instead of a scaled array index).
  // Unlike `index`, this carries the field NAME (which encodes the byte offset, `field_<off>`),
  // not a width-scaled number — the byte-offset-carrying member access cpp.ts's sub-word guard needs.
  | { k: 'field'; base: Expr; name: string; dot?: true }
  // A GAP MARKER — the annotate-mode (`onGap: "annotate"`) spelling of a value asmlift could not
  // faithfully lift (an unmodelled instruction's `opaque` result, an unlowered transient op, a
  // dropped def). Every backend spells it as a call to the UNDEFINED symbol `ASMLIFT_ERROR("reason",
  // args…)` (the m2c `M2C_ERROR` discipline): the surrounding function is complete and readable, but
  // the source does NOT compile until the user consciously defines the macro — loud in the ARTIFACT
  // instead of loud in the process. `args` carry the source operands for context. Strict mode (the
  // default) never produces this node; it keeps the `"?"` sentinel → ContractError behavior.
  | { k: 'marker'; reason: string; args: Expr[] };

// `>>` is the ARITHMETIC right shift and `>>>` the LOGICAL one. C spells both `>>` and picks from
// the left operand's type, so the C backend synthesizes the cast that pins the choice — exactly as
// it already synthesizes scalar deref casts from an `index` node's width. A backend with no
// spelling for one of them (IDO Pascal) declines LOUDLY on the operation itself, rather than on
// whatever artifact another language's spelling happened to leave in the tree.
//
// WHY THIS ONE SPLIT AND NOT THE OTHERS. "The machine distinguishes them" is NOT the rule — the
// machine distinguishes `divu`/`div` and `sltu`/`slt` too, and ARITH_TO_BIN deliberately collapses
// `udiv`→`/`, `umod`→`%`, `icmp_u*`→`<` etc., noting that "unsignedness is in the operand types".
// Taking the machine as the rule would license four more splits with no inhabitant, which is what
// "earn the level" forbids. The rule is the repo's own: the shift split because a real,
// byte-load-bearing divergence HAD inhabitants (~20 rows, 5 projects, 4 compilers) and no other
// channel could carry it — the operand type could not, since a promoted narrow value is signed
// whatever it was loaded as.
//
// The collapsed operators lean on exactly that channel, so they carry the same latent hazard:
// `*(u16 *)p / 3` renders as a signed division of a promoted `int` where the asm did `divu`. It is
// tolerated because no row has produced such a divergence. When one does, the fix is this same
// split — not a per-site patch.
export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '>>>'
  | '&&'
  | '||';

export type Stmt =
  | { k: 'assign'; name: string; value: Expr }
  // A memory write to an lvalue expression (`index` → `base[idx] = value` / `*base = value`;
  // `field` → `base->name = value`). Carrying the lvalue as an Expr keeps stores symmetric with
  // the load side, so the same leaf-hook / field spelling serves reads and writes alike.
  | { k: 'store'; lval: Expr; value: Expr }
  | { k: 'exprstmt'; value: Expr } // a side-effecting expression (e.g. a void call)
  | { k: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { k: 'while'; cond: Expr; body: Stmt[] }
  // A bottom-tested loop `do { body } while (cond);` — the body runs at least once, then the test at
  // the BOTTOM decides re-entry. This is the shape a compiler emits for a loop whose trip count it can
  // prove ≥1 (guard elided) or a source `do-while`. Distinct from `while` (test-at-top, body may run
  // 0 times) — the two are NOT interchangeable for matching.
  | { k: 'dowhile'; cond: Expr; body: Stmt[] }
  // A counted loop `for (init; cond; inc) { body }` — a PURE RE-SPELLING of a test-at-top `while`
  // (quality only). Produced ONLY by recognizing a `while` whose induction variable's init literally
  // precedes it and whose increment is literally the body's last statement, WITHOUT moving any op:
  // `assign(iv,e0); while(c){ …; assign(iv,e1) }` becomes `for(assign(iv,e0); c; assign(iv,e1)){ … }`.
  // Semantically identical to that desugaring — with ONE exception the recognizer guards against: a
  // `continue` in the body RUNS `inc` under `for` but SKIPS it under `while`, so a body containing a
  // same-level `continue` is NOT converted. `init`/`inc` are Stmts (an `assign`); a backend that
  // cannot spell native `for` may always fall back to the `while` desugaring (Pascal does), so this
  // node never forces a loud-fail.
  | { k: 'for'; init: Stmt; cond: Expr; inc: Stmt; body: Stmt[] }
  // `break;` / `continue;` — a loop early-exit / next-iteration jump. Emitted ONLY when the target is
  // the innermost enclosing loop (bare C break/continue cannot express a multi-level exit; a deeper
  // target declines). SGI/IDO Pascal has neither, so its backend loud-fails them (like `field`/`cast`).
  | { k: 'break' }
  | { k: 'continue' }
  // A multi-way `switch` over an integer scrutinee (recovered from a comparison tree — Regime A — or
  // a jump-table `switch_br` — Regime B). `cases` are emitted IN ARRAY ORDER; `default` (if present)
  // is emitted last.
  //
  // NON-NEUTRALITY NOTE (like the `index` node above): `fallsThrough` encodes a C/C++ control-flow
  // concept POSITIONALLY — `cases[i].fallsThrough === true` means control continues into
  // `cases[i+1].body`, so the array ORDER is semantically load-bearing (a backend that reorders cases
  // would break fall-through). C/C++ spell it natively; Pascal `case-of` has NO fall-through, so the
  // Pascal backend MUST loud-fail a `fallsThrough` case (it has no faithful spelling), exactly as it
  // loud-fails `field`/`cast`. Recovery must therefore only set `fallsThrough` when the fall-through
  // target is the emission-adjacent case.
  | { k: 'switch'; scrutinee: Expr; cases: SwitchCase[]; default?: Stmt[] }
  | { k: 'return'; value?: Expr };

/** One arm of a `switch`. `values` stacks multiple `case K:` labels onto one body (`case 1: case 2:`).
 *  `fallsThrough` true ⇒ the body flows into the NEXT arm (no `break;`); see the non-neutrality note. */
export interface SwitchCase {
  values: number[];
  body: Stmt[];
  fallsThrough: boolean;
}

export interface SFn {
  name: string;
  params: { name: string; type: IrType }[];
  locals: { name: string; type: IrType }[]; // recovered locals, declared at function top
  /** project globals referenced with a known declaration shape (symbol map) — typed for the
   *  legalization env (exprCType) but NEVER declared by a backend: the project's own headers
   *  declare them, exactly like every other global name asmlift emits. */
  globals?: { name: string; type: IrType }[];
  retType: IrType;
  body: Stmt[];
  /** Struct types this function's fields reference, declared above it by the backend. Empty
   *  unless raise/structs.ts recovered a struct. Sorted by name for deterministic output. */
  structs?: StructType[];
}

/** A struct declaration surfaced to the backend (name + field list). Mirrors the IR struct
 *  type but lives in the neutral AST so a backend can print `struct N { ... };`. */
export interface StructType {
  name: string;
  fields: { off: number; type: IrType; name: string }[];
  size?: number;
}

/** A language backend: emits one L3 AST as concrete-language source, plus the language's
 *  comment spelling. */
export interface LanguageBackend {
  readonly id: 'c' | 'cpp' | 'pascal';
  emit(fn: SFn): string;
  // Spell ONE LINE of text as a comment in this language (C block comments, Pascal `(* … *)`).
  // Used by the annotate-mode stub path to carry the failure reason + the original asm
  // alongside the emitted marker, so a human/LLM has the raw material to finish by hand.
  comment(text: string): string;
}

/** The dot-form base of a `field` node — the array-element `index` node under an
 *  `arr[i].field` access — or undefined for the arrow form. THE one copy of the dot-vs-arrow
 *  rule, as a NARROWING accessor (no bare `as` at the consumers): the C-family printer spells
 *  from it and the deref contract (assertDerefsTyped) type-checks against it; a per-consumer
 *  copy would let the two silently disagree on the same AST. */
export function dotBase(f: Extract<Expr, { k: 'field' }>): Extract<Expr, { k: 'index' }> | undefined {
  return f.base.k === 'index' ? f.base : undefined;
}

/** Boolean projection of `dotBase` for conditions that need no narrowing. */
export function fieldSpellsDot(f: Extract<Expr, { k: 'field' }>): boolean {
  // dot also spells a STRUCT-VALUE global's field (`gSym.field`, the symbol-map layout path) —
  // marked explicitly by the structurer via `dot: true` since the base is a `var`, not an index.
  return dotBase(f) !== undefined || f.dot === true;
}

/** Structural equality of two expression trees. THE one copy of Expr deep-equal (like
 *  fieldSpellsDot/derefStrideOk): key-order-independent by construction (a switch, not a
 *  stringify), exhaustive under noImplicitReturns like the walkers below. */
export function exprEquals(a: Expr, b: Expr): boolean {
  if (a.k !== b.k) {
    return false;
  }
  switch (a.k) {
    case 'var':
      return a.name === (b as typeof a).name;
    case 'addr':
      return a.name === (b as typeof a).name;
    case 'const':
      return a.value === (b as typeof a).value;
    case 'bin': {
      const bb = b as typeof a;
      return a.op === bb.op && exprEquals(a.l, bb.l) && exprEquals(a.r, bb.r);
    }
    case 'un': {
      const bb = b as typeof a;
      return a.op === bb.op && exprEquals(a.e, bb.e);
    }
    case 'cast': {
      const bb = b as typeof a;
      return JSON.stringify(a.to) === JSON.stringify(bb.to) && exprEquals(a.e, bb.e);
    }
    case 'call': {
      const bb = b as typeof a;
      return a.fn === bb.fn && a.args.length === bb.args.length && a.args.every((x, i) => exprEquals(x, bb.args[i]));
    }
    case 'index': {
      const bb = b as typeof a;
      // `lead` is part of the ADDRESS (`g[0][i]` and `g[1][i]` are different elements), so it
      // must be compared — an omission here would let CSE/dedup collapse two distinct accesses.
      const lead = a.lead ?? [];
      const bLead = bb.lead ?? [];
      return (
        a.width === bb.width &&
        a.signed === bb.signed &&
        lead.length === bLead.length &&
        lead.every((v, i) => v === bLead[i]) &&
        exprEquals(a.base, bb.base) &&
        exprEquals(a.idx, bb.idx)
      );
    }
    case 'field': {
      const bb = b as typeof a;
      return a.name === bb.name && exprEquals(a.base, bb.base);
    }
    case 'marker': {
      const bb = b as typeof a;
      return (
        a.reason === bb.reason && a.args.length === bb.args.length && a.args.every((x, i) => exprEquals(x, bb.args[i]))
      );
    }
  }
}

// ── the ONE traversal vocabulary ───────────────────────────────────────────────────────────────
// Every generic walker derives from these helpers, so a NEW node kind is a compile error in
// exactly one place per union (the switches are exhaustive under noImplicitReturns) — a
// hand-rolled walker that misses a node kind is a silent bug. Specialized walkers with per-kind
// SEMANTICS (loop-boundary scans like hasEnclosingContinue, rebuilding transforms like
// recognizeForLoops) rightly keep their own switches.

/** The direct sub-expressions of `e`, in syntactic order. */
export function exprChildren(e: Expr): Expr[] {
  switch (e.k) {
    case 'var':
    case 'const':
    case 'addr':
      return [];
    case 'bin':
      return [e.l, e.r];
    case 'un':
    case 'cast':
      return [e.e];
    case 'call':
      return e.args;
    case 'index':
      return [e.base, e.idx];
    case 'field':
      return [e.base];
    case 'marker':
      return e.args;
  }
}

/** Rebuild `e` with each direct sub-expression mapped through `f` (shallow; recurse in `f`). */
export function mapExprChildren(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.k) {
    case 'var':
    case 'const':
    case 'addr':
      return e;
    case 'bin':
      return { ...e, l: f(e.l), r: f(e.r) };
    case 'un':
    case 'cast':
      return { ...e, e: f(e.e) };
    case 'call':
      return { ...e, args: e.args.map(f) };
    case 'index':
      return { ...e, base: f(e.base), idx: f(e.idx) };
    case 'field':
      return { ...e, base: f(e.base) };
    case 'marker':
      return { ...e, args: e.args.map(f) };
  }
}

/** The expressions a statement DIRECTLY contains, in syntactic order. */
export function stmtExprs(s: Stmt): Expr[] {
  switch (s.k) {
    case 'assign':
      return [s.value];
    case 'store':
      return [s.lval, s.value];
    case 'exprstmt':
      return [s.value];
    case 'return':
      return s.value ? [s.value] : [];
    case 'if':
    case 'while':
    case 'dowhile':
      return [s.cond];
    case 'for':
      return [s.cond];
    case 'switch':
      return [s.scrutinee];
    case 'break':
    case 'continue':
      return [];
  }
}

/** The statements a statement DIRECTLY contains. NOTE for document-order walks: a `for`'s
 *  init/inc are listed here while its cond is in stmtExprs — a walker visiting exprs-then-stmts
 *  sees the cond before the init. */
export function stmtChildren(s: Stmt): Stmt[] {
  switch (s.k) {
    case 'assign':
    case 'store':
    case 'exprstmt':
    case 'return':
    case 'break':
    case 'continue':
      return [];
    case 'if':
      return [...s.then, ...s.else];
    case 'while':
    case 'dowhile':
      return s.body;
    case 'for':
      return [s.init, s.inc, ...s.body];
    case 'switch':
      return [...s.cases.flatMap((c) => c.body), ...(s.default ?? [])];
  }
}

// THE negation of a CONDITION — the one implementation, shared by every L3 pass that flips one.
//
// There were two, and they drifted: structure.ts's empty-then peephole learned to distribute over
// the short-circuit connectives while l3/dce.ts's copy kept wrapping in `!`, and because
// `eliminateDeadStores` runs AFTER structuring it re-introduced the very spelling the other one had
// just removed. That is the l3/hoist.ts failure mode verbatim — a copied helper silently losing the
// newer rule — so this lives with the AST vocabulary and the passes call it.
//
// Three rules, in order:
//   1. a relational operator flips directly (`!=` → `==`, `<` → `>=`, …), exact over C's total
//      integer order;
//   2. DE MORGAN — `!(a && b)` becomes `!a || !b`. Sound including EVALUATION ORDER: `a && b` runs
//      `b` only when `a` holds, and `!a || !b` runs `!b` only when `!a` is false, i.e. when `a`
//      holds. Same operands, same inputs — which is what makes it safe over a `b` that loads. It
//      matters because a source `&&` and its dual `||` compile to the SAME branch graph, so the
//      recognizers in raise/shortcircuit.ts can only pick whichever the asm's branch senses spell;
//      distributing is what lets the `/flip-branch` candidate reach the other one;
//   3. `!!x` collapses to `x`, reachable only from a double flip that rule 2 now produces.
//
// CONTEXT REQUIREMENT, and it is the reason this is `negateCond` and not `negate`: rule 3 is valid
// only in a TRUTH-VALUE context, where `x` and `!!x` are interchangeable. `!!5` is 1 and `5` is 5,
// so this must never be used to negate a general integer expression — only an `if`/loop test or an
// operand of one of the connectives above.
//
// SCOPE of rule 2: it only gives the differ a second spelling where a candidate lever already flips
// the condition, and `preserveDivergentBranchSense` covers divergent `if`s ONLY. A connective that
// ended up as a LOOP test therefore has no dual candidate at all — the differ never sees the other
// form, so on such a row this rule changes how the code READS and nothing else. Widening the
// branch-sense lever to loop tests is what would make it a matching lever there, and that is a
// separate change.
const NEGATE_REL: Partial<Record<BinOp, BinOp>> = {
  '<': '>=',
  '>=': '<',
  '>': '<=',
  '<=': '>',
  '==': '!=',
  '!=': '==',
};

export function negateCond(e: Expr): Expr {
  if (e.k === 'bin') {
    const flipped = NEGATE_REL[e.op];
    if (flipped) {
      return { ...e, op: flipped };
    }
    if (e.op === '&&' || e.op === '||') {
      return { ...e, op: e.op === '&&' ? '||' : '&&', l: negateCond(e.l), r: negateCond(e.r) };
    }
  }
  if (e.k === 'un' && e.op === '!') {
    return e.e;
  }
  return { k: 'un', op: '!', e };
}
