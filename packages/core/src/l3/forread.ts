// L3 respell variation: a `do`/`while` whose first test is already known to pass, read as `for`.
//
// `i = K; do { B; i = step; } while (i OP L);` with `K OP L` true is `for (i = K; i OP L; i = step)
// { B }`: the `for`'s first test runs right after `i = K`, where it holds, so both run `B` and the
// step, then test. Compilers rotate a `for` whose entry test they can fold into exactly that
// `do`/`while`, so the assembly does not say which the source wrote. They compile alike at every
// optimizing level measured for a word counter (agbcc -O2, IDO 7.1 -O2, gcc 2.7.2 -O2, KMC gcc
// -O1/-O2, mwcc -O4,p), and differ on mwcc -O4,p for a `u8` counter or a pointer walk and at every
// -O0 (compiled pairs over eleven compiler/levels), so the `for` is a candidate beside the loop as
// recovered.
//
// WHERE IT FIRES, each site independently, all of them in one candidate: a `dowhile` right after
// `v = K;` in the same list, where
//   • the test is `v OP L` (`<`, `<=`, `>`, `>=`, `!=`) with `v` bare on the left and both `K` and
//     `L` integer literals in 0 .. 2^31-1, so the test's signedness cannot change its answer, and
//     `K` is in range of `v`'s declared type (a narrower `v` would hold another value);
//   • the body's last statement assigns `v` (it becomes the step), and no `continue` binds to
//     this loop — a `continue` skips the step in the `do` and runs it in the `for`.
import type { IrType } from '../ir/types';
import { type Expr, type SFn, type Stmt, isLoop, mapStmtLists, stmtLists } from './ast';

const MAX = 2 ** 31 - 1;
const literal = (e: Expr): number | null =>
  e.k === 'const' && Number.isInteger(e.value) && e.value >= 0 && e.value <= MAX ? e.value : null;

function holds(op: string, k: number, l: number): boolean {
  switch (op) {
    case '<':
      return k < l;
    case '<=':
      return k <= l;
    case '>':
      return k > l;
    case '>=':
      return k >= l;
    case '!=':
      return k !== l;
    default:
      return false;
  }
}

/** Does `k` fit `t` unchanged? Only an integer or pointer type is a counter here. */
function fits(t: IrType | undefined, k: number): boolean {
  if (t === undefined) {
    return false;
  }
  if (t.kind === 'ptr') {
    return true;
  }
  return t.kind === 'int' && k < 2 ** (t.signed ? t.width - 1 : t.width);
}

/** Does a `continue` in `body` bind to the loop that holds it — none inside a nested loop counts? */
function continuesHere(body: readonly Stmt[]): boolean {
  return body.some((s) => s.k === 'continue' || (!isLoop(s) && stmtLists(s).some(continuesHere)));
}

export function readDoWhileAsFor(sfn: SFn): SFn | null {
  const types = new Map<string, IrType>([
    ...sfn.params.map((p) => [p.name, p.type] as const),
    ...sfn.locals.filter((l) => !l.volatile).map((l) => [l.name, l.type] as const),
  ]);
  let changed = false;
  const list = (stmts: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (const s0 of stmts) {
      const s = mapStmtLists(s0, list);
      const init = out[out.length - 1];
      if (s.k === 'dowhile' && init?.k === 'assign' && init.compound !== true) {
        const v = init.name;
        const k = literal(init.value);
        const c = s.cond;
        const l = c.k === 'bin' && c.l.k === 'var' && c.l.name === v ? literal(c.r) : null;
        const step = s.body[s.body.length - 1];
        if (
          k !== null &&
          l !== null &&
          c.k === 'bin' &&
          holds(c.op, k, l) &&
          fits(types.get(v), k) &&
          step?.k === 'assign' &&
          step.name === v &&
          !continuesHere(s.body)
        ) {
          out[out.length - 1] = { k: 'for', init, cond: c, inc: step, body: s.body.slice(0, -1) };
          changed = true;
          continue;
        }
      }
      out.push(s);
    }
    return out;
  };
  const body = list(sfn.body);
  return changed ? { ...sfn, body } : null;
}
