// asmlift structurer — the spelling of one memory access as an L3 lvalue/rvalue: a constant-offset
// `load`/`store` through a pointer, a frame slot or a named global (`memAccess`), an indexed
// `aload`/`astore` (`arrayAccess`), and the symbol-map lookups they read (`SymbolLookup`,
// `SymRenderCtx`) — the pointer-to-global and pointer-to-member bases, the pointee element of a
// declared pointer, and a displacement's whole-element index. Pure functions of the op, the
// rendered base and the map: the per-function state they need arrives as arguments from
// structure.ts's lowering, a read in `lowerRead` and a store in `sideEffects`. The address
// decomposition they share with the pointer spelling is globalaccess.ts.
import { Op, Value } from '../ir/core';
import {
  type IrType,
  type StructField,
  T,
  UNION_VIEW_NAMES,
  isCastView,
  scalarTypeForAccess,
  spellsAccessType,
  typeEquals,
  unionViewAt,
} from '../ir/types';
import { Expr } from '../l3/ast';
import { type Gate, firstRejection } from '../l3/gates';
import {
  type DeclaredField,
  type SymbolInfo,
  declaredArrayShape,
  isArrayField,
  isBitfieldField,
  pointeeFields,
  structFieldInnerExtents,
} from '../symbols';
import {
  addOffset,
  addrIn,
  bareArrayLead,
  declaredSubscripts,
  elementIndex,
  globalByteBase,
  globalOf,
  memberQualsAllow,
  nestedGlobalOf,
  ptrMemberDecl,
  structMemberAt,
  subscriptsFromExtents,
} from './globalaccess';
import { StructureError } from './structure-error';

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
export interface SymbolLookup {
  get(name: string): SymbolInfo | undefined;
  has(name: string): boolean;
}

/** The symbol-map rendering context threaded into memAccess/arrayAccess: shape facts per
 *  global name, plus a callback registering a global's env type (so the bare `gSym[i]` spelling,
 *  which must pass the stride check uncast, does). Absent ⇒ today's spellings. */
export interface SymRenderCtx {
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
  /** The element a declaration context declares the array `name` of, laid out on this target
   *  (StructureOptions `contextArrayElements`), and whether the array is declared volatile. Absent,
   *  or undefined for a name, ⇒ no declared element: {@link declaredElementMember} keeps the cast. */
  arrayElement?(name: string): DeclaredElementInfo | undefined;
  /** Whether the assembly materialized `name`'s address BEFORE it scaled the index (StructureOptions
   *  `orderLicensedGlobals`, raise/globalshape.ts): the base-first order an agbcc ARRAY_REF expands
   *  in. Absent ⇒ never: {@link declaredElementMember} keeps the cast. */
  baseFirst?(name: string): boolean;
}

/** A context-declared array's element as the structurer reads it: the element's IR struct (named
 *  members at the target's offsets, `aggregate.ts` `aggregateType`), the array's rank, and whether
 *  any byte of it is declared volatile. */
