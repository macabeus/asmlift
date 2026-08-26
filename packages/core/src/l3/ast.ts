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
  //
  // `volatile` qualifies the POINTEE of a pointer cast (`(volatile u16 *)0x4000208`) — the one
  // place asmlift can say "this access is to a volatile object" when there is no declaration to
  // hang it on, which is exactly the raw-address case (l3/inlinebase.ts). IrType models no
  // cv-qualifier, deliberately: volatility is a SPELLING, carried at the declaration or the
  // cast, the same split SFn.locals makes for `volatile`/`pointeeVolatile`.
  | { k: 'cast'; to: IrType; e: Expr; volatile?: true }
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
  // `operandOff` is the one field here that is EVIDENCE rather than spelling: the constant part
  // of this access's offset arrived in the instruction's MEMORY OPERAND (`ldrb [r0, #0x3]`) and
  // not in the address the pool word materialized (`.word gSym+0x3`). Both denote the same cell
  // and print the same subscript, which is why `exprEquals` ignores it — but on a compiler that
  // folds a constant subscript into the literal, only one C spelling could have put it there, and
  // `l3/basecse.ts` reads it as the evidence its `unfoldedOffset` rule is about. Absent whenever
  // the offset was 0 or came from the address expression, so absence is never proof of anything.
  | { k: 'index'; base: Expr; idx: Expr; width: number; signed: boolean; lead?: number[]; operandOff?: true }
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

