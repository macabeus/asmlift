// `if (f(x))`, not `if (f(x) != 0)`: a call's result tested for truth, spelled as the test.
//
// THE SAME PROGRAM: a controlling expression is compared with zero by C itself (C89 6.6.4.1,
// 6.6.5), and so is an operand of `&&`, `||` and `!`. Only an INTEGER `!=` (never the float one,
// `f!=`) against the literal `0`, over a call that returns its value (not a struct through memory),
// and only in a truth position: a loop or `if` test, or an operand of `&&`, `||` or `!` in one. A
// value `(f(x) != 0)` stored or returned is the integer 0 or 1, and keeps its compare.
import { type Expr, type SFn, type Stmt, mapStmtLists } from '../ast';

function truth(e: Expr): Expr {
  if (e.k === 'bin' && (e.op === '&&' || e.op === '||')) {
    return { ...e, l: truth(e.l), r: truth(e.r) };
  }
  if (e.k === 'un' && e.op === '!') {
    return { ...e, e: truth(e.e) };
  }
  if (e.k === 'bin' && e.op === '!=') {
    const isCall = (x: Expr) => x.k === 'call' && x.sret === undefined;
    const isZero = (x: Expr) => x.k === 'const' && x.value === 0;
    if (isCall(e.l) && isZero(e.r)) {
      return e.l;
    }
    if (isZero(e.l) && isCall(e.r)) {
      return e.r;
    }
  }
  return e;
}

function one(s0: Stmt): Stmt {
  const s = s0.k === 'for' ? { ...s0, init: one(s0.init), inc: s0.inc.map(one) } : s0;
  const inner = mapStmtLists(s, (list) => list.map(one));
  switch (inner.k) {
    case 'if':
    case 'while':
    case 'dowhile':
    case 'for':
      return { ...inner, cond: truth(inner.cond) };
    default:
      return inner;
  }
}

export function callTruthTests(fn: SFn): SFn {
  return { ...fn, body: fn.body.map(one) };
}
