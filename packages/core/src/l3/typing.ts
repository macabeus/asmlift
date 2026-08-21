// asmlift L3 — the C-facing static type of a RENDERED expression.
//
// The IR carries recovered types on VALUES, but structuring renders a value as an EXPRESSION
// (a declared var, an inlined arithmetic tree, a literal), and the C type of that expression is
// what the compiler will actually see — which can disagree with the value's recovered type
// (`recoverTypes` may type an `add` result as a pointer while both its operands render as
// declared-`s32` vars, so the C type of `a0 + a1` is `int`, not `T *`). Every memory access the
// structurer emits derefs a RENDERED base, so its C-validity is decided by THIS type, not the
// value's. `exprCType` computes it bottom-up from the declared variable types.
//
// Contract: POINTER-NESS-accurate, not signedness-accurate. Callers use this to decide whether an
// expression is a C pointer (and of what pointee) — integer results are uniformly reported `s32`
// with NO promotion/unsignedness modeling, so this must never be consulted for signedness or
// width of integer arithmetic. Returns `undefined` when the type is not statically knowable here
// (a call — its C type comes from a prototype outside the emitted function; a gap marker; a var
// missing from the environment; an ill-typed shape like `ptr + ptr` or a deref of a non-pointer).
// Callers choose their conservative direction: the emission guard treats `undefined` as "not
// provably a pointer" (adds a cast — valid C either way); the deref contract treats `undefined`
// as "not provably wrong" (no error).
import { IrType, T, scalarTypeForAccess } from '../ir/types';
import type { Expr, SFn } from './ast';

/** The declared type of a printed variable — the env `exprCType` judges rendered C against.
 *  THE one copy of the SFn→env derivation (C printer, Pascal printer, deref contract): each
 *  consumer judging against anything but the declarations it emits would let them disagree. */
export type VarTypes = (name: string) => IrType | undefined;

export function declaredTypes(fn: SFn): VarTypes {
  const m = new Map<string, IrType>();
  // shape-known project globals first, so a (theoretical) local of the same name wins
  for (const g of fn.globals ?? []) {
    m.set(g.name, g.type);
  }
  for (const p of fn.params) {
    m.set(p.name, p.type);
  }
  for (const l of fn.locals) {
    m.set(l.name, l.type);
  }
  return (n) => m.get(n);
}

// Byte size of a pointer's element, for C pointer-arithmetic scaling. A scalar (`int`) or pointer
// pointee has an unambiguous size; a struct/array/void pointee returns 0 = "do not scale" (the
// stride is the aggregate size or unknown — left raw rather than guessed). Lives here (not in
// ir/types.ts) because element scaling is a C-semantics fact, not an IR fact.
export function ptrElemBytes(to: IrType): number {
  return to.kind === 'int' ? to.width / 8 : to.kind === 'ptr' ? 4 : 0;
}

/** May a `width`-byte access of the given signedness dereference a base of rendered C type `rt` AS
 *  SPELLED — i.e. is `rt` a pointer/array whose element size equals the access width, and whose
 *  element extends the way the access does? THE one copy of the stride rule:
 *  the C-family printer decides cast insertion from it, the Pascal backend decides declining from
 *  it, and exprCType types the access result from it. `false` for a non-pointer, an unknowable
 *  base (undefined), or a pointer of the WRONG stride — a wrong-stride deref would make C read
 *  the wrong width and scale the index by the wrong element size. */
export function derefStrideOk(rt: IrType | undefined, width: number, signed: boolean): boolean {
  // SIGNEDNESS COUNTS WHEREVER THE ACCESS EXTENDS. A sub-word load fills the top bits from either
  // the sign bit or zero, and in the emitted C the pointee type is the ONLY thing that says which —
  // so a base of the wrong signedness has to take the reinterpret cast exactly as a base of the
  // wrong stride does. Read `*(u8 *)p` where the machine did `ldrsb` and `p[9] < 0` is not merely a
  // different value: an `unsigned char` promotes to a non-negative `int`, so the arm goes dead.
  // A word access extends nothing, and a POINTER pointee is a word.
  const extendsOk = (to: IrType) => width === 4 || (to.kind === 'int' && to.signed === signed);
  if (rt?.kind === 'ptr') {
    return rt.to.kind !== 'struct' && ptrElemBytes(rt.to) === width && extendsOk(rt.to);
  }
  if (rt?.kind === 'array') {
    return rt.elem.kind === 'int' && rt.elem.width === width * 8 && extendsOk(rt.elem);
  }
  return false;
}

/** Does the rendered expression PROMOTE to `unsigned int` under C's usual arithmetic
 *  conversions — the fact that decides a `<`'s compare signedness? Tri-state: true/false when
 *  provable from the declared types, undefined when not (a call's C type lives in the project
 *  ctx). Narrower ints promote to signed `int`, so only a full-width unsigned (or a pointer)
 *  answers true. Shifts take the LEFT operand's promoted type; comparisons/logic yield `int`.
 *  This is deliberately separate from `exprCType`, whose integer results are pointer-ness-only
 *  (its contract forbids consulting it for signedness); the leaf cases delegate to it because
 *  var/cast/index/field types ARE the declarations it judges against. */
