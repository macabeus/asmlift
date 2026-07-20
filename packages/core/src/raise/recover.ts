// asmlift — L1→L2 type recovery (a constraint pass). Seeds signedness from op semantics
// (signed comparisons/divisions ⇒ signed operands), types memory-access bases as pointers,
// propagates pointer-ness across the SSA, then defaults the rest to s32. Emits recovered
// types onto the SSA values in place.
import { Fn, Value, defOpMap } from '../ir/core';
import { IrType, T, scalarTypeForAccess, typeEquals } from '../ir/types';

const SIGNED_CMP = new Set(['icmp_slt', 'icmp_sle', 'icmp_sgt', 'icmp_sge']);
const UNSIGNED_CMP = new Set(['icmp_ult', 'icmp_ule', 'icmp_ugt', 'icmp_uge']);
// Division/remainder carry signedness in the OPCODE (a hardware `div` vs `divu`), so they seed it
// onto their operands AND result — the reason the backend can pick signed `/` over unsigned operands.
const SIGNED_DIV = new Set(['sdiv', 'smod']);
const UNSIGNED_DIV = new Set(['udiv', 'umod']);

export function recoverTypes(fn: Fn): void {
  const setInt = (v: Value, signed: boolean) => {
    if (v.type.kind === 'unknown') {
      v.type = T.int(v.type.width, signed);
    }
  };
  // Seed: operands of a signed comparison are signed integers.
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (SIGNED_CMP.has(op.opcode)) {
        op.operands.forEach((o) => setInt(o, true));
      }
      if (UNSIGNED_CMP.has(op.opcode)) {
        op.operands.forEach((o) => setInt(o, false));
      } // sltu ⇒ u32 operands
      if (op.opcode.startsWith('icmp')) {
        op.results.forEach((r) => (r.type = T.u(32)));
      } // bool
      // The register (2-operand) division form seeds operand+result signedness; the immediate form
      // (`sdiv X {imm=…}`, 1 operand) is always the signed strength-reduced divisor.
      if (SIGNED_DIV.has(op.opcode)) {
        op.operands.forEach((o) => setInt(o, true));
        op.results.forEach((r) => setInt(r, true));
      }
      if (UNSIGNED_DIV.has(op.opcode)) {
        op.operands.forEach((o) => setInt(o, false));
        op.results.forEach((r) => setInt(r, false));
      }
      // A rotate is a bitwise permutation: its value operand and result are unsigned (the C
      // idiom's `>>` must be the LOGICAL shift or the spelling stops round-tripping). The
      // rotate AMOUNT (operand 1, register form) keeps its own signedness.
      if (op.opcode === 'rotr' || op.opcode === 'rotl') {
        setInt(op.operands[0], false);
        op.results.forEach((r) => setInt(r, false));
      }
    }
  }
  // A value used as the base of a memory access is a pointer; its pointee type comes from the
  // access width (and, for loads, signedness). This must run before the s32 default so the
  // base is typed `T *` rather than being flattened to a plain integer. Both the constant-offset
  // forms (load/store, width) and the variable-index forms (aload/astore, elemSize) type their
  // base operand[0]; only the scale attribute differs.

  for (const b of fn.blocks) {
    for (const op of b.ops) {
      let width: number, signed: boolean;
      switch (op.opcode) {
        case 'load':
          width = op.attrs.width as number;
          signed = op.attrs.signed as boolean;
          break;
        case 'store':
          width = op.attrs.width as number;
          signed = width === 4;
          break;
        case 'aload':
          width = op.attrs.elemSize as number;
          signed = op.attrs.signed as boolean;
          break;
        case 'astore':
          width = op.attrs.elemSize as number;
          signed = width === 4;
          break;
        default:
          continue;
      }
      const base = op.operands[0];
      if (base.type.kind === 'unknown') {
        base.type = T.ptr(scalarTypeForAccess(width, signed));
      }
    }
  }
  // Propagate pointer-ness across the SSA. The seed above types only the DIRECT base of a dereference;
  // a loop-carried pointer reaches its dereference through a block-arg phi (its incoming `a0`) and a
  // `p = p + stride` walk, so those values stay `unknown` and the s32 default below would spell them
  // `int` — an `int→int*` assignment mwcc/agbcc REJECT (gcc warns). Flow the pointer type across the
  // exact same-value edges (a phi is one value; `ptr ± const` is the same pointer type). Union-find over
  // Value identity. SOUND: every edge connects values that provably hold the same pointer, and we only
  // fill `unknown`s — a class with a conflicting int member or two distinct pointees is left untouched.
  propagatePointers(fn);
  // Default every still-unknown value to s32. This is a COMPILER default (agbcc/IDO/GCC all take
  // plain `int` as the integer default), not a hardware fact — applied uniformly.
  for (const b of fn.blocks) {
    for (const p of b.params) {
      if (p.type.kind === 'unknown') {
        p.type = T.s(32);
      }
    }
    for (const op of b.ops) {
      for (const r of op.results) {
        if (r.type.kind === 'unknown') {
          r.type = T.s(32);
        }
      }
    }
  }
}

