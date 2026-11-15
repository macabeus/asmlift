// L3 respell variation: return from each arm instead of merging into a local that is only returned.
//
// `if (c) { v = a; } else { v = b; } return v;` and `if (c) { return a; } return b;` are one
// program when `v` is declared at the function's return type: the assignment converts `a` to `v`'s
// type and the return converts it to the same one, and nothing reads `v` after the `return`. They
// are not one tree to every compiler. With MathUtil_Div16Shift's body, `if (a2 == 0) return 0;
// return X;` and the merged spelling compile alike on agbcc -O2, gcc 2.7.2 -O2 and KMC gcc
// -O1/-O2, and differ on IDO 7.1 -O2 and mwcc -O4,p; other bodies of the same shape differ on
// agbcc too (compiled pairs over eleven compiler/levels). So which one the source wrote is a
// per-function question the differ referees, and the merged spelling stays in the fan beside it.
//
// Polarity is not this pass's choice: it rides every structured tree, `/flip-join`'s included, so
// `if (a2 != 0) return X; return 0;` and `if (a2 == 0) return 0; return X;` are two candidates.
// The arm that returns first keeps its braces and the other arm follows the `if`, which is how a
// reader writes it.
//
// WHERE IT FIRES. An `if` with both arms, followed in the same list by `return v;`, where:
//   • `v` is a local this function declares, not `volatile`, at exactly the return type (any
//     other type converts `a` twice and once respectively, which is other arithmetic);
//   • each arm ENDS by setting `v` — its last statement is `v = e;` (not a compound one), or an
//     `if` with both arms that ends that way in turn, or a statement no path runs past (a
//     `return`, a `break`, a `goto`). Any other last statement declines the site.
// The `return v;` after the `if` is then unreachable and is dropped, and so is `v`'s declaration
// once nothing names it.
import { T, typeEquals } from '../ir/types';
import { type SFn, type Stmt, mapStmtLists, reachesEnd } from './ast';
import { mentionedLocals } from './mentions';

/** `arm` with its final assignment to `v` returned instead, or null where it does not end that way.
 *  A nested `if` is split the way the outer one is (`splitArms`), so no `else` is left after a
 *  `return` at any depth. */
function returnFrom(arm: readonly Stmt[], v: string): Stmt[] | null {
  const last = arm[arm.length - 1];
  if (last === undefined) {
    return null;
  }
  const head = arm.slice(0, -1);
  if (last.k === 'assign' && last.name === v && last.compound !== true) {
    return [...head, { k: 'return', value: last.value }];
  }
  if (last.k === 'if' && last.else.length > 0) {
    const split = splitArms(last, v);
    return split && [...head, ...split];
  }
  return reachesEnd([last]) ? null : [...arm];
}

/** `s`, an `if` with both arms, as `if (c) { …return a; } …return b;`: its first arm returns inside
 *  the `if` and its other arm follows it. Null where an arm does not end by setting `v` or leaving. */
function splitArms(s: Extract<Stmt, { k: 'if' }>, v: string): Stmt[] | null {
  const t = returnFrom(s.then, v);
  const e = returnFrom(s.else, v);
  return t && e && !reachesEnd(t) && !reachesEnd(e) ? [{ ...s, then: t, else: [] }, ...e] : null;
}

export function splitReturnedMerges(sfn: SFn): SFn | null {
  if (typeEquals(sfn.retType, T.void())) {
    return null;
  }
  const returnable = new Set(
    sfn.locals.filter((l) => !l.volatile && typeEquals(l.type, sfn.retType)).map((l) => l.name),
  );
  const split = new Set<string>();
  const list = (stmts: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < stmts.length; i++) {
      const s = mapStmtLists(stmts[i], list);
      const next = stmts[i + 1];
      const v = next?.k === 'return' && next.value?.k === 'var' ? next.value.name : undefined;
      if (s.k === 'if' && s.else.length > 0 && v !== undefined && returnable.has(v)) {
        const arms = splitArms(s, v);
        if (arms) {
          out.push(...arms);
          split.add(v);
          i++; // the `return v;` no path reaches any more
          continue;
        }
      }
      out.push(s);
    }
    return out;
  };
  const body = list(sfn.body);
  if (split.size === 0) {
    return null;
  }
  const named = mentionedLocals(body, split);
  return { ...sfn, body, locals: sfn.locals.filter((l) => !split.has(l.name) || named.has(l.name)) };
}
