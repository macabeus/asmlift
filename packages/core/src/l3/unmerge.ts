// L3 re-spelling lever: duplicate a join statement back into the arms the compiler merged it out
// of — the dual of l3/tailmerge.ts, and a LEVER where that one is unconditional.
//
// agbcc cross-jumps a store the source wrote in both arms into the join block, so the lifted CFG
// carries the address and the value on merge parameters and SSA destruction mints a temp per
// parameter:
//
//     if (c) { … v16 = (u16 *)A1; v17 = B1; } else { … v16 = (u16 *)A2; v17 = B2; }
//     *v16 = v17;
//
// The source that produced those bytes wrote `*(u16 *)A1 = B1;` inside one arm and
// `*(u16 *)A2 = B2;` inside the other — two whole statements, no temps. Substituting each arm's
// own definitions into the join statement and duplicating it back recovers that spelling.
//
// A LEVER, NOT A DEFAULT, and the reason is the tower's: the asm UNDERDETERMINES this. A source
// that really did write the temps and one store compiles to the same bytes, because the merge is
// the compiler's own. Both spellings are emitted and the differ referees.
//
// SOUND BY ITS DUAL'S ARGUMENT, READ BACKWARDS. The join runs on every path out of the `if`,
// immediately after that arm's own tail, with nothing between; a copy at the end of each arm runs
// it exactly once per path, in the same order relative to everything else. What tailmerge needs
// (the two statements are identical) this does not — the copies legitimately differ, because each
// arm substitutes its own definitions.
//
// REFUSES (leaving the merged spelling, which is what the structurer produced) when:
//   - the `if` has an empty arm, or the statement after it is not an `assign`/`store`/`exprstmt`
//     (tailmerge's scope, for its reason: control flow duplicated into an arm changes what the arm
//     still reaches);
//   - the join statement reads no local the arms define — there is no merge to undo;
//   - a local it reads is neither a merge temp (assigned EXACTLY ONCE IN EACH ARM, read only by
//     the join statement, never address-taken — the counts are function-wide, so a second reader
//     anywhere refuses) nor untouched by both arms (a name the arms DO write and this cannot
//     substitute would read a different value at the arm's end);
//   - anything but an EFFECT-FREE assignment stands between the first definition and the arm's
//     end: the substituted values are evaluated where the copy lands, so an intervening store or
//     call could answer a load inside one of them differently. Both halves of that are tested,
//     and the second is why the statement KIND is not enough — `q = Foo();` is an `assign` whose
//     value is a call, and a load moved past it is a load answered after the call instead of
//     before it;
//   - an intervening assignment writes a name one of those values reads — same reason, one level
//     more precise;
//   - a definition's value reads another of the merge names (the substitutions would need an order
//     between them that the join statement does not fix);
//   - a definition's value carries an EFFECT — a call or a gap marker. One statement's operands
//     have no evaluation order in C, so folding two effectful expressions into it would let the
//     backend choose an order the asm did not.
import {
  type Expr,
  type SFn,
  type Stmt,
  exprHasEffect,
  mapExprChildren,
  mapStmtExprs,
  stmtChildren,
  walkExprs,
} from './ast';
import { localMentions, readsOf } from './mentions';

/** every statement under `body`, itself included */
function* walkStmts(body: Stmt[]): Generator<Stmt> {
  for (const s of body) {
    yield s;
    yield* walkStmts(stmtChildren(s));
  }
}

/** The statements this pass moves — see the scope refusal above. */
type Joinable = Extract<Stmt, { k: 'assign' } | { k: 'store' } | { k: 'exprstmt' }>;
const isJoinable = (s: Stmt): s is Joinable => s.k === 'assign' || s.k === 'store' || s.k === 'exprstmt';

/** The locals `s` READS. An `assign`'s target is a write and `stmtExprs` does not carry it, which
 *  is what makes this the set of names substitution has to supply. */
function namesRead(s: Stmt, locals: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const e of walkExprs([s])) {
    if (e.k === 'var' && locals.has(e.name)) {
      out.add(e.name);
    }
  }
  return out;
}

/** Every local `e` reads. */
function readsIn(e: Expr): Set<string> {
  const out = new Set<string>();
  for (const x of walkExprs([{ k: 'exprstmt', value: e }])) {
    if (x.k === 'var') {
      out.add(x.name);
    }
  }
  return out;
}

/** The arm's definitions of `names` and the statements that survive beside them, or null when the
 *  substituted copy would not evaluate to the same values at the arm's end. */
