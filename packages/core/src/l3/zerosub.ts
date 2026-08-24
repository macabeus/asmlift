// L3 re-spelling lever: spell a negate of a SHARED subtraction as `0 - x`.
//
// The two C spellings of a negation are not interchangeable in front of gcc 2.9's folder. `-x` is
// built through build_unary_op and FOLDED, so fold-const.c's "Convert - (a - b) to (b - a)"
// (gcc/fold-const.c:4821) rewrites a negated subtraction into the reversed one before CSE ever
// runs. `0 - x` reaches fold as a MINUS_EXPR with a zero left operand and comes back as a bare
// `build1 (NEGATE_EXPR, …)` (gcc/fold-const.c:5082) which is never re-folded, so the subtraction
// survives as itself.
//
// With ONE use that difference is invisible: RTL combine folds the negate back in and both
// spellings emit the same `sub r0, r1, r0`. With the subtraction SHARED — its value also feeding
// the compare that chose the branch — they diverge by more than the negate, because the reversed
// subtraction is a second computation whose operands must stay live: `-(a - b)` costs six
// instructions (one a register copy) where `0 - (a - b)` costs five. Both compiled with agbcc
// `-O2 -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`.
//
// NOT an agbcc rule, so no target gate: compiled on the shared shape, IDO, KMC GCC and gcc
// 2.7.2/MIPS each emit a different function for the two spellings as well — IDO the other way
// round, where `-(a - b)` is the `negu` and `0 - (a - b)` the reversed `subu` — and only mwcc
// collapses them, where the duplicate scores identically and can neither win nor lose.
//
// So which one the source wrote is not recoverable — a `neg` is reachable from `-t` over a named
// local as well — and the differ referees. Semantics are preserved by construction: `-x` and
// `0 - x` are the same C expression for every integer type.
//
// A RE-SPELLING rather than a fourth value-home axis (docs/level-tower.md's third fork). The fold
// rule fires at all only because asmlift INLINED a value the source bound to a local, and naming
// that local reaches the same match by the other route: on `pokeemerald:GetAnchorCoord:agbcc`,
// `s32 t = a1 - a0;` scores 0 against the row's own target.o where the inlined body with a plain
// `-` scores 1. asmlift cannot spell it — all three home axes decline on pedigree (`/addr-home`
// wants an address, `/expr-home` a loop, `/derived-home` a memory read) and this is a bare pure
// value with three consumers. An axis admitting any such value would reach the use shapes a
// substitution cannot, and would double the fan wherever it admits; this costs one candidate per
// distinct tree carrying the shape. Take the axis when a row demands a shape this cannot reach.
//
// SCOPE (decline over approximate). Only a `bin('-')` operand, and only a SHARED one. Neither
// restriction is caution: over any other operand shape the fold rule does not apply and the two
// spellings compile identically (verified for `-(a + b)`, `-(a >> 3)`, `-(a * 3)`, `-a`), so
// firing there could only duplicate the primary. An EFFECTFUL subtraction is out of scope too —
// two textually equal calls are two calls, not one shared value, so the premise fails.
import { type Expr, type SFn, exprEquals, exprHasEffect, mapExprChildren, mapStmtExprs, walkExprs } from './ast';

export function zeroSubNegates(sfn: SFn): SFn | null {
  const subs: Expr[] = [];
  for (const e of walkExprs(sfn.body)) {
    if (e.k === 'bin' && e.op === '-') {
      subs.push(e);
    }
  }
  const shared = (x: Expr): boolean => subs.filter((s) => exprEquals(s, x)).length > 1;
  let changed = false;
  const rewrite = (e: Expr): Expr => {
    const m = mapExprChildren(e, rewrite);
    if (m.k === 'un' && m.op === '-' && m.e.k === 'bin' && m.e.op === '-' && !exprHasEffect(m.e) && shared(m.e)) {
      changed = true;
      return { k: 'bin', op: '-', l: { k: 'const', value: 0 }, r: m.e };
    }
    return m;
  };
  const body = sfn.body.map((s) => mapStmtExprs(s, rewrite));
  return changed ? { ...sfn, body } : null;
}