export function promotesUnsigned(e: Expr, varType: VarTypes): boolean | undefined {
  const rec = (x: Expr): boolean | undefined => promotesUnsigned(x, varType);
  switch (e.k) {
    case 'const':
      return false;
    case 'un':
      return e.op === '!' ? false : rec(e.e);
    case 'bin': {
      if (['<', '<=', '>', '>=', '==', '!=', '&&', '||'].includes(e.op)) {
        return false;
      }
      if (e.op === '<<' || e.op === '>>' || e.op === '>>>') {
        return rec(e.l);
      }
      const l = rec(e.l);
      const r = rec(e.r);
      return l === true || r === true ? true : l === false && r === false ? false : undefined;
    }
    default: {
      const t = exprCType(e, varType);
      if (t === undefined) {
        return undefined;
      }
      if (t.kind === 'ptr' || t.kind === 'array') {
        return true;
      }
      return t.kind === 'int' ? t.width === 32 && !t.signed : undefined;
    }
  }
}

/** Is the rendered expression provably in [0, 2^31) — the range where a signed and an unsigned
 *  compare agree on every input (and where gcc itself emits the unsigned branch for the signed
 *  spelling)? Narrow unsigned values are the everyday case: a `(u8)x` cast or a `u8`/`u16`
 *  deref promotes to a non-negative `int`. Conservative false elsewhere. */
export function provablyNonNegative(e: Expr, varType: VarTypes): boolean {
  switch (e.k) {
    case 'const':
      return e.value >= 0 && e.value < 0x80000000;
    case 'un':
      return e.op === '!';
    case 'bin':
      return ['<', '<=', '>', '>=', '==', '!=', '&&', '||'].includes(e.op);
    case 'cast':
      return e.to.kind === 'int' && e.to.width < 32 && !e.to.signed;
    default: {
      const t = exprCType(e, varType);
      return t?.kind === 'int' && t.width < 32 && !t.signed;
    }
  }
}

export function exprCType(e: Expr, varType: (name: string) => IrType | undefined): IrType | undefined {
  const rec = (x: Expr): IrType | undefined => exprCType(x, varType);
  switch (e.k) {
    case 'var':
      return varType(e.name);
    // An integer literal spells as a plain C `int` — NEVER a pointer, whatever the value's
    // recovered type was. This is the exact gap the emission guard exists to bridge.
    case 'const':
      return T.s(32);
    case 'cast':
      return e.to;
    // `-`/`~` yield the promoted integer; `!` yields int. None yields a pointer.
    case 'un':
      return T.s(32);
    case 'bin': {
      if (e.op === '+' || e.op === '-') {
        const l = rec(e.l);
        const r = rec(e.r);
        // C pointer arithmetic: ptr ± int is that pointer type; int + ptr commutes; ptr - ptr is
        // an integer; ptr + ptr is not C at all (unknowable — the emitter legalizes it away).
        // Anything else is the usual arithmetic int.
        const lp = l?.kind === 'ptr';
        const rp = r?.kind === 'ptr';
        if (lp && rp) {
          return e.op === '-' ? T.s(32) : undefined;
        }
        if (lp) {
          return l;
        }
        if (rp && e.op === '+') {
          return r;
        }
        return T.s(32);
      }
      // comparisons/logic yield int; *,/,%,&,|,^,<<,>> yield the arithmetic int.
      return T.s(32);
    }
    // A callee's C return type comes from a prototype OUTSIDE the emitted function (the
    // project ctx / C89 implicit int) — not statically knowable here.
    case 'call':
      return undefined;
    case 'index': {
      // `base[idx]` / `*base`: the element type of the base's pointer/array type when the base
      // strides the access width AS RENDERED — otherwise the backend legalizes with a reinterpret
      // cast at the access width, so the access reads exactly the node's scalar type. TOTAL: an
      // index node always has a C type, because the carried width always yields a legal spelling.
      //
      // A STRUCT pointee is the dot-form exception: `arr[i]` on a `struct S *` base is a struct
      // VALUE (the array element under a `.field` access; its width is the struct STRIDE, its
      // legalization the tree-level struct cast) — falling through to the scalar default here
      // would type it `s96`-style garbage and make the field contract reject valid trees. The
      // node width must AGREE with the element size (when the struct declares one): a mismatch
      // means the stride channel is corrupt, so it types scalar and the field contract flags it.
      const bt = rec(e.base);
      if (bt?.kind === 'ptr' && bt.to.kind === 'struct' && (bt.to.size === undefined || bt.to.size === e.width)) {
        return bt.to;
      }
      if (bt?.kind === 'ptr' && derefStrideOk(bt, e.width, e.signed)) {
        return bt.to;
      }
      if (bt?.kind === 'array' && derefStrideOk(bt, e.width, e.signed)) {
        return bt.elem;
      }
      return scalarTypeForAccess(e.width, e.signed);
    }
    case 'field': {
      // `base->name` (base: ptr-to-struct) or `base.name` (base: struct value, an array element).
      const bt = rec(e.base);
      const st = bt?.kind === 'ptr' ? bt.to : bt;
      if (st?.kind !== 'struct') {
        return undefined;
      }
      return st.fields.find((f) => f.name === e.name)?.type;
    }
    case 'marker':
      return undefined;
    // `&gSym` is a pointer, but the global's type comes from the project headers — not knowable
    // here. Callers treat undefined conservatively (the deref of an addr is simplified away in
    // structure.ts before it reaches a legalization decision).
    case 'addr':
      return undefined;
  }
}
