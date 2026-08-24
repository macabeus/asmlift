// asmlift — L2→L3 structuring: CFG + block-argument SSA → a structured AST.
//
// Three jobs:
//  1. SSA destruction WITH COALESCING — a merge block-argument that already carries a
//     variable's value on one path is coalesced to that variable, so only the
//     non-identity paths emit an assignment (reproducing agbcc's register allocation:
//     NOTE the coupled INVERSE: l3/regspell.ts re-derives the UN-coalesced copy-carrying
//     spelling as a ranked candidate — its R1 template matches THIS pass's diamond output
//     shape, so a change to coalescing here can silently stop that lever firing (the
//     matching-suite regspell gate is what makes the coupling loud).
//     the clamp0 diamond becomes `if (x < 0) x = 0; return x;` rather than a temp copy).
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
// Module layout: loop DISCOVERY is loops.ts; the pure ANALYSIS phase (use registry, liveness,
// materialization) is analysis.ts; comparison-tree switch recovery is switch-recover.ts
// (explicit-deps factory). THIS file keeps the mutually-entangled remainder: SSA-destruction
// coalescing (canTakeName + seeding) and emission (structureBlock + the loop emitters) — they
// share varName/backArgName mutation and the activeSub/loopCtx dynamic state.
//
// Scope: reducible single-latch natural loops — GUARDED self-loop `while` (the guard-fusion
// un-rotation), UNGUARDED self-loop `do-while` (single block, header === latch), test-at-top
// `while`, bottom-test `do-while`, PROPERLY-nested loops, in-body `break`/early-`return`,
// comparison-tree and jump-table `switch`. Still DECLINED (loud StructureError, never wrong
// code): multi-latch headers, irreducible/overlapping loops, conditional `continue`, a `break`
// whose exit copies would clobber, switch fall-through, and mixed-entry self-loops (a guarded
// header also entered by a plain br).
import { type GlobalCell, globalCellOf, mayWriteGlobal } from '../ir/alias';
import { Block, Fn, Op, Value, defOpMap, dominators, successorsOf } from '../ir/core';
import { EFFECTFUL_OPS } from '../ir/opcodes';
import { type IrType, T, scalarTypeForAccess, typeEquals } from '../ir/types';
import {
  BinOp,
  Expr,
  SFn,
  Stmt,
  SwitchCase,
  exprChildren,
  exprHasEffect,
  gapReasonFor,
  mapExprChildren,
  negateCond,
} from '../l3/ast';
import type { Gate } from '../l3/gates';
import { exprCType, provablyNonNegative, ptrElemBytes, renderedIntSignedness } from '../l3/typing';
import { returnType } from '../raise/recover';
import { collectStructs } from '../raise/structs';
import {
  type DeclaredField,
  type SymbolInfo,
  type SymbolStructField,
  arrayInnerExtents,
  declaredFields,
  isArrayField,
  isBitfieldField,
  isScalarCellSize,
  pointeeFields,
  scalarCellType,
} from '../symbols';
import { analyze } from './analysis';
import { makeLoopHazards, sunkCopyOverDroppedUndef, updateWriteSet } from './hazards';
import { analyzeLoops } from './loops';
import { type NameMerge, coalesceNames } from './namecoalesce';
import { type ArmExit, makeSwitchRecovery } from './switch-recover';

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
// `&gSym`, possibly wearing the value-context integer cast the additive lowering adds
// (`(u32)&gSym` — see lowerDef's addr-intify): both spell the same link-time constant, so the
// fold rules match through the cast and every access that CAN spell a named element still does.
// WIDTH 32 ONLY — a NARROWING cast (`(u8)&gSym`, from a zext/sext lowering) is a different
// VALUE (`addr & 0xFF`), and folding through it would read the named global at a wrong address
// (the adversarial round's probe: `*(u8*)(u8)&gSym` must keep its truncation, never become
// `*(u8*)&gSym` — let alone a confidently-named `gSym.field`).
function addrIn(e: Expr): Extract<Expr, { k: 'addr' }> | null {
  if (e.k === 'addr') {
    return e;
  }
  if (e.k === 'cast' && e.to.kind === 'int' && e.to.width === 32 && e.e.k === 'addr') {
    return e.e;
  }
  return null;
}

// If `e` is a global address `&gSym` (optionally `+ index`), return the global name and the
// element index (byte residual divided by the access width). `&gSym` alone → idx const 0;
// `&gSym + i` → idx `i / width` (exact division only — a non-multiple residual is a mid-element
// access this whole-global spelling can't express, so it declines to null and the caller casts).
function globalOf(e: Expr, width: number): { name: string; idx: Expr } | null {
  const top = addrIn(e);
  if (top) {
    return { name: top.name, idx: { k: 'const', value: 0 } };
  }
  if (e.k === 'bin' && e.op === '+') {
    for (const [side, other] of [
      [e.l, e.r],
      [e.r, e.l],
    ] as const) {
      const addrSide = addrIn(side);
      if (addrSide) {
        const idx = elementIndex(other, width);
        return idx ? { name: addrSide.name, idx } : null;
      }
    }
  }
  return null;
}

// THE one gate on the BARE-NAME array-global spelling (`gSym[i]` rather than `((T *)&gSym)[i]`),
// shared by the constant-offset and variable-index access paths so the two cannot disagree.
// Returns the `index` node's `lead` fragment when the bare form is spellable, or null to fall
// through to the always-valid `&gSym` cast form.
//
// Two facts are required, not one. The element WIDTH must match, as it always has. And the RANK
// must be SPELLABLE, because one subscript reaches an element only on a rank-1 array: on `u16
// g[4][0x400]`, `g[i]` is a ROW. Against the project's own header that is usually a type error,
// but where the row address flows into an integer context it is merely a warning and the emitted C
// then addresses a different object than the asm did — silently.
//
// A rank > 1 pins the leading dimensions at 0 and puts the whole flat element index in the last
// subscript (`g[0][i]`) — the same address arithmetic, and the idiom decomp sources themselves use
// when the split is not observable in the asm either (`gBgTilemapBufs[0][…]` in kleod,
// `gNatureStatTable[nature][…]` in pokeemerald). A rank the map states but cannot spell (an unknown
// inner extent) gets no bare form at all; `((T *)&gSym)[i]` is byte-identical and valid under ANY
// declaration, which is why it is the safe fallback. See symbols.ts arrayInnerExtents for why an
// ABSENT rank is read as 1 rather than as unknown.
function bareArrayLead(si: SymbolInfo, width: number, signed: boolean): { lead?: number[] } | null {
  if (si.shape !== 'array' || si.elemSize !== width) {
    return null;
  }
  // …and the element must EXTEND the way the access does, for the same reason the width must
  // match: the bare spelling carries no cast, so the declared element type is the only thing in
  // the emitted C that says whether a sub-word read sign- or zero-fills. Against the DECLARED
  // signedness, defaulted exactly as the element type registered for the env is (noteGlobal, just
  // below) — a disagreement there makes the deref legalization wrap the base, and a leading
  // subscript has no room for that wrapping.
  //
  // The caller then falls through to `((T *)&gSym)[i]`, byte-identical under any declaration.
  if (width < 4 && (si.elemSigned ?? false) !== signed) {
    return null;
  }
  const inner = arrayInnerExtents(si);
  return inner === null ? null : inner.length === 0 ? {} : { lead: new Array<number>(inner.length).fill(0) };
}

// A BYTE residual read as an ELEMENT index of `elemSize`-wide elements, or null when it is not one
// — the residual then addresses mid-element and no whole-element spelling can express it, so the
// caller falls through to the honest cast forms. THE one copy of the rule, indexing the
// `&gSym`-based array spelling: width 1 → the byte residual IS the index; wider → a constant
// residual must divide exactly, and a non-constant one must already be element-scaled
// (`i * elemSize` / `i << log2(elemSize)`), which is exactly what the asm's own index scaling
// produced.
function elementIndex(residual: Expr, elemSize: number): Expr | null {
  if (elemSize === 1) {
    return residual;
  }
  if (residual.k === 'const') {
    return residual.value % elemSize === 0 ? { k: 'const', value: residual.value / elemSize } : null;
  }
  if (residual.k === 'bin' && (residual.op === '*' || residual.op === '<<')) {
    const factor =
      residual.op === '<<'
        ? residual.r.k === 'const'
          ? 1 << residual.r.value
          : 0
        : residual.r.k === 'const'
          ? residual.r.value
          : 0;
    if (factor === elemSize) {
      return residual.l;
    }
  }
  return null;
}

/** The symbol-map rendering context threaded into memAccess/arrayAccess: shape facts per
 *  global name, plus a callback registering a global's env type (so the bare `gSym[i]` spelling,
 *  which must pass the stride check uncast, does). Absent ⇒ today's spellings. */
interface SymRenderCtx {
  info(name: string): SymbolInfo | undefined;
  noteGlobal(name: string, type: IrType): void;
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
 *  see the `needsIntSpelling` / pointer-global arithmetic rules below). Both denote the same
 *  address and add BYTES to it, so both fold here; a cast to any other pointer type is NOT looked
 *  through — a `(u16 *)` base would re-scale everything added after it. */
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

/** A pointer global's value, the constant bytes added to it, and the at-most-one variable term. */
interface PtrGlobalBase {
  name: string;
  byte: number;
  idx: Expr | null;
}

/** Decompose an access base into "the VALUE of a map-declared POINTER global + a constant byte
 *  offset + at most ONE variable term": `gPtr`, `gPtr + K`, `(u8 *)gPtr + i`, `(u8 *)gPtr + (i <<
 *  2) + K`. Null for anything else — two variable terms, no such global, a non-`+` operator —
 *  because only a single residual can be read as one member's index. */
