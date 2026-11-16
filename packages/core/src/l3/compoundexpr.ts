// L3 respell variation `/compound-expr`: `x += e` for an added value `e` that is NOT a literal.
//
// `x = x + e` and `x += e` are one program for a plain name, and the readability polish
// (l3/polish/compound.ts) already prints the compound for a literal `e`, where every compiler the
// bench covers builds the two alike. For any other `e` they are not one tree to IDO 7.1, which spells
// the add's operands in the other order for the compound (`addu v1,v1,t9` against `addu v1,t9,v1`
// for `v0 += v7 * v8` in `synthetic:dotprod`, -O2 -mips2, compiled). So which one the source wrote
// is a per-function question the differ referees, and this is a ranked candidate beside the plain
// spelling, at every level — not a polish, which may only hold what no compiler tells apart.
//
// WHERE IT FIRES: the polish's targets (a word or pointer parameter or local, not `volatile`, written
// as itself plus or minus `e`; its header carries the measurements that bound them), with a
// non-literal `e`. Declines where no statement qualifies.
import type { SFn } from './ast';
import { literal, markCompound } from './polish/compound';

export function compoundExpressionAssignments(fn: SFn): SFn | null {
  const { fn: out, marked } = markCompound(fn, (rhs) => !literal(rhs));
  return marked > 0 ? out : null;
}
