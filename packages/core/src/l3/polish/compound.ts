// `x++`, `x--`, `x += k` and `x -= k` for a statement that adds a literal to what it writes:
// `x = x + 1;`, `v0[i] = v0[i] - 4;`, and a `for` update.
//
// `E1 op= E2` is `E1 = E1 op (E2)` with E1 evaluated ONCE, so the rewrite is the same program
// exactly where evaluating the target twice is evaluating it once. It fires only where that holds
// in the strictest reading:
//   • the target is a parameter or a local this function declares, not `volatile` — a global's
//     qualifier is the project's, and not in the tree; or a store whose address reads only such
//     names and constants — no call, no post-increment, no load (`p->q->n` loads `p->q` once where
//     it was spelled twice) and nothing `volatile`;
//   • the added value is an integer LITERAL. `x = x + e` and `x += e` are one program for any `e`,
//     but not one tree to IDO 7.1, which spells the add's operands in the other order for the compound
//     (`addu v1,v1,t9` against `addu v1,t9,v1` for `v0 += v7 * v8` in `synthetic:dotprod`, -O2
//     -mips2, compiled), where `v4 += 4` and `v1++` compile alike;
//   • the statement is exactly the target, `+` or `-`, and the literal: a cast the pointer-write
//     legalization put around the sum (it runs first) is no compound.
// `1` is spelled `++`/`--`. The statement keeps its node; `compound` asks the printer for the
// spelling, and the printer checks the shape again before using it.
import { type Expr, type SFn, type Stmt, exprChildren, exprEquals, exprReadsVolatile, mapStmtLists } from '../ast';

/** Reads only declared non-volatile locals and parameters and constants, and loads nothing. */
function plainAddress(e: Expr, names: ReadonlySet<string>): boolean {
  switch (e.k) {
    case 'var':
      return names.has(e.name);
    case 'const':
      return true;
    case 'bin':
    case 'cast':
      return exprChildren(e).every((c) => plainAddress(c, names));
    default:
      return false;
  }
}

function pureTarget(lval: Expr, names: ReadonlySet<string>): boolean {
  if (lval.k === 'index') {
    return !lval.lead?.length && plainAddress(lval.base, names) && plainAddress(lval.idx, names);
  }
  if (lval.k === 'field') {
    return lval.base.k !== 'index' && plainAddress(lval.base, names);
  }
  return false;
}

/** The sum a compound statement spells, if `value` is `target + e` or `target - e`. */
export function compoundSum(target: Expr, value: Expr): { op: '+' | '-'; rhs: Expr } | null {
  return value.k === 'bin' && (value.op === '+' || value.op === '-') && exprEquals(value.l, target)
    ? { op: value.op, rhs: value.r }
    : null;
}

export function compoundAssignments(fn: SFn): SFn {
  const names = new Set([
    ...fn.params.map((p) => p.name),
    ...fn.locals.filter((l) => !l.volatile && !l.pointeeVolatile).map((l) => l.name),
  ]);
  for (const l of fn.locals) {
    if (l.volatile) {
      names.delete(l.name);
    }
  }
  const valueOk = (rhs: Expr): boolean => rhs.k === 'const' && Number.isInteger(rhs.value);
  const one = (s: Stmt): Stmt => {
    if (s.k === 'assign' && names.has(s.name)) {
      const target: Expr = { k: 'var', name: s.name };
      const sum = compoundSum(target, s.value);
      return sum && valueOk(sum.rhs) ? { ...s, compound: true } : s;
    }
    if (s.k === 'store' && pureTarget(s.lval, names) && !exprReadsVolatile(s.lval, fn)) {
      const sum = compoundSum(s.lval, s.value);
      return sum && valueOk(sum.rhs) ? { ...s, compound: true } : s;
    }
    if (s.k === 'for') {
      return { ...s, init: one(s.init), inc: one(s.inc), body: s.body.map(one) };
    }
    return mapStmtLists(s, (list) => list.map(one));
  };
  return { ...fn, body: fn.body.map(one) };
}