function ptrGlobalBase(e: Expr, isPtrGlobal: (n: string) => boolean): PtrGlobalBase | null {
  let name: string | null = null;
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
    const global = ptrGlobalValueName(x);
    if (global !== null && name === null && isPtrGlobal(global)) {
      name = global;
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
  return ok && name !== null ? { name, byte, idx } : null;
}

/** Does a member declared at signedness `declared` read as EXACTLY the type the cast spelling this
 *  replaces would have produced — `scalarTypeForAccess(width, signed)`? That is the whole
 *  byte-exactness argument for naming a member instead of casting: same address, same read width,
 *  same C type, so every operator downstream compiles identically. A 4-byte access renders s32
 *  whatever the load said (the ISA has one word load), so only a SIGNED member may take its place;
 *  narrower accesses carry their own signedness and must match it. An undeclared signedness (the
 *  member is not a base type — a nested struct, an enum, a pointer) is never assumed to match.
 *  Compared against THE one copy of that rule (ir/types.ts) rather than restating it. */
function spellsAccessType(declared: boolean | undefined, width: number, signed: boolean): boolean {
  if (declared === undefined) {
    return false;
  }
  return typeEquals(T.int(width * 8, declared), scalarTypeForAccess(width, signed));
}

/** May a member be NAMED by an access of this direction, given the qualifiers on its declaration?
 *  The named spelling REPLACES a cast through `(u8 *)`, which carries no qualifier at all, so a
 *  qualifier the name reintroduces changes what the compiler emits:
 *    • `volatile` makes the access observable — the load may no longer be folded or reordered,
 *      which is a different instruction sequence (measured: 6 insns where the cast form was 5);
 *    • `const` under a STORE is a hard error, where the cast form merely cast the qualifier away.
 *  Either way the honest spelling is the cast form, so the member simply is not nameable here. */
function memberQualsAllow(f: SymbolStructField, containerConst: boolean | undefined, isStore: boolean): boolean {
  if (f.volatile) {
    return false;
  }
  return !(isStore && (f.const || containerConst));
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

/** `gPtr->member` for an access through a pointer global's value, or null when the offset is not
 *  provably ONE member's (see the block comment above). A VARIABLE index declines whatever it
 *  lands on — the indexed form is not byte-neutral and has no spelling here. */
function pointeeAccess(
  pg: PtrGlobalBase,
  off: number,
  width: number,
  signed: boolean,
  isStore: boolean,
  sym: SymRenderCtx,
): Expr | null {
  if (pg.idx !== null) {
    return null;
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
  if (sym) {
    const gb = globalConstByte(baseExpr, off);
    const si = gb ? sym.info(gb.name) : undefined;
    if (gb && si?.shape === 'struct') {
      // THE shared spellability predicate (symbols.ts), the same call declare.ts gates its struct
      // declaration on: a layout it declines whole is a layout with no nameable members, and a
      // union alias it drops for the first view at that offset is a name no declaration carries.
      // An ARRAY member is excluded for the same reason as in pointeeAccess: `u8 x[1]` would match
      // a byte access by (offset, size) and spell `.x`, which is not an lvalue of that width. A
      // BITFIELD member likewise — a plain read of its bytes is not a read of its bits (the named
      // bitfield spelling has its own recognizer, on the extract shape: see lowerDef).
      const fld = declaredFields(si.layout)?.find(
        (f) => f.offset === gb.byte && f.size === width && !isArrayField(f) && !isBitfieldField(f),
      );
      if (fld && memberQualsAllow(fld, si.const, isStore)) {
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
    const idx: Expr =
      off === 0
        ? idxVal
        : idxVal.k === 'const'
          ? { k: 'const', value: idxVal.value + off / width }
          : { k: 'bin', op: '+', l: idxVal, r: { k: 'const', value: off / width } };
    // ARRAY-declared global (symbol map): index the bare name — `gSym[i]`, the spelling the
    // dogfood proved agbcc needs for ROM tables — with the element type registered in the env
    // so the stride check passes and no cast is added. Element-width match only.
    const siArr = sym?.info(g.name);
    const lead = siArr === undefined ? null : bareArrayLead(siArr, width, signed);
    if (lead !== null) {
      sym!.noteGlobal(g.name, T.ptr(T.int(width * 8, siArr!.elemSigned ?? false)));
      return { k: 'index', base: { k: 'var', name: g.name }, idx, width, signed, ...lead };
    }
    return { k: 'index', base: { k: 'addr', name: g.name }, idx, width, signed };
  }
  const bt = base.type;
  if (bt.kind === 'ptr' && bt.to.kind === 'struct') {
    const rt = ctype(baseExpr);
    // `->` requires the base to render as a pointer to THIS struct (field names resolve against
    // its declaration) AND as a non-`index` node (the printer spells an index-node base with `.`,
    // the array-element form — wrong for a pointer). Anything else is cast to the recovered
    // struct pointer type; the cast node prints with `->`.
    const ok = rt?.kind === 'ptr' && rt.to.kind === 'struct' && rt.to.name === bt.to.name && baseExpr.k !== 'index';
    return { k: 'field', base: ok ? baseExpr : { k: 'cast', to: bt, e: baseExpr }, name: `field_${off}` };
  }
  return { k: 'index', base: baseExpr, idx: { k: 'const', value: off / width }, width, signed };
}

// A variable-index array access `base[index]`, or `base[index].field_K` when a `fieldOff` marks an
// array-of-STRUCT element (raise/struct-arrays.ts). The `.field` on an array element prints
// with `.` (the printer decides dot-vs-arrow from the base being an `index` node).
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
  elemSize: number,
  signed: boolean,
  ctype: (e: Expr) => IrType | undefined,
  sym?: SymRenderCtx,
): Expr {
  // A variable-index access off a global's address indexes the ADDRESS `&gSym` (the cast form
  // `((T *)&gSym)[i]` — valid for a struct global too, unlike casting the bare value). A
  // struct-array-of-globals (fieldOff) through `&gSym` is out of scope — fall through.
  if (baseExpr.k === 'addr' && fieldOff === undefined) {
    // ARRAY-declared global (symbol map): the bare-name spelling, same rule as memAccess.
    const si = sym?.info(baseExpr.name);
    const lead = si === undefined ? null : bareArrayLead(si, elemSize, signed);
    if (lead !== null) {
      sym!.noteGlobal(baseExpr.name, T.ptr(T.int(elemSize * 8, si!.elemSigned ?? false)));
      return { k: 'index', base: { k: 'var', name: baseExpr.name }, idx: idxExpr, width: elemSize, signed, ...lead };
    }
    return { k: 'index', base: baseExpr, idx: idxExpr, width: elemSize, signed };
  }
  const bt = base.type;
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
const ARITH_TO_BIN: Record<string, BinOp> = {
  add: '+',
  sub: '-',
  mul: '*',
  sdiv: '/',
  // the UNSIGNED quotient/remainder — the C backend spells them `/`/`%` over an operand it casts
  // unsigned (l3/ast.ts BinOp, backend/cfamily.ts C_SPELLING)
  udiv: '/u',
  smod: '%',
  umod: '%u',
  or: '|',
  and: '&',
  xor: '^',
  shl: '<<',
  shr_u: '>>>', // the LOGICAL right shift; the C backend spells it `>>` over an unsigned operand
  shr_s: '>>',
  logic_and: '&&',
  logic_or: '||', // short-circuit connectives (raise/shortcircuit.ts)
};

// The operators whose operand order the machine does not fix — candidates for the def-order
// re-spelling in lowerDef. `&&`/`||` are excluded: short-circuit order IS semantics.
const COMMUTATIVE_BIN: ReadonlySet<BinOp> = new Set(['+', '*', '&', '|', '^']);

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

// One early-`return` exit out of a loop body, and the blocks of it the loop emits inside its body
// (`earlyReturnArm` decides which). Per-EDGE rather than flattened into per-loop sets: ownership is
// decided against `from`, so a second edge into the same target is a separate question. `owned` has
// one reader, `emitDoWhile` — a `while` hoists no update, so it has no pre-update reads to exempt.
interface LoopArm {
  from: Block;
  to: Block;
  owned: Set<Block>;
}

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
}

// Opcodes whose NUMBER OF EXECUTIONS is observable. Moving one of these out of a loop changes what
// the program does — a call that ran per iteration would run once. A `load`/`aload` is deliberately
// NOT here: it is a pure read, so running it once instead of per-iteration is unobservable as long
// as it reads the same memory, which is exactly what the existing def→render barrier scan
// (structure/analysis.ts) already proves before it lets one inline at all.
const REPEATED_EFFECT = new Set(['call', 'opaque']);

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

// Structuring levers, threaded as DATA so a new one is a field here + its consumer, not a new
// positional boolean widened across every call site:
//   returnsVoid                    — from the function's own prototype (suppress phantom r0 return);
//   coalesceLoopInit               — keep the induction var in its arg register;
//   preserveDivergentBranchSense   — reproduce source branch direction on divergent ifs;
//   orderArgCopiesByComputation    — order edge copies by computation order in the predecessor.
// The last three are `compilerBehaviors` (target.ts) — this pass stays target-AGNOSTIC: it reads
// booleans, never a compiler name.
export interface StructureOptions {
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
  // This is the ZERO POINT of rank.ts's `/flip-join` axis, not a per-compiler fact that closes
  // the question — docs/level-tower.md wants a default only where the mapping is a FUNCTION, and
  // 19 of the benchmark's 856 rows still reach their winning spelling through the axis (4 of them
  // matches). Read it forward only: it says which sense to emit ABSENT evidence of an inversion,
  // never that the asm's layout WAS the source's sense. What agbcc contributes is the refusals —
  // its gcc Makefile SRCS compiles neither sched.c nor reorg.c and toplev.c never sets
  // flag_schedule_insns, and gcse.c runs one_code_hoisting_pass only `if (optimize_size)`, which
  // toplev.c sets for -Os alone — so no scheduler and no hoister moves an arm's body across the
  // branch after stmt.c laid the arms out in source order.
  //
  // Three mechanisms DO invert the sense, and each is per-SITE where this lever is per-function,
  // so no value here is right in every `if` of a function that holds several: a short-circuit
  // fold picks which successor is `taken` from the asm's branch polarity, which on Thumb the
  // branch RANGE decides (raise/shortcircuit.ts); a relay past a branch's reach inverts to jump
  // around the long form; and a rotated loop's zero-trip guard is an `if` no source wrote at all
  // (`synthetic:fib`, `for(i=0;i<n;i++)`, emits `if (0 >= a0) … else do{…}while`), so there no
  // spelling is the faithful one and only the differ can choose.
  negateJoinedBranchSense?: boolean;
  orderArgCopiesByComputation?: boolean;
  // Comparison-tree switch recovery: treat an `x != K` test as a case (the EQUAL side is a case
  // body). GCC freely uses `!=`; IDO prefers `==`/`<`. A per-compiler DATA lever, not an `arch ==`
  // branch — default true (permissive; the decline path keeps it sound either way).
  switchAllowsNeqCase?: boolean;
  // Comparison-tree switch recovery: treat a relational test whose BRANCH admits exactly one
  // scrutinee value as that case rather than as navigation. A per-compiler DATA lever declared in
  // TargetDescription.compilerBehaviors — a compiler opts in on evidence that its dispatch jumps
  // straight to a bounded subtree's body. Default false: absent, every relational edge navigates.
  switchAllowsBoundCase?: boolean;
  // Comparison-tree switch recovery: emit the case arms in the order the ASSEMBLY lays their
  // bodies out, rather than sorted by ascending case value. A per-compiler DATA lever declared in
  // TargetDescription.compilerBehaviors — a compiler opts in on evidence that it neither reorders
  // basic blocks nor schedules across them, so the layout it produced IS the order the source
  // wrote. Default false: absent, the arms keep the ascending spelling.
  switchArmsFollowLayout?: boolean;
  // Commutative load pairs re-spell in def (evaluation) order — see the swap in lowerDef. Default
  // true; verified byte-exact on agbcc and IDO. A per-compiler DATA lever declared in
  // TargetDescription.compilerBehaviors: the first compiler whose scheduler is shown re-ordering
  // independent loads flips it there, not in a code branch. A per-FUNCTION machine-order fallback
  // candidate is deliberately deferred until a row demands it.
  defOrderLoadPairs?: boolean;
  // Anchor a constant merge copy at its const op's ORIGINAL position instead of at the CFG edge:
  // `movs r9, #0` at entry ahead of a single-armed overwrite emits as a pre-initialization above
  // the `if`, not as its else-arm. A differ-refereed candidate axis (rank.ts `/defsite`), never a
  // default — see the refusal conditions where it is computed.
  anchorConstCopies?: boolean;
  // HARDWARE fact from TargetDescription.capabilities.endianness, threaded by structureOptionsFor:
  // the bitfield extract recognizer solves an LSB-first equation, so it only runs on little-endian
  // data. The provider already refuses to EMIT bitfield facts for a big-endian ELF; this is the
  // same boundary enforced on core's side, against a hand-built map that never went through it.
  littleEndian?: boolean;
  // Spell `(x << a) >> b` extracts of a struct global as the map's named bitfield member. On by
  // default; rank.ts enumerates the OFF spelling as the `/no-bitfield` axis, because the named
  // read recompiles at the DECLARATION's access width — where that diverges from the asm's load
  // width the honest shift spelling is the one that matches, and the differ referees. Only the map
  // carries the names, so with no `symbols` this is normalized to false whatever a caller passes.
  spellBitfieldMembers?: boolean;
  // Let a read of a named global render at its use across writes that PROVABLY cannot reach it
  // (a store to a different named global), instead of caching it in a local. Off by default;
  // rank.ts enumerates the ON spelling as the `/reread-globals` axis — see analysis.ts
  // AnalyzeOptions for why this is a differ-refereed lever and not a fix.
  rereadGlobals?: boolean;
  // Materialize a load that feeds a `cond_br` join arg, so the naming walk can home the join in
  // it and the identity arm elides to a one-sided in-place `if`. Off by default; rank.ts
  // enumerates the ON spelling as the `/inplace` axis — see analysis.ts AnalyzeOptions.
  materializeJoinFeeds?: boolean;
  // Materialize a pure computed address shared by 2+ memory accesses, and the multi-render loads
  // through it, reproducing the source's pointer-local + scalar-temp spelling. Off by default;
  // rank.ts enumerates the ON spelling as the `/addr-home` axis — see analysis.ts AnalyzeOptions.
  homeSharedAddresses?: boolean;
  // Materialize a pure value with 2+ distinct consumers, at least one of them inside a loop the
  // def sits outside — the register the compiler holds across the iterations. Off by default;
  // rank.ts enumerates the ON spelling as the `/expr-home` axis — see analysis.ts AnalyzeOptions.
  homeLoopExprs?: boolean;
  // Materialize a pure value with 2+ consumers standing on a memory read — the register the asm
  // carried the DERIVED value in, where the read's own home is a register that died at the
  // computation. Off by default; rank.ts enumerates the ON spelling as the `/derived-home` axis —
  // see analysis.ts AnalyzeOptions.
  homeDerivedReads?: boolean;
  // Emit a memory read as a named temp in ITS OWN block when every place it renders sits in a
  // block that block strictly dominates. A per-compiler DATA lever (TargetDescription
  // .compilerBehaviors), not a differ-refereed axis: where the compiler has neither a scheduler
  // nor a code hoister, the sunk spelling is one it could not have emitted from this asm, so there
  // is nothing to referee. Absent ⇒ off — the target field carries the evidence a compiler owes,
  // analysis.ts AnalyzeOptions the refusals.
  readsStayWhereWritten?: boolean;
  // Spell unsigned compares unsigned: cast an icmp_u* operand where the rendered operands do not
  // guarantee it, and reconcile a mixed-claimant declaration to u32 when nothing under the name
  // needs signed. Off by default: a signed spelling that byte-matched was PROVED non-negative by
  // the compiler (it emits the unsigned branch from signed compares only then), so which spelling
  // the source used is genuinely ambiguous at emission — rank.ts enumerates the ON spelling as
  // the `/uns-cmp` axis and the differ referees.
  unsignedCompareSpelling?: boolean;
  // Merge two variables that a merge copy would join, when the values under them never interfere
  // (structure/namecoalesce.ts). Off by default; rank.ts enumerates the ON spelling as the
  // `/merge-names` axis. Which variables the compiler's own coalescer shared is not derivable from
  // the naming, and removing a copy is worth less than it looks — the compiler coalesces most of
  // them itself. What moves the score is which values share a register, and that splits per
  // function. Over the whole benchmark the axis wins one row by 3 points and loses none, which is
  // what a differ-refereed spelling looks like.
  coalesceMergeNames?: boolean;
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
}

/** Test-only seams. SEPARATE from `StructureOptions` on purpose: `structureOptionsFor` builds that
 *  one by spreading a target's `compilerBehaviors`, whose fields map 1:1 onto it, so a hook living
 *  there would be settable from a TargetDescription. */
export interface StructureHooks {
  /** `coalesceMergeNames`'s admission rules, so a test can run the pass with one gate DROPPED —
   *  the ablation as a value rather than as a flag compiled into the shipped path. */
  nameCoalesceGates?: readonly Gate<NameMerge>[];
}

/** A CANDIDATE SPELLING MUST NEVER UNLOCK A FUNCTION THE PRIMARY DECLINES. `varName` is not only
 *  how values are spelled — the loop emitters' hazard predicates read it, and several ask "does
 *  this edge copy survive identity elision", which merging two names quietly answers `no`. A pass
 *  that made a hazard invisible would trade a loud decline for a silent wrong answer, so the
 *  lever-less structuring runs first and its refusal stands. That is the whole invariant, rather
 *  than a list of individually patched guards, and it costs one extra structuring — nothing next to
 *  the compile the candidate exists to feed.
 *
 *  It rests on `structure()` not mutating `fn`, which `structure-purity.test.ts` pins.
 *
 *  SCOPE: refusals thrown by `structure()` itself. A decline can also come from `structureChecked`'s
 *  boundary contracts, which run OUTSIDE it — `rank.ts` closes that half, where the contracts are. */
function assertPrimaryAccepts(fn: Fn, opts: StructureOptions, hooks: StructureHooks): void {
  structure(
    fn,
    {
      ...opts,
      coalesceMergeNames: false,
      materializeJoinFeeds: false,
      homeSharedAddresses: false,
      homeLoopExprs: false,
      homeDerivedReads: false,
    },
    hooks,
  );
}

export function structure(fn: Fn, opts: StructureOptions = {}, hooks: StructureHooks = {}): SFn {
  const {
    returnsVoid = false,
    coalesceLoopInit = false,
    preserveDivergentBranchSense = true,
    negateJoinedBranchSense = preserveDivergentBranchSense,
    orderArgCopiesByComputation = true,
    switchAllowsNeqCase = true,
    switchAllowsBoundCase = false,
    switchArmsFollowLayout = false,
    defOrderLoadPairs = true,
    anchorConstCopies = false,
    littleEndian = true,
    spellBitfieldMembers: bitfieldSpellingWanted = true,
    rereadGlobals = false,
    materializeJoinFeeds = false,
    homeSharedAddresses = false,
    homeLoopExprs = false,
    homeDerivedReads = false,
    readsStayWhereWritten = false,
    unsignedCompareSpelling = false,
    coalesceMergeNames = false,
    onGap = 'strict',
    symbols,
  } = opts;
  // Only the MAP makes the named bitfield spelling available, so with no map this is not a choice.
  // Normalized once here rather than left to each reader's own `symCtx &&` guard, because rank.ts's
  // `/no-bitfield` decline rests on both arms structuring the IDENTICAL tree without a map — a
  // second reader added outside that guard would otherwise delete a candidate silently, and nothing
  // reports a candidate that was never enumerated (bitfield-members.test.ts).
  const spellBitfieldMembers = symbols !== undefined && bitfieldSpellingWanted;
  // These levers all change which edge copies elide as identities (extra materialization does
  // too), which the loop emitters' hazard predicates read — so the invariant above covers each.
  // A per-compiler DEFAULT is not among them, however much it materializes: the primary IS this
  // target's defaults, so resetting one would probe a spelling asmlift never emits here.
  if (coalesceMergeNames || materializeJoinFeeds || homeSharedAddresses || homeLoopExprs || homeDerivedReads) {
    assertPrimaryAccepts(fn, opts, hooks);
  }
  const defs = defOpMap(fn);
  const preds = predecessorBlocks(fn);
  const ipdom = postDominators(fn);
  const dom = dominators(fn);

  // ── analysis phase (structure/analysis.ts): use registry, liveness, materialization ──
  const { useSitesOf, opIndex, opBlock, liveIn, materialize, reachFrom, emitPos, memWriteBetween } = analyze(
    fn,
    returnsVoid,
    {
      defs,
      dom,
      rereadGlobals,
      materializeJoinFeeds,
      homeSharedAddresses,
      homeLoopExprs,
      homeDerivedReads,
      readsStayWhereWritten,
      // the map's own declaration truth: a volatile object's read may not be duplicated or moved
      volatileGlobal: (n) => {
        const si = symbols?.get(n);
        return si?.volatile === true || (si?.layout ?? []).some((f) => f.volatile === true);
      },
    },
  );

  // SCALAR-vs-AGGREGATE globals: a `gaddr` symbol accessed EXCLUSIVELY at offset 0 is a scalar
  // global → the bare name `gSym` (byte-exact, matches the source). A symbol accessed at any
  // non-zero offset (or via a variable index) is an array/struct global → EVERY access uses the
  // `((T *)&gSym)[i]` address-cast form (a struct value does not decay, so casting the bare name is
  // invalid C; casting the address is valid and byte-exact). Computed once here.
  //
  // Only the offset set is tracked, not width: a single symbol read at off-0 with two DIFFERENT
  // widths is a union/type-pun, which the downstream struct-layout recovery rejects LOUD
  // ("overlapping fields ... unions not modelled") before this classification is consumed — so a
  // width collision at off-0 declines honestly rather than reaching a wrong bare-`gSym` emission.
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
        } else if (op.opcode === 'call') {
          // a CALLEE's name is in this namespace too: a function really named sp0 would be
          // shadowed by the minted local, and `sp0()` on a u16 object is a compile error
          taken.add(op.attrs.target as string);
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
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'laddr') {
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
          undefNames.set(op, mint(`uninit_${String(op.attrs.key).replace('@', '')}`));
        }
      }
    }
    return { laddr: names, undef: undefNames };
  })();

  const scalarGlobals = new Set<string>();
  {
    const offsets = new Map<string, Set<number>>();
    const bumpAgg = (sym: string) => offsets.set(sym, new Set([-1])); // -1 marks "variable index"
    for (const b of fn.blocks) {
      for (const op of b.ops) {
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
      if (offs.size === 1 && offs.has(0)) {
        scalarGlobals.add(sym);
      }
    }
    // Declaration-shape OVERRIDE (symbol map): a project-declared array/struct global is an
    // AGGREGATE whatever the usage inference saw — a lone off-0 access to `extern u16 tbl[]`
    // must still spell through the aggregate/array forms, never the bare scalar `tbl`.
    // Driven from the FUNCTION's own globals, for the same reason the name minter above consults
    // the map instead of copying it: a name outside `scalarGlobals` has nothing to override.
    if (symbols) {
      for (const n of [...scalarGlobals]) {
        const shape = symbols.get(n)?.shape;
        if (shape === 'array' || shape === 'struct') {
          scalarGlobals.delete(n);
        }
      }
    }
  }

  // Symbol-map rendering context (memAccess/arrayAccess): shape lookups + the env registry for
  // array-shaped globals actually referenced (they surface as SFn.globals — typed, undeclared).
  const shapedGlobalTypes = new Map<string, IrType>();
  const symCtx: SymRenderCtx | undefined = symbols
    ? { info: (n) => symbols.get(n), noteGlobal: (n, t) => shapedGlobalTypes.set(n, t) }
    : undefined;

  /** A bare `gSym` naming a map-declared POINTER global — the VALUE of a pointer cell. Load,
   *  store and compare of that 4-byte cell are identical for any object-pointer type, so the
   *  declared pointee never matters to THEM; arithmetic on the loaded value is the opposite case,
   *  where the pointee's size scales what is added and every stride must therefore be made
   *  explicit (`(u8 *)gPtr + K`). `ctype` cannot see any of this: it types only params/locals, so
   *  a pointer global renders `undefined` there. */
  const isPtrGlobal = (x: Expr): boolean => x.k === 'var' && symCtx?.info(x.name)?.shape === 'pointer';

  /** Operands `-`/`~` cannot take as spelled: a rendered pointer, a bare `&gSym`, a pointer
   *  global's value. All three are ill-formed C under a unary arithmetic operator — the asm did
   *  32-bit integer math on the address, so that is what gets spelled. */
  const needsIntSpelling = (x: Expr): boolean => ctype(x)?.kind === 'ptr' || x.k === 'addr' || isPtrGlobal(x);

  // --- loop discovery (loops.ts): natural loops via dominator back-edges + the nesting forest ---
  const forest = analyzeLoops(fn, dom);

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
              P.ops.every((o) => !EFFECTFUL_OPS.has(o.opcode) && !materialize.has(o)) &&
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
  // declines to plain if-recovery, which re-enters the header and fails loud via `onStack`.
  const isRet = (blk: Block) => blk.ops[blk.ops.length - 1]?.opcode === 'ret';
  // An early `return` out of the loop: forward-walking from `to` WITHOUT re-entering the loop `body`,
  // every path terminates in a `ret`. agbcc/gcc merge every `return` into ONE epilogue block and each
  // return site just sets the return register and branches there, so a second body exit that lands on
  // such a chain is an early RETURN, not a break to a live merge — which is what lets two returns
  // merged through a shared `bx lr` recover as a `while` with an in-body early `return` instead of
  // declining as "multi-exit".
  //
  // The arm is structured AT the edge, so any block in it that a second path also reaches is emitted
  // twice. A duplicated `return v` is harmless — both copies sit on mutually exclusive paths, so this
  // is a FIDELITY rule, not a soundness one: a store or call written twice is source no compiler
  // would have produced from this asm, and the region it drags along is unbounded. A block escapes
  // that on two counts. `from` dominates `to` and `to` dominates the block, so every path reaching it
  // runs this edge's predecessor and then this region — and only one edge into `to` can satisfy the
  // first half, since two predecessors cannot both dominate it. And the region must not be reachable
  // from the loop's own exit, which dominance does NOT rule out: an arm landing straight on the
  // post-loop join dominates itself, and claiming it would emit the epilogue on both paths. Testing
  // `to` covers the whole region — a block dominated by `to` that the exit reached would mean the
  // exit reached `to`. The shared epilogue an arm branches to still has to be pure.
  //
  // Returns the blocks the arm OWNS — its exclusive part, which the loop emits inside its body, ahead
  // of the update — or null when this is not an early-`return` arm.
  const earlyReturnArm = (from: Block, to: Block, body: Set<Block>, exit: Block): Set<Block> | null => {
    const entryOwned = dom.get(to)!.has(from) && to !== exit && !reachFrom(exit).has(to);
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
      if (entryOwned && dom.get(bb)!.has(to)) {
        owned.add(bb);
      } else if (bb.ops.some((op) => EFFECTFUL_OPS.has(op.opcode))) {
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
  };
  const whileLoops = new Map<Block, WhileLoopInfo>();
  const doWhileLoops = new Map<Block, DoWhileInfo>();
  for (const nl of forest.byHeader.values()) {
    const h = nl.header;
    if (nl.selfLoop && loops.has(h)) {
      continue;
    } // guarded self-loops use emitWhile (above); UNGUARDED ones are single-block do-whiles
    if (!nl.selfLoop && nl.latches.length !== 1) {
      continue;
    } // single latch only
    const latch = nl.selfLoop ? h : nl.latches[0];
    // Nested loops: an inner loop whose header sits in this body is fine ONLY if it is PROPERLY
    // nested — its ENTIRE body is contained in ours (a forest descendant). Structuring then recurses
    // naturally: when the outer body reaches the inner header, structureBlock dispatches to the inner's
    // own emitWhile/emitDoWhile. An OVERLAPPING loop (shared blocks, neither containing the other →
    // irreducible) DECLINES. If a contained inner is itself unstructurable, the outer's body
    // structuring loud-fails at the inner back-edge (onStack) — a safe decline, not a miscompile.
    if (
      [...forest.byHeader.keys()].some(
        (h2) => h2 !== h && nl.body.has(h2) && ![...forest.byHeader.get(h2)!.body].every((b) => nl.body.has(b)),
      )
    ) {
      continue;
    }
    // Reducible entry (single-entry): every body block except the header is entered ONLY from
    // inside the body — no jump into the loop interior.
    let reducible = true;
    for (const bb of nl.body) {
      if (bb === h) {
        continue;
      }
      if ((preds.get(bb) ?? []).some((p) => !nl.body.has(p))) {
        reducible = false;
        break;
      }
    }
    if (!reducible) {
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
    const headerPure = !h.ops.some((op) => EFFECTFUL_OPS.has(op.opcode) || materialize.has(op));

    let exitFrom: Block,
      exit: Block,
      kind: 'while' | 'dowhile',
      bodyEntry: Block | null = null;
    if (!nl.selfLoop && hTerm.opcode === 'cond_br' && hInBody.length === 1 && hOut.length === 1 && headerPure) {
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
    // the body must be an early `return` (`earlyReturnArm`) or a ret-terminated target. A second exit
    // that lands on a LIVE non-return merge is a genuine `break`/second structured exit → decline.
    // The arms are kept: emission needs to know which edges out of the body end an iteration rather
    // than continue it.
    const arms: LoopArm[] = [];
    let singleExit = true;
    for (const e of nl.exitEdges) {
      if (e.from === exitFrom && e.to === exit) {
        continue;
      }
      const owned = earlyReturnArm(e.from, e.to, nl.body, exit);
      if (owned) {
        arms.push({ from: e.from, to: e.to, owned });
      } else if (!isRet(e.to)) {
        singleExit = false;
        break;
      }
    }
    if (!singleExit) {
      continue;
    }

    if (kind === 'while') {
      whileLoops.set(h, {
        header: h,
        bodyEntry: bodyEntry!,
        exit,
        latch,
        forwardPreds: nl.forwardPreds,
        body: nl.body,
        arms,
      });
    } else {
      doWhileLoops.set(h, { header: h, latch, exit, forwardPreds: nl.forwardPreds, body: nl.body, arms });
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
  const backArgName = new Map<Value, string>();
  // The C static type of a rendered expression, over the declared variable types — what decides
  // whether a memory access's base may be dereferenced as spelled (memAccess/arrayAccess).
  const vtEnv = (n: string): IrType | undefined => varType.get(n);
  const ctype = (e0: Expr): IrType | undefined => exprCType(e0, vtEnv);

  /** `&gSym` assigned to a `T *` local: the address of an AGGREGATE is not a pointer to its
   *  element. `&gArr` is `T (*)[n]`, `&gStruct` is `struct S *`, and neither is assignable to
   *  `T *` — yet the IR's `gaddr` value legitimately has type `T *`, because that is what the asm
   *  loaded. The bare spelling therefore states a type the project's own header contradicts.
   *
   *  It survived because agbcc only WARNS ("assignment from incompatible pointer type") and
   *  computes the right address anyway. That leniency is not something to rely on: the Klonoa
   *  project's own build template treats these as fatal, so the row's emitted C does not build
   *  where its author would put it. The cast is the always-valid spelling — the same fallback
   *  `bareArrayLead` documents for the indexed form — and it is byte-identical, so no benchmark row
   *  moves either way and the rule that decides it is pinned in test/deref-typing.test.ts instead.
   *
   *  The test is whether `&gSym`'s rendered type PROVABLY equals the destination's, not whether the
   *  symbol looks like an aggregate. A shape enumeration got this wrong three ways, each a real
   *  miss: `shape:'pointer'` declares a pointer cell (`void *gSym`, or `struct Tag *gSym` when the
   *  pointee has a declarable layout), so `&gSym` is a pointer-to-pointer either way; a `shape:'scalar'`
   *  whose width differs from the destination's pointee gives `s32 *` for a `u16 *` slot; and a
   *  NAME-ONLY symbol is synthesized as `extern u32 gSym;` (declare.ts), which is `u32 *` — not the
   *  `T *` the older comment here claimed. So the default is to CAST, and the cast is omitted only
   *  where the declared cell type is known and matches exactly. Byte-identical either way, so the
   *  cost of casting one time too many is a redundant `(T *)`, never a wrong address. */
  const castAggregateAddr = (name: string, value: Expr): Expr => {
    const t = varType.get(name);
    if (t?.kind !== 'ptr' || value.k !== 'addr') {
      return value;
    }
    // The only provably-redundant case: a NON-VOLATILE scalar cell whose DECLARED type is the
    // destination's pointee, where `&gSym` already denotes exactly `T *`.
    //
    // `scalarCellType` and not `scalarTypeForAccess`: the latter answers what an ACCESS of that
    // width reads and collapses every 4-byte access to `s32`, so it called a `u32` cell equal to an
    // `s32 *` destination and let the incompatible assignment through. And a `volatile` cell makes
    // `&gSym` a `volatile T *`, so omitting the cast would DISCARD the qualifier — the same class of
    // fatal-under-a-strict-build defect this rule exists to remove.
    const si = symCtx?.info(value.name);
    if (si?.shape === 'scalar' && !si.volatile && isScalarCellSize(si.size)) {
      if (typeEquals(scalarCellType(si.size, si.signed), t.to)) {
        return value;
      }
    }
    return { k: 'cast', to: t, e: value };
  };

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
  // also runs on the final (exiting) iteration — so the test is `p` live into the writer's block
  // OR live out of any of its predecessors (the conservative union covers that placement). A
  // materialized def under the name writes at its own block. This applies even to a
  // redundant-phi alias (`pureAlias` waives only the value-at-B check: aliasing is sound at B's
  // entry, but a later write to the shared name still splits them — e.g. a saved pre-increment
  // `i` read post-loop).
  const paramBlock = new Map<Value, Block>();
  for (const blk of fn.blocks) {
    for (const pv of blk.params) {
      paramBlock.set(pv, blk);
    }
  }
  const canTakeName = (p: Value, B: Block, name: string, pureAlias = false): boolean => {
    if (B.params.some((q) => q !== p && varName.get(q) === name)) {
      return false;
    }
    const lin = liveIn.get(B)!;
    for (const [v, n] of varName) {
      if (n !== name || v === p) {
        continue;
      }
      if (!pureAlias && lin.has(v)) {
        return false;
      } // v still live at B → p's copies clobber it
      const wblk = paramBlock.get(v);
      if (wblk && wblk !== entry) {
        // v is a param → `name` written at wblk's edges
        if (liveIn.get(wblk)!.has(p)) {
          return false;
        }
        for (const pr of preds.get(wblk) ?? []) {
          for (const s of successorsOf(pr)) {
            if (liveIn.get(s)!.has(p)) {
              return false;
            }
          }
        }
      }
      const d = defs.get(v);
      if (d && materialize.has(d) && liveIn.get(opBlock.get(d)!)!.has(p)) {
        return false;
      }
    }
    return true;
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
  // ONE seeding routine for self-loop and structured-loop headers. On a coalesceLoopInit target,
  // keep the induction variable in its entry (forward-edge) value's register — reproducing a
  // compiler that mutates the arg register across the loop instead of copying to a fresh local,
  // so the init copy vanishes. The loop mutates the adopted name every iteration — canTakeName
  // declines it when any value under it is still live at the header. `exclude` are names never to
  // adopt (enclosing loops' induction vars — the cross-level collision below); every seeded
  // param's name is ADDED to it, so sibling params can't collapse.
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
        // A MATERIALIZED back-edge arg is this variable's in-place update (`add r4, r4, r0`
        // mutates the same register the param lives in) — adopt its name so the def assigns the
        // loop variable directly and the update copy elides. Sound only when every read of the
        // param sits at-or-before the def in the header (the def's own operands included): the
        // assignment splits the iteration into old-value-before / new-value-after, and a later
        // read of the OLD value would silently get the new one — position-granular, because
        // liveness is block-granular and the param is killed from its own block's liveIn.
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
            (useSitesOf.get(p) ?? []).every((s) => s.blk === header && s.idx <= opIndex.get(d)!) &&
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
      if (backArgs) {
        backArgName.set(backArgs[i], varName.get(p)!);
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
  const structuredLoops = [
    ...[...whileLoops.values()].map((l) => ({
      header: l.header,
      latch: l.latch,
      forwardPreds: l.forwardPreds,
      body: l.body,
    })),
    ...[...doWhileLoops.values()].map((l) => ({
      header: l.header,
      latch: l.latch,
      forwardPreds: l.forwardPreds,
      body: l.body,
    })),
  ];
  // Cross-level collision: with nesting, an outer loop's induction variable is LIVE across the inner
  // loop (the outer latch reads it after). If the inner var is coalesced onto the outer var's name
  // (its init reads the outer var), the inner loop would MUTATE the outer variable — a silent
  // miscompile. Process OUTERMOST-first (so an enclosing loop is named first) and, per loop, exclude
  // the names of every enclosing loop's header params from the coalescing candidates.
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
    const back = successorTo(l.latch, l.header);
    // exclusion seeded with enclosing-loop names → never coalesce onto them
    seedLoopParams(l.header, l.forwardPreds, back ? back.args : null, enclosingNames(l));
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
        // EVERY in-edge record, not successorTo (which returns only the FIRST record to `b` — a
        // terminator with two edges to the same block would hide the second edge's args here).
        const incoming: { v: Value; pr: Block }[] = [];
        for (const pr of new Set(preds.get(b) ?? [])) {
          for (const s of pr.ops[pr.ops.length - 1].successors) {
            if (s.block === b) {
              incoming.push({ v: s.args[i], pr });
            }
          }
        }
        // A redundant phi (every edge passes the SAME value) is a pure alias of it — sharing the
        // name is sound even while the value stays live (they are equal on every path). This
        // waives only the LIVENESS half of canTakeName; the sibling-param check always applies.
        const allSame = incoming.length > 0 && incoming.every((c) => c.v === incoming[0].v);
        // prefer a carrier that already has a name; then a loop var whose update this receives —
        // but only one whose name survives the C3 interference check (else the edge copies into
        // the name would clobber a still-live value).
        let name: string | undefined;
        for (const c of [
          ...incoming.filter((c) => varName.has(c.v)),
          ...incoming.filter((c) => backArgName.has(c.v)),
        ]) {
          const nm = varName.get(c.v) ?? backArgName.get(c.v)!;
          if (!carriesPreUpdate(c.v, c.pr, b) && canTakeName(p, b, nm, allSame)) {
            name = nm;
            break;
          }
        }
        name ??= `v${fresh++}`;
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
  // declarations reconcile; the flip is byte-invariant everywhere but the compares and unsigned
  // divisions it corrects (+/-/*/&/|/^/<< are sign-blind, `>>` self-corrects via the backend's
  // shiftOperand cast, a udiv/umod renders `/`/`%` unsigned through the flipped operand — the
  // machine's own division — and SIGNED division is evidence-blocked).
  if (unsignedCompareSpelling) {
    // Signed-use evidence is the TRANSITIVE INPUT CONE of every signed op — a claimant can feed
    // an icmp_slt through an inline `sub` and the flip would still render that compare unsigned
    // (`v - 5 >= 0`, always true in C), so direct operands are not enough. The cone also crosses
    // edge arg↔param identities in BOTH directions: a kept-guard's substitution (gsub) renders an
    // init ARG under the loop variable's name, so a signed guard over the arg is evidence against
    // the name even though the arg claims it in neither naming map. Over-tainting only blocks
    // flips: conservative-safe.
    const SIGNED_USE = new Set(['icmp_slt', 'icmp_sle', 'icmp_sgt', 'icmp_sge', 'sdiv', 'smod', 'shr_s']);
    const edgePeers = new Map<Value, Value[]>();
    for (const b of fn.blocks) {
      const term = b.ops[b.ops.length - 1];
      for (const sx of term?.successors ?? []) {
        sx.args.forEach((a, i) => {
          const pv = sx.block.params[i];
          if (pv !== undefined) {
            (edgePeers.get(a) ?? edgePeers.set(a, []).get(a)!).push(pv);
            (edgePeers.get(pv) ?? edgePeers.set(pv, []).get(pv)!).push(a);
          }
        });
      }
    }
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
    // is the sign-pin axis's dimension.
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
  //   - the merge is a loop header (loop copies have their own placement discipline);
  //   - the const's block does not dominate every edge source passing it (the anchored write
  //     must precede the edge on every path);
  //   - the const's block or any edge source sits inside ANY loop. Block-level dominance does
  //     not give per-ITERATION precedence — a path may pass the def in iteration 1 and take the
  //     suppressed edge in iteration 2 with the variable overwritten in between, the /preinit
  //     sticky-arm failure class (PR #13) — so in-loop shapes are declined outright;
  //   - the merge variable names any OTHER SSA value (a shared name has readers and writers
  //     between the def site and the edge that edge placement respects and anchoring would not);
  //   - another anchored const of the same variable lies on a path from this one to this one's
  //     edge (the later write would clobber this arg's value; both stay at their edges instead).
  const anchoredAt = new Map<Op, { name: string; arg: Value }[]>();
  const suppressedArgs = new Map<object, Set<number>>();
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
    for (const M of fn.blocks) {
      if (M === entry || M.params.length === 0 || forest.byHeader.has(M)) {
        continue;
      }
      M.params.forEach((p, i) => {
        const name = varName.get(p)!;
        if (nameCount.get(name) !== 1) {
          return;
        }
        // every in-edge record into M, grouped by the SSA value it passes for param i
        const groups = new Map<Value, { rec: { block: Block; args: Value[] }; src: Block }[]>();
        for (const pr of new Set(preds.get(M) ?? [])) {
          for (const s of pr.ops[pr.ops.length - 1].successors) {
            if (s.block === M) {
              const g = groups.get(s.args[i]);
              if (g) {
                g.push({ rec: s, src: pr });
              } else {
                groups.set(s.args[i], [{ rec: s, src: pr }]);
              }
            }
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

  // ── BITFIELD member reads (symbol map) ──────────────────────────────────────────────────────
  // The `(x << a) >> b` extract of a struct global's loaded bytes IS a bitfield access when the
  // map declares a bitfield at exactly those bits: spelled `gSym.field`, the source form, whose
  // declared `u32 field : n` then makes C's own integer promotion reproduce the signedness every
  // downstream operator compiled with (a 7-bit unsigned field promotes to signed int — sdiv
  // renders `/` and recompiles to __divsi3, where the raw-shift spelling stays u32).
  //
  // Semantically EXACT, never approximate: the window must lie inside the loaded bytes (so the
  // load's extension bits cannot reach it), the field's position, width and signedness must all
  // match the extract (a logical shift is an unsigned read, an arithmetic one a signed read —
  // a signless field never matches), and the member must be nameable at all (memberQualsAllow;
  // the map only carries bitfield facts for little-endian ELFs — see SymbolStructField). Any
  // mismatch keeps the honest shift spelling.
  //
  // Precomputed over the ops (not folded during rendering) for the load's sake: a load whose
  // EVERY use is a spelled extract chain must not also emit its materialized `v = *(u16 *)&g;`
  // temp — the compiler CSEs the repeated member reads back to one load, but the leftover temp
  // would be a second one. A VOLATILE container refuses the whole fold: N member reads are N
  // volatile accesses where the asm did one load. (Byte-level residual, differ-refereed: a load
  // only PARTIALLY absorbed — one extract spelled, another use kept — emits both the temp and
  // the named reads, one load more than the asm; semantics hold, the score decides.)
  //
  // ORDERING GATE (adversarial round, CRITICAL 1 — twice): the named spelling replaces a
  // REGISTER value — the bits captured at the load's program position — with a fresh memory
  // read at each render position. Every other memory read in this file goes through the
  // materialization model (analysis.ts) for exactly that hazard, so the fold clears the SAME
  // bar with the SAME machinery: `emitPos` resolves where each extract actually renders
  // (transitively through its inlining consumers — an unresolvable position refuses), and
  // `memWriteBetween` walks every def-avoiding load→render path for a call, an opaque, or a
  // store not provably to a DIFFERENT named global. Path-based on purpose: the second audit
  // pass broke the first fix's linear-position scan with a block laid out AFTER the render in
  // address order but executing between load and render on the taken path — fn.blocks order is
  // address order, not topological order.
  const bitfieldSpelling = new Map<Op, { global: string; field: string }>();
  const absorbedLoads = new Set<Op>();
  if (symCtx && littleEndian && spellBitfieldMembers) {
    // the (name, byte) of a load's address when it resolves through defs alone — `gaddr` or
    // `add(gaddr, const)`; anything else (a materialized base, a variable index) declines. THE
    // shared L2 disjointness query (ir/alias.ts), which the materialization model consults with
    // the same rule, so the fold and the model cannot disagree about what a store can reach.
    const loadTargets = new Map<Op, GlobalCell>();
    const addrOf = (v: Value, off: number): GlobalCell | null => globalCellOf(defs, v, off);
    // A write for the fold's purposes: calls and opaques always; a store/astore unless its base
    // resolves to a global PROVABLY different from the folded one.
    const mayWrite = (sym: string) => mayWriteGlobal(defs, sym);
    for (const blk of fn.blocks) {
      for (const op of blk.ops) {
        if ((op.opcode !== 'shr_u' && op.opcode !== 'shr_s') || op.operands.length !== 1) {
          continue;
        }
        const b = op.attrs.imm as number | undefined;
        const inner = defs.get(op.operands[0]);
        if (typeof b !== 'number' || b <= 0 || b >= 32 || inner?.opcode !== 'shl' || inner.operands.length !== 1) {
          continue;
        }
        const a = inner.attrs.imm as number | undefined;
        if (typeof a !== 'number' || a < 0 || b < a) {
          continue;
        }
        const w = 32 - b; // extract width
        const lo = b - a; // low bit within the loaded value
        const load = defs.get(inner.operands[0]);
        if (load?.opcode !== 'load' || lo + w > (load.attrs.width as number) * 8) {
          continue;
        }
        // a materialized shl would still emit its `v = x << a` temp reading the load — the fold
        // would then ADD member reads on top of it; rare, refuse
        if (materialize.has(inner)) {
          continue;
        }
        const gb = addrOf(load.operands[0], load.attrs.off as number);
        const si = gb ? symCtx.info(gb.name) : undefined;
        if (!gb || si?.shape !== 'struct' || si.volatile) {
          continue;
        }
        // where does the member read RENDER? at the extract's own position when materialized,
        // else wherever each of its consumers ultimately renders (emitPos, transitively —
        // unresolvable refuses); every load→render path must be write-free
        const renders = materialize.has(op)
          ? [{ blk: opBlock.get(op)!, idx: opIndex.get(op)! }]
          : [...new Set((useSitesOf.get(op.results[0]) ?? []).map((s) => s.op))].map((c) => emitPos(c));
        const writes = mayWrite(gb.name);
        if (renders.some((r) => r === null) || renders.some((r) => memWriteBetween(load, r!, writes))) {
          continue;
        }
        const signedRead = op.opcode === 'shr_s';
        const fld = declaredFields(si.layout)?.find(
          (f) => f.bitWidth === w && f.offset * 8 + f.bitOffset! === gb.byte * 8 + lo && f.signed === signedRead,
        );
        if (fld && memberQualsAllow(fld, si.const, false)) {
          bitfieldSpelling.set(op, { global: gb.name, field: fld.name });
          loadTargets.set(load, gb);
        }
      }
    }
    // a load is ABSORBED when every use is an shl whose every use is a spelled extract
    for (const load of loadTargets.keys()) {
      const shls = useSitesOf.get(load.results[0]) ?? [];
      const absorbed =
        shls.length > 0 &&
        shls.every(
          (u) =>
            u.op.opcode === 'shl' && (useSitesOf.get(u.op.results[0]) ?? []).every((v) => bitfieldSpelling.has(v.op)),
        );
      if (absorbed) {
        absorbedLoads.add(load);
      }
    }
  }

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

  // Lower ONE def's operation to an Expr, rendering operands through `e`. Shared between the
  // inline-at-use path (exprWith) and the materialized-temp path (sideEffects), so both spell a
  // given op identically.
  const lowerDef = (d: Op, e: (v: Value) => Expr): Expr => {
    if (d.opcode === 'const') {
      return { k: 'const', value: d.attrs.value as number };
    }
    // a bitfield extract recognized over the ops (see the precompute above): the member read,
    // not the shift pair
    const bf = bitfieldSpelling.get(d);
    if (bf) {
      return { k: 'field', base: { k: 'var', name: bf.global }, name: bf.field, dot: true };
    }
    if (CMP_TO_BIN[d.opcode]) {
      // A bare global address `&gSym` as a COMPARISON operand is the same unspelled escape as the
      // arithmetic case below (see intifyAddr): its C type comes from the PROJECT's own
      // declaration, unknowable here. Worse, the compare's SIGNEDNESS lives in the operand types
      // (CMP_TO_BIN maps icmp_ult and icmp_slt to the same '<'), so leaving `&gSym` untyped lets
      // the project's declaration pick the compare the compiler emits — silently byte-inexact
      // whenever it disagrees with the asm. The honest spelling is integer math on the address
      // with the cast AGREEING with the opcode's signedness: unsigned compares (and the
      // sign-agnostic ==/!=) spell `(u32)&gSym`, signed compares `(s32)&gSym` — exactly the
      // compare the asm did. The deref folds never see a compare operand, so no named spelling is
      // lost; a NARROWING cast (`(u8)&gSym`) is not a bare `addr` and keeps its truncation.
      // SCOPE: this handles BARE addr operands. An addr-carrying arithmetic tree
      // (`(u32)&gSym + 4`, spelled by intifyAddr below) renders unsigned and would compare
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
      if (
        unsignedCompareSpelling &&
        /^icmp_u/.test(d.opcode) &&
        !ptrSide(l) &&
        !ptrSide(r) &&
        renderedIntSignedness(l, vtEnv) !== false &&
        renderedIntSignedness(r, vtEnv) !== false &&
        !(provablyNonNegative(l, vtEnv) && provablyNonNegative(r, vtEnv))
      ) {
        const irUnsigned = (v: Value): boolean => v.type.kind === 'int' && !v.type.signed;
        if (!irUnsigned(d.operands[0]) && irUnsigned(d.operands[1])) {
          r = { k: 'cast', to: T.u(32), e: r };
        } else {
          l = { k: 'cast', to: T.u(32), e: l };
        }
      }
      // The SIGNED direction of the same hole, and a DEFAULT rather than an arm of that axis —
      // not because nothing underdetermines, but because the underdetermination is INERT. An
      // unsigned source compare can reach a signed opcode when the compiler proves the test is
      // the sign bit (`u32 a; a < 0x80000000` compiles to `cmp r0, #0; bge`; kmc-gcc and gcc
      // 2.7.2 fold it to `slti`), so an icmp_s* has more than one source — but the pinned
      // spelling reproduces that branch too (`(s32)a >= 0` is the same `cmp r0, #0; bge`), so
      // both sources reach ONE candidate and an axis would have doubled the fan to referee a
      // question with one answer. Where the spellings genuinely diverge they diverge the way the
      // opcode says, on every toolchain: an operand that renders unsigned makes C compare
      // unsigned (agbcc `bls`, IDO/kmc-gcc/gcc 2.7.2 `sltu`/`sltiu` against `slt`/`slti`, mwcc
      // `neg;or` against `neg;andc` in its branchless form), and against a constant the test
      // folds away entirely and takes the surrounding computation with it — `(u32)a / b < 0`
      // becomes `mov r0, #0`, deleting the `__udivsi3` call.
      //
      // `undefined` takes the cast exactly as a definite `false` does (see
      // renderedIntSignedness): a call's signedness is the project header's, not this function's.
      // A POINTER-rendered side is the one operand left alone, and not out of caution — `p < q`
      // is already the unsigned compare C gives two addresses, where `(s32)p < (s32)q` would
      // compare them signed.
      if (/^icmp_s/.test(d.opcode)) {
        const pinSigned = (x: Expr): Expr =>
          renderedIntSignedness(x, vtEnv) === true || ptrSide(x) ? x : { k: 'cast', to: T.s(32), e: x };
        l = pinSigned(l);
        r = pinSigned(r);
      }
      return { k: 'bin', op: CMP_TO_BIN[d.opcode], l, r };
    }
    if (ARITH_TO_BIN[d.opcode]) {
      let l = e(d.operands[0]);
      let r = d.operands.length === 2 ? e(d.operands[1]) : ({ k: 'const', value: d.attrs.imm as number } as Expr);
      // Commutative LOAD-PAIR operands re-spell in EVALUATION order. A commutative instruction's
      // operand order is an allocator artifact (`mul r0, r0, r2` reads dst-first, so the lift's
      // l/r is whichever load landed in the dst), but the order the compiler EVALUATED the
      // operands is still visible: their defs' order in the instruction stream. gcc 2.9 and IDO
      // both emit `w * h`'s loads w-first, so def order IS source order — verified byte-identical
      // on both (the bg_area rows). Scope, one gate per way the signal fails: BOTH root defs must
      // be same-block memory reads (a const already has its side; arithmetic defs get combined
      // out of source order — an ldmia-fed add reads def-reordered; cross-block positions do not
      // order evaluation), neither stamped `listOrder` (an ldmia-expanded load's own position is
      // LIST order), both operand VALUES un-named (see below), no pointer side (load-bearing for
      // the stride rules below), and no effect moves (call, marker).
      if (COMMUTATIVE_BIN.has(ARITH_TO_BIN[d.opcode]) && d.operands.length === 2) {
        const [da, db] = [defs.get(d.operands[0]), defs.get(d.operands[1])];
        if (
          defOrderLoadPairs &&
          da &&
          db &&
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
          ctype(l)?.kind !== 'ptr' &&
          ctype(r)?.kind !== 'ptr' &&
          !exprHasEffect(l) &&
          !exprHasEffect(r) &&
          opBlock.get(da) === opBlock.get(db) &&
          opIndex.get(da)! > opIndex.get(db)!
        ) {
          [l, r] = [r, l];
        }
      }
      // Pointer stride: C pointer arithmetic is ELEMENT-scaled, but the asm added a BYTE
      // constant — `addi p,4` on an `s32*` walks 1 element, yet C `p + 4` walks 4. Divide the byte
      // constant by the pointee size so the walk recompiles to the same address math.
      //
      // Keyed on the operand's RENDERED C type, never the IR value's recovered type: C scales by
      // the type of the expression it actually sees, and the two diverge exactly like memAccess's
      // deref bases (a value recovered `s32*` can render as an int-typed tree — C then does NO
      // element scaling, so pre-dividing the constant would bake in a WRONG address that the
      // deref cast downstream turns into silently-wrong bytes; found by the adversarial round).
      // An int-rendered walk keeps its raw byte constant and derefs through the access-width cast.
      // Fires only for a rendered pointer whose element size (>1) DIVIDES the constant exactly;
      // otherwise raw (a misaligned/struct-array stride is left as-is; a `u8*` is size 1 so
      // unchanged). Since C `(K/es) + p == p + (K/es)`, scaling the const on whichever side it
      // sits fixes the bytes: `add` is commutative so the pointer may be either operand; `sub` is
      // not, so only operand[0] (the minuend) may be the pointer.
      // A rendered pointer that CANNOT express the byte constant as a whole number of elements —
      // an inexact residual, or a pointee whose size is not knowable here (a struct) — has no
      // scaled spelling at all, and leaving the raw byte count is the silent wrongness the
      // pointer-global rule below refuses in the same words: C multiplies it back, so `p + 62` on
      // an `s32 *` addresses byte 248 and `p + 38` on a `struct S *` addresses byte 38 * sizeof(S).
      // Same answer as there — CAST THEN ADD, `(u8 *)p + 62`, the same address in every world.
      const bytePtr = (x: Expr): Expr => ({ k: 'cast', to: T.ptr(T.u(8)), e: x });
      // Set when a byte-pointer cast was applied for the ADDRESS math alone: the sum is cast back
      // to the pointer type it started as, so the walk changes the arithmetic and nothing else. A
      // bare `u8 *` sum would be a different C type from the slot it lands in (`v4 = (u8 *)a0 +
      // (v1 << 2)` into an `s32 *` — an mwcc error) and from the bases the deref rules read.
      let restoreTo: IrType | undefined;
      const walk = (base: Expr, c: Extract<Expr, { k: 'const' }>): { base: Expr; off: Expr } => {
        const t = ctype(base);
        if (t?.kind !== 'ptr') {
          return { base, off: c }; // an int-rendered walk: C scales nothing, the bytes are right
        }
        const es = ptrElemBytes(t.to);
        if (es === 1) {
          return { base, off: c }; // already a byte pointer
        }
        return es > 1 && c.value % es === 0
          ? { base, off: { k: 'const', value: c.value / es } }
          : { base: bytePtr(base), off: c };
      };
      // A RUNTIME byte offset has no element spelling at all — not even an inexact one to reject,
      // since the residual is unknown until the program runs. The asm added bytes, so the same
      // answer as the inexact constant above: cast then add. Without it a `u16 *` walked by a
      // computed offset addresses TWICE the intended byte, and nothing downstream can see the
      // error — in the sa3 decomp that address is what a `CpuSet` call writes THROUGH.
      //
      // KNOWN GAP: `ptr ± ptr` is excluded, and the intify rules below do not make it right
      // either — `ptr + ptr` becomes `l + (s32)r`, which C scales, and a same-pointee `ptr - ptr`
      // is C's ELEMENT difference where the asm subtracted bytes. Both want the same cast-then-add
      // treatment; both are byte-identical to what this emitted before, and three functions in the
      // agbcc corpus carry one.
      //
      // KNOWN GAP: the inexact-CONSTANT branch above casts its base and does NOT cast the sum
      // back, so `v1 = (u8 *)a0 + 2` still lands in an `s32 *` slot. Copying the restore up churns
      // the common case, where the sum is consumed by a deref that supplies its own cast — the
      // real predicate is the CONSUMER, and deciding it here at the producer is what these two
      // branches would have to stop doing.
      const walkVar = (x: Expr): IrType | undefined => {
        const t = ctype(x);
        return t?.kind === 'ptr' && ptrElemBytes(t.to) !== 1 ? t : undefined;
      };
      if ((d.opcode === 'add' || d.opcode === 'sub') && r.k === 'const') {
        ({ base: l, off: r } = walk(l, r));
      } else if (d.opcode === 'add' && d.operands.length === 2 && l.k === 'const') {
        ({ base: r, off: l } = walk(r, l)); // commuted `const + ptr`
      } else if (d.opcode === 'add' || d.opcode === 'sub') {
        // ONE side only. `ptr - ptr` is C's element difference and `ptr + ptr` is not C at all;
        // both are the intify rules' business below, and casting both operands here would hide
        // the shape from them.
        const lp = ctype(l)?.kind === 'ptr';
        const rp = d.operands.length === 2 && ctype(r)?.kind === 'ptr';
        if (lp && !rp) {
          restoreTo = walkVar(l);
          l = restoreTo ? bytePtr(l) : l;
        } else if (rp && !lp && d.opcode === 'add') {
          restoreTo = walkVar(r);
          r = restoreTo ? bytePtr(r) : r;
        }
      }
      // C rejects a pointer operand outright under the non-additive operators (& | ^ << >> * / %),
      // under `ptr + ptr`, and as the subtrahend of `int - ptr` — the asm just does 32-bit integer
      // math on the address, so the honest spelling is the value cast to its integer self. Only a
      // DEFINITELY-pointer rendering is cast (same conservative direction as memAccess); the
      // additive ops keep C's legal pointer arithmetic untouched.
      const op = ARITH_TO_BIN[d.opcode];
      const intify = (x: Expr): Expr => (ctype(x)?.kind === 'ptr' ? { k: 'cast', to: T.s(32), e: x } : x);
      if (!['+', '-', '&&', '||'].includes(op)) {
        l = intify(l);
        r = intify(r);
      } else if (op === '+' && ctype(l)?.kind === 'ptr' && ctype(r)?.kind === 'ptr') {
        r = intify(r); // ptr + ptr is not C; ptr + (s32)ptr is, with the same bytes
      } else if (op === '-' && ctype(l)?.kind !== 'ptr' && ctype(r)?.kind === 'ptr') {
        r = intify(r); // int - ptr is not C
      }
      // A bare global address `&gSym` under ANY of these operators is never emitted as-is: its C
      // type comes from the PROJECT's own declaration (unknowable here — exprCType types `addr`
      // undefined, so the ptr-keyed intify above never fires on it), which makes `&gSym + K`
      // byte-INEXACT (C scales K by sizeof(gSym)) and `&gSym & K` ill-formed. The honest spelling
      // is integer math on the address — `(u32)&gSym + K`, exactly the arithmetic the asm did.
      // The deref folds (globalOf / globalConstByte, via addrIn) look through this cast, so every
      // access that CAN spell a named element/field still does; only a genuine value-context
      // escape (a call argument, a stored address, a compare) keeps it — previously such an
      // escape tripped assertDerefsTyped's interior-pointer rule and declined the whole function.
      const intifyAddr = (x: Expr): Expr => (x.k === 'addr' ? { k: 'cast', to: T.u(32), e: x } : x);
      l = intifyAddr(l);
      r = intifyAddr(r);
      // The SAME hazard one level down, for a POINTER-shaped global's VALUE (`gPtr`, isPtrGlobal):
      // C scales `gPtr + K` by sizeof(*gPtr) — 1 under the map's synthesized `void *`, but
      // whatever the PROJECT's header declares (a 0x5C-byte struct, say) in the world a user
      // actually recompiles in. The asm added BYTES, so the honest spelling makes the stride
      // explicit: CAST-THEN-ADD, `(u8 *)gPtr + K`, the same address in EVERY world. Add-then-cast
      // (`(u8 *)(gPtr + K)`, what the backend's deref legalization would otherwise produce) is
      // byte-correct in exactly one of them — a silent wrongness, the class this project refuses.
      // NOT foldable into the deref index either: `((u8 *)gPtr)[K + off]` re-scales K by the
      // ACCESS width, a different address whenever that width is not 1.
      // Under the non-additive operators C rejects a pointer outright, so there the honest
      // spelling is integer math on the cell — exactly intifyAddr's `(u32)&gSym` rule.
      const intifyPtrGlobal = (x: Expr): Expr => ({ k: 'cast', to: T.u(32), e: x });
      if (op === '+' || op === '-') {
        // `ptr ± int` and `ptr - ptr` are byte arithmetic once both sides are byte pointers;
        // `ptr + ptr` and `int - ptr` are not C at all, so the second pointer goes integer.
        const bothPtr = isPtrGlobal(l) && isPtrGlobal(r);
        if (isPtrGlobal(l)) {
          l = bytePtr(l);
        }
        if (isPtrGlobal(r)) {
          r = bothPtr && op === '-' ? bytePtr(r) : op === '+' && !bothPtr ? bytePtr(r) : intifyPtrGlobal(r);
        }
      } else if (op !== '&&' && op !== '||') {
        // (`&&`/`||` take a pointer operand legally — a truth test, no arithmetic.)
        l = isPtrGlobal(l) ? intifyPtrGlobal(l) : l;
        r = isPtrGlobal(r) ? intifyPtrGlobal(r) : r;
      }
      // (The signedness-carrying pairs stay DISTINCT ops here — `>>>`/`>>` and `/u` `%u`/`/` `%`.
      // Which token a language spells each with, and what cast pins the choice, is a BACKEND
      // decision; see l3/ast.ts BinOp and backend/cfamily.ts's C_SPELLING.)
      // SCOPE: this and intifyAddr cover the ARITHMETIC escapes. A pointer global under a
      // COMPARISON (`gPtr < K` — C compares unsigned whatever the asm's icmp_s* said) is the same
      // class as intifyAddrCmp's `addr` rule and is deliberately left alone here: it is valid C
      // today, so closing it would churn spellings for a signedness case no row exercises.
      const sum: Expr = { k: 'bin', op, l, r };
      return restoreTo ? { k: 'cast', to: restoreTo, e: sum } : sum;
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
    if (d.opcode === 'neg') {
      const x = e(d.operands[0]);
      return { k: 'un', op: '-', e: needsIntSpelling(x) ? { k: 'cast', to: T.s(32), e: x } : x };
    }
    if (d.opcode === 'not') {
      const x = e(d.operands[0]);
      return { k: 'un', op: '~', e: needsIntSpelling(x) ? { k: 'cast', to: T.s(32), e: x } : x };
    }
    // Width-narrowing casts: `zext`/`sext` widen a `width`-bit value back to 32 → C `(u8)e`/`(s8)e`.
    if (d.opcode === 'zext') {
      return { k: 'cast', to: T.int(d.attrs.width as number, false), e: e(d.operands[0]) };
    }
    if (d.opcode === 'sext') {
      return { k: 'cast', to: T.int(d.attrs.width as number, true), e: e(d.operands[0]) };
    }
    if (d.opcode === 'call') {
      return { k: 'call', fn: d.attrs.target as string, args: d.operands.map(e) };
    }
    if (d.opcode === 'laddr') {
      // gaddr's local twin: the address of the frame-local object the Thumb frontend PROVED
      // (frame-object audit — width/signed are stamped machine facts). The NAME is this layer's:
      // see laddrName. Renders `&sp0`; the object itself is declared in `locals`.
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
      // integer: spelled `(u32)Name` — the source idiom — never `&Name` (defect G of the
      // dogfood report; the & form compiles but is a different, non-matching spelling).
      if (d.attrs.code === true) {
        return { k: 'cast', to: T.int(32, false), e: { k: 'var', name: d.attrs.sym as string } };
      }
      return { k: 'addr', name: d.attrs.sym as string };
    }
    if (d.opcode === 'load') {
      return memAccess(
        d.operands[0],
        e(d.operands[0]),
        d.attrs.off as number,
        d.attrs.width as number,
        (d.attrs.signed as boolean) ?? false,
        ctype,
        scalarGlobals,
        symCtx,
      );
    }
    // aload carries a runtime index operand (variable-index array access) — `base[index]`, or
    // `base[index].field_K` when it carries a `fieldOff` (array-of-STRUCT element access).
    if (d.opcode === 'aload') {
      return arrayAccess(
        d.operands[0],
        e(d.operands[0]),
        e(d.operands[1]),
        d.attrs.fieldOff as number | undefined,
        d.attrs.elemSize as number,
        (d.attrs.signed as boolean) ?? false,
        ctype,
        symCtx,
      );
    }
    return d.opcode === 'opaque'
      ? mkGap(gapReasonFor(d.attrs.mnemonic), d.operands.map(e))
      : mkGap(`no lowering for op '${d.opcode}'`, d.operands.map(e));
  };

  const exprWith = (sub: Map<Value, string> | null) => {
    const e = (v: Value): Expr => {
      const subbed = sub?.get(v);
      if (subbed) {
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
  // `varName` is captured as a live reference: it is still being populated here in the naming
  // pipeline, and each check reads the names that exist when EMISSION calls it.
  const { readsClobbered, loopUpdateHazard, sinkablePreUpdateSlots, sameAtEntry, loopWriteSet } = makeLoopHazards({
    defs,
    varName,
    useSitesOf,
    liveIn,
    opBlock,
    materialize,
    respelledDefs: bitfieldSpelling,
  });

  // A POST-LOOP substitution active while structuring a loop's exit region: a loop-carried value (a
  // latch back-edge arg) is held in its loop-variable NAME after the loop, so any post-loop use must
  // read the name, not re-inline the computation (which would double-count, e.g. `(u8)(v1+1)` instead
  // of `v1`). `expr` consults it; `withSub` installs/merges it around the exit region. Null normally.
  let activeSub: Map<Value, string> | null = null;
  const expr = (v: Value): Expr => exprWith(activeSub)(v);
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
  // stores whatever the arm left — the same substitution the parameter case makes, one axis over.
  //
  // THE SECOND RELOCATION goes the other way, and this test cannot see it at all. A SUNK pre-update
  // exit copy (preUpdateCopies) writes the loop EXIT's param at the top of the loop BODY, so the
  // home this reads for it — `paramBlock`, the exit block — sits strictly LATER in the CFG than
  // where the copy lands. What keeps the two apart is not this test but `dest-free-inside-loop`
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
  /** Every sunk pre-update exit copy, homed where it LANDS (the loop header whose body opens with
   *  it) rather than where its destination param lives. These two lists are the postcondition's
   *  whole input. */
  const sunkCopyHomes: { name: string; home: Block }[] = [];
  const undefCarriesNothing = (arg: Value, name: string, pred: Block): boolean => {
    if (defs.get(arg)?.opcode !== 'undef') {
      return false;
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
  const tempCounter = { n: 0 }; // per-function swap-cycle temp names (sequentialize)
  // The copies for ONE specific successor record — the workhorse behind argAssigns, taken
  // directly by the switch_br path, whose duplicate case targets successorTo cannot
  // disambiguate.
  const argAssignsFor = (
    pred: Block,
    succ: { block: Block; args: Value[] },
    sub: Map<Value, string> | null = null,
    keepSlot: (i: number) => boolean = () => true,
  ): Stmt[] => {
    const target = succ.block;
    const argExpr = sub ? exprWith(sub) : expr;
    const copies: { name: string; value: Expr; arg: Value }[] = [];
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
      copies.push({ name, value: castAggregateAddr(name, argExpr(arg)), arg });
    });
    // Emit in the order the args are COMPUTED in `pred` — a compiler that lays the defining ops
    // (and thus the copies that read them) out in that order matches with no spurious arg-swap.
    // This is a per-compiler behavior (orderArgCopiesByComputation), not a universal: a compiler
    // that emits copies in source/param order sets it false. Dependency ordering (sequentialize)
    // still has the final say regardless.
    if (orderArgCopiesByComputation) {
      // opIndex is only valid for a def IN this block; a def elsewhere keeps indexOf's -1 (sorts first).
      const pos = (v: Value) => {
        const d = defs.get(v);
        return d && opBlock.get(d) === pred ? opIndex.get(d)! : -1;
      };
      copies.sort((a, b) => pos(a.arg) - pos(b.arg));
    }
    return sequentialize(
      copies.map(({ name, value }) => ({ name, value })),
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
  const sideEffects = (b: Block): Stmt[] => {
    const out: Stmt[] = [];
    for (const op of b.ops) {
      if (op.opcode === 'store') {
        // A store whose lvalue is a bare global (`gSym = v`, from an `&gSym` base at off 0) emits
        // as an ASSIGN, not a store — memAccess returns a `var` node for that case.
        const width = op.attrs.width as number;
        const lval0 = memAccess(
          op.operands[0],
          expr(op.operands[0]),
          op.attrs.off as number,
          width,
          width === 4,
          ctype,
          scalarGlobals,
          symCtx,
          true, // an lvalue: a member whose declaration is const cannot be NAMED as the target
        );
        if (lval0.k === 'var') {
          globalNames.add(lval0.name);
          out.push({ k: 'assign', name: lval0.name, value: expr(op.operands[1]) });
          continue;
        }
        // signedness mirrors recoverTypes' store seed (word ⇒ signed, narrow ⇒ unsigned), so an
        // inserted cast declares the same scalar the recovered pointee would have.
        out.push({ k: 'store', lval: lval0, value: expr(op.operands[1]) });
      } else if (op.opcode === 'astore') {
        const elemSize = op.attrs.elemSize as number;
        out.push({
          k: 'store',
          lval: arrayAccess(
            op.operands[0],
            expr(op.operands[0]),
            expr(op.operands[1]),
            op.attrs.fieldOff as number | undefined,
            elemSize,
            elemSize === 4,
            ctype,
            symCtx,
          ),
          value: expr(op.operands[2]),
        });
      } else if (EFFECTFUL_OPS.has(op.opcode) && op.results.length && !useSitesOf.has(op.results[0])) {
        // An effectful op whose result nobody reads is still an execution. `store`/`astore` have no
        // result and were handled above, so what reaches here is `call` and `opaque` — and an
        // `opaque` missing from this walk is an instruction the frontend could not model
        // disappearing with no diagnostic, which is the one thing this project refuses to do.
        //
        // Keyed on EFFECTFUL_OPS rather than the two opcode names: the deciding property is "has an
        // effect the result does not account for", which is what the flag already means, so the next
        // op to acquire it needs no edit here. Statement, not expression — `expr` on the result
        // routes through `lowerDef`, already where `opaque` becomes the gap, so this reuses the SAME
        // degradation a live opaque gets rather than inventing a second way to be loud.
        out.push({ k: 'exprstmt', value: expr(op.results[0]) });
      } else if (materialize.has(op) && !absorbedLoads.has(op)) {
        // (an absorbed load's every consumer spells a named bitfield read — emitting its temp
        // here would recompile to a second load the asm does not have)
        const nm = varName.get(op.results[0])!;
        out.push({ k: 'assign', name: nm, value: castAggregateAddr(nm, lowerDef(op, expr)) });
      }
      // a merge copy anchored at this const's original position (anchorConstCopies, above)
      for (const a of anchoredAt.get(op) ?? []) {
        out.push({ k: 'assign', name: a.name, value: expr(a.arg) });
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
  type LoopFrame = { header: Block; exit: Block; body: Set<Block>; arms: LoopArm[] };
  let loopCtx: LoopFrame | null = null;
  const withLoop = <R>(frame: LoopFrame, run: () => R): R => {
    const prev = loopCtx;
    loopCtx = frame;
    try {
      return run();
    } finally {
      loopCtx = prev;
    }
  };

  const structureRegion = (b: Block, stop: Block | null): Stmt[] => {
    if (b === stop) {
      return [];
    }
    if (onStack.has(b)) {
      throw new StructureError(
        `cannot structure '${fn.name}': unrecovered back-edge into block #${fn.blocks.indexOf(b)} ` +
          `(loop-recovery declined this shape: multi-latch, irreducible/overlapping loops, ` +
          `a conditional continue, or an unsafe break)`,
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
  // back into structureRegion, and Regime B (switch_br, below) shares its fall-through predicate.
  const { recognizeSwitch, analyzeArmExit, layoutIndex, defaultLayoutPos } = makeSwitchRecovery({
    fn,
    defs,
    dom,
    ipdom,
    opBlock,
    isNamed: (v) => varName.has(v),
    isCmpOpcode: (opcode) => !!CMP_TO_BIN[opcode],
    switchAllowsNeqCase,
    switchAllowsBoundCase,
    switchArmsFollowLayout,
    emitsOwnStatement: (blk) => blk.ops.some((o) => anchoredAt.has(o) || materialize.has(o)),
    expr: (v) => expr(v),
    structureRegion: (b, stop) => structureRegion(b, stop),
  });

  const structureBlock = (b: Block, stop: Block | null): Stmt[] => {
    // Bottom-test `do-while`: this block is a do-while header (the body-first loop entry). Emit the
    // do-while — its body includes `b`'s own ops (structured via structureRegion with the hook masked),
    // so do NOT emit sideEffects(b) here. The init was already emitted by the predecessor's argAssigns.
    const dw = doWhileLoops.get(b);
    if (dw && !dwActive.has(b)) {
      return emitDoWhile(dw, stop);
    }

    const out: Stmt[] = [...sideEffects(b)];
    const term = b.ops[b.ops.length - 1];
    if (term.opcode === 'ret') {
      // A void function's `bx lr` leaves whatever in r0; suppress that phantom return value.
      out.push({ k: 'return', value: returnsVoid || !term.operands.length ? undefined : expr(term.operands[0]) });
      return out;
    }
    if (term.opcode === 'br') {
      const target = term.successors[0].block;
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
      const merge = ipdom.get(b) ?? stop;
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
      // The blocks an arm could fall INTO. The default block counts only when it is a block of its
      // own: when it IS the merge, "the default" is just where the switch ends, and an arm reaching
      // it is a plain `break`.
      const siblings = new Set<Block>(arms.map((a) => a.entry));
      if (defEdge.block !== merge) {
        siblings.add(defEdge.block);
      }
      // ARM ORDER. Grouping the table's slots by target walks them in TABLE order, which for a dense
      // table is ascending case value — the neutral spelling, and the source's order only by
      // accident. Where the compiler has declared that its block layout IS the order the arms were
      // written (TargetDescription.switchArmsFollowLayout — the same fact and the same evidence
      // Regime A reads, and agbcc's jump tables carry it too: 8 dense arms written 5,2,0,4,1,3,6,7
      // lay their bodies out in that order under an ascending table), the bodies' layout is the
      // evidence and the arms take it.
      //
      // Only when NO arm falls through. Here — unlike Regime A, which declines fall-through
      // outright — emission order is load-bearing for correctness (the l3/ast.ts non-neutrality
      // note): a falling arm must be emitted directly above the one it falls into, so its position
      // is not free to move. `analyzeArmExit` does not depend on emission order, so the exits can
      // be settled first and reused below. Grouping by target already gives every arm a DISTINCT
      // entry block, so no two sort keys can be equal and the tie-break Regime A needs on shared
      // bodies has nothing to decide here.
      const exitOf = new Map<Block, ArmExit>();
      for (const entry of [...arms.map((a) => a.entry), defEdge.block]) {
        if (!exitOf.has(entry)) {
          exitOf.set(entry, analyzeArmExit(entry, b, merge, siblings));
        }
      }
      const armsFollowLayout = switchArmsFollowLayout && [...exitOf.values()].every((e) => e.kind === 'break');
      if (armsFollowLayout) {
        arms.sort((x, y) => layoutIndex(x.entry) - layoutIndex(y.entry));
      }
      // The `default:` arm carries that evidence too, and a table hands it over the same way: the
      // range check BRANCHES to the default (`bhi .Ldefault`), so its block is never one the
      // dispatch ran into — measured, a 5-arm table lays the default's body at each of the six
      // positions the source can write it in exactly there. `defaultLayoutPos` states the refusals.
      const defaultAt =
        armsFollowLayout && defEdge.block !== merge
          ? defaultLayoutPos(
              defEdge.block,
              arms.map((a) => a.entry),
              false,
            )
          : undefined;
      // ONE emission order for the whole statement: the case arms, then the default. Adjacency is
      // read off this array, so "falls into the next arm" needs no separate rule for a case that
      // falls into the default (it is the arm after the last case, and legal C). Where the LABEL is
      // printed is `defaultAt`, which the emission order does not follow.
      const emitOrder = [...arms, { entry: defEdge.block, edge: defEdge, values: null as number[] | null }];
      // Each arm's switch-edge copies, computed ONCE and in emission order: `argAssignsFor` mints
      // swap-cycle temp names, so calling it twice for one edge burns a temp number and changes the
      // output (the same reason emitDoWhile reuses its `updates`).
      const edgeCopies = emitOrder.map((a) => argAssignsFor(b, a.edge));
      const bodies = emitOrder.map((a, i) => {
        const exit = exitOf.get(a.entry)!;
        if (exit.kind === 'unstructurable') {
          throw new StructureError(`cannot structure '${fn.name}': ${exit.why}`);
        }
        const ft = exit.kind === 'fallthrough';
        const next = emitOrder[i + 1];
        if (ft && next?.entry !== exit.to) {
          throw new StructureError(
            `cannot structure '${fn.name}': ${a.values ? `case ${a.values.join('/')}` : 'the default arm'} falls ` +
              `through into an arm that is not the next one emitted — C fall-through only reaches the arm below`,
          );
        }
        // The arm fallen INTO opens with its own switch-edge copies, which are how the dispatch hands
        // it its block parameters. On the fall-through path those copies would RE-RUN and overwrite
        // what the falling arm just computed (`case 0: v=7; case 1: v=5;` — the case-0 path calling
        // with 5). They cannot simply be dropped either: entering that arm by its own case value
        // needs them. Hoisting them above the switch is possible but not always safe (another arm may
        // read the same name first), so this shape declines LOUD; recovering it is future work.
        if (ft && edgeCopies[i + 1].length) {
          throw new StructureError(
            `cannot structure '${fn.name}': the case fallen into takes a value from the switch edge, ` +
              `which the fall-through path would re-run`,
          );
        }
        return {
          // A falling-through arm stops AT its successor arm, which then emits that body once under
          // its own labels; a closed arm runs to the merge as before.
          body: [...edgeCopies[i], ...structureRegion(a.entry, ft ? exit.to : merge)],
          fallsThrough: ft,
        };
      });
      const outCases: SwitchCase[] = arms.map((a, i) => ({ values: a.values, ...bodies[i] }));
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
      out.push(sw);
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
        // (1) Is the guard PROVABLY the loop's own test? Fusing DELETES it and lets the `while`
        // re-test, so an unproven fuse would lose the `if` outright and run a loop the source
        // skipped. Structural equality is a sufficient proof, never a necessary one: `str[0]` and
        // `str[i]` at `i = 0`, or a signed `e <= 0` beside an unsigned `e != 0`, are the same test
        // spelled differently, and normalising those needs a canonical form this pass does not
        // have. An unproven guard therefore KEEPS its `if`, with the loop as a `do-while` inside it
        // — every test the asm performs is emitted as itself. The proof still gates the SINK below:
        // a sunk copy runs once per iteration, and only the proof (fused form) or the kept `if`
        // makes the zero-trip path skip it. The kept `if` would widen the sink's key to unproven
        // guards too; no row needs that yet, so it stays keyed on the proof.
        const enterIsTaken = takenB === h;
        const contIsTaken = hterm.successors[0].block === li.header;
        const guardProven = sameAtEntry(hterm.operands[0], term.operands[0], entryVals, enterIsTaken !== contIsTaken);
        // Fused `while` additionally requires a header free of MATERIALIZED defs: their temps are
        // assigned only inside the body (sideEffects), and an un-rotated `while` condition renders
        // BEFORE the body ever ran — reading a temp uninitialized on the first test. The kept-guard
        // `do-while` tests after the body, so it carries no such restriction.
        const fused = guardProven && !li.header.ops.some((o) => materialize.has(o));
        // A pre-update exit copy is repairable rather than fatal: emitted at the TOP of the body it
        // captures the value one iteration before the update, which is what the exit edge carries.
        // Its post-loop copy is then dropped, so the ZERO-TRIP path needs the guard→exit edge as a
        // seed — the only edge holding the never-entered value. That is why the sink demands the
        // proof above: it makes the fused zero-trip path load-bearing.
        const sunk = guardProven
          ? sinkablePreUpdateSlots(li.header, li.exit, hexitArgs, new Set([li.header]), sub, updateWrites)
          : new Set<number>();
        // (2) Every exit copy the fused form KEEPS renders after the loop, on the zero-trip path
        // too — where the loop variables still hold their init values. It must therefore produce
        // what the guard→exit edge carries, since that edge is dropped. A sunk slot is exempt: its
        // seed and its body copy cover the two paths separately.
        const staleExit = hexitArgs.findIndex(
          (a, j) => !sunk.has(j) && !sameAtEntry(a, guardExit.args[j] as Value, entryVals),
        );
        if (staleExit >= 0) {
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
            new Set(li.header.params),
          )
        ) {
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
        // The header→exit edge may carry non-identity phi args (the exit param merges the guard-false
        // value with the loop's final value). Emit those copies after the loop — dropping them returns
        // a stale value. Read under the un-rotation substitution (post-loop the params hold their
        // updated values), and structure the exit region under the same substitution so a post-loop
        // use of a loop value reads its name.
        out.push(
          ...withSub(sub, () => [...argAssigns(li.header, li.exit, sub, keptSlot), ...structureRegion(li.exit, stop)]),
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
    if (loopCtx && (takenB === loopCtx.header || fallB === loopCtx.header)) {
      const contIsTaken = takenB === loopCtx.header;
      const exitB = contIsTaken ? fallB : takenB;
      const isBreak = exitB === loopCtx.exit;
      // SOUNDNESS (break-clobber): a structured `break` jumps to AFTER the loop, where the header→exit
      // phi copies are emitted (emitTestAtTopWhile / emitDoWhile). If those copies are NON-identity, the
      // break path would fall through them and CLOBBER the value the break carried into the exit param.
      // Only emit `break` for a WHILE header whose header→exit copy is empty (the exit param already
      // coalesces across both edges); otherwise decline (fall through → honest loud fail). A do-while
      // `break` declines here (its exit copies live post-loop too, but the check differs) — the
      // return-trampoline path below still serves both. Trampolines are immune (the `return` terminates
      // the arm, so nothing falls through).
      const breakSafe = whileLoops.has(loopCtx.header) && argAssigns(loopCtx.header, loopCtx.exit).length === 0;
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
      // No loop-param exemption here. That exemption exists for reads AFTER the loop, where the
      // updated name holding its final value is exactly what was meant. This arm renders INSTEAD of
      // the next iteration, behind an update already emitted, so a read of a loop variable here
      // wanted the value it had before that — `if (found) { *out = i; return; }` would store `i + 1`.
      const exitRegion = new Set([exitB, ...reachFrom(exitB)].filter((x) => !loopCtx!.body.has(x)));
      const hazard = loopUpdateHazard(
        term.operands[0],
        exitArgs,
        loopCtx.body,
        sub,
        updateWrites,
        exitRegion,
        new Set(),
      );
      if (!hazard && !loopCtx.body.has(exitB) && ((isBreak && breakSafe) || (!isBreak && isArm(exitB)))) {
        out.push(...updateCopies); // the loop update, RAW (i++, p>>=1, …)
        let leaveCond = exprWith(sub)(term.operands[0]);
        if (contIsTaken) {
          leaveCond = negateCond(leaveCond);
        } // continue is `taken` → leave when NOT it
        const exitArm = isBreak
          ? [...argAssigns(b, loopCtx.exit, sub), { k: 'break' } as Stmt] // break to the loop exit
          : withSub(sub, () => [...argAssigns(b, exitB, sub), ...structureRegion(exitB, stop)]); // early return
        out.push(mkIf(leaveCond, exitArm, []));
        return out;
      }
    }

    // Regime-A switch: if this cond_br roots a comparison tree over a single scrutinee, emit a
    // `switch`. A pre-check here — mirroring the guard-fused-loop check above — so it sees the raw
    // tree before if-recovery claims the diamonds. Declines (null) fall through to plain if-recovery.
    const asSwitch = recognizeSwitch(b, stop);
    if (asSwitch) {
      out.push(...asSwitch);
      return out;
    }

    const cond = expr(term.operands[0]);
    const ipd = ipdom.get(b) ?? null; // null ⇒ the arms diverge (both reach EXIT), no join
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
    // doubling per nesting level; those keep the CFG join and the old loud decline. Lifting that
    // needs a post-dominator computed over the body alone with the arms DELETED — treating them as
    // exits does not work, since post-dominance cannot express "where the paths that did not
    // return meet".
    const clampToLoop =
      loopCtx !== null &&
      ipd !== null &&
      !loopCtx.body.has(ipd) &&
      term.successors.some((sc) => isArm(sc.block) || sc.block === stop) &&
      term.successors.every((sc) => loopCtx!.body.has(sc.block) || isArm(sc.block));
    const merge = clampToLoop ? stop : (ipd ?? stop);
    // Per-successor records, NOT successorTo(b, block): a cond_br whose two edges reach the SAME
    // block with different args would otherwise give both arms the first edge's copies.
    const thenS = [...argAssignsFor(b, term.successors[0]), ...structureRegion(takenB, merge)];
    const elseS = [...argAssignsFor(b, term.successors[1]), ...structureRegion(fallB, merge)];
    if (ipd === null && thenS.length && elseS.length && preserveDivergentBranchSense) {
      // Divergent arms (both terminate — no reconvergence). The asm branched forward to the
      // `taken` block and fell through to `fall`; a compiler that PRESERVES source branch direction
      // re-emits that as a forward branch on the NEGATED condition to the else-arm, so putting the
      // taken arm as `else` (and negating) reproduces the original branch sense. Byte-exact on
      // IDO/MIPS; agbcc/GCC canonicalise either way, so it is safe there too. A compiler that
      // inverts branch canonicalization sets preserveDivergentBranchSense false and falls through
      // to the positive form below.
      out.push({ k: 'if', cond: negateCond(cond), then: elseS, else: thenS });
      return out;
    }
    if (negateJoinedBranchSense && ipd !== null && thenS.length && elseS.length) {
      // JOINED arms only (`ipd !== null` — a divergent if belongs to preserveDivergentBranchSense
      // above, and without the check a /flip-branch variant would fall through here and get
      // flipped BACK, collapsing the {divergent flipped × joined flipped} combination), and both
      // arms real: the flipped spelling is a genuine sibling, not noise on a one-armed if
      out.push({ k: 'if', cond: negateCond(cond), then: elseS, else: thenS });
      if (merge && merge !== stop) {
        out.push(...structureRegion(merge, stop));
      }
      return out;
    }
    out.push(mkIf(cond, thenS, elseS));
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

  // The sunk exit copies, as body statements: `dest = <the arg, rebuilt here>`. The sink's gates
  // are stated against `exprWith(null)` — every name it stops at holds, at the top of the body,
  // what it held where the edge read it — so the arg is spelled with no substitution. Slot order
  // keeps it deterministic.
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
  // `home` is the loop HEADER — the block whose body these copies open, and so the block from which
  // the write is reachable. Recorded rather than inferred because `exit` says the opposite (see
  // `sunkCopyHomes`).
  const preUpdateCopies = (exit: Block, exitArgs: readonly Value[], sunk: Set<number>, home: Block): Stmt[] =>
    [...sunk]
      .sort((x, y) => x - y)
      .map((j) => {
        if (activeSub !== null && !varName.has(exitArgs[j])) {
          throw new StructureError(
            `cannot structure '${fn.name}': a pre-update exit copy would rebuild a computed value ` +
              `inside a loop nested in another loop's post-loop naming`,
          );
        }
        const name = varName.get(exit.params[j])!;
        sunkCopyHomes.push({ name, home });
        return {
          k: 'assign' as const,
          name,
          value: exprWith(null)(exitArgs[j]),
        };
      });

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
    updates?: Stmt[],
    sunkCopies: Stmt[] = [],
    kind: 'while' | 'dowhile' = 'while',
  ): Stmt => {
    const term = li.header.ops[li.header.ops.length - 1];
    let cond = exprWith(loopSub(li))(term.operands[0]);
    if (term.successors[0].block !== li.header) {
      cond = negateCond(cond);
    } // loop-continue must be `taken`
    const body = [...sunkCopies, ...sideEffects(li.header), ...(updates ?? argAssigns(li.header, li.header))];
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
    const body = withLoop({ header: wl.header, exit: wl.exit, body: wl.body, arms: wl.arms }, () => [
      ...argAssigns(wl.header, wl.bodyEntry),
      ...structureRegion(wl.bodyEntry, wl.header),
    ]);
    const out: Stmt[] = [{ k: 'while', cond, body }];
    out.push(...argAssigns(wl.header, wl.exit)); // phi args carried on the header→exit edge, if any
    out.push(...structureRegion(wl.exit, stop));
    return out;
  };

  // The latch back-edge substitution (do-while) — subFor over the latch's back-edge args.
  const latchSub = (dw: DoWhileInfo): Map<Value, string> =>
    subFor(dw.header.params, successorTo(dw.latch, dw.header)!.args);

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
    const updates = argAssigns(dw.latch, dw.header);
    const updateWrites = loopWriteSet(updates, dw.body, dw.header);
    const lterm = dw.latch.ops[dw.latch.ops.length - 1];
    // KNOWN GAP, and the reason the sink stands down rather than repairing anything. A body
    // block's param may adopt a LOOP VARIABLE's name (canTakeName waives the liveness half for a
    // pure alias, an argument that does not carry when the name came from `backArgName` — it is
    // then a different value's). The arm's copy into it is a real write partway through the body,
    // and everything rendered after it reads the name RAW: the update, the bottom test, the
    // header's own ops, the latch's side effects.
    //
    // The refusal is on the NAME, not on who reads it: the readers are every statement the loop
    // emits, which is not a set worth enumerating when the name alone is the whole signal.
    //
    // The emitted C is wrong whenever this shape occurs, sink or no sink — it is a naming-pipeline
    // defect, not this pass's, and repairing the exit copy does not touch it. What IS this pass's
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
        // EVERY in-edge record, not successorTo — a terminator with two edges to this block would
        // hide the second edge's args, and a hidden edge is a rebind this does not see. Only a
        // copy that SURVIVES argAssigns' identity elision writes anything, so an edge whose arg
        // already carries the name does not count.
        for (const pb of new Set(preds.get(bb) ?? [])) {
          for (const sc of pb.ops[pb.ops.length - 1].successors) {
            if (sc.block === bb && varName.get(sc.args[i]) !== n) {
              bodyRebinds.add(n);
            }
          }
        }
      });
    }
    const rebindHazard = [...bodyRebinds].some((n) => headerNames.has(n));
    const exitArgs = (successorTo(dw.latch, dw.exit)?.args ?? []) as Value[];
    // A pre-update exit copy moves to the TOP of the body, where the loop variables still hold
    // their top-of-iteration values. No zero-trip seed here: a `do-while` always runs its body, so
    // any other predecessor of the exit is an ordinary edge some enclosing `if` already emits.
    const sunk = rebindHazard
      ? new Set<number>()
      : sinkablePreUpdateSlots(dw.header, dw.exit, exitArgs, dw.body, sub, updateWrites);
    // The post-loop region the escaped-value check judges: everything the loop does not emit itself.
    // An early-`return` arm the loop OWNS renders inside the body, ahead of the update, so a read of
    // a loop variable there is the pre-update value it wants — counting it as post-loop would decline
    // the loop for a hazard that cannot happen. Blocks the arm merely reaches are not `owned`, and stay
    // post-loop where the other path really does read them after the update.
    const owned = new Set(dw.arms.flatMap((a) => [...a.owned]));
    const postLoop = new Set(fn.blocks.filter((bb) => !dw.body.has(bb) && !owned.has(bb)));
    if (
      loopUpdateHazard(
        lterm.operands[0],
        exitArgs.filter((_, j) => !sunk.has(j)),
        dw.body,
        sub,
        updateWrites,
        postLoop,
        new Set(dw.header.params),
      )
    ) {
      throw new StructureError(
        `cannot structure '${fn.name}': do-while condition or a post-loop value reads a pre-update loop variable`,
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
        : withLoop({ header: dw.header, exit: dw.exit, body: dw.body, arms: dw.arms }, () =>
            structureBlock(dw.header, dw.latch),
          ); // header..latch (exclusive of latch)
    dwActive.delete(dw.header);
    // The UPDATE is RAW (`v = v - 1`) — it IS the decrement; applying `sub` would make it look like the
    // identity `v = v` and drop it. Only the CONDITION and EXIT copies use `sub` (post-update the param
    // already holds the next value, so the latch-computed test reads `v`, not `v - 1`). `updates`
    // reuses the hazard check's computation — a second argAssigns call would burn a spurious
    // swap-cycle temp number.
    const body = [
      ...preUpdateCopies(dw.exit, exitArgs, sunk, dw.header),
      ...inner,
      ...sideEffects(dw.latch),
      ...updates,
    ];
    let cond = exprWith(sub)(lterm.operands[0]);
    if (lterm.successors[1].block === dw.header) {
      cond = negateCond(cond);
    } // continue edge must be `taken`
    const out: Stmt[] = [{ k: 'dowhile', cond, body }];
    // The exit region reads latch back-edge values under `sub` (post-loop they live in the loop vars).
    out.push(
      ...withSub(sub, () => [
        ...argAssigns(dw.latch, dw.exit, sub, (j) => !sunk.has(j)),
        ...structureRegion(dw.exit, stop),
      ]),
    );
    return out;
  };

  const body = recognizeForLoops(structureRegion(entry, null));
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
  // they have no Value, so they are collected from varType, not varName).
  const localNames = [...new Set([...varName.values(), ...[...varType.keys()].filter((n) => /^t\d+$/.test(n))])].filter(
    (n) => /^[vt]\d+$/.test(n) && !globalNames.has(n),
  );
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
  // `synthetic:dma_fill_uninit` and `kleod:ProcessInputAndUpdateEntities` both lose their record
  // here.
  const frameRecord = (at: Op): { frame?: { loads: number; stores: number } } => {
    const off = at.attrs.off as number;
    const roots = new Set<Value>();
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode === 'laddr' && (op.attrs.off as number) === off) {
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
        // every OTHER mention of the address, operands and branch arguments alike
        const elsewhere = op.operands.some((v, i) => roots.has(v) && !(access && i === 0));
        if (elsewhere || op.successors.some((sx) => sx.args.some((v) => roots.has(v)))) {
          return {};
        }
      }
    }
    return { frame: { loads, stores } };
  };
  const structs = collectStructs(fn);
  return {
    name: fn.name,
    params: entry.params.map((p, i) => ({ name: `a${i}`, type: p.type })),
    locals: [
      ...localNames.map((n) => ({ name: n, type: varType.get(n)! })),
      // frame-local objects (laddr): declared with EXACTLY the access type the machine used —
      // the frontend's frame-object audit proved all accesses agree, so this is a fact, not a guess
      ...[
        ...new Map(
          fn.blocks
            .flatMap((b) => b.ops)
            .filter((op) => op.opcode === 'laddr')
            .map((op) => [
              laddrName.get(op)!,
              {
                name: laddrName.get(op)!,
                type: T.int((op.attrs.width as number) * 8, op.attrs.signed as boolean),
                // the asm materialized this slot's address, and this is how many times it
                // loaded and stored through it — both asm facts, and the gate the
                // l3/volatileval.ts lever reads (see the SFn.locals doc)
                ...frameRecord(op),
                // an ESCAPED address makes every store observable (the DMA hardware reads it), and
                // the source spells the scratch volatile for that reason — see the stamp site in
                // frontend/thumb.ts for why it is the SPELLING that matters and not dead-store
                // elimination, which keeps the store either way
                ...(op.attrs.volatile === true ? { volatile: true as const } : {}),
              },
            ]),
        ).values(),
      ],
      // uninitialised locals (undef): declared, never assigned, typed by whatever recovery settled
      // on for the value.
      ...fn.blocks
        .flatMap((b) => b.ops)
        .filter((op) => op.opcode === 'undef')
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
    retType: returnsVoid ? T.void() : returnType(fn),
    body,
    ...(structs.length ? { structs } : {}),
  };
}

// Does any statement CONTINUE this loop (vs. a nested one)? A `continue` inside a nested while/dowhile/
// for targets THAT loop, so we do not descend into them; but `if`/`switch` do not capture `continue`,
// so we scan through those. DEFENSIVE: the structurer does not currently emit an explicit `continue`
// node (the in-body early-exit is an IMPLICIT continue — a fall-through to the loop bottom — and a
// conditional continue DECLINES), so this never fires today; it guards the one case where the while→for
// re-bracketing would change semantics (a `continue` runs `inc` under `for`, skips it under `while`).
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
  if (thenS.length === 0 && elseS.length > 0) {
    return { k: 'if', cond: negateCond(cond), then: elseS, else: [] };
  }
  return { k: 'if', cond, then: thenS, else: elseS };
}

// --- CFG utilities ---
function predecessorBlocks(fn: Fn): Map<Block, Block[]> {
  const m = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    m.set(b, []);
  }
  for (const b of fn.blocks) {
    for (const s of successorsOf(b)) {
      m.get(s)!.push(b);
    }
  }
  return m;
}
function successorTo(pred: Block, target: Block) {
  const term = pred.ops[pred.ops.length - 1];
  return term.successors.find((s) => s.block === target);
}

// Immediate post-dominators. EXIT is represented as `null`; ret-blocks post-lead to it.
function postDominators(fn: Fn): Map<Block, Block | null> {
  const nodes: (Block | null)[] = [null, ...fn.blocks];
  const succ = (b: Block): (Block | null)[] => {
    const term = b.ops[b.ops.length - 1];
    return term.opcode === 'ret' ? [null] : successorsOf(b);
  };
  const pdom = new Map<Block | null, Set<Block | null>>();
  pdom.set(null, new Set([null]));
  for (const b of fn.blocks) {
    pdom.set(b, new Set(nodes));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of fn.blocks) {
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
  for (const b of fn.blocks) {
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