export interface DeclaredElementInfo {
  readonly type: IrType;
  readonly rank: number;
  readonly volatile: boolean;
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
export function laddrType(op: Op): IrType {
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
 *  NOT a `Gate` table (l3/gates.ts), unlike `FRESH_MERGE_GATES` and `CARRIER_NAME_GATES` in
 *  carrier-gates.ts: those refusals are predicates over ONE prepared context, while these interleave with
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
export function stampedStoreLval(
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
export type FrameArrayDecl = (name: string) => SymbolInfo | undefined;

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

export function memAccess(
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

// ── a struct-array element's member through the DECLARED array ───────────────────────────────
// `((struct Elem0 *)&gBgInfo)[i].field_8` and `gBgInfo[i].hOfs` address the same bytes, and they
// are not the same object on agbcc. Its build_array_ref (c-typeck.c:1383) builds an ARRAY_REF only
// for a subscript of an object of ARRAY type that is no INDIRECT_REF, which is the declared array
// alone; every cast base, a cast to the declared element type included, is the pointer sum, and the
// two expand in a different order (an ARRAY_REF through get_inner_reference, base first). Compiled
// on kleod:sub_0804C7FC:agbcc with the row's own command: the declared spelling is IDENTICAL to the
// target and every INLINE cast spelling places `ldr r5, =gBgInfo` after the index scale instead of
// before it. The recovered element reaches those bytes too, but only through a pointer-local home
// assigned at its first use (`p0 = (struct Elem0 *)&gBgInfo;` after the call), the `first-use`
// placement of ORDERBASE_HOISTS that rank-variations.ts withholds. So this spelling is not the only
// one that matches: it is the source's own reading, through the element type and member names the
// declaration context states (proto-context.ts `arrayElements`), and it needs no extra candidate.
//
// The spelling is taken only where it names exactly the bytes and the value the cast form does,
// only on agbcc (`arrayShapeFromStride`, read where the element is laid out): whether another
// compiler tells the two spellings apart is unmeasured, and only where the asm loaded the array's
// address before it scaled the index (the order licence, raise/globalshape.ts): a source that
// took a pointer to the element (`struct S *p = &g[i]; p->a`) scales first, and its cast lift
// matches where this one does not. Each refusal is a row of DECLARED_MEMBER_GATES, and the
// access then keeps the cast.

/** One struct-array member access the declared spelling `g[i].member` is asked of. */
export interface DeclaredMemberAccess {
  /** the declaration context's element for the array, on this target */
  readonly element: DeclaredElementInfo | undefined;
  /** the byte stride the asm scales the index by */
  readonly stride: number;
  /** the declared element's member that starts at the access's byte, if any */
  readonly member: StructField | undefined;
  /** the type the cast spelling reads or writes there: the recovered element's field */
  readonly access: IrType | undefined;
  readonly isStore: boolean;
  /** the access carries a qualifier, which only a cast has room for */
  readonly qualified: boolean;
  /** the assembly loaded the array's address before it scaled the index (the order licence) */
  readonly baseFirst: boolean;
}

/** Which struct-array member accesses are spelled through the declared array. Every rule but
 *  the last is sound: removed, the spelling names other bytes, reads another value, drops a
 *  qualifier, or (`no-declared-element`) has no element to spell. The last, `base-order`, is a
 *  codegen rule: both spellings name the same bytes, and it keeps the cast where the assembly
 *  scaled the index before it loaded the array's address, which is the pointer sum's order and not
 *  the ARRAY_REF's (`struct S *p = &g[i]; p->a = x;` compiles that way, and its lift through the
 *  cast is IDENTICAL while `g[i].a` moves the base load ahead of the scale).
 *
 *  WHAT IT DOES NOT ADMIT YET, each keeping the cast: a member of a nested struct or an array
 *  member (`aggregateType` gives neither a field), a pointer member read or written as a word
 *  (`no-member`, whose scalar test takes integers only), a rank-2 array (`rank`), and every lift
 *  with no symbol map (`/raw-globals` and a map-less row). The lookup sits on the symbol context
 *  although the declaration context alone states the element, so that the map-less sibling stays
 *  the fan's one cast candidate and both readings rank.
 *
 *  KNOWN GAP: no census seam reaches this table (its caller, `arrayAccess`, is held by no record
 *  outside core), so `pnpm bench gates` cannot count it. */
export const DECLARED_MEMBER_GATES: readonly Gate<DeclaredMemberAccess>[] = [
  {
    id: 'no-declared-element',
    why: 'the context declares no array of a struct this target lays out under that name, or the target is not one whose declared-array subscript is its own object',
    sound: true,
    guardedBy: 'declared-element-member.test.ts: a struct array the context does not declare keeps the cast',
    rejects: (c) => c.element === undefined || c.element.type.kind !== 'struct',
  },
  {
    id: 'qualified',
    why: 'a volatile array or a qualified access needs the cast its qualifier goes on',
    sound: true,
    guardedBy: 'declared-element-member.test.ts: a volatile struct array keeps the cast',
    rejects: (c) => c.qualified || c.element?.volatile === true,
  },
  {
    id: 'rank',
    why: 'a multidimensional array needs a row subscript this spelling does not place',
    sound: true,
    guardedBy: 'declared-element-member.test.ts: a rank-2 struct array keeps the cast',
    rejects: (c) => c.element !== undefined && c.element.rank !== 1,
  },
  {
    id: 'stride',
    why: 'the declared element is not the stride the asm scales by, so `g[i]` would name other bytes',
    sound: true,
    guardedBy: 'declared-element-member.test.ts: an element of another size keeps the cast',
    rejects: (c) => c.element?.type.kind === 'struct' && c.element.type.size !== c.stride,
  },
  {
    id: 'no-member',
    why: 'no scalar member of the declared element starts at the accessed byte',
    sound: true,
    guardedBy: 'declared-element-member.test.ts: an offset no member starts at keeps the cast',
    rejects: (c) => c.element !== undefined && (c.member === undefined || c.member.type.kind !== 'int'),
  },
  {
    id: 'member-type',
    why: 'the member is not the access: another width names other bytes, another extension reads another value',
    sound: true,
    guardedBy: 'declared-element-member.test.ts: a member of another width or a load of another sign keeps the cast',
    rejects: (c) => {
      const m = c.member?.type;
      const a = c.access;
      return m?.kind === 'int' && (a?.kind !== 'int' || m.width !== a.width || (!c.isStore && m.signed !== a.signed));
    },
  },
  {
    id: 'base-order',
    why: "the asm scaled the index before it loaded the array's address: the pointer sum's order, which the cast reproduces and the declared array's ARRAY_REF (base first) does not",
    sound: false,
    guardedBy: 'declared-element-member.test.ts: an element reached through a pointer to it keeps the cast',
    rejects: (c) => !c.baseFirst,
  },
];

/** `g[i].member` for a member access of a struct-array element whose base is the array's address,
 *  spelled through the array the declaration context declares, or null for the cast form
 *  (DECLARED_MEMBER_GATES says why). The element's IR type rides on the `index` node
 *  (`baseElem`), which is how the C type walk reads the element's members: the name is not entered
 *  in `SFn.globals`, which is also the addressable-base list the hoisting variations read. */
function declaredElementMember(
  name: string,
  recovered: IrType,
  idxExpr: Expr,
  fieldOff: number,
  elemSize: number,
  signed: boolean,
  sym: SymRenderCtx | undefined,
  how: { isStore: boolean; qualified: boolean },
): Expr | null {
  const element = sym?.arrayElement?.(name);
  const declared = element?.type.kind === 'struct' ? element.type : undefined;
  const ctx: DeclaredMemberAccess = {
    element,
    stride: elemSize,
    member: declared?.fields.find((f) => f.off === fieldOff),
    access:
      recovered.kind === 'ptr' && recovered.to.kind === 'struct'
        ? recovered.to.fields.find((f) => f.off === fieldOff)?.type
        : undefined,
    ...how,
    baseFirst: sym?.baseFirst?.(name) === true,
  };
  if (firstRejection(DECLARED_MEMBER_GATES, ctx) !== null) {
    return null;
  }
  const index: Expr = {
    k: 'index',
    base: { k: 'var', name },
    idx: idxExpr,
    width: elemSize,
    signed,
    baseElem: element!.type,
  };
  return { k: 'field', base: index, name: ctx.member!.name };
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
export function arrayAccess(
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
  how: { isStore: boolean; qualified: boolean } = { isStore: false, qualified: false },
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
    // the array the context declares, subscripted itself: agbcc's ARRAY_REF object (see above)
    if (baseExpr.k === 'addr') {
      const declared = declaredElementMember(baseExpr.name, bt, idxExpr, fieldOff, elemSize, signed, sym, how);
      if (declared !== null) {
        return declared;
      }
    }
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