// Union-find pointer propagation (see the call site). Unions (1) each successor arg with the block param
// it binds (the phi/copy identity) and (2) an `add`/`sub` result with its non-constant operand when the
// other operand is a constant (a pointer ± an integer offset stays the same pointer type). Then, for each
// class with EXACTLY ONE distinct pointee and NO conflicting int-typed member, every `unknown` member of
// the class is typed with that pointee. Conservative on conflict: a genuinely ambiguous value (used as
// both pointer and integer, or with two pointee widths) is left for the s32 default — sound, never a
// mistype. Types only; changes no op, so it cannot alter compiled bytes except to fix the `int→ptr` form.
//
// Domain assumption (edge type 1): in WELL-TYPED compiler output a block-arg phi merges values of ONE
// type, so a pointer's phi has only pointer incoming args — propagating the pointee across it is exact.
// Genuinely type-punned asm (one register aliasing a pointer and an integer across a merge) has no
// byte-exact C anyway; the `hasInt` conflict guard blocks the common form, and the residual is ill-typed
// input, not a miscompile of well-typed code.
function propagatePointers(fn: Fn): void {
  const parent = new Map<Value, Value>();
  const find = (v: Value): Value => {
    if (!parent.has(v)) {
      parent.set(v, v);
      return v;
    }
    let r = v;
    while (parent.get(r)! !== r) {
      r = parent.get(r)!;
    }
    for (let c = v; parent.get(c)! !== r;) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: Value, b: Value) => {
    parent.set(find(a), find(b));
  };

  const defs = defOpMap(fn);
  const isConst = (v: Value) => defs.get(v)?.opcode === 'const';
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        const n = Math.min(s.args.length, s.block.params.length);
        for (let i = 0; i < n; i++) {
          union(s.args[i], s.block.params[i]);
        }
      }
      if ((op.opcode === 'add' || op.opcode === 'sub') && op.results.length === 1 && op.operands.length === 2) {
        const [x, y] = op.operands;
        const xc = isConst(x),
          yc = isConst(y);
        if (xc !== yc) {
          union(op.results[0], xc ? y : x);
        } // exactly one const ⇒ pointer ± offset
        // A `base + index` add (two non-constant operands) is NOT unioned: base and index are not
        // reliably distinguishable here. Attempting it mis-typed the INDEX as the pointer whenever
        // the true base was itself int-seeded by a pointer comparison (`if (p < lim)` → `sltu`/`cmplw`
        // seeds the base `int`, the index stays `unknown`) — silent-wrong pointer-scaled C. Recovering
        // `add(base,index)` bases needs a stronger base/index discriminator; deferred rather than
        // risk a miscompile.
      }
    }
  }

  // Per class: the distinct pointees seen, and whether any member is a definite integer (a conflict).
  const info = new Map<Value, { pointees: IrType[]; hasInt: boolean }>();
  for (const v of parent.keys()) {
    const root = find(v);
    let e = info.get(root);
    if (!e) {
      e = { pointees: [], hasInt: false };
      info.set(root, e);
    }
    if (v.type.kind === 'ptr' && !e.pointees.some((t) => typeEquals(t, v.type))) {
      e.pointees.push(v.type);
    }
    if (v.type.kind === 'int') {
      e.hasInt = true;
    }
  }
  for (const v of parent.keys()) {
    if (v.type.kind !== 'unknown') {
      continue;
    }
    const e = info.get(find(v))!;
    if (e.pointees.length === 1 && !e.hasInt) {
      v.type = e.pointees[0];
    }
  }
}

/** The recovered return type = the type of the value returned by the first `ret`. */
export function returnType(fn: Fn): IrType {
  for (const b of fn.blocks) {
    const term = b.ops[b.ops.length - 1];
    if (term?.opcode === 'ret') {
      if (term.operands.length === 0) {
        return T.s(32);
      }
      const v = term.operands[0];
      return v.type.kind === 'unknown' ? T.s(32) : v.type;
    }
  }
  return T.s(32);
}
