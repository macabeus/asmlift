// L3 re-spelling lever: park incoming ARGUMENTS first in the entry straight-line prefix.
//
// A copy of an incoming parameter into a local (`v = a1`) reproduces the register park the
// compiler performed to free a caller-save register (`mov ip, r1`). The park instruction lifts
// to pure SSA aliasing — no op, no position — so the emitted order falls out of block emission
// (materialized statements first, edge copies last), while the compiler may have parked BEFORE
// any of those statements ran (hipress homes its counter in ip before loading a byte into the
// vacated r1). Both orders are legitimate C for the same asm; this lever emits the park-first
// sibling and the differ referees.
//
// SCOPE (decline over approximate): only plain assigns in the ENTRY straight-line prefix (the
// leading run of assigns) move; a park's RHS must read parameters alone through pure scalar
// nodes (var/const/un/bin/cast — a memory read or a call would be re-scheduled, not re-spelled);
// and a park never crosses a statement that writes a name it reads, or reads or writes its
// destination. Relative order — of the parks and of everything else — is preserved. Declines
// (null) when nothing moves.
import type { Expr, SFn, Stmt } from './ast';
import { exprChildren } from './ast';

type Assign = Extract<Stmt, { k: 'assign' }>;

const readVars = (e: Expr, acc: Set<string> = new Set()): Set<string> => {
  if (e.k === 'var') {
    acc.add(e.name);
  }
  for (const c of exprChildren(e)) {
    readVars(c, acc);
  }
  return acc;
};

const pureOverParams = (e: Expr, params: ReadonlySet<string>): boolean => {
  switch (e.k) {
    case 'var':
      return params.has(e.name);
    case 'const':
      return true;
    case 'un':
    case 'cast':
      return pureOverParams(e.e, params);
    case 'bin':
      return pureOverParams(e.l, params) && pureOverParams(e.r, params);
    default:
      return false;
  }
};

export function parkParamsFirst(sfn: SFn): SFn | null {
  const params = new Set(sfn.params.map((p) => p.name));
  let n = 0;
  while (n < sfn.body.length && sfn.body[n].k === 'assign') {
    n++;
  }
  const prefix = sfn.body.slice(0, n) as Assign[];
  const parks: Assign[] = [];
  const rest: Assign[] = [];
  for (const st of prefix) {
    // `rest` is exactly what this park would cross — a REFUSED earlier park is in it, so a later
    // park is re-checked against it like any other crossed statement.
    if (!params.has(st.name) && pureOverParams(st.value, params)) {
      const reads = readVars(st.value);
      if (rest.every((c) => !reads.has(c.name) && c.name !== st.name && !readVars(c.value).has(st.name))) {
        parks.push(st);
        continue;
      }
    }
    rest.push(st);
  }
  if (parks.length === 0 || parks.every((p, i) => prefix[i] === p)) {
    return null; // nothing to move, or the parks already lead the prefix
  }
  return { ...sfn, body: [...parks, ...rest, ...sfn.body.slice(n)] };
}