function armDefs(arm: Stmt[], names: ReadonlySet<string>): { defs: Map<string, Expr>; keep: Stmt[] } | null {
  const at = new Map<string, number>();
  arm.forEach((s, i) => {
    if (s.k === 'assign' && names.has(s.name)) {
      at.set(s.name, i);
    }
  });
  if (at.size !== names.size) {
    return null;
  }
  const first = Math.min(...at.values());
  // From the first definition on, nothing but EFFECT-FREE assignments: a store or a call there
  // would run BEFORE a value this moves to the arm's end, and could answer a load inside it
  // differently. The KIND test alone does not say that — an `assign` whose value is a call is an
  // intervening call — so the effect test is applied to the kept statements too, not only to the
  // definition values below.
  if (arm.slice(first).some((s) => s.k !== 'assign' || exprHasEffect(s.value))) {
    return null;
  }
  const defs = new Map([...at].map(([n, i]) => [n, (arm[i] as Extract<Stmt, { k: 'assign' }>).value] as const));
  const read = new Set([...defs.values()].flatMap((v) => [...readsIn(v)]));
  const keep: Stmt[] = [];
  for (const [i, s] of arm.entries()) {
    if (i >= first && s.k === 'assign' && names.has(s.name)) {
      continue; // the definition itself, consumed by the substitution
    }
    if (i > first && s.k === 'assign' && read.has(s.name)) {
      return null; // it would change a value this moves past it
    }
    keep.push(s);
  }
  return { defs, keep };
}

/** `s` with every mention of a defined name replaced by that name's value. */
function substitute(s: Stmt, defs: ReadonlyMap<string, Expr>): Stmt {
  const rec = (e: Expr): Expr => (e.k === 'var' ? (defs.get(e.name) ?? e) : mapExprChildren(e, rec));
  return mapStmtExprs(s, rec);
}

/** The tree with every eligible join statement pushed back into its arms, or null when no site
 *  qualified — the lever declines rather than re-emitting the primary spelling. */
export function unmergeJoins(sfn: SFn): SFn | null {
  const mentions = localMentions(sfn);
  const localNames = new Set(sfn.locals.map((l) => l.name));
  const consumed = new Set<string>();

  const unmergeAt = (iff: Extract<Stmt, { k: 'if' }>, join: Joinable): Stmt | null => {
    if (iff.then.length === 0 || iff.else.length === 0) {
      return null;
    }
    const read = namesRead(join, localNames);
    const written = new Set(
      [...iff.then, ...iff.else].flatMap((s) => [...walkStmts([s])].filter((x) => x.k === 'assign').map((x) => x.name)),
    );
    const merge = new Set<string>();
    for (const n of read) {
      const m = mentions.get(n);
      if (m && m.assigns === 2 && readsOf(m) === 1 && m.addrTaken === 0) {
        merge.add(n);
      } else if (written.has(n)) {
        return null; // the arms write it and this cannot substitute it
      }
    }
    if (merge.size === 0) {
      return null;
    }
    const then = armDefs(iff.then, merge);
    const els = armDefs(iff.else, merge);
    if (then === null || els === null) {
      return null;
    }
    for (const v of [...then.defs.values(), ...els.defs.values()]) {
      if (exprHasEffect(v) || [...readsIn(v)].some((n) => merge.has(n))) {
        return null;
      }
    }
    merge.forEach((n) => consumed.add(n));
    return {
      ...iff,
      then: [...then.keep, substitute(join, then.defs)],
      else: [...els.keep, substitute(join, els.defs)],
    };
  };

  const list = (xs: Stmt[]): Stmt[] => {
    const out: Stmt[] = [];
    for (let i = 0; i < xs.length; i++) {
      const s = rewrite(xs[i]);
      const join = xs[i + 1];
      const done = s.k === 'if' && join !== undefined && isJoinable(join) ? unmergeAt(s, join) : null;
      out.push(done ?? s);
      if (done) {
        i++; // the join statement now lives in both arms
      }
    }
    return out;
  };

  const rewrite = (s: Stmt): Stmt => {
    switch (s.k) {
      case 'if':
        return { ...s, then: list(s.then), else: list(s.else) };
      case 'while':
      case 'dowhile':
      case 'for':
        return { ...s, body: list(s.body) };
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ ...c, body: list(c.body) })),
          ...(s.default ? { default: list(s.default) } : {}),
        };
      default:
        return s;
    }
  };

  const body = list(sfn.body);
  return consumed.size === 0 ? null : { ...sfn, body, locals: sfn.locals.filter((l) => !consumed.has(l.name)) };
}
