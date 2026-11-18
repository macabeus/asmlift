// `x++`, `x--`, `x += k` and `x -= k` for a statement that adds a literal to the local it writes:
// `x = x + 1;`, `v0 = v0 - 4;`, and a `for` update.
//
// `E1 op= E2` is `E1 = E1 op (E2)` with E1 evaluated ONCE, so for a plain name it is the same
// program. It is the same TREE to the compilers only in a narrower set, and the pass fires only
// there:
//   • the target is a parameter or a local this function declares, not `volatile` — a global's
//     qualifier is the project's, and not in the tree;
//   • of a full-word integer or a pointer type. A narrower one is other code on mwcc at every level:
//     a `u8` local's `v--` and an `s16`'s `v += 4` against `v = v - 1` and `v = v + 4` differ on
//     mwcc 2.4.2 at -O0,p through -O4,p and at -O4,s, on 2.4.7 and on 2.3.3 at -O4,p, and on agbcc
//     and both gcc 2.7.2 builds at -O0;
//   • NOT a store through memory. `*p = *p + 1` against `(*p)++` and `p[i] = p[i] + 1` against
//     `p[i]++` are other code on agbcc, gcc 2.7.2 and KMC gcc at -O0 and on every mwcc build at
//     -O0,p, and the second also on mwcc 2.3.3 at -O4,p;
//     and three narrow member stores `p->a++; p->b -= 2; p->c++;` schedule their loads in another
//     order on gcc 2.7.2 and KMC gcc at -O2;
//   • the added value is an integer LITERAL. `x = x + e` and `x += e` are one program for any `e`,
//     but not one tree to IDO 7.1, which spells the add's operands in the other order for the compound
//     (`addu v1,v1,t9` against `addu v1,t9,v1` for `v0 += v7 * v8` in `synthetic:dotprod`, -O2
//     -mips2, compiled), where `v4 += 4` and `v1++` compile alike;
//   • the statement is exactly the target, `+` or `-`, and the literal: a cast the pointer-write
//     legalization put around the sum (it runs first) is no compound;
//   • not at a level that compiles each statement as written (`PolishFacts.literal`): gcc 2.7.2 and
//     KMC gcc at -O0 spell even an `int` local's `v++` with another register move.
// Measured over every pair above, compiled at agbcc -O0/-O1/-O2, IDO 7.1 -O0/-O1/-O2, gcc 2.7.2
// and KMC gcc -O0/-O1/-O2, mwcc 2.4.2 -O0,p through -O4,p and -O4,s, and mwcc 2.4.7 and 2.3.3 at
// -O0,p and -O4,p: an `s32`, `u32` or pointer local or parameter stepped by a literal, alone, in a
// `for` update or beside narrow stores, compiles alike everywhere but gcc 2.7.2 and KMC gcc at -O0.
// `1` is spelled `++`/`--`. The statement keeps its node; `compound` asks the printer for the
// spelling, and the printer checks the shape again before using it.
import type { PolishFacts } from '.';
import type { IrType } from '../../ir/types';
import { type Expr, type SFn, type Stmt, exprEquals, mapStmtLists } from '../ast';

/** The sum a compound statement spells, if `value` is `target + e` or `target - e`. */
export function compoundSum(target: Expr, value: Expr): { op: '+' | '-'; rhs: Expr } | null {
  return value.k === 'bin' && (value.op === '+' || value.op === '-') && exprEquals(value.l, target)
    ? { op: value.op, rhs: value.r }
    : null;
}

const wordOrPointer = (t: IrType): boolean => (t.kind === 'int' && t.width === 32) || t.kind === 'ptr';

/** `fn` with every statement `valueOk` admits marked compound, over the targets the header admits.
 *  Shared with the `/compound-expr` variation (l3/compoundexpr.ts), which marks the non-literal
 *  values this polish leaves alone. */
export function markCompound(fn: SFn, valueOk: (rhs: Expr) => boolean): { fn: SFn; marked: number } {
  const names = new Set([
    ...fn.params.filter((p) => wordOrPointer(p.type)).map((p) => p.name),
    ...fn.locals.filter((l) => !l.volatile && wordOrPointer(l.type)).map((l) => l.name),
  ]);
  for (const l of fn.locals) {
    if (l.volatile) {
      names.delete(l.name);
    }
  }
  let marked = 0;
  const one = (s: Stmt): Stmt => {
    if (s.k === 'assign' && names.has(s.name) && s.compound !== true) {
      const sum = compoundSum({ k: 'var', name: s.name }, s.value);
      if (sum && valueOk(sum.rhs)) {
        marked++;
        return { ...s, compound: true };
      }
      return s;
    }
    if (s.k === 'for') {
      return { ...s, init: one(s.init), inc: s.inc.map(one), body: s.body.map(one) };
    }
    return mapStmtLists(s, (list) => list.map(one));
  };
  return { fn: { ...fn, body: fn.body.map(one) }, marked };
}

export const literal = (rhs: Expr): boolean => rhs.k === 'const' && Number.isInteger(rhs.value);

export function compoundAssignments(fn: SFn, facts: PolishFacts): SFn {
  return facts.literal ? fn : markCompound(fn, literal).fn;
}
