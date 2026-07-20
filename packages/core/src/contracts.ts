// asmlift — stage boundary contracts: semantic POSTCONDITIONS enforced in production at the
// stage boundaries, in every entry path (decompile / decompileTraced / the cli's
// decompileRanked / decompileWithReport).
// A pass that regresses fails AT its boundary with a diagnostic, not three stages later as
// wrong C.
import type { Fn, Value } from './ir/core';
import { type IrType, typeToString } from './ir/types';
import type { Expr, SFn, Stmt } from './l3/ast';
import { exprChildren, fieldSpellsDot, stmtChildren, stmtExprs } from './l3/ast';
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

/** Post structuring: the AST must reference no unresolved value. The structurer emits the
 *  sentinel var `"?"` when it cannot resolve a value (a dropped def, or an opcode it has no
 *  lowering for) — which would print as uncompilable source. Fail at the structuring boundary
 *  instead of emitting garbage. */
export function assertResolved(sfn: SFn): void {
  // Derived from the shared exprChildren/stmtExprs/stmtChildren traversal so no statement kind
  // can be missed. A gap `marker` is annotate-mode's DESIGNED spelling of an unresolved value
  // ("resolved" by construction); only its args could still hide a stray `"?"` — and args are
  // exactly its children.
  const badExpr = (e: Expr): boolean => (e.k === 'var' && e.name === '?') || exprChildren(e).some(badExpr);
  const badStmt = (s: Stmt): boolean => stmtExprs(s).some(badExpr) || stmtChildren(s).some(badStmt);
  if (sfn.body.some(badStmt)) {
    throw new ContractError(
      `structuring left an unresolved value ('?') in '${sfn.name}' — a dropped def or unlowered opcode`,
    );
  }
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
  // Ops C rejects outright on a pointer operand (the additive ops and &&/|| are legal C).
  const NO_PTR_OPS = new Set(['&', '|', '^', '<<', '>>', '*', '/', '%']);
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
