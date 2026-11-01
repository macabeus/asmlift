// asmlift — L2→L3 structuring: CFG + block-argument SSA → a structured AST.
//
// Three jobs:
//  1. SSA destruction WITH COALESCING — a merge block-argument that already carries a
//     variable's value on one path is coalesced to that variable, so only the
//     non-identity paths emit an assignment (reproducing agbcc's register allocation:
//     the clamp0 diamond becomes `if (x < 0) x = 0; return x;` rather than a temp copy).
//     NOTE the coupled INVERSE: l3/regspell.ts re-derives the UN-coalesced copy-carrying
//     spelling as a ranked candidate — its R1 template matches THIS pass's diamond output
//     shape, so a change to coalescing here can silently stop that respell variation firing (the
//     matching-suite regspell gate is what makes the coupling loud).
//     Coalescing is INTERFERENCE-CHECKED against per-block value liveness, and
//     inline-at-use rendering carries an effect-ordering model: a call/load that cannot
//     soundly render at its use is MATERIALIZED as a named temp at its own program
//     position. Where no correct spelling exists, the structurer declines loud
//     (StructureError) — never silent wrong code.
//  2. If-recovery over the CFG using immediate post-dominators as merge points, with an
//     empty-then peephole (negate + swap).
//  3. Loop-recovery: a back-edge (edge into a dominating header) is recognised, and the
//     gcc "guard + do-while" lowering is un-rotated back into a `while` — the loop
//     condition is the latch test read on the header's OWN parameters (back-edge args
//     substituted back to the phi they feed), and the loop body is the header's
//     parallel block-argument update, sequentialised so an assignment never clobbers a
//     value a later one still needs.
//
// Module layout: loop DISCOVERY is ../ir/loops.ts (raise/ reads it too); the pure ANALYSIS phase
// (use registry, liveness, materialization) is analysis.ts; comparison-tree switch recovery is switch-recover.ts
// (explicit-deps factory). THIS file keeps the mutually-entangled remainder: SSA-destruction
// coalescing (canTakeName + seeding) and emission (structureBlock + the loop emitters) — they
// share varName/backArgName mutation and the activeSub/loopCtx dynamic state.
//
// Scope: reducible natural loops — GUARDED self-loop `while` (the guard-fusion un-rotation),
// UNGUARDED self-loop `do-while` (single block, header === latch), test-at-top `while`,
// bottom-test `do-while`, `while (1)` for any other latch set (a conditional `continue`, a
// mid-tested header), PROPERLY-nested loops, in-body `break`/early-`return`, comparison-tree and
// jump-table `switch`, and a switch arm that FALLS THROUGH into the next one (both regimes — see
// `ArmExit` in switch-recover.ts), on some paths only, leaving the switch by a `break;` on the
// others (`switchFrames`), and a `while (1)` whose second exit target lies past the code after it
// (`goto` past that code; `TwoLevelExit`, spelled with a flag). Still DECLINED (loud
// StructureError, never wrong code): irreducible/overlapping loops, exits to more than one live
// merge that no flag spells (among them a third target, a second one at the enclosing loop's header
// or past it short of its exit, and one whose code never joins the code after the first exit: `goto
// hit; } k(i); goto next; hit: y(i); next:`), a `break` out of a nested loop's body other than a
// flag handed out one loop at a time (`TwoLevelExit.outward`), a `break` whose exit copies would
// clobber, and mixed-entry self-loops (a guarded header also entered by a plain br).
// Fall-through carries two REFUSALS of its own rather than a decline: a target language whose
// `case` cannot fall through (`spellSwitchFallthrough` false) sends Regime A back to if-recovery,
// and arms that do not linearize into one chain — two arms falling into the same sibling, or a fall
// into the `default:` — refuse in `chainArms`, which answers null. In a jump table (Regime B), two
// or more arms entering a sibling that itself ends the switch are the one exception: a cross-jump
// makes that shape out of arms with a common tail, and `copySharedFallTargets` writes the tail back
// into all of them but one, or into all of them under the `/tail-copies` variation. Regime A keeps
// the refusal, since its if-recovery already lifts.
import { globalBaseOf } from '../ir/alias';
import { type WordCtx, demandedBits, incomingArgs, mayAlwaysHold, overwrittenReads, storeForwards } from '../ir/bits';
import {
  Block,
  CALL_RETURN_OBJECT,
  Fn,
  OWN_RETURN_OBJECT,
  Op,
  RETURNS_OBJECT,
  Successor,
  Value,
  byValueOperands,
  callArgs,
  calleeName,
  calleeValue,
  defOpMap,
  dominators,
  mergeClasses,
  reachForward,
  successorsOf,
} from '../ir/core';
import { effectful, orderSensitive, placedAt, qualified, qualifiedBy, spelledWhenDead } from '../ir/discipline';
import { type NaturalLoop, analyzeLoops } from '../ir/loops';
import { CAST_WIDTHS, FLOAT_RESIZE, FLOAT_TO_INT, INT_TO_FLOAT, NEGATED_FCMP, WIDE_BITS, opSig } from '../ir/opcodes';
import {
  type IrType,
  type StructField,
  T,
  UNION_VIEW_NAMES,
  intWidth,
  isCastView,
  scalarTypeForAccess,
  spellsAccessType,
  structSpelling,
  typeEquals,
  unionView,
  unionViewAt,
} from '../ir/types';
import {
  BinOp,
  Expr,
  SFn,
  Stmt,
  SwitchCase,
  exprChildren,
  exprHasEffect,
  gapReasonFor,
  isLoop,
  keepsHelperRel,
  mapExprChildren,
  mapStmtExprs,
  mentionedName,
  negateCond,
  reachesEnd,
  regainsHelperRel,
  splitHelperBreak,
  stmtChildren,
  stmtExprs,
  stmtsEqual,
  unionStmtsEvidence,
  walkExprs,
} from '../l3/ast';
import { constantImageRefusal } from '../l3/constinit';
import { type Gate, firstRejection } from '../l3/gates';
import {
  exprCType,
  exprIntWidth,
  renderedIntSignedness,
  rendersSignedOverUnsigned,
  spelledNonNegative,
} from '../l3/typing';
import { castOffDeclaration, qualifiedMemoryAccess } from '../l3/volstore';
import type { ContextGlobals, DeclaredStorage } from '../proto-context';
import { evalIntPair, foldConstPair, isConstFoldOpcode, isIntPairOpcode } from '../raise/const';
import { stampDeclaredVolatile } from '../raise/declared-volatile';
import { returnType } from '../raise/recover';
import { storeSigned } from '../raise/storesign';
import { collectStructs } from '../raise/structs';
import {
  type DeclaredField,
  type SymbolInfo,
  declaredArrayShape,
  isArrayField,
  isBitfieldField,
  pointeeFields,
  structFieldInnerExtents,
} from '../symbols';
import { type UseSite, analyze, shortCircuitGuardedValues } from './analysis';
import { ARITH_TO_BIN } from './arith-ops';
import { makeBitfieldSpelling } from './bitfields';
import {
  addOffset,
  addrIn,
  bareArrayLead,
  declaredSubscripts,
  elementIndex,
  globalByteBase,
  globalOf,
  memberQualsAllow,
  memoFieldsOf,
  nestedGlobalOf,
  ptrMemberDecl,
  structMemberAt,
  subscriptsFromExtents,
} from './globalaccess';
import {
  PREUPDATE_SINK_GATES,
  type SinkCandidate,
  makeLoopHazards,
  preUpdateCopyHome,
  sunkCopyOverDroppedUndef,
  updateWriteSet,
} from './hazards';
import { type StaticLayout, localStaticShapes, nameLocalStatics } from './local-statics';
import { type NameMerge, coalesceNames } from './namecoalesce';
import { type ArithCompilerFacts, declaresBytePointer, makePointerSpelling } from './pointer-spelling';
import { testRereadsOnly } from './redundant-test';
import { unspelledEpilogues } from './retspell';
import {
  type ArmExit,
  type SwitchBoundCase,
  copySharedFallTargets,
  jumpSharedFallTargets,
  makeSwitchRecovery,
} from './switch-recover';

// Lower a constant-offset memory access to its lvalue/rvalue Expr. If the base was recovered as a
// struct pointer (raise/structs.ts), the byte offset resolves to a NAMED field (`base->field_<off>`);
// otherwise it stays the width-scaled array index (`base[off/width]`, `*base` for offset 0).
//
// The scalar path builds a WIDTH-CARRYING `index` node and inserts NO cast: each backend
// legalizes the base itself from the node's width (the C family inserts the reinterpret cast at
// print time when the base's rendered type does not stride the width — derefStrideOk, l3/typing —
// and Pascal loud-declines instead). The struct path still bakes its cast into the tree: the
// legalization target is the RECOVERED struct pointer type, which the `field` node does not carry
// TODAY — carrying the struct name (resolved against SFn.structs) is the same move as width and
// the named follow-up; until then no backend pays a tax for the tree cast (Pascal loud-fails
// `field` regardless, C++ falls through its leaf hook to the shared C spelling).

/** "What does this project know about the global named `n`" — the union of the project's own
 *  symbol map and the array shapes derived from this function's assembly, asked map-first. Only
 *  ever probed by name (never iterated or copied), which is what lets the union be a lookup rather
 *  than a merged Map. */
interface SymbolLookup {
  get(name: string): SymbolInfo | undefined;
  has(name: string): boolean;
}

/** The symbol-map rendering context threaded into memAccess/arrayAccess: shape facts per
 *  global name, plus a callback registering a global's env type (so the bare `gSym[i]` spelling,
 *  which must pass the stride check uncast, does). Absent ⇒ today's spellings. */
interface SymRenderCtx {
  info(name: string): SymbolInfo | undefined;
  noteGlobal(name: string, type: IrType): void;
  /** may {@link ptrMemberElement} spell a whole-element subscript through a pointer member — the
   *  `/no-ptr-elem` arm's OFF switch, off the `spellPtrMemberElements` structure option. */
  ptrElements: boolean;
  /** may {@link declaredSubscripts} recover a multidimensional global's declared subscripts out of
   *  the byte residual — the `/flat-rank` arm's OFF switch, off the `spellDeclaredSubscripts`
   *  structure option. */
  declRank: boolean;
  /** {@link memoFieldsOf} over `info`. */
  fieldsOf(name: string): DeclaredField[] | null;
}

// ── interior spelling through a POINTER-shaped global ────────────────────────────────────────
// A pointer global's VALUE is the address of the object the project's header says it points at.
// With that pointee's layout in the map, an access at a known offset is a NAMED member of it —
// `gPtr->member` — which is the source spelling; without it the access is byte arithmetic on the
// loaded cell (`((u8 *)gPtr + i)[16]`), honest but opaque. The address computed is IDENTICAL
// either way: `->member` adds the member's DWARF offset, which is the same constant the arithmetic
// added, and an index into an array member scales by the member's own element size, which the
// rules below require to equal the access width. Everything not provably that — a partial overlap,
// a width mismatch, an unnamed offset, a member whose declared signedness differs from the
// access's (an s8 read is ldrb+lsl+asr where u8 is ldrb alone), a missing layout — falls THROUGH
// to the cast forms. A member is never guessed.

/** The global named by a pointer global's VALUE as the additive lowering spells it: the bare
 *  `gPtr`, or that value wearing the byte-pointer / u32 cast that lowering adds (cast-then-add,
 *  see the `needsIntSpelling` / pointer-global arithmetic rules in pointer-spelling.ts). Both
 *  denote the same address and add BYTES to it, so both fold here; a cast to any other pointer
 *  type is NOT looked through — a `(u16 *)` base would re-scale everything added after it. */
function ptrGlobalValueName(x: Expr): string | null {
  if (x.k === 'var') {
    return x.name;
  }
  if (x.k === 'cast' && x.e.k === 'var') {
    const t = x.to;
    const bytePtr = t.kind === 'ptr' && t.to.kind === 'int' && t.to.width === 8;
    return bytePtr || (t.kind === 'int' && t.width === 32) ? x.e.name : null;
  }
  return null;
}

/** A pointer global's value, the constant bytes added to it, and the variable byte residual. */
interface PtrGlobalBase {
  name: string;
  byte: number;
  idx: Expr | null;
}

/** Decompose an access base into "the VALUE of a map-declared POINTER global + a constant byte
 *  offset + the variable residual": `gPtr`, `gPtr + K`, `(u8 *)gPtr + i`, `(u8 *)gPtr + (i << 2)
 *  + K`, `(u8 *)gPtr + K + j + (i << 3)`. Null for anything else — no such global, a non-`+`
 *  operator.
 *
 *  SEVERAL variable terms re-associate into ONE residual rather than refusing the decomposition,
 *  because a rank-2 member's index is two of them (`->x[i][j]` computes `j + i*8`) and the caller
 *  that splits them back apart ({@link pointeeElement}) needs to see both. The `+` tree's own
 *  LEFT-TO-RIGHT visit order is preserved and never sorted: `j + (i * 8)` and `(i * 8) + j` are
 *  different agbcc objects, so the order is part of the answer.
 *
 *  Every consumer still decides for itself what a residual it cannot explain means: the
 *  constant-offset member spelling ({@link pointeeAccess}) refuses any residual at all. */
function ptrGlobalBase(e: Expr, isPtrGlobal: (n: string) => boolean): PtrGlobalBase | null {
  let name: string | null = null;
  let byte = 0;
  const terms: Expr[] = [];
  const visit = (x: Expr): void => {
    if (x.k === 'bin' && x.op === '+') {
      visit(x.l);
      visit(x.r);
      return;
    }
    const global = ptrGlobalValueName(x);
    if (global !== null && name === null && isPtrGlobal(global)) {
      name = global;
      return;
    }
    if (x.k === 'const') {
      byte += x.value;
      return;
    }
    terms.push(x);
  };
  visit(e);
  const idx = terms.length === 0 ? null : terms.reduce((l, r): Expr => ({ k: 'bin', op: '+', l, r }));
  return name !== null ? { name, byte, idx } : null;
}

/** The declared type of a frame-local object, from the three facts its `laddr` carries: `count`
 *  elements of `width` bytes, signed or not. ONE element is a SCALAR typed by the access every
 *  access agreed on. More is STORAGE the frontend's frame-object audit sized without typing —
 *  no access pins an element type there, so the audit stamps bytes and this declares the array
 *  that spells them — except a proven PART, whose own accesses may pin its element (`elem`, below).
 *  Every arm is the audit's own facts; none infers anything here.
 *
 *  …and storage the audit found accessed at two widths over one byte carries the VIEWS those
 *  accesses use (`views`, frame-objects.ts `unionViews`), and is declared the union of them —
 *  each view an array tiling the whole storage, `union { s32 word[3]; u16 half[6]; u8 byte[12]; }`
 *  — because a union member access is the one spelling of two widths agbcc never reads stale. */
function laddrType(op: Op): IrType {
  // a call's struct-return storage: the audit typed its address as a pointer to that struct
  const t = op.results[0].type;
  if (op.attrs.aggregate === true && t.kind === 'ptr') {
    return t.to;
  }
  const views = op.attrs.views as number[] | undefined;
  if (views !== undefined) {
    const count = op.attrs.count as number;
    const widths = views.map(Math.abs);
    const members = views.map((v): StructField => {
      const w = Math.abs(v);
      const elem = scalarTypeForAccess(w, v < 0);
      const name =
        widths.filter((x) => x === w).length > 1 ? `${v < 0 ? 's' : 'u'}${UNION_VIEW_NAMES[w]}` : UNION_VIEW_NAMES[w];
      return { off: 0, type: count === w ? elem : T.array(elem, count / w), name };
    });
    return { kind: 'union', members, size: count };
  }
  // …and a proven PART is declared with the element its accesses agree on, where they do
  // (frame-objects.ts `stampPartElements`): `elem` bytes, negative for a signed narrow one
  const partElem = op.attrs.elem as number | undefined;
  if (partElem !== undefined) {
    const w = Math.abs(partElem);
    return T.array(scalarTypeForAccess(w, partElem < 0), (op.attrs.count as number) / w);
  }
  const elem = T.int((op.attrs.width as number) * 8, op.attrs.signed as boolean);
  const count = op.attrs.count as number;
  return count === 1 ? elem : T.array(elem, count);
}

/** A map-declared POINTER MEMBER as the additive lowering renders its VALUE: the bare `gSym.pBuf`,
 *  or that member wearing the byte-pointer / u32 cast the arithmetic guard adds. Both denote the
 *  same address and add BYTES to it, so both fold here; a cast to any OTHER pointer type is not
 *  looked through — it would re-scale everything added after it. */
function ptrMemberValue(x: Expr, sym: SymRenderCtx): { expr: Expr; field: DeclaredField } | null {
  let bare = x;
  if (x.k === 'cast') {
    const t = x.to;
    const isBytePtr = t.kind === 'ptr' && t.to.kind === 'int' && t.to.width === 8;
    if (!isBytePtr && !(t.kind === 'int' && t.width === 32)) {
      return null;
    }
    bare = x.e;
  }
  const f = ptrMemberDecl(bare, sym);
  return f !== null ? { expr: bare, field: f } : null;
}

/** Decompose an access base into "the VALUE of a map-declared POINTER MEMBER + a constant byte
 *  offset + at most ONE variable term" — the same decomposition {@link ptrGlobalBase} makes one
 *  indirection up, declining on the same conditions (two variable terms, no such member, a
 *  non-`+` operator), because only a single residual can be read as one element index. */
interface PtrMemberBase {
  value: Expr;
  field: DeclaredField;
  byte: number;
  idx: Expr | null;
}
function ptrMemberBase(e: Expr, sym: SymRenderCtx): PtrMemberBase | null {
  const hits: { expr: Expr; field: DeclaredField }[] = [];
  let byte = 0;
  let idx: Expr | null = null;
  let ok = true;
  const visit = (x: Expr): void => {
    if (!ok) {
      return;
    }
    if (x.k === 'bin' && x.op === '+') {
      visit(x.l);
      visit(x.r);
      return;
    }
    const m = hits.length === 0 ? ptrMemberValue(x, sym) : null;
    if (m !== null) {
      hits.push(m);
      return;
    }
    if (x.k === 'const') {
      byte += x.value;
      return;
    }
    if (idx !== null) {
      ok = false;
      return;
    }
    idx = x;
  };
  visit(e);
  return ok && hits.length === 1 ? { value: hits[0].expr, field: hits[0].field, byte, idx } : null;
}

/** `gSym.pBuf[i]` for an access through a POINTER MEMBER's VALUE — the spelling the project's own
 *  header makes available, where the byte arithmetic it replaces is the same address written the
 *  machine's way. The DECLARATION is what licenses it: `pointeeSize` says how wide an element is,
 *  so an access of exactly that width at a whole multiple of it IS the i-th element, and the
 *  reinterpret cast the backend adds strides by the same amount under any header.
 *
 *  `carried` is an ELEMENT index the access already holds (an `aload`'s own index); everything
 *  else — a byte residual inside the base, the instruction's displacement `off` — is converted and
 *  summed into the one subscript, which is where the source put it.
 *
 *  REFUSALS, and they are of TWO kinds.
 *
 *  ADDRESS refusals — no whole-element spelling expresses the address at all: a variable residual
 *  that is not element-scaled, and a constant the element width does not divide. Both address
 *  MID-ELEMENT, so they fall through to the honest byte forms and must.
 *
 *  REACH refusals — the address IS expressible and this rule declines anyway: an access of a
 *  DIFFERENT width than the declared element, and a sub-word access whose signedness the declared
 *  pointee does not carry. Neither is soundness. `exprCType` types a `field` node `undefined` (it
 *  types params and locals), so `derefStrideOk` is false for every base this rule produces and the
 *  backend ALWAYS emits the reinterpret cast — `((u16 *)gB.pMap)[i + 157]`, cast included, is what
 *  the accepted case spells. `((s32 *)gB.pMap)[i + K]` would be the same address and the same fill
 *  as the byte form those two clauses fall back to, and the byte form the width clause produces
 *  already spells `((s32 *)…)[157]` itself. What these two clauses encode is a REACH judgement — the
 *  map says this pointer addresses an array of THESE, so the source probably wrote a subscript of
 *  them — and a declaration-shaped access is where that judgement is most likely right. On a
 *  STORE the signedness clause has no premise at all (a store extends nothing), so it withholds
 *  the spelling from every `s8 *` / `s16 *` member store; that is left in place deliberately
 *  rather than widened, because this rule is not byte-neutral (see `spellPtrMemberElements`) and
 *  widening a non-neutral spelling's reach is a separate question a row has to ask.
 *
 *  And the whole rule refuses when `/no-ptr-elem` turns it off — the variation, not a preference. */
function ptrMemberElement(
  baseExpr: Expr,
  carried: Expr | null,
  off: number,
  width: number,
  signed: boolean,
  sym: SymRenderCtx,
): Extract<Expr, { k: 'index' }> | null {
  if (!sym.ptrElements) {
    return null;
  }
  const pm = ptrMemberBase(baseExpr, sym);
  if (!pm || pm.field.pointeeSize !== width || (width < 4 && (pm.field.pointeeSigned ?? false) !== signed)) {
    return null;
  }
  const varIdx = pm.idx === null ? null : elementIndex(pm.idx, width); // THE one copy of that rule
  const total = pm.byte + off;
  if ((pm.idx !== null && varIdx === null) || total % width !== 0) {
    return null;
  }
  // Variable terms first, constant last — the `idxVal + off / width` order every other indexed
  // spelling in this file uses, and the one the source's own subscript is written in.
  const terms = [varIdx, carried].filter((t): t is Expr => t !== null);
  const k = total / width;
  if (k !== 0 || terms.length === 0) {
    terms.push({ k: 'const', value: k });
  }
  const idx = terms.reduce((l, r) => ({ k: 'bin', op: '+', l, r }));
  return { k: 'index', base: pm.value, idx, width, signed };
}

// WHY THERE IS NO INDEXED `gPtr->arr[i]` SPELLING.
//
// Naming a member is only allowed where it is byte-identical to the cast form it replaces, and
// for the INDEXED form that was measured to be false. Against agbcc, `gPtr->arr[i]` and
// `((u8 *)gPtr + i)[K]` differ at EVERY nonzero K and for every width and direction — agbcc does
// not reassociate `(base + K) + i` into `(base + i) + K`, so it materialises the offset instead of
// folding it into the load (`adds r1, #16`; +2 code bytes at width 1, +4 at widths 2 and 4). At
// K = 0 the two still differ for widths 2 and 4, where the commutative `adds` picks a different
// destination register. The single agbcc case that did measure identical — width 1 at K = 0 —
// survives only a BARE index in a function with ONE such access: `i & 255`, `i + 1`, `i >> 2` and
// a second access that lets the cast side CSE its base all break it. A spelling rule decides one
// expression at a time and cannot see the neighbouring access that changes the answer, so there is
// no local gate that makes this form safe. (Both MIPS targets accept it freely, but core is
// target-agnostic — it cannot condition on the compiler it is emitting for.)
//
// The CONSTANT-offset form below is the opposite case, and is emitted unconditionally: measured
// identical on all three targets for widths 1/2/4, loads and stores, at every offset tested up to
// 4096 — including offsets past Thumb's immediate range, and under multi-member, across-a-call
// and in-a-loop shapes. It is one load whose member offset becomes the same immediate the cast
// form used, and unlike the indexed form it composes.
//
// ONE SHAPE IS NOT IDENTICAL: on agbcc, a STORE to an offset past Thumb's
// immediate range. expand_assignment (gcc/expr.c) expands only the base of a COMPONENT_REF target
// (:2535) and evaluates the right-hand side first in store_field (:2624), while it expands a cast
// (INDIRECT_REF) target whole (:2689) before the right-hand side (:2747). So the member form loads
// a loaded value before it materialises `base + K` and the cast form after it, and with a constant
// or a parameter on the right the two still allocate registers differently. Neither spelling is
// the source's by default: a hoisted `u8 *d = &p->f38; *d = v;` builds the cast's object, and the
// order in which the address and the value are computed is the evidence between them. The member
// is emitted here; raise/structs.ts `foldDisplacedAccesses` folds such a store into its struct by
// default and the `/far-cast` lift keeps it on its address, so the differ referees the two
// (`synthetic:sfar_b` pins the member). A LOAD's member and cast forms compile alike, but agbcc
// gives each member access its own `base + K`, so one materialised base read at two offsets is a
// held pointer, and the fold leaves it on its address (`held-pointer-offsets`, `synthetic:sfar_held`
// pins it); so does ido past its `addiu` reach (target.ts `farMemberBasePerAccess`). On ido, KMC,
// GCC 2.7.2 and mwcc one access's two forms compile alike past a 16-bit displacement, a loaded
// value included, and `/far-cast` is offered there for the neighbours a folded store respells.

/** The pointee a global's value may be spelled through: the members the declaration synthesis
 *  DECLARES. Null when nothing may be named through it — THE shared gate (symbols.ts
 *  pointeeFields), so core never names a member that synthesis would not declare, and never sees a
 *  member synthesis drops (a union alias behind the first view at that offset). A VOLATILE pointee
 *  declines outright: every named access through it would be a volatile access where the cast form
 *  it replaces was plain. */
function spellablePointee(
  name: string,
  sym: SymRenderCtx,
): { fields: DeclaredField[]; const: boolean | undefined } | null {
  const pointee = sym.info(name)?.pointee;
  const fields = pointeeFields(pointee);
  if (fields === null || pointee!.volatile) {
    return null;
  }
  return { fields, const: pointee!.const };
}

/** `gPtr->arr[i]` — a VARIABLE-index access into an ARRAY member of a pointer global's pointee.
 *
 *  Unlike the constant-offset member spelling below, this one is NOT byte-neutral. The member form
 *  materialises the member's own base (`add r1, r1, #0x8` then `ldrb r0, [r1]`) where the cast form
 *  folds the constant into the load (`add r0, r0, r1` then `ldrb r0, [r0, #0x8]`), so the constant
 *  reaches this rule down two distinguishable channels: the base tree (`pg.byte`, a separate add)
 *  or the instruction's own displacement (`off`). The gate is `off === 0` — the constant was
 *  materialised — and where the displacement carries it the cast spelling stands.
 *
 *  THAT CHANNEL DOES NOT SAY THE SOURCE NAMED THE MEMBER: a HOISTED BASE LOCAL materialises the
 *  same constant. Compiled at agbcc's canonical flags against `u8 unk8[6][8]`, all three of
 *  `gBlob->unk8[0][i]`, `u8 *p = (u8 *)gBlob->unk8; p[i]` and `u8 *p = (u8 *)gBlob + 8; p[i]` emit
 *  the identical `add r1, #0x8` · `add r1, r1, r0` · `ldrb r0, [r1]`, while `*((u8 *)gBlob + 8 + i)`
 *  and `((u8 *)gBlob + i)[8]` take the displacement — and the base-local form is a spelling three
 *  shipped passes exist to emit (basecse/nearbase/scopebase). It is a per-site DEFAULT and not a
 *  ranked variation for the OTHER reason of the two docs/level-tower.md gives: those two forms TIE in
 *  bytes, so a variation would enumerate a candidate that can never win. Contrast the GLOBAL rank
 *  recovery one indirection up (`cli/test/matching/array-rank-variation.test.ts`, `/flat-rank`), which
 *  IS a variation because its two spellings do not tie. Do not read this gate as "the asm decided" and
 *  carry that reading to a case where the alternatives differ in bytes.
 *
 *  THE RANK IS PART OF THE SPELLING, not a later fidelity polish. The declaration this access has
 *  to type-check against belongs to the PROJECT, not to asmlift, and `->x[k]` on a `u8 x[6][8]`
 *  is a ROW: agbcc strides it a second time and truncates the resulting pointer to `u8`, which is
 *  a different program that happens to compile. So a member whose map states no rank is REFUSED
 *  (absence means "the map could not say" — see SymbolStructField.dims), and a stated rank is
 *  spelled out in full (`->x[i][j]`, or `->x[0][i]` where the asm merged the row into one flat
 *  counter, which is the same address).
 *
 *  `->x[0][i]` TYPE-CHECKS AND IS OUT OF BOUNDS, and both halves of that are meant: `i` runs the
 *  member's whole element count through a declared row of `8`. There is no in-bounds alternative —
 *  the flat `->x[i]` is a different program (above) and the cast form is what this rule replaces —
 *  so it is the only spelling that both type-checks and keeps the bytes, which is a narrower claim
 *  than "the only spelling that type-checks". The `pmarrrow` synthetic row referees it (pass
 *  `subscriptsFromExtents` a `needRecovered` of true, as the global path does, and the row takes
 *  the cast form: MATCH → diff:5); `kleod:CheckWorldCompletion:agbcc` was its real-tier inhabitant
 *  until kleod's rows were retired (2026-09-13);
 *  at rank 3 the same merge spells `->x[0][0][k]`.
 *
 *  A VARIABLE SUBSCRIPT IS NEVER BOUNDED, here or anywhere. The member lookup bounds only the
 *  CONSTANT part (`pg.byte` inside `[offset, offset+size)`), so `->grid[i]` can address the member
 *  after `grid` exactly as `->x[0][i]` can run past a row. Not this rule's defect to fix: the cast
 *  form it replaces is unbounded in the same way, the asm supplies no bound, and refusing every
 *  unbounded index would refuse the capability whole (`pmarr1`'s `gBlob->unk8[i]` included). It is
 *  recorded so the constant-side check is not mistaken for a bounds check on the access.
 *
 *  REFUSES, and each one keeps the honest cast form rather than guessing. Named with the test that
 *  fails when it is removed (`packages/core/test/symbols.test.ts`), because a refusal nothing
 *  ablates is a claim rather than a rule:
 *    • any load/store displacement at all (`off !== 0`)   — "named only where the member BASE was
 *      materialised"
 *    • a pointee nothing may be named through, a qualifier the name would reintroduce, a width
 *      mismatch, an element signedness the access contradicts (an s8 read is ldrb+lsl+asr where u8
 *      is ldrb alone)   — "honours every gate the constant-offset one does", "a WIDER indexed
 *      member is not named either", "a WIDTH mismatch falls back to the cast spelling"
 *    • no array member of exactly this element width covering the accessed byte   — same three
 *    • a member with NO stated rank   — "absence is not read as rank 1"
 *    • a rank the DECLARATION does not spell: `dims` and `length` are independent map facts, and
 *      symbolFieldType declares the flat byte array whenever the bound is missing   — "a rank with
 *      NO `length` DECLARES flat, so the access may not subscript it — as a pair"
 *    • a rank whose subscripts cannot be split out of the residual   — "a rank the residual cannot
 *      be split along still spells every subscript, never a row"
 *    • a byte offset into the member that does not land on an element boundary
 *
 *  NOT a `Gate` table (l3/gates.ts), unlike `FRESH_MERGE_GATES` and `CARRIER_NAME_GATES` in this
 *  same file: those refusals are predicates over ONE prepared context, while these interleave with
 *  the computations that produce the values the later ones test (the member `find`,
 *  `structFieldInnerExtents`, `declaredArrayShape`, `subscriptsFromExtents`), so building that Ctx
 *  would run all of it on inputs the earlier gates reject.
 *
 *  A THIRD ROUTE TO THE SAME LEGALIZATION, deliberately not taken: peel `lead.length` array levels
 *  off the WALKED base type before the stride check, needing neither `baseElem` nor the global
 *  path's env lie (`noteGlobal(name, T.ptr(elem))`) — both of which exist only because
 *  `derefStrideOk` asks a SINGLE-subscript question of a node carrying `lead.length + 1`
 *  subscripts. It needs `gPtr` typed in the print env, a bigger change than this gap should
 *  carry. */
function pointeeElement(
  pg: PtrGlobalBase,
  off: number,
  width: number,
  signed: boolean,
  isStore: boolean,
  sym: SymRenderCtx,
): Expr | null {
  // `pg.idx === null` narrows the type; the sole caller reaches here only for a variable index.
  if (off !== 0 || pg.idx === null) {
    return null;
  }
  const p = spellablePointee(pg.name, sym);
  const f = p?.fields.find(
    (m) => isArrayField(m) && m.elemSize === width && m.offset <= pg.byte && pg.byte < m.offset + m.size,
  );
  if (!p || !f || !spellsAccessType(f.elemSigned, width, signed) || !memberQualsAllow(f, p.const, isStore)) {
    return null;
  }
  // The map must have STATED the rank. Absence is not rank 1 here: every vendored map predates the
  // provider reading a member's rank, and each one flattens a member its project's header declares
  // multidimensional (SymbolStructField.dims).
  if (f.dims === undefined) {
    return null;
  }
  const inner = structFieldInnerExtents(f);
  const rel = pg.byte - f.offset;
  if (inner === null || rel % width !== 0) {
    return null;
  }
  // …AND THE DECLARATION HAS TO SPELL THAT SAME RANK. `dims` is not the declaration: symbolFieldType
  // needs facts `dims` does not supply (a `length`, a base-type `elemSigned`) and declares the FLAT
  // byte array without them, while `dims` and `length` are independent — a member whose outermost
  // subrange is unbounded (`u8 data[][8]`, legal C; @gba-kit/debug-info reports `length` absent and
  // `dims` regardless) carries `dims: [null, 8]` and no `length`. Reading the rank off `dims` alone
  // therefore emitted `gPtr->grid[0][a0];` against `struct Save { u8 grid[48]; };` — the exact
  // decl-vs-access divergence declaredFields' header calls non-compiling C. Asked of
  // declaredArrayShape, which reads the answer back OUT of the declaration, so no gate that
  // function grows later can reopen it. The element test is the one `baseElem` below asserts: the
  // declaration must really give this base the element type the node is about to state for it.
  const decl = declaredArrayShape(f);
  if (decl.extents.length !== inner.length + 1 || !typeEquals(decl.elem, T.int(width * 8, f.elemSigned!))) {
    return null;
  }
  // The residual is BYTES from the member's start — the accessed byte's own offset into it plus
  // whatever the asm computed. `subscriptsFromExtents` splits the declared rows back out of it,
  // and answers zero leading subscripts for a rank-1 member.
  const residual: Expr = rel === 0 ? pg.idx : { k: 'bin', op: '+', l: pg.idx, r: { k: 'const', value: rel } };
  const split =
    inner.length === 0
      ? (() => {
          const i = elementIndex(residual, width);
          return i === null ? null : { lead: [] as Expr[], idx: i };
        })()
      : subscriptsFromExtents(inner, residual, width, false);
  if (split === null) {
    return null;
  }
  return {
    k: 'index',
    base: { k: 'field', base: { k: 'var', name: pg.name }, name: f.name },
    idx: split.idx,
    width,
    signed,
    ...(split.lead.length ? { lead: split.lead } : {}),
    // The element type the MAP declares for this member — the base is a `field` node off an
    // untyped `var`, which the C type walk types `undefined`, and without this the backend would
    // legalize the base through `((u8 *)gPtr->arr)[i]`, which is the cast form's object again.
    // Stated from the same two facts the member gate above just checked (see l3/ast.ts baseElem).
    baseElem: T.int(width * 8, f.elemSigned!),
  };
}

/** `gPtr->member` for an access through a pointer global's value, or null when the offset is not
 *  provably ONE member's (see the block comment above). A VARIABLE index is not this rule's
 *  constant-offset question at all and is handed to {@link pointeeElement}, which decides it on
 *  its own terms. */
function pointeeAccess(
  pg: PtrGlobalBase,
  off: number,
  width: number,
  signed: boolean,
  isStore: boolean,
  sym: SymRenderCtx,
): Expr | null {
  if (pg.idx !== null) {
    return pointeeElement(pg, off, width, signed, isStore, sym);
  }
  const total = pg.byte + off;
  // Constant offset: the member must match EXACTLY — offset, read width, and the SPELLED type
  // (spellsAccessType). An ARRAY member is excluded whatever its size: `u8 x[1]` would match a
  // byte access by (offset, size) and spell `->x`, which is not an lvalue of that width at all.
  // A BITFIELD member likewise: its `size` is the byte span its bits touch, so a 7-bit field
  // would match a plain u16 read and spell a 7-bit lvalue for a 16-bit access.
  const p = spellablePointee(pg.name, sym);
  const f = p?.fields.find((m) => m.offset === total && m.size === width && !isArrayField(m) && !isBitfieldField(m));
  return p && f && spellsAccessType(f.signed, width, signed) && memberQualsAllow(f, p.const, isStore)
    ? { k: 'field', base: { k: 'var', name: pg.name }, name: f.name }
    : null;
}

// The (name, byte offset) of a global access with a CONSTANT total offset — `&gSym` → off,
// `&gSym + K` → K + off. The exact byte is what a struct-layout field lookup needs; a variable
// residual returns null (no field spelling — falls through to the index/cast forms).
function globalConstByte(baseExpr: Expr, off: number): { name: string; byte: number } | null {
  const top = addrIn(baseExpr);
  if (top) {
    return { name: top.name, byte: off };
  }
  if (baseExpr.k === 'bin' && baseExpr.op === '+') {
    for (const [a, b] of [
      [baseExpr.l, baseExpr.r],
      [baseExpr.r, baseExpr.l],
    ] as const) {
      const a2 = addrIn(a);
      if (a2 && b.k === 'const') {
        return { name: a2.name, byte: b.value + off };
      }
    }
  }
  return null;
}

/** The whole-element subscript a constant byte displacement denotes at a given element width — the
 *  `idxVal + off / width` fold every indexed spelling below shares, with the rule
 *  structure/globalaccess.ts `elementIndex` applies to a VARIABLE residual applied to the constant
 *  one. A displacement that is not a whole number of elements has no subscript spelling at all
 *  (`[0.5]` is not C, and agbcc answers `array subscript is not an integer`), so it declines LOUD
 *  here, where the fraction would be computed, rather than leaving the layer above to have refused
 *  every base that can reach it. */
function displacementIndex(off: number, width: number): number {
  if (off % width !== 0) {
    throw new StructureError(
      `a ${width}-byte access at byte ${off} of its base is not a whole number of elements from it — ` +
        `no subscript spells it`,
    );
  }
  return off / width;
}

/** A stamped narrow store (raise/storesign.ts) spelled through a MEMBER — a struct field, a union
 *  member's view, a struct-array element's field — is converted by the compiler to the member's
 *  DECLARED type, so a declaration whose sign is not the stamp's loses it: `a0->field_6 = -104`
 *  under `u16 field_6` recompiles to `li 0xff98`. Such a store is spelled instead as the flat cell
 *  at the same address, `((s16 *)a0)[3] = -104`, or `((s16 *)(a0 + a1))[1] = -104` for an
 *  element. The member's type is read off the spelled lvalue (`ctype`), so a member declared by a
 *  load, a stamp or a union's view is judged alike.
 *
 *  `storeWidth` is `undefined` for an `astore`, which does not carry it: raise/struct-arrays.ts
 *  declares each field at the one width its accesses share, so the member's width is the store's.
 *
 *  `lval` comes back unchanged for an unstamped store, an lvalue that is not a member, no
 *  `flatBase`, a member that is not a narrow integer of the store's width or agrees with the stamp,
 *  and an offset that is not a whole number of cells (no flat subscript spells it). */
function stampedStoreLval(
  lval: Expr,
  stamp: boolean | undefined,
  storeWidth: number | undefined,
  flatBase: Expr | null,
  off: number,
  ctype: (e: Expr) => IrType | undefined,
): Expr {
  if (stamp === undefined || lval.k !== 'field' || flatBase === null) {
    return lval;
  }
  const t = ctype(lval);
  const width = storeWidth ?? (t?.kind === 'int' ? t.width / 8 : 0);
  if (t?.kind !== 'int' || (width !== 1 && width !== 2) || t.width !== width * 8 || t.signed === stamp || off % width) {
    return lval;
  }
  return { k: 'index', base: flatBase, idx: { k: 'const', value: off / width }, width, signed: stamp };
}

/** The declaration of a PROVEN FRAME PART by the name the lift minted for it (frame-objects.ts
 *  `provenParts`), stated as the map states an array global's, so the one bare-array gate
 *  ({@link bareArrayLead}) spells both: `sp64[i]`, not `((u8 *)sp64)[i]`. Absent for any other frame
 *  object — the one object's bytes are members and spills of any type, which the cast spells
 *  honestly — and for a QUALIFIED access, whose qualifier needs the cast to sit on. */
type FrameArrayDecl = (name: string) => SymbolInfo | undefined;

/** THE bare-name spelling of an element `name[idx]` of a declared array, or null for the cast
 *  form: the frame part's declaration first (a minted frame name is never a map symbol's), else
 *  the map's. A map global registers its element type in the env, so the stride check passes and
 *  no cast is added; a frame part is declared by the lift already (`laddrType`) and keeps its
 *  element spelling at index 0 (`subscript`, see l3/ast.ts). */
function bareArrayIndex(
  name: string,
  idx: Expr,
  width: number,
  signed: boolean,
  sym: SymRenderCtx | undefined,
  frameArray: FrameArrayDecl | undefined,
): Extract<Expr, { k: 'index' }> | null {
  const part = frameArray?.(name);
  const si = part ?? sym?.info(name);
  const lead = si === undefined ? null : bareArrayLead(si, width, signed, idx);
  if (lead === null) {
    return null;
  }
  if (part === undefined) {
    sym!.noteGlobal(name, T.ptr(T.int(width * 8, si!.elemSigned ?? false)));
  }
  return {
    k: 'index',
    base: { k: 'var', name },
    idx,
    width,
    signed,
    ...lead,
    ...(part !== undefined ? { subscript: true as const } : {}),
  };
}

function memAccess(
  base: Value,
  baseExpr: Expr,
  off: number,
  width: number,
  signed: boolean,
  ctype: (e: Expr) => IrType | undefined,
  scalarGlobals: Set<string>,
  sym?: SymRenderCtx,
  isStore = false,
  advancedBy?: number,
  castQualified = false,
  frameArray?: FrameArrayDecl,
): Expr {
  // A deref of a global's address collapses to the bare global: `*(&gSym)` at off 0 is `gSym`;
  // at off N the global is an array — `gSym[N/width]` (a C global name decays to a pointer, so
  // the index reproduces the offset). A `+`-tree base holding `&gSym` is a global-ARRAY element
  // `*(&gSym + i)` → `gSym[i + off/width]` (byte offset `i` peeled from the tree; for a u8 global
  // the residual IS the index). This is what makes an agbcc `.word gSym` pool access a named
  // global read/element rather than a phantom-pointer deref.
  // Declaration-shape spellings (symbol map): a STRUCT global's constant-offset access is the
  // named field (`gSym.field` — the source spelling a folded literal can never match); an ARRAY
  // global indexes its BARE name (`gSym[i]`, see below). Exact field match only (offset AND
  // width) — anything else falls through to the honest cast forms, never a guessed field.
  // The constant offset this access reached through the instruction's MEMORY OPERAND. The two
  // facts are separate at L2 — `off` is the load/store's own immediate, any addend the address
  // carried is already inside `baseExpr` — and folding them into one subscript below
  // (`idxVal + off / width`) is what makes the two indistinguishable at L3, so the displacement
  // is recorded before the fold destroys it (see the `operandOff` note in l3/ast.ts).
  // …and the second evidence field this function carries: the byte step by which the machine advanced
  // an address register to reach this access (raise/const.ts `advancedBy`, recorded before its own
  // fold destroyed it). It rides beside `operandOff` because both are facts about how the address
  // was computed rather than about which cell it names, and both are lost at L3 otherwise.
  //
  // `off === 0` IS A NARROWING, AND ONE SIDE OF IT IS WHAT THE ASM SHOWS. That side is a base
  // value used as an address at TWO offsets — `ldr r3,=X; strh [r3]; adds r3,#2;
  // strh [r3]; strh [r3,#2]`, where the third access carries `{adv 2, off 2}`. Stamping that one
  // makes `l3/advance.ts` spell a second `p = p + 1;` where the target performed no second `add`:
  // the distance still lands (the displacement was folded into the cell address, so
  // `prev.addr + step` matches), so nothing downstream can refuse it, and the byte-exact spelling
  // — one advance and then a subscript — is not in the fan at all. Pinned on that three-access
  // shape in test/advance.test.ts, a COMPILED repro and not a row.
  //
  // WHAT IT IS NOT is "a non-zero `off` says this access was reached by a displacement RATHER THAN
  // by the advance", which is false wherever ONE displacement rides EVERY member —
  // `ldr r3,=X; strh [r3,#4]; adds r3,#2; strh [r3,#4]` is a real chain at X+4 and X+6, and this
  // term refuses it — both index nodes arrive `{off 4, adv undefined}` and `advancedBases`
  // declines, pinned by test/advance.test.ts's `one displacement on BOTH members is a real chain,
  // and the stamp rule declines it`. The discriminating fact is the same base VALUE used at more
  // than one `off`, where only the smallest is the link — not `off` alone, and reaching it takes a
  // per-value census of address offsets this seam does not have.
  //
  // PRICED AT 0 ROWS EITHER WAY, which is why the narrow term ships: instrumenting this seam over
  // `bench sweep --fan --map-modes harness,nomap` (2,126 records, 1,063 rows) counts 4,361 `advancedBy`
  // stamps, ALL of them at `off === 0` and none at `off !== 0`, over ten producing functions. So
  // the shape above has no corpus inhabitant to pay for the census, and the capability it costs is
  // recorded here rather than spent.
  const addressEvidence = {
    ...(off !== 0 ? ({ operandOff: off } as const) : {}),
    ...(advancedBy !== undefined && off === 0 ? ({ baseAdvanced: advancedBy } as const) : {}),
  };
  if (sym) {
    const gb = globalConstByte(baseExpr, off);
    const si = gb ? sym.info(gb.name) : undefined;
    // NOT FOR AN ACCESS THE LIFT QUALIFIED BY A CAST (`castQualified`, ir/discipline.ts `qualifiedBy`):
    // a member's name reaches the object through its declaration, which the map states plain — had
    // it qualified the object the access would be placed `declared` — so `gState.ctl;` would compile
    // to no read at all. The access falls to the cast forms below, where `pinnedAccess` puts the
    // qualifier: `((volatile s32 *)&gState)[2];`.
    if (gb && si?.shape === 'struct' && !castQualified) {
      // THE shared spellability predicate (symbols.ts), the same call declare.ts gates its struct
      // declaration on: a layout it declines whole is a layout with no nameable members, and a
      // union alias it drops for the first view at that offset is a name no declaration carries.
      // The named bitfield spelling has its own recognizer, on the extract shape: see lowerDef.
      const fld = structMemberAt(si, gb.byte, width, isStore);
      if (fld) {
        return { k: 'field', base: { k: 'var', name: gb.name }, name: fld.name, dot: true };
      }
    }
    // …and the same idea one indirection down: an access at a CONSTANT offset through a POINTER
    // global's VALUE is a named member of what it points at (`gPtr->member`) when the map knows
    // the pointee's layout — see pointeeAccess for the guards.
    const pg = ptrGlobalBase(baseExpr, (n) => sym.info(n)?.shape === 'pointer');
    if (pg) {
      const spelled = pointeeAccess(pg, off, width, signed, isStore, sym);
      if (spelled) {
        return spelled;
      }
    }
    // …and one step further out: an access through a POINTER MEMBER's value is an ELEMENT of the
    // buffer that member points AT (see ptrMemberElement).
    const elem = ptrMemberElement(baseExpr, null, off, width, signed, sym);
    if (elem) {
      return { ...elem, ...addressEvidence };
    }
  }
  // …and the MULTIDIMENSIONAL bare-name spelling, which needs the byte terms globalOf's division
  // into elements has already merged: `g[r][i]`, where a term at the declared ROW stride is `r`.
  // Tried before the flat spellings because those cannot express a recovered row at all — and off
  // under `/flat-rank`, which is what puts those flat spellings back in the fan for the differ.
  const gbb = sym?.declRank ? globalByteBase(baseExpr) : null;
  const siMulti = gbb ? sym!.info(gbb.name) : undefined;
  const multi = siMulti ? declaredSubscripts(siMulti, gbb!.residual, width, signed) : null;
  if (multi) {
    sym!.noteGlobal(gbb!.name, T.ptr(T.int(width * 8, siMulti!.elemSigned ?? false)));
    return {
      k: 'index',
      base: { k: 'var', name: gbb!.name },
      idx: addOffset(multi.idx, displacementIndex(off, width)),
      width,
      signed,
      lead: multi.lead,
      ...addressEvidence,
    };
  }
  const g = globalOf(baseExpr, width);
  if (g) {
    const idxVal = g.idx;
    // off-0 access of a SCALAR global (accessed only at offset 0, per scalarGlobals) → the BARE
    // global `gSym` (byte-exact, matches the source spelling). Any other access — a non-zero
    // offset, a variable index, or an AGGREGATE global (accessed at multiple offsets) — indexes
    // the global's ADDRESS `&gSym`, NOT the bare value: a struct global does not decay, so
    // `((s32 *)gSym)[i]` is invalid C, but `((s32 *)&gSym)[i]` reinterpret-casts the address and
    // strides correctly for BOTH a struct and an array global.
    if (off === 0 && idxVal.k === 'const' && idxVal.value === 0 && scalarGlobals.has(g.name)) {
      return { k: 'var', name: g.name };
    }
    const idx = addOffset(idxVal, displacementIndex(off, width));
    // ARRAY-declared global (symbol map): index the bare name — `gSym[i]`, the spelling the
    // dogfood proved agbcc needs for ROM tables — with the element type registered in the env
    // so the stride check passes and no cast is added. Element-width match only. A proven frame
    // part is declared by the lift itself and answers the same gate (see {@link FrameArrayDecl}).
    const bare = bareArrayIndex(g.name, idx, width, signed, sym, frameArray);
    if (bare !== null) {
      return { ...bare, ...addressEvidence };
    }
    return { k: 'index', base: { k: 'addr', name: g.name }, idx, width, signed, ...addressEvidence };
  }
  // …and the same bare spelling where the array's address sits deeper in the sum than globalOf
  // looks (`(u32)sp56 + 32 + v8`, see nestedGlobalOf): taken only when a declaration answers it,
  // so the cast forms below keep every other such sum as written.
  const nested = nestedGlobalOf(baseExpr, width, off);
  const bareNested = nested ? bareArrayIndex(nested.name, nested.idx, width, signed, sym, frameArray) : null;
  if (bareNested !== null) {
    return { ...bareNested, ...addressEvidence };
  }
  const bt = base.type;
  // A field declared at its cell's widest view (raise/structs.ts `castViewCell`) is read at any
  // other view as the flat cell at the same address, `((u8 *)p)[1]`: the cast the union it stands
  // for would have spelled as a member.
  if (bt.kind === 'ptr' && bt.to.kind === 'struct' && !isCastView(bt.to, off, width, signed, isStore)) {
    const rt = ctype(baseExpr);
    // `->` requires the base to render as a pointer to THIS struct (field names resolve against
    // its declaration) AND as a non-`index` node (the printer spells an index-node base with `.`,
    // the array-element form — wrong for a pointer). Anything else is cast to the recovered
    // struct pointer type; the cast node prints with `->`.
    const ok = rt?.kind === 'ptr' && rt.to.kind === 'struct' && rt.to.name === bt.to.name && baseExpr.k !== 'index';
    const structBase = ok ? baseExpr : { k: 'cast' as const, to: bt, e: baseExpr };
    // A byte range recovered as a UNION member (raise/structs.ts) is read through the view of the
    // access's own width and extension: `p->field_0.word`, `p->field_0.half[1]`, `p->field_0.shalf`.
    const u = unionViewAt(bt.to, off, width, signed, isStore);
    if (u === undefined) {
      return { k: 'field', base: structBase, name: `field_${off}` };
    }
    // An internal invariant: the builder made a view for every width and narrow extension a union's
    // own base accessed, and a value that inherits the type through recoverTypes carries a pointee
    // of its own instead.
    if (u.view === undefined) {
      throw new StructureError(
        `a ${width}-byte ${isStore ? 'store' : signed ? 'signed load' : 'unsigned load'} at byte ${off} has no view in the union member '${u.member.name}'`,
      );
    }
    const cell: Expr = { k: 'field', base: structBase, name: u.member.name };
    const view: Expr = { k: 'field', base: cell, name: u.view.name, dot: true };
    return u.index === null ? view : { k: 'index', base: view, idx: { k: 'const', value: u.index }, width, signed };
  }
  return {
    k: 'index',
    base: baseExpr,
    idx: { k: 'const', value: displacementIndex(off, width) },
    width,
    signed,
    ...addressEvidence,
  };
}

// A variable-index array access `base[index]`; `base[index].field_K` when a `fieldOff` marks an
// array-of-STRUCT element (raise/struct-arrays.ts); `base->field_K[index]` when a `memberOff` marks
// an array MEMBER of a struct (raise/memberarrays.ts). The `.field` on an array element prints
// with `.` (the printer decides dot-vs-arrow from the base being an `index` node); a member array's
// own `field` base is a pointer, so it prints with `->`.
//
// Scalar path: a width-carrying `index` node, no cast — the backend legalizes (see memAccess).
// Struct-array path: like memAccess's struct path, the recovered struct pointer type is an L2
// fact the AST cannot carry, so a base that does not render as THAT struct pointer is cast here
// (C then scales the index by the struct size, exactly the aload/astore element stride); the
// `index` node's width is the struct size only nominally — strideOk never fires on struct
// pointees, so the C backend leaves a struct-typed base uncast and the tree-level cast governs.
function arrayAccess(
  base: Value,
  baseExpr: Expr,
  idxExpr: Expr,
  fieldOff: number | undefined,
  memberOff: number | undefined,
  elemSize: number,
  signed: boolean,
  ctype: (e: Expr) => IrType | undefined,
  sym?: SymRenderCtx,
  frameArray?: FrameArrayDecl,
): Expr {
  // An indexed access through a POINTER MEMBER's value is an ELEMENT of what it points at, exactly
  // as in memAccess — the index the aload already carries is the subscript, and any byte residual
  // in the base is converted and summed into it. A fieldOff/memberOff access selects an interior
  // of a STRUCT element instead, which this spelling has no place to put, so it is left alone.
  if (sym && fieldOff === undefined && memberOff === undefined) {
    const elem = ptrMemberElement(baseExpr, idxExpr, 0, elemSize, signed, sym);
    if (elem) {
      return elem;
    }
  }
  // A variable-index access off a global's address indexes the ADDRESS `&gSym` (the cast form
  // `((T *)&gSym)[i]` — valid for a struct global too, unlike casting the bare value). A
  // struct-array-of-globals (fieldOff) or a member array (memberOff) through `&gSym` falls through:
  // this spelling has no place to put the constant offset, so taking it would DROP the member and
  // address the wrong bytes.
  if (baseExpr.k === 'addr' && fieldOff === undefined && memberOff === undefined) {
    // ARRAY-declared global (symbol map) or proven frame part: the bare-name spelling, same rule
    // as memAccess.
    // NO declared-subscript recovery here, and the reason is the evidence, not the shape. The
    // index reaching this spelling is already in ELEMENTS — the asm scaled the whole sum ONCE, at
    // the end — and that single scale is what both candidate sources reduce to, so the term at the
    // row's stride in elements is no longer evidence that the source named the row. Compiled, with
    // the klonoa checkout's own agbcc command line:
    //
    //   u16 g[4][0x400] — a POWER-OF-TWO row stride: `g[a][b]` is `lsl #0xb` + `lsl #0x1` added
    //     (the SEPARATE terms memAccess reads), `g[0][(a<<10)+b]` is `lsl #0xa; add; lsl #0x1`.
    //     DIFFERENT bytes — so the single-scale shape that arrives here is the FLAT spelling's own
    //     codegen, and recovering `g[a][b]` out of it emits a source that does not reproduce the
    //     input asm.
    //   u32 g[6][9] — a NON-power-of-two row stride: `g[a][b]` and `g[0][a*9+b]` are BYTE-
    //     IDENTICAL, because agbcc reassociates `(a*36)+(b*4)` into `((a*9)+b)*4` itself. Nothing
    //     referees the question, which is the same reason `scaledBy` refuses a CONSTANT row term.
    //
    // Both cases say decline: in the first the evidence points the other way, in the second there
    // is none. The recovery therefore lives on the byte residual alone (memAccess), where the two
    // spellings are still distinguishable. Pinned by matching/array-rank-variation.test.ts.
    const bare = bareArrayIndex(baseExpr.name, idxExpr, elemSize, signed, sym, frameArray);
    if (bare !== null) {
      return bare;
    }
    return { k: 'index', base: baseExpr, idx: idxExpr, width: elemSize, signed };
  }
  const bt = base.type;
  // The member-array spelling: the constant offset selects a MEMBER and the index strides inside
  // it. Same cast rule as memAccess's struct path — the recovered struct-pointer type is an L2 fact
  // the AST cannot carry, so a base that does not render as THAT struct pointer is cast here.
  if (memberOff !== undefined) {
    // Both offsets on one access is `b->field_K[i].field_J` — an array of STRUCTS at a member
    // offset, which raise/memberarrays.ts declares as an array of scalars and its `claimed-access`
    // gate refuses. Spelling it through either offset alone addresses the wrong bytes, so the
    // unreachable case declines loudly rather than dropping one.
    if (fieldOff !== undefined) {
      throw new StructureError(
        `an array access carries both a member offset (${memberOff}) and a field offset (${fieldOff})`,
      );
    }
    const structTo = bt.kind === 'ptr' && bt.to.kind === 'struct' ? bt.to : null;
    const rt = ctype(baseExpr);
    const ok = rt?.kind === 'ptr' && rt.to.kind === 'struct' && rt.to.name === structTo?.name && baseExpr.k !== 'index';
    const b = ok || structTo === null ? baseExpr : { k: 'cast' as const, to: T.ptr(structTo), e: baseExpr };
    return {
      k: 'index',
      base: { k: 'field', base: b, name: `field_${memberOff}` },
      idx: idxExpr,
      width: elemSize,
      signed,
    };
  }
  if (fieldOff !== undefined) {
    const structTo = bt.kind === 'ptr' && bt.to.kind === 'struct' ? bt.to : null;
    const rt = ctype(baseExpr);
    const ok = structTo !== null && rt?.kind === 'ptr' && rt.to.kind === 'struct' && rt.to.name === structTo.name;
    // an ill-typed struct-array base with no recovered struct type has no derivable cast target:
    // left as rendered — assertDerefsTyped's FIELD rule flags the definite violations at the
    // stage boundary (the dot-form field types non-struct there).
    const b = ok || structTo === null ? baseExpr : { k: 'cast' as const, to: T.ptr(structTo), e: baseExpr };
    const index: Expr = { k: 'index', base: b, idx: idxExpr, width: elemSize, signed };
    return { k: 'field', base: index, name: `field_${fieldOff}` };
  }
  return { k: 'index', base: baseExpr, idx: idxExpr, width: elemSize, signed };
}

// Raised when the CFG contains control flow the structurer cannot recover (see the module scope
// note above for what IS recovered vs declined). It is an explicit, catchable "out of scope"
// signal — NOT a bug — so callers fail loud with a diagnostic instead of stack-overflowing.
export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureError';
  }
}

// THE one copy of the guard shape (like fieldSpellsDot/derefStrideOk): a predecessor whose
// cond_br decides "enter `header` vs its `exit`". The self-loop DISCOVERY classifies ownership
// with it, and the guard-FUSION site consumes the same shape (its `takenB/fallB === li.exit`
// check is this predicate from the branch's own viewpoint) — a drift between the two is
// fail-safe (traced: either an onStack decline or an unfused `if (g) do…while` spelling, never
// wrong code) but wastes capability, so both keep pointing here.
function isGuardShapedPred(pred: Block, header: Block, exit: Block): boolean {
  if (pred === header) {
    return false;
  }
  const t = pred.ops[pred.ops.length - 1];
  return (
    t.opcode === 'cond_br' &&
    t.successors.some((sx) => sx.block === header) &&
    t.successors.some((sx) => sx.block === exit)
  );
}

const CMP_TO_BIN: Record<string, BinOp> = {
  icmp_slt: '<',
  icmp_sle: '<=',
  icmp_sgt: '>',
  icmp_sge: '>=',
  icmp_ult: '<',
  icmp_ule: '<=',
  icmp_ugt: '>',
  icmp_uge: '>=', // unsignedness is in the operand types
  icmp_eq: '==',
  icmp_ne: '!=',
};

// The float ops (ir/opcodes.ts) and their L3 operators (l3/ast.ts BinOp). A table of their own and
// not entries in ARITH_TO_BIN (arith-ops.ts), because every rule that table's consumers apply —
// the pointer stride, the integer legalizations, the constant fold, the commutative re-spelling —
// is an integer rule.
const FLOAT_TO_BIN: Record<string, BinOp> = { fadd: 'f+', fsub: 'f-', fmul: 'f*', fdiv: 'f/' };

// The float compares (ir/opcodes.ts) and their L3 operators. An ORDERED compare and `fcmp_une` are
// C's relation; an unordered one is the logical NOT of the ordered relation it negates
// (`NEGATED_FCMP`), and is spelled as that `!`, never as the integer negation of the relation.
const FCMP_TO_BIN: Record<string, BinOp> = {
  fcmp_olt: 'f<',
  fcmp_ole: 'f<=',
  fcmp_ogt: 'f>',
  fcmp_oge: 'f>=',
  fcmp_oeq: 'f==',
  fcmp_une: 'f!=',
};

// The operators whose operand order the machine does not fix — candidates for the def-order
// re-spelling in lowerDef. `&&`/`||` are excluded: short-circuit order IS semantics.
const COMMUTATIVE_BIN: ReadonlySet<BinOp> = new Set(['+', '*', '&', '|', '^']);

// Spell a loop update at the place the bottom test reads the variable: the one `name` leaf becomes
// `name++`. Returns null unless the rendered test MENTIONS `name` exactly once, and that mention is
// a readable leaf. `&v1` is a mention the `++` cannot be placed on and cannot be counted out of —
// a callee reads the object through it — so a test holding one alongside a bare `v1` is refused
// here rather than left to `assertPostIncrUnshared`, which would abort the lift instead.
//
// `preUpdateCondFold` decided that on the DEF TREE, and this asks the same question of what the
// lowering actually produced. The two can disagree — an idiom fold spells a value its operands do
// not show, a substitution stops the render short of a leaf the walk reached — and the two
// disagreements are not equally bad: a test that named the variable twice would be C89-undefined,
// and one that names it not at all would drop the update altogether. Both answer null, and the
// caller declines.
//
// No input reaches either answer today, so it is pinned directly, on hand-built expressions
// (test/loop-preupdate-cond.test.ts) — the discipline `sunkCopyOverDroppedUndef` is held to.
export function spellUpdateInCond(cond: Expr, name: string, by: 1 | -1): Expr | null {
  let found = 0;
  let mentions = 0;
  const rec = (e: Expr): Expr => {
    if (mentionedName(e) === name) {
      mentions++;
    }
    if (e.k === 'var' && e.name === name) {
      found++;
      return { k: 'postincr', name, by };
    }
    return mapExprChildren(e, rec);
  };
  const out = rec(cond);
  return found === 1 && mentions === 1 ? out : null;
}

// Recovered info for a self-loop header: its exit block and the per-parameter back-edge
// arg it feeds (the value on the header→header edge). The back-edge arg is the "next"
// value of the phi; mapping it back to the phi turns the latch test into the while test.
interface LoopInfo {
  header: Block;
  exit: Block;
  backArgOfParam: Value[]; // index-aligned with header.params
  /** The PURE forwarding block between the guard and the header, when the compiler's own
   *  loop-invariant motion parked computations there (`mov r3,#0x80; lsl r3,#24` feeding the
   *  latch test). Its defs render inline wherever the loop reads them; the block itself is never
   *  structured — the guard's inits come from ITS edge into the header instead. */
  preheader?: Block;
}

// One early-`return` exit out of a loop body, and the blocks of it that run ahead of the loop's
// update on every path that reaches them (`earlyReturnArm` decides which). Per-EDGE rather than
// flattened into per-loop sets: ownership is decided against `from`, so a second edge into the same
// target is a separate question. Two arms' `owned` sets may OVERLAP: a tail only the loop's exit arms
// run (`armsOnly`, the cross-jumped `h(i); return;` two arms end in) is owned by every arm that
// reaches it, and written once in each. A return tail the exit path also runs (`exitTail`) is written
// in the arm too, but owned by none: the exit path's copy runs it after the update. `owned` has one
// reader, `emitDoWhile`, which unions the arms' sets for its pre-update hazard check — an overlap
// only repeats a block in that union — and a `while` hoists no update, so it has no pre-update reads
// to exempt.
interface LoopArm {
  from: Block;
  to: Block;
  owned: Set<Block>;
}

// A `break` whose arm RUNS CODE first: `if (t[i] == 7) { gHit = 1; break; }`. The arm's blocks never
// reach the latch, so they sit outside the natural loop as a second exit target; `codeBreakArm`
// says when they are one exit with code on the way.
interface BreakArm {
  from: Block;
  to: Block;
  region: Set<Block>;
}

// A loop with no test of its own, `while (1)`: its latches are conditional continues, and it leaves
// by a `break` to `exit` or an early `return`. `exit` is null for a loop no edge leaves at all — the
// main loop that never returns — which has no break, no arm, and nothing after it.
interface ForeverLoopInfo {
  header: Block;
  latches: Block[];
  forwardPreds: Block[];
  exit: Block | null;
  body: Set<Block>;
  arms: LoopArm[];
  breaks: Set<Block>; // the body blocks whose edge to `exit` is a `break`, or whose edge enters a `breakArms` arm
  breakArms: BreakArm[];
  twoLevel?: TwoLevelExit;
  /** the inner loops that hand this loop an outward two-level exit (`TwoLevelExit.outward`), by
   *  header, each with the blocks its hit leaves from */
  handed?: Map<Block, Set<Block>>;
}

// A SECOND EXIT PAST THE CODE AFTER THE LOOP: `for (j…) { if (hit) goto next; } k(i); next: …`, the
// `goto` a search loop takes out of its own exit region. The loop leaves to `exit` and, from the
// blocks in `from`, to `to`, a block every path from `exit` reaches unless it leaves first
// (`twoLevelCandidate`). L3 has no `goto`, so a flag spells it: `f = 0;` ahead of the loop, `f = 1;
// break;` on the edge to `to`, and the code from `exit` up to `to` under `if (f == 0)` after it
// (`emitForever`). Only a `while (1)` takes one, and only where no other reading fits.
//
// OUTWARD: `for (i…) { for (j…) { if (hit) { s(j); goto out; } } k(i); } out:`, the `goto` out of
// BOTH loops. `to` lies past the enclosing loop, and the code from it runs on to that loop's own exit
// (`outwardExitOf`). The flag is handed out one loop at a time: the hit runs that code and `f = 1;
// break;`, and `if (f != 0) break;` follows the loop at once, ahead of everything the hit skips.
// Both loops must take the reading, the enclosing one recording it as `handed`, or neither does.
interface TwoLevelExit {
  to: Block;
  from: Set<Block>;
  outward?: true;
}

/** One edge out of a loop's body that `foreverShape`'s last resort weighs as a two-level exit: from
 *  `from` in the body to `to`, beside the loop's own `exit`. Every field is a getter, so a walk runs
 *  only when the rules ahead of it admit. */
export interface TwoLevelCandidate {
  /** the edge leaves from an inner loop's body, not this loop's own */
  readonly fromInnerBody: boolean;
  /** another edge of this loop already took a second target, and it is not `to` */
  readonly secondTargetElsewhere: boolean;
  /** `to` is the loop's own exit or lies in its body */
  readonly targetIsExitOrInLoop: boolean;
  /** a loop encloses this one and `to` lies outside its body (a `goto` out of both loops) */
  readonly targetPastEnclosingLoop: boolean;
  /** the reading may hand the exit out to the enclosing loop (`TwoLevelExit.outward`): asked only
   *  once every other reading has failed */
  readonly outwardAsked: boolean;
  /** the outward rung's first pass, where the loop takes no two-level exit of its own: only an
   *  outward one */
  readonly ownTargetHeldBack: boolean;
  /** `to` lies past the loop around the enclosing one too (a `goto` out of three loops) */
  readonly targetTwoLoopsOut: boolean;
  /** a loop encloses this one and `exit` lies outside its body */
  readonly exitPastEnclosingLoop: boolean;
  /** `to` is the enclosing loop's header (a two-level `continue`) */
  readonly targetIsEnclosingHeader: boolean;
  /** no forward path from `exit` meets `to` (`twoLevelSkip` is null) */
  readonly exitNeverMeetsTarget: boolean;
  /** the code from `exit` up to `to` re-enters the loop's body */
  readonly skipReentersLoop: boolean;
}

/** When `foreverShape`'s last resort takes an edge for a two-level exit (`TwoLevelExit`). The
 *  argument for each rule is at `twoLevelCandidate` and at that clause. Not in the table: the scope (a
 *  two-level exit is asked only of a `while (1)` reading that failed every other way, `foreverShape`'s
 *  `twoLevel`); the two refusals where the exit is spelled, which judge other contexts
 *  (`TWO_LEVEL_REGION_GATES`, `TWO_LEVEL_BREAK_GATES`); `breakRule`'s DEFENSIVE `leaves for a second
 *  target a loop with a test of its own cannot spell`, read with that function's other refusal
 *  strings; and `emitForever`'s `skipped === null`, a re-check of `exit-never-meets-target`. */
export const TWO_LEVEL_EXIT_GATES: readonly Gate<TwoLevelCandidate>[] = [
  {
    id: 'from-inner-body',
    why: 'an edge out of an inner loop is that loop’s to read first (defensive)',
    sound: false,
    rejects: (c) => c.fromInnerBody,
  },
  {
    id: 'second-target-elsewhere',
    why: 'one flag read after the loop spells one second target, and a third way out has none',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: without second-target-elsewhere a third exit target is still refused where its break is written',
    rejects: (c) => c.secondTargetElsewhere,
  },
  {
    id: 'target-is-exit-or-in-loop',
    why: 'the loop’s own exit and its own body are not a second target (defensive)',
    sound: false,
    rejects: (c) => c.targetIsExitOrInLoop,
  },
  {
    id: 'target-past-enclosing-loop',
    why: 'a break out of both loops hands its flag out to the enclosing loop, asked only once every other reading failed',
    sound: false,
    rejects: (c) => c.targetPastEnclosingLoop && !c.outwardAsked,
  },
  {
    id: 'own-target-held-back',
    why: 'on the outward rung every exit is tried with no flag of the loop’s own first, so the hit’s code laid out ahead of the code after the loop is not read as the exit',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: a `goto` out of both loops takes one flag whichever of its code and the code after the loop is laid out first',
    rejects: (c) => c.ownTargetHeldBack && !c.targetPastEnclosingLoop,
  },
  {
    id: 'target-two-loops-out',
    why: 'a flag handed out one loop at a time is read by the enclosing loop alone, never the one around it',
    sound: false,
    rejects: (c) => c.targetTwoLoopsOut,
  },
  {
    id: 'exit-past-enclosing-loop',
    why: 'the loop’s own exit lies in the enclosing loop whenever its code meets the target there (defensive)',
    sound: false,
    rejects: (c) => c.exitPastEnclosingLoop,
  },
  {
    id: 'target-is-enclosing-header',
    why: 'the enclosing header is a two-level continue, which no flag read after the loop spells',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: each decline is refused by the two-level rule its shape names',
    rejects: (c) => c.targetIsEnclosingHeader,
  },
  {
    id: 'exit-never-meets-target',
    why: 'where the code after the loop never meets the target, no if after the loop holds the code it skips',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: each decline is refused by the two-level rule its shape names',
    rejects: (c) => c.exitNeverMeetsTarget,
  },
  {
    id: 'skip-reenters-loop',
    why: 'code past the loop that runs back into it is the enclosing header read as the loop exit, not yet weighed',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: without skip-reenters-loop the two-level continue lifts, and agrees',
    rejects: (c) => c.skipReentersLoop,
  },
];

/** An exit edge of a `while (1)` that leaves from an inner loop's body, weighed as the inner loop's
 *  outward two-level exit handed out to this one (`TwoLevelExit.outward`, `outwardExitOf`). */
export interface OutwardExitCandidate {
  /** the innermost loop the edge leaves from is not a child of this one, but nested deeper */
  readonly fromDeeperLoop: boolean;
  /** the code from the edge's target is not a break arm of this loop (`codeBreakArm`): it re-enters
   *  the loop, dispatches, leaves for another target, or is entered where the duplication policy
   *  writes it once, after the loop */
  readonly notABreakArm: boolean;
}

/** When `foreverShape`'s outward rung takes an edge out of an inner loop's body as that loop's
 *  outward two-level exit. The argument is at `outwardExitOf`. Not in the table: the inner loop
 *  taking the same edge for its own (`TWO_LEVEL_EXIT_GATES`), checked once both are classified.
 *  `from-a-deeper-loop` is DEFENSIVE: on a `goto` out of three loops the middle loop never reads
 *  the edge as a break arm of its own (the code from the target misses its exit), and the check
 *  that both loops took the reading sends the outer one back to its other readings. */
export const OUTWARD_EXIT_GATES: readonly Gate<OutwardExitCandidate>[] = [
  {
    id: 'from-a-deeper-loop',
    why: 'the flag is handed out one loop at a time, so the edge must leave a loop this one holds directly',
    sound: false,
    rejects: (c) => c.fromDeeperLoop,
  },
  {
    id: 'not-a-break-arm',
    why: 'the code the exit runs is written in the inner loop ahead of its break, so it must be one this loop’s break arm may write',
    sound: false,
    guardedBy: 'two-level-exit.test.ts: each decline is refused by the two-level rule its shape names',
    rejects: (c) => c.notABreakArm,
  },
];

/** A two-level exit about to be spelled where its `while (1)` sits (`emitForever`). */
export interface TwoLevelRegion {
  /** the region holding the loop ends inside the code the exit skips (`stop` among it) */
  readonly skipsRegionEnd: boolean;
  /** the second target is the merge of the switch arm the loop sits in, and a `break;` after the
   *  loop leaves that switch (`switchBreaks`) */
  readonly breakReachesTarget: boolean;
}

/** When `emitForever` spells a two-level exit in the region it is asked for. The argument is at
 *  `emitForever`. */
export const TWO_LEVEL_REGION_GATES: readonly Gate<TwoLevelRegion>[] = [
  {
    id: 'skips-region-end',
    why: 'the code from the second target would render past the end of the region, and its owner renders it again',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: without skips-region-end the goto into the next arm lifts, and agrees: the rule refuses a correct reading',
    rejects: (c) => c.skipsRegionEnd && !c.breakReachesTarget,
  },
];

/** A two-level exit's `break` about to be written out of one block (`structureBlock`). */
export interface TwoLevelBreak {
  /** the block sits in a case body opened inside the loop, where `break` leaves only the switch */
  readonly inCaseBody: boolean;
}

/** When a block's edge to a two-level exit's second target is written `flag = 1; break;`. The
 *  argument is at the refusal in `structureBlock`. */
export const TWO_LEVEL_BREAK_GATES: readonly Gate<TwoLevelBreak>[] = [
  {
    id: 'from-a-case-body',
    why: 'inside a case body a break leaves only the switch, not the loop',
    sound: false,
    guardedBy:
      'two-level-exit.test.ts: without from-a-case-body the case-body exit is refused by the switch-exit rule behind it',
    rejects: (c) => c.inCaseBody,
  },
];

/** A tail several `break` arms share that holds a cycle (`codeBreakArm`, shared). */
export interface BreakTailCycle {
  /** asked by `while (1)`'s last rung (`ArmCopies.cycles`), once every reading that copies no cycle
   *  has failed */
  readonly cycleRung: boolean;
}

/** When a tail several arms share may hold a cycle, so each arm writes its own copy of the loop in
 *  it. The argument is at `earlyReturnArm` (A LOOP IN THE TAIL): the duplication policy's one rule
 *  for a cycle, which `EXIT_TAIL_GATES`' `tail-holds-cycle` and `BYPASS_TAIL_GATES` hold a return
 *  tail to. Not in the table: the acyclic tail (admitted without asking), every other refusal of
 *  `codeBreakArm`, which are its own walk's, and a cycle entered at two blocks, which no copy can
 *  spell as a loop and emission declines loud ("unrecovered back-edge"), as it does wherever the
 *  loop forest holds no loop for a cycle. */
export const BREAK_TAIL_GATES: readonly Gate<BreakTailCycle>[] = [
  {
    id: 'shared-cycle-before-last-resort',
    why: 'a loop copied into every arm is the reading of last resort, after every reading that copies none',
    sound: false,
    guardedBy:
      'loop-break-exit.test.ts: a loop in the tail the arm and the `else` share is copied only once the flag reading fails',
    rejects: (c) => !c.cycleRung,
  },
];

/** One loop's `for` reading (`forPlanAt`, THE LOOP AS A `for`) once its SHAPE is the `for`'s, as
 *  `FOR_PLAN_GATES` judges it. THE FIELDS ARE LAZY, as `CarrierName`'s are: each is computed only
 *  once every rule above it in the table has admitted, so the table's order is also what runs. */
export interface ForPlanCandidate {
  /** an edge into the preheader carries a copy */
  readonly preheaderParams: boolean;
  /** a block besides the guard enters the preheader */
  readonly preheaderSecondWayIn: boolean;
  /** a preheader op has an effect, touches memory, is order-sensitive or qualified */
  readonly preheaderEffect: boolean;
  /** a preheader op can trap (a division) */
  readonly preheaderTraps: boolean;
  /** a preheader op is a def-site anchored write (`anchorConstCopies`) */
  readonly preheaderAnchored: boolean;
  /** an edge into the latch carries a copy */
  readonly latchParams: boolean;
  /** a latch op has an effect or a qualified access */
  readonly latchEffect: boolean;
  /** a latch op is named (materialized) and read outside the latch */
  readonly latchNamedOutside: boolean;
  /** a latch op is a def-site anchored write */
  readonly latchAnchored: boolean;
  /** the latch test reads a body value other than the latch's own ops and the header's params */
  readonly testReadsBody: boolean;
  /** …or the back edge's args do */
  readonly updateReadsBody: boolean;
}

/** `forPlanAt`'s rules past the loop's shape. The argument for each is in the THE LOOP AS A `for`
 *  block above `forPlanAt`. Not in the table, and named here so the table does not read as the whole
 *  of the refusal: the SHAPE the context is built over (one latch that is not the header, one exit,
 *  `g` outside the loop branching only to the header — or the preheader — and the exit, the latch
 *  branching only to the header and the exit, the header entered only from those two), which every
 *  field reads and no rule could be dropped from without a crash; the caller's own construction of a
 *  preheader (a `br` into the header, offered only from a guard); the copies the update and the init
 *  make (`edgeCopyRecords`, which pushes a gap or refuses and so cannot be a prepared field); and
 *  `FOR_PLAN_IV_GATES`, the rules that read those copies.
 *
 *  A preheader in the loop's body is not refused on its own: it is entered only from `g`, and a
 *  natural loop's body holds every predecessor of a block in it but the header, so `g` would be in
 *  the body too, which the shape refuses. */
export const FOR_PLAN_GATES: readonly Gate<ForPlanCandidate>[] = [
  {
    id: 'preheader-params',
    why: 'the preheader runs as statements ahead of the loop, and a value its in-edge hands it would never be written',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without preheader-params the value the guard hands the preheader is read unset',
    rejects: (c) => c.preheaderParams,
  },
  {
    id: 'preheader-second-way-in',
    why: 'the preheader runs once, ahead of the loop, from the guard alone (defensive)',
    sound: false,
    rejects: (c) => c.preheaderSecondWayIn,
  },
  {
    id: 'preheader-effect',
    why: 'the preheader runs ahead of the first test, so also on the path where the guard skipped the loop',
    sound: true,
    guardedBy: 'for-derived-iv.test.ts: a preheader that reads memory refuses the `for`',
    rejects: (c) => c.preheaderEffect,
  },
  {
    id: 'preheader-traps',
    why: 'a division in the preheader would run on the path where the guard skipped the loop, and could trap there',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without preheader-traps a division runs ahead of the loop the guard skipped',
    rejects: (c) => c.preheaderTraps,
  },
  {
    id: 'preheader-anchored',
    why: 'a write anchored at its definition belongs to the edge it replaces, which the loop no longer has (defensive)',
    sound: false,
    rejects: (c) => c.preheaderAnchored,
  },
  {
    // DEFENSIVE: a latch param is read only by the latch's own ops, so by the test or the update,
    // which `test-reads-body` and `update-reads-body` refuse as a body value; one nothing reads is dead.
    id: 'latch-params',
    why: 'the latch is never rendered, so a copy into it would never be written (defensive)',
    sound: false,
    rejects: (c) => c.latchParams,
  },
  {
    id: 'latch-effect',
    why: 'the latch is never rendered, so an effect in it would never run',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without latch-effect a call in the latch never runs',
    rejects: (c) => c.latchEffect,
  },
  {
    // DEFENSIVE: a read outside the latch is one the latch dominates, so past the loop with no guard
    // and no `break` — a loop no fixture or probe has brought here as a `while (1)` (a loop every arm
    // of which continues or returns reads as a `do`-`while` first).
    id: 'latch-named-outside',
    why: 'a named latch value is written nowhere, so a read of it past the latch would see no value (defensive)',
    sound: false,
    rejects: (c) => c.latchNamedOutside,
  },
  {
    id: 'latch-anchored',
    why: 'a write anchored at its definition in the latch would never be rendered (defensive)',
    sound: false,
    rejects: (c) => c.latchAnchored,
  },
  {
    // DEFENSIVE for the first test: a body value has no entry value, so `entry-test-differs` refuses
    // the guard (or the fold) it would be read through.
    id: 'test-reads-body',
    why: 'the test runs ahead of the first trip too, before the body computes what it would read (defensive)',
    sound: false,
    guardedBy:
      'for-plan-gates.test.ts: the heuristic and defensive rules admit nothing wrong when dropped on these fixtures',
    rejects: (c) => c.testReadsBody,
  },
  {
    // Not load-bearing on its own: a body value the latch reads dominates the latch, so it is a
    // header value (named there, and read under that name as the plain reading reads it) or a latch
    // param (refused by `test-reads-body` wherever the test reads it). Kept as the reading measured.
    id: 'update-reads-body',
    why: 'the update reads only the loop variables and values from before the loop, the reading measured',
    sound: false,
    rejects: (c) => c.updateReadsBody,
  },
];

/** `forPlanAt`'s rules that read the update's and the init's copies, once those are made. Lazy, as
 *  `ForPlanCandidate` is. */
export interface ForPlanIv {
  /** the test reads the name the update writes, other than through its back-edge value */
  readonly testReadsUpdate: boolean;
  /** the guard is not the test on the entry values, or with no guard the test does not fold to stay
   *  in the loop */
  readonly entryTestDiffers: boolean;
  /** an edge the test leaves by — the guard's (through its relay) or the latch's — hands the exit a
   *  copy that the `for`'s own init (on the guard's) or update (on the latch's) does not make */
  readonly exitCopy: boolean;
  /** …or a slot it carries without a copy (an identity, or a write anchored at its def) names a
   *  value the `for` writes otherwise ahead of the test: the init's names on the guard's edge (and
   *  the preheader's), on the latch's the IV past its update, or a latch op it never renders; or the
   *  code past the loop reads the IV's param itself, which the update has rewritten there */
  readonly exitNameRewritten: boolean;
}

/** `forPlanAt`'s rules over the IV, its copies and the test. The argument for each is in the THE
 *  LOOP AS A `for` block. Not in the table: the update that is not ONE copy, which every field
 *  reads; and three refusals left inline ahead of the table — init copies that are cyclic or whose
 *  IV init reads another init copy's name (`copySetIsCyclic`, the `init` clause runs after the
 *  copies ahead of the `for`), and a test or update that reads an inner loop's value
 *  (`latchInnerSub`). */
export const FOR_PLAN_IV_GATES: readonly Gate<ForPlanIv>[] = [
  {
    id: 'test-reads-update',
    why: 'the test runs after the update, so a read of the name it writes would see the next trip',
    sound: true,
    guardedBy:
      'for-plan-gates.test.ts: without test-reads-update the test reads the updated IV where the asm read the old',
    rejects: (c) => c.testReadsUpdate,
  },
  {
    id: 'entry-test-differs',
    why: 'the `for` runs its test before the first trip, which the asm does only through the guard it drops',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without entry-test-differs a guard other than the test is dropped',
    rejects: (c) => c.entryTestDiffers,
  },
  {
    id: 'exit-copy',
    why: 'the `for` leaves by its test, which runs no copy into the code after it but the init and the update',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without exit-copy the value the test edges hand the exit is never written',
    rejects: (c) => c.exitCopy,
  },
  {
    id: 'exit-name-rewritten',
    why: 'the init runs ahead of the first test and the update ahead of every other, so a name either writes no longer holds what the asm left there',
    sound: true,
    guardedBy: 'for-plan-gates.test.ts: without exit-name-rewritten the exit reads the IV past its update',
    rejects: (c) => c.exitNameRewritten,
  },
];

// A test-at-top multi-block `while`. The header is a pure test whose cond_br enters `bodyEntry`
// (inside the loop) or leaves to `exit` (the single loop exit). Unlike LoopInfo the condition reads
// the header's params directly (top-of-iteration values) — no back-edge substitution.
interface WhileLoopInfo {
  header: Block;
  bodyEntry: Block;
  exit: Block;
  latch: Block; // the single block with the back-edge to header (its args = the update)
  forwardPreds: Block[]; // header preds outside the loop body (the entry/init side)
  body: Set<Block>; // the pure natural-loop body (for in-body vs exit classification)
  arms: LoopArm[]; // the early-`return` exits out of the body (`earlyReturnArm`)
  breaks: Set<Block>; // the body blocks whose edge to `exit` itself is a `break`, or enters a `breakArms` arm
  breakArms: BreakArm[];
}

// Opcodes whose NUMBER OF EXECUTIONS is observable. Moving one of these out of a loop changes what
// the program does — a call that ran per iteration would run once. A `load`/`aload` is deliberately
// NOT here: it is a pure read, so running it once instead of per-iteration is unobservable as long
// as it reads the same memory, which is exactly what the existing def→render barrier scan
// (structure/analysis.ts) already proves before it lets one inline at all.
const REPEATED_EFFECT = new Set(['call', 'opaque']);

/** No evidence about where this copy goes — NOT "written before everything". A destination the
 *  predecessor never wrote is an argument passing through, and both orders put those first, so the
 *  record answers no question the assembly put to it. Priced where the sort runs. */
const NO_RECORD = -1;
/** A MEASURED predecessor that recorded no destination of this edge — it wrote registers, none of
 *  them a key this edge copies. Distinct from an UNMEASURED pred, which has no record at all and
 *  falls back to the def-position proxy. */
const NO_WRITTEN_DESTINATIONS: ReadonlyMap<Value, number> = new Map<Value, number>();

/** Does the write-order record order some edge's copies differently from the def-position proxy?
 *  rank.ts's enumeration gate for `/copy-defpos`: where the two orders agree, the sibling is the
 *  same tree and the fan does not grow.
 *
 *  A SUPERSET of the real sort, on purpose and in the safe direction — and the direction only
 *  holds because rank asks this of the SAME fn it then structures (a `perLiftGate`, evaluated on
 *  that lift's own fully-raised fn). Two gaps remain, both of which only say YES where the sort
 *  says nothing: `keepSlot`/`suppressedArgs` drop copies this still counts, and this asks of every
 *  edge where `preferDefPosCopyOrder` reorders only the acyclic ones (`copySetIsCyclic` needs the
 *  built copy list, which is not available here). So it can answer true for a pair that later
 *  collapses — the tree dedup then eats it — but never false for one that does not.
 *
 *  ASKED ANY EARLIER THE CLAIM FAILS, in both directions. The answer moves with the SYMBOL MAP
 *  (klonoa's `UpdateHUDCollectibleCount` answers false under the map and true without it, off one
 *  asm — test/corpus/agbcc-hudcount.s) and with the STAGE, because `raise/latch.ts` rewrites the
 *  record this reads (klonoa's `EntityGravityAndFloorCheck`: false after `recoverTypes`, true
 *  after `foldEmptyLatches` — a RECORD of a measurement, not a live check: that function is in no
 *  corpus row and no fixture here, so the claim cannot be re-run from this repo).
 *
 *  A SECOND, HAND-WRITTEN SPELLING of `edgeCopyRecords`' two comparators — including the stability
 *  that decides ties — not a call into them, and nothing forces the two to agree. A change to that
 *  sort has to be mirrored here BY HAND, or this gate keeps answering about an ordering the pass no
 *  longer produces. Unified deliberately not: this is `/copy-defpos`'s perLiftGate, so it decides
 *  which candidates are ENUMERATED and its predicate cannot move without moving rows. */
export function edgeCopyOrdersDiffer(fn: Fn): boolean {
  const order = fn.writeOrder;
  if (order === undefined) {
    return false;
  }
  const defs = defOpMap(fn);
  for (const pred of fn.blocks) {
    if (!order.writes.has(pred)) {
      continue;
    }
    const rec = order.lastWrite.get(pred) ?? NO_WRITTEN_DESTINATIONS;
    const opAt = new Map(pred.ops.map((o, i) => [o, i] as const));
    for (const op of pred.ops) {
      for (const succ of op.successors) {
        if (succ.args.length < 2) {
          continue;
        }
        const slots = succ.args.map((_, i) => i);
        const proxyPos = (i: number) => {
          const d = defs.get(succ.args[i]);
          return d !== undefined && opAt.has(d) ? opAt.get(d)! : NO_RECORD;
        };
        const byRecord = [...slots].sort(
          (a, b) => (rec.get(succ.block.params[a]) ?? NO_RECORD) - (rec.get(succ.block.params[b]) ?? NO_RECORD),
        );
        const byProxy = [...slots].sort((a, b) => proxyPos(a) - proxyPos(b));
        if (byRecord.some((v, i) => v !== byProxy[i])) {
          return true;
        }
      }
    }
  }
  return false;
}

// A bottom-tested `do { body } while(cond)`. The header is the body entry (entered before any
// test); the LATCH holds the loop condition and the single exit. Body = header..latch structured, then
// the latch's own ops + the loop-update; the latch test is the do-while condition. The condition is
// read under the latch back-edge substitution (post-update the params hold their next-iteration value).
interface DoWhileInfo {
  header: Block;
  latch: Block;
  exit: Block;
  forwardPreds: Block[];
  body: Set<Block>; // the pure natural-loop body (for in-body vs exit classification)
  arms: LoopArm[];
}

/** One carrier offered to one merge slot, as `FRESH_MERGE_GATES` judges it. */
export interface FreshMergeCarrier {
  /** every in-edge passes the SAME value, so the merge is a pure alias of the carrier */
  readonly allSame: boolean;
  /** the carrier is an entry parameter, or a merge home this rule itself minted */
  readonly paramRooted: boolean;
}

/** `freshParamMerge`'s admission: may this merge take its OWN home instead of the carrier's name?
 *  Nothing here is `sound` — both spellings are ordinary C over the same values, so `rank.ts`
 *  enumerates the ON one as `/fresh-merge` and the differ referees it. What keeps them two
 *  SPELLINGS rather than two PROGRAMS is `canTakeName`'s carrier width/sign check, which runs on
 *  the same carrier one step earlier.
 *
 *  WHAT THE SPELLING BUYS: a parameter is live from entry, so its name pins the value to the
 *  register the ABI handed it; a fresh local is dead until its first arm, so the compiler may place
 *  the copy where the asm has it. Which merges actually needed a register of their own is not
 *  recoverable from the C, and the rule is ALL-OR-NOTHING over a function's param-rooted slots. On
 *  `max3` (agbcc -O2, scored against its own target) only the SECOND of the two chained merges is
 *  load-bearing: re-homing just the first is byte-identical to re-homing neither (score 5), and
 *  re-homing just the second is byte-identical to re-homing both (score 0, MATCH). Splitting the
 *  decision per slot would be a fan of 2^slots, so the variation offers the whole-function spelling.
 *
 *  `param-rooted` is a SCOPE, not a derivation. A chain rooted in an ordinary merge home is left
 *  alone, and widening to one is a different, unmeasured variation: 293 of 721 map-less corpus rows
 *  carry at least one conditional merge slot (925 slots), of which the param rooting admits 109 —
 *  `LoadBGTilemapData` is one of the other 184, which is why the variation has no reach there — a RECORD
 *  of a measurement, not a live check: that function is in no corpus row and no fixture here (its
 *  attribution evidence is docs/lbg-attribution.md), so it cannot be re-run from this repo.
 *
 *  The rooting is over carrier VALUES, and two shapes carry a parameter's value past it under
 *  another name, both reach-only: a redundant phi keeps the parameter's own name (`redundant-phi`)
 *  and its result is then an ordinary carrier, which fires on 0 of 721 lifted corpus rows; and the
 *  minted-home set records only merges that ended up FRESH, so a merge that refuses a parameter and
 *  then adopts an ordinary local is not recorded — 336 firings over 6 rows. */
export const FRESH_MERGE_GATES: readonly Gate<FreshMergeCarrier>[] = [
  {
    id: 'redundant-phi',
    why: 'a merge every edge feeds the same value overwrites nothing, so a local of its own only adds a copy',
    sound: false,
    guardedBy: 'fresh-merge.test.ts: a redundant phi over one parameter keeps the parameter',
    rejects: (c) => c.allSame,
  },
  {
    id: 'param-rooted',
    why: 'a merge fed by a chain that does not start at a parameter keeps its ordinary local',
    sound: false,
    guardedBy: 'fresh-merge.test.ts: a merge over ordinary locals is untouched',
    rejects: (c) => !c.paramRooted,
  },
];

/** Whether any merge slot could reach `FRESH_MERGE_GATES` at all: an in-edge argument list that
 *  differs and includes an entry parameter — what `rank.ts` gates enumeration of `/fresh-merge` on.
 *  An OVER-approximation, which is the safe direction for a gate that only decides whether to
 *  enumerate: the walk can still refuse
 *  the carrier (`carriesPreUpdate`, `canTakeName`), and a slot whose carrier is a home this rule
 *  mints is not visible here at all. */
export function hasParamRootedMerge(fn: Fn): boolean {
  const entryParams = new Set<Value>(fn.blocks[0].params);
  return fn.blocks.slice(1).some((b) =>
    b.params.some((_, i) => {
      const args = fn.blocks.flatMap((pr) =>
        pr.ops[pr.ops.length - 1].successors.filter((sx) => sx.block === b).map((sx) => sx.args[i]),
      );
      return args.some((a) => a !== args[0]) && args.some((a) => entryParams.has(a));
    }),
  );
}

/** True when the merge takes its own home. The table is a parameter so a test can drop one gate and
 *  re-run the real pass (`StructureHooks.freshMergeGates`). */
function reHomesParamMerge(
  c: FreshMergeCarrier,
  gates: readonly Gate<FreshMergeCarrier>[] = FRESH_MERGE_GATES,
): boolean {
  return firstRejection(gates, c) === null;
}

/** One name offered to one block parameter, as `CARRIER_NAME_GATES` judges it.
 *
 *  THE FIELDS ARE LAZY, and that is a cost decision rather than a style one. `canTakeName` runs per
 *  merge slot per carrier over every named value in the function, and `NAME_COALESCE_GATES`' eager
 *  record is affordable only because its pass is an opt-in variation. Laziness changes nothing about
 *  BLAME: `firstRejection` reports the first gate in TABLE order that rejects, whichever fields
 *  were computed to get there. What it does mean is that the table's order also decides what runs,
 *  so the two whole-function walks sit at the bottom. */
export interface CarrierName {
  /** the merge is a pure alias — every in-edge hands it the same value */
  readonly pureAlias: boolean;
  /** the name offered is that value's OWN, not a loop variable's name offered through its back edge */
  readonly ownName: boolean;
  /** the name's declaration and the parameter disagree about carrier width */
  readonly widthDiffers: boolean;
  /** …or, at a sub-word width, about signedness — which at that width is part of the width */
  readonly signDiffers: boolean;
  /** another parameter of the SAME block already holds the name */
  readonly siblingHolds: boolean;
  /** a value under the name is still live where the parameter's in-edge copies land */
  readonly carrierLive: boolean;
  /** the name is written somewhere the parameter is still live — at a materialized definition
   *  under it, or at any block a predecessor of another parameter's block reaches, which is that
   *  block itself plus wherever a loop emitter could move the copy to */
  readonly carrierWritten: boolean;
  /** a value with no name of its own re-derives the name at a use past the copy */
  readonly reDerivesName: boolean;
  /** …or reads it through a loop's back-edge argument, which carries the loop variable's name
   *  (`backArgName`) and renders as that name past its loop */
  readonly backArgReadsName: boolean;
}

/** `canTakeName`'s admission: may this block parameter be SPELLED with a name that already exists,
 *  so the in-edge copies into it disappear? EVERY rule here is sound — a refusal costs one copy in
 *  the emitted C, and an admission this table gets wrong is a program that computes something else.
 *  The argument for each is in the block comment above `canTakeName`, which has room for it.
 *
 *  `carrier-write` carries the one approximation in the table. A loop emitter rotates the header's
 *  update copy to the BOTTOM of the body, where it also runs on the exiting iteration, so a write
 *  nominally on a back edge lands on the exit path too. Liveness cannot see a placement, so the
 *  rule takes the conservative union over every block the writing edge's predecessor reaches. */
export const CARRIER_NAME_GATES: readonly Gate<CarrierName>[] = [
  {
    id: 'carrier-width',
    why: 'the copies into the name are assignments through its declaration, which would truncate',
    sound: true,
    guardedBy: 'fresh-merge.test.ts: a merge WIDER than its parameter carrier takes a fresh home',
    rejects: (c) => c.widthDiffers,
  },
  {
    id: 'carrier-sign',
    why: 'a narrow declaration IS the extension it replaced, and u8 re-applies a different one',
    sound: true,
    guardedBy: 'carrier-name.test.ts: ablating carrier-sign reads an s8 carrier through a u8 name',
    rejects: (c) => c.signDiffers,
  },
  {
    id: 'sibling-param',
    why: 'two parameters of one block share every in-edge, so one edge would write the name twice',
    sound: true,
    guardedBy: 'carrier-name-fuzz.test.ts: every SOUND gate of CARRIER_NAME_GATES is load-bearing',
    rejects: (c) => c.siblingHolds,
  },
  {
    id: 'carrier-live',
    why: 'a value under the name still live here is what the in-edge copies would overwrite',
    sound: true,
    guardedBy: 'carrier-name-fuzz.test.ts: every SOUND gate of CARRIER_NAME_GATES is load-bearing',
    rejects: (c) => !c.pureAlias && c.carrierLive,
  },
  {
    id: 'carrier-write',
    why: 'the converse — the name must not be written anywhere the parameter is still live',
    sound: true,
    guardedBy: 'carrier-name.test.ts: ablating carrier-write reads a loop variable past its sunk update',
    rejects: (c) => c.carrierWritten,
  },
  {
    id: 're-derives',
    why: 'an unnamed live value is re-rendered at its use, and would read the name written here',
    sound: true,
    guardedBy: 'name-clobber.test.ts: the inlined difference keeps reading the value the asm computed it from',
    rejects: (c) => !c.pureAlias && c.reDerivesName,
  },
  {
    // A back-edge argument is in no `varName`: it takes the header's name unconditionally
    // (`seedLoopParams`), and the exit region's substitution renders it as that name after the loop.
    // So a merge there offered the same name overwrites it on every other in-edge. `int u; do { … u =
    // …; } while (--d > 0); return (c != 1 ? u : u + t) * u;` at mwcc: the merge took `u`'s name, and
    // its `else` copy overwrote the `u` the multiply still reads.
    id: 'back-arg-live',
    why: "a loop's back-edge value renders under the loop variable's name after the loop, and the copies would overwrite it",
    sound: true,
    guardedBy: 'name-clobber.test.ts: a back-edge argument live across a merge reads the name it carries',
    rejects: (c) => !c.pureAlias && c.backArgReadsName,
  },
  {
    // `carrier-live` and `re-derives` waive a pure alias because the alias and its value are equal on
    // every path under the value's own name. A loop variable's name holds the value only once the back
    // edge that carries it has run.
    id: 'alias-under-its-own-name',
    why: "a loop variable's name holds the value it is offered for only after the back edge that carries it",
    sound: true,
    guardedBy: 'carrier-name.test.ts: a redundant merge shares only its value’s own name, not a later loop variable’s',
    rejects: (c) => c.pureAlias && !c.ownName && (c.carrierLive || c.reDerivesName),
  },
];

/** A nested loop's header parameter offered its ENCLOSING loop's name, as
 *  `ENCLOSING_CARRIER_GATES` judges it — the admission `enclosingCarrierName` makes before
 *  `canTakeName` (`CARRIER_NAME_GATES`) is asked. `E` is the inner header's first forward
 *  predecessor and `a` the argument `E` hands the parameter.
 *
 *  Lazy for the same reason `CarrierName` is: `carriedByBoth` walks the in-edges of both headers,
 *  so it sits last and runs only when every cheaper rule admits. Every field is TOTAL — false when
 *  `E` or `a` does not exist — so a test can drop any one gate and the rest still answer. */
export interface EnclosingCarrier {
  /** every forward predecessor of the inner header is the one block `E`, and `E` is not the header */
  readonly oneForwardEntry: boolean;
  /** `E` heads a loop whose body holds the inner header */
  readonly entryEncloses: boolean;
  /** `a` is one of `E`'s own parameters — `E`'s loop-carried value, which `E` does not compute */
  readonly argIsEnclosingParam: boolean;
  /** the frontend measured `E`, and `E` wrote nothing into the parameter's key */
  readonly keyUnwritten: boolean;
  /** the value is carried by BOTH loops (`carriedByBothLoops`). False whenever `entryEncloses` or
   *  `argIsEnclosingParam` is, since it needs `E`'s loop and `a`'s slot in `E` — which is why no
   *  fixture can separate those two from this one. Independent of `keyUnwritten`, which no part of
   *  the walk consults */
  readonly carriedByBoth: boolean;
}

/** `enclosingCarrierName`'s own admission. The argument for each rule is the block comment above
 *  `enclosingCarrierName`; the ids are here so a refusal can be named and a rule dropped by a test.
 *
 *  ONE rule is sound, and it is the last. The four before it bound what the write-order record can
 *  be EVIDENCE for — a refusal keeps the two-variable spelling, which is correct by construction —
 *  so each is `sound: false`: dropping one spells a different, still-correct program (the fixtures
 *  in `nested-carrier.test.ts` show what each keeps). `carried-by-one-loop` is the collision
 *  `canTakeName` cannot see, and dropping it emits another program. */
export const ENCLOSING_CARRIER_GATES: readonly Gate<EnclosingCarrier>[] = [
  {
    id: 'one-forward-entry',
    why: 'the record is per predecessor, so it cannot vouch for a second edge into the inner header',
    sound: false,
    rejects: (c) => !c.oneForwardEntry,
  },
  {
    id: 'enclosing-header',
    why: 'only the enclosing header itself has a record that can say the entry copy was not made',
    sound: false,
    rejects: (c) => !c.entryEncloses,
  },
  {
    id: 'enclosing-param',
    why: 'only a value the enclosing header did not compute can have reached the inner loop uncopied',
    sound: false,
    rejects: (c) => !c.argIsEnclosingParam,
  },
  {
    id: 'key-written',
    why: 'the enclosing header wrote the key (or was not measured): the source spelled the copy',
    sound: false,
    rejects: (c) => !c.keyUnwritten,
  },
  {
    id: 'carried-by-one-loop',
    why: 'a value the outer back edge replaces would be overwritten under a name the inner loop reads',
    sound: true,
    guardedBy: 'nested-carrier.test.ts: ablating carried-by-one-loop lets the outer update clobber the inner value',
    rejects: (c) => !c.carriedByBoth,
  },
];

// Structuring options, threaded as DATA so a new one is a field here + its consumer, not a new
// positional boolean widened across every call site:
//   returnsVoid                    — from the function's own prototype (suppress phantom r0 return);
//   coalesceLoopInit               — keep the induction var in its arg register;
//   preserveDivergentBranchSense   — reproduce source branch direction on divergent ifs;
//   orderArgCopiesByWriteOrder     — order edge copies by the order the pred WROTE their
//                                    destinations.
// The last three are `compilerBehaviors` (target.ts) — this pass stays target-AGNOSTIC: it reads
// booleans, never a compiler name. So are the arithmetic table's (`ArithCompilerFacts`), which this
// type extends and hands to `makePointerSpelling` whole; the byte-pointer temp step below reads
// `keepsPointerSumAddend` from it too.
//
// WHAT A FIELD DOC BELOW HOLDS, narrowly: what the option MEANS to `structure()`, and the suffix of
// the variation that enumerates it. A VARIATION's rationale, and any figure pricing its marginal value, live
// ONCE at its `STRUCTURE_VARIATIONS` entry in rank-variations.ts — restated here the two copies rot
// separately, and only that one is the entry the enumeration reads. Figures pricing a
// DEFAULT this pass owns (the edge-copy ordering, `spellDeclaredSubscripts`) do belong here.
export interface StructureOptions extends ArithCompilerFacts {
  returnsVoid?: boolean;
  coalesceLoopInit?: boolean;
  preserveDivergentBranchSense?: boolean;
  // Spell a JOINED two-armed if with the negated condition and swapped arms: the asm branched
  // forward to the taken block and fell through to the other, so a compiler that preserves
  // source branch direction saw the FALL-THROUGH arm as `then` — the same layout evidence the
  // divergent case reads (preserveDivergentBranchSense), which post-dominance hides here because
  // both arms reconverge. Defaults to preserveDivergentBranchSense rather than to a constant, so a
  // target that opts out of the divergent claim opts out of this one; target.ts says how.
  //
  // This is the ZERO POINT of rank.ts's `/flip-join` variation, not a per-compiler fact that closes
  // the question — docs/level-tower.md wants a default only where the mapping is a FUNCTION, and
  // benchmark rows still reach their winning spelling through the variation rather than through this
  // default. Read it forward only: it says which sense to emit ABSENT evidence of an inversion,
  // never that the asm's layout WAS the source's sense. What agbcc contributes is the refusals —
  // its gcc Makefile SRCS compiles neither sched.c nor reorg.c and toplev.c never sets
  // flag_schedule_insns, and gcse.c runs one_code_hoisting_pass only `if (optimize_size)`, which
  // toplev.c sets for -Os alone — so no scheduler and no hoister moves an arm's body across the
  // branch after stmt.c laid the arms out in source order.
  //
  // Three mechanisms DO invert the sense, and each is per-SITE where this option is per-function,
  // so no value here is right in every `if` of a function that holds several: a short-circuit
  // fold picks which successor is `taken` from the asm's branch polarity, which on Thumb the
  // branch RANGE decides (raise/shortcircuit.ts); a relay past a branch's reach inverts to jump
  // around the long form; and a rotated loop's zero-trip guard is an `if` no source wrote at all
  // (`synthetic:fib`, `for(i=0;i<n;i++)`, emits `if (0 >= a0) … else do{…}while`), so there no
  // spelling is the faithful one and only the differ can choose. `senseFromFoldEvidence` below
  // answers the FIRST of the three per site, off the fold's own record.
  negateJoinedBranchSense?: boolean;
  /** Spell a branch-sense site from the SHORT-CIRCUIT FOLD'S own orientation evidence, where the
   *  fold left some, instead of from the two booleans above. `raise/shortcircuit.ts` stamps the
   *  fused branch with three facts: `scSharedOnFall` — whether the arm both tests reach was FALLEN
   *  INTO rather than branched to, and so, since gcc lays a condition's arms out in source order,
   *  whether it is the source's `then` — `scSharedIsTaken`, which successor slot that arm landed in
   *  here, and `scEdgeRelayed`, whether a long-branch trampoline sat on either edge, which is the
   *  layout where the source-order premise is inverted and therefore must not be consulted. The
   *  site NEGATES in one cell only: the shared arm in the TAKEN slot, branched to, no relay — the
   *  taken slot holding the source's `else`. Per SITE, which is the point: the booleans are per
   *  function, and a function whose `if`s were written in opposite senses has no right value for
   *  either.
   *
   *  A site the fold did not touch carries no stamp and keeps its boolean, so this changes nothing
   *  on a function with no short-circuit chain. rank.ts's `/site-sense` variation; it is a VARIATION and not
   *  a default because the source-order premise under `scSharedOnFall` is a claim about gcc's
   *  layout that the differ referees per row — and because one cell of the table is genuinely
   *  undecided by these three facts (see the census at the read). */
  senseFromFoldEvidence?: boolean;
  /** PER-SITE override of whatever decided a site's sense — the boolean, or `senseFromFoldEvidence`
   *  where that is on: the ORDINALS of the branch-sense sites to spell the OTHER way round. A
   *  site's ordinal is its
   *  position among the distinct blocks that turn out to BE sense sites, in first-visit order —
   *  a numbering only this pass can hand out, since a site exists only once structuring has
   *  decided both of its arms are real. Absent ⇒ the booleans alone decide, which is every caller
   *  but the enumerating one; an ordinal past the last site is inert. */
  branchSenseFlipSites?: ReadonlySet<number>;
  orderArgCopiesByWriteOrder?: boolean;
  /** Order a measured edge's ACYCLIC copy set by the def-position proxy instead — the
   *  `/copy-defpos` ranked sibling of the write-order spelling (rank.ts). A CYCLIC set keeps the
   *  record either way: there an instruction names the compiler's temp, and no arm of the fan may
   *  contradict it (`copySetIsCyclic`). Not a target field and deliberately not one: which order a
   *  compiler laid out is two-sided inside one compiler, so the differ referees it per row. Inert
   *  on an unmeasured pred, where the proxy is already what runs. */
  preferDefPosCopyOrder?: boolean;
  /** In a jump table where two or more arms enter one sibling arm's body (a cross-jumped tail),
   *  write that body back into EVERY entrant instead of letting the one the arm-order policy puts
   *  above the sibling keep its fall-through (`copySharedFallTargets`). rank.ts's `/tail-copies`
   *  variation: which arm the source wrote the tail under is not in the asm, and one compiler answers
   *  both ways, so the differ referees it. Inert where no switch has such a sibling. */
  copyEveryTailEntrant?: boolean;
  /** In a jump table where two or more arms enter one sibling CASE arm's body and the copies would
   *  write that body back into the entrants (`copySharedFallTargets`), spell them with the one
   *  fall-through and `goto`s to that case's label instead (`jumpSharedFallTargets`), the source's
   *  own spelling of the shape. rank.ts's `/case-goto` variation: a cross-jump of copies and a goto
   *  are one asm where the cross-jump merges the whole copy, and the copies are a goto-free reading
   *  that compiles elsewhere (agbcc's CSE stops the cross-jump short of a copy that re-reads an
   *  address the arm already formed), so the differ referees it. Inert where no switch has such a
   *  sibling. */
  jumpToSharedCases?: boolean;
  /** Spell EVERY `while (1)` loop `forPlanAt` accepts as `for (init; cond; inc)` on the first
   *  structuring, not only one a declined run asked for (`ForRanking`). rank.ts's `/for-continue`
   *  variation: a counted loop whose latch holds the update and the test is the same asm as
   *  `while (1)` with that latch at the foot of the body and as a `for` whose `continue` runs it, so
   *  the differ referees the two where both lift. Inert where `forPlanAt` refuses every loop. */
  spellCountedLoopsFor?: boolean;
  // Comparison-tree switch recovery: treat an `x != K` test as a case (the EQUAL side is a case
  // body). GCC freely uses `!=`; IDO prefers `==`/`<`. A compiler behavior, not an `arch ==`
  // branch — default true (permissive; the decline path keeps it sound either way).
  switchAllowsNeqCase?: boolean;
  // Comparison-tree switch recovery: treat a relational test as a case where the values that can
  // reach it leave exactly one on a side its compiler's dispatch lands a body on — the BRANCH
  // (`'taken'`) or either side (`'either'`). A compiler behavior declared in
  // TargetDescription.compilerBehaviors. Absent: every relational edge navigates.
  switchBoundCase?: SwitchBoundCase;
  // Comparison-tree switch recovery: emit the case arms in the order the ASSEMBLY lays their
  // bodies out, rather than sorted by ascending case value. A compiler behavior declared in
  // TargetDescription.compilerBehaviors — a compiler opts in on evidence that it neither reorders
  // basic blocks nor schedules across them, so the layout it produced IS the order the source
  // wrote. Default false: absent, the arms keep the ascending spelling.
  switchArmsFollowLayout?: boolean;
  // Comparison-tree switch recovery: DECLINE a tree whose own layout interleaves a test block with
  // a case body, on the reading that the source wrote an if/else-if LADDER there and not a
  // `switch`. Regime A otherwise recovers a `switch` from any comparison tree it can, so a ladder
  // and a `switch` over the same values produce the SAME candidate and the differ never sees the
  // ladder — there is nothing in the fan for it to prefer.
  //
  // The two spellings are different objects. Compiled at agbcc's canonical flags the same two-case
  // body is 20 bytes either way (0x14, ten Thumb instructions — the pair is committed as
  // `corpus/agbcc-sw{frontload,ladder}.s`) and disagrees instruction for instruction: the `switch` emits
  // `cmp #0x1e; beq` then `cmp #0x64; bne` — both tests ahead of both bodies, and sorted ASCENDING,
  // which is the reverse of the order the source writes them in — while the ladder emits
  // `cmp #0x64; bne` directly above its own body and reaches `cmp #0x1e` only after it.
  //
  // Read PER SITE off the recovery's own blocks — a function may hold one of each — and it
  // inherits `layoutIndex`'s frontend premise (see switch-recover.ts PRE5, which also states what
  // the gate costs when the premise fails: the `switch` spelling, never correctness — and what a
  // lost spelling actually looks like, which on a NESTED tree is an `if` nest around a `switch`
  // over some of the arms, not a clean ladder).
  // Default false: absent, every recoverable tree is still spelled as a `switch`.
  switchRequiresFrontLoadedTests?: boolean;
  // Does the TARGET LANGUAGE spell a `switch` arm that runs on into the next one? Set from the
  // caller's LanguageBackend (`spellsSwitchFallthrough`), not from the compiler target: it is a
  // property of what the emitted source may say, and the only reason the structurer needs it is
  // that a fall-through switch has a SECOND, behaviourally identical recovery. Regime A declines
  // to if-recovery when it is false; Regime B, having no fallback, fails loud. Default true.
  spellSwitchFallthrough?: boolean;
  // Does the TARGET LANGUAGE spell a `break` that leaves a `switch` arm before its end? Set from
  // the caller's LanguageBackend (`spellsSwitchBreak`), for the same reason as the line above. When
  // false, a CLOSED arm gets no region (`structureArm`), so `switchBreakAt` never mints the
  // statement and the arm structures to the CFG's joins, copying the tail its early exit skips into
  // each path. A FALLING arm needs no gate of its own: a language without a mid-arm `break` has no
  // fall-through either (Pascal), and `spellSwitchFallthrough` keeps those out. Default true.
  spellSwitchBreak?: boolean;
  // Which way this compiler hands out frame slots against DECLARATION RANK: `ascending` = the
  // earlier-declared spilled local takes the LOWER `[sp,#k]`. A compiler behavior declared
  // in TargetDescription.compilerBehaviors, carried to the backend on `SFn.slotOrder` and applied
  // by `l3/slotorder.ts` at emit time. ABSENT means the ordering refuses — there is no default
  // direction, because a wrong one reorders declarations for no reason.
  //
  // TWO STATES, NOT THREE. `TargetDescription` spells a third, `'unknown'`, and it earns its place
  // there: it separates a direction that was measured and deliberately not shipped from one nobody
  // ever asked about, which is a fact about the target worth writing down. Nobody reads a
  // STRUCTURER option to learn what was measured, so carrying it here would be a second way to
  // spell "no" on a public option type. The translation happens once, in `structureOptionsFor`
  // (target.ts), which is where the target-to-structurer mapping lives.
  spillSlotOrder?: 'ascending' | 'descending';
  // Each declared callee's parameter types, carried to the backend on `SFn.declaredArgs` (see
  // there). Built by `structureOptionsFor` from the prototype table.
  declaredArgs?: Readonly<Record<string, readonly (string | undefined)[]>>;
  // Each declared callee's return type, carried on `SFn.declaredReturns` the same way.
  declaredReturns?: Readonly<Record<string, string>>;
  // The emitted C is compiled as C++ (`SFn.dialect`).
  dialect?: 'c++';
  // The compiler parses a designated initializer element (`SFn.designators`; the compiler behavior
  // of the same name says which do).
  designatedInitializers?: boolean;
  // The compiler's C refuses C's implicit pointer conversions (`SFn.strictConversions`; the compiler
  // behavior `strictPointerConversions` says which does).
  strictPointerConversions?: boolean;
  // Commutative load pairs re-spell in def (evaluation) order — see the swap in lowerDef. Default
  // true; verified byte-exact on agbcc and IDO. A compiler behavior declared in
  // TargetDescription.compilerBehaviors: the first compiler whose scheduler is shown re-ordering
  // independent loads flips it there, not in a code branch. A per-FUNCTION machine-order fallback
  // candidate is deliberately deferred until a row demands it.
  defOrderLoadPairs?: boolean;
  // Anchor a constant merge copy at its const op's ORIGINAL position instead of at the CFG edge:
  // `movs r9, #0` at entry ahead of a single-armed overwrite emits as a pre-initialization above
  // the `if`, not as its else-arm. A differ-refereed candidate variation (rank.ts `/defsite`), never a
  // default — see the refusal conditions where it is computed.
  anchorConstCopies?: boolean;
  // WIDEN `anchorConstCopies` to a LOOP HEADER's entry constant — `int s = 0;` hoisted above the
  // `if` that guards the loop, rather than written on the edge into it. A second placement
  // decision, so a second structure setting (rank.ts `/defsite/loop-entry`) rather than a widening of
  // the first: on a function carrying both kinds of anchorable const, folding them into one flag
  // would make "anchor the plain ones, leave the loop's at its edge" — a spelling `/defsite`
  // emits today — unreachable. Inert unless `anchorConstCopies` is also on.
  //
  // A VARIATION RATHER THAN AN EXTENSION OF `l3/initfirst.ts`, whose header opens on the same rewrite
  // (`if (0 < n) { v = 0; … }` → `v = 0; if (v < n) { … }`) at a fraction of the price: a
  // respell variation adds candidates only where it fires, while this multiplies every candidate below
  // it. The fork is REACH, and it is a hard one. `initfirst` MOVES A STATEMENT, and an edge copy
  // is not a statement — structuring mints it, choosing between the edge and the const op's own
  // position, and the IR that holds those positions is gone by the time L3 runs. So the shapes
  // where the two coincide are initfirst's for free — except that they never do: its guard
  // re-spelling wants an ELSE-LESS `if` and rewrites the condition to read the hoisted variable
  // (`if (v < n)`), where anchoring leaves the condition alone, so the two emit different sources.
  // Measured, not argued: `/initfirst` rides every spelling rank.ts enumerates, so it is scored on
  // every benchmark row already, and on each row this variation wins its `/initfirst`-only sibling is
  // either not enumerated at all or not byte-identical to the anchored source — the substitution
  // reaches none of them. Take the variation only while rows demand that; the price is in rank.ts.
  anchorLoopEntryConsts?: boolean;
  // HARDWARE fact from TargetDescription.capabilities.endianness, threaded by structureOptionsFor:
  // the bitfield extract recognizer solves an LSB-first equation, so it only runs on little-endian
  // data. The provider already refuses to EMIT bitfield facts for a big-endian ELF; this is the
  // same boundary enforced on core's side, against a hand-built map that never went through it.
  littleEndian?: boolean;
  // COMPILER facts about how a declared scalar is stored (TargetDescription.compilerBehaviors), read
  // by the declaration-shape override of `scalarGlobals` (`storageDisagrees`): the bytes an enum
  // takes, and whether a plain `char` is signed. ABSENT ⇒ unmeasured, and a global declared with
  // that type agrees with no access the override is asked about, so it is spelled through its
  // address.
  enumBytes?: number;
  plainCharSigned?: boolean;
  // Does the compiler extend a `volatile` narrow signed read in a register, never in the load? The
  // `declared` stamp structuring re-derives reads it (TargetDescription.compilerBehaviors'
  // `volatileReadsExtendInRegister`), so it leaves unplaced the read the lift's stamp did.
  volatileReadsExtendInRegister?: boolean;
  // Spell `(x << a) >> b` extracts of a struct global as the map's named bitfield member. On by
  // default; rank.ts enumerates the OFF spelling as the `/no-bitfield` variation, because the named
  // read recompiles at the DECLARATION's access width — where that diverges from the asm's load
  // width the honest shift spelling is the one that matches, and the differ referees. Only the map
  // carries the names, so with no `symbols` this is normalized to false whatever a caller passes.
  spellBitfieldMembers?: boolean;
  // Spell an element-scaled offset through a map-declared POINTER MEMBER as a whole-element
  // subscript of it (`gBg.pMap[i + 157]`) rather than as the byte arithmetic it replaces. On by
  // default; rank.ts enumerates the OFF spelling as the `/no-ptr-elem` variation.
  //
  // IT IS A VARIATION AND NOT A DEFAULT BECAUSE IT IS NOT BYTE-NEUTRAL — the bar the block comment
  // above `spellablePointee` sets for a member spelling. Compiled against agbcc (`-mthumb-interwork -Wimplicit -O2 -fhex-asm
  // -fprologue-bugfix`), `((u16 *)gB.pMap)[i + K]` and `*(u16 *)((i << 1) + (u8 *)gB.pMap + 2K)`
  // are the same address and the same instruction COUNT at K = 0, 1 and 157 — and different
  // objects at all three, differing in which register the `add` targets. Which side matches is
  // per-function knowledge the asm does not carry, so both are emitted and the differ referees.
  // Only the map declares a pointee width, so with no `symbols` this is normalized to false.
  spellPtrMemberElements?: boolean;
  // Recover a multidimensional array global's DECLARED subscripts (`g[r][i]`) from a byte residual
  // carrying a term at the declared ROW stride, rather than spelling the whole residual as the
  // `*(T *)(… + (u32)&g)` cast it replaces. On by default; rank.ts enumerates the OFF spelling as
  // the `/flat-rank` variation.
  //
  // IT IS A VARIATION AND NOT A DEFAULT BECAUSE THE ASM DOES NOT DETERMINE IT, and the evidence that
  // it does not is the same compile the recovery's own premise rests on, read against the spelling
  // the recovery DISPLACES rather than against the flat one it refuses. For `u16 g[4][0x400]`:
  //
  //   agbcc  g[a][b]  lsl #0xb ; lsl #0x1 ; add ; add   |  *(u16 *)((a<<11)+(b<<1)+(u32)&g)
  //                   md5 f58a694f…                     |  md5 051bf506…   DIFFERENT, and the
  //                   difference is WHERE THE POOL LOAD SITS — the shift structure the recovery
  //                   reads is IDENTICAL in both, so the residual is evidence about the row and
  //                   NOT about which of these two spellings wrote it.
  //   kmc / mwcc      the same: separate scales both sides, differing only in scheduling.
  //   IDO             the two are BYTE-IDENTICAL (md5 2b55b493…) — and IDO also distributes the
  //                   FLAT sum into the same separate scales, so on that compiler the recovery's
  //                   own premise is false and the flat spelling reaches it too.
  //
  // WHICH ROW OF THAT TABLE IS PINNED: the agbcc pair, by
  // packages/cli/test/matching/array-rank-variation.test.ts, which compiles both spellings through the
  // klonoa checkout's own template. The other three were measured by hand and nothing re-runs
  // them, so treat them as the record of a measurement rather than as a live check.
  //
  // So both are emitted and the differ referees, exactly as for `/no-ptr-elem`. Only the map
  // declares a rank, so with no `symbols` this is normalized to false.
  spellDeclaredSubscripts?: boolean;
  // Let a read of a named global render at its use across writes that PROVABLY cannot reach it
  // (a store to a different named global), instead of caching it in a local. Off by default;
  // rank.ts enumerates the ON spelling as the `/reread-globals` variation — see analysis.ts
  // AnalyzeOptions for why this is a differ-refereed variation and not a fix.
  rereadGlobals?: boolean;
  // Materialize a load that feeds a `cond_br` join arg, so the naming walk can home the join in
  // it and the identity arm elides to a one-sided in-place `if`. Off by default; rank.ts
  // enumerates the ON spelling as the `/inplace` variation — see analysis.ts AnalyzeOptions.
  materializeJoinFeeds?: boolean;
  // Materialize a pure computed address shared by 2+ memory accesses, and the multi-render loads
  // through it, reproducing the source's pointer-local + scalar-temp spelling. Off by default;
  // rank.ts enumerates the ON spelling as the `/addr-home` variation — see analysis.ts AnalyzeOptions.
  homeSharedAddresses?: boolean;
  // Materialize a pure value with 2+ distinct consumers, at least one of them inside a loop the
  // def sits outside — the register the compiler holds across the iterations. Off by default;
  // rank.ts enumerates the ON spelling as the `/expr-home` variation — see analysis.ts AnalyzeOptions.
  homeLoopExprs?: boolean;
  // Materialize a pure value with 2+ consumers standing on a memory read — the register the asm
  // carried the DERIVED value in, where the read's own home is a register that died at the
  // computation. Off by default; rank.ts enumerates the ON spelling as the `/derived-home` variation —
  // see analysis.ts AnalyzeOptions.
  homeDerivedReads?: boolean;
  // Can this compiler FUSE a float multiply into the add or subtract that reads it, when both are
  // written in one expression? Then every such product is named (analysis.ts), so the spelling
  // compiles to the unfused pair the object holds. A compiler opts in; the target says which
  // (`compilerBehaviors.contractsFloatProducts`).
  contractsFloatProducts?: boolean;
  // How this compiler lays out a function-scope static (`compilerBehaviors.staticLayout`), which
  // decides the definition that puts one where the target has it. Absent ⇒ unmeasured, and a
  // function that defines a static declines.
  staticLayout?: StaticLayout;
  // Materialize a pure value that one join's incoming edges render into the SAME parameter slot
  // from 2+ places — the value the source computed once above the branch and the copy machinery
  // sinks into every arm. Off by default; rank.ts enumerates the ON spelling as the `/merge-home`
  // variation — see analysis.ts AnalyzeOptions.
  homeMergeFeeds?: boolean;
  // Materialize a `zext`/`sext` with 2+ consumers, none of them in its own block — the register the
  // asm narrowed into once and every later block read. Off by default; rank.ts enumerates the ON
  // spelling as the `/escape-home` variation — see analysis.ts AnalyzeOptions.
  homeEscapingExtensions?: boolean;
  // Emit a memory read as a named temp in ITS OWN block when every place it renders sits in a
  // block that block strictly dominates. A compiler behavior (TargetDescription
  // .compilerBehaviors), not a differ-refereed variation: where the compiler has neither a scheduler
  // nor a code hoister, the sunk spelling is one it could not have emitted from this asm, so there
  // is nothing to referee. Absent ⇒ off — the target field carries the evidence a compiler owes,
  // analysis.ts AnalyzeOptions the refusals.
  readsStayWhereWritten?: boolean;
  // Spell unsigned compares unsigned: cast an icmp_u* operand where the rendered operands do not
  // guarantee it, and reconcile a mixed-claimant declaration to u32 when nothing under the name
  // needs signed. ON by default, because it is the only spelling that is value-faithful without a
  // proof: an unsigned compare spelled over two signed-rendering operands compiles to a SIGNED
  // compare, which differs from the machine's wherever an operand's top bit is set. The OFF spelling
  // is still a real source: a signed spelling that byte-matched was PROVED non-negative by the
  // compiler (it emits the unsigned branch from signed compares only then), and emission's provable
  // set is smaller than the compiler's. So rank.ts enumerates it as the `/signed-cmp` variation and
  // publishes it only on a byte-exact score (`Candidate.matchOnly`).
  unsignedCompareSpelling?: boolean;
  // Merge two variables that a merge copy would join, when the values under them never interfere
  // (structure/namecoalesce.ts). Off by default; rank.ts enumerates the ON spelling as the
  // `/merge-names` variation. Which variables the compiler's own coalescer shared is not derivable from
  // the naming, and removing a copy is worth less than it looks — the compiler coalesces most of
  // them itself. What moves the score is which values share a register, and that splits per
  // function.
  coalesceMergeNames?: boolean;
  // Give a merge whose carrier is a FUNCTION PARAMETER its own local, instead of assigning back
  // into the parameter's name. Off by default; rank.ts enumerates the ON spelling as the
  // `/fresh-merge` variation, and `FRESH_MERGE_GATES` holds the admission and the argument for it.
  //
  // NOT `materializeJoinFeeds` widened to parameters. That variation reaches its shape by giving the
  // join's feed a NAME to adopt, and materialization is keyed on the defining `Op` — a parameter
  // has none, so there is nothing to key.
  freshParamMerge?: boolean;
  // Give a DIVERGENT `if` — one whose arms reach no common block before EXIT — the follow its
  // non-returning paths share: `followOverReturns` below. Absent, such an `if` keeps its arms
  // divergent and a region both of them reach is emitted in each.
  followEarlyReturns?: boolean;
  // How an unresolvable VALUE degrades (a live `opaque`, an unlowered transient op, a dropped def):
  //   "strict"   (default) — the `"?"` sentinel, tripping assertResolved at the boundary (loud in
  //              the PROCESS);
  //   "annotate" — a `marker` node that spells as the undefined ASMLIFT_ERROR(...) symbol (loud in
  //              the ARTIFACT: the function emits complete, but cannot compile un-acknowledged).
  onGap?: 'strict' | 'annotate';
  /** NAME-keyed project symbol facts (symbols.ts `symbolsByName`) — drives the byte-sensitive
   *  declaration-shape spellings: `shape:'array'` forces the aggregate classification and the
   *  bare `gSym[i]` form; `shape:'struct'`+layout spells interiors as `gSym.field`. Absent (or
   *  a symbol not in the map) ⇒ today's usage-inferred behavior, byte-identical. */
  symbols?: Map<string, SymbolInfo>;
  /** ARRAY SHAPES DERIVED FROM THE INPUT ASSEMBLY (raise/globalshape.ts) for globals the project
   *  map does not describe — same `SymbolInfo` shape, same readers, LOWER precedence: `symbols`
   *  wins every name it knows, because a project declaration knows more than an inference off one
   *  function's strides.
   *
   *  A SEPARATE FIELD rather than a pre-merged map, and the separation is load-bearing twice.
   *  `spellBitfieldMembers` is normalized against `symbols` alone, so a derived shape can never
   *  switch the named-bitfield spelling on for a map-less row (which would silently delete the
   *  `/no-bitfield` variation's decline — see bitfield-members.test.ts). And it keeps the derivation
   *  ATTRIBUTABLE: everything the map does stays keyed on the map. */
  inferredSymbols?: Map<string, SymbolInfo>;
  /** THE ORDER HALF of the same derivation (raise/globalshape.ts `orderLicensedGlobals`): the
   *  globals whose address the assembly materialized BEFORE it scaled the index. Not a shape and
   *  not a declaration — nothing is spelled from it here — it is stamped onto every `index` node it
   *  reaches (`Expr.baseOrdered`, l3/ast.ts) for the L3 pass that decides whether a base gets a
   *  HOME.
   *
   *  A SUPERSET of `inferredSymbols`' names, and its own field for exactly that reason: a struct
   *  element is licensed here and has no shape there. */
  orderLicensedGlobals?: ReadonlySet<string>;
  /** The globals the project map declares POINTERS, handed to a structuring that runs without the
   *  map (rank.ts `/raw-globals`). Spelling a global raw does not make it an integer: C still scales
   *  arithmetic on its value by the declared pointee, so the byte-arithmetic rules read this where
   *  they would read the map's `shape:'pointer'`. The operand-order rules do not read it: no element
   *  or field spelling folds from a name with no pointee. */
  pointerGlobals?: ReadonlySet<string>;
  /** What the declaration context states about its globals (proto-context.ts `globalsFromContext`):
   *  which are structs, unions or arrays, and which are volatile, read by the stamp this structuring
   *  re-derives. Read with the map setting and without it: a context declaration is what every
   *  candidate compiles against, whichever names it spells. */
  contextGlobals?: ContextGlobals;
}

/** The named global an `index` node's base denotes DIRECTLY, or undefined: the bare `&gSym` an
 *  ordinary element access indexes, and the `(struct S *)&gSym` an array-of-struct element indexes
 *  — the reinterpret cast is the base's spelling, not a different base.
 *
 *  Deliberately not a search. A symbol buried inside a base's arithmetic is a base this licence has
 *  nothing to say about — the order fact is about the address the pool word materialized, and what
 *  a home would bind there is the sum, not the symbol — so it goes unstamped, which costs a
 *  candidate and never a wrong one. The same two shapes are what `l3/basecse.ts` can hoist. */
function indexBaseSymbol(e: Expr): string | undefined {
  if (e.k === 'addr') {
    return e.name;
  }
  return e.k === 'cast' && e.e.k === 'addr' ? e.e.name : undefined;
}

/** Stamp `baseOrdered` on every `index` whose base names an order-licensed global — the ONE place
 *  the L1 order fact enters the L3 tree.
 *
 *  A post-pass over the finished body rather than a `...fromOrder` at each construction site: the
 *  index node is built across `ptrMemberElement`, `memAccess` and `arrayAccess` at more sites than
 *  `operandOff` itself reaches, the licence is per SYMBOL rather than per site, and a walk is
 *  exhaustive by construction where a new site would silently carry no evidence. */
function stampOrderedBases(body: Stmt[], licensed: ReadonlySet<string> | undefined): Stmt[] {
  if (licensed === undefined || licensed.size === 0) {
    return body;
  }
  const stamp = (e: Expr): Expr => {
    const mapped = mapExprChildren(e, stamp);
    if (mapped.k !== 'index') {
      return mapped;
    }
    const sym = indexBaseSymbol(mapped.base);
    return sym !== undefined && licensed.has(sym) ? { ...mapped, baseOrdered: true as const } : mapped;
  };
  return body.map((s) => mapStmtExprs(s, stamp));
}

/** Test-only seams. SEPARATE from `StructureOptions` on purpose: `structureOptionsFor` builds that
 *  one by spreading a target's `compilerBehaviors`, whose fields map 1:1 onto it, so a hook living
 *  there would be settable from a TargetDescription. */
export interface StructureHooks {
  /** `coalesceMergeNames`'s admission rules, so a test can run the pass with one gate DROPPED —
   *  the ablation as a value rather than as a flag compiled into the shipped path. */
  nameCoalesceGates?: readonly Gate<NameMerge>[];
  /** `freshParamMerge`'s admission rules, ablatable the same way. */
  freshMergeGates?: readonly Gate<FreshMergeCarrier>[];
  /** `canTakeName`'s admission rules — which name a block parameter may be spelled with. Every
   *  entry is sound, so this exists for the differential test that drops one and watches the
   *  emitted program change, never for a shipped ablation. */
  carrierNameGates?: readonly Gate<CarrierName>[];
  /** `enclosingCarrierName`'s admission rules (`ENCLOSING_CARRIER_GATES`), ablatable the same way —
   *  and, wrapped in `tallying`, the census of which rule refuses a nest. */
  enclosingCarrierGates?: readonly Gate<EnclosingCarrier>[];
  /** `sinkablePreUpdateSlots`'s per-slot rules (`PREUPDATE_SINK_GATES`), ablatable the same way. */
  preUpdateSinkGates?: readonly Gate<SinkCandidate>[];
  /** `earlyReturnArm`'s `exitTail` rules (`EXIT_TAIL_GATES`), ablatable the same way. */
  exitTailGates?: readonly Gate<ExitTailCandidate>[];
  /** `earlyReturnArm`'s `bypassTail` rules (`BYPASS_TAIL_GATES`), ablatable the same way. */
  bypassTailGates?: readonly Gate<BypassTailCandidate>[];
  /** `foreverShape`'s two-level exit rules (`TWO_LEVEL_EXIT_GATES`), ablatable the same way. */
  twoLevelExitGates?: readonly Gate<TwoLevelCandidate>[];
  /** `outwardExitOf`'s rules (`OUTWARD_EXIT_GATES`), ablatable the same way. */
  outwardExitGates?: readonly Gate<OutwardExitCandidate>[];
  /** `codeBreakArm`'s rules for a shared tail holding a cycle (`BREAK_TAIL_GATES`), ablatable the
   *  same way. */
  breakTailGates?: readonly Gate<BreakTailCycle>[];
  /** `emitForever`'s two-level exit rule (`TWO_LEVEL_REGION_GATES`), ablatable the same way. */
  twoLevelRegionGates?: readonly Gate<TwoLevelRegion>[];
  /** the two-level exit's `break` rule (`TWO_LEVEL_BREAK_GATES`), ablatable the same way. */
  twoLevelBreakGates?: readonly Gate<TwoLevelBreak>[];
  /** `forPlanAt`'s rules (`FOR_PLAN_GATES`, `FOR_PLAN_IV_GATES`), ablatable the
   *  same way and, wrapped in `tallying`, the census of which rule refuses a loop's `for`. */
  forPlanGates?: readonly Gate<ForPlanCandidate>[];
  forPlanIvGates?: readonly Gate<ForPlanIv>[];
  /** Every branch-sense site this structuring reached, in emission order: the block index
   *  `StructureOptions.branchSenseFlipSites` names, whether the site is JOINED or divergent, and
   *  which sense it actually emitted. The enumeration domain — a site only exists once structuring
   *  has decided both arms are real, so it cannot be computed ahead of the pass. */
  onBranchSenseSite?: (site: { block: number; ordinal: number; joined: boolean; negated: boolean }) => void;
  /** Every branch `followOverReturns` gave a follow: the branch's block and the follow's. Both
   *  callers fire it — a divergent `if` under `followEarlyReturns`, EVERY jump table whose arms all
   *  return, unconditionally, and a jump table whose default-anchored RETRY is adopted (some arms
   *  return, the rest reach the code after it) — so the sites it reports are not the enumeration
   *  domain of the shared-tail twins (that domain is `hasDivergentSharedRet`, which asks for a
   *  `cond_br`). */
  onEarlyReturnFollow?: (site: { block: number; follow: number }) => void;
  /** Fired each time a jump table's cross-jumped sibling is read with an entrant left FALLING into
   *  it (`copySharedFallTargets`' `onFallerKept`) — the one place `copyEveryTailEntrant` changes
   *  what the structurer reads. A structuring with that option off that never fires it builds the
   *  same tree as the same options with it on, so rank.ts skips `/tail-copies` on its sibling
   *  rather than structure a tree the dedup would discard. Like `onBranchSenseSite`, the domain
   *  only exists once structuring has picked the switch's merge and walked its arms, so no
   *  question of the raised fn answers it ahead of the pass: a block two arms reach is not a
   *  sibling where it is the merge, and two entrants can reach their sibling through one shared
   *  cross-jumped block. Not fired by `assertDefaultAccepts`' structuring, which is not the
   *  setting being observed. */
  onTailFallerKept?: () => void;
  /** Fired each time the copies write a CASE arm's body back into an entrant
   *  (`copySharedFallTargets`' `onCopied`, a sibling that is not the `default:` arm) — the one
   *  place `jumpToSharedCases` changes what the structurer reads. A structuring with that option off
   *  that never fires it builds the same tree as the same options with it on, so rank.ts skips
   *  `/case-goto` on its sibling. Not fired by `assertDefaultAccepts`' structuring. */
  onCaseCopied?: () => void;
  /** Fired each time a `while (1)` loop no run asked for (`ForRanking`) passes every check of
   *  `forPlanAt` — a single pure latch, a guard or plain entry, a test and update read only from the
   *  latch, the header's params and values from outside the loop, one update copy, and the guard
   *  (or the folded first test) read on the entry values — the one place `spellCountedLoopsFor` changes what the structurer
   *  reads. A structuring with that option off that never fires it builds the same tree as the same
   *  options with it on, so rank.ts skips `/for-continue` on its sibling. Not fired by
   *  `assertDefaultAccepts`' structuring. */
  onForOffered?: () => void;
}

/** A CANDIDATE SPELLING MUST NEVER UNLOCK A FUNCTION THE PRIMARY DECLINES. `varName` is not only
 *  how values are spelled — the loop emitters' hazard predicates read it, and several ask "does
 *  this edge copy survive identity elision", which merging two names quietly answers `no`. A pass
 *  that made a hazard invisible would trade a loud decline for a silent wrong answer, so the
 *  structuring with no variation on runs first and its refusal stands. That is the whole invariant, rather
 *  than a list of individually patched guards, and it costs one extra structuring — nothing next to
 *  the compile the candidate exists to feed.
 *
 *  It rests on `structure()` not mutating `fn`, which `structure-purity.test.ts` pins.
 *
 *  SCOPE: refusals thrown by `structure()` itself. A decline can also come from `structureChecked`'s
 *  boundary contracts, which run OUTSIDE it — `rank.ts` closes that half, where the contracts are.
 *
 *  With a `memo`, a reset already structured for this fn is answered from the memo. */
function assertDefaultAccepts(
  fn: Fn,
  opts: StructureOptions,
  hooks: StructureHooks,
  memo: DefaultAcceptsMemo | undefined,
): void {
  const reset: StructureOptions = {
    ...opts,
    coalesceMergeNames: false,
    freshParamMerge: false,
    materializeJoinFeeds: false,
    homeSharedAddresses: false,
    homeLoopExprs: false,
    homeDerivedReads: false,
    homeMergeFeeds: false,
    homeEscapingExtensions: false,
    anchorConstCopies: false,
    anchorLoopEntryConsts: false,
    followEarlyReturns: false,
    copyEveryTailEntrant: false,
    jumpToSharedCases: false,
    spellCountedLoopsFor: false,
  };
  if (memo === undefined) {
    structure(fn, reset, hooks);
  } else {
    memo.check(fn, hooks, reset, () => structure(fn, reset, hooks));
  }
}

/** A {@link DefaultAcceptsMemo} asked a question it cannot answer. */
export class DefaultAcceptsMemoMisuse extends Error {
  constructor(message: string) {
    super(`DefaultAcceptsMemo: ${message}`);
    this.name = 'DefaultAcceptsMemoMisuse';
  }
}

/** Every block, block parameter, op, opcode, operand, result, successor and edge argument of `fn`,
 *  in order and by identity, each list after its length. A pass that rewrites the graph in place
 *  changes it; attributes and side tables are not in it. */
function graphShape(fn: Fn): unknown[] {
  const shape: unknown[] = [fn.blocks.length];
  for (const b of fn.blocks) {
    shape.push(b, b.params.length, ...b.params, b.ops.length);
    for (const op of b.ops) {
      shape.push(op, op.opcode, op.operands.length, ...op.operands, op.results.length, ...op.results);
      shape.push(op.successors.length);
      for (const s of op.successors) {
        shape.push(s.block, s.args.length, ...s.args);
      }
    }
  }
  return shape;
}

/** A set or array of at most this many primitives is keyed by its members. Keying costs a pass over
 *  the members on every structuring, and the maps and sets a project hands every function (`symbols`,
 *  `pointerGlobals`) are as large as the project, so a bigger one is keyed by identity. */
const MEMO_CONTENT_KEY_LIMIT = 64;

/** What `assertDefaultAccepts` learned about ONE fn: for each reset it structured, whether
 *  `structure()` accepted it or the error it threw. Settings that differ only in the flags the
 *  guard resets share one reset, so an enumeration that structures a fn under many settings asks
 *  the same question of it many times.
 *
 *  VALID WHILE THE FN AND THE OPTIONS' CONTAINERS ARE UNCHANGED. A fn rewritten in place
 *  (`sinkStoreTails`) needs a new memo, and a `Map`, an object, or a set or array over
 *  `MEMO_CONTENT_KEY_LIMIT` members is keyed by identity, so one mutated between two calls would
 *  share a key with its old contents. The `declared` stamps are not a change: `structure()`
 *  re-derives them from the options' map before it reaches the guard, so the reset run finds them as
 *  the first run of the same key did.
 *
 *  Asked about another fn, or about its own fn once a block, op or value of it was added, removed,
 *  replaced or reordered (`graphShape`), it throws {@link DefaultAcceptsMemoMisuse} rather than
 *  answer. That is a wiring defect, not a decline, so `rank.ts` lets it end the enumeration.
 *
 *  Only a call with no hooks is answered: a hook can change the outcome, or must observe the run.
 *  An option holding a function or a symbol has no key, and its reset always runs. */
export class DefaultAcceptsMemo {
  readonly #outcomes = new Map<string, { error: unknown } | 'accepted'>();
  readonly #ids = new WeakMap<object, number>();
  readonly #shape: readonly unknown[];
  #nextId = 0;

  constructor(readonly fn: Fn) {
    this.#shape = graphShape(fn);
  }

  /** Returns or throws what `run` did for this reset, running it only when the memo has no
   *  outcome for it yet. */
  check(fn: Fn, hooks: StructureHooks, reset: StructureOptions, run: () => void): void {
    if (fn !== this.fn) {
      throw new DefaultAcceptsMemoMisuse('asked about a fn it was not made for');
    }
    const shape = graphShape(fn);
    if (shape.length !== this.#shape.length || shape.some((x, i) => !Object.is(x, this.#shape[i]))) {
      throw new DefaultAcceptsMemoMisuse(`asked about ${fn.name} after its graph was rewritten`);
    }
    const key = Object.values(hooks).every((h) => h === undefined) ? this.#keyOf(reset) : undefined;
    if (key === undefined) {
      run();
      return;
    }
    const known = this.#outcomes.get(key);
    if (known === 'accepted') {
      return;
    }
    if (known !== undefined) {
      throw known.error;
    }
    try {
      run();
    } catch (error) {
      this.#outcomes.set(key, { error });
      throw error;
    }
    this.#outcomes.set(key, 'accepted');
  }

  /** Every option that is set, by name and value; `undefined` when one has no key. */
  #keyOf(opts: StructureOptions): string | undefined {
    const parts: string[] = [];
    for (const name of Object.keys(opts).sort()) {
      const value: unknown = (opts as Record<string, unknown>)[name];
      if (value === undefined) {
        continue;
      }
      const part = this.#valueKey(value);
      if (part === undefined) {
        return undefined;
      }
      parts.push(`${name}=${part}`);
    }
    return parts.join(';');
  }

  /** A prefix-free spelling of one value, so two option sets share a key only when every value
   *  agrees. */
  #valueKey(value: unknown): string | undefined {
    switch (typeof value) {
      case 'undefined':
        return 'u';
      case 'boolean':
        return value ? 't' : 'f';
      case 'number':
        return Object.is(value, -0) ? 'n-0' : `n${value}`;
      case 'bigint':
        return `b${value}`;
      case 'string':
        return JSON.stringify(value);
      case 'function':
      case 'symbol':
        return undefined;
    }
    if (value === null) {
      return 'null';
    }
    const members = value instanceof Set ? [...value] : Array.isArray(value) ? value : undefined;
    if (
      members !== undefined &&
      members.length <= MEMO_CONTENT_KEY_LIMIT &&
      members.every((m) => m === null || typeof m !== 'object')
    ) {
      const keys = members.map((m) => this.#valueKey(m));
      return keys.every((k) => k !== undefined) ? `${value instanceof Set ? 'S' : 'A'}[${keys.join(',')}]` : undefined;
    }
    const container = value as object;
    let id = this.#ids.get(container);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(container, id);
    }
    return `#${id}`;
  }
}

/** What {@link earlyReturnArm} reads beyond its arguments: block dominance and forward
 *  reachability, both of them whole-function facts computed once per `structure()`. */
interface EarlyReturnArmDeps {
  dom: Map<Block, Set<Block>>;
  reachFrom: (b: Block) => Set<Block>;
  preds: ReadonlyMap<Block, Block[]>;
}

function isRet(blk: Block): boolean {
  return blk.ops[blk.ops.length - 1]?.opcode === 'ret';
}
/** The `ret`s reachable from EVERY successor of `b` — the region `followOverReturns` keeps — or,
 *  given an `anchor`, from every successor that shares a `ret` with the anchor. Empty when there
 *  is none, and when `b` does not branch at all. `reachFrom` is forward reachability, the start
 *  block excluded.
 *
 *  THE QUESTION IS ABOUT A BRANCH, not about an `if`: "the arms all return, so post-dominance gives
 *  this block no join — where does the construct end?" is asked by a jump table exactly as by a
 *  two-way branch, and the answer is derived the same way. The `if`-shaped reading belongs to the
 *  CALLER that wants it (`hasDivergentSharedRet`), not here.
 *
 *  THE ANCHOR names a successor taken to reach the end the question is about, and leaves out
 *  every successor that shares no `ret` with it (`leftOutOf`). The `switch_br` caller anchors on
 *  the dispatch's DEFAULT edge, whose target is the `default:` arm or the code after the switch: a
 *  `case` that `return`s on its own, or falls into one that does, then no longer empties the
 *  intersection for the arms that `break`. Leaving those successors out is sound for the follow the
 *  caller derives from the answer: the answer is a subset of the anchor's `ret`s, so a successor
 *  left out reaches none of them, hence no block that reaches one — in particular not the follow —
 *  and it is structured to its own `return`. It is a candidate and not evidence that the source
 *  ended the construct there: a `default:` that `return`s on its own is an anchor too, and the
 *  caller states what it reads to tell the two apart. The `if` caller never anchors.
 *
 *  THE DEDUP IS DEFENSIVE AND NO CALLER CAN REACH IT TODAY. It is what makes "two successors that
 *  are the same block" answer `[]` rather than "a branch with a shared `ret`". Both callers ask
 *  only when `ipdom.get(b)` is null, and a branch whose successors are all ONE block has that block
 *  as its post-dominator, so they never ask it of that shape. It stays because the answer belongs
 *  to this function rather than to its callers' guards, and dropping it is a no-op on the corpus:
 *  the reader over every row of the committed artifact (`decompile` per row, no compiling) emits
 *  byte-identical source with and without it. */
function sharedRetsOf(b: Block, reachFrom: (x: Block) => ReadonlySet<Block>, anchor: Block | null = null): Block[] {
  const left = anchor === null ? [] : leftOutOf(b, reachFrom, anchor);
  const succs = [...new Set(successorsOf(b))].filter((x) => !left.includes(x));
  if (succs.length < 2) {
    return [];
  }
  return succs
    .map((x) => retsFrom(x, reachFrom))
    .reduce((shared, rets) => {
      const here = new Set(rets);
      return shared.filter((r) => here.has(r));
    });
}
function retsFrom(x: Block, reachFrom: (x: Block) => ReadonlySet<Block>): Block[] {
  return [x, ...reachFrom(x)].filter(isRet);
}
/** The successors of `b` that share no `ret` with `anchor` — the ones `sharedRetsOf` leaves out. */
function leftOutOf(b: Block, reachFrom: (x: Block) => ReadonlySet<Block>, anchor: Block): Block[] {
  const anchored = new Set(retsFrom(anchor, reachFrom));
  return [...new Set(successorsOf(b))].filter((x) => !retsFrom(x, reachFrom).some((r) => anchored.has(r)));
}
/** Is there an `if` whose arms reach no common block before EXIT but share a `ret` — the only shape
 *  `followEarlyReturns` changes? The enumeration gate of both shared-tail twins (rank.ts), asked of
 *  the fn as raised and again of the sunk fn; a superset, since it asks `sharedRetsOf` and none of
 *  the follow's three later refusals. An `if`, specifically: see the restriction at the `some`. */
export function hasDivergentSharedRet(fn: Fn): boolean {
  const ipdom = functionPostDominators(fn);
  const reach = new Map<Block, Set<Block>>();
  const reachFrom = (b: Block): Set<Block> => {
    let out = reach.get(b);
    if (out === undefined) {
      out = new Set<Block>();
      for (const stack = successorsOf(b); stack.length;) {
        const x = stack.pop()!;
        if (!out.has(x)) {
          out.add(x);
          stack.push(...successorsOf(x));
        }
      }
      reach.set(b, out);
    }
    return out;
  };
  // `cond_br` HERE, not in `sharedRetsOf`: this is the enumeration gate of the shared-tail twins,
  // and those twins are `if`-shaped variations. A jump table with a shared `ret` has the same
  // no-join shape and no such twin, so asking for it would spend fan on a duplicate candidate.
  return fn.blocks.some(
    (b) =>
      b.ops[b.ops.length - 1]?.opcode === 'cond_br' && ipdom.get(b) === null && sharedRetsOf(b, reachFrom).length > 0,
  );
}
/** does a path from `from` reach `to` without passing through `avoid`? */
function reachesAvoiding(from: Block, to: Block, avoid: Block): boolean {
  const seen = new Set<Block>([avoid]);
  const stack = successorsOf(from);
  while (stack.length) {
    const x = stack.pop()!;
    if (x === to) {
      return true;
    }
    if (!seen.has(x)) {
      seen.add(x);
      stack.push(...successorsOf(x));
    }
  }
  return false;
}
/** The arm `from -> to` breaks to `exit` after running code: the region `to` heads re-enters no
 *  `body` block and leaves only for `exit` or by a `ret` of its own. Returns that region, or null.
 *  The region is written inside the loop, ahead of the `break` — a `ret` among it as the `return` it
 *  is: `if (t[i] == 7) { if (k) return; gHit = 1; break; }`.
 *
 *  UNSHARED (the default, and the header-exit caller), `to` is entered by that edge alone and the
 *  region admits no edge from outside itself, so each region block is written once and the region
 *  owns its `ret`s: the `return` is written where the asm holds its one copy.
 *
 *  A TAIL SEVERAL BREAKS SHARE, with `shared` (what `exitArmOf` passes for every in-body code arm):
 *  `if (a) f |= 1; else if (b) f |= 2; else continue; gHit = i; break;` compiles to two arms that
 *  each run their own code and jump to one `gHit = i` block on the way out (agbcc and gcc2.7.2
 *  cross-jump arms written with a tail each into that same shape, jump.c). The region is then
 *  admitted when the arm's head is entered only from the body (a body block, or a block every path
 *  into which comes from the body without passing `exit`: the other arm's own blocks, whose exit
 *  edge the classifier must admit as an arm of its own, or the loop declines), every other block an
 *  edge from outside enters is one the loop's own exit path does not run (`offExitPath`), and the
 *  region holds no cycle, save at `while (1)`'s last rung (`BREAK_TAIL_GATES`). Each arm writes the
 *  shared blocks again ahead of its own `break`, a shared `ret` as one `return` per arm, and a path
 *  from outside the loop (an `else` before it) structures its own copy where the block sits. Those
 *  paths are exclusive — a path that left the body by an arm reaches a region block again only
 *  through `exit`, and the exit does not reach it — so every path runs the tail once, as the asm
 *  does, whatever the tail does; where the compiler cross-jumps, the copies are the same code
 *  (gcc2.7.2kmc byte-identical, agbcc up to register allocation).
 *
 *  THE COST where it does not: ido keeps one tail, and only the source's single copy at the arms'
 *  join recompiles to it. `synthetic:brmerge:ido7.1`'s row source is byte-identical to its target;
 *  the per-arm spelling compiles to 52 instructions against 50 (an extra `lui` and `sb`), so that
 *  row cannot MATCH this way. The single copy needs a `continue` that runs the latch's update — a
 *  `for` whose `inc` is that update, or a `do`/`while` whose test the `continue` reaches — and
 *  structure writes `continue` only to a `while (1)` header, while the L3 `for` respell refuses a
 *  body holding one (l3/ast.ts, the `for` node). */
function codeBreakArm(
  preds: ReadonlyMap<Block, Block[]>,
  dom: ReadonlyMap<Block, ReadonlySet<Block>>,
  from: Block,
  to: Block,
  body: ReadonlySet<Block>,
  exit: Block,
  shared = false,
  cycles: { cycleRung: boolean; gates: readonly Gate<BreakTailCycle>[] } = NO_SHARED_CYCLES,
): Set<Block> | null {
  if (to === exit || body.has(to)) {
    return null;
  }
  const region = new Set<Block>();
  let leaves = false;
  for (const stack = [to]; stack.length > 0;) {
    const x = stack.pop()!;
    if (x === exit) {
      leaves = true;
      continue;
    }
    if (region.has(x)) {
      continue;
    }
    const t = x.ops[x.ops.length - 1];
    if (body.has(x) || (t.opcode !== 'br' && t.opcode !== 'cond_br' && t.opcode !== 'ret')) {
      return null; // re-enters the loop, or dispatches
    }
    region.add(x);
    stack.push(...successorsOf(x));
  }
  // Shared: the arm's head is entered from another arm when every path into the entering block
  // comes from the body without passing `exit` — the body block itself, or the other arm's own
  // blocks. Never from outside the loop: an edge straight from the body into a block others enter
  // too is a `break` to it, which `while (1)` writes once, after the loop.
  const armOfBody = onlyFromBody(preds, body, exit);
  // Shared, past the head: a block may be entered from anywhere — another arm, or outside the loop —
  // when the loop's own exit path does not run it (`offExitPathOf`). agbcc cross-jumps a `break`
  // that assigns a `u8` with an `else` before the loop that assigns the same `u8` into one `lsr`
  // truncation block, and a `gLast = id;` both write into one `strb` (jump.c); gcc2.7.2kmc keeps one
  // `jal note` the arm's `beql` and the `else` both enter. The per-arm copy is the source's spelling.
  const offExitPath = offExitPathOf(exit, dom);
  let entersShared = false;
  const entered = (x: Block) =>
    (preds.get(x) ?? []).every(
      (p) =>
        region.has(p) ||
        (x === to && p === from) ||
        (shared && (x === to ? armOfBody(p) : offExitPath(x)) && (entersShared = true)),
    );
  if (!leaves || ![...region].every(entered)) {
    return null;
  }
  // A region another arm enters is written once per arm. One only its own edge enters is written
  // once wherever it sits. An acyclic one is written by a walk that meets each block once.
  if (!entersShared || [...region].every((x) => acyclicThrough(x, region))) {
    return region;
  }
  // A SHARED TAIL HOLDING A LOOP: agbcc's `case MAGNET: if (..) continue; ... for (j = 0; j < n; j++)
  // if (t[j] == id) goto found; ... break;` cross-jumps two cases' `break`s into one search loop.
  // Each arm writes its own copy of that loop ahead of its `break`, at `while (1)`'s last rung only
  // (A LOOP IN THE TAIL, at `earlyReturnArm`).
  return firstRejection(cycles.gates, { cycleRung: cycles.cycleRung }) === null ? region : null;
}
const NO_SHARED_CYCLES = { cycleRung: false, gates: BREAK_TAIL_GATES } as const;
/** The duplication policy's admission (written at `earlyReturnArm`): is a block one the loop's own
 *  exit path does not run? Forward only (`reachForward`): round an enclosing loop's back-edge the exit
 *  reaches the inner loop again, which is the next iteration running the block again in the asm too,
 *  not the fall-through path running it after the loop. Computed on first use. */
function offExitPathOf(exit: Block, dom: ReadonlyMap<Block, ReadonlySet<Block>>): (b: Block) => boolean {
  let fromExit: Set<Block> | undefined;
  return (b) => !(fromExit ??= reachForward(exit, dom)).has(b);
}
/** Does every path into a block come from `body` without passing `exit`? True of a body block, and
 *  of a block outside whose every predecessor is one — a loop exit arm's own blocks, and a tail only
 *  those arms enter. Memoised per call; a cycle back to a block is no path from the body. */
function onlyFromBody(
  preds: ReadonlyMap<Block, Block[]>,
  body: ReadonlySet<Block>,
  exit: Block,
): (b: Block) => boolean {
  const fromBody = new Map<Block, boolean>();
  const armOfBody = (p: Block): boolean => {
    if (body.has(p)) {
      return true;
    }
    const known = fromBody.get(p);
    if (known !== undefined) {
      return known;
    }
    fromBody.set(p, false);
    const into = preds.get(p) ?? [];
    const ok = p !== exit && into.length > 0 && into.every(armOfBody);
    fromBody.set(p, ok);
    return ok;
  };
  return armOfBody;
}
/** Does no path inside `region` lead from `x` back to `x`? */
function acyclicThrough(x: Block, region: ReadonlySet<Block>): boolean {
  const seen = new Set<Block>();
  for (const stack = successorsOf(x); stack.length > 0;) {
    const y = stack.pop()!;
    if (y === x) {
      return false;
    }
    if (region.has(y) && !seen.has(y)) {
      seen.add(y);
      stack.push(...successorsOf(y));
    }
  }
  return true;
}
/** One block the `exitTail` count (at `earlyReturnArm`) weighs for an arm: a return tail the loop's
 *  own exit path also runs, which the arm would write a copy of. Every field past the first two is a
 *  getter, so its walk runs only when the rules ahead of it admit. */
export interface ExitTailCandidate {
  /** the arm's edge leaves from a latch, the loop's own way out */
  readonly armLeavesByLatch: boolean;
  /** the reading of last resort asked for the copy (`ArmCopies.onExitPath`): a path from before
   *  the loop that skips the exit may enter the tail too (A PATH THAT BYPASSES THE LOOP) */
  readonly lastResort: boolean;
  /** asked by `while (1)`'s last rung (`ArmCopies.cycles`): the tail may hold a loop */
  readonly cycleRung: boolean;
  /** a latch, or a path from before the loop (the zero-trip guard), enters the exit */
  readonly exitIsTestOut: boolean;
  /** the exit path runs a block of its own before the tail: the arm never reaches `exit` */
  readonly exitRunsOwnBlock: boolean;
  /** every predecessor of the block is an arm's block or on the exit's forward path */
  readonly enteredByArmsOrExitPath: boolean;
  /** neither the block nor anything past it holds a cycle */
  readonly acyclicPast: boolean;
}

/** When an early-`return` arm may write a copy of a tail the loop's exit path also runs. The rules
 *  and the argument for each are at `earlyReturnArm` ("THE EXIT PATH RUNS IT TOO"); none is sound,
 *  since every copy runs on a path exclusive of the others. Not in the table: the count's scope — a
 *  copy the caller asked for (`copyExitTail`), and a block with an effect the exit path runs — which
 *  is the walk's own condition. */
export const EXIT_TAIL_GATES: readonly Gate<ExitTailCandidate>[] = [
  {
    id: 'arm-leaves-by-latch',
    why: 'an arm leaving by a latch is the way the loop itself leaves, and a copy past it moves post-loop code into the body',
    sound: false,
    guardedBy: 'loop-break-exit.test.ts: an arm another path also enters is not a `break` arm',
    rejects: (c) => c.armLeavesByLatch,
  },
  {
    id: 'exit-not-test-out',
    why: 'an exit only a mid-body branch enters is another arm, not where the loop test leaves to',
    sound: false,
    guardedBy: 'loop-break-exit.test.ts: a shared tail the exit also reaches is refused',
    rejects: (c) => !c.exitIsTestOut,
  },
  {
    id: 'exit-runs-nothing-of-its-own',
    why: 'where the exit path runs no code of its own before the tail, a break reaches the tail and no copy is needed',
    sound: false,
    guardedBy:
      'loop-exit-return-tail.test.ts: an arm that reaches the exit itself is a `break`, and copies no tail past it',
    rejects: (c) => !c.exitRunsOwnBlock,
  },
  {
    id: 'entry-bypasses-exit',
    why: 'a path from before the loop that skips the exit lands on the epilogue the asm holds once after the loop',
    sound: false,
    guardedBy:
      'loop-exit-return-tail.test.ts: a tail also entered straight from before the loop, past the exit, stays refused',
    rejects: (c) => !c.lastResort && !c.enteredByArmsOrExitPath,
  },
  {
    id: 'tail-holds-cycle',
    why: 'a tail holding a loop would be written once per arm where the asm holds it once: the reading of last resort, after every reading that copies none',
    sound: false,
    guardedBy: 'loop-exit-return-tail.test.ts: a tail holding a loop of its own stays refused',
    rejects: (c) => !c.cycleRung && !c.acyclicPast,
  },
];

/** One block the `bypassTail` count (at `earlyReturnArm`) weighs for an arm: a return
 *  tail the loop's own exit path does not run, which a path from outside the loop also enters. */
export interface BypassTailCandidate {
  /** asked by `while (1)`'s last rung (`ArmCopies.cycles`): the tail may hold a loop */
  readonly cycleRung: boolean;
  /** neither the block nor anything past it holds a cycle */
  readonly acyclicPast: boolean;
}

/** When an early-`return` arm may write a copy of a return tail another path from outside the loop
 *  also enters, off the loop's exit path. The argument is at `earlyReturnArm` ("A PATH THAT
 *  BYPASSES THE LOOP"); like `EXIT_TAIL_GATES`, no rule is sound, since every copy runs on a path
 *  exclusive of the others. Not in the table: the count's scope — the reading asked for it
 *  (`ArmCopies.offExitPath`), the block has an effect, the loop's own exit path does not run it,
 *  and a path from outside the loop enters it — which is the walk's own condition. */
export const BYPASS_TAIL_GATES: readonly Gate<BypassTailCandidate>[] = [
  {
    id: 'bypass-tail-holds-cycle',
    why: 'a tail holding a loop would be written once per arm where the asm holds it once: the reading of last resort, after every reading that copies none',
    sound: false,
    guardedBy: 'loop-exit-return-tail.test.ts: a bypassed tail holding a loop of its own is not written in the arm',
    rejects: (c) => !c.cycleRung && !c.acyclicPast,
  },
];

/** What one `while (1)` reading asks of `foreverShape` past the default: an arm may copy a tail the
 *  exit path also runs (`copyExitTail`), take one edge as a two-level exit (`twoLevel`,
/** What one `while (1)` reading asks of `foreverShape` past the default: an arm may copy a tail the
 *  exit path also runs (`copyExitTail`), take one edge as a two-level exit (`twoLevel`,
 *  `TwoLevelExit`), hand a `goto` out of both loops out one loop at a time (`outward`,
 *  `TwoLevelExit.outward`), copy past `entry-bypasses-exit` and a bypassed return tail
 *  (`lastResort`, `ArmCopies.offExitPath` and `onExitPath`), and copy a loop in a tail it shares
 *  (`cycles`, `ArmCopies.cycles`). */
interface ForeverAsk {
  readonly copyExitTail?: boolean;
  readonly twoLevel?: boolean;
  readonly outward?: boolean;
  readonly lastResort?: boolean;
  readonly cycles?: boolean;
}

/** Which copies past the duplication policy's defaults a reading asks an exit arm for: the counts
 *  for a path that bypasses the loop (A PATH THAT BYPASSES THE LOOP, at `earlyReturnArm`), and a
 *  tail holding a loop. */
interface ArmCopies {
  /** `bypassTail`: a return tail off the loop's exit path that a path from outside also enters */
  readonly offExitPath: boolean;
  /** the `exitTail` count waives `entry-bypasses-exit` */
  readonly onExitPath: boolean;
  /** `while (1)`'s last rung: a tail an arm copies may hold a loop, a `break` tail
   *  (`BREAK_TAIL_GATES`) and a return tail (`tail-holds-cycle`, `BYPASS_TAIL_GATES`) alike */
  readonly cycles: boolean;
}
const NO_COPIES: ArmCopies = { offExitPath: false, onExitPath: false, cycles: false };

// An early `return` out of the loop: forward-walking from `to` WITHOUT re-entering the loop `body`,
// every path terminates in a `ret`. agbcc/gcc merge every `return` into ONE epilogue block and each
// return site just sets the return register and branches there, so a second body exit that lands on
// such a chain is an early RETURN, not a break to a live merge — which is what lets two returns
// merged through a shared `bx lr` recover as a `while` with an in-body early `return` instead of
// declining as "multi-exit".
//
// The arm is structured AT the edge, so any block in it that a second path also reaches is emitted
// twice. A duplicated `return v` is harmless — both copies sit on mutually exclusive paths, so this
// is a FIDELITY rule, not a soundness one.
//
// ONE DUPLICATION POLICY for loop exit arms, here and in `codeBreakArm`'s shared mode. A block with
// effects may be written once per arm when the loop's own exit path does not run it (`offExitPathOf`)
// and it holds no cycle (save at `while (1)`'s last rung, below), whoever else enters it — another
// arm, or a path from before the loop (an `else` beside it). A path that left the body by an arm
// reaches the block only through that arm, because the exit does not reach it; a path from before the
// loop never ran an arm. The paths are exclusive, so each runs one copy once, the arm's or the one
// written where the block sits; on a compiler that cross-jumps (agbcc, gcc2.7.2: jump.c) those copies
// are the source the one block came from. Whether the block has an effect does not enter into it. A
// block the loop's own exit path also runs is, for a `break`, written once, after the loop: the arm's
// `break` reaches it there. `codeBreakArm`'s shared region stops at `exit`, so the loop's own arms
// bound it and it takes no size limit. This walk applies the same policy to a tail that ends in its
// own `return`: an effectful block is admitted only on one of the counts below, and refused
// otherwise. `exitTail` is the one place an arm copies a block the exit path also runs: a `return`
// tail no `break` can reach without running the exit's own code first.
//
// THE EDGE OWNS IT. `from` dominates `to` and `to` dominates the block, so every path reaching it
// runs this edge's predecessor and then this region — and only one edge into `to` can satisfy the
// first half, since two predecessors cannot both dominate it. And the region must not be reachable
// forward from the loop's own exit (`offExitPathOf`), which dominance does NOT rule out: an arm
// landing straight on the post-loop join dominates itself, and claiming it would emit the epilogue
// on both paths. Testing `to` covers the whole region — a block dominated by `to` that the exit
// reached would mean the exit reached `to`.
//
// ONLY THE LOOP'S EXIT ARMS RUN IT (`armsOnly`): the policy's count, plus every path into it comes
// from the body without passing `exit` (`onlyFromBody`). Two arms ending in the same `h(i); return;`,
// which agbcc and gcc2.7.2kmc cross-jump into one block no edge dominates, write it once each: the
// arms run on exclusive paths, so each path still runs it once. The `while` reading that takes one
// such arm for the exit stays refused — the other arm's tail is then reachable from it — so the loop
// falls to the reading whose exit runs nothing of the tail. A shared epilogue the exit also reaches
// still has to be pure, unless the exit path runs a block of its own first (`exitTail`, below).
//
// A PURE block the count admits is owned as well, though no effect forces it. The arms write it
// whether or not they own it, so owning it changes no spelling; what it changes is `emitDoWhile`'s
// escape check, which judges every block no arm owns as code run after the loop, past the update. A
// block only the arms enter runs ahead of the update on every path, so a read there of a loop
// variable is the pre-update value the arm's copy renders. agbcc cross-jumps two of three
// `p.at = …; p.kind = seg->kind; return p;` arms into one such block, reading the element pointer
// the body computed (`synthetic:sretpuretail`); unowned, it would decline the loop as a post-loop
// read of a pre-update variable.
//
// THE EXIT PATH RUNS IT TOO, AFTER CODE OF ITS OWN (`exitTail`). `for (i = 0; i < gCount; i++) { if
// (gTab[i] == x) { *out = r; return; } } gMiss = 1; *out = r;` (`synthetic:retpost_tail`): agbcc
// cross-jumps the arm's `b` to the return label onto the identical `*out = r` before it (jump.c), and
// gcc2.7.2kmc and gcc2.7.2 hold that one store in the `jr ra` delay slot, so the arm and the exit path,
// past `gMiss = 1`, end in one `store; ret` block. A `break` would land on `gMiss = 1`, so nothing but
// a copy spells the arm: the arm writes the tail and its `return`, and the exit path keeps the copy
// written after the loop. Sound for the reason the policy is: a path that took the arm reaches the
// block only through the arm's copy, which ends in its `return`, and the exit path never ran the arm,
// so each path runs one copy once. A copy is the reading of last resort: the caller asks for it
// (`copyExitTail`) only once every reading of the loop has failed without it, since another exit can
// let the arm `break` to the tail (agbcc's rotated `if (bit(i)) { x = i; break; }`, where taking the
// `x = i` arm for the exit would copy the tail into the count test's edge). The count's SCOPE is a
// copy asked for and an effectful block the exit path runs; within it, a block is admitted when no
// rule of `EXIT_TAIL_GATES` refuses it. The rules, in table order, and why each exists:
//   - `arm-leaves-by-latch`: the arm does not leave by a latch, the loop's own way out. agbcc's
//     peeled first test entering a `hit(i); break;` arm leaves no reading with the latch's target as
//     the exit, and the one that took the arm for it would copy the post-loop `out()` into the body
//     as an early return;
//   - `exit-not-test-out`: the exit is where the loop's test leaves to: a latch enters it, or a path
//     from before the loop (the zero-trip guard). An exit only a mid-body branch enters is
//     indistinguishable from an arm: the `while` reading of `if (t[i] == 7) { Ping(i); Hit(a);
//     return; } if (t[i] == 8) { Pong(i); Hit(a); return; }` (`synthetic:retarm2_tail:agbcc`) takes
//     the `Ping` edge for its exit and would copy `Hit(a)` past it; `while (1)`, which keeps both
//     arms without a copy, is read first there, so the rule's live case is a top-tested loop whose
//     header leaves to a `pre()` ahead of the arms' shared tail;
//   - `exit-runs-nothing-of-its-own`: the exit path reaches the block after a block of its own:
//     `exit`, which the arm never reaches. That block need not have an effect: agbcc cross-jumps `{
//     *out = r; return; }` onto the post-loop `r = 0; *out = r;` as well, a register move falling
//     into the one store. An arm that reaches `exit` itself is a `break` to it, which `while (1)`
//     spells; the `do-while` reading would copy the exit's code and the tail into it;
//   - `entry-bypasses-exit`: every predecessor is an arm's block (`onlyFromBody`) or on the exit's
//     forward path — never an entry from before the loop that bypasses the exit (the paragraph below
//     says why), save at the reading of last resort (A PATH THAT BYPASSES THE LOOP);
//   - `tail-holds-cycle`: neither the block nor anything past it holds a cycle, so the region past it
//     only returns, and each copy is one walk, never a loop written once per arm, save at the last
//     rung (A LOOP IN THE TAIL, below).
// None is `sound`: each copy runs on a path exclusive of the others, so a refusal here picks which
// reading of the loop is written, never whether the C means the asm. What keeps a copied tail sound
// is that the arm does not own it (`emitDoWhile`'s escape check, `a tail the exit path also runs
// stays post-loop for the escape check of a \`do-while\``).
//
// WHY A RETURN TAIL ASKS MORE THAN THE POLICY. An entry from before the loop that bypasses the exit
// is sound to copy past — the paths are exclusive — but into a tail that returns it is, in the common
// shape, the loop's own zero-trip guard landing on the post-loop epilogue: `for (i = 0; i < n; i++) {
// if (t[i] == 7) { ping(i); return; } } out(0);`. Admitting it lets the `while` reading take the early-return arm for
// the exit and copy `out(0); return;` into the body, where the asm holds it once after the loop
// (ido7.1 and mwcc_242_81 re-spell `while (1)` that way, equivalent but not the source's shape).
// What it would buy is an `else` before the loop that cross-jumps into the arms' tail (agbcc's
// `else { pong(9); hit(a); return; }`), and that is taken only at the reading of last resort (A PATH
// THAT BYPASSES THE LOOP).
//
// A PATH THAT BYPASSES THE LOOP. agbcc cross-jumps an arm's `fin(..); return;` onto the identical
// tail of an `if` branch before the loop or of a sibling `case` of an outer switch (jump.c
// `find_cross_jump`), so the arm runs into a `call; ret` block a path from outside the loop also
// enters, which no count above admits. Two counts take it, each sound for the policy's reason, and
// each asked for by the reading (`ArmCopies`), never by default. Neither can tell a cross-jump
// from a source `goto` into a shared tail, since the asm is the same: what each admits is the shape,
// on every toolchain, and the rows name the cross-jump only as its commonest source:
//   - `bypassTail` (`offExitPath`): an effectful block the loop's own exit path does not run, which a
//     path from outside the loop enters (not only the loop's arms: a tail only they enter is a
//     `break` target, written once after the loop), is admitted, the arm's own head included, when
//     no rule of `BYPASS_TAIL_GATES` refuses it. A path that took the arm reaches it only through
//     the arm's copy, which ends in its `return`; a path from outside never ran the arm, and the exit
//     never reaches it. It is not owned: a path that did not take the arm runs it too
//     (`synthetic:sw_xjret`, `synthetic:sw_xjret_case`). It is asked at the last resort, and by
//     `while (1)` (`foreverShape`) where a reading without it takes an exit laid out between the
//     body's first and last blocks and an exit past the loop's body fits with it (never an exit laid
//     out ahead of the loop: a label a `goto` jumps back to). An exit in the span may be an early
//     `return` read as the exit, which leaves the post-loop epilogue the paragraph above names off
//     the exit path; under an exit past the body that epilogue is on it, never this count's. The
//     in-span exit stays first, and the exit past the loop is taken only by a structuring run again
//     because the first declined (`PastExitRanking`, at `structure`). Klonoa's sub_08016EEC has the
//     shape (`synthetic:sw_xjret_end`): a loop that ends a `case` takes the arm's own head for its
//     exit, and declines at the switch inside it;
//   - `onExitPath`, at the reading of last resort only: the `exitTail` count waives
//     `entry-bypasses-exit`, so a tail the exit path runs past code of its own is copied although a
//     path from before the loop also lands on it: that path ran neither the arm nor the exit
//     (`synthetic:sw_xjret_post`, where the code after the loop ends in the same `fin(..); return;`).
//     Every other `exitTail` rule still holds. What it admits is any effectful return tail a branch
//     before the loop also enters, cross-jumped or not: the zero-trip epilogue the paragraph above
//     names among them, taken only where every other reading declines. A search loop's found arm
//     that jumps past the not-found code into a join the guard also enters (`if (f) { for (..) if
//     (hit) { id = i; goto j; } id = 3; } else id = 26; j: out(id);`, on gcc2.7.2, gcc2.7.2kmc and
//     ido7.1 as on agbcc) lifts this way with the join written in the arm, where a two-level exit
//     carrying the value would write it once; an unrolled search writes it once per arm.
//
// A LOOP IN THE TAIL. A cycle in a copied tail is the policy's one exception, and it is one rule
// wherever the tail ends: in `break` (`codeBreakArm`, `BREAK_TAIL_GATES`) or in `return`
// (`tail-holds-cycle` above, `BYPASS_TAIL_GATES`). Each arm may write its own copy of the loop, but
// only at `while (1)`'s last rung (`ArmCopies.cycles`), after every reading that copies none: one
// loop the asm holds once, written twice. The copies are exclusive for the policy's reason, so each
// path runs one copy and runs its loop as the asm runs the one loop; the walk never re-enters the
// body, so no copy's loop reaches back into it; and a block on the cycle is never owned (`armsOnly`
// asks for none). Each copy is structured by the reading its own natural loop takes, and a cycle
// entered at two blocks, which has none, declines loud at emission.
//
// Returns the blocks the arm OWNS — the ones that run ahead of the loop's update on every path that
// reaches them — or null when this is not an early-`return` arm. The arm writes every block its walk
// admits, owned or not: an `exitTail` block is admitted but not owned, since the exit path runs it
// after the update. Not exclusive to the arm: a block the `armsOnly` count admits is owned by every
// arm that reaches it, so two arms' sets can share it. `latches` are the loop's latches;
// `exitTailGates` the refusals the `exitTail` count is held to (`EXIT_TAIL_GATES`).
function earlyReturnArm(
  { dom, reachFrom, preds }: EarlyReturnArmDeps,
  from: Block,
  to: Block,
  body: Set<Block>,
  exit: Block,
  latches: readonly Block[],
  copyExitTail: boolean,
  exitTailGates: readonly Gate<ExitTailCandidate>[] = EXIT_TAIL_GATES,
  bypass: ArmCopies = NO_COPIES,
  bypassTailGates: readonly Gate<BypassTailCandidate>[] = BYPASS_TAIL_GATES,
): Set<Block> | null {
  // does the loop's own exit path run it? forward only (`offExitPathOf`)
  const offExitPath = offExitPathOf(exit, dom);
  const entryOwned = dom.get(to)!.has(from) && to !== exit && offExitPath(to);
  // the duplication policy's admission: the loop's own exit path does not run it, and no cycle holds
  // it — and, for a tail that returns, only the loop's exit arms enter it (`armsOnly`, below). Never
  // the arm's own head: an edge straight from the body into a block others enter too is a `break` to
  // it, which `while (1)` writes once, after the loop — unless the exit path reaches it after a block
  // of its own, which no `break` can skip (`exitTail`).
  const armOfBody = onlyFromBody(preds, body, exit);
  const armsOnly = (bb: Block) =>
    bb !== to && bb !== exit && armOfBody(bb) && offExitPath(bb) && !reachFrom(bb).has(bb);
  // a return tail the loop's own exit path also runs, after a block of its own (THE EXIT PATH RUNS IT
  // TOO, above), asked for only when the caller has found no reading without it
  const acyclicPast = (bb: Block) => ![bb, ...reachFrom(bb)].some((y) => reachFrom(y).has(y));
  const exitTail = (bb: Block): boolean =>
    copyExitTail &&
    !offExitPath(bb) &&
    firstRejection(exitTailGates, {
      armLeavesByLatch: latches.includes(from),
      lastResort: bypass.onExitPath,
      cycleRung: bypass.cycles,
      get exitIsTestOut() {
        return (preds.get(exit) ?? []).some((p) => !body.has(p) || latches.includes(p));
      },
      // `exit` itself, which the arm never reaches (so `bb` is never `exit`, which the loop writes
      // after it)
      get exitRunsOwnBlock() {
        return to !== exit && !reachFrom(to).has(exit);
      },
      get enteredByArmsOrExitPath() {
        return (preds.get(bb) ?? []).every((p) => armOfBody(p) || !offExitPath(p));
      },
      get acyclicPast() {
        return acyclicPast(bb);
      },
    }) === null;
  // a return tail off the exit path that a path from outside the loop also enters (A PATH THAT
  // BYPASSES THE LOOP, above), asked for by the reading
  const bypassTail = (bb: Block): boolean =>
    bypass.offExitPath &&
    offExitPath(bb) &&
    bb !== exit &&
    !armOfBody(bb) &&
    firstRejection(bypassTailGates, {
      cycleRung: bypass.cycles,
      get acyclicPast() {
        return acyclicPast(bb);
      },
    }) === null;
  const owned = new Set<Block>();
  const seen = new Set<Block>();
  const stack = [to];
  while (stack.length) {
    const bb = stack.pop()!;
    if (seen.has(bb)) {
      continue;
    }
    seen.add(bb);
    if (body.has(bb)) {
      return null;
    } // re-enters the loop → not an exit
    if ((entryOwned && dom.get(bb)!.has(to)) || armsOnly(bb)) {
      owned.add(bb);
    } else if (bb.ops.some(effectful) && !exitTail(bb) && !bypassTail(bb)) {
      return null;
    }
    const t = bb.ops[bb.ops.length - 1];
    if (t.opcode === 'ret') {
      continue;
    }
    if (t.opcode === 'br' || t.opcode === 'cond_br') {
      for (const s of t.successors) {
        stack.push(s.block);
      }
      continue;
    }
    return null; // switch_br / unknown terminator → decline
  }
  return owned;
}

/** The two facts a merge carrier's declared type contributes to `canTakeName` — see the rule's own
 *  comment there for why the signedness half is part of the width at sub-word sizes. */
function carrierWidth(t: IrType | undefined): number {
  return t?.kind === 'int' ? t.width : 32;
}
function carrierSign(t: IrType | undefined): boolean | undefined {
  return t?.kind === 'int' && t.width < 32 ? t.signed : undefined;
}

/** Where a loop reading that copies a ret tail with an effect into the body (`retCopyingReadings`)
 *  ranks, and whether a structuring committed one. */
interface RetCopyRanking {
  /** Behind every `while (1)` reading that copies no loop, the two-level one included, and ahead of
   *  the last rung's readings that copy one in a tail they share (`ForeverAsk.cycles`). Otherwise it
   *  ranks as the other `while` and `do-while` readings do, save for a tail code around the loop
   *  also enters, which waits behind the `while (1)` readings that add no variable. */
  readonly last: boolean;
  took: boolean;
}

/** Whether `while (1)` (`foreverShape`) takes a fitting exit laid out past the loop's body ahead of
 *  the exit inside the body's span it reads first otherwise, and whether a structuring met a loop
 *  where that order reads differently (A PATH THAT BYPASSES THE LOOP, at `earlyReturnArm`). */
interface PastExitRanking {
  readonly first: boolean;
  could: boolean;
}

/** Whether `while (1)` asks its outward rung (`TwoLevelExit.outward`), and whether a structuring met
 *  a loop that rung reads. */
interface OutwardRanking {
  readonly asked: boolean;
  could: boolean;
}

/** The jump tables, by dispatch block, that ask their jump rungs (THE JUMPS, in the per-switch
 *  ladder), or every one of them; the ones a structuring met where every goto-free rung declined
 *  and an unasked jump rung read the switch; and the ones any structuring spelled with no goto. */
interface JumpRanking {
  readonly asked: ReadonlySet<Block> | 'every';
  readonly wanted: Set<Block>;
  readonly free: Set<Block>;
}

/** The `while (1)` loops spelled `for (init; cond; inc)` with `continue;` into their latch (THE LOOP
 *  AS A `for`, at `forPlanAt`), by header, and the ones a structuring declined inside of. */
interface ForRanking {
  readonly asked: ReadonlySet<Block>;
  readonly wanted: Set<Block>;
}

/** A RET-TAIL COPY CLASSIFICATION ACCEPTS, EMISSION MAY STILL NOT SPELL. A `while` or `do-while`
 *  reading takes an edge into a ret-terminated tail it does not own as an early `return`, and only
 *  emission learns whether the body can hold it: on gcc2.7.2kmc, `for (j = 0; j < 8; j++) { if
 *  (hit) goto out; } k(i); out: gA[0] = i;` reads as a do-while whose hit branch then finds no join
 *  in the body ("unrecovered back-edge"), and on gcc2.7.2 the same loop in a switch arm whose merge
 *  is the function's `t(); return` reaches that merge from inside the loop, which no `break;` spells
 *  (`switchBreakAt`). Such a structuring is run again with every such reading last
 *  (`RetCopyRanking.last`), where `while (1)` spells the loop.
 *
 *  AN EXIT PAST THE LOOP, LIKEWISE. Where `while (1)` takes an exit inside the loop's span and an
 *  exit past its body would fit once an arm copies a return tail a path from outside the loop also
 *  enters, both readings are the same asm, and neither scores better on every toolchain: the one
 *  read first is kept. Only a structuring that declines with it — Klonoa's sub_08016EEC
 *  (`synthetic:sw_xjret_end`), where the switch inside the loop finds a case body leaving for the
 *  in-span exit past the switch's end — is run again with the exit past the loop first
 *  (`PastExitRanking.first`), and with the ret-tail copies last as well if that one committed one.
 *
 *  A GOTO OUT OF BOTH LOOPS, LAST OF ALL. The outward flag (`TwoLevelExit.outward`) is a variable
 *  the asm does not hold, and one loop's ladder cannot see whether the readings of its partner
 *  would have structured the nest without it: on mwcc_242_81, `for (i…) { k(i); for (j…) if (a(j))
 *  goto out; } out: gOut += i;` lifts with the hit copying the ret tail once the ret copies rank last,
 *  where asking the outward rung there hands the flag out instead. So every run above is made with
 *  the rung unasked, and only where all of them decline and some loop's rung would have read it are
 *  they made again with it asked (`OutwardRanking`).
 *
 *  A `for` WHOSE `continue` RUNS THE UPDATE, LAST. `while (1)` spells a counted loop whose latch
 *  holds the update and the test as `if (!c) break; i++;` at the foot of the body, which has no
 *  `continue` into it: a jump table arm that reaches both the latch and the loop's exit is then a
 *  loop `break` C binds to the switch (`synthetic:sw_forjt`). Where every run above declines, they
 *  are made again with each `while (1)` loop spelled `for` where `forPlanAt` reads one
 *  (`ForRanking`), once more for each loop that run adds. The loops asked are the ones where
 *  ANY of those runs — the ret-copy, past-exit and outward reruns as well as the first — met one of
 *  three jump-table refusals (`wantFor`), so the published refusal, which is the first run's, need
 *  not be one of them: a function that declines on "unrecovered back-edge" can lift here because a
 *  later rung reached the jump table. Any structure decline in a function with a `while (1)` loop
 *  holding a jump table is in reach. Where the default lifts, the same `for` is the ranked
 *  `/for-continue` variation (`spellCountedLoopsFor`), which asks every loop on the first run.
 *
 *  A CASE-LABEL `goto`, AFTER EVERYTHING ELSE. The jump rungs of a jump table's ladder (THE JUMPS,
 *  `jumpSharedFallTargets`) write the one goto L3 holds, and the default writes one only where
 *  every goto-free reading declines. One switch's ladder sees only
 *  its own rungs, not the whole-function reruns above: a `while (1)` jump table whose copies decline
 *  in the first run can lift goto-free once the `for` rerun asks its loop, and asking the jumps in
 *  the first run adopts them there and never makes that rerun. So every run above is made with the
 *  jump rungs unasked, and only where all of them decline, the `for` reruns included, and some
 *  switch's jump rung would have read it, are they all made again with rungs asked (`JumpRanking`)
 *  — PER SWITCH: only at the switches whose jump rung read them and that no run spelled goto-free.
 *  Asked for every switch, a function whose first switch needs the jump and whose second is a
 *  `while (1)` jump table the `for` rerun spells would take gotos in both. A switch first reached
 *  in an asked pass is asked by the next pass, as `ForRanking` adds loops; and where the last pass
 *  declines while a switch it left unasked would have read, one pass asks every switch, so no
 *  function the per-switch passes decline is one asking every switch lifts.
 *  The ranked `/case-goto` variation (`jumpToSharedCases`) is the other producer, and the scorer
 *  weighs it against the copies.
 *
 *  The first run's refusal stands if every rerun declines too, where the first run is the last
 *  pass's that asked the jumps when any did. Each run's observation hooks are held until it is
 *  known to stand, so a site is reported once: by the structuring that is returned, or by the
 *  first run where none is. */
export function structure(
  fn: Fn,
  opts: StructureOptions = {},
  hooks: StructureHooks = {},
  memo?: DefaultAcceptsMemo,
): SFn {
  let refused: { error: StructureError; held: (() => void)[] } | undefined;
  const attempt = (
    retCopy: RetCopyRanking,
    pastExit: PastExitRanking,
    outward: OutwardRanking,
    forRank: ForRanking,
    jumps: JumpRanking,
  ): SFn | null => {
    const held: (() => void)[] = [];
    const hold =
      <A extends unknown[]>(f: (...args: A) => void) =>
      (...args: A) => {
        held.push(() => f(...args));
      };
    try {
      const sfn = structureRanked(
        fn,
        opts,
        {
          ...hooks,
          onBranchSenseSite: hooks.onBranchSenseSite && hold(hooks.onBranchSenseSite),
          onEarlyReturnFollow: hooks.onEarlyReturnFollow && hold(hooks.onEarlyReturnFollow),
          onTailFallerKept: hooks.onTailFallerKept && hold(hooks.onTailFallerKept),
          onCaseCopied: hooks.onCaseCopied && hold(hooks.onCaseCopied),
          onForOffered: hooks.onForOffered && hold(hooks.onForOffered),
        },
        memo,
        retCopy,
        pastExit,
        outward,
        forRank,
        jumps,
      );
      held.forEach((f) => f());
      return sfn;
    } catch (error) {
      if (!(error instanceof StructureError)) {
        throw error;
      }
      refused ??= { error, held };
      return null;
    }
  };
  const ranked = (outward: OutwardRanking, forRank: ForRanking, jumps: JumpRanking): SFn | null => {
    const first: RetCopyRanking = { last: false, took: false };
    const inSpan: PastExitRanking = { first: false, could: false };
    const past: RetCopyRanking = { last: false, took: false };
    return (
      attempt(first, inSpan, outward, forRank, jumps) ??
      (first.took ? attempt({ last: true, took: false }, inSpan, outward, forRank, jumps) : null) ??
      (inSpan.could ? attempt(past, { first: true, could: false }, outward, forRank, jumps) : null) ??
      (past.took ? attempt({ last: true, took: false }, { first: true, could: false }, outward, forRank, jumps) : null)
    );
  };
  const outwardRanked = (forRank: ForRanking, jumps: JumpRanking): SFn | null => {
    const unasked: OutwardRanking = { asked: false, could: false };
    return (
      ranked(unasked, forRank, jumps) ?? (unasked.could ? ranked({ asked: true, could: false }, forRank, jumps) : null)
    );
  };
  const forRanked = (jumps: JumpRanking): SFn | null => {
    let forRank: ForRanking = { asked: new Set(), wanted: new Set() };
    let sfn = outwardRanked(forRank, jumps);
    // each rerun asks every loop the runs before it declined inside of; a nest needs one per level
    for (let n = 0; sfn === null && n < 4; n++) {
      const asked = new Set([...forRank.asked, ...forRank.wanted]);
      if (asked.size === forRank.asked.size) {
        break;
      }
      forRank = { asked, wanted: new Set() };
      sfn = outwardRanked(forRank, jumps);
    }
    return sfn;
  };
  const free = new Set<Block>();
  let jumps: JumpRanking = { asked: new Set(), wanted: new Set(), free };
  let sfn = forRanked(jumps);
  // each pass asks the switches the passes before it wanted and none spelled goto-free; a switch
  // only an asked pass reaches needs one more
  for (let n = 0; sfn === null && jumps.asked !== 'every' && n < 8; n++) {
    const asked: ReadonlySet<Block> = jumps.asked;
    const next = new Set([...asked, ...[...jumps.wanted].filter((b) => !free.has(b))]);
    // where no switch the last pass left unasked would have read, it made exactly the runs asking
    // every switch makes, so its decline is that one's
    if (next.size === asked.size && [...jumps.wanted].every((b) => asked.has(b))) {
      break;
    }
    // The runs that ask the jumps read every switch at least as far as the unasked ones, so where
    // they decline too, theirs is the refusal that stands: the unasked one may be a switch the
    // jumps spell, and a function declined for arms that do not linearize would then be declined
    // for the wrong reason.
    refused = undefined;
    jumps = { asked: next.size === asked.size || n === 7 ? 'every' : next, wanted: new Set(), free };
    sfn = forRanked(jumps);
  }
  if (sfn !== null) {
    return sfn;
  }
  refused!.held.forEach((f) => f());
  throw refused!.error;
}

function structureRanked(
  fn: Fn,
  opts: StructureOptions,
  hooks: StructureHooks,
  memo: DefaultAcceptsMemo | undefined,
  retCopy: RetCopyRanking,
  pastExit: PastExitRanking,
  outwardRank: OutwardRanking,
  forRank: ForRanking,
  jumpRank: JumpRanking,
): SFn {
  const {
    returnsVoid = false,
    coalesceLoopInit = false,
    preserveDivergentBranchSense = true,
    negateJoinedBranchSense = preserveDivergentBranchSense,
    branchSenseFlipSites,
    senseFromFoldEvidence = false,
    orderArgCopiesByWriteOrder = true,
    preferDefPosCopyOrder = false,
    copyEveryTailEntrant = false,
    jumpToSharedCases = false,
    spellCountedLoopsFor = false,
    switchAllowsNeqCase = true,
    switchBoundCase,
    switchArmsFollowLayout = false,
    switchRequiresFrontLoadedTests = false,
    spellSwitchFallthrough = true,
    spellSwitchBreak = true,
    spillSlotOrder,
    declaredArgs,
    declaredReturns,
    dialect,
    designatedInitializers = false,
    strictPointerConversions = false,
    defOrderLoadPairs = true,
    anchorConstCopies = false,
    anchorLoopEntryConsts = false,
    littleEndian = true,
    spellBitfieldMembers: bitfieldSpellingWanted = true,
    spellPtrMemberElements: ptrElementSpellingWanted = true,
    spellDeclaredSubscripts: declRankSpellingWanted = true,
    rereadGlobals = false,
    materializeJoinFeeds = false,
    homeSharedAddresses = false,
    homeLoopExprs = false,
    homeDerivedReads = false,
    homeMergeFeeds = false,
    homeEscapingExtensions = false,
    readsStayWhereWritten = false,
    contractsFloatProducts = false,
    keepsPointerSumAddend = false,
    staticLayout,
    unsignedCompareSpelling = true,
    coalesceMergeNames = false,
    freshParamMerge = false,
    followEarlyReturns = false,
    onGap = 'strict',
    symbols: mapSymbols,
    inferredSymbols,
    orderLicensedGlobals,
    pointerGlobals,
    contextGlobals,
    enumBytes,
    plainCharSigned,
  } = opts;
  // A read this stamp is the first to place was plain to every raising pass, and in a `&&`/`||`'s
  // guarded operand a short-circuit fold may have lifted it out of the arm it ran in: which side of
  // the branch the asm read it on is lost. The analysis names a counted op it finds there above the
  // branch, which is right only for one no fold could move, so this read declines instead.
  const stampedLate = stampDeclaredVolatile(fn, mapSymbols, {
    volatileReadsExtendInRegister: opts.volatileReadsExtendInRegister,
    contextGlobals,
  });
  if (stampedLate.length > 0) {
    const defsNow = defOpMap(fn);
    const guarded = shortCircuitGuardedValues(fn, defsNow);
    const moved = stampedLate.find((op) => op.results.some((r) => guarded.has(r)));
    if (moved !== undefined) {
      throw new StructureError(
        `cannot structure '${fn.name}': a '&&'/'||' would guard a read of the volatile object ` +
          `'${globalBaseOf(defsNow, moved.operands[0]) ?? 'a volatile object'}', and which side of the branch the asm read it on is not recoverable`,
      );
    }
  }
  // THE shape dictionary the rendering context asks, map-first. Built as a lookup rather than a
  // merged Map because the map is the PROJECT's and is asked by name for a whole project's worth
  // of symbols — copying it per structuring is work proportional to the project, and a ranked run
  // structures one function thousands of times (the same argument the `laddr` name minter makes).
  //
  // A function-scope static is asked by its linker name, which no map holds, and comes FIRST: its
  // shape is its definition's, never the one raise/globalshape.ts infers from its accesses.
  const localStatics = localStaticShapes(fn, staticLayout);
  if ('refused' in localStatics) {
    if (fn.localObjects?.get(localStatics.symbol)?.anonymous) {
      throw new StructureError(
        `cannot structure '${fn.name}': reads the compiler's anonymous constant ('${localStatics.symbol}') ${localStatics.refused}`,
      );
    }
    throw new StructureError(
      `cannot structure '${fn.name}': names a function-scope static ('${localStatics.symbol}') ${localStatics.refused}`,
    );
  }
  const staticInfo = localStatics.infos;
  const symbols: SymbolLookup | undefined =
    mapSymbols !== undefined || (inferredSymbols !== undefined && inferredSymbols.size > 0) || staticInfo.size > 0
      ? {
          get: (n) => staticInfo.get(n) ?? mapSymbols?.get(n) ?? inferredSymbols?.get(n),
          has: (n) => staticInfo.has(n) || mapSymbols?.has(n) === true || inferredSymbols?.has(n) === true,
        }
      : undefined;
  // Only the MAP makes the named bitfield spelling available, so with no map this is not a question.
  // Normalized once here rather than left to each reader's own `symCtx &&` guard, because rank.ts's
  // `/no-bitfield` decline rests on both arms structuring the IDENTICAL tree without a map — a
  // second reader added outside that guard would otherwise delete a candidate silently, and nothing
  // reports a candidate that was never enumerated (bitfield-members.test.ts).
  // Against the PROJECT MAP alone, never the derived shapes: only a map carries bitfield members,
  // and keying this on the union would flip the `/no-bitfield` variation's zero point on a map-less row.
  const spellBitfieldMembers = mapSymbols !== undefined && bitfieldSpellingWanted;
  // These options all change which edge copies elide as identities (extra materialization does
  // too), which the loop emitters' hazard predicates read — so the invariant above covers each.
  // A compiler behavior is not among them, however much it materializes: the default structuring
  // IS this target's compiler behaviors, so resetting one would probe a spelling asmlift never emits
  // here.
  //
  // THE STRUCTURE VARIATIONS `assertDefaultAccepts` DOES NOT RESET (rank-variations.ts) ARE
  // DELIBERATE NON-MEMBERS, each for its own reason, and this is the whole of that list — the one
  // place it is stated, derived from the guard's own reset list and held to it by
  // test/variation-offers.test.ts. Every variation NOT named here is one the guard resets, so the
  // invariant it protects — a candidate spelling never unlocks a function the default declines —
  // rests on the guard for those and on the argument beside each name for these:
  //   - `/site-sense` (senseFromFoldEvidence) decides which way each folded branch is written. It
  //     negates a branch sense per site and touches no copy, like the per-function sense booleans;
  //   - `/reread-globals` (rereadGlobals) is an ANALYSIS option, and it only ever RELAXES: it
  //     widens a load's render positions and narrows the write set that bars it, so it removes
  //     materializations rather than minting them. Extra materialization is what this guard is
  //     about (see above), and this variation adds none;
  //   - `/signed-cmp` (unsignedCompareSpelling OFF) drops the casts at compares and the u32
  //     reconciliation of `varType`. It touches no name and no copy, so no edge copy changes its
  //     elision under it;
  //   - `/copy-defpos` (preferDefPosCopyOrder) REORDERS the copies of one edge and adds or drops
  //     none. rank.ts states the same thing from the variation side, in the terms that matter there: a
  //     reordering cannot rescue a spelling whose OFF sibling failed the boundary contracts.
  if (
    coalesceMergeNames ||
    freshParamMerge ||
    materializeJoinFeeds ||
    homeSharedAddresses ||
    homeLoopExprs ||
    homeDerivedReads ||
    homeMergeFeeds ||
    homeEscapingExtensions ||
    anchorConstCopies ||
    followEarlyReturns ||
    copyEveryTailEntrant ||
    jumpToSharedCases ||
    spellCountedLoopsFor
  ) {
    // The observation hooks are this setting's, not the default's: dropped for that run, which also
    // leaves it answerable from `memo`.
    assertDefaultAccepts(
      fn,
      opts,
      { ...hooks, onTailFallerKept: undefined, onCaseCopied: undefined, onForOffered: undefined },
      memo,
    );
  }
  const defs = defOpMap(fn);
  // The word evaluator's view of `fn`, built at the first `neg_s` (no other rule asks it).
  let wordCtx: WordCtx | undefined;
  const preds = predecessorBlocks(fn);
  const dom = dominators(fn);
  // --- loop discovery (ir/loops.ts): natural loops via dominator back-edges + the nesting forest ---
  const forest = analyzeLoops(fn, dom);
  const ipdom = functionPostDominators(fn, forest);

  /** The byte step `raise/const.ts` recorded on the literal that feeds this access's address, or
   *  `undefined` where the address was not reached by advancing a register. Read at the two
   *  `memAccess` call sites, which are where an IR value becomes an L3 access node. */
  const advanceStepOf = (base: Value): number | undefined => {
    const step = defs.get(base)?.attrs.advancedBy;
    return typeof step === 'number' ? step : undefined;
  };

  /** THE view a `store` (`width` bytes) or `astore` (`elemSize`) lvalue is spelled through, for
   *  both branches below: `storeSigned`, the scalar the recovered pointee was seeded at, so an
   *  inserted cast declares the same type. An UNSTAMPED narrow store of a constant both views store
   *  alike (narrow sign bit clear) takes its base's own int pointee instead and asks for no cast,
   *  since nothing witnessed either type. */
  const storeView = (op: Op, width: number): boolean => {
    const t = op.operands[0].type;
    const own = t.kind === 'ptr' && t.to.kind === 'int' && t.to.width === width * 8 ? t.to.signed : undefined;
    const v = defs.get(op.operands[op.opcode === 'astore' ? 2 : 1]);
    const k = v?.opcode === 'const' ? v.attrs.value : undefined;
    const neutral = typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < 2 ** (width * 8 - 1) && width < 4;
    return op.attrs.signed === undefined && neutral && own !== undefined ? own : storeSigned(op, width);
  };

  // ── analysis phase (structure/analysis.ts): use registry, liveness, materialization ──
  const { useSitesOf, opIndex, opBlock, liveIn, materialize, preUpdateHomes, reachFrom, emitPos, memWriteBetween } =
    analyze(fn, returnsVoid, {
      defs,
      dom,
      rereadGlobals,
      materializeJoinFeeds,
      homeSharedAddresses,
      homeLoopExprs,
      homeDerivedReads,
      homeMergeFeeds,
      homeEscapingExtensions,
      readsStayWhereWritten,
      contractsFloatProducts,
    });

  // THE FOLLOW OF A DIVERGENT `if`, over the paths that do not return early. Post-dominance gives
  // such an `if` no join — its arms reach two different `ret`s, and EXIT is the only block on every
  // path — so each arm is structured to its end and a region both arms reach is emitted in both.
  // When the compiler emitted that region ONCE, the source can have written it once, after the
  // `if`, with every other path into a `ret` an early `return;` — `synthetic:gcseinner`, where
  // agbcc keeps the `fnA` arm's own `ret` and stores the default once. An option, enumerated as
  // rank.ts's `/shared-ret` twin, and as its `/shared-tail` twin after the store-tail sink: as a
  // default it costs rows, measured there.
  //
  // WHICH REGION: the `ret`s reachable from EVERY successor — or, given an `anchor`, from every
  // successor that shares a `ret` with the anchor (`sharedRetsOf`; only the `switch_br` caller's
  // retry passes one, the dispatch's default edge). Every block that cannot reach one of
  // them is an early-return region and is deleted; the follow is `b`'s post-dominator over what is
  // left. Sound for the same reason an ordinary follow is: every kept path from `b` passes it, and a
  // deleted block reaches no kept `ret` and so never the follow, so each arm structures up to the
  // follow or into a `return`.
  //
  // IT CAN DUPLICATE ACROSS THE ARMS, AND ABOVE TWO SUCCESSORS IT DOES. With two, it cannot: a
  // deleted region both arms reach would have its `ret` in the intersection, and so would not have
  // been deleted. With three or more that argument does not carry — a `ret` reachable from two of
  // three arms is NOT in the intersection, so its region is deleted from `keep` and re-emitted in
  // each arm that reaches it. The copies sit on mutually exclusive paths, so the program stays
  // correct; the cost is bytes, which is the only currency here. The `switch_br` caller pays it
  // knowingly: its alternative is not a shorter spelling but a decline (see that caller).
  //
  // PER `if`, never function-wide: the deletion set is a function of that `if`'s own shared `ret`s
  // (memoized on them), because a nested `if` shares a different set, or none.
  //
  // REFUSES (keeping the divergent arms) when that reading leaves no `ret` — none reachable from
  // every successor, or from every successor the anchor keeps — when the
  // kept graph gives `b` no post-dominator but EXIT, and when the enclosing region's `stop` is
  // reachable from `b` without passing the follow — that path must reach `stop`, and structuring
  // the arms towards a different follow would emit `stop`'s region inside an arm.
  //
  // THE TWO CALLERS DIFFER ON LOOPS AND ONLY ONE OF THEM GUARDS IT. The `if` caller asks outside a
  // loop body only (`followEarlyReturns && loopCtx === null`, with `clampToLoop` as its second
  // net), for the reason written there. The `switch_br` caller asks it without consulting
  // `loopCtx`, and no input has been found that reaches this from inside a loop body: every `ret`
  // the arms of an in-loop branch reach is reachable from the latch too, so the intersection keeps
  // the whole graph, `pd` is `ipdom` itself — and the caller only asks when `ipdom.get(b)` is
  // already null, so the answer comes back null and the `?? stop` fallback stands. That is an
  // observation about the shape rather than a check, which is why it is written down here. The
  // anchored RETRY that caller adds is no exception in practice: inside a loop the latch carries
  // every arm to every `ret`, so the arm that returns shares one with the default edge and is
  // kept, and nothing is left out. Where an in-loop switch's arms DO reach one join past the loop
  // — every `ret` merged into one epilogue, which `ipdom` then names (`synthetic:sw_loopret`) —
  // it is that caller's LOOP CLAMP, not this, that reads the loop body's own join (`loopJoin`).
  const followsByShared = new Map<string, Map<Block, Block | null>>();
  const followOverReturns = (b: Block, stop: Block | null, anchor: Block | null = null): Block | null => {
    const shared = sharedRetsOf(b, reachFrom, anchor);
    if (shared.length === 0) {
      return null;
    }
    const key = shared
      .map((r) => fn.blocks.indexOf(r))
      .sort((x, y) => x - y)
      .join(',');
    let pd = followsByShared.get(key);
    if (pd === undefined) {
      const keep = new Set(fn.blocks.filter((x) => shared.some((r) => r === x || reachFrom(x).has(r))));
      pd = postDominators(fn, keep);
      followsByShared.set(key, pd);
    }
    const follow = pd.get(b) ?? null;
    if (follow === null || (stop !== null && follow !== stop && reachesAvoiding(b, stop, follow))) {
      return null;
    }
    if (anchor === null) {
      hooks.onEarlyReturnFollow?.({ block: fn.blocks.indexOf(b), follow: fn.blocks.indexOf(follow) });
    }
    return follow;
  };

  // SCALAR-vs-AGGREGATE globals: a `gaddr` symbol accessed EXCLUSIVELY at offset 0 is a scalar
  // global → the bare name `gSym` (byte-exact, matches the source). A symbol accessed at any
  // non-zero offset (or via a variable index) is an array/struct global → EVERY access uses the
  // `((T *)&gSym)[i]` address-cast form (a struct value does not decay, so casting the bare name is
  // invalid C; casting the address is valid and byte-exact). Computed once here.
  //
  // THE ACCESS SPELLING IS PART OF THE QUESTION, not only the offset set. The bare name is ONE
  // declaration, so it spells one width and one signedness; a symbol read at off-0 two different
  // ways has no bare spelling at all, and emitting one loses the second access entirely
  // (`gState + gState` for a halfword plus a byte). Such a symbol is an AGGREGATE here, so every
  // access takes the address-cast form at its OWN width — `*(u16 *)&gState + *(u8 *)&gState`,
  // which is what the source wrote and what raise/structs.ts's constant-address sibling emits for
  // the same shape at a literal address.
  //
  // TWO QUESTIONS, AND THEY ARE ASKED OF DIFFERENT ACCESSES. WIDTH is asked of every load and store: a
  // `u16` declaration cannot carry a word store either. SIGNEDNESS is asked of LOADS ONLY — a store
  // writes the same bytes through either declaration (`*(s16 *)&g = x` and `*(u16 *)&g = x` are one
  // instruction), while a load does not: `lh` and `lhu` on one cell are two declarations, and
  // spelling both `g` would lose the zero-extension. Unreachable in Thumb, where `ldrsh`/`ldrsb`
  // need a register offset and the `add` that forms it already marks the symbol aggregate; live on
  // MIPS, where `%hi/%lo` addressing carries no such `add`.
  // FRAME-LOCAL OBJECT NAMES (laddr). Minted HERE, not in the frontend, because identifiers live
  // in this layer's namespace: params, locals, every gaddr symbol, and the project's symbol map —
  // none of which the frontend can see. A frontend-chosen `sp0` silently shadowed a project global
  // of the same name. `sp<off>` uniquified with underscores until free; one name per offset.
  // `undef` locals are minted in the same pass off the same `taken` set — they need the same
  // protection from the symbol map, gaddr symbols and callee names that `laddr` names do.
  //
  // The map is CONSULTED, never copied in: `taken` is only probed and added to, so asking the
  // name-keyed map answers the same question for every name in it. Copying it is work
  // proportional to the whole PROJECT's symbol count on every structuring, and a ranked run
  // structures one function thousands of times.
  const { laddr: laddrName, undef: undefName } = (() => {
    const taken = new Set<string>();
    const isTaken = (n: string): boolean => taken.has(n) || symbols?.has(n) === true;
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'gaddr') {
          taken.add(op.attrs.sym as string);
        } else if (calleeName(op) !== undefined) {
          // a CALLEE's name is in this namespace too: a function really named sp0 would be
          // shadowed by the minted local, and `sp0()` on a u16 object is a compile error
          taken.add(calleeName(op)!);
        }
      }
    }
    const mint = (base: string): string => {
      let n = base;
      while (isTaken(n)) {
        n += '_';
      }
      taken.add(n);
      return n;
    };
    const byOff = new Map<number, string>();
    const names = new Map<Op, string>();
    const undefNames = new Map<Op, string>();
    const undefByKey = new Map<string, string>();
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'laddr' && op.attrs[OWN_RETURN_OBJECT] === true) {
          // the function's own return object, which no frame offset names
          names.set(op, mint('ret'));
        } else if (op.opcode === 'laddr' && typeof op.attrs[CALL_RETURN_OBJECT] === 'string') {
          // the struct a call returned in a register, which no frame offset names either
          names.set(op, mint(`${op.attrs[CALL_RETURN_OBJECT]}_ret`));
        } else if (op.opcode === 'laddr') {
          const off = op.attrs.off as number;
          let n = byOff.get(off);
          if (n === undefined) {
            n = mint(`sp${off}`);
            byOff.set(off, n);
          }
          names.set(op, n);
        } else if (op.opcode === 'undef') {
          // Named from the key, like laddr's `sp<off>`: `uninit_sp8` says which frame slot to look
          // at in the assembly, and it stays put where a running counter would renumber every local
          // when an unrelated edit changed the order ops are minted in.
          // A `copied` undef is the same storage's content as the undef its key names, so it
          // shares that one's name (and declaration) once both are minted, below.
          if (op.attrs.copied !== true) {
            const n = mint(`uninit_${String(op.attrs.key).replace('@', '')}`);
            undefNames.set(op, n);
            undefByKey.set(String(op.attrs.key), n);
          }
        }
      }
    }
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'undef' && op.attrs.copied === true) {
          const key = String(op.attrs.key);
          const n = undefByKey.get(key) ?? mint(`uninit_${key.replace('@', '')}`);
          undefByKey.set(key, n);
          undefNames.set(op, n);
        }
      }
    }
    return { laddr: names, undef: undefNames };
  })();

  const scalarGlobals = new Set<string>();
  /** The scalar GLOBALS (never a frame object) the IR loads as a pointer at least once: one load
   *  typed a pointer is the value used as an address somewhere in the function, while its other
   *  loads may type an integer only because they reach a call argument or a compare. */
  const pointerLoadedGlobals = new Set<string>();
  /** Every scalar GLOBAL (never a frame object) whose value the function loads as a word, the
   *  only width a pointer has: a `u8`/`u16` global is an integer whatever it is added to. */
  const wordLoadedGlobals = new Set<string>();
  {
    const offsets = new Map<string, Set<number>>();
    const widths = new Map<string, Set<number>>();
    const loadSigns = new Map<string, Set<boolean>>();
    const loadsPointer = new Map<string, boolean>();
    /** the sign of a symbol's loads whose extension some use reads (`extensionImmaterial`) */
    const signedLoads = new Map<string, boolean>();
    const bumpAgg = (sym: string) => offsets.set(sym, new Set([-1])); // -1 marks "variable index"
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        // A C++ reference global is a cell holding its referent's address, and the assembly reads
        // or writes that cell; `gRef` and `&gRef` both name the referent, one dereference past it,
        // so every spelling here would add a load (`*(s32 *)*(s32 *)&gRef` for `return gRef;`).
        if (op.opcode === 'gaddr' && contextGlobals?.storage.get(op.attrs.sym as string)?.kind === 'reference') {
          throw new StructureError(
            `'${op.attrs.sym as string}' is declared a C++ reference, and no spelling names the cell the assembly accesses`,
          );
        }
        // A frame object declared as an aggregate (`laddrType`) is one whatever its accesses agree
        // on — the frame-side twin of the symbol map's declaration-shape override. Spelled
        // scalar, a store assigns to the array and a load reads its address.
        if (op.opcode === 'laddr' && laddrType(op).kind !== 'int') {
          bumpAgg(laddrName.get(op)!);
        }
        const gaddrSym = (v: Value) => {
          const dv = defs.get(v);
          // laddr participates identically: `sp0` is scalar-spelled at off 0 and cast-spelled
          // anywhere else, exactly as a global of its shape would be — by its MINTED name
          // (laddrName): the op carries no name attr, that namespace is this layer's
          return dv?.opcode === 'gaddr'
            ? (dv.attrs.sym as string)
            : dv?.opcode === 'laddr'
              ? (laddrName.get(dv) ?? null)
              : null;
        };
        if (op.opcode === 'load' || op.opcode === 'store') {
          const s = gaddrSym(op.operands[0]);
          if (s) {
            (offsets.get(s) ?? offsets.set(s, new Set()).get(s)!).add(op.attrs.off as number);
            (widths.get(s) ?? widths.set(s, new Set()).get(s)!).add(op.attrs.width as number);
            if (op.opcode === 'load') {
              if (!extensionImmaterial(fn, op, op.attrs.width as number, useSitesOf)) {
                signedLoads.set(s, op.attrs.signed as boolean);
              }
              (loadSigns.get(s) ?? loadSigns.set(s, new Set()).get(s)!).add(op.attrs.signed as boolean);
              if (defs.get(op.operands[0])?.opcode === 'gaddr') {
                loadsPointer.set(s, loadsPointer.get(s) === true || op.results[0].type.kind === 'ptr');
              }
            }
          }
        } else if (op.opcode === 'add' || op.opcode === 'sub') {
          // ANY arithmetic on the symbol's address is interior addressing ⇒ aggregate — even when
          // the sum only reaches memory through a copy/phi (a pointer-walk loop `p = &g + 2;
          // do { *p++ … }` never makes the add a DIRECT load/store base, which is all the old
          // check saw; the symbol then classified scalar and emitted the bare `g = 0` spelling,
          // which a project declaring `extern u16 g[]` rejects as an incomplete-type assignment).
          for (const o of op.operands) {
            const s2 = gaddrSym(o);
            if (s2) {
              bumpAgg(s2);
            }
          }
        } else if (op.opcode === 'aload' || op.opcode === 'astore') {
          const s = gaddrSym(op.operands[0]);
          if (s) {
            bumpAgg(s);
          }
        }
      }
    }
    for (const [sym, offs] of offsets) {
      if (offs.size === 1 && offs.has(0) && widths.get(sym)?.size === 1 && (loadSigns.get(sym)?.size ?? 1) === 1) {
        scalarGlobals.add(sym);
      }
    }
    for (const [sym, ptr] of loadsPointer) {
      if (scalarGlobals.has(sym)) {
        if (widths.get(sym)?.has(4)) {
          wordLoadedGlobals.add(sym);
        }
        if (ptr) {
          pointerLoadedGlobals.add(sym);
        }
      }
    }
    // Declaration-shape OVERRIDE (symbol map, or the declaration context for a global the map does
    // not describe): a project-declared array/struct global is an AGGREGATE whatever the usage
    // inference saw — a lone off-0 access to `extern u16 tbl[]` must still spell through the
    // aggregate/array forms, never the bare scalar `tbl`.
    // Driven from the FUNCTION's own globals, for the same reason the name minter above consults
    // the map instead of copying it: a name outside `scalarGlobals` has nothing to override.
    // A declared SCALAR is overridden the same way where its storage — the context's or the map's,
    // either of which the candidate may be compiled against — disagrees with the one access
    // (`storageDisagrees`): a bare name reads and writes what the declaration says, so over
    // `extern s32 gN;` a byte read spelled `gN` reads four bytes, and over `extern s8 gN;` it
    // sign-extends what an `ldrb` zero-extends. The cast spelling `*(u8 *)&gN` states the access
    // itself whatever the declaration, on either byte order.
    for (const n of [...scalarGlobals]) {
      const shape = symbols?.get(n)?.shape;
      if (
        shape === 'array' ||
        shape === 'struct' ||
        contextGlobals?.aggregates.has(n) === true ||
        [contextGlobals?.storage.get(n), mappedStorage(symbols?.get(n))].some((declared) =>
          storageDisagrees(
            declared,
            {
              width: [...widths.get(n)!][0],
              signed: signedLoads.get(n),
            },
            { enumBytes, plainCharSigned },
          ),
        )
      ) {
        scalarGlobals.delete(n);
      }
    }
  }

  // Symbol-map rendering context (memAccess/arrayAccess): shape lookups + the env registry for
  // array-shaped globals actually referenced (they surface as SFn.globals — typed, undeclared).
  const shapedGlobalTypes = new Map<string, IrType>();
  const symCtx: SymRenderCtx | undefined = symbols
    ? {
        info: (n) => symbols.get(n),
        noteGlobal: (n, t) => shapedGlobalTypes.set(n, t),
        ptrElements: ptrElementSpellingWanted,
        declRank: declRankSpellingWanted,
        fieldsOf: memoFieldsOf((n) => symbols.get(n)),
      }
    : undefined;

  // GUARDED self-loop headers (a block that is its own successor, entered through a guard-shaped
  // cond_br) — recovered by the guard-fusion + emitWhile un-rotation path below (the gcc "guard +
  // do-while" → `while` shape; countdown/shifts). UNGUARDED self-loops register as single-block
  // do-whiles in the structured-loop discovery instead. A self-loop's
  // test and update live in ONE block, so the latch test reads the UPDATED value → emitWhile substitutes
  // the back-edge arg back to the header param. This is DISTINCT from a test-at-top multi-block `while`
  // (whileLoops, below) whose header is a pure test read on entry values.
  const loops = new Map<Block, LoopInfo>();
  for (const nl of forest.byHeader.values()) {
    if (!nl.selfLoop) {
      continue;
    } // multi-block loops go through whileLoops
    const b = nl.header;
    const term = b.ops[b.ops.length - 1];
    if (term.opcode !== 'cond_br') {
      continue;
    } // a many-way self-terminator has no single "exit"
    const exit = term.successors.find((s) => s.block !== b)?.block;
    if (!exit) {
      continue;
    }
    // GUARDED self-loops only: some forward pred's cond_br decides "enter b vs its exit" — the
    // shape the guard-fusion + emitWhile un-rotation below consumes. An UNGUARDED self-loop
    // (entered by a plain br / fall-through) is a bottom-tested loop whose body always runs
    // once — a single-block do-while — and is claimed by the structured-loop discovery below
    // instead (each header lives in exactly ONE map, so seeding stays single-pass).
    const direct = (preds.get(b) ?? []).some((pr) => isGuardShapedPred(pr, b, exit));
    // Or THROUGH a pure preheader: the compiler's loop-invariant motion parks computations in a
    // forwarding block between the guard and the header (the mask re-materialization of a busy
    // poll). The block must be PURE and unmaterialized — its defs then render inline wherever
    // the loop reads them and nothing about it needs a statement position of its own — with a
    // single in-edge and a plain `br` into the header, so the guard's branch is still the only
    // decision. Anything else keeps the unguarded do-while recovery.
    // The preheader claim is limited to loops whose header→exit edge carries NO args: with
    // nothing riding the exit, the fusion site's exit-copy obligations (staleExit, the sink) are
    // vacuous. The condition and zero-trip hazards stay live there, so redirecting a loop from
    // the do-while path yields the new shape or a LOUD decline — never silent wrong C.
    const exitCarriesNothing = (successorTo(b, exit)?.args ?? []).length === 0;
    const preheader =
      direct || !exitCarriesNothing
        ? undefined
        : (preds.get(b) ?? []).find((P) => {
            const pt = P.ops[P.ops.length - 1];
            return (
              P !== b &&
              pt?.opcode === 'br' &&
              P.params.length === 0 &&
              P.ops.every((o) => !effectful(o) && !materialize.has(o)) &&
              // at least one def the LOOP BODY reads — the loop-invariant-motion shape this claim
              // exists for. A block that only computes the init args is the do-while path's
              // ordinary entry chain, and that path's sink machinery handles it better.
              P.ops.some((o) => o.results.some((r) => (useSitesOf.get(r) ?? []).some((site) => site.blk === b))) &&
              (preds.get(P) ?? []).length === 1 &&
              isGuardShapedPred(preds.get(P)![0], P, exit)
            );
          });
    if (!direct && !preheader) {
      continue;
    }
    const back = successorTo(b, b)!;
    loops.set(b, {
      header: b,
      exit,
      backArgOfParam: b.params.map((_, i) => back.args[i]),
      ...(preheader ? { preheader } : {}),
    });
  }

  // --- structured natural loops (test-at-top `while` / bottom-test `do-while`) ---
  // Both share the fail-closed preconditions: single latch, properly-nested inner loops only,
  // reducible single-entry body, and a SINGLE real (non-ret) exit — early returns (ret-terminated
  // targets) are allowed in-body. The shape then splits on WHERE the exit lives: the HEADER exits
  // (pure test-at-top) → `while`; the LATCH exits (body-first) → `do-while`. Anything that fails
  // is left to `while (1)` (below), or declines to plain if-recovery, which re-enters the header and
  // fails loud via `onStack`.
  //
  // What every loop form asks first (`admissible`): each inner loop whose header sits in this body
  // is PROPERLY nested — its ENTIRE body is contained in ours (a forest descendant). Structuring
  // then recurses naturally: when the outer body reaches the inner header, structureBlock
  // dispatches to the inner's own emitter. An OVERLAPPING loop (shared blocks, neither containing
  // the other → irreducible) DECLINES. If a contained inner is itself unstructurable, the outer's
  // body structuring loud-fails at the inner back-edge (onStack) — a safe decline, not a
  // miscompile. And the body is single-entry: every block but the header is entered ONLY from
  // inside it — no jump into the loop interior. A `break` edge must also not leave from an inner
  // loop's body (`innerBodyHas`), which would be a two-level exit.
  const innerBodyHas = (nl: NaturalLoop, b: Block): boolean =>
    [...forest.byHeader.values()].some((l2) => l2.header !== nl.header && nl.body.has(l2.header) && l2.body.has(b));
  // THE CODE A TWO-LEVEL EXIT SKIPS (`TwoLevelExit`): every block a forward path from `exit` runs
  // before it meets `to`, or null when none meets it. Forward only: an edge into a block that
  // dominates its source is the back edge of a loop around both, the next iteration, not the code
  // after this loop. A path that leaves without meeting `to` (a `return`, a `break` or `continue` of
  // the enclosing loop) stays in the region, which renders it where it sits, inside the `if`.
  const twoLevelSkip = (exit: Block, to: Block): Set<Block> | null => {
    const region = new Set<Block>();
    let meets = false;
    for (const work = [exit]; work.length > 0;) {
      const x = work.pop()!;
      if (x === to) {
        meets = true;
      } else if (!region.has(x)) {
        region.add(x);
        work.push(...successorsOf(x).filter((s) => !dom.get(x)!.has(s)));
      }
    }
    return meets ? region : null;
  };
  // May the edge from `nl`'s body to `to` be a two-level exit past `exit`? `to` lies outside the
  // loop and is not `exit`; inside a loop around this one, `to` lies in that loop's body, or, on the
  // outward rung only (`outwardAsked`), past that loop and no further (an outward exit, handed out
  // to it: `TwoLevelExit.outward`); and the code from `exit` meets `to` (`twoLevelSkip`), which an
  // outward exit does not ask. Asked only of an edge no other reading takes
  // (`foreverShape`), so a loop any other reading takes never reads through it. The rules are
  // `TWO_LEVEL_EXIT_GATES`, read here as the fields of one edge; every refusal is a loud capability
  // gap, and no rule is sound:
  //   - `second-target-elsewhere` refuses a third exit target; without it the `break` it would
  //     write is refused where it is emitted, still loud.
  //   - A TWO-LEVEL `continue` (the hit going straight to the enclosing header) is refused twice
  //     over. Read with its count exit for `exit`, the target is the header
  //     (`target-is-enclosing-header`; the walk reaches the header only by a back edge, so
  //     `exit-never-meets-target` refuses it too). Read with the header for `exit`, the walk runs
  //     back into the loop (`skip-reenters-loop`). That one refuses a correct lift, `if (f == 0)
  //     continue;` after the loop: it stays until a bench row weighs the header as an exit.
  //   - `target-past-enclosing-loop` keeps the `goto` out of both loops for the outward rung, and
  //     `own-target-held-back` keeps that rung's first pass to it (`foreverShape`'s `ownFlag`).
  //   - `target-two-loops-out` is DEFENSIVE: on a `goto` out of three loops the middle loop refuses
  //     the hand-out (`not-a-break-arm`, OUTWARD_EXIT_GATES: the code from the target misses its
  //     exit), and the check that both loops took the reading sends the innermost one back.
  //   - `from-inner-body`, `target-is-exit-or-in-loop` and `exit-past-enclosing-loop` are DEFENSIVE:
  //     an edge out of an inner loop is that loop's to read first, an exit edge never lands in its
  //     own loop, and on a reducible CFG the walk from `exit` meets a `to` inside the enclosing body
  //     only from inside it.
  const twoLevelCandidate = (
    nl: NaturalLoop,
    exit: Block,
    from: Block,
    to: Block,
    second: TwoLevelExit | undefined,
    outwardAsked: boolean,
    ownTargetHeldBack: boolean,
  ): TwoLevelCandidate => {
    const outer = forest.parent.get(nl.header);
    const outerBody = outer ? forest.byHeader.get(outer)!.body : null;
    const grand = outer ? forest.parent.get(outer) : null;
    const outward = outerBody !== null && !outerBody.has(to);
    let skip: Set<Block> | null | undefined;
    // an outward exit skips nothing a walk from `exit` meets: the code it skips is the rest of the
    // enclosing loop, which `if (f != 0) break;` leaves
    const skipped = () => (skip === undefined ? (skip = outward ? new Set() : twoLevelSkip(exit, to)) : skip);
    return {
      get fromInnerBody() {
        return innerBodyHas(nl, from);
      },
      secondTargetElsewhere: second !== undefined && second.to !== to,
      get targetIsExitOrInLoop() {
        return to === exit || nl.body.has(to);
      },
      targetPastEnclosingLoop: outward,
      outwardAsked,
      ownTargetHeldBack,
      get targetTwoLoopsOut() {
        return outward && grand !== null && grand !== undefined && !forest.byHeader.get(grand)!.body.has(to);
      },
      get exitPastEnclosingLoop() {
        return outerBody !== null && !outerBody.has(exit);
      },
      get targetIsEnclosingHeader() {
        return outerBody !== null && to === outer;
      },
      get exitNeverMeetsTarget() {
        return skipped() === null;
      },
      get skipReentersLoop() {
        const s = skipped();
        return s !== null && [...s].some((x) => nl.body.has(x));
      },
    };
  };
  // May the exit edge `from -> to` of `nl`, leaving from an inner loop's body, be that loop's outward
  // two-level exit (`TwoLevelExit.outward`) handed out to `nl`, which leaves for `exit`? The edge
  // leaves a loop `nl` holds directly (`child`), and the code from `to` (none where `to` is `exit`) is
  // a break arm of `nl` (`codeBreakArm`, shared, with its one duplication policy): the hit writes it
  // inside the inner loop, ahead of `f = 1; break;`, and `if (f != 0) break;` then lands where that
  // code went. The rules are `OUTWARD_EXIT_GATES`; every refusal is a loud capability gap.
  const outwardExitOf = (
    nl: NaturalLoop,
    from: Block,
    to: Block,
    exit: Block,
  ): { child: Block; candidate: OutwardExitCandidate } => {
    let child: NaturalLoop | undefined;
    for (const l of forest.byHeader.values()) {
      if (
        l !== nl &&
        nl.body.has(l.header) &&
        l.body.has(from) &&
        (child === undefined || l.body.size < child.body.size)
      ) {
        child = l;
      }
    }
    return {
      child: child!.header,
      candidate: {
        fromDeeperLoop: forest.parent.get(child!.header) !== nl.header,
        get notABreakArm() {
          return to !== exit && codeBreakArm(preds, dom, from, to, nl.body, exit, true) === null;
        },
      },
    };
  };
  const admissible = (nl: NaturalLoop): boolean =>
    [...forest.byHeader.values()].every(
      (l2) => l2.header === nl.header || !nl.body.has(l2.header) || [...l2.body].every((b) => nl.body.has(b)),
    ) && [...nl.body].every((bb) => bb === nl.header || (preds.get(bb) ?? []).every((p) => nl.body.has(p)));
  // An edge out of `nl` that does not land on `exit` itself, read the one way both the `while` and the
  // `while (1)` classifiers read it: a `break` that runs `region` first, or an early return whose
  // tail the loop emits (`owned`). The break arm is asked first: where the code past `exit` is a pure
  // `return`, `earlyReturnArm` would also take the arm and copy that post-loop `return` into it, where
  // the asm holds one copy after the loop (two code arms ahead of `return 3;` would lift as `gHit = i;
  // return 3;` twice, not a `break` each and one `return 3`). The break arm copies nothing past
  // `exit` — the duplication policy written at `earlyReturnArm`.
  // `codeArms` is the classifier's own admission of a code-running break; never out of an inner body.
  // `copyExitTail` lets the arm copy a tail the exit path also runs (`exitTail`, at `earlyReturnArm`):
  // a copy is the reading of last resort, asked for only once every reading without it has failed.
  const exitArmOf = (
    nl: NaturalLoop,
    e: { from: Block; to: Block },
    exit: Block,
    codeArms: boolean,
    copyExitTail: boolean,
    bypass: ArmCopies = NO_COPIES,
  ) => {
    const region =
      codeArms && !innerBodyHas(nl, e.from)
        ? codeBreakArm(preds, dom, e.from, e.to, nl.body, exit, true, {
            cycleRung: bypass.cycles,
            gates: hooks.breakTailGates ?? BREAK_TAIL_GATES,
          })
        : null;
    const owned =
      region === null
        ? earlyReturnArm(
            { dom, reachFrom, preds },
            e.from,
            e.to,
            nl.body,
            exit,
            nl.latches,
            copyExitTail,
            hooks.exitTailGates,
            bypass,
            hooks.bypassTailGates,
          )
        : null;
    return { region, owned };
  };
  const whileLoops = new Map<Block, WhileLoopInfo>();
  const doWhileLoops = new Map<Block, DoWhileInfo>();
  const copyingReadings = new Map<Block, () => void>();
  const retCopyingReadings = new Map<Block, () => void>();
  const keptGuardDoWhiles = new Map<Block, DoWhileInfo>();
  for (const nl of forest.byHeader.values()) {
    const h = nl.header;
    // Guarded self-loops use emitWhile (above); UNGUARDED ones are single-block do-whiles. A
    // guarded one's do-while reading is kept aside all the same (`keptGuardDoWhiles`), for the
    // guard that emitWhile cannot fuse and then declines.
    const guarded = nl.selfLoop && loops.has(h);
    if (!nl.selfLoop && nl.latches.length !== 1) {
      continue;
    } // single latch only
    const latch = nl.selfLoop ? h : nl.latches[0];
    if (!admissible(nl)) {
      continue;
    }

    // Identify the loop's single STRUCTURAL exit — where the loop-condition sends control when it
    // fails. It may itself be a ret block (a loop ending in `return`), so it CANNOT be found by
    // filtering ret targets (that would hide the exit of every `while(*p){} return q;`). It is the
    // header's non-body edge (test-at-top `while`) or the latch's non-body edge (bottom-test
    // `do-while`). `while` is tried first; `do-while` only when the header keeps BOTH edges in-body.
    const hTerm = h.ops[h.ops.length - 1];
    const lTerm = latch.ops[latch.ops.length - 1];
    const hInBody = hTerm.opcode === 'cond_br' ? hTerm.successors.filter((s) => nl.body.has(s.block)) : [];
    const hOut = hTerm.opcode === 'cond_br' ? hTerm.successors.filter((s) => !nl.body.has(s.block)) : [];
    const lOut = lTerm.opcode === 'cond_br' ? lTerm.successors.filter((s) => !nl.body.has(s.block)) : [];
    // Header purity — the header block is KEPT as the re-evaluated `while` condition, so no
    // store/astore/opaque, and no `call` (expr() inlines a result at every use with no CSE → a call
    // whose result also feeds the body would be evaluated twice per iteration). A `load` is fine —
    // but NOT a materialized one: its temp assignment renders only via sideEffects(), which a
    // condition-only header never emits, so its uses would read an unassigned variable.
    const headerPure = !h.ops.some((op) => effectful(op) || materialize.has(op));

    let exitFrom: Block,
      exit: Block,
      kind: 'while' | 'dowhile',
      bodyEntry: Block | null = null;
    // The header's way out is not the loop's exit when it enters an arm that runs code and then
    // joins another exit edge (`codeBreakArm`) whose tail has an effect: that arm is a `break`, and
    // the loop a `while (1)`. Where the tail only returns, the `while` reading copies it into the
    // other edge as an early `return`, and keeps that spelling — unless the tail is a bare `return`
    // and the arm itself runs code. gcc2.7.2's `for (i = 0; i < n; i++) { if (t[i] == 7) { gHit = 1;
    // break; } }` keeps the arm inside a guarded bottom-tested loop, so the arm is the one in the
    // loop, and a bare `return` copies no code: `while (t[i] != 7) { ...; if (i >= n) return; }
    // gHit = 1;` is the spelling the bytes do not hold (breaknend_code 21/26 against 4/18).
    // The arm is asked in shared mode, as `exitArmOf` asks it for `while (1)`: a break whose tail
    // another arm or an `else` before the loop also enters is a break all the same, and the `while`
    // reading that took it for the exit would leave the other exit edge with no spelling.
    const runsEffect = (x: Block) => [x, ...reachFrom(x)].some((y) => !nl.body.has(y) && y.ops.some(effectful));
    const hOutIsBreakArm =
      hOut.length === 1 &&
      nl.exitEdges.some((e) => {
        if (e.to === hOut[0].block) {
          return false;
        }
        const region = codeBreakArm(preds, dom, h, hOut[0].block, nl.body, e.to, true, {
          cycleRung: false,
          gates: hooks.breakTailGates ?? BREAK_TAIL_GATES,
        });
        const bareReturn = e.to.ops.length === 1 && e.to.ops[0].opcode === 'ret' && e.to.ops[0].operands.length === 0;
        return region !== null && (runsEffect(e.to) || (bareReturn && [...region].some((y) => y.ops.some(effectful))));
      });
    if (
      !nl.selfLoop &&
      hTerm.opcode === 'cond_br' &&
      hInBody.length === 1 &&
      hOut.length === 1 &&
      headerPure &&
      !hOutIsBreakArm
    ) {
      kind = 'while';
      exitFrom = h;
      exit = hOut[0].block;
      bodyEntry = hInBody[0].block;
    } else if (lTerm.opcode === 'cond_br' && lOut.length === 1 && lTerm.successors.some((s) => s.block === h)) {
      // a SELF-loop always lands here: its ops run before its bottom test (body-first), so the
      // faithful spelling is `do { ops; updates } while (cond)` with header === latch
      kind = 'dowhile';
      exitFrom = latch;
      exit = lOut[0].block;
    } else {
      continue; // neither a clean pre-tested nor bottom-tested single-exit shape
    }
    // Single loop exit (ret-aware): the chosen exit is the ONE real exit; every OTHER edge leaving
    // the body must be an early `return` (`earlyReturnArm`), a ret-terminated target, or — for a
    // `while` — a `break`: an edge landing on the header's own exit, which C spells by leaving the
    // loop and running the exit region once, after it. A second exit that lands on any OTHER live
    // merge has no single-level spelling → decline, as does a `break` edge out of a NESTED loop's
    // body (a two-level exit). A `do-while` takes no break: an edge into its exit that no arm owns
    // leaves the loop to `while (1)`, whose breaks carry their own copies, where the do-while's
    // would fall into the latch's. An edge to the header's exit is a break whatever the exit holds:
    // the asm runs ONE copy of the exit region for both edges, and agbcc and mwcc keep a
    // source-duplicated return tail duplicated, so copying the tail into the arm spells another
    // object. Where that exit ends in a return, the edge is also an arm or a ret target, and emission
    // copies the tail where the break spelling refuses. The arms and breaks are kept: emission needs
    // to know which edges out of the body end an iteration rather than continue it.
    // An arm that copies a tail the exit path also runs (`exitTail`) is asked for only when the reading
    // fails without one, and a reading that needs it waits (`copyingReadings`) until `while (1)` has
    // tried every exit without it (below): a `do-while` whose arm copies the tail keeps its bottom test
    // (`a \`do-while\` whose arm needs the exit path's tail keeps its bottom test`), where `while (1)`
    // with the copy would spell it `if (!(i < n)) break;`.
    // A RET TARGET THE EDGE DOES NOT OWN, holding an effect, is copied into the body as an early
    // `return` (`retCopyingReadings`). Where code around the loop also enters it (the header does
    // not dominate it), the reading waits behind the `while (1)` readings that add no variable, and
    // goes ahead of the two-level one (`TwoLevelExit`), whose flag the asm does not hold either:
    // ido7.1's `for (…) { if (t[i] == x) { *out = r; return; } } gMiss = 1; *out = r;` merges the
    // two `*out = r; return` and is spelled by `while (1)` with the hit's `return` inside
    // (`retpost_tail`), and agbcc's cross-jumped `for (…) if (hit) { s->f = i; return; }` keeps the
    // copy where the flag would add `v = 1; break;` the source never wrote. A tail only the loop's
    // own paths reach is the arms' to copy (`a pure tail only the arms of a \`do-while\` enter`).
    // Classification cannot tell whether emission spells the copy, so a structuring that committed
    // one and declined is run again with every such reading last of all (`RetCopyRanking`).
    const readArms = (copyExitTail: boolean) => {
      const arms: LoopArm[] = [];
      const breaks = new Set<Block>();
      const breakArms: BreakArm[] = [];
      let copiesEffect = false;
      let shared = false;
      for (const e of nl.exitEdges) {
        if (e.from === exitFrom && e.to === exit) {
          continue;
        }
        // a `while` takes a code-running break only into an exit that takes no copies: the header's exit
        // copies are what `breakRule` shares with a break, and an arm's edge into the exit is not one
        const { region, owned } = exitArmOf(nl, e, exit, kind === 'while' && exit.params.length === 0, copyExitTail);
        if (owned) {
          arms.push({ from: e.from, to: e.to, owned });
        }
        if (kind === 'while' && e.to === exit && !innerBodyHas(nl, e.from)) {
          breaks.add(e.from);
        } else if (region !== null) {
          breaks.add(e.from);
          breakArms.push({ from: e.from, to: e.to, region });
        } else if (!owned && (!isRet(e.to) || (kind === 'dowhile' && e.to === exit))) {
          return null;
        } else if (!owned && e.to.ops.some(effectful)) {
          copiesEffect = true;
          shared ||= !dom.get(e.to)!.has(h);
        }
      }
      return { arms, breaks, breakArms, copiesEffect, shared };
    };
    const plain = readArms(false);
    const read = plain ?? readArms(true);
    if (read === null) {
      continue;
    }
    const { arms, breaks, breakArms, copiesEffect, shared } = read;

    const reading =
      kind === 'while'
        ? () =>
            whileLoops.set(h, {
              header: h,
              bodyEntry: bodyEntry!,
              exit,
              latch,
              forwardPreds: nl.forwardPreds,
              body: nl.body,
              arms,
              breaks,
              breakArms,
            })
        : () =>
            (guarded ? keptGuardDoWhiles : doWhileLoops).set(h, {
              header: h,
              latch,
              exit,
              forwardPreds: nl.forwardPreds,
              body: nl.body,
              arms,
            });
    const commit = () => {
      retCopy.took ||= copiesEffect;
      reading();
    };
    // a self-loop has no edge out but its exit, so `plain` is never null for a guarded one
    if (copiesEffect && (shared || retCopy.last)) {
      retCopyingReadings.set(h, commit);
    } else if (plain === null) {
      copyingReadings.set(h, commit);
    } else {
      commit();
    }
  }

  // A loop none of the shapes above spells — several latches with a conditional `continue` in
  // mid-body beside the bottom one, or one latch under a header that computes before it tests (a
  // mid-tested loop) — is `while (1)`: every edge back to the header is the
  // implicit continue at the foot of its region, and every edge out is a `break` to the one exit
  // chosen below or an early `return`. Same fail-closed preconditions as above: `admissible`, and
  // no break out of an inner loop's body. The exit is the first target under which every other edge
  // out is an early-return arm or lands on a `ret` block with no effect in it, trying first, in
  // block order, the targets laid out after the loop's last body block: a compiler places the code
  // after a loop there and an early `return` inside the loop's span, so block order alone would take
  // that `return` for the break and the code after the loop for an early return.
  const foreverLoops = new Map<Block, ForeverLoopInfo>();
  const foreverShape = (nl: NaturalLoop, ask: ForeverAsk): ForeverLoopInfo | null => {
    const { copyExitTail = false, twoLevel = false, outward = false, lastResort = false, cycles = false } = ask;
    // NO EDGE LEAVES: the loop never ends, and C spells that `while (1)` with no `break` and nothing
    // after it. A block laid out past the loop is reached from elsewhere or not at all, and the
    // region holding the loop ends at the loop either way (`emitForever`).
    if (nl.exitEdges.length === 0) {
      return {
        header: nl.header,
        latches: nl.latches,
        forwardPreds: nl.forwardPreds,
        exit: null,
        body: nl.body,
        arms: [],
        breaks: new Set(),
        breakArms: [],
      };
    }
    const laidOut = [...nl.body].map((b) => fn.blocks.indexOf(b));
    const first = Math.min(...laidOut);
    const last = Math.max(...laidOut);
    const rank = (x: Block) => fn.blocks.indexOf(x) + (fn.blocks.indexOf(x) > last ? 0 : fn.blocks.length);
    const targets = [...new Set(nl.exitEdges.map((e) => e.to))].sort((x, y) => rank(x) - rank(y));
    const pastLoop = (x: Block) => rank(x) < fn.blocks.length;
    // laid out between the body's first and last blocks: never a block ahead of the loop
    const inSpan = (x: Block) => fn.blocks.indexOf(x) > first && fn.blocks.indexOf(x) < last;
    const asked: ArmCopies = { offExitPath: lastResort, onExitPath: lastResort, cycles };
    const fitAt = (exit: Block, bypass: ArmCopies, ownFlag: boolean): ForeverLoopInfo | null => {
      const arms: LoopArm[] = [];
      const breaks = new Set<Block>();
      const breakArms: BreakArm[] = [];
      let second: TwoLevelExit | undefined;
      let handed: Map<Block, Set<Block>> | undefined;
      // an edge out of an inner loop's body, on the outward rung: that loop's outward two-level exit,
      // handed out to this one (`outwardExitOf`)
      const handOut = (e: { from: Block; to: Block }): boolean => {
        const { child, candidate } = outwardExitOf(nl, e.from, e.to, exit);
        if (firstRejection(hooks.outwardExitGates ?? OUTWARD_EXIT_GATES, candidate) !== null) {
          return false;
        }
        handed ??= new Map();
        handed.set(child, (handed.get(child) ?? new Set()).add(e.from));
        breaks.add(e.from);
        return true;
      };
      const fits = nl.exitEdges.every((e) => {
        if (e.to === exit) {
          breaks.add(e.from);
          return !innerBodyHas(nl, e.from) || (outward && handOut(e));
        }
        const { region, owned } = exitArmOf(nl, e, exit, true, copyExitTail, bypass);
        if (owned) {
          arms.push({ from: e.from, to: e.to, owned });
        }
        if (region !== null) {
          breaks.add(e.from);
          breakArms.push({ from: e.from, to: e.to, region });
          return true;
        }
        // a `ret` target the edge does not own is copied into the body where the edge leaves, so it
        // must hold nothing a second copy would run twice in the source
        if (owned !== null || (isRet(e.to) && !e.to.ops.some(effectful))) {
          return true;
        }
        if (outward && innerBodyHas(nl, e.from)) {
          return handOut(e);
        }
        // the last resort: a two-level exit, to ONE target beside `exit`, never out of an inner body
        // (`TWO_LEVEL_EXIT_GATES`; what each rule does is at `twoLevelCandidate`)
        const candidate = twoLevel ? twoLevelCandidate(nl, exit, e.from, e.to, second, outward, !ownFlag) : null;
        if (candidate === null || firstRejection(hooks.twoLevelExitGates ?? TWO_LEVEL_EXIT_GATES, candidate) !== null) {
          return false;
        }
        second ??= {
          to: e.to,
          from: new Set(),
          ...(candidate.targetPastEnclosingLoop ? { outward: true as const } : {}),
        };
        second.from.add(e.from);
        breaks.add(e.from);
        return true;
      });
      return fits
        ? {
            header: nl.header,
            latches: nl.latches,
            forwardPreds: nl.forwardPreds,
            exit,
            body: nl.body,
            arms,
            breaks,
            breakArms,
            ...(second !== undefined ? { twoLevel: second } : {}),
            ...(handed !== undefined ? { handed } : {}),
          }
        : null;
    };
    // an exit inside the loop's span may be an early `return` read as the exit: an exit past the
    // loop that fits once an arm copies a bypassed return tail is noted here, and taken only on a
    // rerun (`PastExitRanking`; A PATH THAT BYPASSES THE LOOP, at `earlyReturnArm`). An exit laid out
    // ahead of the loop is a `goto` back to a label before it, which a `break` spells once.
    const pastFirst = (exit: Block, shape: ForeverLoopInfo, ownFlag: boolean): ForeverLoopInfo => {
      if (inSpan(exit) && !asked.offExitPath) {
        for (const past of targets.filter(pastLoop)) {
          const copied = fitAt(past, { ...asked, offExitPath: true }, ownFlag);
          if (copied !== null) {
            pastExit.could = true;
            return pastExit.first ? copied : shape;
          }
        }
      }
      return shape;
    };
    // On the outward rung every exit is tried first with no two-level exit of the loop's own, so
    // a `goto` out of both loops whose code is laid out ahead of the code after the loop is not
    // read as the exit with the loop's other way out as a second flag the asm does not hold.
    for (const ownFlag of outward ? [false, true] : [true]) {
      for (const exit of targets) {
        const shape = fitAt(exit, asked, ownFlag);
        if (shape !== null) {
          return pastFirst(exit, shape, ownFlag);
        }
      }
    }
    return null;
  };
  // A copy of an exit-path tail (`exitTail`) is the reading of last resort: `while (1)` first tries
  // every exit without one, then the `while` or `do-while` reading that needed one, then every exit
  // with one. agbcc rotates `for (i = 0; i < 8; i++) { if (bit(i)) { x = i; break; } } tail;` so the
  // `break` arm leaves by the latch and the count test mid-body: taking the arm for the exit, the
  // count test's edge copies `tail` past `x = i`, where the reading with `tail` for the exit writes
  // the source's two `break`s and one `tail`. Then comes the `while` or `do-while` that copies a
  // ret tail with an effect into the body (`retCopyingReadings`), and past all of them the two-level
  // exit (`TwoLevelExit`), which adds a variable the asm does not hold: it is taken only by a loop
  // that every other reading declines. A structuring run again because emission refused such a
  // copy (`RetCopyRanking.last`) asks the two-level exit before the copy. Behind it the same rung
  // asks again with `outward`, where a `goto` out of both loops is handed out
  // (`TwoLevelExit.outward`) — only on a run every structuring without it declined
  // (`OutwardRanking`) — and right behind that `while (1)` with every copy, where an arm also
  // copies a return tail a path that bypasses the loop enters, under an exit inside the loop's span
  // or on the exit path (A PATH THAT BYPASSES THE LOOP, at `earlyReturnArm`). Last of all, where no
  // reading fits and no ret copy waits, every `while (1)` reading above runs again, in the same
  // order, with an arm writing its own copy of a loop in a tail it shares, ending in `break` or in
  // `return` (A LOOP IN THE TAIL, at `earlyReturnArm`): two copies of a loop the asm holds once.
  // `rungs` asks every reading with or without `cycles`, so a reading added to `rungs` is asked
  // again with it at the last rung. A loop whose outward reading its partner refused runs the ladder
  // from the two-level rung again with `outward` off (`handedFallbacks`).
  const handedFallbacks = new Map<Block, () => void>();
  for (const nl of forest.byHeader.values()) {
    const h = nl.header;
    const open = !loops.has(h) && !whileLoops.has(h) && !doWhileLoops.has(h) && admissible(nl);
    const copying = copyingReadings.get(h);
    const retCopying = open ? retCopyingReadings.get(h) : undefined;
    const rungs = (cycles: boolean) => {
      const read = (ask: ForeverAsk) => (open ? foreverShape(nl, { ...ask, cycles }) : null);
      // unasked, the outward rung only notes whether it reads the loop, a probe that leaves no
      // ranking of its own behind
      const handingOut = (): ForeverLoopInfo | null => {
        if (outwardRank.asked) {
          return read({ twoLevel: true, outward: true });
        }
        const pastCould = pastExit.could;
        outwardRank.could ||= read({ twoLevel: true, outward: true }) !== null;
        pastExit.could = pastCould;
        return null;
      };
      return {
        plain: () => read({}),
        copied: () => read({ copyExitTail: true }),
        flagged: (outward: boolean) =>
          read({ twoLevel: true }) ?? (outward ? handingOut() : null) ?? read({ copyExitTail: true, lastResort: true }),
      };
    };
    const first = rungs(false);
    const shape = first.plain();
    // the ladder from the two-level rung on, settled: the loop it read, else the ret copy behind it,
    // else, where none waits, the last rung
    const fromFlagged = (outward: boolean): ForeverLoopInfo | null => {
      let fl = first.flagged(outward);
      if (fl === null && retCopying === undefined) {
        const last = rungs(true);
        fl = last.plain() ?? last.copied() ?? last.flagged(outward);
      }
      if (fl !== null) {
        foreverLoops.set(h, fl);
      } else {
        retCopying?.();
      }
      return fl;
    };
    if (open && shape === null && copying !== undefined) {
      copying();
    } else {
      const copied = shape ?? first.copied();
      if (copied !== null) {
        foreverLoops.set(h, copied);
      } else if (retCopying !== undefined && !retCopy.last) {
        retCopying();
      } else {
        const flagged = fromFlagged(true);
        // only an `outward` reading hands an exit out, or takes one handed out
        if (flagged !== null && (flagged.handed !== undefined || flagged.twoLevel?.outward === true)) {
          handedFallbacks.set(h, () => fromFlagged(false));
        }
      }
    }
  }
  // AN OUTWARD EXIT TAKES BOTH LOOPS OR NEITHER. Each loop's outward rung reads its own edges, so the
  // enclosing loop's `handed` must name exactly the hits the inner loop took for its outward exit, to
  // the one target; a loop whose partner read the edge another way (or not at all) goes back to what
  // it would have taken without the rung, and a loop left unread declines loud where it is emitted.
  for (let changed = true; changed;) {
    changed = false;
    for (const [h, fallback] of handedFallbacks) {
      const fl = foreverLoops.get(h)!;
      const parent = forest.parent.get(h);
      const outer = parent !== null && parent !== undefined ? foreverLoops.get(parent) : undefined;
      const handedOk = [...(fl.handed ?? [])].every(([child, from]) => {
        const inner = foreverLoops.get(child)?.twoLevel;
        return (
          inner?.outward === true &&
          inner.from.size === from.size &&
          [...from].every((b) => inner.from.has(b) && successorsOf(b).includes(inner.to))
        );
      });
      const outwardOk =
        fl.twoLevel?.outward !== true || (outer?.handed?.get(h) !== undefined && handedFallbacks.has(parent!));
      if (!handedOk || !outwardOk) {
        foreverLoops.delete(h);
        handedFallbacks.delete(h);
        fallback();
        changed = true;
      }
    }
  }

  // --- coalesce SSA values to variable names ---
  const varName = new Map<Value, string>();
  const varType = new Map<string, IrType>();
  // Global symbols referenced by name (agbcc pool `.word gSym`, lowered by the global read/write
  // paths below). They print as bare `gSym`, declared by the project headers — so they are
  // EXCLUDED from the emitted local declarations (localNames below).
  const globalNames = new Set<string>();
  const entry = fn.blocks[0];
  entry.params.forEach((p, i) => {
    varName.set(p, `a${i}`);
    varType.set(`a${i}`, p.type);
  });
  /** The function's own parameters, as VALUES — `FRESH_MERGE_GATES`' `param-rooted` half. A name
   *  test would not do: a loop variable that adopted `a0` carries the name without being the
   *  parameter. */
  const entryParams = new Set<Value>(entry.params);
  /** Merge params that took a fresh home because `param-rooted` refused their parameter carrier —
   *  the set's other half, so a further merge carrying one of them is refused too. It records the
   *  merges that ended up FRESH and no others: one that refuses a parameter and then adopts an
   *  ordinary local passes the value on under that local's name (336 firings over 6 corpus rows),
   *  which is the chain-rooted widening rather than this rule. */
  const paramSeededMerges = new Set<Value>();
  const backArgName = new Map<Value, string>();
  /** The loop header each `backArgName` entry was seeded by. */
  const backArgHeader = new Map<Value, Block>();
  // The C static type of a rendered expression, over the declared variable types — what decides
  // whether a memory access's base may be dereferenced as spelled (memAccess/arrayAccess).
  const vtEnv = (n: string): IrType | undefined => varType.get(n);
  const ctype = (e0: Expr): IrType | undefined => exprCType(e0, vtEnv);

  // ── POINTER/INTEGER spelling (structure/pointer-spelling.ts) ────────────────────────────────
  // Whether an operand, a temp's value or a pointer cell's value is written as a pointer or as an
  // integer, and through which cast. `varType` and `varName` are read live: the naming below is
  // still declaring temps.
  const {
    pointerGlobal,
    castsIntoGlobal,
    needsIntSpelling,
    intoDeclaredTemp,
    intoPtrCell,
    arith: spellArith,
  } = makePointerSpelling({
    sym: symCtx,
    pointerGlobals,
    pointerLoadedGlobals,
    wordLoadedGlobals,
    scalarGlobals,
    varType,
    compiler: opts,
    strictPointerConversions,
    ...(dialect !== undefined ? { dialect } : {}),
    refuse: (why) => {
      throw new StructureError(`cannot structure '${fn.name}': ${why}`);
    },
    useSitesOf,
    isNamed: (v) => varName.has(v),
  });

  let fresh = 0;
  // Materialized defs are named FIRST: the temp is the register the compiler held the
  // value in, so downstream coalescing (loop inits, merge params) may adopt it — subject to the
  // same interference check as any other name.
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (materialize.has(op)) {
        const r = op.results[0];
        const name = `v${fresh++}`;
        varName.set(r, name);
        varType.set(name, r.type);
      }
    }
  }
  // Interference check: may block-param `p` of block B adopt `name`? The in-edge copies into
  // `name` execute just before B, and inside/after B the name means p — so it is a silent
  // clobber if ANY other value already under that name is still LIVE at B's entry (the textbook
  // "two live values merged into one variable"), or if a SIBLING param of B claimed it (one
  // edge would then write the name twice).
  //
  // AND THE CONVERSE: the name must not be WRITTEN anywhere `p` itself is live. Every other
  // block param under the name is such a write — its in-edge copies execute at each
  // predecessor's end, and a LOOP header's update copy is emitted inside the loop body, where it
  // also runs on the final (exiting) iteration — so the test is `p` live out of any of the writing
  // block's predecessors, the conservative union that covers that placement. A materialized def
  // under the name writes at its own block. This applies even to a redundant-phi alias
  // (`pureAlias` waives only the value-at-B check: aliasing is sound at B's entry, but a later
  // write to the shared name still splits them — e.g. a saved pre-increment `i` read post-loop).
  //
  // EXCEPT WHERE THE WRITE STORES `p`. A predecessor all of whose edges hand that slot `p` itself
  // writes `name = name` once the two share the name, so it stores nothing to clobber and
  // relocating it reaches nowhere. That predecessor is a loop's own accumulator update, and
  // without the exception the rule calls a value a clobber of itself.
  const paramBlock = new Map<Value, Block>();
  for (const blk of fn.blocks) {
    for (const pv of blk.params) {
      paramBlock.set(pv, blk);
    }
  }
  // AND THE NAME MUST BE EXACTLY AS WIDE AS `p`. Every edge into `B` copies its argument into
  // `name`, which is a C assignment through `name`'s declaration, and the name's type is fixed by
  // its FIRST claimant — so a width mismatch loses a truncation in one direction or the other:
  //   • name NARROWER than the merged value truncates it. `u8 a0` (raise/paramwidth.ts) adopted by
  //     a merge of `a0` with `0x1234` emits `a0 = 4660`, which agbcc compiles to 52.
  //   • name WIDER than a narrow carrier drops the extension the carrier's declaration WAS. A
  //     narrow block parameter (raise/narrowlocal.ts) has had its one reading extension deleted
  //     against the promise that reading the local re-applies it, so adopting an `s32` name emits
  //     `*out = a0` where the graph says `*out = (s16)a0` — a silent wrong answer, not a worse one.
  // Register-width carriers are unaffected — a pointer or an `unknown` is a full word, so the two
  // narrow-typing passes are the only producers either half can see.
  //
  // AND AT A SUB-WORD WIDTH, THE SIGNEDNESS IS PART OF THE WIDTH. A narrow declaration is where
  // the extension went, and `u8` re-applies a DIFFERENT extension than `s8` — same bytes in the
  // variable, different value at every read. `sa3`'s `sub_80B4654` (the IR is built in
  // test/narrow-local.test.ts) merges a `zext8` arm with its own `u8` parameter and reads the merge
  // through `lsls #24 / asrs #24`: the carrier is `s8`, and
  // letting it adopt the `u8` parameter's name emits `sub_80B4FA8(a0, a1, …)`, which passes 144
  // where the target passes -112 for every byte with bit 7 set. Width alone said 8 === 8 and
  // admitted it — a silent wrong answer, not a worse score. At 32 bits the two spellings ARE the
  // same bytes at a read, which is the mismatch `structure/namecoalesce.ts`'s header names and this
  // rule deliberately still tolerates.
  //
  // THE RULES ARE A TABLE (`CARRIER_NAME_GATES`), so each one can be dropped and the pass re-run on
  // real input — see docs/level-tower.md. What is computed here is the EVIDENCE; which evidence
  // refuses is the table's to say.
  const carrierScan = (p: Value, B: Block, name: string): { carrierLive: boolean; carrierWritten: boolean } => {
    const lin = liveIn.get(B)!;
    let carrierLive = false;
    let carrierWritten = false;
    for (const [v, n] of varName) {
      if (n !== name || v === p) {
        continue;
      }
      carrierLive ||= lin.has(v); // v still live at B → p's copies clobber it
      const wblk = paramBlock.get(v);
      if (wblk && wblk !== entry) {
        // v is a param → `name` is written by the in-edge copies into wblk, and by any relocation
        // of one of them. AN EDGE THAT HANDS THIS SLOT `p` ITSELF IS NOT A WRITE: once the two
        // share the name the copy reads `name = name`, so it stores nothing to clobber and
        // relocating it reaches nowhere. Per PREDECESSOR rather than per edge, because the
        // relocation is a property of the predecessor's placement — a terminator with two edges
        // into wblk is exempt only if BOTH hand it `p`.
        const slot = wblk.params.indexOf(v);
        const storesOther = new Map<Block, boolean>();
        for (const { pred, succ } of inEdgeRecords(preds, wblk)) {
          storesOther.set(pred, (storesOther.get(pred) ?? false) || succ.args[slot] !== p);
        }
        for (const [pr, other] of storesOther) {
          if (!other) {
            continue;
          }
          for (const s of successorsOf(pr)) {
            carrierWritten ||= liveIn.get(s)!.has(p);
          }
        }
      }
      const d = defs.get(v);
      carrierWritten ||= !!d && materialize.has(d) && liveIn.get(opBlock.get(d)!)!.has(p);
      if (carrierLive && carrierWritten) {
        break;
      }
    }
    return { carrierLive, carrierWritten };
  };
  const canTakeName = (p: Value, B: Block, name: string, pureAlias = false, ownName = true): boolean => {
    const lin = liveIn.get(B)!;
    let scan: ReturnType<typeof carrierScan> | undefined;
    const scanned = (): ReturnType<typeof carrierScan> => (scan ??= carrierScan(p, B, name));
    // AND A VALUE NOBODY NAMED IS STILL A READER OF THIS NAME. `carrier-live` asks which NAMED
    // values are live at `B`; an unnamed one is not stored anywhere, it is RE-DERIVED at its use
    // from whatever its operands are called then — so a value live into `B` whose inlined
    // expression mentions `name` reads the merge's assignment instead of what it was defined from.
    // `s32 t = a - b; if (a > 0) { a = a + b; } return a + t;` is the whole shape: `t` is inlined,
    // the merge takes `a0`, and the emitted `return a0 + (a0 - a1)` computes 13 where the asm
    // computes 10 — agbcc emits exactly that asm, so this is not a generated-IR curiosity. The
    // walk stops at any value with a name of its own (it reads THAT name) and at a materialized
    // def (it is assigned at its own position, which the clause above already judges).
    //
    // `viaBackArg` asks the `back-arg-live` question instead: the walk is the same, and what it
    // looks for is a loop's back-edge argument carrying `name` through `backArgName`, so that the two
    // gates' evidence stays disjoint and each one's ablation is its own claim.
    // The exit regions that render a back-edge argument AS its loop variable's name are the ones
    // under the loop's substitution — a self-loop's and a do-while's (`withSub`). A test-at-top
    // `while` installs none: past it the argument is re-derived from its operands, which the plain
    // walk judges.
    const rendersAsBackArgName = (w: Value): boolean => {
      const h = backArgHeader.get(w);
      return h !== undefined && (loops.has(h) || doWhileLoops.has(h));
    };
    const reDerives = (w: Value, seen: Set<Value>, viaBackArg: boolean): boolean => {
      if (w === p || seen.has(w)) {
        return false;
      }
      seen.add(w);
      const nm = varName.get(w);
      if (nm !== undefined) {
        return !viaBackArg && nm === name;
      }
      if (viaBackArg && backArgName.get(w) === name && rendersAsBackArgName(w)) {
        return true;
      }
      const d = defs.get(w);
      if (!d || materialize.has(d)) {
        return false;
      }
      return d.operands.some((o) => reDerives(o, seen, viaBackArg));
    };
    // `back-arg-live` looks where the in-edge copies LAND, which is more than `B`'s entry when the
    // edge leaves a loop from its latch: the do-while and self-loop emitters sink that exit copy into
    // the body, so what is live into that loop's header is live at the copy. A predecessor all of
    // whose edges hand the slot a value already under `name` writes nothing. The sink gate
    // (`dest-free-inside-loop`) refuses an unnamed value that renders the name through `varName`, but
    // not one that renders it as an earlier loop's back-edge argument, so this rule is that case's
    // only guard. `re-derives` is the sink gate's there, and reads `B`'s entry alone.
    let landed: Set<Value> | undefined;
    const landing = (): Set<Value> => {
      if (landed) {
        return landed;
      }
      landed = new Set(lin);
      const slot = B.params.indexOf(p);
      const writes = new Map<Block, boolean>();
      for (const { pred, succ } of inEdgeRecords(preds, B)) {
        writes.set(pred, (writes.get(pred) ?? false) || varName.get(succ.args[slot]) !== name);
      }
      for (const [pr, w] of writes) {
        for (const s of w ? successorsOf(pr) : []) {
          if (forest.byHeader.get(s)?.body.has(pr)) {
            liveIn.get(s)!.forEach((v) => landed!.add(v));
          }
        }
      }
      return landed;
    };
    return (
      firstRejection(hooks.carrierNameGates ?? CARRIER_NAME_GATES, {
        pureAlias,
        ownName,
        widthDiffers: carrierWidth(varType.get(name)) !== carrierWidth(p.type),
        signDiffers: carrierSign(varType.get(name)) !== carrierSign(p.type),
        siblingHolds: B.params.some((q) => q !== p && varName.get(q) === name),
        get carrierLive() {
          return scanned().carrierLive;
        },
        get carrierWritten() {
          return scanned().carrierWritten;
        },
        get reDerivesName() {
          // NAMED live values are `carrier-live`'s, so the two rules stay disjoint and each one's
          // ablation is its own claim. The walk itself still crosses into a named OPERAND, which
          // is the whole point of it.
          return [...lin].some((w) => !varName.has(w) && reDerives(w, new Set(), false));
        },
        get backArgReadsName() {
          return [...landing()].some((w) => !varName.has(w) && reDerives(w, new Set(), true));
        },
      }) === null
    );
  };
  // Does the edge `pr -> b` hand `c` over as a loop variable's PRE-update value? True when `c` is a
  // loop header's own param and the edge leaves the loop from a latch of an emitter that places
  // the update at the BOTTOM of the body — the self-loop `while` and the `do-while`. `c` there
  // means the value the variable held at the top of the exiting iteration, so a merge param
  // sharing its name would read one iteration on, silently. Keeping the names apart is also what
  // lets those emitters sink the copy into the body; sharing them would make it a self-assignment.
  //
  // Four shapes are NOT this, and must keep coalescing:
  //   - the loop is emitted by neither of those two. A test-at-top `while` puts its exit copies in
  //     the sibling arm of the latch's `cond_br`, AHEAD of the update, so the name is still the
  //     top-of-iteration value there (`while (p) { if (p->key == k) return p; p = p->next; }`);
  //   - the edge leaves from the HEADER rather than a latch — same reason;
  //   - the back-edge arg for `c`'s own slot is `c`: that slot is never rewritten;
  //   - `c` is itself a back-edge arg — the compiler already carries the trailing value in a
  //     second loop variable, so the un-rotation substitution reads it under that one's name.
  //     Same exemption `readsClobbered` makes for a `sub`-mapped value.
  const carriesPreUpdate = (c: Value, pr: Block, b: Block): boolean => {
    const header = paramBlock.get(c);
    const nl = header && forest.byHeader.get(header);
    if (!nl || nl.body.has(b) || !nl.body.has(pr)) {
      return false;
    }
    if (!loops.has(header!) && doWhileLoops.get(header!)?.latch !== pr) {
      return false;
    }
    const back = successorTo(pr, header!);
    const k = header!.params.indexOf(c);
    return !!back && k >= 0 && back.args[k] !== c && !back.args.includes(c);
  };
  // A NESTED LOOP'S CARRIED VALUE KEEPS THE NAME ITS ENCLOSING LOOP GAVE IT. `p`, a param of the
  // inner header, is entered straight from the enclosing loop's header `E` with `E`'s own param —
  // an accumulator (or any loop-carried value) crossing into the inner loop. Minting `p` a fresh
  // name spells `v3 = v1; do { … v3 … } while (…); v1 = v3;`, and on agbcc that pair is two `mov`s
  // the target does not contain. Whether the source had ONE variable or TWO is what the frontend's
  // write-order record answers: `E` wrote nothing into `p`'s key, so the machine carried the value
  // into the inner loop in the register it already had — there is no copy to reproduce.
  //
  // THE NARROW FORM OF A PROXY THAT WAS MEASURED AND LOST. `target.ts`'s MIPS_GCC note records the
  // wide form — adopt the entry value's name whenever the forward predecessor did not write the
  // param's key — moving 36 of 736 synthetic rows for four matches lost net, because a predecessor
  // that COMPUTES the initial value into the param's own register writes the key and still
  // coalesces. Here the argument is `E`'s own parameter, which `E` does not compute: `E` can write
  // `p`'s key only by moving that value into it, which is the copy the two-variable spelling spells.
  // So in this scope the record answers the question exactly, and the measured reach is 4 rows over
  // the 1,036 of the corpus, all four moved toward the target.
  //
  // The argument above is an agbcc one (two `mov`s). The rule has no compiler gate, and it reaches
  // no corpus row on any other toolchain (0 of the MIPS and PPC rows change), so for those the claim
  // is UNMEASURED rather than established.
  //
  // THE REFUSALS ARE A TABLE (`ENCLOSING_CARRIER_GATES`, in table order), and then `canTakeName`'s.
  // `p` keeps the seeding below when:
  //   • `one-forward-entry` / `enclosing-header`: `p` has more than one forward predecessor, or its
  //     one forward predecessor is not the header of a loop that strictly encloses `p`'s header.
  //     That is a limit of the DATUM, not of the hazard: the record is keyed by successor params,
  //     and a single-predecessor block has none, so it cannot say whether a block between `E` and
  //     the inner header made the copy. It is also what holds the rule to the unguarded,
  //     constant-trip nest: nestacc1 with its inner bound `j < 7` made `j < n` is entered through
  //     its guard and keeps both copies (measured, agbcc). The register-key identity the MIPS_GCC
  //     note names (`frontend/ssa.ts` `phiKey`) is the datum that would lift it;
  //   • `enclosing-param`: the argument is not one of `E`'s own params (it is not `E`'s
  //     loop-carried value);
  //   • `key-written`: the frontend did not measure `E`, or measured it WRITING `p`'s key — the
  //     copy the source spelled, which the fresh name reproduces;
  //   • `carried-by-one-loop`: the value is not carried by BOTH loops (`carriedByBothLoops`, below).
  //     The one SOUND rule of the five; the four above bound the evidence, and dropping one spells
  //     a different program that is still correct;
  //   • `canTakeName` refuses. With the clause above, these are the guards against the collision
  //     `enclosingNames` excludes wholesale: a value of `E` still read after the inner loop is
  //     `carrier-live`, and an unnamed one re-derived from it there (the outer update
  //     `(u8)(v0 + 1)`) is `re-derives`. `canTakeName` alone is NOT enough — it reads `varName`
  //     only, and sharing the name reaches two readers that are not in it.
  //
  // THE VALUE MUST BE CARRIED BY BOTH LOOPS — the per-site form of `structure/namecoalesce.ts`'s
  // `loop-escape` premise. Sharing the name hands it to more values than `p`: the inner back edge's
  // argument takes it through `backArgName` (unconditionally, in `seedLoopParams`), and `E`'s own
  // back-edge argument for `a`'s slot takes it as the outer loop's un-rotation alias. If the outer
  // back edge hands `a`'s slot something the inner loop did not produce, the outer update copy
  // overwrites the name the inner loop's value is read under, and a merge after the loop that
  // adopts that value's `backArgName` reads the outer value instead. That is the frozen
  // `INNER_CLOBBERS_OUTER` pair (`fz5104`, `fz6437`, in `test/loop-escape-witnesses.ts`, replayed
  // against this rule by `nested-carrier.test.ts`): given ONE realistic record fact — `E`
  // did not write `p`'s key, nestacc1's own shape — the rule without this clause emits both as a
  // different program, and nothing throws. So every in-edge of `E` from inside its loop must hand
  // `a`'s slot either `a` (then `a` is live across the inner loop, and `carrier-live` refuses), `p`
  // (what the name holds when a test-at-top `while` exits from its header; after a bottom-tested
  // loop it is a pre-update read, the inner emitter's own hazard and the same one whichever name
  // `p` has), an inner back-edge argument for `p`, or a merge every in-edge of which hands it one of
  // those. One level of merge, not a closure: a deeper chain refuses, which costs reach and never
  // soundness.
  const carriedByBothLoops = (p: Value, i: number, header: Block, E: Block, a: Value): boolean => {
    const outer = forest.byHeader.get(E);
    const inner = forest.byHeader.get(header);
    if (!outer || !inner) {
      return false;
    }
    const carried = new Set<Value>([a, p]);
    for (const { pred, succ } of inEdgeRecords(preds, header)) {
      if (inner.body.has(pred)) {
        carried.add(succ.args[i]);
      }
    }
    const k = E.params.indexOf(a);
    if (k < 0) {
      return false; // not `E`'s loop-carried value — `enclosing-param`'s question, asked again
    }
    let backEdges = 0;
    for (const { pred, succ } of inEdgeRecords(preds, E)) {
      if (!outer.body.has(pred)) {
        continue;
      }
      backEdges++;
      const r = succ.args[k];
      if (carried.has(r)) {
        continue;
      }
      const rb = paramBlock.get(r);
      if (rb === undefined || rb === entry) {
        return false;
      }
      const j = rb.params.indexOf(r);
      let ins = 0;
      for (const { succ: s } of inEdgeRecords(preds, rb)) {
        ins++;
        if (!carried.has(s.args[j])) {
          return false;
        }
      }
      if (ins === 0) {
        return false;
      }
    }
    return backEdges > 0;
  };
  const enclosingCarrierName = (
    p: Value,
    i: number,
    header: Block,
    forwardPreds: readonly Block[],
  ): string | undefined => {
    const [E] = forwardPreds;
    const a = E === undefined ? undefined : successorTo(E, header)?.args[i];
    const order = fn.writeOrder;
    const refused = firstRejection(hooks.enclosingCarrierGates ?? ENCLOSING_CARRIER_GATES, {
      oneForwardEntry: E !== undefined && E !== header && forwardPreds.every((fp) => fp === E),
      get entryEncloses() {
        return E !== undefined && forest.byHeader.get(E)?.body.has(header) === true;
      },
      get argIsEnclosingParam() {
        return a !== undefined && E!.params.includes(a);
      },
      get keyUnwritten() {
        return E !== undefined && order?.writes.has(E) === true && order.lastWrite.get(E)?.has(p) !== true;
      },
      get carriedByBoth() {
        return E !== undefined && a !== undefined && carriedByBothLoops(p, i, header, E, a);
      },
    });
    const nm = a === undefined ? undefined : varName.get(a);
    return refused === null && nm !== undefined && canTakeName(p, header, nm) ? nm : undefined;
  };
  /** Where in `header` an op reading a loop variable RENDERS, for the in-place adoption below: at
   *  its own index when it is a statement, at the consumer it inlines into otherwise (`emitPos`) —
   *  `%t = v1 - v0` ahead of the adopted def, inlined into a call after it, reads the name after
   *  the assignment has overwritten it. A tree the header's TERMINATOR carries renders there, at the
   *  bottom, with one exception: a self-loop's EXIT arg renders at its ROOT's own index, which is
   *  where a sunk exit copy is rebuilt (`preUpdateCopyHome`), while a kept one renders after the
   *  loop, where the hazard checks already count the in-place write (`loopWriteSet`). A tree the
   *  back edge also carries is an update copy, and renders at the bottom. So a read never renders
   *  EARLIER than its SSA position says, and the rule only ever refuses more. Null — refuse — where
   *  the read renders in several places or outside the header, or in an exit arg with no home. */
  const readRenderIdx = (op: Op, header: Block): number | null => {
    const pos = emitPos(op);
    if (pos === null || pos.blk !== header) {
      return null;
    }
    const term = header.ops[header.ops.length - 1];
    if (pos.idx !== opIndex.get(term) || !term.successors.some((sc) => sc.block === header)) {
      return pos.idx;
    }
    for (let cur = op; cur !== term;) {
      const cons = [...new Set((useSitesOf.get(cur.results[0]) ?? []).map((u) => u.op))];
      if (cons.length !== 1) {
        return null;
      }
      if (cons[0] === term) {
        const root = cur.results[0];
        if (term.successors.some((sc) => sc.block === header && sc.args.includes(root))) {
          return pos.idx;
        }
        const home = preUpdateCopyHome(defs, opBlock, root, header);
        return home === null ? null : opIndex.get(home)!;
      }
      cur = cons[0];
    }
    return pos.idx;
  };
  // ONE seeding routine for self-loop and structured-loop headers. On a coalesceLoopInit target,
  // keep the induction variable in its entry (forward-edge) value's register — reproducing a
  // compiler that mutates the arg register across the loop instead of copying to a fresh local,
  // so the init copy vanishes. The loop mutates the adopted name every iteration — canTakeName
  // declines it when any value under it is still live at the header. `exclude` are names never to
  // adopt (enclosing loops' induction vars — the cross-level collision below) except through
  // `enclosingCarrierName`, which measures the collision instead; every seeded param's name is
  // ADDED to it, so sibling params can't collapse.
  const seedLoopParams = (
    header: Block,
    forwardPreds: Block[],
    backArgs: readonly Value[] | null,
    exclude: Set<string>,
  ): void => {
    header.params.forEach((p, i) => {
      if (!varName.has(p)) {
        let name: string | undefined;
        if (coalesceLoopInit) {
          for (const fp of forwardPreds) {
            const nm = varName.get(successorTo(fp, header)?.args[i] as Value);
            if (nm && !exclude.has(nm) && canTakeName(p, header, nm)) {
              name = nm;
              break;
            }
          }
        }
        name ??= enclosingCarrierName(p, i, header, forwardPreds);
        // A MATERIALIZED back-edge arg is this variable's in-place update (`add r4, r4, r0`
        // mutates the same register the param lives in) — adopt its name so the def assigns the
        // loop variable directly and the update copy elides. Sound only when every read of the
        // param sits at-or-before the def in the header (the def's own operands included): the
        // assignment splits the iteration into old-value-before / new-value-after, and a later
        // read of the OLD value would silently get the new one — position-granular, because
        // liveness is block-granular and the param is killed from its own block's liveIn. And the
        // position is where the read RENDERS, not where SSA put it (`readRenderIdx`).
        if (name === undefined) {
          const ba = backArgs?.[i];
          const d = ba !== undefined ? defs.get(ba) : undefined;
          const nm = ba !== undefined ? varName.get(ba) : undefined;
          if (
            nm !== undefined &&
            !exclude.has(nm) &&
            d !== undefined &&
            materialize.has(d) &&
            opBlock.get(d) === header &&
            (useSitesOf.get(p) ?? []).every((s) => {
              const at = s.op === d ? s.idx : readRenderIdx(s.op, header);
              return at !== null && at <= opIndex.get(d)!;
            }) &&
            canTakeName(p, header, nm)
          ) {
            name = nm;
          }
        }
        name ??= `v${fresh++}`;
        varName.set(p, name);
        if (!varType.has(name)) {
          varType.set(name, p.type);
        }
      }
      exclude.add(varName.get(p)!);
      // THE BACK-EDGE ARGUMENT TAKES THE HEADER'S NAME, UNCONDITIONALLY — so if `p` is declared
      // NARROW, every other reader of that argument reads it through the truncation. This site
      // does not check that, and deliberately: the promise is a precondition of producing a narrow
      // block parameter at all, held by `raise/narrowlocal.ts`'s `edge-reader` gate (every in-edge
      // value is read nowhere but through an extension no wider than the declaration keeps). A
      // width test HERE would be the wrong shape — it would refuse the loop's own update copy and
      // silently un-coalesce it. Any future producer of a sub-word block parameter owes the same
      // gate; without it this line emits `s16 v; do { … v = v + 1; } while (v < 32768);`, which
      // agbcc compiles to an unconditional branch.
      if (backArgs) {
        backArgName.set(backArgs[i], varName.get(p)!);
        backArgHeader.set(backArgs[i], header);
      }
    });
  };
  // Self-loop headers seed FIRST, with an EMPTY exclusion set. KNOWN GAP: a nested self-loop
  // (a guard-fused inner loop inside a structured loop DOES structure) seeds before the
  // enclosing loop's induction name exists to exclude — the outermost-first discipline below
  // does not cover this ordering. canTakeName's liveness/write-site checks are the only guard
  // against a cross-level name adoption here.
  for (const li of loops.values()) {
    const fwdPreds = (preds.get(li.header) ?? []).filter((pr) => pr !== li.header);
    seedLoopParams(li.header, fwdPreds, li.backArgOfParam, new Set());
  }
  // Seed structured-loop (`while`/`do-while`) header params: same discipline as self-loops. On
  // coalesceLoopInit, keep the loop variable in its forward-edge (init) register; else a fresh local
  // (agbcc copies the init to a new reg). Never reuse a name already taken by a SIMULTANEOUSLY-LIVE
  // sibling header param — two loop-carried values seeded from one source must not collapse (a silent
  // clobber). The latch's back-edge arg carries the param's name so the loop update assigns it.
  // A `while (1)` is seeded the same way, and its back-edge args are its latches' when they all hand
  // the header the same ones: latches that differ leave the param a name of its own, and each
  // back edge a copy into it. Seeding is what keeps the merge naming below from handing the param a
  // value the body computes while the param is still read.
  const onlyBackArgs = (header: Block, latches: readonly Block[]): readonly Value[] | null => {
    const [first, ...rest] = latches.map((l) => successorTo(l, header)?.args ?? null);
    return first !== null && rest.every((a) => a !== null && a.every((v, k) => v === first[k])) ? first : null;
  };
  const structuredLoops = [
    ...[...whileLoops.values(), ...doWhileLoops.values()].map((l) => ({
      header: l.header,
      backArgs: successorTo(l.latch, l.header)?.args ?? null,
      forwardPreds: l.forwardPreds,
      body: l.body,
    })),
    ...[...foreverLoops.values()].map((l) => ({
      header: l.header,
      backArgs: onlyBackArgs(l.header, l.latches),
      forwardPreds: l.forwardPreds,
      body: l.body,
    })),
  ];
  // Cross-level collision: with nesting, an outer loop's induction variable is LIVE across the inner
  // loop (the outer latch reads it after). If the inner var is coalesced onto the outer var's name
  // (its init reads the outer var), the inner loop would MUTATE the outer variable — a silent
  // miscompile. Process OUTERMOST-first (so an enclosing loop is named first) and, per loop, exclude
  // the names of every enclosing loop's header params from the coalescing candidates — all but the
  // one `enclosingCarrierName` hands over with the evidence and the `canTakeName` check above.
  // `enclosingNames(l)` = names of params of headers whose natural body strictly contains `l.header`.
  structuredLoops.sort((a, b) => b.body.size - a.body.size); // outermost first
  const enclosingNames = (l: { header: Block; body: Set<Block> }): Set<string> => {
    const names = new Set<string>();
    for (const nl2 of forest.byHeader.values()) {
      if (nl2.header !== l.header && nl2.body.has(l.header)) {
        // nl2 strictly encloses l
        for (const p of nl2.header.params) {
          const nm = varName.get(p);
          if (nm) {
            names.add(nm);
          }
        }
      }
    }
    return names;
  };
  for (const l of structuredLoops) {
    // exclusion seeded with enclosing-loop names → never coalesce onto them
    seedLoopParams(l.header, l.forwardPreds, l.backArgs, enclosingNames(l));
  }
  // THE IV'S EXIT (THE LOOP AS A `for`, at `forPlanAt`): in a run that asks a loop's `for`, an exit
  // param the guard's edge (or its relay's) hands the IV's init arg and the latch's edge its update
  // is the IV past the loop — `for (i = lo; ..) { .. } k(i);`. The `for` leaves it in the IV's name
  // on both edges its test leaves by, so the param takes that name ahead of the guard's carrier,
  // whose name the latch's edge would have to copy into and the `for` cannot. Only a preference: the
  // name is taken under the same `canTakeName` as any carrier's, and an unasked run never reads it.
  const ivExitCarrier = new Map<Value, Value>();
  for (const fl of foreverLoops.values()) {
    const h = fl.header;
    const [latch] = fl.latches;
    const [into] = fl.forwardPreds;
    if (
      fl.exit === null ||
      fl.latches.length !== 1 ||
      fl.forwardPreds.length !== 1 ||
      (!spellCountedLoopsFor && !forRank.asked.has(h))
    ) {
      continue;
    }
    // the guard: the header's one way in, or the one block entering a preheader `br`
    const intoTerm = into.ops[into.ops.length - 1];
    const intoFrom = preds.get(into) ?? [];
    const g = intoTerm.opcode === 'br' && intoFrom.length === 1 ? intoFrom[0] : into;
    const gterm = g.ops[g.ops.length - 1];
    const out = gterm.opcode === 'cond_br' ? gterm.successors.find((sc) => sc.block !== into) : undefined;
    const relay = out?.block.ops.length === 1 ? out.block.ops[0] : undefined;
    const guardExit =
      out?.block === fl.exit
        ? out
        : relay?.opcode === 'br' && relay.successors[0]?.block === fl.exit
          ? relay.successors[0]
          : undefined;
    const back = successorTo(latch, h);
    const latchExit = successorTo(latch, fl.exit);
    const initEdge = successorTo(into, h);
    if (guardExit === undefined || back === undefined || latchExit === undefined || initEdge === undefined) {
      continue;
    }
    fl.exit.params.forEach((p, i) => {
      const j = back.args.indexOf(latchExit.args[i]);
      if (j >= 0 && initEdge.args[j] === guardExit.args[i] && backArgName.has(back.args[j])) {
        ivExitCarrier.set(p, back.args[j]);
      }
    });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of fn.blocks) {
      if (b === entry) {
        continue;
      }
      b.params.forEach((p, i) => {
        if (varName.has(p)) {
          return;
        }
        const incoming: { v: Value; pr: Block }[] = [];
        for (const { pred, succ } of inEdgeRecords(preds, b)) {
          incoming.push({ v: succ.args[i], pr: pred });
        }
        // A redundant phi (every edge passes the SAME value) is a pure alias of it — sharing the
        // value's own name is sound even while the value stays live (they are equal on every path).
        // This waives `carrier-live` and `re-derives`; the sibling-param check always applies.
        const allSame = incoming.length > 0 && incoming.every((c) => c.v === incoming[0].v);
        // prefer a carrier that already has a name; then a loop var whose update this receives —
        // but only one whose name survives the C3 interference check (else the edge copies into
        // the name would clobber a still-live value).
        let name: string | undefined;
        /** Set when `FRESH_MERGE_GATES` refused a carrier here — not "the one reason this merge
         *  went unnamed", since the rejections above it `continue` without recording. Over-marking
         *  costs one downstream merge an extra fresh home, a spelling the differ referees. */
        let refusedParamCarrier = false;
        const ivCarrier = ivExitCarrier.get(p);
        for (const c of [
          ...incoming.filter((c) => c.v === ivCarrier).map((c) => ({ ...c, iv: true })),
          ...incoming.filter((c) => varName.has(c.v)).map((c) => ({ ...c, iv: false })),
          ...incoming.filter((c) => backArgName.has(c.v)).map((c) => ({ ...c, iv: false })),
        ]) {
          const named = !c.iv && varName.has(c.v);
          const nm = named ? varName.get(c.v)! : backArgName.get(c.v)!;
          if (carriesPreUpdate(c.v, c.pr, b) || !canTakeName(p, b, nm, allSame, named)) {
            continue;
          }
          // `freshParamMerge` (the `/fresh-merge` variation): this merge takes its own home rather
          // than the carrier's name — `FRESH_MERGE_GATES` above holds the admission and the
          // argument for it. Absent the option nothing changes.
          if (
            freshParamMerge &&
            reHomesParamMerge(
              { allSame, paramRooted: entryParams.has(c.v) || paramSeededMerges.has(c.v) },
              hooks.freshMergeGates,
            )
          ) {
            refusedParamCarrier = true;
            continue;
          }
          name = nm;
          break;
        }
        if (name === undefined) {
          name = `v${fresh++}`;
          if (refusedParamCarrier) {
            paramSeededMerges.add(p);
          }
        }
        varName.set(p, name);
        if (!varType.has(name)) {
          varType.set(name, p.type);
        }
        changed = true;
      });
    }
  }

  // ── copy coalescing over the interference graph (namecoalesce.ts) ────────────────────────────
  // The walk above adopts a name only BACKWARD along an edge, once, in address order — so a merge
  // parameter whose arguments were still unnamed took a fresh one and kept it. With every name now
  // settled, `coalesceNames` asks which two of them a would-be copy joins and whether the values
  // under them ever interfere. Applied here, before anything reads the names: `anchorConstCopies`
  // below counts the values under a name, and emission spells them.
  if (coalesceMergeNames) {
    const { renames } = coalesceNames(
      {
        blocks: fn.blocks,
        entry,
        preds,
        liveIn,
        opBlock,
        opIndex,
        useSitesOf,
        defs,
        materialize,
        varName,
        varType,
        loops: [...forest.byHeader.values()].map((nl) => ({ header: nl.header, body: nl.body })),
      },
      hooks.nameCoalesceGates,
    );
    for (const [v, n] of varName) {
      const r = renames.get(n);
      if (r !== undefined) {
        varName.set(v, r);
      }
    }
    for (const [v, n] of backArgName) {
      const r = renames.get(n);
      if (r !== undefined) {
        backArgName.set(v, r);
      }
    }
  }

  // ── declaration-signedness reconciliation ──────────────────────────────────────────────────
  // A name's declared type is its FIRST claimant's, and the first claimant of a u32 loop counter
  // is often an s32-typed sibling (the pre-increment value, a const's copy) — so the counter
  // declares s32, every compare through it renders signed, and an unsigned icmp silently
  // compiles to the compare the machine never did (the compare-cast at CMP_TO_BIN patches the
  // sites it can see, but a later re-spell can substitute the var into a compare that needed no
  // cast at emission — the initfirst guard swap). The declaration is the honest fix: a name
  // flips to u32 when SOME value under it is u32-typed and NO value under it carries signed-use
  // evidence (the transitive input cone of any icmp_s* / sdiv / smod / shr_s). Only int32
  // declarations reconcile; the flip is byte-invariant everywhere but the unsigned compares it
  // corrects (+/-/*/&/|/^/<< are sign-blind; the signedness-carrying pairs — `>>`/`>>>` and
  // `/`/`%` against `/u`/`%u` — say which they are through the backend's operand pin, so no
  // declaration can change what they render; and SIGNED division is evidence-blocked).
  if (unsignedCompareSpelling) {
    // Signed-use evidence is the TRANSITIVE INPUT CONE of every signed op — a claimant can feed
    // an icmp_slt through an inline `sub` and the flip would still render that compare unsigned
    // (`v - 5 >= 0`, always true in C), so direct operands are not enough. The cone also crosses
    // edge arg↔param identities in BOTH directions: a kept-guard's substitution (gsub) renders an
    // init ARG under the loop variable's name, so a signed guard over the arg is evidence against
    // the name even though the arg claims it in neither naming map. Over-tainting only blocks
    // flips: conservative-safe.
    const SIGNED_USE = new Set(['icmp_slt', 'icmp_sle', 'icmp_sgt', 'icmp_sge', 'sdiv', 'smod', 'shr_s']);
    // The arg↔param identity is `ir/core.ts`'s `mergeClasses` — a CFG/SSA fact rather than a rule
    // of this pass, and a hand-rolled copy here is one more thing free to drift from it. The walk
    // below is transitive, so seeding it with the whole CLASS is the same closure as seeding it
    // with the direct peers.
    const edgePeers = mergeClasses(fn);
    const signedEvidence = new Set<Value>();
    const work: Value[] = [];
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (SIGNED_USE.has(op.opcode)) {
          work.push(...op.operands);
        }
      }
    }
    while (work.length) {
      const v = work.pop()!;
      if (!signedEvidence.has(v)) {
        signedEvidence.add(v);
        const d = defs.get(v);
        if (d) {
          work.push(...d.operands);
        }
        work.push(...(edgePeers.get(v) ?? []));
      }
    }
    // Params never reconcile: their declarations come from p.type, not varType, so a flip here
    // would only desync the cast site's view from the emitted declaration — and param signedness
    // is the signedness variation's dimension.
    const paramNames = new Set(entry.params.map((_, i) => `a${i}`));
    const claimants = new Map<string, Value[]>();
    for (const [v, n] of [...varName, ...backArgName]) {
      (claimants.get(n) ?? claimants.set(n, []).get(n)!).push(v);
    }
    for (const [n, vs] of claimants) {
      const t = varType.get(n);
      if (paramNames.has(n) || t?.kind !== 'int' || t.width !== 32 || !t.signed) {
        continue;
      }
      if (
        vs.some((v) => v.type.kind === 'int' && v.type.width === 32 && !v.type.signed) &&
        vs.every((v) => !signedEvidence.has(v))
      ) {
        varType.set(n, T.u(32));
      }
    }
  }

  // ── a temp holding a pointer global's value, summed with `x + K`, is a byte pointer ──────────
  // (pointer-spelling.ts `declaresBytePointer` says when.) Decided over every value under the name
  // once the names are settled, so a name that also holds anything else keeps its integer.
  if (keepsPointerSumAddend) {
    const inArgs = (v: Value): Value[] | undefined => {
      const b = paramBlock.get(v);
      if (b === undefined || entryParams.has(v)) {
        return undefined;
      }
      const i = b.params.indexOf(v);
      return [...inEdgeRecords(preds, b)].map(({ succ }) => succ.args[i]);
    };
    const ir = {
      defOf: (v: Value) => defs.get(v),
      inArgs,
      usesOf: (v: Value) => (useSitesOf.get(v) ?? []).map((u) => u.op),
      isNamed: (v: Value) => varName.has(v),
    };
    const holders = new Map<string, Value[]>();
    for (const [v, n] of [...varName, ...backArgName]) {
      (holders.get(n) ?? holders.set(n, []).get(n)!).push(v);
    }
    for (const [n, vs] of holders) {
      const t = varType.get(n);
      if (t?.kind === 'int' && t.width === 32 && declaresBytePointer(vs, ir, { pointerGlobal, castsIntoGlobal })) {
        varType.set(n, T.ptr(T.u(8)));
      }
    }
  }

  // ── def-site anchoring of constant merge copies (anchorConstCopies) ──────────────────────────
  // An edge copy `v = K` places the constant where the EDGE is, but the asm often materialized K
  // earlier: `movs r9, #0` at entry ahead of a single-armed overwrite, `movs r5, #1` at the top
  // of an arm ahead of a nested if. Anchoring the copy at the const op's own program position
  // reproduces that placement — the write is emitted as a statement there (sideEffects reads
  // `anchoredAt`) and the edge copies it replaces are suppressed (argAssignsFor reads
  // `suppressedArgs`). Where the surviving arm then empties, mkIf's empty-then peephole yields
  // the single-armed positive `if` the source wrote.
  //
  // REFUSAL CONDITIONS — each keeps the edge placement, never producing a different write:
  //   - the arg is not an UNNAMED `const` op (only a rematerializable constant carries
  //     unambiguous placement evidence; a named value's position is its materialized def's);
  //   - the merge is a LOOP HEADER, unless `anchorLoopEntryConsts` is also on and the loop is
  //     entered through ONE preheader with no value living outside the body under the same name.
  //     A loop header's entry arg is the one merge arg whose def sits legitimately far above its
  //     edge — `int s = 0;` ahead of a `for` accumulating into it — and the carried values that
  //     share its name are what the name rule below would refuse it on. Anchoring holds exactly
  //     when the name is written nowhere outside the loop but at the anchored site: the entry
  //     copy runs once, before the body, and every other write to it is a back-edge copy strictly
  //     after. Its own flag because it is a SECOND placement decision, and one boolean covering
  //     both would delete a spelling rather than add one (see the option's doc);
  //   - the const's block does not dominate every edge source passing it (the anchored write
  //     must precede the edge on every path);
  //   - the const's block or any edge source sits inside ANY loop. Block-level dominance does
  //     not give per-ITERATION precedence — a path may pass the def in iteration 1 and take the
  //     suppressed edge in iteration 2 with the variable overwritten in between, the /preinit
  //     sticky-arm failure class (PR #13) — so in-loop shapes are declined outright;
  //   - the merge variable names any OTHER SSA value (a shared name has readers and writers
  //     between the def site and the edge that edge placement respects and anchoring would not).
  //     A loop header's carried value is the exception above: its other claimants all live in
  //     the body. `freshParamMerge` WIDENS what this admits — a minted home is sole by
  //     construction — which is the pairing `/fresh-merge` and `/defsite` match `clampu8` on;
  //   - another anchored const of the same variable lies on a path from this one to this one's
  //     edge (the later write would clobber this arg's value; both stay at their edges instead).
  //
  // What the list does NOT cover is whether the def site is RENDERED at all; an anchor that lands
  // in an elided block declines the whole function instead, at the postcondition after the render.
  /** Where a value is WRITTEN: its block for a param, its def op's block otherwise — the two
   *  halves of "where is this defined" asked as one question. Used by def-site anchoring below to
   *  order a write against an edge, and by Regime-A switch recovery (through `SwitchRecoverDeps`)
   *  to ask whether a hoisted argument is available at the dispatch root; passed there rather than
   *  rebuilt, since `paramBlock` and `opBlock` are this scope's own. */
  const blockOf = (v: Value): Block | undefined => {
    const d = defs.get(v);
    return paramBlock.get(v) ?? (d === undefined ? undefined : opBlock.get(d));
  };
  type AnchoredWrite = { name: string; arg: Value };
  const anchoredAt = new Map<Op, AnchoredWrite[]>();
  const suppressedArgs = new Map<object, Set<number>>();
  /** Every anchored write `sideEffects` actually rendered. The other half of the postcondition
   *  below: suppressing an edge copy is a PROMISE that the def site emits the write instead, and
   *  only the render can report that the promise was kept. */
  const anchorsEmitted = new Set<AnchoredWrite>();
  if (anchorConstCopies) {
    const nameCount = new Map<string, number>();
    for (const n of varName.values()) {
      nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
    }
    const inLoop = (b: Block): boolean => {
      for (const nl of forest.byHeader.values()) {
        if (nl.body.has(b)) {
          return true;
        }
      }
      return false;
    };
    // conservative "a write in `a` may execute between one in `b` and `b`'s terminator": same
    // block counts (op order refined by the caller where it matters), else CFG reachability
    const mayFollow = (a: Block, b: Block): boolean => a === b || reachFrom(a).has(b);
    // A loop entered from ONE preheader — what makes "every write to the name outside the anchored
    // one is a back-edge copy" statable: the premise is over ONE entry edge. CONSERVATIVE: two
    // entry consts anchored at their own def sites would still order correctly, and this refuses
    // the shape rather than reasoning about it. The other half of "entered only through its
    // header" needs no test — `analyzeLoops` builds the body as the backward closure from the
    // latches with the header already in it (ir/loops.ts), so a body block's predecessors are all in
    // the body by construction.
    const singleEntry = (nl: NaturalLoop): boolean => nl.forwardPreds.length === 1;
    for (const M of fn.blocks) {
      if (M === entry || M.params.length === 0) {
        continue;
      }
      const loop = anchorLoopEntryConsts ? forest.byHeader.get(M) : undefined;
      if (forest.byHeader.has(M) && (loop === undefined || !singleEntry(loop))) {
        continue;
      }
      M.params.forEach((p, i) => {
        const name = varName.get(p)!;
        // the name belongs to this merge alone — or, at a loop header, to this merge and the
        // body's own carried values, which are written only on the back edge
        const soleClaimant =
          nameCount.get(name) === 1 ||
          (loop !== undefined &&
            [...varName].every(([v, n]) => {
              if (n !== name || v === p) {
                return true;
              }
              const b = blockOf(v);
              return b !== undefined && loop.body.has(b);
            }));
        if (!soleClaimant) {
          return;
        }
        // every in-edge record into M, grouped by the SSA value it passes for param i
        const groups = new Map<Value, { rec: { block: Block; args: Value[] }; src: Block }[]>();
        for (const { pred, succ } of inEdgeRecords(preds, M)) {
          const g = groups.get(succ.args[i]);
          if (g) {
            g.push({ rec: succ, src: pred });
          } else {
            groups.set(succ.args[i], [{ rec: succ, src: pred }]);
          }
        }
        const candidates: { arg: Value; def: Op; defBlock: Block; edges: { rec: object; src: Block }[] }[] = [];
        for (const [arg, edges] of groups) {
          const def = defs.get(arg);
          if (!def || def.opcode !== 'const' || varName.has(arg)) {
            continue;
          }
          const defBlock = opBlock.get(def)!;
          if (inLoop(defBlock) || edges.some(({ src }) => inLoop(src))) {
            continue;
          }
          if (edges.some(({ src }) => !dom.get(src)!.has(defBlock))) {
            continue;
          }
          candidates.push({ arg, def, defBlock, edges });
        }
        // pairwise clobber check: candidate `c` is unsafe when another candidate's write can lie
        // between c's def and one of c's edges (def_c → def_o → edge_c); both then keep their edges
        const safe = candidates.filter((c) =>
          candidates.every((o) => {
            if (o === c) {
              return true;
            }
            const oAfterC =
              c.defBlock === o.defBlock ? opIndex.get(o.def)! > opIndex.get(c.def)! : mayFollow(c.defBlock, o.defBlock);
            return !(oAfterC && c.edges.some(({ src }) => mayFollow(o.defBlock, src)));
          }),
        );
        for (const c of safe) {
          const at = anchoredAt.get(c.def);
          if (at) {
            at.push({ name, arg: c.arg });
          } else {
            anchoredAt.set(c.def, [{ name, arg: c.arg }]);
          }
          for (const { rec } of c.edges) {
            const sup = suppressedArgs.get(rec);
            if (sup) {
              sup.add(i);
            } else {
              suppressedArgs.set(rec, new Set([i]));
            }
          }
        }
      });
    }
  }

  // ── BITFIELD member spelling (structure/bitfields.ts) ───────────────────────────────────────
  // The read fold, the mask-and-insert WRITE fold and the absorbed-load set, precomputed over the
  // ops before any rendering. Extracted behind an explicit-deps factory: every dependency below is
  // READ-only, so this cannot participate in the naming pipeline this file's remainder is built
  // around. The module header states what each fold recognizes and every refusal it carries.
  const {
    spelling: bitfieldSpelling,
    stores: bitfieldStore,
    absorbed: absorbedLoads,
  } = makeBitfieldSpelling({
    fn,
    defs,
    materialize,
    useSitesOf,
    opBlock,
    opIndex,
    emitPos,
    memWriteBetween,
    sym: symCtx,
    littleEndian,
    enabled: spellBitfieldMembers,
    memberQualsAllow,
  });

  // An unresolvable value: strict mode keeps the `"?"` sentinel AND records the reason — the
  // decline thrown below names the actual gaps ("unmodelled instruction 'adde'"), the same
  // reasons annotate mode's markers carry, instead of the anonymous `?` that assertResolved
  // would report at the boundary (assertResolved stays as the backstop for any other producer).
  // Annotate mode emits a marker (the undefined ASMLIFT_ERROR symbol — loud in the ARTIFACT,
  // function still complete).
  const strictGaps: string[] = [];
  const mkGap = (reason: string, args: Expr[]): Expr => {
    if (onGap === 'annotate') {
      return { k: 'marker', reason, args };
    }
    strictGaps.push(reason);
    return { k: 'var', name: '?' };
  };

  // A qualified access is one the recompile must make where the machine did, so its spelling
  // carries the qualifier or the function declines: a plain spelling is one agbcc may delete or
  // hoist. It carries it where ir/discipline.ts `qualifiedBy` says: on its cast, or through the
  // object's declaration and on its cast where it reaches the object through one, since a cast's
  // pointee drops the declaration's qualifiers.
  //
  // Whether a cast stands between the access and the object is the PRINTER's question
  // (backend/cfamily.ts `legalizedIndexBase`), so it is asked of the env the printer judges by:
  // the declared variables over the globals this structuring typed for the tree (`SFn.globals`,
  // l3/typing.ts `declaredTypes`). Asked of the variables alone, a global subscript the printer
  // spells through its own name (`gVA[i]`, already volatile by its declaration) reads as one it
  // casts, and the qualified cast agbcc compiles differently is put on a name that needed none.
  const printedType = (n: string): IrType | undefined => varType.get(n) ?? shapedGlobalTypes.get(n);
  const printedCType = (e0: Expr): IrType | undefined => exprCType(e0, printedType);
  // A declared access reaches its object through the declaration only where its address is spelled
  // from the object's own name. Through a local or a parameter — a pointer one of two addresses of
  // the object joined into, or one a loop steps through it — the declaration qualifies nothing, and
  // the qualifier goes on a cast.
  const throughLocal = (access: Expr): boolean => {
    let b: Expr | undefined = access.k === 'index' || access.k === 'field' ? access.base : undefined;
    while (b !== undefined) {
      if (b.k === 'var') {
        return varType.has(b.name);
      }
      if (b.k === 'index' || b.k === 'field') {
        b = b.base;
      } else if (b.k === 'cast') {
        b = b.e;
      } else if (b.k === 'bin' && (b.op === '+' || b.op === '-')) {
        b = b.l.k === 'const' ? b.r : b.l;
      } else {
        return false;
      }
    }
    return false;
  };
  const pinnedAccess = (op: Op, access: Expr): Expr => {
    const by = qualifiedBy(op);
    if (by === null || (by === 'declaration' && !castOffDeclaration(access, printedCType) && !throughLocal(access))) {
      return access;
    }
    // A bare global's declaration owns its qualifiers. Where the project declares the name — the map
    // knows it, or a declaration context is in play — a declaration that qualified it would have
    // placed the access `declared`, so one the lift qualified by a CAST (`device`:
    // frontend/dead-reads.ts, frontend/device-pins.ts) is declared plain there, and `gR;` compiles
    // to no read at all: the cast goes on the object's address. A name nothing declares gets the
    // synthesized declaration, which carries the qualifier (rank-declare.ts `bareGlobalSymbols`),
    // and keeps the bare spelling — on gcc 2.7.2 the cast compiles to another address sequence.
    if (
      by === 'cast' &&
      access.k === 'var' &&
      (mapSymbols?.has(access.name) === true || contextGlobals !== undefined)
    ) {
      const width = op.attrs.width as number;
      const signed = op.attrs.signed === true;
      return {
        k: 'index',
        base: {
          k: 'cast',
          to: T.ptr(scalarTypeForAccess(width, signed)),
          volatile: true,
          e: { k: 'addr', name: access.name },
        },
        idx: { k: 'const', value: 0 },
        width,
        signed,
      };
    }
    const q = qualifiedMemoryAccess(access, printedCType);
    if (q === null) {
      throw new StructureError(
        `cannot structure '${fn.name}': a ${placedAt(op)} ${op.opcode} that must stay volatile is reached through a ` +
          'pointer with no type to put the qualifier on',
      );
    }
    return q;
  };

  // A FRAME OBJECT DECLARED AS A UNION (`laddrType`) is read and written through the view of each
  // access's own width and extension — `sp0.half[1]`, `sp0.word[0]` — on the object itself, never
  // through a cast on its storage: a cast there is the spelling agbcc may read stale, and the
  // union is declared because it does not. The audit admitted only accesses at a fixed offset on
  // the object and aligned to their own width (frame-objects.ts `unionRefusal`), so a view names
  // each one; an access with none is an internal error, not a decline to fall back from.
  const frameUnionAccess = (base: Value, off: number, width: number, signed: boolean, isStore: boolean) => {
    const d = defs.get(base);
    if (d?.opcode !== 'laddr' || d.attrs.views === undefined) {
      return null;
    }
    const u = laddrType(d);
    const { view, index } =
      u.kind === 'union' ? unionView(u, off, width, signed, isStore) : { view: undefined, index: null };
    if (view === undefined || off % width !== 0) {
      throw new Error(
        `internal: a ${width}-byte ${isStore ? 'store' : 'load'} at byte ${off} of the frame union '${laddrName.get(d)}' has no view`,
      );
    }
    const cell: Expr = { k: 'field', base: { k: 'var', name: laddrName.get(d)! }, name: view.name, dot: true };
    return index === null
      ? cell
      : ({ k: 'index', base: cell, idx: { k: 'const', value: index }, width, signed, subscript: true } as const);
  };
  // A FRAME OBJECT DECLARED AS A STRUCT (a call's return storage or a struct passed by value,
  // `laddrType`) is read and written through the member an access names exactly — its offset, its
  // width, and the type the cast it replaces would spell (`spellsAccessType`, a load's alone: a
  // store truncates to the member's bytes whatever their type); any other access keeps the cast.
  // Unqualified only: a qualified access keeps the cast its qualifier goes on.
  const frameStructMember = (op: Op, off: number, width: number, signed: boolean | null): Expr | null => {
    const d = defs.get(op.operands[0]);
    const t = d?.results[0].type;
    if (d?.opcode !== 'laddr' || d.attrs.aggregate !== true || t?.kind !== 'ptr' || t.to.kind !== 'struct') {
      return null;
    }
    const f = t.to.fields.find((m) => m.off === off);
    if (f === undefined || f.type.kind !== 'int' || f.type.width !== width * 8 || qualifiedBy(op) !== null) {
      return null;
    }
    return signed === null || spellsAccessType(f.type.signed, width, signed)
      ? { k: 'field', base: { k: 'var', name: laddrName.get(d)! }, name: f.name, dot: true }
      : null;
  };
  // A PART OF THE ONE FRAME OBJECT a copy proved one object of the source's (frame-objects.ts
  // `provenParts`, stamped `part`) is DECLARED as the array it is, and an access to it answers the
  // bare-array gate memAccess and arrayAccess put every map-declared array global through
  // (`bareArrayLead`: a whole element of the declared width and extension, a constant subscript
  // inside the array) — `sp16[5]`, `sp64[i % 32 + 32]`, not `((u8 *)sp16)[5]`. The two are one C
  // value, and not one compile: with a second array at sp+16 whose address agbcc already holds for
  // its `memcpy`, `b[5]` reads `ldrb [r4, #0x5]` through it while the cast re-forms `sp + 0x15`,
  // and `b[i]` keeps that `sp + 64` spilled across three calls into a frame word of its own where
  // the cast re-forms it at the read (bcpy_rem). A runtime subscript is licensed by the audit that
  // split the part: every runtime index's reach stays inside one part. Only a part: the one
  // object's bytes are members and spills of any type, which the cast spells honestly, and a lone
  // array at sp+0 compiles the same either way. Unqualified only, like the member. The part is
  // declared with the element its accesses agree on (frame-objects.ts `stampPartElements`), so a
  // `u16` or `s8` part answers the gate as one: `u8` storage would turn every other access away.
  const framePartDecls = new Map<string, SymbolInfo>();
  for (const [d, name] of laddrName) {
    const t = d.attrs.part === true && d.attrs.views === undefined ? laddrType(d) : null;
    if (t?.kind === 'array' && t.elem.kind === 'int') {
      framePartDecls.set(name, {
        name,
        kind: 'data',
        shape: 'array',
        elemSize: t.elem.width / 8,
        elemSigned: t.elem.signed,
        dims: [t.count],
      });
    }
  }
  const frameArrayFor = (op: Op): FrameArrayDecl | undefined =>
    framePartDecls.size === 0 || qualifiedBy(op) !== null ? undefined : (n) => framePartDecls.get(n);
  // A FLOATING MEMBER READ AS ITS INTEGER BITS is spelled `*(s32 *)&s`, which C converts wherever
  // a float is what the reader takes (`gF = *(s32 *)&s;` against `float gF` is `bl __floatsisf` on
  // agbcc, a `cvt` on MIPS), which the bytes never did. So such a read is spelled only where every
  // reader is a store into an lvalue whose integer type this lift states (`floatBitsStoreTarget`):
  // a whole-struct copy lowered to words, `((s32 *)&gV3)[1] = ((s32 *)&s)[1];`, passes the bits
  // through. Any other reader (a named global, a declared member, a call, a return, a join)
  // declines. A store of bits into such a member is the bits, and keeps the cast.
  const floatMemberBits = (op: Op): { name: string; width: number } | null => {
    if (op.opcode !== 'load') {
      return null;
    }
    const width = op.attrs.width as number;
    const t = defs.get(op.operands[0])?.results[0].type;
    const f = t?.kind === 'ptr' && t.to.kind === 'struct' ? t.to.fields.find((m) => m.off === op.attrs.off) : undefined;
    return f?.type.kind === 'float' && f.type.width === width * 8 ? { name: f.name, width } : null;
  };
  const refuseFloatBits = (m: { name: string; width: number }): never => {
    throw new StructureError(
      `a ${m.width}-byte read of the floating member '${m.name}' of a struct local is an integer here, and C ` +
        'would convert it where a float is read — not modelled',
    );
  };
  const refuseFloatMemberRead = (op: Op): void => {
    const m = floatMemberBits(op);
    const v = op.results[0];
    const storedOnly = (useSitesOf.get(v) ?? []).every(
      ({ op: u }) =>
        (u.opcode === 'store' && u.operands[1] === v && u.operands[0] !== v) ||
        (u.opcode === 'astore' && u.operands[2] === v && u.operands[0] !== v && u.operands[1] !== v),
    );
    if (m !== null && !storedOnly) {
      refuseFloatBits(m);
    }
  };
  // …and the store side: the lvalue must be one whose type the lift spells, an integer of the
  // read's width: a cast cell (`((s32 *)&g)[1]`), or a local's or a parameter's cell. A bare global
  // (`gF = …`, `gA[i] = …`) has the project's type, whatever that is.
  const floatBitsStoreTarget = (value: Value, lval: Expr): void => {
    const d = defs.get(value);
    const m = d === undefined ? null : floatMemberBits(d);
    if (m === null) {
      return;
    }
    let root: Expr = lval;
    while (root.k === 'index' || root.k === 'field') {
      root = root.base;
    }
    const t = ctype(lval);
    const own = root.k !== 'var' || varType.has(root.name);
    if (!own || (lval.k !== 'index' && lval.k !== 'field') || t?.kind !== 'int' || t.width !== m.width * 8) {
      refuseFloatBits(m);
    }
  };
  // A STRUCT LOCAL'S BYTES STORED INTO A BARE ARRAY ELEMENT keep the cast cell. The bare `gA[i]`
  // (globalaccess.ts `bareArrayLead`) checks the element's width, not its kind, and the bytes of
  // `gA[i] = mk(x);` over `struct S gA[4]` are the bytes of a scalar array's store: `gA[a1] =
  // *(s32 *)&mk_ret;` assigns an int to the struct element (agbcc: incompatible types in
  // assignment). `((s32 *)&gA)[a1]` addresses the same bytes under any declaration. A recovered row
  // subscript (`gA[r][i]`) has no flat index here to put in the cell, so it declines.
  // ONLY an array-declared symbol: a store through a POINTER global's value (`gIP[i] = s.x`) has
  // the same `var` base, and `&gIP` would address the pointer variable, not its pointee.
  const structBytesCell = (value: Value, lval: Expr): Expr => {
    const d = defs.get(value);
    const local = d?.opcode === 'load' ? defs.get(d.operands[0]) : undefined;
    const t = local?.results[0].type;
    const fromStruct = local?.opcode === 'laddr' && t?.kind === 'ptr' && t.to.kind === 'struct';
    if (
      !fromStruct ||
      lval.k !== 'index' ||
      lval.base.k !== 'var' ||
      varType.has(lval.base.name) ||
      symCtx?.info(lval.base.name)?.shape !== 'array'
    ) {
      return lval;
    }
    if (lval.lead?.some((l) => l.k !== 'const' || l.value !== 0)) {
      throw new StructureError(
        `a struct local's bytes stored into an element of '${lval.base.name}' by a row subscript have no cast cell to spell`,
      );
    }
    const { lead: _lead, ...cell } = lval;
    return { ...cell, base: { k: 'addr', name: lval.base.name } };
  };
  // …and with no qualifier: `pinnedAccess` would put one on through a cast, the very spelling, and
  // the audit refuses the union where its accesses would need one (`unionRefusal`)
  const unqualifiedView = (op: Op, viewed: Expr): Expr => {
    if (qualifiedBy(op) !== null) {
      throw new Error(
        `internal: '${fn.name}': a ${placedAt(op)} ${op.opcode} on a frame union must stay volatile, ` +
          'which no view of the union carries',
      );
    }
    return viewed;
  };

  // A memory READ (`load`, else `aload`), spelled at the extension `signed` (the op's own, or the one a
  // sign-extension of it states: see `declaredExtendedRead`).
  const lowerRead = (d: Op, e: (v: Value) => Expr, signed: boolean): Expr => {
    if (d.opcode === 'load') {
      const viewed = frameUnionAccess(d.operands[0], d.attrs.off as number, d.attrs.width as number, signed, false);
      if (viewed !== null) {
        return unqualifiedView(d, viewed);
      }
      const member = frameStructMember(d, d.attrs.off as number, d.attrs.width as number, signed);
      if (member !== null) {
        return member;
      }
      refuseFloatMemberRead(d);
      const access = memAccess(
        d.operands[0],
        e(d.operands[0]),
        d.attrs.off as number,
        d.attrs.width as number,
        signed,
        ctype,
        scalarGlobals,
        symCtx,
        false,
        advanceStepOf(d.operands[0]),
        qualifiedBy(d) === 'cast',
        frameArrayFor(d),
      );
      return pinnedAccess(d, access);
    }
    // aload carries a runtime index operand (variable-index array access) — `base[index]`, or
    // `base[index].field_K` when it carries a `fieldOff` (array-of-STRUCT element access).
    {
      const access = arrayAccess(
        d.operands[0],
        e(d.operands[0]),
        e(d.operands[1]),
        d.attrs.fieldOff as number | undefined,
        d.attrs.memberOff as number | undefined,
        d.attrs.elemSize as number,
        signed,
        ctype,
        symCtx,
        frameArrayFor(d),
      );
      return pinnedAccess(d, access);
    }
  };

  // A SIGN-EXTENSION OF AN UNSIGNED BYTE READ IS THE SIGNED BYTE, exactly, whatever the byte
  // holds. agbcc has no `ldrsb` with an immediate offset, so it reads `extern s8 gT[16]`'s `gT[3]`
  // as `ldrb r1, [r1, #0x3]; lsl #24; asr #24`, which reaches the structurer as the unsigned byte
  // sign-extended (mwcc's `lbz; extsb` is the same shape, and spells both ways alike). Spelled as
  // written that is `(s8)((u8 *)&gT)[3]`, which agbcc compiles through a literal of its own
  // (`.word gT+0x3; ldrb [r1, #0]`), so a nonmatch where the bare element is the target's bytes.
  //
  // The read is re-spelled signed and taken only where it comes back as a DECLARED ARRAY's element
  // (the one bare-array gate, `bareArrayIndex`, which checks the declared extension): the
  // declaration is the evidence the source read an `s8`. Anywhere else the cast stays.
  //
  // BYTES ONLY, BY MEASUREMENT: every target here has a signed HALF load the bare element compiles
  // to (agbcc `mov r2, #6; ldrsh` for `gH[3]` and for `(s16)((u16 *)gH)[3]` alike, mwcc `lha`), and on
  // mwcc the cast is `lhz; extsh` where the element is `lha`, so a sign-extended unsigned half is
  // the cast's own code. Nor the other direction: a `(u8)` of a signed byte compiles to the unsigned
  // load on agbcc, IDO, gcc 2.7.2 and KMC, so no compiler emits the shape. A volatile read keeps its
  // spelling, as does a value held in a name. The L3 half of the same identity is
  // l3/constinit.ts `asElement`: a local the image fold types `s8` is typed only there.
  const declaredExtendedRead = (d: Op, e: (v: Value) => Expr): Expr | null => {
    const v = d.operands[0];
    const ld = defs.get(v);
    if (d.opcode !== 'sext' || d.attrs.width !== 8) {
      return null;
    }
    if ((ld?.opcode !== 'load' && ld?.opcode !== 'aload') || qualifiedBy(ld) !== null) {
      return null;
    }
    const bytes = (ld.opcode === 'load' ? ld.attrs.width : ld.attrs.elemSize) as number;
    if (bytes !== 1 || ld.attrs.signed === true) {
      return null;
    }
    // a frame UNION is read through its views, never as a declared array's element
    const at = defs.get(ld.operands[0]);
    if (at?.opcode === 'laddr' && at.attrs.views !== undefined) {
      return null;
    }
    if (e(v).k === 'var') {
      return null;
    }
    const read = lowerRead(ld, e, true);
    if (read.k !== 'index' || read.base.k !== 'var' || read.signed !== true || read.width !== 1) {
      return null;
    }
    const name = read.base.name;
    const declared =
      framePartDecls.get(name) ?? (symCtx?.info(name)?.shape === 'array' ? symCtx.info(name) : undefined);
    return declared === undefined ? null : read;
  };

  // Lower ONE def's operation to an Expr, rendering operands through `e`. Shared between the
  // inline-at-use path (exprWith) and the materialized-temp path (sideEffects), so both spell a
  // given op identically.
  const lowerDef = (d: Op, e: (v: Value) => Expr): Expr => {
    if (d.opcode === 'const') {
      return { k: 'const', value: d.attrs.value as number };
    }
    if (d.opcode === 'fconst') {
      return { k: 'fconst', bits: d.attrs.bits as string };
    }
    // a bitfield extract recognized over the ops (see the precompute above): the member read,
    // not the shift pair
    const bf = bitfieldSpelling.get(d);
    if (bf) {
      return { k: 'field', base: { k: 'var', name: bf.global }, name: bf.field, dot: true };
    }
    if (FLOAT_TO_BIN[d.opcode]) {
      return { k: 'bin', op: FLOAT_TO_BIN[d.opcode], l: e(d.operands[0]), r: e(d.operands[1]) };
    }
    if (d.opcode === 'fneg') {
      return { k: 'un', op: 'f-', e: e(d.operands[0]) };
    }
    if (FCMP_TO_BIN[d.opcode] || FCMP_TO_BIN[NEGATED_FCMP[d.opcode] ?? '']) {
      const op = FCMP_TO_BIN[d.opcode] ?? FCMP_TO_BIN[NEGATED_FCMP[d.opcode]];
      const spelled = typeof d.attrs.relation === 'string' ? FCMP_TO_BIN[d.attrs.relation] : undefined;
      const rel: Expr = {
        k: 'bin',
        op,
        l: e(d.operands[0]),
        r: e(d.operands[1]),
        ...(spelled !== undefined ? { helperRel: spelled } : {}),
      };
      return FCMP_TO_BIN[d.opcode] ? rel : { k: 'un', op: '!', e: rel };
    }
    // A conversion is C's cast to the type it converts to. Converting an integer, the cast's
    // operand must BE signed, because C converts an unsigned one with the unsigned conversion,
    // which agbcc open-codes and an FPU computes differently: the pin `icmp_s*` takes below. A cast
    // does not promote its operand, so a `u8` or `u16` name is unsigned here, where it would
    // promote to `int` in arithmetic: agbcc compiles `(float)c` over an `unsigned char` as the
    // unsigned conversion and `(float)(s32)c` as `__floatsisf`.
    if (FLOAT_TO_INT.has(d.opcode)) {
      const w = intWidth(d.results[0].type) === WIDE_BITS ? WIDE_BITS : 32;
      return { k: 'cast', to: T.int(w, d.opcode === 'fptosi'), e: e(d.operands[0]) };
    }
    if (INT_TO_FLOAT.has(d.opcode)) {
      const x = e(d.operands[0]);
      const own = ['var', 'postincr', 'cast', 'index', 'field'].includes(x.k) ? exprCType(x, vtEnv) : undefined;
      const isSigned = own?.kind === 'int' && own.width < 32 ? own.signed : renderedIntSignedness(x, vtEnv) === true;
      const signed: Expr = isSigned ? x : { k: 'cast', to: T.s(exprIntWidth(x, vtEnv)), e: x };
      return { k: 'cast', to: d.results[0].type, e: signed };
    }
    if (FLOAT_RESIZE[d.opcode]) {
      return { k: 'cast', to: d.results[0].type, e: e(d.operands[0]) };
    }
    if (CMP_TO_BIN[d.opcode]) {
      // A bare global address `&gSym` as a COMPARISON operand is the same unspelled escape as the
      // arithmetic case (pointer-spelling.ts ARITH_ROWS): its C type comes from the PROJECT's own
      // declaration, unknowable here. Worse, the compare's SIGNEDNESS lives in the operand types
      // (CMP_TO_BIN maps icmp_ult and icmp_slt to the same '<'), so leaving `&gSym` untyped lets
      // the project's declaration pick the compare the compiler emits — silently byte-inexact
      // whenever it disagrees with the asm. The honest spelling is integer math on the address
      // with the cast AGREEING with the opcode's signedness: unsigned compares (and the
      // sign-agnostic ==/!=) spell `(u32)&gSym`, signed compares `(s32)&gSym` — exactly the
      // compare the asm did. The deref folds never see a compare operand, so no named spelling is
      // lost; a NARROWING cast (`(u8)&gSym`) is not a bare `addr` and keeps its truncation.
      // SCOPE: this handles BARE addr operands. An addr-carrying arithmetic tree
      // (`(u32)&gSym + 4`, spelled by the arithmetic table) renders unsigned and would compare
      // unsigned under an icmp_s*; the signed operand pin at the end of this block catches it as
      // one case of the general rule, needing no addr-specific reasoning.
      const t = /^icmp_s/.test(d.opcode) ? T.s(32) : T.u(32);
      const intifyAddrCmp = (x: Expr): Expr => (x.k === 'addr' ? { k: 'cast', to: t, e: x } : x);
      let l = intifyAddrCmp(e(d.operands[0]));
      let r = intifyAddrCmp(e(d.operands[1]));
      // The same signedness hole for ORDINARY operands: an icmp_u* whose operands both render
      // as signed-promoting C (an s32-declared var carrying a u32 value — declarations take the
      // FIRST claimant's type; an inline `16 << t`, whose C type is the left operand's `int`)
      // compiles to the SIGNED compare the machine did not do. When neither side provably
      // promotes unsigned, one operand takes a (u32) cast — the side whose recovered VALUE type
      // is unsigned, the honest one — and the usual arithmetic conversions make the compare
      // unsigned exactly as the opcode says. A provably-unsigned operand leaves the spelling
      // alone, so correctly-typed compares never churn — as does a compare whose operands both
      // provably sit in [0, 2^31) (a `(u8)x > 4` byte test): there the signed spelling is
      // value-faithful and the compiler already picks the unsigned branch itself, and so does a
      // pointer-rendered side: `p < end` already compares unsigned, and `(u32)p` against a
      // pointer is the int-vs-ptr constraint violation the strict backends reject. ==/!= are
      // sign-agnostic; the icmp_s* direction is pinned below.
      const ptrSide = (x: Expr): boolean => {
        const t2 = ctype(x);
        return t2?.kind === 'ptr' || t2?.kind === 'array';
      };
      // `pinned` places the cast (l3/typing.ts `spelledNonNegative`). Whether an uncast spelling
      // compares different values is not decided here: the compare carries `unsignedCmp` evidence,
      // and rank.ts asks `signedOverUnsignedCompare` of the finished tree, after every pass that
      // could substitute into it. The two differ on an `|`/`^` of non-negative sides, which stays
      // pinned (the pin is codegen-visible) and owes no proof uncast.
      const unsignedOrdering = /^icmp_u(lt|le|gt|ge)$/.test(d.opcode);
      const pinned = /^icmp_u/.test(d.opcode) && rendersSignedOverUnsigned(l, r, vtEnv, spelledNonNegative);
      if (pinned && unsignedCompareSpelling) {
        const irUnsigned = (v: Value): boolean => v.type.kind === 'int' && !v.type.signed;
        // AT THE OPERAND'S OWN RANK: `(u32)a` over a 64-bit `a` pins nothing, it truncates the
        // compare to its low half. `exprIntWidth` is total and answers 64 only where it proves it.
        const pinUnsigned = (x: Expr): Expr => ({ k: 'cast', to: T.u(exprIntWidth(x, vtEnv)), e: x });
        if (!irUnsigned(d.operands[0]) && irUnsigned(d.operands[1])) {
          r = pinUnsigned(r);
        } else {
          l = pinUnsigned(l);
        }
      }
      // The SIGNED direction of the same hole, and a DEFAULT rather than an alternative of that variation —
      // not because nothing underdetermines, but because the underdetermination is INERT. An
      // unsigned source compare can reach a signed opcode when the compiler proves the test is
      // the sign bit (`u32 a; a < 0x80000000` compiles to `cmp r0, #0; bge`; kmc-gcc and gcc
      // 2.7.2 fold it to `slti`), so an icmp_s* has more than one source — but the pinned
      // spelling reproduces that branch too (`(s32)a >= 0` is the same `cmp r0, #0; bge`), so
      // both sources reach ONE candidate and a variation would have doubled the fan to referee a
      // question with one answer. Where the spellings genuinely diverge they diverge the way the
      // opcode says, on every toolchain: an operand that renders unsigned makes C compare
      // unsigned (agbcc `bls`, IDO/kmc-gcc/gcc 2.7.2 `sltu`/`sltiu` against `slt`/`slti`, mwcc
      // `neg;or` against `neg;andc` in its branchless form), and against a constant the test
      // folds away entirely and takes the surrounding computation with it — `(u32)a / b < 0`
      // becomes `mov r0, #0`, deleting the `__udivsi3` call.
      //
      // `undefined` takes the cast exactly as a definite `false` does (see
      // renderedIntSignedness): a call's signedness is the project header's, not this function's.
      // A POINTER-rendered side takes it too. C compares an address unsigned (`p < q` is agbcc
      // `bcc`, IDO `sltu`), so a signed opcode over one is a source that compared the address as
      // an integer, and the byte arithmetic's `(u8 *)g + K` left bare against an `int` compiles
      // `bcs` where the asm says `blt`.
      if (/^icmp_s/.test(d.opcode)) {
        const pinSigned = (x: Expr): Expr =>
          renderedIntSignedness(x, vtEnv) === true ? x : { k: 'cast', to: T.s(exprIntWidth(x, vtEnv)), e: x };
        l = pinSigned(l);
        r = pinSigned(r);
      } else {
        // A pointer-rendered side against an INTEGER one (the byte arithmetic's `(u8 *)g + K`
        // against an `int`) is a constraint violation IDO 7.1 and CodeWarrior reject and agbcc
        // warns about. The asm compared two words, and unsigned, as C compares a pointer, so the
        // pointer side is compared as the `u32` it is. A literal 0 is the null pointer constant.
        const intSide = (x: Expr): boolean => ctype(x)?.kind === 'int' && !(x.k === 'const' && x.value === 0);
        if (ptrSide(l) && intSide(r)) {
          l = { k: 'cast', to: T.u(32), e: l };
        } else if (ptrSide(r) && intSide(l)) {
          r = { k: 'cast', to: T.u(32), e: r };
        }
      }
      return { k: 'bin', op: CMP_TO_BIN[d.opcode], l, r, ...(unsignedOrdering ? { unsignedCmp: true as const } : {}) };
    }
    if (ARITH_TO_BIN[d.opcode]) {
      const l = e(d.operands[0]);
      const r = d.operands.length === 2 ? e(d.operands[1]) : ({ k: 'const', value: d.attrs.imm as number } as Expr);
      // A `+`/`|` over two IR `const`s that both RENDER as literals is the literal it is. After
      // pre-recovery there is only one way such an op still exists: `raise/const.ts` refuses to fold
      // one shape — a register the compiler held live across a branch, whose value on this path is a
      // constant — so that `/merge-home` can enumerate the hoisted init (`v = 0; if (c) v = v + 1;`).
      // A candidate that does NOT home the register inlines both operands and would ship
      // `v = 0 + 1;`: `synthetic:fib:gcc2.7.2kmc` emits exactly that without this fold and scores
      // diff:12 either way, because the target compiler folds the constant expression and no score
      // gate can see the difference. The artifact a decomp author pastes into a repo is what is at
      // stake, so `const-fold.test.ts` pins this on the emitted STRING. Re-folding HERE rather than
      // back in the IR is the point: the pair must survive pre-recovery for the enumeration gate to
      // see the merge feed, and only at rendering is it settled that this candidate named neither
      // half. Two literals are spelled as they are by the arithmetic table, so the fold reads them
      // before it.
      //
      // `foldsFromIrConsts` keeps the reach honest and is not redundant with `l`/`r` being `const`
      // Exprs: a BLOCK PARAMETER resolved to a constant on this arm also renders as a literal, and
      // folding those is a different and unmeasured decision. Instrumented over the real pipeline it
      // fires on `synthetic:sinkacc:agbcc` and on ZERO renders of the 16 MATCH rows whose emitted
      // source carries a literal pair today — theirs are address trees whose IR defs are not consts.
      // It reads through the fold's OWN opcodes, and recursively, because the residue is not flat:
      // `add(add(const 0, const 1), const 2)` would otherwise ship `1 + 2`. That cannot widen the
      // reach past the refusal's residue — any other const/const `add`/`or` `raise/const.ts` already
      // folded, and nothing outside `frontend/` constructs one afterwards. The fold itself is
      // `foldConstPair`, not a copy: which opcodes fold and how the result is normalised to int32 is
      // ONE decision, and a third `FOLD` entry must not silently leave its residue unrepaired here.
      const foldsFromIrConsts = (v: Value): boolean => {
        const dv = defs.get(v);
        if (!dv) {
          return false; // a block parameter: not this refusal's residue
        }
        if (dv.opcode === 'const') {
          return true;
        }
        return (
          isConstFoldOpcode(dv.opcode) && dv.operands.length === 2 && dv.operands.every((o) => foldsFromIrConsts(o))
        );
      };
      if (l.k === 'const' && r.k === 'const' && d.operands.every((o) => foldsFromIrConsts(o))) {
        const value = foldConstPair(d.opcode, l.value, r.value);
        if (value !== null) {
          return { k: 'const', value };
        }
      }
      // Commutative LOAD-PAIR operands re-spell in EVALUATION order. A commutative instruction's
      // operand order is an allocator artifact (`mul r0, r0, r2` reads dst-first, so the lift's
      // l/r is whichever load landed in the dst), but the order the compiler EVALUATED the
      // operands is still visible: their defs' order in the instruction stream. gcc 2.9 and IDO
      // both emit `w * h`'s loads w-first, so def order IS source order — verified byte-identical
      // on both (the bg_area rows). Scope, one gate per way the signal fails: BOTH root defs must
      // be same-block memory reads (a const already has its side; arithmetic defs get combined
      // out of source order — an ldmia-fed add reads def-reordered; cross-block positions do not
      // order evaluation), neither stamped `listOrder` (an ldmia-expanded load's own position is
      // LIST order), both operand VALUES un-named (see below), and no effect moves (call, marker).
      // Which sides may move is the arithmetic's own decision (structure/pointer-spelling.ts
      // `pointerSide`, load-bearing for the stride rules), so the pair is handed to it.
      const [da, db] = [defs.get(d.operands[0]), defs.get(d.operands[1])];
      const loadPairReversed =
        COMMUTATIVE_BIN.has(ARITH_TO_BIN[d.opcode]) &&
        d.operands.length === 2 &&
        defOrderLoadPairs &&
        da !== undefined &&
        db !== undefined &&
        (da.opcode === 'load' || da.opcode === 'aload') &&
        (db.opcode === 'load' || db.opcode === 'aload') &&
        da.attrs.listOrder !== true &&
        db.attrs.listOrder !== true &&
        // NAMED values decline: a value that renders as a name here — a materialized def
        // (varName), a loop-carried value in a post-loop region (activeSub) — was evaluated at
        // its def statement, so re-ordering the reference re-orders nothing and only churns the
        // spelling away from the machine order the allocator saw. An inlined def — a deref, a
        // field, a bare scalar global (whose `var` node lowerDef itself mints) — evaluates at
        // THIS site, wherever recovery spells it.
        !varName.has(d.operands[0]) &&
        !varName.has(d.operands[1]) &&
        activeSub?.has(d.operands[0]) !== true &&
        activeSub?.has(d.operands[1]) !== true &&
        !exprHasEffect(l) &&
        !exprHasEffect(r) &&
        opBlock.get(da) === opBlock.get(db) &&
        opIndex.get(da)! > opIndex.get(db)!;
      // The operand order, the pointer stride, the integer legalizations and the pointer-value
      // byte arithmetic: structure/pointer-spelling.ts `arith`. (The signedness-carrying pairs
      // stay DISTINCT ops — `>>>`/`>>` and `/u` `%u`/`/` `%`. Which token a language spells each
      // with, and what cast pins the choice, is a BACKEND decision; see l3/ast.ts BinOp and
      // backend/cfamily.ts's C_SPELLING.)
      return spellArith(d, l, r, loadPairReversed);
    }
    // `-`/`~` on a pointer rendering is equally not C — same honest integer cast as above.
    if (d.opcode === 'rotr' || d.opcode === 'rotl') {
      // The C rotate idiom — `x >> n | x << (32 - n)` (mirrored for rotl). Byte-exact round-trip
      // on agbcc (thumb ror) and mwcc (rotlw/rotlwi), verified against both toolchains before the
      // ops landed. `x` and `n` render twice — both pure by construction (SSA values; the rotate's
      // operands are register reads). The right half is the LOGICAL shift `>>>` — the idiom is
      // wrong with an arithmetic one — stated on the node rather than left to the rotated value's
      // recovered unsignedness, which is a property of recovery rather than of the idiom.
      //
      // (The PPC mirror fold — `rotl(x, 32 - m)` ⇒ rotr(x, m) — lives in the PATTERN layer,
      // engine.ts ROTL_MIRROR: it is a compiler-spelling idiom, mwcc-gated there, not a
      // structurer concern.)
      const dir: 'rotr' | 'rotl' = d.opcode;
      const n: Expr = d.operands.length === 2 ? e(d.operands[1]) : { k: 'const', value: d.attrs.imm as number };
      const x = e(d.operands[0]);
      // constant-amount edges: 0 and 32 are the IDENTITY (the C idiom would spell the UB
      // shift-by-32); otherwise a constant folds the complement (`a0 >> 24`, not `a0 >> 32 - 8`).
      if (n.k === 'const' && (n.value === 0 || n.value === 32)) {
        return x;
      }
      const w: Expr =
        n.k === 'const'
          ? { k: 'const', value: 32 - n.value }
          : { k: 'bin', op: '-', l: { k: 'const', value: 32 }, r: n };
      const [near, far] = dir === 'rotr' ? (['>>>', '<<'] as const) : (['<<', '>>>'] as const);
      return {
        k: 'bin',
        op: '|',
        l: { k: 'bin', op: near, l: x, r: n },
        r: { k: 'bin', op: far, l: x, r: w },
      };
    }
    if (d.opcode === 'neg_s') {
      // The MATHEMATICAL negation (ir/opcodes.ts), so it must not be spelled over an unsigned 32-bit
      // operand: `-(u32)b` wraps, and at b == 0x80000000 a signed compare reads `(s32)-b` as INT_MIN
      // where the machine's sum was +2^31. Negating the operand as s32 instead is exact wherever C
      // defines it — it is undefined at exactly that one input. The operand keeps its own spelling
      // where it already renders signed (`renderedIntSignedness`, the rule the icmp_s* operand
      // pin uses); a cast it did not need costs no byte.
      //
      // That one input is a value the operand MIGHT hold. An operand that ALWAYS holds it is a
      // different thing: every call then lands on the undefined input, and the C a compiler makes
      // of `-(s32)0x80000000` (INT_MIN again) is not the machine's +2^31. Whether it always does is
      // what the compiler can FOLD, not which opcodes built it — a pool word, `1 << 31`, a
      // `sub`/`orr`/`eor` of constants, a param both arms of a diamond set, a reload of a store
      // nothing can have overwritten, a reload of memory this function wrote on every path through
      // an address it cannot match — so the question goes to the shared word evaluator, and fails
      // closed: a constant it cannot compute refuses too — unless what its ops leave cannot make
      // 0x80000000 at all (a halfword or byte reload of that memory, a narrowing cast, a param
      // whose arms pass such reloads or small constants: `stridedRange`), whatever the evaluator
      // could not say. An operand that is INT_MIN on some paths only still lifts; that is the
      // "might hold" case. agbcc folds the negation of a constant it sees, but compiled C still
      // reaches the refusal: a whole-word reload of memory a store before it may have overwritten
      // (`p->x -= 8; if (p->x <= -gMag)` with an s32 gMag) is a word this cannot compute.
      const x = e(d.operands[0]);
      wordCtx ??= {
        defs,
        incoming: incomingArgs(fn.blocks),
        forwarded: storeForwards(fn.blocks),
        overwritten: overwrittenReads(fn.blocks),
        entry: new Set(fn.blocks[0]?.params ?? []),
      };
      if (mayAlwaysHold(wordCtx, d.operands[0], 0x80000000)) {
        return mkGap('the mathematical negation of the constant 0x80000000 has no int spelling', [x]);
      }
      const cast = needsIntSpelling(x) || renderedIntSignedness(x, vtEnv) !== true;
      return { k: 'un', op: '-', e: cast ? { k: 'cast', to: T.s(32), e: x } : x };
    }
    if (d.opcode === 'neg') {
      const x = e(d.operands[0]);
      return { k: 'un', op: '-', e: needsIntSpelling(x) ? { k: 'cast', to: T.s(32), e: x } : x };
    }
    if (d.opcode === 'not') {
      const x = e(d.operands[0]);
      return { k: 'un', op: '~', e: needsIntSpelling(x) ? { k: 'cast', to: T.s(32), e: x } : x };
    }
    // Width-narrowing casts: `zext`/`sext` widen a `width`-bit value back to 32 → C `(u8)e`/`(s8)e`.
    // The width is in BITS, and outside `CAST_WIDTHS` there is no C type to cast to — a GAP, not
    // the `(u2)` the backend would otherwise print and no compiler accept. No frontend produces
    // one (the cast idioms and PPC's `extsb`/`extsh` emit 8 and 16), so this is the loud floor
    // under hand-written IR; `raise/narrowlocal.ts` and `raise/paramwidth.ts` refuse to NARROW on
    // such a width, which is a different decision from spelling one.
    if (d.opcode === 'zext' || d.opcode === 'sext') {
      const w = d.attrs.width as number;
      const read = declaredExtendedRead(d, e);
      if (read !== null) {
        return read;
      }
      return CAST_WIDTHS.has(w)
        ? { k: 'cast', to: T.int(w, d.opcode === 'sext'), e: e(d.operands[0]) }
        : mkGap(`no C type for a ${w}-bit '${d.opcode}'`, [e(d.operands[0])]);
    }
    // The recovered integer type of a value, where it has one. `lo32`/`hi32`/`concat` all cast to
    // one, and a value recovery left as anything else has no cast to spell.
    const asInt = (t: IrType) => (t.kind === 'int' ? t : undefined);
    // THE TWO HALVES OF A 64-BIT VALUE, which C spells exactly: the low half is a truncating cast,
    // the high half a shift and then the same cast. The RESULT's own recovered type is what the
    // cast is to, and the shift's kind comes from the 64-bit operand's — `>>` over a signed value
    // and `>>>` over an unsigned one is what the machine did, and what the C backend's operand pin
    // is spelled in terms of.
    if (d.opcode === 'lo32' || d.opcode === 'hi32') {
      const src = e(d.operands[0]);
      const half = asInt(d.results[0].type) ?? T.u(32);
      // The LOW half is a truncating cast and needs nothing of its operand's rank: `(u32)x` and
      // `(u32)(s64)x` are the same value whatever `x` renders as.
      if (d.opcode === 'lo32') {
        return { k: 'cast', to: half, e: src };
      }
      // THE HIGH HALF SHIFTS BY 32, AND `x >> 32` IS UNDEFINED IN C WHERE `x` RENDERS 32 BITS
      // WIDE — the shift count must be below the promoted left operand's width. The 64-bit VALUE
      // is what this op projects, but the rendered EXPRESSION is a separate question and the two
      // can part, so the operand is made to carry the rank the shift reads by a cast to the
      // value's own recovered 64-bit type.
      //
      // THE SIGNEDNESS IS A SEPARATE PIN AND IS NOT MADE HERE. `>>` versus `>>>` is read off the
      // 64-bit operand's recovered type, and what the printed operand renders as is decided one
      // level down by backend/cfamily.ts `pinnedOperands` — which casts whenever the operand does
      // not PROVABLY render as the operator needs, and a call never does. So the cast this arm may
      // add carries the rank alone; claiming it carries both would be a claim about a decision
      // this file does not make.
      const whole = asInt(d.operands[0].type);
      const wide: Expr | undefined =
        exprIntWidth(src, vtEnv) === 64 ? src : whole === undefined ? undefined : { k: 'cast', to: whole, e: src };
      // A 64-BIT VALUE WHOSE RECOVERY IS NOT AN INTEGER, AND WHOSE RENDERING DOES NOT ALREADY
      // CARRY THE RANK, has no 64-bit type to cast to and no legal shift to spell, so it is a GAP
      // rather than the undefined C it would otherwise print — the same loud floor the un-nameable
      // `sext` width gets two arms above. The condition is the CONJUNCTION and the refusal states
      // it as one: neither half alone is a reason. Nothing in the corpus reaches it: every `hi32`
      // is built beside a `concat` or a pair return whose recovery is an integer, and a recovery
      // that is not one stops at the `concat` gap below before a projection of it is rendered.
      if (wide === undefined) {
        // "UPPER HALF", NOT "HIGH HALF", for the reason the split-pair refusal in thumb.ts gives at
        // its own throw: `apps/web`'s `reloc-halves` decline class holds `/high half/`, its list is
        // ORDERED, and a 64-bit gap published as a relocation gap because one entry comes first is
        // a classification nothing states. `wide-call-arg` claims this phrase BY NAME
        // (`/no upper half to shift out/`) — a 64-bit gap with no class at all renders as
        // "Other / unclassified", which is the same wrong answer arrived at from the other side.
        return mkGap(
          'a 64-bit value that neither renders 64 bits wide nor has an integer type has no upper half to shift out',
          [src],
        );
      }
      return {
        k: 'cast',
        to: half,
        e: { k: 'bin', op: whole?.signed ? '>>' : '>>>', l: wide, r: { k: 'const', value: 32 } },
      };
    }
    // …AND THE WIDEN THAT BUILDS ONE, which the machine spells as a PAIR rather than as a cast —
    // `asr rN,rM,#31` for the signed extension of a word, `mov rN,#0` for the unsigned one. So the
    // shape is what says HOW the half was widened, and the cast this renders is to whatever 64-bit
    // type recovery gave the value.
    //
    // THE WORD'S OWN SIGNEDNESS IS WHAT THE WIDEN MEANS, and it is pinned the way every other
    // signedness-carrying operand in this function is: cast only where the operand does not
    // already render that way. Leaving the signed arm to whatever `x` happens to render as reads
    // the widen off the DECLARATION rather than off the `asr` — under `/unsigned` the parameter is
    // declared `u32` and `(s64)x` then says zero-extend, against an instruction that says
    // otherwise.
    //
    // A `concat` of anything else is a 64-bit value this pipeline has no C spelling for, and it
    // falls through to the loud gap at the bottom — which is the whole safety story for the
    // representation. A pair that tried to cross a join matches nothing here.
    if (d.opcode === 'concat') {
      const [lo, hi] = d.operands;
      const hiDef = defs.get(hi);
      const whole = asInt(d.results[0].type);
      const signedWiden = hiDef?.opcode === 'shr_s' && hiDef.operands[0] === lo && hiDef.attrs.imm === 31;
      const unsignedWiden = hiDef?.opcode === 'const' && hiDef.attrs.value === 0;
      if (whole && (signedWiden || unsignedWiden)) {
        const word = e(lo);
        const half =
          renderedIntSignedness(word, vtEnv) === signedWiden
            ? word
            : { k: 'cast' as const, to: T.int(32, signedWiden), e: word };
        return { k: 'cast', to: whole, e: half };
      }
    }
    if (d.opcode === 'call') {
      // THE RANK THE RETURN RENDERS WITH TRAVELS ON THE NODE, because no later reader can recover
      // it: the width is a fact the frontend was TOLD (a runtime helper's signature, or a project's
      // `FnProto.returns`) and it is gone from the tree by the time the C backend pins an operand.
      // Stamping it here — at the one place a call becomes an expression — is what keeps every
      // reader of `exprIntWidth` agreeing. `grep -rn exprIntWidth packages/core/src` is the
      // enumeration, and it lists SIX call sites in three files: the `hi32` shift and the two
      // compare pins in this file, the shift rank and the divide rank in backend/cfamily.ts
      // `pinnedOperands`, and `l3/initfirst.ts`'s `meaningPreserved`.
      //
      // THE LAST ONE IS A BEHAVIOUR CHANGE THE STAMP MAKES, and it is named because a reader who
      // trusts an enumeration is owed a complete one: a `wide64` call answered 32 before the stamp
      // and answers 64 now, so `meaningPreserved` refuses to fold such a result into a 32-bit
      // local where it used to admit it. That is what its own reason asks for — a 64-bit value
      // assigned to a 32-bit one truncates — but it is a pass this branch did not set out to move.
      const wide64 = d.results[0] !== undefined && intWidth(d.results[0].type) === 64;
      const through = calleeValue(d);
      // a struct passed by value is the object its operand addresses — a frame object stamped as
      // that struct, or a global — spelled bare (frontend/call-plan.ts `foldByValueArgs`)
      const byValue = byValueOperands(d).map(({ at, param }) => {
        const o = defs.get(d.operands[at]);
        const t = d.operands[at].type;
        const type = t.kind === 'ptr' && t.to.kind === 'struct' ? t.to : undefined;
        const object =
          type !== undefined &&
          (o?.opcode === 'laddr'
            ? o.attrs.aggregate === true
            : o?.opcode === 'gaddr' && o.attrs.passedAs === structSpelling(type));
        if (!object) {
          throw new Error(
            `internal: a by-value argument of '${d.attrs.target}' is not the address of an object of the struct it passes`,
          );
        }
        return { at, param, type };
      });
      const args = callArgs(d).map((v, i): Expr => {
        const x = e(v);
        return byValue.some((b) => b.at === i) && x.k === 'addr' ? { k: 'var', name: x.name } : x;
      });
      return {
        k: 'call',
        fn: through === undefined ? (d.attrs.target as string) : e(through),
        args,
        ...(wide64 ? { wide64: true as const } : {}),
        ...(d.attrs.sret === true ? { sret: d.results[0].type } : {}),
        ...(d.attrs.sret !== true && d.results[0]?.type.kind === 'struct' ? { returns: d.results[0].type } : {}),
        ...(byValue.length > 0 ? { byValue } : {}),
      };
    }
    if (d.opcode === 'laddr') {
      // gaddr's local twin: the address of the frame-local object the Thumb frontend PROVED
      // (frame-object audit — width/signed are stamped machine facts). The NAME is this layer's:
      // see laddrName. Renders `&sp0`; the object itself is declared in `locals`, and an ARRAY
      // one renders by decay, which the C printer reads off that declaration.
      return { k: 'addr', name: laddrName.get(d)! };
    }
    if (d.opcode === 'undef') {
      // An uninitialised local. NEVER emit a definition for it: the declaration in `locals` is the
      // entire recovery, and `sideEffects` skips an `undef` (neither effectful nor materialized),
      // which is what leaves it bare.
      return { k: 'var', name: undefName.get(d)! };
    }
    if (d.opcode === 'gaddr') {
      // A promoted CODE symbol (frontend `code: true`) is a function pointer stored as an
      // integer: spelled `(u32)Name` — the source idiom — never `&Name` (the & form compiles,
      // but it is a different and non-matching spelling).
      if (d.attrs.code === true) {
        return { k: 'cast', to: T.int(32, false), e: { k: 'var', name: d.attrs.sym as string } };
      }
      return { k: 'addr', name: d.attrs.sym as string };
    }
    if (d.opcode === 'load' || d.opcode === 'aload') {
      return lowerRead(d, e, (d.attrs.signed as boolean) ?? false);
    }
    return d.opcode === 'opaque'
      ? mkGap(gapReasonFor(d.attrs), d.operands.map(e))
      : mkGap(`no lowering for op '${d.opcode}'`, d.operands.map(e));
  };

  // A map EXTENDS the ambient post-loop substitution (`activeSub`, below) and wins where both map a
  // value: a loop's own reading is layered over the enclosing exit region's, which still holds
  // inside it. Replacing the ambient one would re-derive a value a previous loop left in its
  // variable's name from that name, which already holds it (`v1 + 1` for `v1`). `null` is no
  // substitution at all.
  const exprWith = (sub: Map<Value, string> | null) => {
    const e = (v: Value): Expr => {
      const subbed = sub === null ? undefined : (sub.get(v) ?? activeSub?.get(v));
      if (subbed) {
        if (zeroTripStale?.get(v) === subbed) {
          throw new StructureError(
            `cannot structure '${fn.name}': a read after the loop spells a value computed before it by a ` +
              `loop variable's name, which holds its initial value on a zero-trip run`,
          );
        }
        return { k: 'var', name: subbed };
      }
      if (varName.has(v)) {
        return { k: 'var', name: varName.get(v)! };
      }
      const d = defs.get(v);
      if (!d) {
        return mkGap('value has no reaching definition (dropped def)', []);
      }
      return lowerDef(d, e);
    };
    return e;
  };
  // The loop-emission hazard checks (readsClobbered / loopEscapeHazard / loopUpdateHazard) —
  // pure decline-or-emit predicates, extracted to hazards.ts behind the explicit-deps factory.
  // `varName` is captured as a live REFERENCE rather than copied, so each check reads the names
  // EMISSION sees. The map is already FINAL at this point — every write to it sits above, in the
  // naming walk and the coalescing that follows it, and these checks only read it — so today the
  // two readings coincide; the reference is what keeps them coinciding if a write ever moves down
  // here.
  const {
    readsClobbered,
    loopEscapeHazard,
    loopUpdateHazard,
    testSkipsAnEffect,
    preUpdateCondFold,
    sinkablePreUpdateSlots,
    sameAtEntry,
    loopWriteSet,
    loopWriteSetAhead,
  } = makeLoopHazards({
    defs,
    varName,
    useSitesOf,
    liveIn,
    opBlock,
    materialize,
    respelledDefs: bitfieldSpelling,
    emitPos,
  });

  // A POST-LOOP substitution active while structuring a loop's exit region: a loop-carried value (a
  // latch back-edge arg) is held in its loop-variable NAME after the loop, so any post-loop use must
  // read the name, not re-inline the computation (which would double-count, e.g. `(u8)(v1+1)` instead
  // of `v1`). `expr` consults it; `withSub` installs/merges it around the exit region. Null normally.
  let activeSub: Map<Value, string> | null = null;
  // The entries of a guarded self-loop's substitution its exit region may not render (that site's
  // `stale`), merged over every enclosing guarded loop's like `activeSub` is: consulted where ANY
  // substitution hit renders in scope, so it judges what the region spells, dead copies included —
  // which over-declines, the refusing direction.
  let zeroTripStale: Map<Value, string> | null = null;
  const expr = (v: Value): Expr => exprWith(activeSub)(v);
  // A return that hands back the function's own struct return object (frontend/own-struct-return.ts)
  // returns that local by value, `return ret;`, where its address would print `&ret`.
  const returnedValue = (term: Op): Expr => {
    const value = expr(term.operands[0]);
    return term.attrs[RETURNS_OBJECT] === true && value.k === 'addr' ? { k: 'var', name: value.name } : value;
  };
  const withSub = <R>(sub: Map<Value, string>, run: () => R): R => {
    const prev = activeSub;
    activeSub = prev ? new Map([...prev, ...sub]) : sub;
    try {
      return run();
    } finally {
      activeSub = prev;
    }
  };

  // Assignments a predecessor must perform when branching into `target`, as a PARALLEL
  // copy (skip identities), then sequentialised so no assignment clobbers a still-needed
  // value. `sub` (used for the emitWhile un-rotation's exit copies) substitutes back-edge args to
  // their header-param NAMES — post-loop the params already hold their updated values, so a merged
  // exit value is read as `v` not `v-1`.
  //
  // AN UNDEFINED ARGUMENT CARRIES NOTHING, so it gets no copy — WHERE THE DESTINATION IS ITSELF
  // UNDEFINED THERE. `undef` is storage nothing wrote on this path (ir/opcodes.ts), so
  // `w = uninit_sp0;` spells a read of storage that was never written: a statement the asm has no
  // instruction for, whose cost is the register the undefined value then occupies across the merge.
  // Dropping it leaves the variable holding whatever it held — the same thing exactly when nothing
  // ever wrote it before this edge, and a DIFFERENT FUNCTION otherwise. That second case is real:
  // a merge that adopted an incoming parameter's name emits `if (a0 == 0) a0 = uninit_sp0;`, where
  // dropping the copy would substitute the parameter's defined value for the undefined one.
  //
  // So the test is over the destination's whole name class: no value spelled with that name may
  // have a definition able to execute before this edge — its home block being this predecessor, or
  // reaching it, which through a back edge is also how an earlier iteration's write is caught.
  // Unsure keeps the copy. Edge copies only: a `store` or a `ret` of an undef value is a real
  // instruction and emits.
  //
  // A value's home is where the copies into it run, and anchoring MOVES one: an anchored const is
  // written at the const's own def site instead of on the edges (anchorConstCopies, above), and
  // that site dominates them. Its block is a write site for the name like any other, and without it
  // `v0 = 0; if (c) { } store v0;` drops the undefined arm's copy and stores 0 where the machine
  // stores whatever the arm left — the same substitution the parameter case makes, one step over.
  //
  // THE SECOND RELOCATION goes the other way, and this test cannot see it at all. A SUNK pre-update
  // exit copy (preUpdateCopies) writes the loop EXIT's param INSIDE the loop BODY, so the home this
  // reads for it — `paramBlock`, the exit block — sits strictly LATER in the CFG than where the copy
  // lands. What keeps the two apart is not this test but `dest-free-inside-loop`
  // (hazards.ts): a merge inside the body under the exit param's name is a block param
  // `definedInBody` sees, so the slot is never sunk in the first place. That gate carries its own
  // KNOWN GAP, so the pair is a conjecture rather than a proof — `sunkCopyOverDroppedUndef` re-checks
  // it per function once both records below are complete, which is the only point at which they can
  // be: the do-while path structures its body BEFORE it mints its sunk copies.
  const anchoredHome = new Map<string, Block[]>();
  for (const [def, entries] of anchoredAt) {
    for (const { name } of entries) {
      (anchoredHome.get(name) ?? anchoredHome.set(name, []).get(name)!).push(opBlock.get(def)!);
    }
  }
  /** Every copy `undefCarriesNothing` dropped, with the edge it was dropped from. */
  const droppedUndefCopies: { name: string; pred: Block }[] = [];
  /** Every sunk pre-update exit copy, homed where it LANDS (the loop header, which dominates every
   *  point inside the body a copy is rebuilt at) rather than where its destination param lives.
   *  These two lists are the postcondition's whole input. */
  const sunkCopyHomes: { name: string; home: Block }[] = [];
  /** A loop's sunk pre-update exit copies: those rebuilt at the op that computed their value, and
   *  those with no such op, which open the body. */
  type SunkCopies = { leading: Stmt[]; atDef: Map<Op, Stmt[]> };
  const NO_COPIES_AT_A_DEF: ReadonlyMap<Op, Stmt[]> = new Map();
  /** The `atDef` copies `sideEffects` has spelled — `assertSunkCopiesPlaced`'s input. */
  const sunkCopiesEmitted = new Set<Stmt>();
  const undefCarriesNothing = (arg: Value, name: string, pred: Block, coalescing = false): boolean => {
    // A `copied` undef is another storage's content moved into this one (`x = y` of two
    // uninitialised locals): the machine ran that move, so the copy is spelled.
    if (defs.get(arg)?.opcode !== 'undef' || defs.get(arg)!.attrs.copied === true) {
      return false;
    }
    // AN UNDEFINED VALUE READ UNDER ANOTHER NAME IS A RELATION. Dropping the copy leaves `name`
    // holding whatever it held, which equals the undefined value only where nothing else reads that
    // value: `int x, z; z = x; if (c) x = 5; return x * 2 + z;` at gcc 2.7.2 keeps x in v0 and
    // reads it as z too, so on `c == 0` the join's local IS z, and an unassigned `v0` beside
    // `uninit_v0` loses that. So the copy is dropped only where every other read of the value goes
    // through `name` itself: the coalesced undef below (which the coalescing test asks before it
    // has renamed it), or edge copies into joins of the same name.
    if (!coalescing) {
      const op = defs.get(arg)!;
      for (const site of useSitesOf.get(arg) ?? []) {
        if (site.op.operands.includes(arg) && undefName.get(op) !== name) {
          return false;
        }
        for (const s of site.op.successors) {
          if (s.args.some((a, i) => a === arg && varName.get(s.block.params[i]) !== name)) {
            return false;
          }
        }
      }
    }
    const writesBefore = (home: Block | undefined): boolean =>
      home === undefined || home === pred || reachFrom(home).has(pred);
    for (const [v, n] of varName) {
      if (n === name && writesBefore(paramBlock.get(v) ?? opBlock.get(defs.get(v)!))) {
        return false;
      }
    }
    return !(anchoredHome.get(name) ?? []).some(writesBefore);
  };
  // AN UNDEF ONE JOIN TAKES IS THAT JOIN'S LOCAL, READ BEFORE ITS ASSIGNMENT. `int t; if (k > 5)
  // g = t; switch (k) { case 0: t = …; } … t …` reads one source variable on both sides of the
  // switch, and the asm reads one register: the entry value directly, and again through the join
  // the arms assign. Named from its key it would be two declarations, `uninit_t7` beside the join's
  // `v9`, which the compiler allocates as two. So the undef takes the join's name when that name is
  // never written where any of its reads happen: every edge copy into the join is one
  // `undefCarriesNothing` drops, and every block that reads it — through the ops rendered inline
  // over it — passes the same test, so each read sees the name before anything assigned it.
  // A merge that adopted a parameter's name is never one (`v<n>` only). The reads are recorded with
  // the dropped copies, for the sunk-copy postcondition below to check them the same way.
  const coalescedUndefs = new Set<Op>();
  for (const op of fn.blocks.flatMap((b) => b.ops)) {
    if (op.opcode !== 'undef') {
      continue;
    }
    const u = op.results[0];
    const joins = new Set<string>();
    const intoJoin: Block[] = [];
    const readIn = new Set<Block>();
    let unnamed = false;
    for (const site of useSitesOf.get(u) ?? []) {
      for (const s of site.op.successors) {
        s.args.forEach((a, i) => {
          if (a === u) {
            const n = varName.get(s.block.params[i]);
            if (n === undefined) {
              unnamed = true;
            } else {
              joins.add(n);
            }
            intoJoin.push(site.blk);
          }
        });
      }
      if (site.op.operands.includes(u)) {
        const work = [site];
        for (let w = work.pop(); w !== undefined; w = work.pop()) {
          readIn.add(w.blk);
          if (!materialize.has(w.op)) {
            work.push(...w.op.results.flatMap((r) => useSitesOf.get(r) ?? []));
          }
        }
      }
    }
    const [name] = joins;
    if (
      unnamed ||
      joins.size !== 1 ||
      readIn.size === 0 ||
      !/^v\d+$/.test(name) ||
      globalNames.has(name) ||
      ![...intoJoin, ...readIn].every((b) => undefCarriesNothing(u, name, b, true))
    ) {
      continue;
    }
    undefName.set(op, name);
    coalescedUndefs.add(op);
    for (const b of readIn) {
      droppedUndefCopies.push({ name, pred: b });
    }
  }
  const tempCounter = { n: 0 }; // per-function swap-cycle temp names (sequentialize)
  /** One record per parameter slot an edge ACTUALLY carries, in the order the copies are to be
   *  laid out — everything `argAssignsFor` does except `sequentialize`. Split out because Regime-A
   *  switch recovery merges the records of a whole DISPATCH's edges and sequentializes the union
   *  ONCE (`hoistedDispatchAssigns` below); sequentializing per edge and then deduping would mint
   *  a swap-cycle temp per edge and spell a different program. */
  const edgeCopyRecords = (
    pred: Block,
    succ: { block: Block; args: Value[] },
    sub: Map<Value, string> | null = null,
    keepSlot: (i: number) => boolean = () => true,
  ): { name: string; value: Expr; arg: Value; param: Value }[] => {
    const target = succ.block;
    const argExpr = sub ? exprWith(sub) : expr;
    const copies: { name: string; value: Expr; arg: Value; param: Value }[] = [];
    const suppressed = suppressedArgs.get(succ);
    target.params.forEach((p, i) => {
      if (suppressed?.has(i) || !keepSlot(i)) {
        return;
      } // anchored at its const's def site (or emitted elsewhere) — this edge does not carry it
      const name = varName.get(p)!;
      const arg = succ.args[i];
      if ((sub?.get(arg) ?? varName.get(arg)) === name) {
        return;
      } // identity copy — coalesced away
      if (undefCarriesNothing(arg, name, pred)) {
        droppedUndefCopies.push({ name, pred });
        return;
      }
      copies.push({ name, value: intoDeclaredTemp(name, argExpr(arg)), arg, param: p });
    });
    // Emit in the order the pred WROTE the destinations (ir/core.ts `WriteOrder` — the frontend's
    // measurement; the value graph cannot show it, because a copy is the same SSA value under a new
    // key). This is a per-compiler behavior (orderArgCopiesByWriteOrder), not a universal: a
    // compiler that emits copies in source/param order sets it false and no sort runs at all.
    //
    // THE RULE IS TWO CLAIMS, and only the first is licensed by an instruction:
    //
    //  1. CYCLIC copy sets. `sequentialize` spills the FIRST pending destination, and the record
    //     names the destination whose FINAL value the compiler established earliest — the one whose
    //     old value had to be saved elsewhere, since every later reader of that old value reads it
    //     after the register stopped holding it. That is the compiler's own temp.
    //     READ THE QUANTITY AS THE LAST WRITE, not the first overwrite: a pred commonly writes a
    //     key several times (1,867 of 5,283 edge-destination records over klonoa, marioparty3 and
    //     af, in 312 of the 464 functions that record anything). Both alternatives cost matches
    //     over the 736 synthetic rows and gain none: recording the FIRST write loses `bgsplit`,
    //     `bgswitch`, `bgswsplit` and `hipress` (all agbcc, 482 → 478); REFUSING the record for a
    //     key written more than once loses those four plus `dmascope2` and `swmulti` (482 → 476).
    //  2. ACYCLIC copy sets — a SECOND, separately-licensed claim: that the compiler LAID THE
    //     COPIES OUT in the order it wrote them. No instruction states it, and it is two-sided, so
    //     the def-position spelling is enumerated beside the record's as a ranked candidate
    //     (`/copy-defpos`, rank.ts) instead of being declared here. Restricting the record to
    //     cyclic sets as the DEFAULT was measured over the 736 synthetic rows: it takes
    //     `armfall:agbcc` 11 → 8, `memcpy1:mwcc` 23 → 19 and `memset1:mwcc` 21 → 19 — and LOSES
    //     `gcd:agbcc` (the cyclic row's own entry edge is acyclic) and `structarr:agbcc` to
    //     nonmatch. The CANDIDATE spans that second claim only (`preferDefPosCopyOrder`: the proxy
    //     on acyclic sets, the record on cyclic ones), so no arm of the fan spells a cycle against
    //     the instruction that licenses it, and the pair differs exactly where the evidence runs
    //     out — which is what lets one function take the record on its back edge and the proxy on
    //     its entry edge, as `gcd:agbcc` does.
    //
    // IT REACHES FURTHER THAN `sequentialize`, because it decides which copy is an arm's LAST
    // statement: `l3/tailmerge.ts` peels only a common last statement, so an arm-varying copy
    // ordered last hides an agreeing one behind it (measured there, on klonoa
    // `CountCollectedGems`); and `recognizeForLoops` recovers a `for` only when the induction
    // update is last, so this sort also decides `for` vs `while` (goldens in
    // `structure-goldens.test.ts`). That is why `synthetic:gcd:agbcc` is a `while` — agbcc wrote
    // the dividend's register last, so the modulo update is not last.
    //
    // A destination with NO RECORD keeps `NO_RECORD`, sorting first, which is where the proxy also
    // puts an argument the pred did not compute: on those copies the two orders AGREE rather than
    // one replacing the other. Pinning unwritten destinations at their param-order slot instead
    // loses `armdef:agbcc`, `loopfall:agbcc`, `loopset:agbcc` and `structarr:agbcc` over the same
    // 736 rows, and buys back only `armfall` 11 → 7 and `ucmp:kmc` 15 → 14.
    if (orderArgCopiesByWriteOrder) {
      // UNMEASURED (undefined) is not "wrote nothing": a parsed or hand-built fn carries no record
      // at all and its edges keep the def-position proxy, while a MEASURED pred that recorded no
      // destination of this edge gets an empty record. The two cannot meet inside one fn —
      // measurement is all-or-nothing per function and `ir/verify.ts` enforces it — so this asks
      // per block only to spell the wholly unmeasured fn.
      const predIsMeasured = fn.writeOrder?.writes.has(pred) ?? false;
      // The `/copy-defpos` candidate asking for the proxy on an edge the frontend DID measure —
      // the one place the two questions ("is there a record" and "use it") come apart.
      const record =
        predIsMeasured && (!preferDefPosCopyOrder || copySetIsCyclic(copies))
          ? (fn.writeOrder!.lastWrite.get(pred) ?? NO_WRITTEN_DESTINATIONS)
          : undefined;
      const rank =
        record !== undefined
          ? (c: (typeof copies)[number]) => record.get(c.param) ?? NO_RECORD
          : // opIndex is only valid for a def IN this block; a def elsewhere gets NO_RECORD too.
            (c: (typeof copies)[number]) => {
              const d = defs.get(c.arg);
              return d && opBlock.get(d) === pred ? opIndex.get(d)! : NO_RECORD;
            };
      copies.sort((a, b) => rank(a) - rank(b));
    }
    return copies;
  };
  // The copies for ONE specific successor record — the workhorse behind argAssigns, taken
  // directly by the switch_br path, whose duplicate case targets successorTo cannot
  // disambiguate.
  const argAssignsFor = (
    pred: Block,
    succ: { block: Block; args: Value[] },
    sub: Map<Value, string> | null = null,
    keepSlot: (i: number) => boolean = () => true,
  ): Stmt[] =>
    sequentialize(
      edgeCopyRecords(pred, succ, sub, keepSlot).map(({ name, value }) => ({ name, value })),
      varType,
      tempCounter,
      fn.name,
    );
  /** THE DISPATCH HOIST (Regime-A switch recovery). Recovering a comparison tree COLLAPSES its
   *  test blocks, and an edge's only emission is its parallel copy — so every copy the dispatch's
   *  edges carried would be discarded with the tree. This re-emits them above the `switch`, ONCE
   *  PER NAME the dispatch binds — which is not once per machine write: `sw_fall`'s three arms
   *  each take the accumulator under a name of their own, so this tree emits `v0 = 0; v1 = 0;
   *  v2 = 0;` where agbcc has a single `mov r1, #0`, and the one-local spelling that byte-matches
   *  comes from the `/merge-home` ranked variation, not from here. What the position is for is the
   *  fall-through chain: per-arm copies RE-RUN on the fall path and overwrite what the falling arm
   *  computed, the hazard Regime B states at its own `switch_br` refusal.
   *
   *  Null (⇒ the caller declines to if-recovery, which spells every copy the asm performs) on the
   *  two things one hoisted statement cannot say. Both are stated over NAMES, because the name is
   *  what the statement writes. NEITHER FIRES ON A CORPUS ROW: over the synthetic tier the only
   *  functions offering the hoist a param-carrying dispatch edge are the `sw_fall*` family (four
   *  of them, 13 edges under 10 names), it emits on all four, and what refuses is the caller's own
   *  `availableAtRoot`. Both refusals below are pinned by hand-written `.s` in
   *  `test/switch-arms.test.ts` and by nothing else — read them as invariants, not as evidence:
   *
   *    - DISAGREEING EDGES. Two edges binding one name to different values: which one runs depends
   *      on which test fell through, and a single statement above the tree cannot depend on that.
   *      Order-independent, so no emission order hides it.
   *    - A CLOBBERED LIVE NAME. The hoisted write runs on EVERY path through the dispatch,
   *      including into arms whose own edge did not carry it. If any value under that name is
   *      live where the switch begins, or into one of its arms, the hoist would overwrite a value
   *      those readers still want. THE SCAN REACHES values read at or after the listed blocks'
   *      entries, and by construction NOT: the parameters of those blocks (`analysis.ts` kills a
   *      block's params at its own entry), a value defined in the root whose only use is a
   *      dispatch edge arg, or a binding elided upstream (identity copy, `undefCarriesNothing`, a
   *      suppressed anchored slot), which contribute no name to compare. Binding an arm's
   *      parameters is what the hoist is FOR, so that blindness is wanted; the other three are
   *      gaps nobody has turned into a wrong answer.
   *
   *  `anchorConstCopies` (above) relocates an edge copy too, and states two clauses this does not;
   *  neither absence is an oversight. Its LOOP clause does not transfer: anchoring moves a write to
   *  the const's DEF site, which may sit outside the loop the edge is in (block dominance is not
   *  per-iteration precedence — see that clause's own statement above), while the hoist moves a
   *  write from a dispatch's edges to the head of that same dispatch, same iteration every time
   *  (`switch-arms.test.ts` pins a param-carrying dispatch inside a `do`-`while`). Its NAME-COUNT
   *  clause — refuse a name several SSA values carry — cannot be adopted, because that is this
   *  mechanism's whole subject: one name per arm taking the accumulator. As a refusal it declines
   *  the empty-arm fall-through switch of `retsink.test.ts` outright, for no row's benefit.
   *
   *  ORDER ACROSS EDGES IS UNLICENSED. Within one edge, `edgeCopyRecords` sorts by the pred's
   *  measured `WriteOrder`; the union below keeps the first record per name in TREE-WALK order,
   *  which no compiler measured — there is no per-pred record spanning writes that different preds
   *  performed. It is deterministic, and `switch-arms.test.ts` pins the three-name order `sw_fall`
   *  emits so that a change to the walk fails loudly rather than silently re-spelling a match.
   *
   *  What it does NOT re-check is that evaluating an arg AT THE ROOT rather than on its edge is
   *  value-preserving. That rests on the collapsed blocks being pure (switch-recover.ts's PRE4)
   *  and on every hoisted arg being available at the root, which the caller establishes before
   *  calling — the hoist depends on those rules, it does not weaken them. */
  const hoistedDispatchAssigns = (
    edges: readonly { pred: Block; succ: { block: Block; args: Value[] } }[],
    liveAt: readonly Block[],
  ): Stmt[] | null => {
    // `edgeCopyRecords` is not a pure query: an `undef` arg whose copy it drops is APPENDED to
    // `droppedUndefCopies`, which a loud postcondition below reads. This caller is SPECULATIVE — it
    // asks every dispatch edge and may still decline — so the records are rolled back on the
    // refusal paths, leaving the audit trail describing the program actually emitted (the caller
    // then declines to if-recovery, which re-walks the same edges through `argAssignsFor` and
    // records them there). `undefCarriesNothing` judges PER PRED, against what that predecessor
    // wrote, while the hoist emits at the ROOT — so the record belongs to the edge walk that
    // survives, not to this one. The rollback covers the refusals THIS function owns: a hoist that
    // succeeds and is declined further down (an arm refusal in switch-recover.ts) still leaves its
    // records, as it leaves any swap-cycle temp name `sequentialize` minted.
    const auditMark = droppedUndefCopies.length;
    const rollBack = (): null => {
      droppedUndefCopies.length = auditMark;
      return null;
    };
    const merged = new Map<string, { name: string; value: Expr; arg: Value; param: Value }>();
    for (const { pred, succ } of edges) {
      for (const c of edgeCopyRecords(pred, succ)) {
        const prev = merged.get(c.name);
        if (prev === undefined) {
          merged.set(c.name, c);
        } else if (prev.arg !== c.arg) {
          return rollBack(); // disagreeing edges
        }
      }
    }
    if (merged.size === 0) {
      return [];
    }
    const bound = new Set([...merged.values()].map((c) => c.param));
    for (const blk of liveAt) {
      for (const v of liveIn.get(blk) ?? []) {
        const nm = varName.get(v);
        if (nm !== undefined && merged.has(nm) && !bound.has(v)) {
          return rollBack(); // a clobbered live name
        }
      }
    }
    return sequentialize(
      [...merged.values()].map(({ name, value }) => ({ name, value })),
      varType,
      tempCounter,
      fn.name,
    );
  };
  const argAssigns = (
    pred: Block,
    target: Block,
    sub: Map<Value, string> | null = null,
    keepSlot?: (i: number) => boolean,
  ): Stmt[] => {
    const succ = successorTo(pred, target);
    return succ ? argAssignsFor(pred, succ, sub, keepSlot) : [];
  };

  // Side-effecting ops of a block, emitted as statements in program order: memory stores; any
  // EFFECTFUL op whose result nothing consumes (a void/discarded call, and an `opaque` standing for
  // an instruction asmlift could not model); and MATERIALIZED defs — a call/load whose value cannot
  // soundly render at its use is assigned to its named temp here, at its own program position.

  /** THE REFUSAL for the read half of `unreadResult`: is this dead read QUALIFIED (ir/discipline.ts
   *  `qualified`)? `pinnedAccess` then puts the qualifier on its spelling, from the dead-read pin
   *  (frontend/dead-reads.ts), the device pin, or the map's declaration of the object it reads, and
   *  `gStatus;` under `extern volatile u32 gStatus;` compiles differently from its own absence. A
   *  plain read is dropped: an unqualified `p[2];` compiles to the same bytes as no statement at all
   *  (measured on agbcc, IDO and mwcc), so spelling it claims an access no candidate makes.
   *
   *  ONE DECIDER. Whether a read nobody uses was `volatile` is the dead-read pin's question, asked
   *  once of the raw lift, at any address, with its refusals tabled and reported. The read that
   *  reaches this walk unused because a DECLARED void return suppressed the `ret` operand is the
   *  same question, and the pin answers it too: it does not count that operand as a use. So no
   *  address window, base-local or second-access rule is asked here; a read the pin refused is
   *  plain, and dropped. */
  const volatileQualifiable = (op: Op): boolean => qualified(op);

  /** Ops the `sideEffects` walk must SPELL even though nothing consumes their result — the
   *  question ir/discipline.ts asks of every op (`spelledWhenDead`), so the next op to acquire the
   *  property needs no edit here, plus the qualifier refusal above for the memory-read half.
   *
   *  A memory READ is not `effectful`, deliberately: ir/discipline.ts calls a load deletable when
   *  dead, because nothing observes a read nobody reads. That is the C claim. The COMPILER
   *  claim points the other way — an optimizing compiler deletes every dead read it is allowed to
   *  delete, so one still in the target is evidence the source's access was `volatile`, and
   *  dropping it deletes an instruction the machine executed. The pin makes that claim; this walk
   *  spells what it stamped. */
  /** Does `op` render AT ITS OWN POSITION, as `v = f(…)`?
   *
   *  ONE DEFINITION, TWO READERS, on purpose: `isSpelled`'s base case is a MODEL of what
   *  `sideEffects` emits, and a predictor and an emitter that disagree spell a call zero times or
   *  twice. There is no third copy in `unreadResult`, and none is needed — it falls out of position
   *  instead, because `sideEffects` tests the assign branch BEFORE the `unreadResult` branch and
   *  `isSpelled` returns at its base case without ever asking `unreadResult`. */
  const rendersAtOwnPosition = (op: Op): boolean => materialize.has(op) && !absorbedLoads.has(op);
  const spelledMemo = new Map<Op, boolean>();
  /** Will the tree SPELL `op` anywhere — as a statement of its own, or inlined into one?
   *
   *  `useSitesOf` is SYNTACTIC, and that is not the question `unreadResult` is asking. An op whose
   *  result feeds one pure op that is itself never rendered HAS a use site, so the syntactic test
   *  reads it as consumed; nothing then renders the consumer either, and an effectful op the
   *  machine executed disappears with no statement and no diagnostic — the one outcome the
   *  `sideEffects` walk exists to prevent. The analysis registry carries a HAND-WRITTEN instance of
   *  the same correction one level up (a void function's `ret` operand is left out of the registry,
   *  so a call feeding only the suppressed return reads as dead); this is its transitive form, which
   *  the registry cannot express because "is it rendered" is a question about the TREE. Measured by
   *  the IR oracle rather than by a reader: without this walk `irTraceOf` disagrees with the emitted
   *  tree on 433 of `generateSsaFn`'s 4,000 acyclic seeds, every one a call the IR performed and the
   *  tree did not, and both naming fuzzes' REFERENCE spellings share the defect exactly.
   *
   *  A TERMINATOR, a `store`/`astore`/`ret` and a materialized def each render at their own
   *  position, so they are the base cases (the first three have no results and fall out of the
   *  same test). Everything else is spelled iff something spelled reads it — or iff it is effectful
   *  and nothing does, which is this walk. No cycle is reachable: op→op edges follow SSA def-use,
   *  and a cycle can only close through a block PARAM, which is not an op result. The memo is still
   *  seeded `true` before recursing, so a malformed function degrades to the over-admitting answer
   *  rather than recursing forever.
   *
   *  WHAT THIS DELIBERATELY DOES NOT MODEL: an edge argument into a block param NOTHING READS is
   *  also spelled nowhere, so in principle the walk should stop at a dead param rather than at the
   *  terminator. That clause moves the residual by ZERO — d0 48/4,000, d1 31/2,508, d2 6/1,556 with
   *  it and the identical counts without — because `argAssigns` writes a copy into every NAMED param
   *  whether or not the param is read, and the naming walk names the params of these shapes. Holding
   *  that draw takes two further clauses (skip the copy test for a named param, or `fz735`'s call is
   *  spelled twice), so it is three rules that buy nothing and it is not here. */
  const isSpelled = (op: Op): boolean => {
    const memo = spelledMemo.get(op);
    if (memo !== undefined) {
      return memo;
    }
    if (op.results.length === 0 || rendersAtOwnPosition(op)) {
      return true;
    }
    spelledMemo.set(op, true);
    const r = hasSpelledUse(op.results[0]) || unreadResult(op);
    spelledMemo.set(op, r);
    return r;
  };
  /** Does any op the tree spells READ `v`? */
  const hasSpelledUse = (v: Value): boolean => (useSitesOf.get(v) ?? []).some((s) => isSpelled(s.op));

  const unreadResult = (op: Op): boolean =>
    spelledWhenDead(op) &&
    op.results.length > 0 &&
    // NO EXEMPTION FOR A MATERIALIZED DEF HERE, and it is not missing. Such a def already renders
    // at its own position, as `v = f(…)`, which spells the effect as surely as a bare statement
    // does; taking the `exprstmt` branch for one instead emits `expr(result)` — the NAME, so `v3;`
    // replaces `v3 = f0(…)` and the call is gone. Both callers rule that out BEFORE asking:
    // `isSpelled` returns at its `rendersAtOwnPosition` base case, and `sideEffects` tests the
    // assign branch first. Under a transitive use test the two sets overlap constantly — a
    // materialized def's name is often read by nothing spelled — so that ordering is load-bearing,
    // and `dead-effect.test.ts`'s `MATERIALIZED` pins it.
    !hasSpelledUse(op.results[0]) &&
    (opSig(op.opcode)?.reads !== true || volatileQualifiable(op));

  const sideEffects = (b: Block, atDef: ReadonlyMap<Op, Stmt[]> = NO_COPIES_AT_A_DEF): Stmt[] => {
    const out: Stmt[] = [];
    for (const op of b.ops) {
      if (op.opcode === 'store') {
        // a mask-and-insert recognized over the ops (see the precompute above): the member
        // assignment, not the read-mask-or-store chain
        const bfs = bitfieldStore.get(op);
        if (bfs) {
          out.push({
            k: 'store',
            lval: { k: 'field', base: { k: 'var', name: bfs.global }, name: bfs.field, dot: true },
            // `zero` is the ALL-ZERO form: the asm carries no value at all, because agbcc emits
            // only the clearing `and` when the assigned value is 0 (structure/bitfields.ts).
            value: bfs.value.k === 'zero' ? { k: 'const', value: 0 } : expr(bfs.value.v),
          });
          continue;
        }
        // A store whose lvalue is a bare global (`gSym = v`, from an `&gSym` base at off 0) emits
        // as an ASSIGN, not a store — memAccess returns a `var` node for that case.
        const width = op.attrs.width as number;
        const off = op.attrs.off as number;
        const stamp = op.attrs.signed as boolean | undefined;
        const viewed = frameUnionAccess(op.operands[0], off, width, storeView(op, width), true);
        if (viewed !== null) {
          const lval = unqualifiedView(op, viewed);
          floatBitsStoreTarget(op.operands[1], lval);
          out.push({ k: 'store', lval, value: intoPtrCell(lval, expr(op.operands[1])) });
          continue;
        }
        const member = frameStructMember(op, off, width, null);
        if (member !== null) {
          floatBitsStoreTarget(op.operands[1], member);
          out.push({ k: 'store', lval: member, value: intoPtrCell(member, expr(op.operands[1])) });
          continue;
        }
        const baseExpr = expr(op.operands[0]);
        const lval0 = structBytesCell(
          op.operands[1],
          memAccess(
            op.operands[0],
            baseExpr,
            off,
            width,
            storeView(op, width),
            ctype,
            scalarGlobals,
            symCtx,
            true, // an lvalue: a member whose declaration is const cannot be NAMED as the target
            advanceStepOf(op.operands[0]),
            qualifiedBy(op) === 'cast',
            frameArrayFor(op),
          ),
        );
        floatBitsStoreTarget(op.operands[1], lval0);
        if (lval0.k === 'var') {
          globalNames.add(lval0.name);
          out.push({ k: 'assign', name: lval0.name, value: intoPtrCell(lval0, expr(op.operands[1])) });
          continue;
        }
        // a member whose declared sign is not the stamp's is spelled as the flat cell (stampedStoreLval)
        const bt = op.operands[0].type;
        const lval = pinnedAccess(
          op,
          stampedStoreLval(
            lval0,
            stamp,
            width,
            bt.kind === 'ptr' && bt.to.kind === 'struct' ? baseExpr : null,
            off,
            ctype,
          ),
        );
        out.push({ k: 'store', lval, value: intoPtrCell(lval, expr(op.operands[1])) });
      } else if (op.opcode === 'astore') {
        const elemSize = op.attrs.elemSize as number;
        const fieldOff = op.attrs.fieldOff as number | undefined;
        const stamp = op.attrs.signed as boolean | undefined;
        const lval0 = structBytesCell(
          op.operands[2],
          arrayAccess(
            op.operands[0],
            expr(op.operands[0]),
            expr(op.operands[1]),
            fieldOff,
            op.attrs.memberOff as number | undefined,
            elemSize,
            storeView(op, elemSize),
            ctype,
            symCtx,
            frameArrayFor(op),
          ),
        );
        // a struct-array element's field: `base[i].field_K`, whose flat cell is
        // `(base + i)[K / width]` — C scales `base + i` by the element, exactly as `base[i]` does
        const el = lval0.k === 'field' && lval0.base.k === 'index' ? lval0.base : null;
        const lval =
          el === null || fieldOff === undefined
            ? lval0
            : stampedStoreLval(lval0, stamp, undefined, { k: 'bin', op: '+', l: el.base, r: el.idx }, fieldOff, ctype);
        floatBitsStoreTarget(op.operands[2], lval);
        out.push({
          k: 'store',
          lval: pinnedAccess(op, lval),
          value: expr(op.operands[2]),
        });
      } else if (rendersAtOwnPosition(op)) {
        // FIRST, and that order is the rule rather than a restatement of it: this branch is what
        // "renders at its own position" MEANS, so an op it claims can never reach the `exprstmt`
        // branch below and be spelled as a bare `v3;` with the call dropped.
        // (an absorbed load's every consumer spells a named bitfield read — emitting its temp
        // here would recompile to a second load the asm does not have)
        const nm = varName.get(op.results[0])!;
        out.push({ k: 'assign', name: nm, value: intoDeclaredTemp(nm, lowerDef(op, expr)) });
      } else if (unreadResult(op)) {
        // An op whose result nobody reads is still an execution. `store`/`astore` have no result and
        // were handled above, so what reaches here is `call`, `opaque` and a memory READ — and an
        // `opaque` missing from this walk is an instruction the frontend could not model
        // disappearing with no diagnostic, which is the one thing this project refuses to do.
        //
        // Statement, not expression — `expr` on the result routes through `lowerDef`, already where
        // `opaque` becomes the gap, so this reuses the SAME degradation a live opaque gets rather
        // than inventing a second way to be loud.
        out.push({ k: 'exprstmt', value: expr(op.results[0]) });
      }
      // a merge copy anchored at this const's original position (anchorConstCopies, above)
      for (const a of anchoredAt.get(op) ?? []) {
        out.push({ k: 'assign', name: a.name, value: expr(a.arg) });
        anchorsEmitted.add(a);
      }
      // a sunk pre-update exit copy, rebuilt at the op that computed its value (preUpdateCopies).
      // Reached for the same reason the anchored copies are: every key is an op with a RESULT, so
      // none of them is the `store`/`astore` this walk `continue`s out of above. A PARAMETER, where
      // the anchored copies read a module-level map: a sunk copy belongs to ONE loop's body, and a
      // map would let the generic `sideEffects(b)` calls emit it in an unrelated context — silently,
      // because `assertSunkCopiesPlaced` would see it placed.
      for (const st of atDef.get(op) ?? []) {
        out.push(st);
        sunkCopiesEmitted.add(st);
      }
    }
    return out;
  };

  // Blocks currently on the recursion stack. A well-formed reducible CFG structures each
  // block at most once per active path, so re-entering a block already on the stack means an
  // unrecovered back-edge (a cycle loop-recovery didn't lower) — which would recurse forever.
  // Bail explicitly instead. This also bounds recursion depth by the block count.
  const onStack = new Set<Block>();
  // do-while headers currently being emitted — so structuring the do-while's own body (which re-enters
  // the header block to structure its ops up to the latch) does not re-trigger the do-while hook.
  const dwActive = new Set<Block>();
  // The innermost loop whose BODY is currently being structured. A body cond_br with one edge back
  // to `header` is a conditional continue; its other edge, when it leaves the loop, is an early exit
  // (a `break` to `exit`, or an early `return` through a trampoline). Null outside any loop body —
  // the early-exit branch in structureBlock is inert there.
  type LoopFrame = {
    header: Block;
    exit: Block | null;
    body: Set<Block>;
    arms: LoopArm[];
    breaks: ReadonlySet<Block>;
    breakArms?: readonly BreakArm[];
    twoLevel?: TwoLevelExit;
    /** the loop an outward two-level exit is handed out to (`TwoLevelExit.outward`) */
    enclosing?: LoopFrame;
    /** the latch of a `while (1)` spelled `for` (`ForPlan`): an edge into it is `continue;`, and one
     *  into `exit` is `break;` */
    forLatch?: Block;
  };
  let loopCtx: LoopFrame | null = null;
  // A jump table in a `while (1)` that declines: the rerun spells that loop `for` (`ForRanking`).
  const wantFor = (): void => {
    if (loopCtx !== null && loopCtx.forLatch === undefined && foreverLoops.has(loopCtx.header)) {
      forRank.wanted.add(loopCtx.header);
    }
  };
  const withLoop = <R>(frame: LoopFrame, run: () => R): R => {
    const prev = loopCtx;
    loopCtx = frame;
    try {
      return run();
    } finally {
      loopCtx = prev;
    }
  };

  // THE SWITCH ARMS being structured, innermost last — one frame per arm, in both regimes, so a
  // `break;` can be checked against what C binds it to. A C `break` leaves the innermost enclosing
  // loop OR switch, so a switch-scoped one is only spelled where this arm's frame is the innermost
  // switch frame AND no loop was entered since the arm began (`loop` is the loop frame the arm sits
  // in). `region` is the arm's own blocks (`ArmExit`), closed or falling; null on an arm the exit
  // analysis gave none (one that leaves sideways), which structures to the CFG's joins and stops AT
  // the merge without the statement. A frame with no region still matters: it is what tells a
  // `break;` reached inside a nested switch that it would bind the inner one, and the loop-exit
  // rules that a loop's `break` cannot be minted here. `fallsTo` is the sibling a falling arm runs
  // into (`armJoin` reads it).
  type SwitchFrame = {
    merge: Block | null;
    loop: LoopFrame | null;
    region: ReadonlySet<Block> | null;
    fallsTo: Block | null;
    /** the flags of the outward two-level exits handed out through this arm's switch
     *  (`handedThroughSwitch`) */
    flags: Set<string> | null;
  };
  const switchFrames: SwitchFrame[] = [];
  // every label a case-label `goto` (l3/ast.ts) names in this function, so no two arms share one
  const caseLabelNames = new Set<string>();
  // the latches and exits of every `for` (`ForPlan`) whose body is being structured
  const forJumps = new Set<Block>();
  // AN OUTWARD EXIT HANDED OUT THROUGH A SWITCH (`emitForever`): in a case body `if (f != 0) break;`
  // leaves only the switch, so the switch is followed at once by a second `if (f != 0) break;` that
  // leaves the loop, and is preceded by `f = 0;`, since a path that never entered the inner loop
  // reaches that test too. One scope per switch being emitted, opened by `withSwitchFlags` around
  // its arms (Regime A from `handedThroughSwitch`, Regime B at the jump table); each arm's frame
  // holds its switch's.
  const switchFlagScopes: Set<string>[] = [];
  const withSwitchFlags = <R>(run: () => R): [R, ReadonlySet<string>] => {
    const flags = new Set<string>();
    switchFlagScopes.push(flags);
    try {
      return [run(), flags];
    } finally {
      switchFlagScopes.pop();
    }
  };
  const handedThroughSwitch = <S extends Stmt[] | null>(run: () => S): S => {
    const [out, flags] = withSwitchFlags(run);
    const at = out === null ? -1 : out.findIndex((st) => st.k === 'switch');
    return out === null || at < 0
      ? out
      : ([...out.slice(0, at), ...aroundSwitch(flags, out[at]), ...out.slice(at + 1)] as S);
  };
  // `if (f != 0) break;`, the one spelling of a flag read where it is handed out
  const breakOnFlag = (name: string, ofSwitch: boolean): Stmt =>
    mkIf(
      { k: 'bin', op: '!=', l: { k: 'var', name }, r: { k: 'const', value: 0 } },
      [{ k: 'break', ...(ofSwitch ? { ofSwitch: true } : {}) }],
      [],
    );
  const aroundSwitch = (flags: ReadonlySet<string>, sw: Stmt): Stmt[] => [
    ...[...flags].map((name): Stmt => ({ k: 'assign', name, value: { k: 'const', value: 0 } })),
    sw,
    ...[...flags].map((name) => breakOnFlag(name, false)),
  ];
  // THE ONE RULE THAT BINDS A `break;` TO A SWITCH ARM: does a `break;` written here reach `b`? It
  // does where `b` is the merge of the innermost arm with a region and no loop was entered since
  // that arm began. `switchBreakAt` spells it, and `emitForever` asks it for a flag's `break`.
  const switchBreaks = (b: Block): boolean => {
    const f = switchFrames[switchFrames.length - 1];
    return f !== undefined && f.region !== null && f.merge === b && f.loop === loopCtx;
  };
  // Is `b` the merge of an arm with a region, reached before that arm's end, and may `break;` say so
  // from here (`switchBreaks`)? Undefined when no such arm ends at `b`. (At an arm's own end, `stop`
  // is the merge and `structureRegion` returns before asking.) Throws when one does but a nested
  // loop or switch would capture the statement.
  const switchBreakAt = (b: Block): Stmt[] | undefined => {
    let i = switchFrames.length - 1;
    while (i >= 0 && (switchFrames[i].region === null || switchFrames[i].merge !== b)) {
      i--;
    }
    if (i < 0) {
      return undefined;
    }
    if (!switchBreaks(b)) {
      throw new StructureError(
        `cannot structure '${fn.name}': a case body leaves its switch from inside a nested ` +
          `${i !== switchFrames.length - 1 ? 'switch' : 'loop'}, where \`break\` would leave that instead`,
      );
    }
    return [{ k: 'break', ofSwitch: true }];
  };
  // THE JOIN OF A BRANCH INSIDE AN ARM. The CFG's join for `if (c) break;` lies past the switch —
  // in a falling arm the fall-through path reaches the merge too, through the next arm, and in a
  // closed arm the merge IS the join — so structuring to it would copy the next arm, or the rest of
  // this one, into both sides. Inside the arm, an edge to the merge is a `break;` and a `ret` a
  // `return`: jumps, which end their path wherever they sit, so those edges are DELETED, as
  // `loopJoin` deletes a loop body's exits (`regionJoins`). The edge into the sibling the arm falls
  // into is no jump: its path runs to the arm's END, so it goes to EXIT, the caller's `stop`. Sent
  // to EXIT too, a guard whose one side breaks would be post-dominated by EXIT alone and every
  // statement after it would nest in its `else`; deleted, a guard whose one side falls would join
  // on the other side's path, which the falling path cannot jump over. Null ⇒ the paths meet only
  // at the arm's end. Asked only in the innermost arm frame and outside any loop entered since,
  // which is where `switchBreakAt` would spell the `break;`.
  const armJoins = new Map<ReadonlySet<Block>, Map<Block, Block | null>>();
  const armJoin = (b: Block, stop: Block | null): Block | null | undefined => {
    const f = switchFrames[switchFrames.length - 1];
    if (f === undefined || f.region === null || !f.region.has(b) || f.loop !== loopCtx) {
      return undefined;
    }
    const region = f.region;
    let pd = armJoins.get(region);
    if (pd === undefined) {
      pd = regionJoins(region, null, false, f.fallsTo);
      armJoins.set(region, pd);
    }
    const join = pd.get(b) ?? null;
    // IN A CLOSED ARM, AN EDGE TO THE MERGE IS USUALLY THE ARM'S OWN END, not a `break;`: in
    // `case 7: s *= 2; if (s > 100) s = 1; break;` the guard's edge past `s = 1` is where the arm
    // runs off, and deleting it makes `s = 1` the join and spells `if (!(s > 100)) break; s = 1;`.
    // What the deletion is for is a TAIL two of the arm's paths share behind a mid-arm `break;`
    // (`if (a) { if (b) break; g(1); } h(2); break;`, where `h(2)` is the join). So a closed arm
    // takes its own join only where the join is such a meeting point, two of the arm's blocks
    // entering it, or where the region being structured already ends INSIDE the arm (`stop` is one
    // of its blocks: an enclosing guard found such a tail, and a path to the merge from here jumps
    // over it). Otherwise it reads the CFG.
    if (
      f.fallsTo === null &&
      !(stop !== null && region.has(stop)) &&
      (join === null || new Set(preds.get(join)?.filter((p) => region.has(p))).size < 2)
    ) {
      return undefined;
    }
    return join;
  };

  // THE IMPLICIT CONTINUE. A branch with one edge back to the loop header spells that edge as
  // nothing at all: control falls to the bottom of the body and the loop goes round. That holds only
  // where the region being structured ends at the loop bottom (`stop === frame.header`). An `if` in
  // the body whose join lies outside it, at the loop's exit, hands its arms that exit as `stop` and
  // renders the exit region after itself, still inside the body: an implicit continue there falls
  // into that region and the loop runs at most once. Both spellings of a branch that leaves the loop
  // beside such an edge consult this.
  const continueFallsToBottom = (frame: LoopFrame, stop: Block | null): boolean => stop === frame.header;

  // THE BREAK RULE, for a `break` from block `from` out of `frame`'s body wherever the edge sits. A
  // `break` lands after the loop, where the header→exit copies render and then the exit region, raw.
  // Refused:
  //   • a `do-while`: its exit copies live post-loop too, but are judged differently;
  //   • the header→exit edge has copies the break cannot share: the break path runs them too, and
  //     they would overwrite what the break carried;
  //   • the exit region reads a loop value under a loop variable's name that `writes` holds —
  //     the names this iteration has rewritten by the time the break leaves.
  //
  // A BREAK THAT CARRIES WHAT THE HEADER CARRIES shares them. When every argument the break edge
  // hands the exit is the very value the header's exit edge hands it, the break needs no copies of
  // its own: it leaves `bare` and falls into the header's copies after the loop, which compute the
  // same values. They compute them from the names they read, at the loop's end instead of at the
  // header, so those names must still hold what the header read: none may be one `writes` holds.
  // Without that clause a latch break spelled after its update runs the update twice —
  // `v = v + 1; break;`, then the header's copy `x = v + 1` after the loop. The clause is judged
  // over every argument the header hands the exit, at the value level, and not only over the copies
  // that render: an exit parameter that takes its argument's own name renders no copy, yet the exit
  // still reads that name, and a latch update that wrote it hands the exit the updated value.
  //
  // A TWO-LEVEL EXIT (`TwoLevelExit`) is judged as a `while (1)`'s break to its own target `to`:
  // the region it lands in is the code from `to` on, which reads what the break left in the names.
  const breakRule = (
    frame: LoopFrame,
    from: Block,
    writes: Set<string>,
    to: Block | null = frame.exit,
  ): { refusal: string } | { bare: boolean } => {
    const exit = to;
    if (exit === null) {
      return { refusal: 'leaves a loop that has no exit' }; // DEFENSIVE: no edge leaves such a loop
    }
    if (exit !== frame.exit && !foreverLoops.has(frame.header)) {
      return { refusal: 'leaves for a second target a loop with a test of its own cannot spell' }; // DEFENSIVE
    }
    // A `while (1)` has no copies of its own after the loop, so a break carries its own, computed
    // where it leaves; what is left is the exit region's re-derivations. An inner loop's value the
    // region reads under its name (`emitForever`) is no re-derivation.
    const fl = foreverLoops.get(frame.header);
    if (fl !== undefined) {
      const exitRegion = new Set([exit, ...reachFrom(exit)].filter((x) => !frame.body.has(x)));
      const { sub } = latchInnerSub(fl.header, fl.body, [...fl.breaks], exitRegion);
      return loopEscapeHazard(frame.body, sub, writes, exitRegion)
        ? { refusal: 'reaches an exit region that reads a loop value under a name this iteration already rewrote' }
        : { bare: false };
    }
    if (!whileLoops.has(frame.header)) {
      return { refusal: 'leaves a do-while' };
    }
    const headerCopies = argAssigns(frame.header, exit);
    let bare = false;
    if (headerCopies.length !== 0) {
      const headerArgs = successorTo(frame.header, exit)!.args;
      const breakArgs = successorTo(from, exit)!.args;
      const reads = new Set<string>();
      for (const s of headerCopies) {
        stmtExprs(s).forEach((e) => exprVars(e, reads));
      }
      bare =
        breakArgs.every((v, k) => v === headerArgs[k]) &&
        ![...reads].some((n) => writes.has(n)) &&
        !headerArgs.some((a) => readsClobbered(a, new Map(), writes));
      if (!bare) {
        return { refusal: 'would run the copies the loop header hands its exit' };
      }
    }
    const exitRegion = new Set([exit, ...reachFrom(exit)].filter((x) => !frame.body.has(x)));
    if (loopEscapeHazard(frame.body, new Map(), writes, exitRegion)) {
      return { refusal: 'reaches an exit region that reads a loop value under a name this iteration already rewrote' };
    }
    return { bare };
  };
  // The loop-variable names an iteration has written on its way from the header to `b`, before any
  // update copy (`loopWriteSetAhead`).
  const writtenAhead = (frame: LoopFrame, b: Block): Set<string> => {
    const ahead = new Set<Block>([b]);
    for (const stack = [b]; stack.length;) {
      for (const p of preds.get(stack.pop()!) ?? []) {
        if (p !== frame.header && frame.body.has(p) && !ahead.has(p)) {
          ahead.add(p);
          stack.push(p);
        }
      }
    }
    const incoming = (x: Block) => [...inEdgeRecords(preds, x)].map(({ succ }) => succ.args);
    return loopWriteSetAhead(ahead, incoming, frame.header);
  };

  // Branch-sense sites, numbered as the walk below first reaches them (`branchSenseFlipSites`).
  const senseOrdinal = new Map<number, number>();

  // Which `return;` statements the SOURCE wrote — the reading, and why it is decidable, live in
  // `structure/retspell.ts`. `l3/tailret.ts` owns whether a marked return is safe to delete.
  const unspelledRets = unspelledEpilogues(fn);

  const structureRegion = (b: Block, stop: Block | null): Stmt[] => {
    if (b === stop) {
      return [];
    }
    // The merge of the switch a falling arm also leaves: the edge copies are already out, and
    // `break;` is the jump.
    const brk = switchBreakAt(b);
    if (brk !== undefined) {
      return brk;
    }
    // Back to a `while (1)` header from a region that ends short of the loop bottom: the edge's
    // copies are already out, and `continue` is the jump.
    if (loopCtx !== null && b === loopCtx.header && foreverLoops.has(b)) {
      return [{ k: 'continue' }];
    }
    // THE LOOP AS A `for` (`ForPlan`): its latch runs the update and the test, so an edge into it
    // is `continue;`, and one into its exit is `break;` — a jump table's arms reach both. The
    // `break;` is refused, loud, inside a case body opened in this loop, which binds it to the
    // switch, and either jump is refused from a loop nested inside, which binds it to that loop.
    if (loopCtx?.forLatch !== undefined && (b === loopCtx.forLatch || b === loopCtx.exit)) {
      if (b === loopCtx.forLatch) {
        return [{ k: 'continue' }];
      }
      if (switchFrames.some((f) => f.loop === loopCtx)) {
        throw new StructureError(
          `cannot structure '${fn.name}': a case body leaves its switch for the exit of the \`for\` it sits ` +
            `in (block #${fn.blocks.indexOf(b)}), where \`break\` would leave only the switch`,
        );
      }
      return [{ k: 'break' }];
    }
    if (forJumps.has(b)) {
      throw new StructureError(
        `cannot structure '${fn.name}': a nested loop reaches the latch or the exit of the \`for\` around it ` +
          `(block #${fn.blocks.indexOf(b)}), which \`continue\` or \`break\` would bind to the nested loop`,
      );
    }
    if (onStack.has(b)) {
      throw new StructureError(
        `cannot structure '${fn.name}': unrecovered back-edge into block #${fn.blocks.indexOf(b)} ` +
          `(loop-recovery declined this shape: irreducible/overlapping loops, exits to more than one ` +
          `live merge, a break out of a nested loop, or an unsafe break or continue)`,
      );
    }
    onStack.add(b);
    try {
      return structureBlock(b, stop);
    } finally {
      onStack.delete(b);
    }
  };

  // ── Regime-A switch recovery (structure/switch-recover.ts): the recognizer's case bodies call
  // back into structureRegion, and Regime B (switch_br, below) reads FOUR things from it — the
  // per-arm exit, the layout index, the chain linearization and where the `default:` label goes —
  // so neither regime states any of those four facts twice.
  //
  // `isNamed` reads `varName` LIVE, and by here THE NAMING WALK IS COMPLETE: every write to
  // `varName` and `backArgName` sits above, in the walk and the coalescing that follows it, and the
  // two places the map is handed to (`coalesceNames`, `makeLoopHazards`) only read it. So the
  // recognizer sees one settled naming however late a case body calls back into `structureRegion`,
  // and nothing here has to be rebuilt against a naming that moves underneath it.
  // One switch arm, from `entry` to `stop`, under its frame (`switchFrames`).
  const structureArm = (entry: Block, stop: Block | null, merge: Block | null, exit: ArmExit | undefined): Stmt[] => {
    // A backend with no mid-arm `break` (`spellSwitchBreak`) gets no region for a closed arm, and
    // so no `break;` from `switchBreakAt` and no arm-local join: it structures to the CFG's.
    const region =
      exit === undefined || exit.kind === 'unstructurable' || (exit.kind === 'break' && !spellSwitchBreak)
        ? null
        : (exit.region ?? null);
    switchFrames.push({
      merge,
      loop: loopCtx,
      region,
      // A `goto` arm is structured as the falling arm it re-spells: its paths into the sibling run
      // to the arm's end, where the jump is written.
      fallsTo: exit?.kind === 'fallthrough' || exit?.kind === 'goto' ? exit.to : null,
      flags: switchFlagScopes[switchFlagScopes.length - 1] ?? null,
    });
    try {
      return structureRegion(entry, stop);
    } finally {
      switchFrames.pop();
    }
  };
  const { recognizeSwitch, analyzeArmExit, forwardToMerge, layoutIndex, defaultLayoutPos, chainArms } =
    makeSwitchRecovery({
      fn,
      defs,
      dom,
      ipdom,
      opBlock,
      isNamed: (v) => varName.has(v),
      isCmpOpcode: (opcode) => !!CMP_TO_BIN[opcode],
      switchAllowsNeqCase,
      switchBoundCase: switchBoundCase ?? null,
      switchArmsFollowLayout,
      switchRequiresFrontLoadedTests,
      spellSwitchFallthrough,
      emitsOwnStatement: (blk) => blk.ops.some((o) => anchoredAt.has(o) || materialize.has(o)),
      blockOf,
      enclosingLoop: () => loopCtx,
      hoistDispatchCopies: (edges, liveAt) => hoistedDispatchAssigns(edges, liveAt),
      expr: (v) => expr(v),
      structureRegion: (b, stop) => structureRegion(b, stop),
      structureArm,
    });

  const structureBlock = (b: Block, stop: Block | null): Stmt[] => {
    // Bottom-test `do-while`: this block is a do-while header (the body-first loop entry). Emit the
    // do-while — its body includes `b`'s own ops (structured via structureRegion with the hook masked),
    // so do NOT emit sideEffects(b) here. The init was already emitted by the predecessor's argAssigns.
    // A guarded self-loop its guard did not claim (`keptGuardDoWhiles`) is a do-while like any
    // other: read as a plain block, its back edge would re-enter it and decline.
    const dw = doWhileLoops.get(b) ?? keptGuardDoWhiles.get(b);
    if (dw && !dwActive.has(b)) {
      return emitDoWhile(dw, stop);
    }
    const forever = foreverLoops.get(b);
    if (forever && !dwActive.has(b)) {
      return emitForever(forever, stop);
    }

    const out: Stmt[] = [...sideEffects(b)];
    const term = b.ops[b.ops.length - 1];
    if (term.opcode === 'ret') {
      // A void function's `bx lr` leaves whatever in r0; suppress that phantom return value.
      const value = returnsVoid || !term.operands.length ? undefined : returnedValue(term);
      // The `value === undefined` half is a GUARD: `l3/tailret.ts` re-checks it before deleting
      // anything, so marking a value-carrying return would change no output. The mark claims the asm
      // shows no `return;` STATEMENT here, which is a claim about a VOID return only.
      out.push({ k: 'return', value, ...(value === undefined && unspelledRets.has(b) ? { unspelled: true } : {}) });
      return out;
    }
    if (term.opcode === 'br') {
      const target = term.successors[0].block;
      // a `while (1)` spelled `for` (`forPlanAt`) whose first test the compiler folded away
      const fl = foreverLoops.get(target);
      const plan = fl !== undefined && !onStack.has(target) ? forPlanAt(b, fl) : null;
      if (plan !== null) {
        onStack.add(target);
        try {
          out.push(...emitForever(fl!, stop, plan));
        } finally {
          onStack.delete(target);
        }
        return out;
      }
      out.push(...argAssignsFor(b, term.successors[0]));
      out.push(...structureRegion(target, stop));
      return out;
    }
    // Regime B: a `switch_br` (jump-table dispatch) lowers directly to the `switch` node — scrutinee,
    // per-successor case value, last successor = default. Case bodies delegate to structureRegion (as in
    // Regime A). Two table slots naming ONE block are one arm carrying both `case` labels; an arm whose
    // region flows into the NEXT arm is C fall-through (no `break`). Any other shape needs a `goto` and
    // fails LOUD rather than being duplicated or silently closed.
    if (term.opcode === 'switch_br') {
      // WHERE THE SWITCH ENDS. Post-dominance answers it whenever the arms reconverge. When they
      // do not — some arm `return`s, so EXIT is the only block on every path — the answer is the
      // one `followOverReturns` derives for a divergent `if`: keep the blocks that reach a `ret`
      // EVERY successor reaches, and post-dominate on what is left.
      //
      // UNCONDITIONAL, where the `if` asks it behind `followEarlyReturns` — and NOT because a jump
      // table has only one reading. It has the same two an `if` has, and `ipdom.get(b) ?? stop` is
      // the other one: for a table whose arms reach a shared `ret` and also a shared tail, that
      // reading structures each arm to its own end and emits legal, complete C with the tail
      // duplicated into the arms. Both are legal C for one CFG, so the asm underdetermines the
      // source — which is the definition of a ranked variation (docs/level-tower.md).
      //
      // WHAT MAKES THIS ONE THE DEFAULT is which of the two can decline. With a null merge the
      // default edge's target joins `siblings`, so an arm's plain `break` classifies as a
      // fall-through into it, and Regime B has no fallback recovery — `synthetic:sw_jtret` is that
      // shape and declines outright. A variation could not rescue it, and the reason is an
      // authoring rule rather than a blanket one: `assertDefaultAccepts` re-runs the default
      // structuring, and lets its refusal stand, for the options it RESETS — which is every
      // structure variation but the four named as non-members beside it. `followEarlyReturns`, the
      // `if`-side twin of this very mechanism, is one it resets, because moving a merge point
      // changes which edge copies elide as identities; a switch-side twin moves the same merge
      // point and would be reset for the same reason. So the divergent reading cannot come back as
      // a candidate that rescues `sw_jtret`. The reading that lifts strictly
      // more functions therefore has to BE the default, and it is the DIVERGENT reading that a
      // variation would have to offer back — a candidate nothing mints today, and the one thing
      // this line costs. `?? stop` keeps the shape where no `ret` is reachable from every
      // successor — and where that reading declines, the default-anchored RETRY below gets one try.
      // Neither reading knows about loops: inside a loop body, where post-dominance names a join
      // PAST the loop and every reading declines there, THE LOOP CLAMP below reads the body's own.
      const joined = ipdom.get(b) ?? followOverReturns(b, stop);
      let merge = joined ?? stop;
      const succ = term.successors;
      const caseVals = term.attrs.cases as number[];
      // Switch edges CARRY phi args (frontend/ssa.ts appends them terminator-generically) — each
      // case/default body must open with its edge's copies, exactly as cond_br edges do; dropping
      // them leaves the target's params uninitialized on the switch path. Two case values sharing
      // a target must agree on their args (else the copies are ambiguous → loud decline); the
      // shared body is then emitted ONCE under both labels.
      const argsSeen = new Map<Block, Value[]>();
      for (const s of succ) {
        const prev = argsSeen.get(s.block);
        if (prev && (prev.length !== s.args.length || prev.some((v, i) => v !== s.args[i]))) {
          throw new StructureError(
            `cannot structure '${fn.name}': jump-table cases share a target block with differing phi args`,
          );
        }
        argsSeen.set(s.block, s.args as Value[]);
      }
      // Group the case slots by target block, in TABLE order — `case 5: case 6:` is one arm with two
      // labels, not two copies of one body. Emission order is the array order (load-bearing: see the
      // l3/ast.ts fall-through note), so the adjacency check below is against this same order.
      const defEdge = succ[succ.length - 1];
      const arms: { entry: Block; edge: (typeof succ)[number]; values: number[] }[] = [];
      const armOf = new Map<Block, (typeof arms)[number]>();
      succ.slice(0, -1).forEach((s, i) => {
        let a = armOf.get(s.block);
        if (!a) {
          a = { entry: s.block, edge: s, values: [] };
          armOf.set(s.block, a);
          arms.push(a);
        }
        a.values.push(caseVals[i]);
      });
      // ARM ORDER. Grouping the table's slots by target walks them in TABLE order, which for a dense
      // table is ascending case value — the neutral spelling, and the source's order only by
      // accident. Where the compiler has declared that its block layout IS the order the arms were
      // written (TargetDescription.switchArmsFollowLayout — the same fact and the same evidence
      // Regime A reads, and agbcc's jump tables carry it too: 8 dense arms written 5,2,0,4,1,3,6,7
      // lay their bodies out in that order under an ascending table), the bodies' layout is the
      // evidence and the arms take it.
      //
      // The policy orders the chain HEADS. A FALLING arm's position is not free — emission order is
      // load-bearing for correctness (the l3/ast.ts non-neutrality note), so it must sit directly
      // above the arm it falls into — and `chainArms` below re-threads it for exactly those, which
      // is the same per-SITE reading Regime A makes of the same declaration.
      if (switchArmsFollowLayout) {
        arms.sort((x, y) => layoutIndex(x.entry) - layoutIndex(y.entry));
      }
      // …and then the CHAIN re-threads that order for the falling arms, exactly as it does for the
      // comparison tree: ONE definition (`chainArms`) for the linearization, the adjacency it
      // guarantees, and the three shapes no linear order spells. The arm-order policy above is read
      // for the chain HEADS only — the same per-SITE reading Regime A makes of the same
      // declaration, rather than a whole-switch gate on every arm being closed.
      const preChain = arms.map((a) => a.entry);
      // Everything below that depends on WHERE THE SWITCH ENDS, read for one candidate merge: the
      // arms' exits, their linearization, and whether the emission below would decline them. Read
      // at the CFG's merge (or `stop`), at the retry's (no CFG merge), and then once per rung of
      // THE LADDER below — the copies, the loop clamp's own merge as written and with the copies,
      // and the jumps at both — until one declines nothing.
      // A default edge the dispatch never takes: a frontend whose dispatch is entered only past a
      // bounds test that already sent every other value elsewhere says so with `exhaustive`.
      const deadDefaultEdge = term.attrs.exhaustive === true;
      const readArms = (at: Block | null, copies = false, gotos = false) => {
        // The blocks an arm could fall INTO. The default block counts only when it is a block of
        // its own: when it IS the merge, "the default" is just where the switch ends, and an arm
        // reaching it is a plain `break`.
        const siblings = new Set<Block>(arms.map((a) => a.entry));
        if (defEdge.block !== at) {
          siblings.add(defEdge.block);
        }
        // The latch of the `for` the switch sits in is no sibling: an edge into it is `continue;`.
        // Nor, once the rerun asks the loop (`ForRanking`) and it is not spelled `for`, is the header
        // of the `while (1)` it sits in, which structureRegion spells `continue;` too. Only asked: an
        // arm that reaches the latch of a counted loop then takes a copy of its test and update,
        // which a first run must not prefer to the `for` the rerun reads.
        const continueTo =
          loopCtx === null
            ? undefined
            : (loopCtx.forLatch ??
              (foreverLoops.has(loopCtx.header) && forRank.asked.has(loopCtx.header) ? loopCtx.header : undefined));
        const jumps = new Set<Block>(continueTo !== undefined && continueTo !== at ? [continueTo] : []);
        jumps.forEach((x) => siblings.delete(x));
        // `analyzeArmExit` does not depend on emission order, so the exits can be settled before
        // the chain and reused below. Grouping by target already gives every arm a DISTINCT entry
        // block, so no two sort keys can be equal and the tie-break Regime A needs on shared bodies
        // has nothing to decide here.
        const walked = new Map<Block, ArmExit>();
        for (const entry of [...arms.map((a) => a.entry), defEdge.block]) {
          if (!walked.has(entry)) {
            walked.set(entry, analyzeArmExit(entry, b, at, siblings, false, jumps));
          }
        }
        // A table whose default block is ALSO a case target is that case's arm, not a separate
        // one: it is already in `preChain`, and `defaultLayoutPos` withholds the label's position.
        const dflt = defEdge.block !== at && !armOf.has(defEdge.block) ? defEdge.block : null;
        // Asked for, arms a cross-jump sent into one sibling's body get that body back as copies:
        // all but the one the arm-order policy puts above it, or under `/tail-copies` all of them
        // (`copySharedFallTargets`, and THE COPIES below for when it is asked).
        // Under `/case-goto` every case arm the copies write back into an entrant is spelled with
        // the jumps instead (`jumpSharedFallTargets` over just those siblings), and the copies keep
        // the rest (`default:` siblings), so the two settings differ exactly where `onCaseCopied`
        // fires.
        const copiedInto = new Set<Block>();
        const copyOver = (from: ReadonlyMap<Block, ArmExit>, onCopied?: (to: Block) => void) =>
          copySharedFallTargets(
            preChain,
            dflt,
            from,
            !copyEveryTailEntrant,
            hooks.onTailFallerKept,
            (s) => forwardToMerge(s, b, at, siblings),
            onCopied,
          );
        const copied = copies
          ? copyOver(walked, (to) => {
              copiedInto.add(to);
              hooks.onCaseCopied?.();
            })
          : walked;
        const exits =
          copiedInto.size > 0 && jumpToSharedCases && spellSwitchFallthrough
            ? copyOver(jumpSharedFallTargets(preChain, dflt, walked, copiedInto))
            : copied;
        // …and, asked for, the arms still entering one case arm's body two or more at a time get
        // the one fall-through and `goto`s to its label (`jumpSharedFallTargets`, THE JUMPS below).
        const jumped = gotos && spellSwitchFallthrough ? jumpSharedFallTargets(preChain, dflt, exits) : exits;
        const falls = [...jumped.values()].some((e) => e.kind === 'fallthrough');
        const chain = !spellSwitchFallthrough && falls ? null : chainArms(preChain, dflt, jumped);
        const refusal = chain === null ? null : armRefusal(jumped, chain);
        return { exits: jumped, falls, chain, refusal, declines: chain === null || refusal !== null };
      };
      // THE EMISSION'S PER-ARM REFUSALS, the one definition of them. Every refusal the emission
      // below throws is a null chain (which a fall-through in a language without one forces too —
      // `readArms` reads that one) or one of three asked here per arm, in emission order, without
      // emitting anything: an arm whose exit is unstructurable, a fall-through into an arm that is
      // not the next one emitted, and a fall-through into an arm that opens with switch-edge
      // copies. The answer is the arm it refuses at and a `raise` that throws the refusal, and the
      // emission calls exactly the one `readArms` carries for the reading it adopted — so the
      // retry's gate and the emission cannot disagree about what declines, and a reading that
      // declines fails with the message it always did. Each refusal stays a literal
      // `throw new StructureError(…)` so the decline-message harvest (apps/web declines.test.ts)
      // still reads it.
      //
      // `edgeCopyRecords` stands in for `argAssignsFor` because it mints no swap-cycle temp — a
      // name minted here would change the output of every arm emitted after it — and it answers
      // the same question: `sequentialize` emits at least one statement per record and none for
      // none. It is not a pure query either: an `undef` copy it drops is recorded in
      // `droppedUndefCopies`, which a postcondition reads. So the records this question leaves are
      // rolled back, as the speculative dispatch hoist does with its own.
      const armRefusal = (exits: Map<Block, ArmExit>, chain: Block[]): { at: number; raise: () => never } | null => {
        const order: { entry: Block; edge: (typeof succ)[number]; values: number[] | null }[] = [
          ...chain.map((e) => armOf.get(e)!),
          { entry: defEdge.block, edge: defEdge, values: null },
        ];
        const auditMark = droppedUndefCopies.length;
        try {
          for (const [i, a] of order.entries()) {
            const exit = exits.get(a.entry)!;
            if (exit.kind === 'unstructurable') {
              const { why } = exit;
              return {
                at: i,
                raise: () => {
                  throw new StructureError(`cannot structure '${fn.name}': ${why}`);
                },
              };
            }
            // A `goto` lands where a fall-through into its sibling would — on the label printed above
            // the sibling's body, which opens with its switch-edge copies — so it is refused where
            // that fall-through is: below, on a sibling that opens with such copies, which the jump
            // would re-run. It needs the sibling to be a case arm emitted in this switch, which
            // `jumpSharedFallTargets` only ever names.
            if (exit.kind === 'goto') {
              const into = order.find((o) => o.entry === exit.to && o.values !== null);
              if (into === undefined || into.entry === a.entry) {
                return {
                  at: i,
                  raise: () => {
                    throw new StructureError(
                      `cannot structure '${fn.name}': a case body jumps to an arm that is no case of its switch`,
                    );
                  },
                };
              }
              if (edgeCopyRecords(b, into.edge).length > 0) {
                return {
                  at: i,
                  raise: () => {
                    throw new StructureError(
                      `cannot structure '${fn.name}': the case a goto lands on takes a value from the switch ` +
                        `edge, which the goto would re-run`,
                    );
                  },
                };
              }
              continue;
            }
            if (exit.kind !== 'fallthrough') {
              continue;
            }
            const next = order[i + 1];
            if (next?.entry !== exit.to) {
              const { values } = a;
              return {
                at: i,
                raise: () => {
                  throw new StructureError(
                    `cannot structure '${fn.name}': ${values ? `case ${values.join('/')}` : 'the default arm'} falls ` +
                      `through into an arm that is not the next one emitted — C fall-through only reaches the arm below`,
                  );
                },
              };
            }
            // The arm fallen INTO opens with its own switch-edge copies, which are how the dispatch
            // hands it its block parameters. On the fall-through path those copies would RE-RUN and
            // overwrite what the falling arm just computed (`case 0: v=7; case 1: v=5;` — the case-0
            // path calling with 5). They cannot simply be dropped either: entering that arm by its
            // own case value needs them. Hoisting them above the switch is possible but not always
            // safe (another arm may read the same name first), so this shape declines LOUD. A
            // parameter every edge hands one pure expression over values that dominate the case
            // does not reach here: raise/unpre.ts recomputes it in the case before structuring
            // (gcse PRE's `i + 1`, `synthetic:sw_fallpre`), and leaves a merged constant to this
            // refusal. The one edge that needs no copies is a default edge the dispatch never takes
            // (the op's `exhaustive` attr): nothing enters the default by it, so its copies are not
            // emitted (`edgeCopies` below) and cannot re-run.
            if (!(deadDefaultEdge && next.edge === defEdge) && edgeCopyRecords(b, next.edge).length > 0) {
              return {
                at: i,
                raise: () => {
                  throw new StructureError(
                    `cannot structure '${fn.name}': the case fallen into takes a value from the switch edge, ` +
                      `which the fall-through path would re-run`,
                  );
                },
              };
            }
          }
          return null;
        } finally {
          droppedUndefCopies.length = auditMark;
        }
      };
      let read = readArms(merge);
      // THE RETRY: A SWITCH WHOSE ARMS DO NOT ALL REACH THE CODE AFTER IT. When neither
      // post-dominance nor the every-successor reading gives the table an end, the `?? stop`
      // reading above puts the default block among the siblings, so every plain `break` reads as
      // falling INTO it — and the function declines wherever that does not spell. One arm that
      // `return`s on its own is enough to cause it (`case 4: …; return TRUE;` beside four `break`s
      // and a `return FALSE;` after the switch): its `ret` is reached by no other successor, so
      // the every-successor intersection is empty although the rest plainly share an end. So is a
      // `case 1:` that falls into a returning `case 2:`, and so are four returning arms beside one
      // `break` that carries a value to the code after the switch.
      //
      // The DEFAULT-ANCHORED reading (`sharedRetsOf`) names that end by the dispatch's DEFAULT
      // edge, which goes to the `default:` arm or, where the source wrote none, straight to the
      // code after the switch. It keeps the successors that share a `ret` with the default edge's
      // target, and derives the follow from them alone. That is a candidate, not evidence: a
      // `default:` that `return`s on its own has a `ret` of its own, and the follow it derives
      // then sits inside that arm, with every `break` spelled as a `return` — the same program,
      // and not the one the source wrote (KMC and gcc 2.7.2 recompile it to different code).
      //
      // THE LAYOUT TELLS THEM APART, and nothing in the graph does: `case 0: …; break;` beside
      // returning arms and a returning `default:` is the same CFG as returning arms beside one
      // arm that carries a value past the switch to a store the default edge shares. What
      // differs is where the code the anchor leaves out sits. The code after a switch is laid
      // out after every arm, so an arm the anchor leaves out — one that returns on its own, or
      // reaches the switch's real end — sits above that end only if the candidate is the real
      // end. Where any block a left-out successor reaches is laid out past the candidate, the
      // candidate is inside an arm and the retry is refused.
      //
      // That reads `layoutIndex` at a strength of its own: only that no block of an arm was moved
      // past the code after the switch — not the arm order `switchArmsFollowLayout` places, so it
      // is not behind that declaration. Where it fails — PPC's synthetic return blocks sort after
      // every real one — it can only refuse, so its cost is a decline the `stop` reading already
      // made, never a spelling.
      //
      // A RETRY, NOT A THIRD LINK IN THE `??` CHAIN. Where the `stop` reading spells, it is legal
      // C already, and asking the anchored reading first re-spells three shapes whose `stop`
      // spelling is published (a real fall-through moved after the switch, a value-carrying
      // fall-through edge lifted where it declined, a Pascal decline re-worded) with no row asking
      // for it. So it is read only where the `stop` reading DECLINES — any refusal `readArms`
      // reports, which is every refusal the emission below throws — and adopted only where it
      // declines nothing, so it can turn a decline into a lift and never one lift into another,
      // nor one decline's stated reason into another's.
      //
      // NEVER AT A CASE ARM. Where the arms that return on their own are the many and the arms that
      // share an end are one arm and the arm it falls into (`case 0: …` running on into `case 1:`,
      // every other arm its own `return`), the follow the anchored reading can derive is that
      // second arm's ENTRY. Ending the switch there spells `case 1:` as an empty arm and moves its
      // body after the switch — the same program, but a spelling no source writes and the one the
      // `stop` reading's own refusal is the honest answer for. So the retry ends the switch only
      // at the default block or past every arm.
      //
      // THE DEFAULT BLOCK STAYS ELIGIBLE WHEN THE TABLE'S HOLES MAKE IT AN ARM. A slot no `case`
      // names holds the default edge's target, so on a table with a hole that block is an arm by
      // construction, but not one with a body: a hole runs what an unmatched value runs, and ending
      // the switch there spells it `case 1: break;`. The rule above refuses an arm that is NOT the
      // default edge's target, whose body would move after the switch, and only that arm.
      let over: Block | null = null;
      if (joined === null && read.declines) {
        const found = followOverReturns(b, stop, defEdge.block);
        const pastEnd = (end: Block): boolean =>
          leftOutOf(b, reachFrom, defEdge.block).some((s) =>
            [s, ...reachFrom(s)].some((x) => x !== b && layoutIndex(x) > layoutIndex(end)),
          );
        over = found !== null && (found === defEdge.block || !armOf.has(found)) && !pastEnd(found) ? found : null;
        const retry = over === null ? null : readArms(over);
        if (retry !== null && !retry.declines) {
          hooks.onEarlyReturnFollow?.({ block: fn.blocks.indexOf(b), follow: fn.blocks.indexOf(over!) });
          merge = over;
          read = retry;
        }
      }
      // THE COPIES: TWO ARMS A CROSS-JUMP SENT INTO ONE SIBLING'S BODY. Read as written they are two
      // fall-throughs into one arm, which no linear order spells; `copySharedFallTargets` writes
      // the sibling's body back into every entrant but the one the arm-order policy puts above it
      // (into all of them under `/tail-copies`, the ranked choice between the two). A third
      // reading, asked LAST and adopted only where it declines nothing, for the reason the retry
      // is: where either reading above spells, it is legal C already, and this one must turn a
      // decline into a lift, never one lift into another.
      //
      // "DECLINES NOTHING" IS THIS STAGE'S VERDICT, NOT THE BACKEND'S. A target language whose
      // `case` cannot fall through (Pascal) refuses the reading as written, and the copies can take
      // away every fall-through, so the switch structures. A backend that then refuses the function
      // for something else (a struct-typed value, a `return` inside a case, a narrow local) declines
      // it under THAT reason instead of "no fall-through": the outcome stays a decline, and the
      // reason it gives is the obstacle that is actually left.
      //
      // NEVER ON THE `stop` READING. There the default block is a sibling, every plain `break`
      // reads as falling into it, and copying it would write the code after the switch into every
      // arm. So it is read at a merge the switch HAS — post-dominance's, or the retry's; THE LOOP CLAMP
      // below asks it at a third, the loop body's own join. That narrows the shape and does not rule
      // it out: where the other arms `return` into the epilogue the default block also reaches,
      // post-dominance's merge IS that epilogue, and arms that `break` to the code after the switch
      // get it as copies (`copySharedFallTargets`, a `default:` sibling). The same program, where
      // the reading before it failed loud.
      const copyAt = joined !== null ? merge : over;
      // THE LOOP CLAMP: A SWITCH IN A LOOP BODY WHOSE CFG MERGE LIES PAST THE LOOP. Post-dominance
      // reads the whole function, and where an arm `return`s and every `return` shares one epilogue
      // (agbcc and IDO whenever the code after the loop returns early too, mwcc always), that
      // epilogue is the only block every path from the dispatch reaches — so `joined` is outside
      // the loop, the loop's own latch (or the block a hole and the bounds test go to) is left a
      // sibling, and every `break` reads as falling into it (`synthetic:sw_loopret`). The `if`
      // has the same problem and the same answer: a join outside the body is not this statement's
      // join, and the real one is where the paths that STAY in the body meet — `inLoopJoin`, the
      // one rule both statements read (null ⇒ they meet only at the bottom of the body, and the
      // region's `stop` is the end). NO CFG MERGE AT ALL reads the same way inside a loop body: an
      // arm that `return`s keeps a `ret` of its own beside the one past the loop, and the stop
      // reading then puts the default block among the siblings (gcc 2.7.2, whose reorg moves the
      // latch's `i++` into some arms' delay slots and leaves the rest a separate `i++` block).
      //
      // A MERGE CANDIDATE OF ITS OWN, READ AS THE OTHERS ARE: as written, then — where that
      // declines — with the arms a cross-jump sent into one sibling's body given that body back
      // (THE COPIES above, which read only at a merge the switch HAS: the body's join is one, even
      // where it is the very block the stop reading ended at, and the region's `stop` standing in
      // where the body has none is not). An in-loop switch whose arm tails were cross-jumped needs
      // both at once.
      //
      // ASKED LAST, NOT FIRST, and only where every reading above declines, as the retry and the
      // copies are: where any of them spells, it is published already, and this one turns a
      // decline into a lift and never one lift into another. Asked first it would re-read the
      // switch whose CFG merge is the loop's exit and whose arms `break` there (switch-arms.test
      // `exitloop`, which then declines at the body's join).
      //
      // KNOWN GAP, loud: where an earlier reading SPELLS at a merge past the body that only
      // `return`s reach (a switch nested in an arm of an in-loop switch, one of whose own arms
      // returns), this is never asked, and the epilogue's `return;` after the switch is one no path
      // reaches — the reachability contract declines the function. No static test over the CFG
      // tells that reading from the published one whose arm spells an early `return` as `break;`
      // to that same `return;` (a `return` arm entered from the dispatch, or one Regime A walks
      // through rather than rendering in place).
      //
      // THE JUMPS: TWO ARMS ENTERING ONE CASE'S BODY, ONE OF THEM BY `goto`. Where every reading above
      // still declines, the arms that enter one case arm's body two or more at a time keep one
      // fall-through and the rest end `goto` to that arm's label (`jumpSharedFallTargets`, over what
      // the copies leave) — the one goto L3 holds (l3/ast.ts). Asked at the readings that may take
      // the copies, in their order: the switch's own merge (or the retry's), then the loop clamp's.
      // LAST, and adopted only where it declines nothing, for the reason the copies are: it turns a
      // decline into a lift, never one lift into another. And asked only in the runs `structure`
      // makes after every goto-free run of the whole function declined, and only at a switch no run
      // spelled goto-free (`JumpRanking`), since a rerun this ladder cannot see — the `for` one
      // above all — may spell the switch without it: so it never writes a goto where goto-free C
      // already spells the switch. Only the ranked `/case-goto` variation does (`jumpToSharedCases`
      // in `readArms`), as a candidate the scorer weighs against the copies. A language with no
      // fall-through gets none (`readArms`), and its decline keeps the words it has.
      //
      // THE LADDER, AS DATA: each rung above is one reading — a merge, and whether the copies and
      // the jumps are asked — and the first that declines nothing is adopted, so the order of this
      // list IS the precedence the sections above argue for. `follows` marks the rungs at the
      // switch's own merge (or the retry's), whose adoption the early-return hook reports.
      let jumped = false;
      if (read.declines) {
        const inLoop = inLoopJoin(b, joined, true);
        const clampAt = inLoop === undefined ? null : (inLoop ?? stop);
        const rungs: { at: Block | null; copies: boolean; gotos: boolean; follows?: true }[] = [
          { at: copyAt, copies: true, gotos: false, follows: true },
          ...(clampAt !== null && clampAt !== merge ? [{ at: clampAt, copies: false, gotos: false }] : []),
          ...(inLoop !== null ? [{ at: clampAt, copies: true, gotos: false }] : []),
          { at: copyAt, copies: true, gotos: true, follows: true },
          { at: inLoop ?? null, copies: true, gotos: true },
        ];
        for (const { at, copies, gotos, follows } of rungs) {
          if (at === null) {
            continue;
          }
          const reading = readArms(at, copies, gotos);
          // unasked, a jump rung only notes whether it reads the switch (`JumpRanking`): every
          // goto-free rung above it declined, so this run declines here either way
          if (gotos && jumpRank.asked !== 'every' && !jumpRank.asked.has(b)) {
            if (!reading.declines) {
              jumpRank.wanted.add(b);
            }
            continue;
          }
          if (!reading.declines) {
            jumped = gotos;
            if (follows === true && at !== merge) {
              hooks.onEarlyReturnFollow?.({ block: fn.blocks.indexOf(b), follow: fn.blocks.indexOf(at) });
            }
            merge = at;
            read = reading;
            break;
          }
        }
      }
      if (!read.declines && !jumped) {
        jumpRank.free.add(b);
      }
      const exitOf = read.exits;
      // A language whose `case` cannot fall through (Pascal) has no spelling for this shape, and
      // Regime B has no second recovery to fall back on — so it fails LOUD, as it does for every
      // other unspellable jump table. (Regime A, which does have a fallback, declines to
      // if-recovery instead: switch-recover.ts's PRE2.)
      if (!spellSwitchFallthrough && read.falls) {
        throw new StructureError(
          `cannot structure '${fn.name}': a jump-table case runs on into the next case, and the target ` +
            `language has no fall-through in its case statement`,
        );
      }
      const chained = read.chain;
      if (chained === null) {
        wantFor();
        throw new StructureError(
          `cannot structure '${fn.name}': the jump table's case arms do not linearize — two arms fall ` +
            `into one, the default arm falls into a case, or the fall-through is a cycle`,
        );
      }
      const armByEntry = new Map(arms.map((a) => [a.entry, a]));
      const ordered = chained.map((e) => armByEntry.get(e)!);
      const orderIntact = chained.every((e, i) => e === preChain[i]);
      // The `default:` arm carries that evidence too, and a table hands it over the same way: the
      // range check BRANCHES to the default (`bhi .Ldefault`), so its block is never one the
      // dispatch ran into — measured, a 5-arm table lays the default's body at each of the six
      // positions the source can write it in exactly there. `defaultLayoutPos` states the refusals.
      const defaultAt =
        defEdge.block !== merge
          ? defaultLayoutPos(
              defEdge.block,
              ordered.map((a) => ({ entry: a.entry, fallsThrough: exitOf.get(a.entry)!.kind === 'fallthrough' })),
              { placedByDispatch: false, orderIntact },
            )
          : undefined;
      // ONE emission order for the whole statement: the case arms, then the default. Adjacency is
      // read off this array, so "falls into the next arm" needs no separate rule for a case that
      // falls into the default (it is the arm after the last case, and legal C). Where the LABEL is
      // printed is `defaultAt`, which the emission order does not follow.
      const emitOrder = [...ordered, { entry: defEdge.block, edge: defEdge, values: null as number[] | null }];
      // Each arm's switch-edge copies, computed ONCE and in emission order: `argAssignsFor` mints
      // swap-cycle temp names, so calling it twice for one edge burns a temp number and changes the
      // output (the same reason emitDoWhile reuses its `updates`).
      // A dead default edge carries none: the default runs only when a case falls into it, and that
      // case's own edge copies hand it its values.
      const edgeCopies = emitOrder.map((a) => (deadDefaultEdge && a.edge === defEdge ? [] : argAssignsFor(b, a.edge)));
      // A default edge the dispatch never takes (the op's `exhaustive` attr) gets no arm: its block
      // runs under whatever the dispatch path left in the registers, a state the machine never gives
      // it there. Unless a case runs on into that block — then the label is where that case goes.
      // A table whose hole names that block already gives it a case arm (`dflt` is null in
      // `readArms`), and a fall into the block lands under that arm's labels, never the default's.
      const deadDefault =
        deadDefaultEdge &&
        (armOf.has(defEdge.block) ||
          ![...exitOf.values()].some((e) => e.kind === 'fallthrough' && e.to === defEdge.block));
      // The label each `goto` target carries, named after its first case value (`case_3`,
      // `case_m1` for -1) and kept unique across the function (`caseLabelNames`).
      const labels = new Map<Block, string>();
      const labelOf = (to: Block): string => {
        let name = labels.get(to);
        if (name === undefined) {
          const base = `case_${String(armOf.get(to)!.values[0]).replace('-', 'm')}`;
          name = base;
          for (let n = 2; caseLabelNames.has(name); n++) {
            name = `${base}_${n}`;
          }
          caseLabelNames.add(name);
          labels.set(to, name);
        }
        return name;
      };
      const [bodies, flags] = withSwitchFlags(() =>
        emitOrder.map((a, i) => {
          // The refusal `armRefusal` found for this reading, thrown at the arm it names, so an
          // earlier arm's own refusal speaks first. Its order is this emission array, so "the next
          // arm" is read off the seam where a position acquires control-flow meaning, as Regime A's is.
          if (read.refusal !== null && read.refusal.at === i) {
            wantFor();
            read.refusal.raise();
          }
          if (deadDefault && i === emitOrder.length - 1) {
            return { body: [], fallsThrough: false };
          }
          const exit = exitOf.get(a.entry)!;
          const ft = exit.kind === 'fallthrough';
          // A `goto` arm is structured exactly as the falling arm it re-spells, and its end is the
          // jump: every path that reaches it is a path into the sibling (`jumpSharedFallTargets`).
          // Unless no path reaches it: the arm's structuring may already have written the sibling's
          // body into it and left (a nested switch whose arms run into the sibling, spelled with
          // the copies and a `break;`), and the jump after that is one no path takes — a goto
          // where goto-free C already spells the arm, so none is written (`reachesEnd`).
          if (exit.kind === 'goto') {
            const body = [...edgeCopies[i], ...structureArm(a.entry, exit.to, merge, exit)];
            return {
              body: reachesEnd(body) ? [...body, { k: 'goto', label: labelOf(exit.to) } as Stmt] : body,
              fallsThrough: false,
            };
          }
          return {
            // A falling-through arm stops AT its successor arm, which then emits that body once under
            // its own labels; a closed arm runs to the merge as before.
            body: [...edgeCopies[i], ...structureArm(a.entry, ft ? exit.to : merge, merge, exit)],
            fallsThrough: ft,
          };
        }),
      );
      const outCases: SwitchCase[] = ordered.map((a, i) => {
        const label = labels.get(a.entry);
        return { values: a.values, ...bodies[i], ...(label !== undefined ? { label } : {}) };
      });
      // An EMPTY default arm is not a default at all: it is where the switch ends, which is where
      // an unmatched scrutinee goes anyway. Emitting the label with nothing under it says nothing
      // and is not even valid C89 (a label needs a statement).
      const defBody = bodies[bodies.length - 1].body;
      const sw: Stmt = {
        k: 'switch',
        scrutinee: expr(term.operands[0]),
        cases: outCases,
        ...(defBody.length ? { default: defBody, ...(defaultAt !== undefined ? { defaultAt } : {}) } : {}),
      };
      out.push(...aroundSwitch(flags, sw));
      if (merge && merge !== stop) {
        out.push(...structureRegion(merge, stop));
      }
      return out;
    }
    // Everything below assumes a 2-way `cond_br`. Any OTHER terminator (a malformed op) must fail LOUD
    // here — otherwise it is silently read as a `cond_br` and every successor past the second is dropped,
    // a silent control-flow miscompile at the structuring seam.
    if (term.opcode !== 'cond_br') {
      throw new StructureError(
        `cannot structure '${fn.name}': unsupported terminator '${term.opcode}' in block #${fn.blocks.indexOf(b)} ` +
          `(only ret / br / cond_br / switch_br are structured today)`,
      );
    }
    // cond_br: successors = [taken, fallthrough]
    const takenB = term.successors[0].block;
    const fallB = term.successors[1].block;

    // Test-at-top `while`: this block IS a loop header whose pure test decides body-vs-exit. The
    // header test is the loop condition (read on entry values); the body is a region that stops at the
    // header (= continue). The init was already emitted by the predecessor's argAssigns into `b`.
    const wl = whileLoops.get(b);
    if (wl) {
      out.push(...emitTestAtTopWhile(wl, stop));
      return out;
    }

    // The guard of a `while (1)` spelled `for` (THE LOOP AS A `for`, at `forPlanAt`): the `for`'s
    // own first test, so it is dropped rather than kept as an `if`.
    for (const to of [takenB, fallB]) {
      // the header, or a pure preheader's `br` into it (A STRENGTH-REDUCED COUNTED LOOP)
      const into = to.ops[to.ops.length - 1];
      const pre = !foreverLoops.has(to) && into.opcode === 'br' ? to : undefined;
      const h = pre === undefined ? to : into.successors[0].block;
      const fl = foreverLoops.get(h);
      const plan = fl !== undefined && !onStack.has(h) ? forPlanAt(b, fl, pre) : null;
      if (plan !== null) {
        onStack.add(h);
        try {
          out.push(...emitForever(fl!, stop, plan));
        } finally {
          onStack.delete(h);
        }
        return out;
      }
    }

    // guarded self-loop: this cond_br decides "enter loop header h vs its exit". Emit the inits
    // unconditionally, then either a `while` whose own test subsumes this guard (fused — only under
    // the guard proof below), or the guard kept as its own `if` around a bottom-tested `do-while`
    // (gcc's "guard + do-while" shape, emitted as itself). Never claim when `b` is itself the
    // header (a guard-LESS single-block do-while would emit the update once before a
    // wrongly-`while` loop) — require a DISTINCT dominating guard block.
    for (const h of [takenB, fallB]) {
      // `h` may be the header itself or its PURE PREHEADER (the LoopInfo records which): the
      // guard's branch enters the loop either way, and the preheader's defs render inline.
      const li = loops.get(h) ?? [...loops.values()].find((l) => l.preheader === h);
      if (li && h !== b && li.header !== b && (takenB === li.exit || fallB === li.exit)) {
        // Self-loop emitter hazards: the while condition, the header→exit args, and every
        // post-loop use of a header-computed value render under the un-rotation sub — sound only
        // when their loop-variable reads go through sub-mapped back-edge args (post-update). A
        // direct read of an updated variable is a PRE-update value the emitted name no longer
        // holds → decline LOUD, never emit wrong code.
        const sub = loopSub(li);
        const updates = argAssigns(li.header, li.header);
        const updateWrites = loopWriteSet(updates, [li.header], li.header);
        const hterm = li.header.ops[li.header.ops.length - 1];
        const hexitArgs = (successorTo(li.header, li.exit)?.args ?? []) as Value[];
        // FUSION IS ONLY SOUND WHEN EVERYTHING IT DROPS IS REDUNDANT. `isGuardShapedPred` asks about
        // the SHAPE alone — branches to the header, branches to the exit — and an `if` on something
        // else entirely has that shape too. `entryVals` maps each header param and back-edge arg to
        // the arg the guard passes into the loop, so reading through it models the first iteration:
        // the state the guard tested. Two claims are checked against it, both LOUD on failure.
        const guardExit = successorTo(b, li.exit)!; // the fusion condition above guarantees this edge
        // The loop's init edge: the guard's own edge into the header, or the preheader's `br`
        // when one stands between — its args are what the first iteration actually receives.
        const initFrom = li.preheader ?? b;
        const initArgs = (successorTo(initFrom, li.header)?.args ?? []) as Value[];
        // Params first, BACK-EDGE ARGS SECOND: one value can be both — param `i+1` of a shifting
        // pair is also the back-edge arg of param `i` — and the emitted expression renders it
        // under the un-rotation substitution, so that reading is the one that must win.
        const entryVals = new Map<Value, Value>();
        li.header.params.forEach((p, i) => initArgs[i] !== undefined && entryVals.set(p, initArgs[i]));
        li.header.params.forEach(
          (_, i) => initArgs[i] !== undefined && entryVals.set(li.backArgOfParam[i], initArgs[i]),
        );
        // A CALL OR A LOAD IS ONE EVALUATION, AT ONE POINT. Read through, it equals another of one
        // callee or one address on the same operands only where each runs at its own test. The
        // guard's runs there when it sits in the guard block with no effect after it. The loop's
        // runs there when it sits in the header or its pure preheader: the fused `while` renders the
        // header's test at its top, so its first evaluation runs right after the guard's, and the
        // `while`'s first test is the evaluation that replaces the guard's — a store or call ahead
        // of it in the header is the previous iteration's body, at the top of this one. Read through
        // anywhere else, a cached result would equal a fresh one: a call the function made once
        // ahead of both (`if (v < f(a)) do {} while (v < v)` would lose the `f(a)`), or a load ahead
        // of a call or store that changes what it reads (`v = *p; g(); if (i < *p) do {} while
        // (i < v)` would lose the guard and its reload).
        const evaluatedAtTest = (v: Value): boolean => {
          const d = defs.get(v);
          if (d === undefined || !orderSensitive(d)) {
            return true;
          }
          const at = opBlock.get(d);
          if (at === b) {
            return !b.ops.slice(opIndex.get(d)! + 1).some(effectful);
          }
          return at !== undefined && (at === li.header || at === li.preheader);
        };
        // (1) Is the guard PROVABLY the loop's own test? Fusing DELETES it and lets the `while`
        // re-test, so an unproven fuse would lose the `if` outright and run a loop the source
        // skipped. Structural equality is a sufficient proof, never a necessary one: `str[0]` and
        // `str[i]` at `i = 0`, or a signed `e <= 0` beside an unsigned `e != 0`, are the same test
        // spelled differently. The first is one of the identities `sameAtEntry` (ir/entry.ts) reads
        // under `normalize`, which the raise re-roll turns on; this caller keeps it off, since it
        // re-spells rows (agbcc `while (s[i]) i++` fuses into a `for`). The second has no reading.
        // An unproven guard KEEPS its `if`, with the loop as a `do-while` inside it — every test
        // the asm performs is emitted as itself. The proof still gates the SINK below: a sunk copy
        // runs once per iteration, and only the proof (fused form) or the kept `if` makes the
        // zero-trip path skip it. The kept `if` would widen the sink's key to unproven guards too;
        // no row needs that yet, so it stays keyed on the proof.
        const enterIsTaken = takenB === h;
        const contIsTaken = hterm.successors[0].block === li.header;
        const guardProven = sameAtEntry(
          hterm.operands[0],
          term.operands[0],
          entryVals,
          enterIsTaken !== contIsTaken,
          evaluatedAtTest,
        );
        // Fused `while` additionally requires a header free of MATERIALIZED defs: their temps are
        // assigned only inside the body (sideEffects), and an un-rotated `while` condition renders
        // BEFORE the body ever ran — reading a temp uninitialized on the first test. The kept-guard
        // `do-while` tests after the body, so it carries no such restriction.
        const fused = guardProven && !li.header.ops.some((o) => materialize.has(o));
        // A KEPT GUARD IS AN ORDINARY `if` AROUND AN ORDINARY `do-while`, and emitWhile's hazards
        // below are the price of merging the guard's exit edge into the loop's post-loop copies,
        // which only the fused `while` needs, since it drops that edge. So where a kept guard meets
        // one of them, it is not claimed here: the `if` recovery below takes the guard, carrying each
        // exit edge's copies on that edge, and the loop reaches `structureBlock` as the do-while it
        // is (`keptGuardDoWhiles`), with the do-while's repairs — a `++` for the test's own
        // pre-update read, the exit-copy sink, the pre-update homes. Asked only where emitWhile
        // declines, so a guarded loop that structures here keeps its spelling. IDO's stolen-slot
        // latch reaches it (`strlen1`: `if (*s) do { t = s[1]; n++; s++; } while (t);`).
        const handBack = (): boolean => !fused && keptGuardDoWhiles.has(li.header);
        // A pre-update exit copy is repairable rather than fatal: emitted INSIDE the body, ahead of
        // the update, it captures the value the exit edge carries rather than the updated one.
        // Its post-loop copy is then dropped, so the ZERO-TRIP path needs the guard→exit edge as a
        // seed — the only edge holding the never-entered value. That is why the sink demands the
        // proof above: it makes the fused zero-trip path load-bearing.
        const sunk = guardProven
          ? sinkablePreUpdateSlots(
              li.header,
              li.exit,
              hexitArgs,
              new Set([li.header]),
              li.header,
              sub,
              updateWrites,
              hooks.preUpdateSinkGates ?? PREUPDATE_SINK_GATES,
              (j) => !sameAtEntry(hexitArgs[j], guardExit.args[j] as Value, entryVals, false, evaluatedAtTest),
            )
          : new Map<number, Op | null>();
        // (2) Every exit copy the fused form KEEPS renders after the loop, on the zero-trip path
        // too — where the loop variables still hold their init values. It must therefore produce
        // what the guard→exit edge carries, since that edge is dropped. A sunk slot is exempt: its
        // seed and its body copy cover the two paths separately.
        const staleExit = hexitArgs.findIndex(
          (a, j) => !sunk.has(j) && !sameAtEntry(a, guardExit.args[j] as Value, entryVals, false, evaluatedAtTest),
        );
        if (staleExit >= 0) {
          if (handBack()) {
            break;
          }
          throw new StructureError(
            `cannot structure '${fn.name}': the fused guard's exit edge carries a value the post-loop ` +
              `copies do not reproduce on a zero-trip run`,
          );
        }
        const sunkSlot = (j: number) => sunk.has(j);
        const keptSlot = (j: number) => !sunk.has(j);
        if (
          loopUpdateHazard(
            hterm.operands[0],
            hexitArgs.filter((_, j) => keptSlot(j)),
            new Set([li.header]),
            sub,
            updateWrites,
            null,
          )
        ) {
          if (handBack()) {
            break;
          }
          // NO `n++` REPAIR HERE, and the SHAPE is why rather than an oversight. The fold
          // (`preUpdateCondFold`) trades the update copy at the foot of the body for a `++` at the
          // leaf, which is the same program only for a BOTTOM test: it runs once per iteration, in
          // the position the copy stood. This test renders at the TOP, ahead of the body, and runs
          // one more time than the body does — `while (n++ < k)` over a body with no update is a
          // different loop. Reaching this site is a rotation, not a wider gate.
          throw new StructureError(
            `cannot structure '${fn.name}': loop condition or a post-loop value reads a pre-update loop variable`,
          );
        }
        // The seed and the loop init are two copy groups from the SAME block, emitted back to back,
        // and nothing sequentializes them against each other: a seed that writes a name the init
        // then reads hands the loop the wrong starting value. Computed once — a second
        // `argAssigns` for one edge burns a swap-cycle temp number and changes the output.
        const seed = argAssigns(b, li.exit, null, sunkSlot);
        const seedWrites = new Set(seed.filter((st) => st.k === 'assign').map((st) => st.name));
        if (initArgs.some((a) => readsClobbered(a, new Map(), seedWrites))) {
          if (handBack()) {
            break;
          }
          throw new StructureError(
            `cannot structure '${fn.name}': seeding the zero-trip value would overwrite a value the ` +
              `loop initialisation reads`,
          );
        }
        // ZERO-TRIP reads (kept-guard form only): the body sits inside `if (guard)`, so a
        // materialized header def's temp is assigned only when the guard held. A kept exit arg or
        // a post-loop read reaching such a temp — by its NAME, which is how a materialized def
        // renders — reads it uninitialized on the guard-false path, silently. Loop-variable names
        // are exempt (the inits write them unconditionally, and staleExit already proved their
        // zero-trip values); so is anything named outside the header. Decline loud.
        if (!fused) {
          const paramNames = new Set(li.header.params.map((q) => varName.get(q)));
          const bodyTemp = (v: Value): boolean => {
            const d = defs.get(v);
            return (
              d !== undefined &&
              materialize.has(d) &&
              opBlock.get(d) === li.header &&
              varName.has(v) &&
              !paramNames.has(varName.get(v))
            );
          };
          const reachesBodyTemp = (root: Value): boolean => {
            const stack = [root];
            const seen = new Set<Value>();
            while (stack.length) {
              const v = stack.pop()!;
              if (seen.has(v)) {
                continue;
              }
              seen.add(v);
              if (sub.has(v)) {
                continue; // renders as its loop variable's name — unconditionally initialized
              }
              if (bodyTemp(v)) {
                return true;
              }
              if (varName.has(v)) {
                continue; // named outside the guarded body — assigned on both paths
              }
              const d = defs.get(v);
              if (d) {
                stack.push(...d.operands);
              }
            }
            return false;
          };
          if (
            hexitArgs.some((a, j) => !sunk.has(j) && reachesBodyTemp(a)) ||
            [...(liveIn.get(li.exit) ?? [])].some(bodyTemp)
          ) {
            if (handBack()) {
              break;
            }
            throw new StructureError(
              `cannot structure '${fn.name}': a post-loop read reaches a temp the guarded body may never assign`,
            );
          }
        }
        const inits = argAssigns(initFrom, li.header);
        const loopStmt = emitWhile(
          li,
          updates,
          preUpdateCopies(li.exit, hexitArgs, sunk, li.header),
          fused ? 'while' : 'dowhile',
        );
        // The guard-read substitution: an init arg reads as its loop variable's NAME. The inits
        // just assigned them (value-identical), and that is the source spelling — `if (n > 0)`
        // tests the loop variable, which is also the parked register the target's guard reads.
        // Not an UNMATERIALIZED const: the guard compared an immediate (`cmp rX, #0`), and an
        // immediate is what re-spelling it as the counter's name would un-spell.
        const gsub = new Map<Value, string>();
        li.header.params.forEach((p, i) => {
          const a = initArgs[i];
          const ad = a !== undefined ? defs.get(a) : undefined;
          if (a !== undefined && !(ad?.opcode === 'const' && !materialize.has(ad))) {
            gsub.set(a, varName.get(p)!);
          }
        });
        if (!fused) {
          // The kept guard's condition renders AFTER the seed and the inits, but tests the state
          // BEFORE them — a read of a just-(non-identity-)written name is sound only through
          // `gsub`, whose mapped values the inits deliberately hold.
          const writes = new Set([...seedWrites, ...updateWriteSet(inits)]);
          if (readsClobbered(term.operands[0], gsub, writes)) {
            if (handBack()) {
              break;
            }
            throw new StructureError(
              `cannot structure '${fn.name}': the kept guard's condition reads a name the loop initialisation overwrites`,
            );
          }
        }
        out.push(...seed); // zero-trip value for the sunk copies
        out.push(...inits); // loop-variable initialisation
        if (fused) {
          out.push(loopStmt);
        } else {
          let gcond = exprWith(gsub)(term.operands[0]);
          if (!enterIsTaken) {
            gcond = negateCond(gcond);
          } // entering the loop must be `taken`
          out.push(mkIf(gcond, [loopStmt], []));
        }
        // A POST-LOOP READ THAT HOLDS THE INIT INSTEAD. The exit copies and the exit region render
        // under the un-rotation substitution, which spells a back-edge arg as its loop variable's
        // name. Both run on the zero-trip path too, where that name still holds its init — so an arg
        // computed BEFORE the loop reads right there only if the init is that very value (`sub` is
        // last-wins over params sharing an arg, so the init is read off the last one). `staleExit`
        // proves a copy through `sameAtEntry`, which answers true for one value on both exit edges
        // without looking inside it — so such a copy is judged here through its inlined expression,
        // and the region wherever its render hits such an entry (`zeroTripStale`).
        //
        // KNOWN GAP, wrong before this check existed too: two DIFFERENT exit values sharing a subtree
        // that reaches a stale entry pass `staleExit` for the same reason, and so do two calls whose
        // operands map to each other through the entry values.
        const stale = new Map(
          [...sub].filter(([x]) => {
            const d = defs.get(x);
            return (
              !li.header.params.includes(x) &&
              (d === undefined || opBlock.get(d) !== li.header) &&
              initArgs[li.backArgOfParam.lastIndexOf(x)] !== x
            );
          }),
        );
        const holdsInitInstead = (root: Value): boolean => {
          const seen = new Set<Value>();
          const walk = (x: Value): boolean => {
            if (seen.has(x)) {
              return false;
            }
            seen.add(x);
            if (sub.has(x)) {
              return stale.has(x);
            }
            if (varName.has(x)) {
              return false;
            }
            const d = defs.get(x);
            return d !== undefined && d.operands.some(walk);
          };
          return walk(root);
        };
        if (hexitArgs.some((a, j) => keptSlot(j) && a === guardExit.args[j] && holdsInitInstead(a))) {
          throw new StructureError(
            `cannot structure '${fn.name}': a read after the loop spells a value computed before it by a ` +
              `loop variable's name, which holds its initial value on a zero-trip run`,
          );
        }
        // The header→exit edge may carry non-identity phi args (the exit param merges the guard-false
        // value with the loop's final value). Emit those copies after the loop — dropping them returns
        // a stale value. Read under the un-rotation substitution (post-loop the params hold their
        // updated values), and structure the exit region under the same substitution so a post-loop
        // use of a loop value reads its name.
        out.push(
          ...withSub(sub, () => {
            const copies = argAssigns(li.header, li.exit, sub, keptSlot);
            const prevStale = zeroTripStale;
            zeroTripStale = prevStale ? new Map([...prevStale, ...stale]) : stale;
            try {
              return [...copies, ...structureRegion(li.exit, stop)];
            } finally {
              zeroTripStale = prevStale;
            }
          }),
        );
        return out;
      }
    }

    // Is THIS edge one of the enclosing loop's admitted early-`return` arms? Keyed on the edge
    // because ownership is: a second edge into the same block is a separate question. No shape today
    // separates it from keying on the target alone — this holds the invariant, it does not fix an
    // observed bug.
    const isArm = (t: Block) => !!loopCtx && loopCtx.arms.some((a) => a.from === b && a.to === t);

    // Conditional latch / in-body early exit: one edge of this cond_br is the loop back-edge (a
    // continue to `loopCtx.header`); the other LEAVES the loop. When the leaving edge lands on the
    // loop's own exit block it is a `break`; when it trampolines to a `return` it is an early `return`.
    // Emit the loop update (the back-edge args, RAW) then a single `if (leaveCond) { <exit arm> }` — the
    // back-edge arm is the implicit continue (control falls to the loop bottom). Guarded to leaving
    // edges only (`!body.has(exitB)` AND a break/return target); an in-body conditional continue still
    // declines (falls through → the header re-entry trips `onStack`, an honest loud fail).
    //
    // Taken only where the implicit continue holds (`continueFallsToBottom`). Where it does not, a
    // break edge is refused by name below, and an arm re-enters the header and declines loud.
    // A switch arm opened in this loop, with no loop entered since: C binds a `break;` here to the
    // switch, so neither rule below may mint the loop's (see the second).
    const armFrame = switchFrames.length > 0 ? switchFrames[switchFrames.length - 1] : undefined;
    const armCapturesBreak = loopCtx !== null && armFrame !== undefined && armFrame.loop === loopCtx;
    if (
      loopCtx &&
      continueFallsToBottom(loopCtx, stop) &&
      (takenB === loopCtx.header || fallB === loopCtx.header) &&
      !(armCapturesBreak && (takenB === loopCtx.exit || fallB === loopCtx.exit))
    ) {
      const contIsTaken = takenB === loopCtx.header;
      const exitB = contIsTaken ? fallB : takenB;
      const isBreak = exitB === loopCtx.exit;
      // The back-edge substitution: each header param's back-edge arg → the param's name, so a test that
      // reads a POST-update value (the value carried to the header) shows the header var name.
      const sub = subFor(loopCtx.header.params, successorTo(b, loopCtx.header)!.args);
      // SOUNDNESS (pre-update-read hazard): the loop update (`argAssigns(b, header)`) is emitted
      // BEFORE the exit test/args. If the test or an exit arg reads a PRE-update value of an
      // induction variable (a body/header param, NOT a back-edge arg) whose coalesced name the
      // update overwrites, the emitted C would read the post-update value → a silent miscompile
      // (break/return fires on the wrong value; e.g. a test on `v0` where the update did
      // `v0 = v0 - 1`). Back-edge args (in `sub`) are the INTENDED post-update reads and are safe.
      // `readsClobbered` distinguishes the two at the VALUE level; on a hazard, decline (fall
      // through → honest loud fail) rather than emit wrong code.
      const updateCopies = argAssigns(b, loopCtx.header);
      const updateWrites = loopWriteSet(updateCopies, loopCtx.body, loopCtx.header);
      const exitArgs = (successorTo(b, exitB)?.args ?? []) as Value[];
      // The exit ARM may also read loop-body-computed values directly (an exitB dominated by `b`
      // — e.g. its `ret` operand), not just through edge args: apply the same escape test to the
      // arm's region (blocks reachable from exitB outside the loop body).
      //
      // WHAT THE REGION IS FOR: this arm renders INSTEAD of the next iteration, behind an update
      // already emitted, so a read of a loop variable here wanted the value it had before that —
      // `if (found) { *out = i; return; }` would store `i + 1`. Handing the arm's own region makes
      // the escape check judge exactly those reads.
      const exitRegion = new Set([exitB, ...reachFrom(exitB)].filter((x) => !loopCtx!.body.has(x)));
      // A `break` is judged by the break rule, with the update among the writes ahead of it: the
      // exit region renders raw after the loop, so a header value re-derived there from a name the
      // update wrote is computed once more — `do { b = t / (b + t); if (c > 2) break; } while
      // (--d > 0); return b;` renders `return t / (v + t)` after `v = t / (v + t)` already ran. An
      // early `return` needs none of it: its `return` ends the arm, so nothing after the loop runs.
      const hazard = loopUpdateHazard(term.operands[0], exitArgs, loopCtx.body, sub, updateWrites, exitRegion);
      const rule = isBreak ? breakRule(loopCtx, b, new Set([...updateWrites, ...writtenAhead(loopCtx, b)])) : null;
      if (!hazard && !loopCtx.body.has(exitB) && (rule ? 'bare' in rule : isArm(exitB))) {
        out.push(...updateCopies); // the loop update, RAW (i++, p>>=1, …)
        let leaveCond = exprWith(sub)(term.operands[0]);
        if (contIsTaken) {
          leaveCond = negateCond(leaveCond);
        } // continue is `taken` → leave when NOT it
        const exitArm =
          rule && 'bare' in rule
            ? [...(rule.bare ? [] : argAssigns(b, exitB, sub)), { k: 'break' } as Stmt] // break to the loop exit
            : withSub(sub, () => [...argAssigns(b, exitB, sub), ...structureRegion(exitB, stop)]); // early return
        out.push(mkIf(leaveCond, exitArm, []));
        return out;
      }
    }

    // A `break` from INSIDE the body: one edge of this cond_br is an admitted break edge (it lands on
    // the `while`'s own exit). Spelled `if (c) { <edge copies>; break; }` and then what the other edge
    // runs, which is what the asm runs: the exit region renders once, after the loop, for the
    // header's exit and this edge alike. The break leaves before any update copy on this path, so
    // the loop variables still hold what the header read, unless a block between the header and here
    // wrote one of their names.
    //
    // The other edge may be the BACK edge, where the latch path above refused (its update-first
    // spelling would let the test or the exit read a value the update overwrites). The update copies
    // then follow the `if`, where the break has already left — the same C as when the update sits in
    // a block of its own, which is a layout accident.
    //
    // Refused: by the break rule over the names written ahead of this edge; where the other edge
    // leaves the body too; and where the other edge is the back edge but the implicit continue does
    // not hold (`continueFallsToBottom`) — every route to the header re-enters it, so that refusal is
    // always loud. The others are loud, since the loop was admitted on the promise of this spelling,
    // unless an arm owns the edge or the exit ends in a `ret`: then if-recovery below copies the
    // exit's tail into the arm and returns.
    // Inside a switch arm opened in THIS loop (no loop entered since), C binds `break;` to the
    // switch, so the loop's `break` cannot be spelled here. An arm spells an edge to the loop's exit
    // only where that exit is the switch's own merge: the code after the switch then IS the exit
    // region, and the edge structures as any other edge to the merge — the arm's `break;`
    // (`switchBreakAt`), or nothing in a closed arm, which stops there. An exit whose tail returns
    // (or that an early-return arm owns) needs no `break`: if-recovery below copies the tail into the
    // arm, as it does outside a switch when the break rule refuses. Any other exit is refused here,
    // loud, rather than handed to the printer as a `break` it would rebind.
    // A TWO-LEVEL EXIT out of this block (`TwoLevelExit`): its edge to the second target is the
    // `break`, and sets the flag first. Any refusal of it is loud: if-recovery would structure the
    // code from the second target inside the loop. In a case body opened in this loop it is refused
    // outright, since `break` there leaves only the switch (`TWO_LEVEL_BREAK_GATES`): agbcc -O2
    // lays out a case that falls through after `if (h(j)) goto T;` that way. The case-body refusal
    // below declines the same input too, the second target being a loop exit past the switch's end.
    const twoLevel =
      loopCtx?.twoLevel?.from.has(b) === true && (takenB === loopCtx.twoLevel.to || fallB === loopCtx.twoLevel.to)
        ? loopCtx.twoLevel
        : undefined;
    if (
      twoLevel !== undefined &&
      firstRejection(hooks.twoLevelBreakGates ?? TWO_LEVEL_BREAK_GATES, { inCaseBody: armCapturesBreak }) !== null
    ) {
      throw new StructureError(
        `cannot structure '${fn.name}': a two-level exit out of block #${fn.blocks.indexOf(b)} sits in a case ` +
          `body, where \`break\` would leave only the switch`,
      );
    }
    if (loopCtx && loopCtx.breaks.has(b) && armCapturesBreak) {
      const exit = loopCtx.exit;
      const tailReturns = exit !== null && (isArm(exit) || isRet(exit));
      if ((exit === null || armFrame!.merge !== exit) && !tailReturns) {
        wantFor();
        throw new StructureError(
          `cannot structure '${fn.name}': a case body leaves its switch for a loop exit past the ` +
            `switch's end (block #${fn.blocks.indexOf(b)}), where \`break\` would leave only the switch`,
        );
      }
    } else if (loopCtx && loopCtx.breaks.has(b)) {
      const frame = loopCtx;
      // An arm that runs code before it breaks (`codeBreakArm`) is rendered inside the `if`, ahead of
      // the `break`, and its last block's copies into the exit are the break's.
      const arm = frame.breakArms?.find((a) => a.from === b && (a.to === takenB || a.to === fallB));
      const breakIsTaken = takenB === (twoLevel?.to ?? arm?.to ?? frame.exit);
      const stayB = breakIsTaken ? fallB : takenB;
      const continueRefused = stayB === frame.header && !continueFallsToBottom(frame, stop);
      // an outward exit also leaves the enclosing loop, for its exit: judged there as that loop's break
      const outer = twoLevel?.outward === true ? frame.enclosing : undefined;
      const outerRule = outer !== undefined ? breakRule(outer, b, writtenAhead(outer, b), outer.exit) : null;
      const rule = continueRefused
        ? { refusal: 'would continue the loop from a region that ends past the loop bottom' }
        : !frame.body.has(stayB)
          ? { refusal: 'has no edge beside it that stays in the loop' }
          : outerRule !== null && 'refusal' in outerRule
            ? outerRule
            : breakRule(frame, b, writtenAhead(frame, b), twoLevel?.to ?? frame.exit);
      if ('bare' in rule) {
        let leaveCond = expr(term.operands[0]);
        if (!breakIsTaken) {
          leaveCond = negateCond(leaveCond);
        }
        const [breakEdge, stayEdge] = breakIsTaken ? term.successors : [term.successors[1], term.successors[0]];
        out.push(
          mkIf(
            leaveCond,
            [
              ...(rule.bare ? [] : argAssignsFor(b, breakEdge)),
              ...(arm !== undefined && twoLevel === undefined ? structureRegion(arm.to, frame.exit) : []),
              ...(outer !== undefined ? structureRegion(twoLevel!.to, outer.exit) : []),
              ...(twoLevel !== undefined
                ? [{ k: 'assign', name: twoLevelFlag(frame.header), value: { k: 'const', value: 1 } } as Stmt]
                : []),
              { k: 'break' },
            ],
            [],
          ),
        );
        out.push(...argAssignsFor(b, stayEdge), ...structureRegion(stayB, stop));
        return out;
      }
      if (
        twoLevel !== undefined ||
        continueRefused ||
        frame.exit === null ||
        (!isArm(frame.exit) && !isRet(frame.exit))
      ) {
        throw new StructureError(
          `cannot structure '${fn.name}': a break out of block #${fn.blocks.indexOf(b)} ${rule.refusal}`,
        );
      }
    }

    // Regime-A switch: if this cond_br roots a comparison tree over a single scrutinee, emit a
    // `switch`. A pre-check here — mirroring the guard-fused-loop check above — so it sees the raw
    // tree before if-recovery claims the diamonds. Declines (null) fall through to plain if-recovery.
    const asSwitch = handedThroughSwitch(() => recognizeSwitch(b, stop));
    if (asSwitch) {
      out.push(...asSwitch);
      return out;
    }

    const cond = expr(term.operands[0]);
    // null ⇒ the arms diverge (both reach EXIT) and no follow over early returns applies. Asked
    // outside loop bodies only: inside one, `clampToLoop` below owns the question. DEFENSIVE — no
    // input it changes: ablated, the follow fires on no more of 40,000 generated functions (random
    // structuring options, sunk and unsunk), and every row of both tiers enumerates a byte-identical
    // variations-and-source set (810 synthetic, 251 real, `ProcessInputAndUpdateEntities` excepted).
    const ipd = ipdom.get(b) ?? (followEarlyReturns && loopCtx === null ? followOverReturns(b, stop) : null);
    // Inside a loop body, a join OUTSIDE that body is not this `if`'s join: an arm that leaves the
    // loop `return`s and never comes back, so what is left reconverges at the loop's own
    // continuation. Post-dominance cannot see that — agbcc/gcc merge every `return` into one
    // epilogue, which the early return and the post-loop path both reach — and structuring the
    // in-loop arm towards it walks through the latch and back into the header (a loud `onStack`
    // decline).
    //
    // `stop` stands in for the real join, so it has to BE the real join: one side must already end
    // this region — an admitted arm (its `return` terminates that path) or `stop` itself. Two sides
    // meeting somewhere further down instead would each re-emit everything from there to the bottom,
    // doubling per nesting level; those take the post-dominator computed over the body alone with
    // the back edges and the arms DELETED (`loopJoin`, below) — treating the arms as exits does
    // not work, since post-dominance cannot express "where the paths that did not return meet".
    const clampToLoop =
      loopCtx !== null &&
      ipd !== null &&
      !loopCtx.body.has(ipd) &&
      term.successors.some((sc) => isArm(sc.block) || sc.block === stop) &&
      term.successors.every((sc) => loopCtx!.body.has(sc.block) || isArm(sc.block));
    // THE BODY'S OWN JOIN (`inLoopJoin`, the one rule the `switch` reads too). In a `while (1)` body
    // it is asked always: a branch whose one arm continues is post-dominated, in the CFG, by
    // wherever the other arm leaves the loop from. In a tested loop it is the same question for a
    // branch whose one way leads out of the body by a `break` — the `else break;` of an
    // if/else-if chain — whose CFG join is the loop's exit, its in-body arm walked from there
    // through the latch back into the header (`onStack`); asked there only where no clamp applies
    // and one successor stays in the body, and `inLoopJoin` adds that the CFG join leaves the body
    // and every way out from here is one the loop renders in place.
    const inForever = loopCtx !== null && foreverLoops.has(loopCtx.header);
    const bodyJoin =
      loopCtx !== null &&
      (inForever ||
        (!clampToLoop && term.successors.some((sc) => loopCtx!.body.has(sc.block) && sc.block !== loopCtx!.header)))
        ? inLoopJoin(b, ipd)
        : undefined;
    // Inside a switch arm, the arm's own join wins over every reading above: each of them reads the
    // CFG, where the arm's paths meet past the switch.
    const inArmJoin = armJoin(b, stop);
    const merge =
      inArmJoin !== undefined
        ? (inArmJoin ?? stop)
        : bodyJoin !== undefined
          ? (bodyJoin ?? stop)
          : clampToLoop
            ? stop
            : (ipd ?? stop);
    // Per-successor records, NOT successorTo(b, block): a cond_br whose two edges reach the SAME
    // block with different args would otherwise give both arms the first edge's copies.
    const thenS = [...argAssignsFor(b, term.successors[0]), ...structureRegion(takenB, merge)];
    const elseS = [...argAssignsFor(b, term.successors[1]), ...structureRegion(fallB, merge)];
    // A BRANCH-SENSE SITE: both arms real, so the swapped-and-negated spelling is a genuine
    // sibling rather than noise on a one-armed if. Which boolean owns it is `ipd`: divergent arms
    // (both terminate, no reconvergence) belong to preserveDivergentBranchSense, a reconverging
    // pair to negateJoinedBranchSense — and the split has to stay, or a /flip-branch candidate would
    // fall into the joined case and get flipped BACK, collapsing the {divergent × joined}
    // combination. Sense TRUE = the asm branched forward to the `taken` block and fell through to
    // `fall`, so a compiler that PRESERVES source branch direction saw the FALL-THROUGH arm as
    // `then`: putting the taken arm as `else` (and negating) reproduces the original. Byte-exact
    // on IDO/MIPS; agbcc/GCC canonicalise either way, so it is safe there too. A compiler that
    // inverts branch canonicalization sets the boolean false and gets the positive form.
    const senseSite = thenS.length > 0 && elseS.length > 0;
    // The fold's evidence where there is any, the function-wide boolean where there is not
    // (`senseFromFoldEvidence`). THREE stamps, and exactly ONE of the eight cells negates.
    //
    //   onFall  isTaken  relayed  spelling   inhabitant (each measured from its own asm)
    //   ------  -------  -------  --------   --------------------------------------------------
    //   false   true     false    NEGATE     `synthetic:ifand_near` — the short-branch `&&`
    //   true    true     false    positive   `synthetic:ifor_near`  — the short-branch `||`
    //   true    false    true     positive   `synthetic:ifand_far`  — the long-branch `&&`
    //   false   true     TRUE     positive   `synthetic:ifor_far`   — the long-branch `||`
    //   false   false    false    positive   `synthetic:chainsense`, the chained fold
    //   (the other three cells are uninhabited over the committed corpus at both settings)
    //
    // `scSharedIsTaken` says where the shared arm went — TRUE, the arm both tests reach is this
    // branch's TAKEN successor, is the `||` fold. `scSharedOnFall` says which source arm it is:
    // true = the last test FELL INTO it, so under gcc's source-order layout it is the source's
    // `then`. A shared arm in the FALL slot leaves the source's `then` in the taken slot whatever
    // the layout — an `&&`'s shared arm is where its FAILING tests go — so the `&&` half is
    // positive at both values of `scSharedOnFall` and the premise is only consulted where it
    // decides something. That is what admits the CHAINED fold, `scSharedOnFall` false, whose inner
    // fold left the head's taken edge pointing at the next test: reading the source arm alone
    // NEGATES it, `synthetic:chainsense` is 4/44 that way and MATCH this way, and the inner-loop
    // site of `kleod:CountCollectedGems:agbcc` is the real-row inhabitant (39/352 → 18/344).
    //
    // `scEdgeRelayed` is the LONG BRANCH, and it is the stamp that keeps the premise honest rather
    // than absorbing it. agbcc inverts a conditional it cannot reach in ±256 bytes, so the layout
    // claim `scSharedOnFall` rests on is simply false there — and the inversion moves the shared arm
    // to the OTHER successor slot, which is why it is not confined to one quadrant. Measured: the
    // long `||` (`ifor_far`) stamps the IDENTICAL pair as the short `&&` (`ifand_near`), false/true,
    // and wants the opposite spelling. Two booleans cannot separate them; without this one the
    // reading spells `ifor_far` as its own dual. Both long rows are pinned by test/site-sense.test.ts
    // and by nothing else: each MATCHes on `/flip-join` whatever the fold spelled (0/140 and 0/139).
    //
    // WHAT IS STILL UNDECIDED, and it is a cell of this table rather than a hole beside it: at
    // `(onFall=true, isTaken=false)` the corpus holds a function with TWO sites of OPPOSITE source
    // sense — `kleod:CheckWorldCompletion:agbcc`, whose own `refSource` wants the positive spelling
    // at one and the negated one at the other. No CONSTANT is right for that cell; this table's
    // `positive` is right at one of the two and wrong at the other, and the row scores 45/191 with
    // the same winner either way because `/site-sense` is not its winner. If the cell is ever to be
    // decided it needs a SITE fact the fold does not carry yet; if it cannot be, the honest shape is
    // `rank.ts`'s per-site mask (`branchSenseFlipSites`, the `/sense-N` probe), which enumerates a
    // site both ways instead of picking. Do not read the table above as the mapping being a function.
    //
    // CENSUS over the 1037 rows of the committed artifact — which predates `synthetic:ifor_far` and
    // `synthetic:chainsense`, the two rows added for the cells below. Each row's own `targetAsm`
    // lifted at both `/connective` settings: stamped `cond_br`s at the PRODUCER, then this
    // consumer's own reads at real two-armed sense sites, each summed over the two settings:
    //
    //   stamped sites     `/connective` off: 82 taken-slot,  4 long-branch, 0 chained
    //                     `/connective` on:  85 taken-slot,  4 long-branch, 2 chained
    //   consumer reads    99 taken-slot, 8 long-branch, 2 chained
    //
    // The chained cell has ZERO inhabitants with `/connective` off, so that half of the capability
    // is reachable only through the `/connective` lift variation — both real inhabitants and
    // `chainsense` carry it in their winner. And `scEdgeRelayed`'s own cell `(false,true,true)`
    // carries 9 stamped sites at each setting and **0 consumer reads** there: all 9 are MIPS rows
    // (`ido7.1`/`gcc2.7.2kmc`, where no ±256 range exists and a relay means something else), and
    // none is a two-armed sense site, so those rows emit byte-identical C with the stamp and
    // without it — the cell's one reader is `synthetic:ifor_far`, measured from its own asm. That
    // MIPS firing is this stamp's known over-reach — a PROXY firing where the structure it proxies
    // is absent — priced at 0 today and worth re-censusing whenever a MIPS row starts reading it.
    //
    // REFUSES unless ALL THREE stamps are present. DEFENSIVE — no input reaches it: the one producer
    // (raise/shortcircuit.ts) writes all three in a single object literal, and instrumenting this
    // read over that same corpus counts 0 partially-stamped sites. A site the fold never touched
    // carries none and keeps its function-wide boolean.
    const foldEvidence = term.attrs.scSharedOnFall;
    const sharedIsTaken = term.attrs.scSharedIsTaken;
    const edgeRelayed = term.attrs.scEdgeRelayed;
    const siteDefault =
      senseFromFoldEvidence &&
      typeof foldEvidence === 'boolean' &&
      typeof sharedIsTaken === 'boolean' &&
      typeof edgeRelayed === 'boolean'
        ? sharedIsTaken && !foldEvidence && !edgeRelayed
        : ipd === null
          ? preserveDivergentBranchSense
          : negateJoinedBranchSense;
    let negateHere = false;
    if (senseSite) {
      // Keyed by BLOCK, numbered by first visit. Both halves matter: a region the structurer
      // emits twice (a tail duplicated into two arms) reaches the same block twice and must get
      // the SAME sense both times, and the ordinal has to mean the same site under every mask —
      // which it does because both arms are structured ABOVE, before any sense is chosen, so the
      // visit order does not depend on the choice.
      const bi = fn.blocks.indexOf(b);
      let ord = senseOrdinal.get(bi);
      if (ord === undefined) {
        ord = senseOrdinal.size;
        senseOrdinal.set(bi, ord);
      }
      negateHere = branchSenseFlipSites?.has(ord) ? !siteDefault : siteDefault;
      hooks.onBranchSenseSite?.({ block: bi, ordinal: ord, joined: ipd !== null, negated: negateHere });
    }
    if (
      stmtsEqual(thenS, elseS) &&
      testRereadsOnly(term, b, { defs, useSitesOf, dom, ipdom, loops: forest.byHeader.values() })
    ) {
      out.push(...unionStmtsEvidence(thenS, elseS));
    } else {
      // A compare whose runtime helper names the relation the source spelled DECIDES its own sense,
      // one-armed or two: the arm order is the one that spells that relation, because no spelling
      // of its negation calls the same helper (l3/ast.ts `keepsHelperRel`). `if (a == b) {} else`
      // is how the source wrote agbcc's `bl __eqsf2; cmp r0, #0; beq` over the arm.
      const helperSense = keepsHelperRel(cond) ? false : regainsHelperRel(cond) ? true : undefined;
      const negate = helperSense ?? negateHere;
      out.push(
        negate
          ? { k: 'if', cond: negateCond(cond), then: elseS, else: thenS }
          : helperSense === false
            ? { k: 'if', cond, then: thenS, else: elseS }
            : mkIf(cond, thenS, elseS),
      );
    }
    if (merge && merge !== stop) {
      out.push(...structureRegion(merge, stop));
    }
    return out;
  };

  // The un-rotation / back-edge substitution: each header param's back-edge arg → the param's
  // name, so a latch test (and exit copies) reads the post-update value under the param's name.
  // ONE builder for all three loop emitters (self-loop, do-while, early-exit).
  const subFor = (params: Value[], backArgs: Value[]): Map<Value, string> => {
    const sub = new Map<Value, string>();
    params.forEach((p, i) => sub.set(backArgs[i], varName.get(p)!));
    return sub;
  };
  const loopSub = (li: LoopInfo): Map<Value, string> => subFor(li.header.params, li.backArgOfParam);

  // The sunk exit copies, as body statements: `dest = <the arg, rebuilt here>`, SPLIT by where in
  // the body each one belongs. WHERE is not recomputed here: `sinkablePreUpdateSlots` cleared each
  // slot at one position and hands it back, so `atDef` keys the ones homed at a latch op by that op,
  // for that block's `sideEffects` walk, and `leading` opens the body with the rest. The sink's gates
  // are stated against `exprWith(null)` — every name the walk stops at holds, anywhere in the body
  // ahead of the update, what it held where the edge read it — so the arg is spelled with no
  // substitution. Slot order keeps it deterministic.
  //
  // NOT `expr`: an ambient `activeSub` is an ENCLOSING loop's post-loop naming, which the sink's
  // walk does not model, so a REBUILT tree here would be spelled under names that substitution has
  // redefined. DEFENSIVE — no input reaches it: instrumenting this line across the whole suite,
  // `activeSub` is null at every call. It stays because the failure it names is silent (a wrong
  // value, not a gap) and the cost of keeping it is one branch.
  //
  // The destination name is read as an invariant, not checked: every block param carries one.
  // `assertResolved` is what catches a widening that breaks that.
  //
  // `home` is the loop HEADER, which dominates every point inside the body a copy is rebuilt at, and
  // so the block from which every one of these writes is reachable. Recorded rather than inferred
  // because `exit` says the opposite (see `sunkCopyHomes`).
  const preUpdateCopies = (
    exit: Block,
    exitArgs: readonly Value[],
    sunk: ReadonlyMap<number, Op | null>,
    home: Block,
  ): SunkCopies => {
    const out: SunkCopies = { leading: [], atDef: new Map() };
    for (const [j, at] of [...sunk].sort(([x], [y]) => x - y)) {
      if (activeSub !== null && !varName.has(exitArgs[j])) {
        throw new StructureError(
          `cannot structure '${fn.name}': a pre-update exit copy would rebuild a computed value ` +
            `inside a loop nested in another loop's post-loop naming`,
        );
      }
      const name = varName.get(exit.params[j])!;
      sunkCopyHomes.push({ name, home });
      // A value the body already names under the destination writes it where it is computed, so
      // its copy would be `dest = dest`: the slot needs only the seed and the dropped post-loop copy.
      if (varName.get(exitArgs[j]) === name) {
        continue;
      }
      const st = { k: 'assign' as const, name, value: exprWith(null)(exitArgs[j]) };
      if (at === null) {
        out.leading.push(st);
      } else {
        (out.atDef.get(at) ?? out.atDef.set(at, []).get(at)!).push(st);
      }
    }
    return out;
  };

  /** Every copy `preUpdateCopies` placed at a def, once the body that was meant to hold it is
   *  assembled. FORWARD DEFENCE WITH NO REACH TODAY: both emitters hand `atDef` to `sideEffects` on
   *  the very block the gate homed those copies in, and that walk visits every op the block holds,
   *  so no key can go unvisited. It is stated rather than assumed because what it names is silent —
   *  a body assembled without that block's side effects, or handing the copies to another block's
   *  walk, drops a copy, and a dropped copy is a wrong value rather than a gap.
   *
   *  STRICT, where the anchored-copy obligation below tests OBSERVABILITY instead, and the
   *  difference is which position is guaranteed. An anchor's position is a const's def block, which
   *  may legitimately render no statement at all — a loop preheader the guarded-loop emitter never
   *  structures is one — so a copy that vanishes there can still leave a consistent program. A sunk
   *  copy's position is in a block both emitters render whatever else they do, because that block's
   *  side effects carry the loop's stores; a copy missing from it is a mistake in assembling the
   *  body and has no second reading. */
  const assertSunkCopiesPlaced = (copies: SunkCopies): void => {
    for (const st of [...copies.atDef.values()].flat()) {
      if (!sunkCopiesEmitted.has(st)) {
        throw new StructureError(
          `cannot structure '${fn.name}': a pre-update exit copy has no position in the loop body it belongs to`,
        );
      }
    }
  };

  // A guarded self-loop's body and latch test. The test reads the header's own params (back-edge
  // args substituted back), and the body is any sunk trailing copies, then the header's SIDE
  // EFFECTS in program order, then its parallel update. The side effects are required — a
  // copies-only body would silently delete every store/discarded call in the header. Effect order
  // is right by construction: statements read pre-update names, the updates land after, and a sunk
  // copy reads the top-of-iteration value it is there to capture.
  //
  // The SAME cond/body serve both forms: as a `while` (guard fused away — the un-rotation), the
  // first test reads the just-emitted init values; as a `dowhile` (guard kept as its own `if`),
  // every test runs after the update wrote the params' next values. Both are what that form's
  // source spelling means.
  const emitWhile = (
    li: LoopInfo,
    updates: Stmt[] | undefined,
    sunkCopies: SunkCopies,
    kind: 'while' | 'dowhile',
  ): Stmt => {
    const term = li.header.ops[li.header.ops.length - 1];
    let cond = exprWith(loopSub(li))(term.operands[0]);
    if (term.successors[0].block !== li.header) {
      cond = negateCond(cond);
    } // loop-continue must be `taken`
    const body = [
      ...sunkCopies.leading,
      ...sideEffects(li.header, sunkCopies.atDef),
      ...(updates ?? argAssigns(li.header, li.header)),
    ];
    assertSunkCopiesPlaced(sunkCopies);
    return kind === 'while' ? { k: 'while', cond, body } : { k: 'dowhile', cond, body };
  };

  // Test-at-top `while`: the header's cond_br is the loop condition. The body is a region that stops
  // at the header (the back-edge = end-of-iteration; the latch's argAssigns emit the loop update where
  // it structurally lands). Polarity: the continue edge is the body-entry; negate iff body-entry
  // is the FALL-THROUGH (successors[1]) — NOT the self-loop-relative test emitWhile uses.
  const emitTestAtTopWhile = (wl: WhileLoopInfo, stop: Block | null): Stmt[] => {
    const term = wl.header.ops[wl.header.ops.length - 1];
    let cond = expr(term.operands[0]);
    if (term.successors[1].block === wl.bodyEntry) {
      cond = negateCond(cond);
    }
    // The header→bodyEntry edge may carry non-identity phi args (a value the header COMPUTED and passes
    // into the body). Those copies must open the body — dropping them reads an uninitialised local.
    // Mirror the br/cond_br cases: argAssigns then structureRegion. Structure the body under this
    // loop's frame so an in-body conditional exit (break / early return) is recognised instead of
    // tripping the header-re-entry `onStack` guard.
    const body = withLoop(
      { header: wl.header, exit: wl.exit, body: wl.body, arms: wl.arms, breaks: wl.breaks, breakArms: wl.breakArms },
      () => [...argAssigns(wl.header, wl.bodyEntry), ...structureRegion(wl.bodyEntry, wl.header)],
    );
    // A test whose tail is a float compare the stay sense moves off its runtime helper's relation
    // (l3/ast.ts `splitHelperBreak`) leaves through a break guard, ahead of the edge's copies: the
    // header evaluated it before them.
    const split = splitHelperBreak(cond);
    if (split !== null) {
      cond = split.head;
      body.unshift({ k: 'if', cond: split.guard, then: [{ k: 'break' }], else: [] });
    }
    const out: Stmt[] = [{ k: 'while', cond, body }];
    out.push(...argAssigns(wl.header, wl.exit)); // phi args carried on the header→exit edge, if any
    out.push(...structureRegion(wl.exit, stop));
    return out;
  };

  // MAY A BRANCH IN A TESTED LOOP JOIN INSIDE THE BODY? Only where every way out of the body from `b`
  // is one the loop's own spelling renders in place: a `break` (an edge of `breaks`, or the edge the
  // loop tests at its header or latch) or an early-`return` arm the loop owns. Any other edge out
  // leaves for code that is copied wherever it is reached, and a join inside the body would write
  // that tail into the arm as well.
  const leavesByOwnedEdges = (frame: LoopFrame, b: Block): boolean => {
    const exitFrom = whileLoops.get(frame.header)?.header ?? doWhileLoops.get(frame.header)?.latch;
    const seen = new Set<Block>();
    for (const stack = [b]; stack.length > 0;) {
      const x = stack.pop()!;
      if (x === frame.header || seen.has(x)) {
        continue;
      }
      seen.add(x);
      for (const sx of successorsOf(x)) {
        if (frame.body.has(sx)) {
          stack.push(sx);
        } else if (
          !frame.arms.some((a) => a.from === x && a.to === sx) &&
          !(sx === frame.exit && (frame.breaks.has(x) || x === exitFrom))
        ) {
          return false;
        }
      }
    }
    return true;
  };
  // THE JOIN OF A BRANCH IN A LOOP BODY, ONE RULE FOR BOTH BRANCHING STATEMENTS — the `if`
  // (`bodyJoin` at the cond_br site) and the `switch` (THE LOOP CLAMP at the switch_br
  // site). `undefined` ⇒ no loop reading applies and the statement keeps its CFG merge; otherwise
  // `loopJoin`'s answer, null meaning the paths meet only at the bottom of the body.
  //  - Outside a loop, or inside one of the innermost loop's break arms: undefined. A break arm's
  //    blocks join as any code outside the loop does.
  //  - In a `while (1)` frame: the body's own join, always (`loopJoin` under the `while (1)` rule).
  //    The CFG cannot see it there: a branch whose one arm continues is post-dominated, in the CFG,
  //    by wherever the other arm leaves the loop from.
  //  - In a tested loop: only where the CFG join `cfgJoin` leaves the body, `b` is a body block,
  //    and every way out of the body from `b` is one the loop renders in place
  //    (`leavesByOwnedEdges`). A CFG join inside the body is the statement's own. No CFG join at
  //    all counts as leaving the body only where the caller says so (`noJoinLeaves`): the `switch`,
  //    whose arms that `return` each keep a `ret` of their own; the `if` reads none as divergent
  //    arms, which need no join.
  // What each statement adds on top is its own: the `if` defers to `clampToLoop` and asks only
  // where one successor stays in the body; the `switch` asks only where its own readings fail.
  const inLoopJoin = (b: Block, cfgJoin: Block | null, noJoinLeaves = false): Block | null | undefined => {
    const frame = loopCtx;
    if (frame === null || frame.breakArms?.some((a) => a.region.has(b)) === true) {
      return undefined;
    }
    const forever = foreverLoops.get(frame.header);
    if (forever !== undefined) {
      return loopJoin(forever, b, true);
    }
    return (cfgJoin !== null ? !frame.body.has(cfgJoin) : noJoinLeaves) &&
      frame.body.has(b) &&
      leavesByOwnedEdges(frame, b)
      ? loopJoin(frame, b, false)
      : undefined;
  };
  // THE JOIN OF A BRANCH IN A LOOP BODY, over the body with its back edges and exits deleted: where
  // the paths from `b` that stay in the body meet, its nearest post-dominator over the rest. Null
  // when none goes on, and the region's own `stop` ends it. Without the deletion, a branch whose one
  // arm continues joins at the loop bottom, and whatever the other arm runs before its own continue
  // is copied into both arms; in a tested loop, the `else break;` of an if/else-if chain joins at
  // the loop's exit.
  //
  // `endsCut` is the `while (1)` rule, and only `emitForever`'s frames take it: a block that only
  // jumps back to the header or out of the loop, rendering nothing but that edge's copies, ENDS its
  // path — a `continue`, a `break` — so it constrains no join either. A block that ends every path
  // but TESTS first is still where its predecessors meet, and so is a latch two body paths reach: the
  // foot of `for (…) { if (c) {…} }`, where deleting it moves the `if`'s join into one arm, which then
  // copies the latch and adds a `continue` the source never wrote. A break block two paths share
  // stays an end, each path its own `break`. A tested loop's latch is where its test renders, so
  // there it constrains the join like any block.
  /** per header, one cache for each value of `endsCut` */
  const loopJoins = [new Map<Block, Map<Block, Block | null>>(), new Map<Block, Map<Block, Block | null>>()];
  const loopJoin = (loop: { header: Block; body: Set<Block> }, b: Block, endsCut: boolean): Block | null => {
    const cache = loopJoins[endsCut ? 1 : 0];
    let ipdom = cache.get(loop.header);
    if (ipdom === undefined) {
      ipdom = regionJoins(loop.body, loop.header, endsCut);
      cache.set(loop.header, ipdom);
    }
    return ipdom.get(b) ?? null;
  };
  // The post-dominators `loopJoin` reads, over `body` with every edge out of it and every edge back
  // to `header` (when there is one) deleted — save an edge to `toExit`, which goes to EXIT. Also
  // the join inside a switch arm (`armJoin`), whose `toExit` is the sibling a falling arm runs into
  // and null for a closed one.
  function regionJoins(
    body: ReadonlySet<Block>,
    header: Block | null,
    endsCut: boolean,
    toExit: Block | null = null,
  ): Map<Block, Block | null> {
    const inBody = (n: Block): Block[] => [...new Set(successorsOf(n))].filter((x) => body.has(x) && x !== header);
    const ends = (n: Block): boolean =>
      endsCut &&
      inBody(n).length === 0 &&
      n.ops[n.ops.length - 1].opcode === 'br' &&
      n.ops.every((op) => !effectful(op) && !materialize.has(op)) &&
      !(successorsOf(n)[0] === header && new Set(preds.get(n)?.filter((q) => body.has(q))).size > 1);
    const exits = (n: Block): boolean => toExit !== null && successorsOf(n).includes(toExit);
    // IN A FALLING ARM, A PATH THAT CANNOT FALL ENDS WHERE IT LEAVES THE FALLING PATHS. Deleting the
    // edge to the merge or a `ret` covers only a jump straight off the branch (`if (b) break;`).
    // When the leaving path runs code first — `if (b) { g(7); break; }`, or a `return k` through a
    // shared epilogue — its block keeps no edge on, and a block with none is post-dominated only by
    // itself, so the guard above it would find no join and copy the rest of the arm into both sides.
    // Such a block is a jump all the same: an edge into a block that can no longer reach the
    // fall-through is deleted too.
    let falls: Set<Block> | null = null;
    if (toExit !== null) {
      const live = new Set<Block>();
      for (let grew = true; grew;) {
        grew = false;
        for (const n of body) {
          if (!live.has(n) && (exits(n) || inBody(n).some((x) => live.has(x) && !ends(x)))) {
            live.add(n);
            grew = true;
          }
        }
      }
      falls = live;
    }
    const onward = (n: Block): Block[] => inBody(n).filter((x) => !ends(x) && (falls === null || falls.has(x)));
    // A CYCLE NO PATH LEAVES. An inner loop at the foot of the body — the vblank wait closing a
    // `while (1)` main loop, `while (q() == 3);` — keeps only its own back edge once the edges
    // to the header and to the ends are deleted, so its paths never end and post-dominance
    // over it is undefined: no branch above it would find a join, and each would re-emit the rest
    // of the body, doubling per `if`. Such a block ends its path at the edge it leaves the cycle
    // by. A block that reaches an end keeps its edges as they are, so no defined join moves.
    const reachesEnd = new Set<Block>();
    for (let grew = true; grew;) {
      grew = false;
      for (const n of body) {
        if (!reachesEnd.has(n) && (onward(n).length === 0 || exits(n) || onward(n).some((x) => reachesEnd.has(x)))) {
          reachesEnd.add(n);
          grew = true;
        }
      }
    }
    return postDominators(fn, body, (n) =>
      !exits(n) && (reachesEnd.has(n) || successorsOf(n).every((x) => onward(n).includes(x)))
        ? onward(n)
        : [...onward(n), null],
    );
  }

  // Does rendering `root` under `map` re-derive one of `targets`: reach it through the def tree
  // without passing a mapped or a named value, either of which renders as a name?
  const rendersThrough = (
    root: Value,
    map: ReadonlyMap<Value, string> | null,
    targets: ReadonlySet<Value>,
  ): boolean => {
    const seen = new Set<Value>();
    const walk = (x: Value): boolean => {
      if (seen.has(x) || map?.has(x) === true || varName.has(x)) {
        return false;
      }
      if (targets.has(x)) {
        return true;
      }
      seen.add(x);
      return defs.get(x)?.operands.some(walk) ?? false;
    };
    return walk(root);
  };
  // What a loop's exit region renders after the loop, before `stop`, and the values it reads.
  const exitRegion = (exit: Block, loopBody: ReadonlySet<Block>, stop: Block | null): Set<Block> => {
    const region = new Set<Block>();
    for (const work = [exit]; work.length > 0;) {
      const x = work.pop()!;
      if (x !== stop && !loopBody.has(x) && !region.has(x)) {
        region.add(x);
        work.push(...successorsOf(x));
      }
    }
    return region;
  };
  const rootsOf = (region: Iterable<Block>): Value[] =>
    [...region].flatMap((x) => x.ops.flatMap((op) => [...op.operands, ...op.successors.flatMap((sc) => sc.args)]));

  // A `break` of the loop whose body `ss` is — not of a loop or `switch` inside it.
  const breaksOut = (ss: Stmt[]): boolean =>
    ss.some((s) => s.k === 'break' || (!isLoop(s) && s.k !== 'switch' && breaksOut(stmtChildren(s))));
  // `while (1) { body }`: the header structured as an ordinary block up to itself (its do-while-style
  // hook masked via dwActive), under a frame whose breaks leave for `exit`, which renders after it.
  // Where no edge out rendered as a `break` — each one an early `return`, the exit's tail copied
  // into it — nothing reaches the end of the loop, and the exit rendered after it would be a dead
  // second copy of that tail.
  //
  // The exit region runs after every break, so an inner loop that runs before each of them has left
  // its last value in its variable's name, and the region reads it there (`latchInnerSub`, with the
  // breaks as its readers). Read raw it would re-derive that value from the name that holds it. Where
  // neither reading is the value, decline LOUD, as the do-while latch does.
  //
  // A TWO-LEVEL EXIT (`TwoLevelExit`) adds its flag: cleared ahead of the loop, so every entry
  // starts it clear, and read once after it, where the code from `exit` up to the second target
  // runs only if the loop left by its own exit. The second target and what follows render after
  // that `if`, once, for both ways out. An OUTWARD one is read at once, `if (f != 0) break;`, which
  // leaves the enclosing loop ahead of all the code between the two loops; in a case body that
  // `break;` leaves the switch, and the switch hands the flag on (`handedThroughSwitch`).
  //
  // Where the region holding the loop ends before the second target (`stop` among the skipped
  // code) and that target is the merge of the switch arm the loop sits in, a `break;` after the
  // loop reaches it (`switchBreaks`): the flag reads `if (f != 0) break;`, and the skipped code
  // renders after it up to `stop`, where the region's owner renders the rest. That `stop` is a
  // zero-trip guard's join at the loop's exit (`case 1: for (j…) { if (hit) goto out; } k(i); out:
  // break;`, where `armJoin` takes the hit's edge to the merge for a `break;` and the guard joins at
  // `k(i)`), or the sibling a falling arm runs into (agbcc cross-jumps a post-loop `k(i)` into
  // `case 3: k(i); break;`). Refused, loud, where no `break;` reaches the target
  // (`TWO_LEVEL_REGION_GATES`): the code from the second target on would render past the end of the
  // region, and the region's owner renders it again. That copy is not a proven wrong (where it ends
  // in a `return`, `break` or `continue` it lifts correct); the refusal stays until a reading proves
  // it never falls through into the owner's. Paths from `exit` that pass `to` without meeting it
  // (`if (q) goto Z; … to: …; Z:`) are not refused: they render inside the `if` and again after it,
  // each copy ending in a jump.
  // THE LOOP AS A `for`. `while (1)` writes a latch that runs the update and the test as `if (!c)
  // break; i++;` at the foot of the body, where nothing but the body's own end reaches it. C has one
  // loop whose `continue;` runs an update before the test, `for (init; cond; inc)`, and only it
  // spells a body that reaches the latch from inside a jump table whose other arms leave the loop:
  // `switch (..) { case 1: if (c) continue; k(); break; default: continue; } break;`. Every arm then
  // ends the switch at the loop's exit, and `break;` after the switch leaves the loop. agbcc and gcc
  // 2.7.2 compile that source to a guard, the body and a latch `i++; if (i <= n) goto top`, the same
  // bytes as `if (i <= n) do { .. } while (++i <= n)` only where no `continue` exists — so the guard
  // is the `for`'s own first test, and the reading drops it.
  //
  // Where the first test is constant, the compiler folds it away and leaves no guard: `for (i = 0;
  // i < 40; i++)` enters its body at once, from a block `g` that ends in a `br` to the header. That
  // entry is the `for`'s too where the test, read on the entry values, provably stays in.
  //
  // Taken only for a loop the rerun asks (`ForRanking`), or for every loop under `/for-continue`
  // (`spellCountedLoopsFor`), from the block `g` that enters it — a guard or a plain `br` — and
  // refused (null) unless every part of the `for` is the asm's, read where the `for` reads it:
  //   • `g` branches only to the header and the exit, or only to the header, and is the header's one
  //     way in beside the one latch, which branches only to the header and the exit. `g`'s way to
  //     the exit may pass a RELAY, a block whose one op jumps there and that nothing else reaches:
  //     agbcc writes `ble .LCB; b .L4 @long jump` (or `bl .L4 @far jump`) where the exit is past a
  //     Thumb conditional branch's range, and that `b` is the same edge, carrying the exit's args
  //     where it takes params;
  //   • the latch takes no params: no edge into it carries a copy;
  //   • the exit's params are written where the asm writes them. A `break` writes its edge's
  //     copies ahead of it, as `while (1)`'s does; the two edges the test leaves by — the guard's
  //     and the latch's — are never rendered, so each must hand the exit what the `for` already
  //     left in the param's name: a name the `for` does not write, holding the arg already (an
  //     identity, or a write anchored at its def), or a name its init (ahead of the first test,
  //     with the preheader's statements) or its update (ahead of every other) writes with that
  //     same arg. So flags set ahead of the loop and rewritten in an arm (`a = 0; for (..) { ..
  //     a = 1; break; } k(a);`) lift, and so does `k(i)` past the loop where the exit param is the
  //     IV's name; a slot read under a name the `for` rewrites does not (`for (..) { last = i; ..
  //     } k(last);`, whose latch hands the exit `i` from before its update and whose guard hands
  //     `-1`, under the IV's name). A latch op the latch's edge hands under its own name is written
  //     nowhere, the latch never being rendered. Past a loop with no guard, which the header
  //     dominates, the code may read the IV's param with no exit param between: that is the IV
  //     from before the update on the latch's way out, and the `for` has updated it, so it refuses;
  //   • the latch is never rendered, so it holds no effect, no qualified access, no anchored def and
  //     no named def read outside the latch — a named op the latch alone reads is spelled inline (A
  //     STRENGTH-REDUCED COUNTED LOOP), and one read past it (only where the latch dominates that
  //     read: no guard and no `break`) would be written nowhere — and what its
  //     test and update read is its own ops over the header's params and values from outside the
  //     loop, since the `for` evaluates them after the update and, the first time, before the body.
  //     A back-edge value the header computes from those by pure ops is the update's too (agbcc
  //     keeps `i + 1` from a body that reads it, and the latch hands that register round): the
  //     update runs after the header did on every path, and the test reads it only as the variable
  //     it updates;
  //   • the update is ONE copy, `inc`, and `g`'s copies into the header name that variable with a
  //     value that reads no other copy's name, `init`; the rest precede the `for`;
  //   • the test reads no variable the update writes except through its back-edge value, and no
  //     inner loop's value (`latchInnerSub`);
  //   • a guard's condition is the test read on the loop's entry values (`sameAtEntry`), a load on
  //     either side read through only where it is evaluated at the test; with no guard, that test
  //     folds to a constant that stays in the loop.
  //
  // A STRENGTH-REDUCED COUNTED LOOP (gcc 2.7.2's `for (i = lo; i <= hi; i++) … gE[i] …`) needs three
  // more readings, read like the rest (taken where asked, offered otherwise):
  //   • `pre`, a PURE PREHEADER between the guard and the header: a `br` into the header that only
  //     the guard enters, whose ops neither touch memory nor trap. Its statements run ahead of the
  //     `for`, so on the zero-trip path too: every value read past the loop directly is live across
  //     the preheader and holds a name of its own, and an exit param whose name a preheader
  //     statement writes is refused as one the init writes;
  //   • an IV whose init edge carries no copy, the name already holding the entry value (`a0`,
  //     the parameter itself): the `for` writes the identity `a0 = a0`, which C prints `for (;`;
  //   • a materialized latch op whose every use is in the latch (`i + 1`, named because the back
  //     edge's copies read it twice): the `for` never renders the latch, so the test and the update
  //     spell it inline.
  // The header's `i << 3` beside `i` (a DERIVED IV) is no reading of this one: raise/unpre.ts's
  // `recomputeDerivedParams` reads that param as the op of `i` it is at every entry, before the
  // structurer runs, so the header carries the IV alone and its test may read the op as it reads any.
  //
  // The rules are tables: `FOR_PLAN_GATES` past the loop's shape, `FOR_PLAN_IV_GATES` over the
  // copies; each table's doc comment names what it leaves out.
  type ForPlan = { latch: Block; inits: Stmt[]; init: Stmt; cond: Expr; inc: Stmt };
  const forPlanAt = (g: Block, fl: ForeverLoopInfo, pre?: Block): ForPlan | null => {
    const h = fl.header;
    const exit = fl.exit;
    const latch = fl.latches.length === 1 ? fl.latches[0] : undefined;
    const entry = pre ?? g;
    const gterm = g.ops[g.ops.length - 1];
    const lterm = latch?.ops[latch.ops.length - 1];
    // `b`, or the exit where `b` is a relay into it that only `g` enters
    const relayed = (b: Block): Block => {
      const t = b.ops[0];
      const from = preds.get(b) ?? [];
      return b !== exit &&
        exit !== null &&
        b.params.length === 0 &&
        b.ops.length === 1 &&
        t.opcode === 'br' &&
        t.successors[0]?.block === exit &&
        from.length > 0 &&
        from.every((p) => p === g)
        ? exit
        : b;
    };
    const onlyTo = (t: Op | undefined, via: (b: Block) => Block = (b) => b, into: Block = h): boolean =>
      t?.opcode === 'cond_br' &&
      t.successors.length === 2 &&
      t.successors.some((sc) => sc.block === into) &&
      t.successors.some((sc) => via(sc.block) === exit);
    const guarded = gterm.opcode === 'cond_br';
    // no effect, no memory, no order, no qualifier; a trap is asked on its own (`preheader-traps`)
    const effectFree = (o: Op): boolean => !effectful(o) && !orderSensitive(o) && !qualified(o);
    const traps = (o: Op): boolean => opSig(o.opcode)?.traps === true;
    // THE LOOP'S SHAPE, which every rule of `FOR_PLAN_GATES` reads: not a rule of the table (see its
    // doc comment). A preheader is offered only from a guard, as a `br` into the header.
    const preTerm = pre?.ops[pre.ops.length - 1];
    if (
      exit === null ||
      latch === undefined ||
      latch === h ||
      fl.body.has(g) ||
      (pre !== undefined && (!guarded || preTerm!.opcode !== 'br' || preTerm!.successors[0]?.block !== h)) ||
      !(guarded ? onlyTo(gterm, relayed, pre ?? h) : gterm.opcode === 'br' && gterm.successors[0]?.block === h) ||
      !onlyTo(lterm) ||
      new Set(preds.get(h) ?? []).size !== 2 ||
      !(preds.get(h) ?? []).every((p) => p === entry || p === latch)
    ) {
      return null;
    }
    const back = successorTo(latch, h)!;
    const backArgs = new Set<Value>(back.args);
    // `pure`: below a back-edge value the header computes, where only pure ops may be read
    const closed = (v: Value, pure = false, seen = new Set<Value>()): boolean => {
      if (seen.has(v)) {
        return true;
      }
      seen.add(v);
      const d = defs.get(v);
      const at = d === undefined ? paramBlock.get(v) : opBlock.get(d);
      if (at === undefined || !fl.body.has(at) || (d === undefined && at === h)) {
        return true;
      }
      if (d === undefined || (pure && (effectful(d) || orderSensitive(d)))) {
        return false;
      }
      const inHeader = at === h && (pure || backArgs.has(v)) && !effectful(d) && !orderSensitive(d);
      return (at === latch || inHeader) && d.operands.every((o) => closed(o, pure || inHeader, seen));
    };
    const cond = lterm!.operands[0];
    const preOps = pre?.ops.slice(0, -1) ?? [];
    const latchOps = latch.ops.slice(0, -1);
    if (
      firstRejection(hooks.forPlanGates ?? FOR_PLAN_GATES, {
        get preheaderParams() {
          return (pre?.params.length ?? 0) > 0;
        },
        get preheaderSecondWayIn() {
          return pre !== undefined && !(preds.get(pre) ?? []).every((p) => p === g);
        },
        get preheaderEffect() {
          return preOps.some((o) => !effectFree(o));
        },
        get preheaderTraps() {
          return preOps.some(traps);
        },
        get preheaderAnchored() {
          return preOps.some((o) => anchoredAt.has(o));
        },
        get latchParams() {
          return latch.params.length > 0;
        },
        get latchEffect() {
          return latchOps.some((o) => effectful(o) || qualified(o));
        },
        get latchNamedOutside() {
          // every use of a latch op is in the latch, the back edge's args included
          return latchOps.some(
            (o) =>
              materialize.has(o) && !o.results.every((r) => (useSitesOf.get(r) ?? []).every((s) => s.blk === latch)),
          );
        },
        get latchAnchored() {
          return latchOps.some((o) => anchoredAt.has(o));
        },
        get testReadsBody() {
          return !closed(cond);
        },
        get updateReadsBody() {
          return !back.args.every((a) => closed(a));
        },
      }) !== null
    ) {
      return null;
    }
    const initEdge = successorTo(entry, h)!;
    // A loop no run asked for is spelled `for` only under `/for-continue`, and a structuring without it
    // reports that it met one — only once every check has passed, just ahead of the copies it would
    // emit, so the report is exact: a loop the `for` refuses anyway is never offered. Those
    // checks read the update's and the init's copies, whose spelling can push a gap or refuse; read
    // for a loop that is only being offered, that is undone, so the structuring that reports it keeps
    // exactly the outcome it had before it asked.
    const offered = !spellCountedLoopsFor && !forRank.asked.has(h);
    const auditMark = droppedUndefCopies.length;
    const gapMark = strictGaps.length;
    let updateRecs: ReturnType<typeof edgeCopyRecords>;
    let initRecs: ReturnType<typeof edgeCopyRecords>;
    try {
      updateRecs = edgeCopyRecords(latch, back);
      initRecs = edgeCopyRecords(entry, initEdge);
    } catch (e) {
      if (offered && e instanceof StructureError) {
        return null;
      }
      throw e;
    } finally {
      droppedUndefCopies.length = auditMark;
      if (offered) {
        strictGaps.length = gapMark;
      }
    }
    // the update is ONE copy: not a rule of `FOR_PLAN_IV_GATES`, which every one of its fields reads
    if (updateRecs.length !== 1) {
      return null;
    }
    const iv = updateRecs[0].name;
    const ivInit = initRecs.find((r) => r.name === iv);
    const sub = subFor(h.params, back.args as Value[]);
    // The plain reading renders the latch's copies and test as `argAssigns` and `exprWith` do. A
    // latch may hold a materialized op its own reads alone use, which the `for` never
    // renders at its position, so its test and update spell every latch op inline, and the test is
    // checked through them for a read of the name the update writes.
    const inlined = latch.ops.some((o) => materialize.has(o));
    const clobbered = (v: Value, seen = new Set<Value>()): boolean => {
      const d = defs.get(v);
      if (!inlined || sub.has(v) || d === undefined || opBlock.get(d) !== latch) {
        return readsClobbered(v, sub, new Set([iv]));
      }
      if (seen.has(v)) {
        return false;
      }
      seen.add(v);
      return d.operands.some((o) => clobbered(o, seen));
    };
    const entryVals = new Map<Value, Value>();
    h.params.forEach((p, i) => entryVals.set(p, initEdge.args[i] as Value));
    h.params.forEach((_, i) => entryVals.set(back.args[i] as Value, initEdge.args[i] as Value));
    const atTest = (v: Value): boolean => {
      const d = defs.get(v);
      if (d === undefined || !orderSensitive(d)) {
        return true;
      }
      const at = opBlock.get(d);
      return at === latch || (at === g && !g.ops.slice(opIndex.get(d)! + 1).some(effectful));
    };
    const contIsTaken = lterm!.successors[0].block === h;
    // the test on the entry values, where it folds: each leaf a constant, each op one `evalIntPair` reads
    const atEntry = (v0: Value): number | null => {
      const v = entryVals.get(v0) ?? v0;
      const d = defs.get(v);
      if (d === undefined || intWidth(v.type) !== 32) {
        return null;
      }
      if (d.opcode === 'const') {
        return typeof d.attrs.value === 'number' ? d.attrs.value | 0 : null;
      }
      if (!isIntPairOpcode(d.opcode) || d.operands.length !== 2) {
        return null;
      }
      const [x, y] = [atEntry(d.operands[0]), atEntry(d.operands[1])];
      return x === null || y === null ? null : evalIntPair(d.opcode, x, y);
    };
    // THE TWO EDGES THE TEST LEAVES BY (THE LOOP AS A `for`): the guard's, through its relay, and
    // the latch's. Each slot either holds already (the exit param's name is the arg's, or a write
    // anchored at its def made it), or is a copy the edge makes. The `for` runs its init ahead of
    // the first test and its update ahead of every other, and renders neither edge: a slot holds
    // where that run leaves the name holding the arg, which is a name it never writes holding
    // already, or a name it writes with that same arg.
    const guardExit = ((): { pred: Block; succ: Successor } | null => {
      const sc = guarded ? gterm.successors.find((x) => x.block !== (pre ?? h)) : undefined;
      if (sc === undefined) {
        return null;
      }
      return sc.block === exit ? { pred: g, succ: sc } : { pred: sc.block, succ: sc.block.ops[0].successors[0] };
    })();
    const initWrites = new Map<string, Value | null>(initRecs.map((r) => [r.name, r.arg]));
    for (const o of preOps) {
      for (const r of o.results) {
        const nm = varName.get(r);
        if (nm !== undefined && !initWrites.has(nm)) {
          initWrites.set(nm, null); // a preheader statement, which writes no exit arg
        }
      }
    }
    const exitSlots = (pred: Block, succ: Successor, writes: ReadonlyMap<string, Value | null>): string[] => {
      const suppressed = suppressedArgs.get(succ);
      return exit.params.flatMap((p, i) => {
        const name = varName.get(p)!;
        const arg = succ.args[i];
        const carried = suppressed?.has(i) !== true && varName.get(arg) !== name;
        if (writes.has(name)) {
          return writes.get(name) === arg ? [] : [carried ? 'copy' : 'rewritten'];
        }
        if (carried) {
          return ['copy'];
        }
        // a latch op the `for` never renders: its name is written nowhere
        const d = defs.get(arg);
        return pred === latch && d !== undefined && opBlock.get(d) === latch ? ['rewritten'] : [];
      });
    };
    // Past a loop with no guard the header dominates the exit, so the code there may read the IV's
    // param itself, not through an exit param: the asm's value from before the update on the
    // latch's way out, which the `for`'s update has rewritten. A named value holds its own.
    const ivParam = updateRecs[0].param;
    const readsIv = (v: Value, seen = new Set<Value>()): boolean => {
      if (v === ivParam) {
        return true;
      }
      if (seen.has(v) || varName.has(v)) {
        return false;
      }
      seen.add(v);
      return defs.get(v)?.operands.some((o) => readsIv(o, seen)) ?? false;
    };
    let exitFindings: string[] | undefined;
    const exitFound = (what: string): boolean => {
      exitFindings ??= [
        ...(guardExit === null ? [] : exitSlots(guardExit.pred, guardExit.succ, initWrites)),
        ...exitSlots(latch, successorTo(latch, exit)!, new Map([[iv, updateRecs[0].arg]])),
        ...(rootsOf(exitRegion(exit, fl.body, null)).some((r) => readsIv(r)) ? ['rewritten'] : []),
      ];
      return exitFindings.includes(what);
    };
    // not in `FOR_PLAN_IV_GATES` (its doc comment says why)
    const inner = latchInnerSub(h, fl.body, [latch]);
    if (
      copySetIsCyclic(initRecs) ||
      (ivInit !== undefined && initRecs.some((r) => r !== ivInit && exprVars(ivInit.value).has(r.name))) ||
      inner.sub.size > 0 ||
      inner.unreadable.size > 0
    ) {
      return null;
    }
    if (
      firstRejection(hooks.forPlanIvGates ?? FOR_PLAN_IV_GATES, {
        get testReadsUpdate() {
          return clobbered(cond);
        },
        get entryTestDiffers() {
          if (guarded) {
            const enterIsTaken = gterm.successors[0].block === (pre ?? h);
            return !sameAtEntry(cond, gterm.operands[0], entryVals, enterIsTaken !== contIsTaken, atTest);
          }
          const first = atEntry(cond);
          return first === null || (first !== 0) !== contIsTaken;
        },
        get exitCopy() {
          return exitFound('copy');
        },
        get exitNameRewritten() {
          return exitFound('rewritten');
        },
      }) !== null
    ) {
      return null;
    }
    if (offered) {
      hooks.onForOffered?.();
      return null;
    }
    const latchExpr = (s: Map<Value, string> | null) => {
      const base = s === null ? expr : exprWith(s);
      const e = (v: Value): Expr => {
        const d = defs.get(v);
        return d !== undefined && opBlock.get(d) === latch && s?.has(v) !== true ? lowerDef(d, e) : base(v);
      };
      return e;
    };
    const [inc] = inlined
      ? [{ k: 'assign' as const, name: iv, value: intoDeclaredTemp(iv, latchExpr(null)(updateRecs[0].arg)) }]
      : argAssigns(latch, h);
    const inits = [...(pre !== undefined ? sideEffects(pre) : []), ...argAssigns(entry, h)];
    const init: Stmt | undefined =
      ivInit === undefined
        ? { k: 'assign', name: iv, value: { k: 'var', name: iv } }
        : inits.find((st) => st.k === 'assign' && st.name === iv);
    if (inc?.k !== 'assign' || init === undefined) {
      throw new StructureError(
        `cannot structure '${fn.name}': the \`for\` at block #${fn.blocks.indexOf(h)} lost its update or its init copy`,
      );
    }
    const test = (inlined ? latchExpr(sub) : exprWith(sub))(cond);
    return {
      latch,
      inits: inits.filter((st) => st !== init),
      init,
      cond: contIsTaken ? test : negateCond(test),
      inc,
    };
  };
  const emitForever = (fl: ForeverLoopInfo, stop: Block | null, asFor?: ForPlan): Stmt[] => {
    // an outward exit is handed out to the loop this one sits in, which must be the enclosing loop
    // that took it (`handed`); in a case body opened in it, through that one switch
    // (`handedThroughSwitch`), never through a switch in a switch. Only the switch-in-switch test
    // decides anything; the rest is DEFENSIVE: AN OUTWARD EXIT TAKES BOTH LOOPS OR NEITHER settles
    // `enclosing` and `handed` before emission, and every switch arm's frame is pushed inside
    // `withSwitchFlags`, so its `flags` is never null.
    const enclosing = fl.twoLevel?.outward === true ? loopCtx : null;
    const through = switchFrames.filter((f) => f.loop === enclosing);
    if (
      fl.twoLevel?.outward === true &&
      (enclosing === null ||
        foreverLoops.get(enclosing.header)?.handed?.has(fl.header) !== true ||
        through.length > 1 ||
        through.some((f) => f.flags === null))
    ) {
      throw new StructureError(
        `cannot structure '${fn.name}': a two-level exit out of the loop at block #${fn.blocks.indexOf(fl.header)} ` +
          `leaves the enclosing loop from where a \`break\` cannot reach its exit`,
      );
    }
    dwActive.add(fl.header);
    const frame = {
      header: fl.header,
      exit: fl.exit,
      body: fl.body,
      arms: fl.arms,
      breaks: fl.breaks,
      breakArms: fl.breakArms,
      ...(fl.twoLevel !== undefined ? { twoLevel: fl.twoLevel } : {}),
      ...(enclosing !== null ? { enclosing } : {}),
      ...(asFor !== undefined ? { forLatch: asFor.latch } : {}),
    };
    // a `for`'s body ends at its latch, and its jumps are refused from any loop nested inside
    const jumps = asFor === undefined ? [] : [asFor.latch, fl.exit!].filter((x) => !forJumps.has(x));
    jumps.forEach((x) => forJumps.add(x));
    let body: Stmt[];
    try {
      body = withLoop(frame, () => structureBlock(fl.header, asFor?.latch ?? fl.header));
    } finally {
      jumps.forEach((x) => forJumps.delete(x));
    }
    dwActive.delete(fl.header);
    const loop: Stmt =
      asFor === undefined
        ? { k: 'while', cond: { k: 'const', value: 1 }, body }
        : { k: 'for', init: asFor.init, cond: asFor.cond, inc: asFor.inc, body };
    const exit = fl.exit;
    if (asFor !== undefined) {
      return [...asFor.inits, ...emitForeverExit(fl, stop, exit!, loop, through)];
    }
    if (exit === null || !breaksOut(body)) {
      return [loop];
    }
    return emitForeverExit(fl, stop, exit, loop, through);
  };
  // The code after a `while (1)` (or its `for`, `ForPlan`) that leaves to `exit`, and the flag of a
  // two-level exit out of it.
  const emitForeverExit = (
    fl: ForeverLoopInfo,
    stop: Block | null,
    exit: Block,
    loop: Stmt,
    through: SwitchFrame[],
  ): Stmt[] => {
    const region = exitRegion(exit, fl.body, stop);
    const { sub: innerSub, unreadable } = latchInnerSub(fl.header, fl.body, [...fl.breaks], region);
    if (unreadable.size > 0 && rootsOf(region).some((r) => rendersThrough(r, innerSub, unreadable))) {
      throw new StructureError(
        `cannot structure '${fn.name}': the code after a while (1) reads an inner loop's value whose name was ` +
          `rewritten after the inner loop, and re-deriving it reads a name the inner loop wrote`,
      );
    }
    const after = (run: () => Stmt[]): Stmt[] => (innerSub.size > 0 ? withSub(innerSub, run) : run());
    const second = fl.twoLevel;
    if (second === undefined) {
      return [loop, ...after(() => structureRegion(exit, stop))];
    }
    if (second.outward === true) {
      const flag = twoLevelFlag(fl.header);
      through[0]?.flags!.add(flag);
      return [
        { k: 'assign', name: flag, value: { k: 'const', value: 0 } },
        loop,
        breakOnFlag(flag, through.length > 0),
        ...after(() => structureRegion(exit, stop)),
      ];
    }
    const skipped = twoLevelSkip(exit, second.to);
    const skipsRegionEnd = skipped !== null && stop !== null && skipped.has(stop);
    const breakReachesTarget = switchBreaks(second.to);
    if (
      skipped === null ||
      firstRejection(hooks.twoLevelRegionGates ?? TWO_LEVEL_REGION_GATES, { skipsRegionEnd, breakReachesTarget }) !==
        null
    ) {
      throw new StructureError(
        `cannot structure '${fn.name}': a two-level exit out of the loop at block #${fn.blocks.indexOf(fl.header)} ` +
          `skips the end of the region the loop sits in`,
      );
    }
    const flag = twoLevelFlag(fl.header);
    if (skipsRegionEnd && breakReachesTarget) {
      return [
        { k: 'assign', name: flag, value: { k: 'const', value: 0 } },
        loop,
        breakOnFlag(flag, true),
        ...after(() => structureRegion(exit, stop)),
      ];
    }
    return [
      { k: 'assign', name: flag, value: { k: 'const', value: 0 } },
      loop,
      mkIf(
        { k: 'bin', op: '==', l: { k: 'var', name: flag }, r: { k: 'const', value: 0 } },
        after(() => structureRegion(exit, second.to)),
        [],
      ),
      ...after(() => structureRegion(second.to, stop)),
    ];
  };
  // The flag of the two-level exit out of the loop at `header`: one `s32` local per loop, named on
  // first use, after the naming walk. Declared only where the body still mentions it
  // (`localNames`), so a reading structured and then dropped declares nothing.
  const twoLevelFlags = new Map<Block, string>();
  const twoLevelFlag = (header: Block): string => {
    let name = twoLevelFlags.get(header);
    if (name === undefined) {
      name = `v${fresh++}`;
      varType.set(name, T.s(32));
      twoLevelFlags.set(header, name);
    }
    return name;
  };

  // The latch back-edge substitution (do-while) — subFor over the latch's back-edge args.
  const latchSub = (dw: DoWhileInfo): Map<Value, string> =>
    subFor(dw.header.params, successorTo(dw.latch, dw.header)!.args);

  // THE LATCH IS POST-LOOP FOR EVERY INNER LOOP THAT RUNS BEFORE IT. A bottom-tested loop renders
  // its latch — side effects, update copies, test — HERE, outside the body region, so none of it is
  // under the substitution an inner loop's exit region installs (`withSub` in the self-loop and
  // do-while emitters). Yet the latch runs after those inner loops exactly as the rest of their exit
  // region does, and the inner do-while's own hazard check judged it that way (its `postLoop` holds
  // every block outside the inner body). Read raw, an inner back-edge value is RE-DERIVED from the inner
  // variable's name — which by then already holds that value — so the latch counts the last
  // iteration twice: `a += gT[i][j] * 2` over a nest whose inner loop is one block emits
  // `do { … v4 = v4 + (v0 << 1); … } while (…); v2 = v4 + (v0 << 1);` — a silent wrong answer that
  // main's default candidate reaches on agbcc's own output (the `acc += a[i][j]` nest).
  //
  // So the latch reads such a value under the name its inner loop left it in: the back-edge
  // substitution of every loop INSIDE this one that dominates the latch and does not contain it.
  // Every depth, not only children: a grandchild's value reaches the latch raw whenever the loop
  // between them does not carry it (`for i { for j { s = j; for k { s += …; } } gO[i] = s; }` —
  // `latch-inner-sub.test.ts`'s `GRANDCHILD`, 64 of 64 inputs wrong when only children counted).
  // Where that middle loop DOES carry it, both loops map the value to the one name the carrying
  // shares, and the inner one wins. Dominating loops apply outermost first, so a later one wins, as
  // the nested `withSub`s do. A test-at-top `while` installs no substitution (its latch-computed
  // values never reach past its header exit), so it contributes nothing. Dominance is not a
  // soundness term — a value of a loop that does not dominate the latch cannot be read there — it
  // is what keeps the map EMPTY when no loop can hand the latch a value, and `emitDoWhile` then
  // spells every line as it did before the map existed.
  //
  // NARROWER THAN THE EXIT REGION'S `withSub`, in two ways:
  //   • only an UNNAMED value DEFINED INSIDE the inner loop. A named value renders under its own
  //     name, and one defined outside the loop (an entry value handed round the back edge
  //     unchanged) re-derives from operands the loop never wrote. The IR oracle found the second
  //     (generated seed 16501, `fz16501`): substituting an entry value `a1 - a1` by its inner name
  //     after the exit copy `v2 = v1` had rewritten it. That witness is held by EITHER narrowing
  //     (measured, dropping one at a time); this one also keeps the refusal below from judging
  //     values whose re-derivation the loop cannot have made stale;
  //   • only while the name still HOLDS it. A name written between the inner loop and the latch —
  //     a block param of the exit region, of an enclosing loop's header or of the latch itself, or
  //     a materialized def there — no longer holds the loop's last value, unless what it wrote IS
  //     that value (`aliasOf`: a merge every arm of which hands it the inner value,
  //     `IDENTITY_MERGE`). This loop's own header is exempt: its params are written by the update
  //     copies below, which read under this very substitution, and `enclosingCarrierName` hands
  //     an inner value exactly that name (`LATCH_SUM`, measured).
  //     Such an entry is not substituted, and then the latch re-derives it, which is right only if
  //     the re-derivation reads no name written after the value was computed — the inner loop's own
  //     and that stretch's. `unreadable` holds the ones for which it does: no spelling at the latch
  //     is that value, and `emitDoWhile` declines LOUD if a latch reader needs one. `T2_MERGE` and
  //     `T2_INVARIANT` in `latch-inner-sub.test.ts` are the two sides: a merge after the inner loop
  //     that took the inner name, with an inner value the raw reading re-derives wrong (neither
  //     reading is right) and right (the raw reading is). The refusal is per VALUE and per
  //     stretch, not per name: an entry another loop's substitution still covers (a middle loop
  //     that carries the grandchild's value under the name they share) is read through that one.
  //
  // `writtenAfter` is that set of names per entry, for the test's own refusal in `emitDoWhile`.
  // Does `w` hold `v` — `v` itself, or a block param every in-edge of which hands it `v` (or such a
  // param)? The write of a param like that stores what the name already held. A cycle of such
  // params is `v` too, which is why a revisit answers yes.
  const aliasOf = (w: Value, v: Value, seen: Set<Value>): boolean => {
    if (w === v || seen.has(w)) {
      return true;
    }
    seen.add(w);
    const b = paramBlock.get(w);
    if (b === undefined || b === entry) {
      return false;
    }
    const k = b.params.indexOf(w);
    const ins = [...inEdgeRecords(preds, b)];
    return ins.length > 0 && ins.every(({ succ }) => aliasOf(succ.args[k], v, seen));
  };
  // `readers` are the blocks the substitution is read after: the latch, or every block a `while (1)`
  // breaks from, whose exit region renders after the loop. `after` adds the blocks of that region,
  // whose writes land before some of its reads.
  const latchInnerSub = (
    header: Block,
    loopBody: ReadonlySet<Block>,
    readers: Block[],
    after: ReadonlySet<Block> = new Set(),
  ): { sub: Map<Value, string>; unreadable: Set<Value>; writtenAfter: Map<Value, Set<string>> } => {
    const out = new Map<Value, string>();
    const refused = new Set<Value>();
    const writtenAfter = new Map<Value, Set<string>>();
    const kids = [...forest.byHeader.values()]
      .filter(
        (l) =>
          l.header !== header &&
          loopBody.has(l.header) &&
          readers.every((r) => !l.body.has(r) && dom.get(r)!.has(l.header)),
      )
      .sort((x, y) => dom.get(x.header)!.size - dom.get(y.header)!.size);
    for (const l of kids) {
      const self = loops.get(l.header);
      const nested = doWhileLoops.get(l.header);
      const s = self ? loopSub(self) : nested ? latchSub(nested) : null;
      if (s === null) {
        continue;
      }
      const rewrittenBy = new Map<string, Value[]>();
      const written = new Set<string>();
      for (const [v, n] of varName) {
        const d = defs.get(v);
        const home = paramBlock.get(v) ?? (d !== undefined && materialize.has(d) ? opBlock.get(d) : undefined);
        if (home === undefined || !(loopBody.has(home) || after.has(home)) || home === header) {
          continue;
        }
        written.add(n);
        if (!l.body.has(home)) {
          rewrittenBy.set(n, [...(rewrittenBy.get(n) ?? []), v]);
        }
      }
      for (const [v, n] of s) {
        const d = defs.get(v);
        if (varName.has(v) || d === undefined || !l.body.has(opBlock.get(d)!)) {
          continue;
        }
        writtenAfter.set(v, written);
        if (rewrittenBy.get(n)?.some((w) => !aliasOf(w, v, new Set())) === true) {
          refused.add(v);
        } else {
          out.set(v, n);
        }
      }
    }
    const unreadable = new Set<Value>();
    for (const v of refused) {
      if (!out.has(v) && readsClobbered(v, out, writtenAfter.get(v)!)) {
        unreadable.add(v);
      }
    }
    return { sub: out, unreadable, writtenAfter };
  };

  // Bottom-test `do-while`: the body runs header..latch (structured, with `b`'s do-while hook masked
  // via dwActive), then the latch's own side-effects + the loop update; the latch's cond_br test is the
  // do-while condition, read under `latchSub` (post-update the params hold their next value). Polarity:
  // the loop-CONTINUE edge is the back-edge to the header; negate iff that is the FALL-THROUGH.
  const emitDoWhile = (dw: DoWhileInfo, stop: Block | null): Stmt[] => {
    // The bottom test and everything post-loop render under `latchSub` — the update copies have
    // ALREADY run by then, so a condition/exit-arg/escaped-value read of an updated loop variable
    // that does NOT go through a sub-mapped back-edge arg means the PRE-update value (the
    // `i++ < n` shape: `icmp %i, %n` reads the pre-increment %i) and would render as the
    // post-update name — one iteration off, silently. Same readsClobbered guard the early-exit
    // path applies; on a hazard, decline LOUD.
    const sub = latchSub(dw);
    // The inner loops' post-loop substitution the latch reads under (`latchInnerSub`). Empty — and
    // then every line below spells what it did before the substitution existed — unless an unnamed
    // value an inner loop computed could reach the latch.
    //
    // The update copies take it MERGED with `activeSub`. A map extends the ambient naming where it
    // renders (`exprWith`), but identity elision consults the map alone, so the merge is what drops
    // a copy that `activeSub` spells `n = n` rather than writing it. The two programs are the same,
    // and it is left conditional so an empty `innerSub` takes the map-less path.
    const { sub: innerSub, unreadable, writtenAfter } = latchInnerSub(dw.header, dw.body, [dw.latch]);
    const latchMap = innerSub.size > 0 ? new Map([...(activeSub ?? []), ...innerSub]) : null;
    const updates = argAssigns(dw.latch, dw.header, latchMap);
    const updateWrites = loopWriteSet(updates, dw.body, dw.header);
    const lterm = dw.latch.ops[dw.latch.ops.length - 1];
    // A DEFENSIVE GUARD, and the reason the sink stands down rather than repairing anything. A body
    // block's param that holds a LOOP VARIABLE's name makes the arm's copy into it a real write
    // partway through the body, and everything rendered after it reads the name RAW: the update,
    // the bottom test, the header's own ops, the latch's side effects. The pure-alias route to such
    // a name is closed (`alias-under-its-own-name`); a param may still take it through `varName`
    // once the header param is dead, and no fixture reaches that today, so this guard is defensive.
    //
    // The refusal is on the NAME, not on who reads it: the readers are every statement the loop
    // emits, which is not a set worth enumerating when the name alone is the whole signal.
    //
    // The emitted C can be wrong wherever this shape occurs, sink or no sink (the predicate is on
    // names, so it also holds on loops that emit correctly) — a naming-pipeline defect, not this
    // pass's, and repairing the exit copy does not touch it. What IS this pass's
    // is not to UNLOCK such a loop: with no sink these functions decline on the pre-update hazard,
    // so standing down keeps them loud rather than trading a decline for a silent wrong answer.
    const headerNames = new Set(dw.header.params.map((p) => varName.get(p)));
    const bodyRebinds = new Set<string>();
    for (const bb of dw.body) {
      if (bb === dw.header) {
        continue;
      }
      bb.params.forEach((pv, i) => {
        const n = varName.get(pv);
        if (n === undefined) {
          return;
        }
        // Only a copy that SURVIVES argAssigns' identity elision writes anything, so an edge whose
        // arg already carries the name does not count.
        for (const { succ } of inEdgeRecords(preds, bb)) {
          if (varName.get(succ.args[i]) !== n) {
            bodyRebinds.add(n);
          }
        }
      });
    }
    const rebindHazard = [...bodyRebinds].some((n) => headerNames.has(n));
    const exitArgs = (successorTo(dw.latch, dw.exit)?.args ?? []) as Value[];
    // A pre-update exit copy moves INSIDE the body, ahead of the update, where the loop variables
    // still hold their top-of-iteration values. No zero-trip seed here: a `do-while` always runs
    // its body, so any other predecessor of the exit is an ordinary edge some enclosing `if`
    // already emits.
    const sunk = rebindHazard
      ? new Map<number, Op | null>()
      : sinkablePreUpdateSlots(
          dw.header,
          dw.exit,
          exitArgs,
          dw.body,
          dw.latch,
          sub,
          updateWrites,
          hooks.preUpdateSinkGates ?? PREUPDATE_SINK_GATES,
        );
    // The post-loop region the escaped-value check judges: everything the loop does not emit itself.
    // An early-`return` arm the loop OWNS renders inside the body, ahead of the update, so a read of
    // a loop variable there is the pre-update value it wants — counting it as post-loop would decline
    // the loop for a hazard that cannot happen. Blocks the arm merely reaches are not `owned`, and stay
    // post-loop where the other path really does read them after the update — among them a tail the
    // loop's own exit path also runs (`exitTail`, at `earlyReturnArm`), which the arm writes a copy of
    // but does not own.
    const owned = new Set(dw.arms.flatMap((a) => [...a.owned]));
    const postLoop = new Set(fn.blocks.filter((bb) => !dw.body.has(bb) && !owned.has(bb)));
    // AN EFFECT THE RENDERED TEST MAY SKIP. `movedEffect` below says this about the exit copies; the
    // bottom test is the other place an effect can change how often it runs, and here it is the
    // `&&`/`||` that moves it rather than a copy: the right operand is evaluated only where the left
    // one let it be, while the asm's branch did not guard the op at all. Nothing can re-place it —
    // the connective is what the test IS — so decline LOUD, the same answer for the same reason.
    //
    // Asked of every `do-while`, not only of a folded one: the arm holds the same call whichever way
    // the counter is spelled.
    if (testSkipsAnEffect(lterm.operands[0], sub)) {
      throw new StructureError(
        `cannot structure '${fn.name}': the bottom test may evaluate an effect behind a '&&'/'||' ` +
          `that the asm ran on every iteration`,
      );
    }
    // The test's OWN pre-update read has a spelling the other two disjuncts do not: `n++` at the
    // leaf, with the update copy dropped from the foot of the body. Asked only where the test is
    // already a hazard, so a loop that structures today enumerates exactly the candidates it did.
    // The polarity is the one applied to `cond` below — the continue edge must be the taken one.
    const condAnswer = readsClobbered(lterm.operands[0], sub, updateWrites)
      ? preUpdateCondFold(
          lterm.operands[0],
          lterm.successors[1].block === dw.header,
          dw.header,
          successorTo(dw.latch, dw.header)?.args ?? [],
          exitArgs,
          dw.body,
          sub,
          updates,
          updateWrites,
        )
      : null;
    const condFold = condAnswer === null || 'refused' in condAnswer ? null : condAnswer;
    // A PRE-UPDATE HOME DOES NOT UNLOCK A LOOP whose variable's NAME a block after it also holds.
    // The exit region reads the loop's back-edge values under those names (`sub`), and such a
    // param's copies write the same name first — the merge naming's `carrier-live` sees live NAMED
    // values, not ones the substitution spells, so it does not refuse them. The spelling is wrong
    // wherever it occurs; it is the home's to keep from unlocking one, which without the name would
    // decline on this hazard.
    const homed = [...dw.body].some((bb) => bb.ops.some((o) => preUpdateHomes.has(o)));
    const sharesALoopName = homed && [...postLoop].some((bb) => bb.params.some((p) => headerNames.has(varName.get(p))));
    if (
      sharesALoopName ||
      loopUpdateHazard(
        lterm.operands[0],
        exitArgs.filter((_, j) => !sunk.has(j)),
        dw.body,
        sub,
        updateWrites,
        postLoop,
        condFold !== null,
      )
    ) {
      // Three reasons share this refusal — the test, an exit slot, an escaped body value — and the
      // one that was asked in detail names the gate that answered.
      throw new StructureError(
        `cannot structure '${fn.name}': do-while condition or a post-loop value reads a pre-update loop variable` +
          (condAnswer !== null && 'refused' in condAnswer
            ? ` (no '++' for the test's own read: ${condAnswer.refused})`
            : ''),
      );
    }
    // The exit copies render AFTER the `dowhile` statement, but the analysis judged where each
    // value they carry may inline as if the copies sat on the latch's terminator — INSIDE the loop.
    // For a pure def that is only a naming question (the pre-update guard above covers the rest);
    // for an EFFECTFUL one it moves the effect out of the loop: a call that ran once per iteration
    // would render once, after it. Nothing can re-place it here — `materialize` was decided before
    // emission — so decline LOUD rather than emit a plausible loop that calls the wrong number of
    // times.
    const movedEffect = exitArgs.find((v) => {
      const d = defs.get(v);
      return (
        d && REPEATED_EFFECT.has(d.opcode) && dw.body.has(opBlock.get(d)!) && !materialize.has(d) && !varName.has(v)
      );
    });
    if (movedEffect) {
      const d = defs.get(movedEffect)!;
      throw new StructureError(
        `cannot structure '${fn.name}': a post-loop value inlines a '${d.opcode}' from inside the loop, ` +
          `which would move that effect out of it`,
      );
    }
    dwActive.add(dw.header);
    // structure the header's own block up to the latch. Call structureBlock DIRECTLY (not
    // structureRegion): the header is already on `onStack` from the caller's structureRegion, so
    // re-entering it via structureRegion would trip the back-edge guard. dwActive masks the do-while
    // hook so this pass structures `header` as an ordinary block (its ifs reconverge at the latch=stop).
    // Structure the header..latch body under this loop's frame so an in-body conditional exit
    // (break / early return before the bottom test) is recognised rather than declining.
    const inner =
      dw.header === dw.latch
        ? [] // single-block self-loop: the header IS the latch — its ops render via sideEffects below
        : withLoop({ header: dw.header, exit: dw.exit, body: dw.body, arms: dw.arms, breaks: new Set() }, () =>
            structureBlock(dw.header, dw.latch),
          ); // header..latch (exclusive of latch)
    dwActive.delete(dw.header);
    // The UPDATE is RAW (`v = v - 1`) — it IS the decrement; applying `sub` would make it look like the
    // identity `v = v` and drop it. Only the CONDITION and EXIT copies use `sub` (post-update the param
    // already holds the next value, so the latch-computed test reads `v`, not `v - 1`). `updates`
    // reuses the hazard check's computation — a second argAssigns call would burn a spurious
    // swap-cycle temp number.
    const sunkCopies = preUpdateCopies(dw.exit, exitArgs, sunk, dw.header);
    const latchEffects = () => sideEffects(dw.latch, sunkCopies.atDef);
    // The folded update is spelled by the test's own `n++`, so it leaves the foot of the body.
    // `updates` itself is untouched: every hazard above, and `writtenByUpdate` below, ask what one
    // iteration WRITES, and the fold moves that write without removing it.
    const bodyUpdates =
      condFold === null ? updates : updates.filter((st) => !(st.k === 'assign' && st.name === condFold.name));
    const body = [
      ...sunkCopies.leading,
      ...inner,
      ...(innerSub.size > 0 ? withSub(innerSub, latchEffects) : latchEffects()),
      ...bodyUpdates,
    ];
    assertSunkCopiesPlaced(sunkCopies);
    // The test reads this loop's own update under `sub`, and anything else an inner loop left under
    // `innerSub` — the outer loop's own reading wins where a value is both. The test runs AFTER the
    // update copies, so an inner name one of them really writes no longer holds the inner value, and
    // that entry keeps the raw reading — the same refusal `latchInnerSub` makes for a name written
    // before the latch, with the update's writes added to what the re-derivation must not read.
    // The exit copies and the exit region run after the test and read under the same map: an inner
    // loop's value is still in its name there.
    const writtenByUpdate = innerSub.size > 0 ? updateWriteSet(updates) : new Set<string>();
    const condInner = [...innerSub].filter(([, n]) => !writtenByUpdate.has(n));
    const condMap = condInner.length > 0 ? new Map([...condInner, ...sub]) : sub;
    // NEITHER READING IS THE VALUE — decline LOUD. An inner value whose name was rewritten before a
    // latch reader runs is not substituted, and its re-derivation reads a name written after it
    // was computed: the name holds something else and the re-derivation computes something else.
    // Which readers these are is exactly what the lines above render under each map: the latch's
    // side effects and update copies under `latchMap` (or the ambient `activeSub`), the test under
    // `condMap`. Materialized and effectful ops are the side effects' roots; a pure op renders at
    // its use, which is one of the other two roots or outside the latch.
    const condUnreadable = new Set(unreadable);
    for (const [v] of innerSub) {
      if (!condMap.has(v) && readsClobbered(v, condMap, new Set([...writtenAfter.get(v)!, ...writtenByUpdate]))) {
        condUnreadable.add(v);
      }
    }
    if (condUnreadable.size > 0) {
      const bodyMap = latchMap ?? activeSub;
      const effectRoots = dw.latch.ops
        .slice(0, -1)
        .filter((op) => op.results.length === 0 || materialize.has(op) || effectful(op) || unreadResult(op))
        .flatMap((op) => op.operands);
      const updateRoots = successorTo(dw.latch, dw.header)!.args;
      const regionRoots = rootsOf(exitRegion(dw.exit, dw.body, stop));
      if (
        [...effectRoots, ...updateRoots].some((r) => rendersThrough(r, bodyMap, unreadable)) ||
        [lterm.operands[0], ...exitArgs, ...regionRoots].some((r) => rendersThrough(r, condMap, condUnreadable))
      ) {
        throw new StructureError(
          `cannot structure '${fn.name}': a loop latch reads an inner loop's value whose name was rewritten ` +
            `after the inner loop, and re-deriving it reads a name the inner loop wrote`,
        );
      }
    }
    let cond = exprWith(condMap)(lterm.operands[0]);
    if (lterm.successors[1].block === dw.header) {
      cond = negateCond(cond);
    } // continue edge must be `taken`
    if (condFold !== null) {
      // AFTER the negation, so the leaf is placed in the tree that is emitted. `negateCond` rewrites
      // the connectives by De Morgan, which moves the leaf between arms without duplicating it — and
      // a rewrite that did duplicate it is exactly what `spellUpdateInCond` refuses.
      const folded = spellUpdateInCond(cond, condFold.name, condFold.by);
      if (folded === null) {
        throw new StructureError(
          `cannot structure '${fn.name}': the do-while test does not spell '${condFold.name}' exactly once, ` +
            `so its update has no place inside the test`,
        );
      }
      cond = folded;
    }
    const out: Stmt[] = [{ k: 'dowhile', cond, body }];
    // The exit region reads latch back-edge values under `sub` (post-loop they live in the loop vars),
    // and inner loops' values as the test does.
    out.push(
      ...withSub(condMap, () => [
        ...argAssigns(dw.latch, dw.exit, condMap, (j) => !sunk.has(j)),
        ...structureRegion(dw.exit, stop),
      ]),
    );
    return out;
  };

  const body = stampOrderedBases(recognizeForLoops(structureRegion(entry, null)), orderLicensedGlobals);
  // THE OBLIGATION `anchorConstCopies` CANNOT DISCHARGE ON ITS OWN, checked now that the render is
  // complete. Anchoring is two edits that must both land: `suppressedArgs` DELETES a write from its
  // edge, and `anchoredAt` owes it back at the const's def site. Its refusal conditions establish
  // that the def block DOMINATES every suppressed edge — but dominating a block is not being
  // rendered, and a block whose every op renders inline gets no statement position at all. A loop's
  // claimed pure preheader is one (LoopInfo.preheader: the guarded-loop emitter takes its EDGE args
  // and never structures it), and there is no reason to believe it is the last. A promise half-kept
  // leaves the merge variable read where nothing wrote it — the one wrongness the byte differ
  // rewards rather than catches, since the candidate compiles, scores, and can win.
  //
  // OBSERVABLE is the test, not "emitted". A merge name the rendered body never mentions has no
  // reader to see the missing write and no second writer to disagree with it, and its declaration
  // goes with it (l3/dce.ts prunes a local nothing references) — so the copy and the value it
  // carried are gone together, which is a program the edge spelling can also produce. Only a name
  // the body still uses is a broken promise, or a GLOBAL, whose store is observed outside this
  // function whatever this body does with it. klonoa's `MPlayContinue` is the live inhabitant: its
  // `/defsite` spelling is correct and main enumerates it — a RECORD of a measurement, not a live
  // check, since that function is in no corpus row and no fixture here.
  const owed = [...anchoredAt.values()].flat().filter((w) => !anchorsEmitted.has(w));
  if (owed.length > 0) {
    const mentioned = new Set<string>(globalNames);
    for (const e of walkExprs(body)) {
      const n = mentionedName(e);
      if (n !== undefined) {
        mentioned.add(n);
      }
    }
    const assignTargets = (ss: Stmt[]): void => {
      for (const st of ss) {
        if (st.k === 'assign') {
          mentioned.add(st.name);
        }
        assignTargets(stmtChildren(st));
      }
    };
    assignTargets(body);
    const broken = owed.find((w) => mentioned.has(w.name));
    if (broken !== undefined) {
      throw new StructureError(
        `cannot structure '${fn.name}': the merge copy into '${broken.name}' was suppressed from ` +
          `its edge for a def-site anchor that no rendered position emitted`,
      );
    }
  }
  // THE OBLIGATION `undefCarriesNothing` CANNOT DISCHARGE ON ITS OWN, checked now that both records
  // are complete. That test reads each write site off `paramBlock`/`opBlock`, and a sunk pre-update
  // exit copy is written somewhere else than either map says. What keeps them apart today is
  // `dest-free-inside-loop`, a gate stated about something else entirely and carrying its own KNOWN
  // GAP — so the day a widening lets the two meet, the emitted C substitutes a DEFINED value for the
  // undefined one the machine leaves in place. Loud, because that failure has no other symptom.
  const collided = sunkCopyOverDroppedUndef(droppedUndefCopies, sunkCopyHomes, (home, pred) =>
    reachFrom(home).has(pred),
  );
  if (collided !== null) {
    throw new StructureError(
      `cannot structure '${fn.name}': a pre-update exit copy sunk into a loop body writes '${collided}' ` +
        `ahead of an edge whose undefined argument's copy was dropped as carrying nothing`,
    );
  }
  // Strict-mode gaps decline HERE, naming the reasons — the same text annotate's markers
  // carry, so the two mode surfaces report the same decline (the reproduction scripts run
  // strict; the benchmark rows store annotate markers — fidelity holds them against each
  // other). Without this, the `?` sentinels reach assertResolved and decline anonymously.
  if (strictGaps.length > 0) {
    const reasons = [...new Set(strictGaps)].join('; ');
    throw new StructureError(`${strictGaps.length} unresolvable value(s) in '${fn.name}' — ${reasons}`);
  }
  // v* = coalesced/materialized locals; t* = sequentialize's swap-cycle temps (varType-only —
  // they have no Value, so they are collected from varType, not varName); and the two-level exit
  // flags (`twoLevelFlag`), varType-only too. A name the body no longer mentions is pruned by
  // l3/dce.ts.
  const localNames = [
    ...new Set([
      ...varName.values(),
      ...[...varType.keys()].filter((n) => /^t\d+$/.test(n)),
      ...twoLevelFlags.values(),
    ]),
  ].filter((n) => /^[vt]\d+$/.test(n) && !globalNames.has(n));
  // THE FRAME COORDINATES OF EACH DECLARED LOCAL (ir/core.ts `SlotHomes`, stamped by the SSA
  // builder). The naming walk is what makes it a per-DECLARATION fact: several spilled values can
  // land under one name, and the local the source declared is the name, not the value. Where a
  // name covers several homes it takes the UNION and picks NOTHING — which offset is the earlier
  // declaration rank depends on the frame's direction, and `l3/slotorder.ts` is the one place that
  // holds it. Sorted, so the list is deterministic rather than insertion-ordered.
  //
  // A NAME COVERING NO HOMED VALUE GETS NO ENTRY, so `slots` is absent rather than `[]` on the
  // locals the asm kept in registers. Values named `a<n>` (parameters) never reach here:
  // `localNames` is the `v*`/`t*` set, and a parameter's storage is the caller's question.
  const slotsOfName = new Map<string, Set<number>>();
  const isLocalName = new Set(localNames);
  for (const [v, offs] of fn.slotHomes ?? []) {
    const n = varName.get(v);
    if (n === undefined || !isLocalName.has(n)) {
      continue;
    }
    const prev = slotsOfName.get(n);
    if (prev === undefined) {
      slotsOfName.set(n, new Set(offs));
    } else {
      offs.forEach((off) => prev.add(off));
    }
  }
  // The machine's static access counts for one frame object: every `load`/`store` rooted on an
  // `laddr` at the same offset. Counted over the L2 blocks, so it is the access set the asm had,
  // before any L3 readability pass could drop or duplicate one. Summed across the offset's
  // `laddr` ops — the frontend's frame-object audit re-roots accesses onto per-offset captures
  // and holds one object per offset, so several ops can name the same storage.
  //
  // NO record at all when the address reaches ANYTHING ELSE — a block argument, an offset
  // computation, a call. The count is then a floor rather than the access set, and it is read as
  // the access set (the l3/volatileval.ts gate), so it refuses instead of reporting a number that
  // undercounts. Reached rather than theoretical: an address-escaped frame scratch takes it —
  // `synthetic:dma_fill_uninit` loses its record here, and so did `kleod:ProcessInputAndUpdateEntities`
  // before that row was retired (2026-09-13).
  const frameRecord = (at: Op): { frame?: { loads: number; stores: number } } => {
    if (at.attrs[OWN_RETURN_OBJECT] === true || at.attrs[CALL_RETURN_OBJECT] !== undefined) {
      return {};
    }
    const off = at.attrs.off as number;
    const roots = new Set<Value>();
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (
          op.opcode === 'laddr' &&
          (op.attrs.off as number) === off &&
          op.attrs[OWN_RETURN_OBJECT] !== true &&
          op.attrs[CALL_RETURN_OBJECT] === undefined
        ) {
          roots.add(op.results[0]);
        }
      }
    }
    let loads = 0;
    let stores = 0;
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        const access = op.opcode === 'load' || op.opcode === 'store';
        if (access && roots.has(op.operands[0])) {
          if (op.opcode === 'load') {
            loads++;
          } else {
            stores++;
          }
        }
        // a struct passed by value is read whole at the call: the word loads the asm made of it
        const passed = byValueOperands(op)
          .map((b) => b.at)
          .filter((at) => roots.has(op.operands[at]));
        passed.forEach((at) => {
          const t = op.operands[at].type;
          loads += t.kind === 'ptr' && t.to.kind === 'struct' ? Math.ceil((t.to.size ?? 4) / 4) : 1;
        });
        // every OTHER mention of the address, operands and branch arguments alike
        const elsewhere = op.operands.some((v, i) => roots.has(v) && !(access && i === 0) && !passed.includes(i));
        if (elsewhere || op.successors.some((sx) => sx.args.some((v) => roots.has(v)))) {
          return {};
        }
      }
    }
    return { frame: { loads, stores } };
  };
  // ONE `laddr` op per minted NAME, last one wins. Same answer as feeding every op's finished entry
  // to `new Map` — each entry was a pure function of its own op, and the Map kept the LAST value
  // under a key at its FIRST key's position — but stated rather than left to be read off `new Map`'s
  // semantics, and `frameRecord` (which walks every op of the function) then runs once per name
  // instead of once per op. NOT a measured speedup: over `packages/core/test` every one of the
  // 1,057 structurings that reach here has ops === names, so the dedup fires zero times there. It
  // is a bound, not a win: `laddrName` mints one name per OFFSET, and the frontend's frame-object
  // audit can re-root several ops onto one offset (see `frameRecord`'s own note).
  const lastLaddrOf = new Map<string, Op>();
  for (const op of fn.blocks.flatMap((b) => b.ops).filter((op) => op.opcode === 'laddr')) {
    lastLaddrOf.set(laddrName.get(op)!, op);
  }
  const structs = collectStructs(fn);
  const tree: SFn = {
    name: fn.name,
    params: entry.params.map((p, i) => ({ name: `a${i}`, type: p.type })),
    locals: [
      ...localNames.map((n) => ({
        name: n,
        type: varType.get(n)!,
        ...(slotsOfName.has(n) ? { slots: [...slotsOfName.get(n)!].sort((x, y) => x - y) } : {}),
      })),
      // frame-local objects (laddr): declared with EXACTLY the access type the machine used —
      // the frontend's frame-object audit proved all accesses agree, so this is a fact, not a guess
      //
      // NO `slots` IS STAMPED HERE, and the offset is in hand (`op.attrs.off`), so this is a
      // refusal and not an oversight. An RTL-time frame object is allocated at its declaration
      // and sits BELOW every spill slot, so its offset is not evidence of its rank among the
      // spilled locals — and the one row in the corpus that carries such an object next to real
      // spills (`synthetic:dma_fill_uninit`, a `volatile` scratch at offset 0) compiles to the
      // same object whether that local is sorted with the spills or left where the naming walk
      // put it, measured both ways. So no row can refute an ordering over these, and an ordering
      // no row can refute does not earn its place. THE FLIP CONDITION: the first row whose object
      // is decided by the declaration order of two `laddr` locals, or of an `laddr` against a
      // spill, is the referee — stamp them then, and `l3/slotorder.ts` needs no change to use it.
      ...[...lastLaddrOf].map(([name, op]) => ({
        name,
        type: laddrType(op),
        // the asm materialized this slot's address, and this is how many times it
        // loaded and stored through it — both asm facts, and the gate the
        // l3/volatileval.ts variation reads (see the SFn.locals doc)
        ...frameRecord(op),
        // an ESCAPED address makes every store observable (the DMA hardware reads it), and
        // the source spells the scratch volatile for that reason — see the stamp site in
        // frontend/thumb.ts for why it is the SPELLING that matters and not dead-store
        // elimination, which keeps the store either way
        ...(op.attrs.volatile === true ? { volatile: true as const } : {}),
      })),
      // uninitialised locals (undef): declared, never assigned, typed by whatever recovery settled
      // on for the value. NO `slots` either, on the same footing as the frame objects above.
      //
      // THE REASON IS UNDECIDABILITY, not absence. One frame slot then yields TWO declarations:
      // the `undef` read of the storage and the value stored into it. They are one object in the
      // source, and the asm does not say which of the two took the rank — so ranking one of the
      // pair while leaving the other pinned would invent an answer. Refusing the undef half keeps
      // the stored half's rank, which is the one the spill evidence is about.
      //
      // AND IT IS PRECAUTIONARY: NO ROW REACHES IT. The co-existence is real in the tree this
      // function returns — `uninit_spill` declares `uninit_sp0/sp4/sp8` beside the slotted `v4@0
      // v5@4 v6@8`, `dma_fill_uninit` declares `uninit_sp4/sp8/sp12` beside `v4@4 v6@8 v8@12` —
      // but that tree is never emitted: `structure()` has exactly one caller, `structureChecked`
      // (pipeline.ts), and `l3/slotorder.ts` runs inside `emit`, downstream of it on every emit
      // path. On the tree `structureChecked` returns neither row has an `uninit` local left —
      // `eliminateDeadStores` (l3/dce.ts, whose last line keeps only locals the body still
      // references) removes all eight on `uninit_spill` and all seven on `dma_fill_uninit`,
      // leaving the slot-carrying locals untouched. Instrumented one spine stage at a time, not
      // inferred: raw 8 → mergeCommonTails 8 → eliminateDeadStores 0.
      //
      // The refusal stays HERE rather than at the ordering because this is where the stamp is
      // decided, and an `undef` local that survived DCE — address-taken, `volatile`, or genuinely
      // read — would otherwise carry it into `emit`. FLIP CONDITION, and it is not "the first
      // uninit local", since four rows already have them in `structure()`'s tree and none in
      // `structureChecked`'s: it is the first row where a slot-keyed `undef` local SURVIVES
      // dead-store elimination beside a slotted local at the same offset, and compile shows the
      // two to be two source declarations rather than one. `spill-slot-order.test.ts` pins both
      // halves, so a change to either fails there.
      ...fn.blocks
        .flatMap((b) => b.ops)
        .filter((op) => op.opcode === 'undef' && !coalescedUndefs.has(op))
        .filter((op, i, all) => all.findIndex((o) => undefName.get(o) === undefName.get(op)) === i)
        .map((op) => ({
          name: undefName.get(op)!,
          type: varType.get(undefName.get(op)!) ?? op.results[0].type,
          uninit: true as const,
        })),
    ],
    ...(shapedGlobalTypes.size
      ? {
          globals: [...shapedGlobalTypes]
            .map(([name, type]) => ({ name, type }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : {}),
    ...(localStatics.statics.length ? { statics: localStatics.statics } : {}),
    ...(localStatics.images.length ? { images: localStatics.images } : {}),
    retType: returnsVoid ? T.void() : returnType(fn),
    body,
    ...(structs.length ? { structs } : {}),
    // absent stays absent: the backend asks "is a direction known?", and there is no third state
    // at this boundary — `structureOptionsFor` dropped the target's `'unknown'` already.
    ...(spillSlotOrder !== undefined ? { slotOrder: spillSlotOrder } : {}),
    ...calledOnly({ declaredArgs, declaredReturns }, body),
    ...(dialect !== undefined ? { dialect } : {}),
    ...(designatedInitializers ? { designators: true as const } : {}),
    ...(strictPointerConversions ? { strictConversions: true as const } : {}),
  };
  if (fn.localObjects === undefined) {
    return tree;
  }
  const named = nameLocalStatics(tree, fn.localObjects);
  if ('refused' in named) {
    throw new StructureError(
      `cannot structure '${fn.name}': names a function-scope static ('${named.symbol}') ${named.refused}`,
    );
  }
  // The compiler's anonymous constant is spelled only as the initializer of the locals its copies
  // fill, which the emitter folds (l3/constinit.ts says why there). Asked here, so a function
  // whose image cannot fold declines loudly rather than reaching an emitter that cannot print it.
  const image = constantImageRefusal(named);
  if (image !== null) {
    throw new StructureError(
      `cannot structure '${fn.name}': reads the compiler's anonymous constant ('${image.image}') ${image.refused}`,
    );
  }
  return named;
}

/** Each declared-callee table's own key order, name → position, computed once per table object: the
 *  ranked pass structures every candidate against the same tables. */
const keyOrders = new WeakMap<object, ReadonlyMap<string, number>>();
function keyOrder(table: object): ReadonlyMap<string, number> {
  let order = keyOrders.get(table);
  if (order === undefined) {
    order = new Map(Object.keys(table).map((n, i) => [n, i]));
    keyOrders.set(table, order);
  }
  return order;
}

/** Of each table of declared callees, the entries this body calls — every tree the ranked pass
 *  structures carries its own, and is keyed by its whole text. A table this body calls nothing in is
 *  absent. */
function calledOnly(
  tables: Pick<StructureOptions, 'declaredArgs' | 'declaredReturns'>,
  body: Stmt[],
): Pick<StructureOptions, 'declaredArgs' | 'declaredReturns'> {
  const callees = new Set<string>();
  for (const e of walkExprs(body)) {
    if (e.k === 'call' && typeof e.fn === 'string') {
      callees.add(e.fn);
    }
  }
  // Look up the few names this body calls, not every entry of the table: a project's table holds
  // every function its ELF declares (thousands for pokeemerald), and this runs on each structuring
  // of each candidate. The result keeps the TABLE's key order, as a whole-table filter would,
  // because the tree is keyed by its whole text.
  const of = <T>(table: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined => {
    if (table === undefined || callees.size === 0) {
      return undefined;
    }
    const order = keyOrder(table);
    const names = [...callees].filter((n) => order.has(n)).sort((a, b) => order.get(a)! - order.get(b)!);
    return names.length > 0 ? Object.fromEntries(names.map((n) => [n, table[n]])) : undefined;
  };
  const declaredArgs = of(tables.declaredArgs);
  const declaredReturns = of(tables.declaredReturns);
  return { ...(declaredArgs ? { declaredArgs } : {}), ...(declaredReturns ? { declaredReturns } : {}) };
}

// Does any statement CONTINUE this loop (vs. a nested one)? A `continue` inside a nested while/dowhile/
// for targets THAT loop, so we do not descend into them; but `if`/`switch` do not capture `continue`,
// so we scan through those. The structurer emits `continue;` for an edge into the header of a `while
// (1)` (structureRegion) and into the latch of a `for` (`forPlanAt`), so a `while` can hold one: this
// guards the one case where the while→for re-bracketing would change semantics (a `continue` runs
// `inc` under `for`, skips it under `while`).
function hasEnclosingContinue(stmts: Stmt[]): boolean {
  const scan = (s: Stmt): boolean => {
    switch (s.k) {
      case 'continue':
        return true;
      case 'if':
        return s.then.some(scan) || s.else.some(scan);
      case 'switch':
        return s.cases.some((c) => c.body.some(scan)) || (s.default ?? []).some(scan);
      case 'while':
      case 'dowhile':
      case 'for':
        return false; // nested loop captures its own continue
      default:
        return false;
    }
  };
  return stmts.some(scan);
}

// Re-spell an eligible test-at-top `while` as a `for` (quality only). PURELY cosmetic — the C
// desugaring `for(init;cond;inc){body}` compiles identically to `init; while(cond){body; inc}`, so it
// NEVER changes a byte-exact match. Conservative preconditions (a Ghidra `findLoopVariable`-style
// recognition that moves NO op — the init already precedes the loop, the increment is already the
// body's last statement):
//   • the `while` is IMMEDIATELY preceded by `assign(iv, e0)` (the init literally precedes it);
//   • the `while` cond references `iv`;
//   • the body's LAST statement is `assign(iv, e1)` with `e1` referencing `iv` (a genuine self-update —
//     the increment is literally the body's last op, not an unrelated trailing assign);
//   • the body EXCLUDING that increment has no `continue` targeting THIS loop — a `continue` RUNS `inc`
//     under `for` but SKIPS it under `while`, so folding the increment into the header would change
//     semantics. This is the one hazard of the transform; all others are pure re-bracketing.
// Any precondition failing leaves the `while` untouched. Runs bottom-up so inner loops convert first.
function recognizeForLoops(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s0 of stmts) {
    const s: Stmt =
      s0.k === 'if'
        ? { ...s0, then: recognizeForLoops(s0.then), else: recognizeForLoops(s0.else) }
        : s0.k === 'while' || s0.k === 'dowhile'
          ? { ...s0, body: recognizeForLoops(s0.body) }
          : s0.k === 'for'
            ? { ...s0, body: recognizeForLoops(s0.body) }
            : s0.k === 'switch'
              ? {
                  ...s0,
                  cases: s0.cases.map((c) => ({ ...c, body: recognizeForLoops(c.body) })),
                  ...(s0.default ? { default: recognizeForLoops(s0.default) } : {}),
                }
              : s0;

    const prev = out[out.length - 1];
    if (s.k === 'while' && s.body.length >= 1 && prev && prev.k === 'assign') {
      const iv = prev.name;
      const inc = s.body[s.body.length - 1];
      if (
        inc.k === 'assign' &&
        inc.name === iv &&
        exprVars(inc.value).has(iv) &&
        exprVars(s.cond).has(iv) &&
        !hasEnclosingContinue(s.body.slice(0, -1))
      ) {
        out.pop(); // the init assign moves into the for-header
        out.push({ k: 'for', init: prev, cond: s.cond, inc, body: s.body.slice(0, -1) });
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

// Sequentialise a parallel copy: order the assignments so none writes a variable that a
// still-pending assignment reads; break a cycle by spilling one destination to a temp.
// `tmp` is the per-FUNCTION temp counter (threaded from structure()) so two independent
// parallel copies never reuse a temp name against conflicting types.
/** Does this edge's copy set contain a CYCLE — no copy emittable without overwriting a destination
 *  another still reads, so `sequentialize` has to spill one into a temp? `sequentialize`'s own
 *  emittability loop, run without emitting, so the two can never disagree about which sets are
 *  which.
 *
 *  It is the LICENCE BOUNDARY the edge-copy sort draws: on a cyclic set an instruction names the
 *  compiler's temp and the write-order record reproduces it, while on an acyclic one the record is
 *  only an assumption about layout order. `preferDefPosCopyOrder` asks for the proxy on the second
 *  kind only. */
function copySetIsCyclic(copies: { name: string; value: Expr }[]): boolean {
  const pending = copies.map((c) => ({ name: c.name, reads: exprVars(c.value) }));
  for (;;) {
    const i = pending.findIndex((a) => !pending.some((b) => b !== a && b.reads.has(a.name)));
    if (i < 0) {
      return pending.length > 0;
    }
    pending.splice(i, 1);
  }
}

function sequentialize(
  copies: { name: string; value: Expr }[],
  varType: Map<string, IrType>,
  tmp: { n: number },
  fnName: string,
): Stmt[] {
  // Two writes to one destination have no correct order — that is two phi params coalesced onto
  // one name, which canTakeName prevents upstream. Fail loud, never pick one.
  const dests = new Set<string>();
  for (const c of copies) {
    if (dests.has(c.name)) {
      throw new StructureError(`cannot structure '${fnName}': parallel copy writes '${c.name}' twice (coalescing bug)`);
    }
    dests.add(c.name);
  }
  const pending = copies.map((c) => ({ ...c, reads: exprVars(c.value) }));
  const out: Stmt[] = [];
  while (pending.length) {
    const i = pending.findIndex((a) => !pending.some((b) => b !== a && b.reads.has(a.name)));
    if (i >= 0) {
      const a = pending.splice(i, 1)[0];
      out.push({ k: 'assign', name: a.name, value: a.value });
      continue;
    }
    // All remaining form a cycle: spill one destination into a temp, rewrite its readers, and
    // RECOMPUTE their read-sets — with stale sets the spilled copy never becomes emittable and
    // the loop mints fresh temps forever.
    const a = pending[0];
    const t = `t${tmp.n++}`;
    varType.set(t, varType.get(a.name)!);
    out.push({ k: 'assign', name: t, value: { k: 'var', name: a.name } });
    for (const b of pending) {
      if (b !== a) {
        b.value = substVar(b.value, a.name, t);
        b.reads = exprVars(b.value);
      }
    }
  }
  return out;
}
// Read-set / rewrite walkers over the FULL Expr union — a walker that misses a node kind (e.g.
// call/index/field reads) sequentializes a copy keyed by an array index in the wrong order.
function exprVars(e: Expr, acc: Set<string> = new Set()): Set<string> {
  if (e.k === 'var') {
    acc.add(e.name);
  }
  for (const c of exprChildren(e)) {
    exprVars(c, acc);
  }
  return acc;
}
function substVar(e: Expr, from: string, to: string): Expr {
  if (e.k === 'var') {
    return e.name === from ? { k: 'var', name: to } : e;
  }
  return mapExprChildren(e, (c) => substVar(c, from, to));
}

// empty-then peephole: `if (c) {} else { S }` → `if (!c) { S }`
function mkIf(cond: Expr, thenS: Stmt[], elseS: Stmt[]): Stmt {
  if (thenS.length === 0 && elseS.length > 0 && !keepsHelperRel(cond)) {
    return { k: 'if', cond: negateCond(cond), then: elseS, else: [] };
  }
  return { k: 'if', cond, then: thenS, else: elseS };
}

// --- CFG utilities ---
/** Every block's in-edges. THROWS BY NAME on a successor that is not a block of `fn` — the one
 *  state that makes this map lie, and the one the whole structurer reads positions and dominance
 *  out of. `ir/verify.ts` already rejects that state with a name and the tower runs it after the
 *  lift and after every raising pass, so reaching HERE means a pass built it after the last verify:
 *  exactly when a named error beats a `TypeError` from a CFG utility 3000 lines from anything the
 *  reader recognises. switch-recover.ts PRE5 and its test cite this throw as a loud invariant. */
function predecessorBlocks(fn: Fn): Map<Block, Block[]> {
  const m = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    m.set(b, []);
  }
  for (const [i, b] of fn.blocks.entries()) {
    for (const s of successorsOf(b)) {
      const preds = m.get(s);
      if (!preds) {
        throw new Error(`successor of block ${i} is not a block of this fn (fn '${fn.name}', predecessorBlocks)`);
      }
      preds.push(b);
    }
  }
  return m;
}
function successorTo(pred: Block, target: Block) {
  const term = pred.ops[pred.ops.length - 1];
  return term.successors.find((s) => s.block === target);
}
/** EVERY in-edge record into `b` — which is what {@link successorTo} cannot give: it returns only
 *  the FIRST record to a block, so a terminator with two edges to the same block hides the second
 *  edge's args. Callers that ask "what does every path pass for param i" need all of them.
 *
 *  ORDER IS LOAD-BEARING and is `preds` insertion order, then terminator-successor order: the
 *  naming walk takes the FIRST admissible carrier, so a different order is a different spelling.
 *
 *  AND IT IS GUARDED, not merely warned about — measured, not reasoned: rewriting this walk to call
 *  `successorTo` turns 12 tests across 5 files of `packages/core/test` red. The path it would lose
 *  is reached constantly, 326,305 times over that suite on a `cond_br` whose two arms land on one
 *  block and 6 more on a `switch_br`.
 *
 *  The terminator is read UNGUARDED (`ops[ops.length - 1]`) on purpose: every block of a verified
 *  Fn has one, and a guard would turn a malformed Fn's throw into a silent missing edge.
 *
 *  `hasParamRootedMerge` does not go through this, deliberately: it is a pre-structuring query over
 *  a raw Fn and walks `fn.blocks` rather than a predecessor map it would first have to build. */
function* inEdgeRecords(preds: Map<Block, Block[]>, b: Block): Generator<{ pred: Block; succ: Successor }> {
  for (const pred of new Set(preds.get(b) ?? [])) {
    for (const succ of pred.ops[pred.ops.length - 1].successors) {
      if (succ.block === b) {
        yield { pred, succ };
      }
    }
  }
}

/** THE function-level immediate post-dominators, the one definition `structure()` and its
 *  enumeration gate `hasDivergentSharedRet` both read, so the gate's join for an `if` is the join
 *  the follow sees. A loop no edge leaves reaches no `ret`, so plain post-dominance would hand
 *  every block before it every block as a post-dominator, and an `if` ahead of it an arbitrary
 *  join. Its header ENDS paths as a `ret` does: the region holding the loop ends there
 *  (`emitForever`). `forest` is the caller's, when it already has one. */
export function functionPostDominators(
  fn: Fn,
  forest: { byHeader: ReadonlyMap<Block, NaturalLoop> } = analyzeLoops(fn, dominators(fn)),
): Map<Block, Block | null> {
  const exitless = [...forest.byHeader.values()].filter((nl) => nl.exitEdges.length === 0).map((nl) => nl.header);
  return postDominators(fn, undefined, undefined, new Set(exitless));
}

// Immediate post-dominators. EXIT is represented as `null`; ret-blocks post-lead to it, and so do
// the blocks of `ends` besides their own successors. Over the subgraph `keep` induces when given,
// every member of which must still reach a `ret` inside it — or, with `onward`, over only the edges
// it names between members of `keep` (and to EXIT, where it names `null`): a block it names no edge
// from ends its paths, post-dominated by nothing but itself.
function postDominators(
  fn: Fn,
  keep?: ReadonlySet<Block>,
  onward?: (b: Block) => (Block | null)[],
  ends?: ReadonlySet<Block>,
): Map<Block, Block | null> {
  const blocks = keep ? fn.blocks.filter((b) => keep.has(b)) : fn.blocks;
  const nodes: (Block | null)[] = [null, ...blocks];
  const succ = (b: Block): (Block | null)[] => {
    if (onward !== undefined) {
      return onward(b);
    }
    const term = b.ops[b.ops.length - 1];
    if (term.opcode === 'ret') {
      return [null];
    }
    const onwards = successorsOf(b).filter((s) => keep === undefined || keep.has(s));
    return ends?.has(b) === true ? [...onwards, null] : onwards;
  };
  const pdom = new Map<Block | null, Set<Block | null>>();
  pdom.set(null, new Set([null]));
  for (const b of blocks) {
    pdom.set(b, new Set(nodes));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of blocks) {
      const ss = succ(b);
      let inter: Set<Block | null> | null = null;
      for (const s of ss) {
        const ps = pdom.get(s)!;
        if (inter === null) {
          inter = new Set(ps);
          continue;
        }
        for (const x of inter) {
          if (!ps.has(x)) {
            inter.delete(x);
          }
        } // intersect in place (spec-safe delete-in-iter)
      }
      const next = new Set<Block | null>(inter ?? []);
      next.add(b);
      if (!setEq(next, pdom.get(b)!)) {
        pdom.set(b, next);
        changed = true;
      }
    }
  }
  // ipdom(b) = the strict post-dom c with (strictPostDoms(b) \ {c}) ⊆ pdom(c)
  const ipdom = new Map<Block, Block | null>();
  for (const b of blocks) {
    const strict = [...pdom.get(b)!].filter((c) => c !== b);
    let chosen: Block | null = null;
    for (const c of strict) {
      const others = strict.filter((x) => x !== c);
      if (others.every((x) => pdom.get(c)!.has(x))) {
        chosen = c;
        break;
      }
    }
    ipdom.set(b, chosen);
  }
  return ipdom;
}
function setEq<X>(a: Set<X>, b: Set<X>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const x of a) {
    if (!b.has(x)) {
      return false;
    }
  }
  return true;
}

/** The storage a symbol map states for a scalar or pointer global ({@link DeclaredStorage}): its
 *  `size`, and for a scalar its `signed`, which the map leaves out where the type is no base type
 *  (an enum, a float) and so states no sign. A map does not say whether a scalar is an integer or a
 *  float, so it is `sized`, compared by width and sign alone. None for a name the map sizes not, or
 *  describes as no scalar. */
function mappedStorage(info: SymbolInfo | undefined): DeclaredStorage | MappedStorage | undefined {
  if (info?.size === undefined || (info.shape !== 'scalar' && info.shape !== 'pointer')) {
    return undefined;
  }
  return { kind: 'sized', bytes: info.size, signed: info.shape === 'scalar' ? info.signed : undefined };
}

/** A symbol map's scalar ({@link mappedStorage}): an integer, a float or an enum it does not tell
 *  apart, of `bytes` bytes and the sign it states, if any. */
interface MappedStorage {
  kind: 'sized';
  bytes: number;
  signed: boolean | undefined;
}

/** One global's one access, as the declaration-shape override compares it with a declaration:
 *  `width` bytes at offset 0, and `signed` the extension of a read whose extension some use reads
 *  (undefined for a write, or a read every use of which takes only its own bytes:
 *  `extensionImmaterial`). It moves integer bits: no frontend models a float load or store of a
 *  global's relocated address (`lwc1`/`swc1` against a `%lo`, `lfs`/`stfs` against a small-data
 *  relocation decline loudly, and agbcc's soft-float helpers refuse an operand loaded from memory:
 *  raise/floathelpers.ts). */
interface GlobalAccess {
  width: number;
  signed: boolean | undefined;
}

/** Whether a global's declared storage disagrees with its one access: a bare name then reads or
 *  writes what the declaration says rather than what the assembly does. An integer agrees with an
 *  access of its own width, and a read narrower than a register with its sign too, a plain `char`
 *  by the target's `plainCharSigned`; a write stores the same bytes either way. A float agrees with
 *  no access, every one of which moves integer bits (`GlobalAccess`): `*(u16 *)&gF` reinterprets
 *  the bytes the bare name would convert. An enum is an integer of the target's `enumBytes`, with
 *  no sign this knows. What the target does not measure, or the context cannot read, agrees with
 *  nothing, which costs a spelling and never the C. No storage (no declaration) never disagrees. */
function storageDisagrees(
  declared: DeclaredStorage | MappedStorage | undefined,
  access: GlobalAccess,
  facts: { enumBytes: number | undefined; plainCharSigned: boolean | undefined },
): boolean {
  switch (declared?.kind) {
    case undefined:
      return false;
    case 'unread':
    case 'reference':
      return true;
    case 'float':
      return true;
    case 'enum':
      return (
        declared.unsized ||
        facts.enumBytes === undefined ||
        storageDisagrees({ kind: 'integer', bytes: facts.enumBytes, signed: undefined }, access, facts)
      );
    case 'integer':
    case 'sized': {
      if (declared.bytes !== access.width) {
        return true;
      }
      const signed = declared.signed === 'char' ? facts.plainCharSigned : declared.signed;
      return access.width < 4 && access.signed !== undefined && signed !== access.signed;
    }
  }
}

/** Whether no use of the narrow `load` (`width` bytes) reads the bits its extension fills: no reader
 *  of its value needs a bit past its own bytes (`demandedBits`, which follows it through
 *  arithmetic, masks, shifts and extensions, and across an edge into the join it reaches). A
 *  zero-extending `lbz` whose only use is an `extsb` then reads the byte a signed declaration names,
 *  and its bare name is the same program; so does the read-modify-write `gN += x`, whose `ldrh` /
 *  `add` / `strh` stores the same halfword whichever way the read extended, and `gN & 0x7f`. A load
 *  nothing uses is not one: what reads it is out of sight. A `ret` reads every bit, whatever the
 *  function returns. */
function extensionImmaterial(
  fn: Fn,
  load: Op,
  width: number,
  useSitesOf: ReadonlyMap<Value, readonly UseSite[]>,
): boolean {
  const v = load.results[0];
  return (
    width < 4 &&
    (useSitesOf.get(v)?.length ?? 0) > 0 &&
    (demandedBits(fn, v, false) & ~(2 ** (8 * width) - 1)) >>> 0 === 0
  );
}