// THE SIGNEDNESS-CARRYING PAIRS. `>>` is the ARITHMETIC right shift and `>>>` the LOGICAL one;
// `/`/`%` are the SIGNED quotient and remainder and `/u`/`%u` the unsigned ones. C spells each pair
// with one token and picks between them from the operand types, so the C backend synthesizes the
// cast that pins the choice — exactly as it already synthesizes scalar deref casts from an `index`
// node's width. A backend with no spelling for one of them (IDO Pascal) declines LOUDLY on the
// operation itself, rather than on whatever artifact another language's spelling happened to leave
// in the tree.
//
// WHY THESE SPLITS AND NOT THE OTHERS. "The machine distinguishes them" is NOT the rule — the
// machine distinguishes `sltu`/`slt` too, and CMP_TO_BIN deliberately collapses `icmp_u*`→`<` etc.,
// noting that "unsignedness is in the operand types". Taking the machine as the rule would license
// more splits with no inhabitant, which is what "earn the level" forbids. The rule is the repo's
// own: a split is earned by a real, byte-load-bearing divergence WITH inhabitants that no other
// channel can carry. The shifts earned it first (~20 rows, 5 projects, 4 compilers) because the
// operand type could not carry them — a promoted narrow value is signed whatever it was loaded as.
//
// The divides earned it second, on pokeemerald:GetAnchorCoord — `(u32)(coord * a1) / (u32)a0`
// standing beside two arithmetic shifts of the same values. Their only other channel is the operand
// TYPES, reached by flipping a declaration, and there that flip is unreachable and unsound at
// once: the divisor also feeds a signed compare, so the /uns-cmp reconciliation correctly refuses
// it, and forcing it anyway makes agbcc delete the comparison as always-false. A per-operand pin is
// the only spelling that says "this division alone is unsigned".
//
// The COMPARISONS stay collapsed, and that asymmetry is the rule applying rather than an omission:
// which side a compare was spelled from genuinely underdetermines — a signed spelling that
// byte-matched was proved non-negative by the compiler — so it is refereed as an axis, while a
// division helper is a pure function of the expression's C type with no such proof available.
export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '/u'
  | '%'
  | '%u'
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
  // is emitted after `defaultAt` of them, or after all of them when that is absent.
  //
  // `defaultAt` exists because C lets `default:` sit BETWEEN case labels and a compiler that lays
  // case bodies out in source order shows where the source put it. It is a COUNT of preceding arms,
  // not an index into an array a later pass may rebuild, and a count past the arms is a producer bug
  // a backend refuses. Setting it is legal only when the arm before the label does not fall through:
  // moving the label in front of a falling arm would divert that arm into the default. The C-family
  // printer terminates a non-final default with `break;` for the mirror-image reason.
  //
  // Unlike `fallsThrough` below, `defaultAt` is a SPELLING: every arm it can sit between is closed,
  // so a backend with no positional default (Pascal's `otherwise`) may ignore it and still emit the
  // same program — the one placement that would change one is the falling arm the rule above already
  // refuses, and which that backend loud-fails anyway.
  //
  // NON-NEUTRALITY NOTE (like the `index` node above): `fallsThrough` encodes a C/C++ control-flow
  // concept POSITIONALLY — `cases[i].fallsThrough === true` means control continues into
  // `cases[i+1].body`, so the array ORDER is semantically load-bearing (a backend that reorders cases
  // would break fall-through). C/C++ spell it natively; Pascal `case-of` has NO fall-through, so the
  // Pascal backend MUST loud-fail a `fallsThrough` case (it has no faithful spelling), exactly as it
  // loud-fails `field`/`cast`. Recovery must therefore only set `fallsThrough` when the fall-through
  // target is the emission-adjacent case.
  | { k: 'switch'; scrutinee: Expr; cases: SwitchCase[]; default?: Stmt[]; defaultAt?: number }
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
  /** Recovered locals, declared at function top. Two INDEPENDENT volatility facts, mirroring
   *  symbols.ts's cell-vs-pointee split: `volatile` = the local OBJECT is volatile (the
   *  address-escaped frame scratch; dce.ts treats reads of it as observable), `pointeeVolatile`
   *  = the local is a pointer TO volatile data (the l3/volatileptr.ts lever; a declaration
   *  spelling only — nothing about the local itself is observable).
   *
   *  `frame` is present on a local the structurer recovered from an `laddr` — the asm
   *  MATERIALIZED the slot's address into a register, so the object provably lives in memory —
   *  and carries the machine's static access counts for it. Under Thumb that envelope is a
   *  SUB-WORD frame object: `strh/ldrh/strb/ldrb` have no `[sp,#imm]` form, so a compiler must
   *  copy `sp` first, while a word spill goes straight to `[sp,#imm]` and is recovered as an
   *  SSA value with no local of its own. So `frame` is NOT the set of every value the machine
   *  slotted. `loads`/`stores` are the yardstick a qualifier lever must match before it may
   *  declare every access to the object observable: the readability passes between here and L3
   *  may drop a store or render one machine load as two reads, and `volatile` over an access
   *  set asmlift did not preserve is a source that contradicts itself. ABSENT where the counts
   *  would be a floor rather than the set: an address reaching anything but a direct load/store
   *  leaves accesses the count cannot see. */
  locals: {
    name: string;
    type: IrType;
    volatile?: true;
    pointeeVolatile?: true;
    frame?: { loads: number; stores: number };
    /** the local stands on an `undef` — storage the asm reads without ever writing it, where the
     *  MISSING assignment is the recovery. Marked because a local read and never assigned is
     *  otherwise a dropped statement (contracts.ts assertLocalsWritten). */
    uninit?: true;
  }[];
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
      // `volatile` is part of the SPELLING, compared for the same reason `lead` and `dot` are: a
      // CSE or dedup that treats these as equal keeps one node and drops the other, silently
      // respelling a volatile access as a plain one.
      return (
        JSON.stringify(a.to) === JSON.stringify(bb.to) &&
        (a.volatile ?? false) === (bb.volatile ?? false) &&
        exprEquals(a.e, bb.e)
      );
    }
    case 'call': {
      const bb = b as typeof a;
      return a.fn === bb.fn && a.args.length === bb.args.length && a.args.every((x, i) => exprEquals(x, bb.args[i]));
    }
    case 'index': {
      const bb = b as typeof a;
      // `lead` is part of the ADDRESS (`g[0][i]` and `g[1][i]` are different elements), so it
      // must be compared — an omission here would let CSE/dedup collapse two distinct accesses.
      // `operandOff` deliberately is NOT: two accesses agreeing on everything else denote the same
      // cell and print the same subscript however the machine spelled the offset, so a CSE that
      // collapses them respells nothing.
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
      // `dot` is part of the SPELLING, and for the same reason `lead` is compared above: a CSE or
      // dedup that treats these as equal keeps one node and discards the other, silently respelling
      // `p->field_4` as `p.field_4` (or the reverse). Both compile only for the base type each
      // belongs to, so collapsing them is how a valid access becomes an invalid one — or worse, a
      // valid one against a different object.
      return a.name === bb.name && (a.dot ?? false) === (bb.dot ?? false) && exprEquals(a.base, bb.base);
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
/** THE spelling of an unmodelled instruction's gap reason, in one place: `structure.ts` writes it
 *  into the marker, `contracts.ts` matches on it to prove the gap was not dropped, and the benchmark
 *  classifies declines by it. Two spellings make that contract silently vacuous — enforced-looking
 *  and never firing. `?` when a frontend stamps no mnemonic. */
export function gapReasonFor(mnemonic: unknown): string {
  return `unmodelled instruction '${typeof mnemonic === 'string' ? mnemonic : '?'}'`;
}

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

/** Rebuild `s` with EVERY expression position mapped through `f` — store lvalues and loop/switch
 *  heads included, nested statements recursively. The rewrite dual of stmtExprs/stmtChildren for
 *  the PURE 1:1 case (basecse, mulfirst). The other levers' hand-rolled mappers have DIFFERENT
 *  contracts, not missed migrations: reindex's is fallible (Stmt|null declines), scopebase's
 *  recurses through its hoist-INSERTING list rewriter, regspell rewrites assign TARGETS, argbase
 *  produces statement lists. */
export function mapStmtExprs(s: Stmt, f: (e: Expr) => Expr): Stmt {
  const mapS = (x: Stmt): Stmt => mapStmtExprs(x, f);
  switch (s.k) {
    case 'assign':
      return { ...s, value: f(s.value) };
    case 'store':
      return { ...s, lval: f(s.lval), value: f(s.value) };
    case 'exprstmt':
      return { ...s, value: f(s.value) };
    case 'return':
      return s.value ? { ...s, value: f(s.value) } : s;
    case 'if':
      return { ...s, cond: f(s.cond), then: s.then.map(mapS), else: s.else.map(mapS) };
    case 'while':
    case 'dowhile':
      return { ...s, cond: f(s.cond), body: s.body.map(mapS) };
    case 'for':
      return { ...s, init: mapS(s.init), cond: f(s.cond), inc: mapS(s.inc), body: s.body.map(mapS) };
    case 'switch':
      return {
        ...s,
        scrutinee: f(s.scrutinee),
        cases: s.cases.map((c) => ({ ...c, body: c.body.map(mapS) })),
        default: s.default?.map(mapS),
      };
    case 'break':
    case 'continue':
      return s;
  }
}

/** An address the target can REMATERIALIZE: a constant expression, reading no variable and no
 *  memory. Which ENCODING the compiler picked for it is not a property of the source — agbcc
 *  spells a pool word `(s32 *)33569456` but a shift-encodable one `(s32 *)(128 << 18)`, and every
 *  GBA hardware region (EWRAM 0x2000000, I/O 0x4000000, VRAM 0x6000000 …) takes the second form —
 *  so both must reach the same admission or the whole MMIO/VRAM fill family declines on its
 *  address. A bare `(T *)0` is excluded — a null base is not a walk — but the test is on the
 *  LITERALS the expression mentions, not on the value they fold to, so `(T *)(5 - 5)` passes.
 *  Folding would need a constant evaluator no consumer has another use for, and both consumers
 *  keep the expression verbatim, so no decision downstream reads the value.
 *
 *  Two ask it: the walk re-index (l3/reindex.ts) about a walk base, and the `volatile` qualifier
 *  (l3/volatileptr.ts) about what feeds a pointer local. They must agree — a MMIO fill whose base
 *  one admits and the other refuses can be re-indexed but never qualified, so the paired
 *  `/indexed/volatile` spelling is unreachable at exactly the hardware addresses it is for.
 *
 *  Two levers reading the same initializers are deliberately NOT here: l3/inlinebase.ts
 *  substitutes the address at each use, l3/nearbase.ts clusters neighbours by distance, and both
 *  need the VALUE, which is the evaluator above. Declining a shift-encoded base there costs a
 *  lever that does not fire, and the population is small: over klonoa's 531 lifting functions,
 *  one inlinebase-shaped local with no symbol map and none with it; a folded nearbase would form
 *  a new cluster in 4 functions mapless and 1 with the map. Zero of either on the 324 agbcc
 *  benchmark rows that lift. */
export function rematerializableAddress(e: Expr): boolean {
  let nonZero = false;
  let ok = true;
  const visit = (x: Expr): void => {
    switch (x.k) {
      case 'const':
        nonZero ||= x.value !== 0;
        break;
      case 'cast':
      case 'bin':
      case 'un':
        break;
      default:
        ok = false; // var, addr, index, field, call, marker
        return;
    }
    mapExprChildren(x, (c) => {
      visit(c);
      return c;
    });
  };
  visit(e);
  return ok && nonZero;
}

/** Whether the tree contains a node with an EFFECT no re-ordering may move: a call, or a marker
 *  standing in for an unmodelled instruction (annotate mode). */
export function exprHasEffect(e: Expr): boolean {
  return e.k === 'call' || e.k === 'marker' || exprChildren(e).some(exprHasEffect);
}

/** The statements a statement DIRECTLY contains, in the order a backend prints them — a `switch`
 *  splices its default in at `defaultAt` for that reason. NOTE for document-order walks: a `for`'s
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
    case 'switch': {
      const arms = s.cases.map((c) => c.body);
      arms.splice(s.defaultAt ?? s.cases.length, 0, s.default ?? []);
      return arms.flat();
    }
  }
}

/** Every expression node in a body, statements nested and children included — the whole-tree walk
 *  the three functions above compose into, kept here so a new node kind is a compile error in one
 *  of them rather than a silent miss in each caller's own recursion.
 *
 *  An EXPLICIT stack, not `yield*` recursion. A delegated generator costs a frame per nesting
 *  level on every value it forwards, so an expression ten levels down was handed off ten times; this
 *  walk runs over a whole function body once per emitted candidate. The stack
 *  holds either a statement list still to expand or an expression still to visit — `Expr` is
 *  never an array, so the two are told apart without a tag — and both are pushed in reverse so
 *  they pop in document order, which is the order the recursion produced. */
export function* walkExprs(body: Stmt[]): Generator<Expr> {
  const stack: (Expr | Stmt[])[] = [body];
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (Array.isArray(top)) {
      for (let i = top.length - 1; i >= 0; i--) {
        const s = top[i];
        const children = stmtChildren(s);
        if (children.length > 0) {
          stack.push(children);
        }
        const exprs = stmtExprs(s);
        for (let j = exprs.length - 1; j >= 0; j--) {
          stack.push(exprs[j]);
        }
      }
      continue;
    }
    yield top;
    const children = exprChildren(top);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
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
//      distributing is what lets the other one be spelled at all;
//   3. `!!x` collapses to `x`, reachable only from a double flip that rule 2 now produces.
//
// CONTEXT REQUIREMENT, and it is the reason this is `negateCond` and not `negate`: rule 3 is valid
// only in a TRUTH-VALUE context, where `x` and `!!x` are interchangeable. `!!5` is 1 and `5` is 5,
// so this must never be used to negate a general integer expression — only an `if`/loop test or an
// operand of one of the connectives above.
//
// SCOPE of rule 2: it fires wherever a branch-sense lever negates the condition, which is both `if`
// classes — `preserveDivergentBranchSense` on divergent ifs, `negateJoinedBranchSense` on
// reconverging ones — and on the joined class it is a DEFAULT emission, not a differ-only
// alternative, so a source `&&` can come out as its `||` dual with no lever asked for
// (`synthetic:ifand_far`, where the branch range put the fold on the other arm). Neither
// lever reaches a LOOP test, so a connective that ended up as one has no dual candidate at all —
// the differ never sees the other form, and on such a row this rule changes how the code READS and
// nothing else. Widening a branch-sense lever to loop tests is what would make it a matching lever
// there, and that is a separate change.
export const NEGATE_REL: Partial<Record<BinOp, BinOp>> = {
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
