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
//   - a local it reads is neither a merge temp (assigned EXACTLY ONCE IN EACH TERMINAL ARM and
//     nowhere else, read only by the join statement, never address-taken — the counts are
//     function-wide, so a second reader anywhere refuses) nor untouched by both arms (a name the
//     arms DO write and this cannot substitute would read a different value at the arm's end);
//   - anything but an EFFECT-FREE assignment TO A DECLARED LOCAL stands between the first
//     definition and the arm's end: the substituted values are evaluated where the copy lands, so
//     an intervening store or call could answer a load inside one of them differently. All three
//     halves of that are tested. The second is why the statement KIND is not enough — `q = Foo();`
//     is an `assign` whose value is a call, and a load moved past it is a load answered after the
//     call instead of before it. The third is why the assignment's TARGET is not either: an
//     `assign` names a variable, and structure.ts spells a write to a scalar GLOBAL as one, so
//     `gBlendValue = v;` is an `assign` with an effect-free value that writes MEMORY. Not a
//     corner of the corpus. Measured over a 957-row artifact (#140): 22 winning sources emit a
//     statement-level assignment to a name they declare nowhere — 71 occurrences, 7 of them in
//     `kleod:ProcessInputAndUpdateEntities` alone.
//     RE-DERIVE THIS RATHER THAN QUOTING IT: one pass over the artifact does it — collect each
//     winning source's declared locals and parameters, then count its statement-level `name = `
//     lines whose name is not among them. `exprHasEffect` answers "a call, or a marker" and cannot
//     see one, the same way it could not see a qualifier;
//   - an intervening assignment writes a name one of those values reads — same reason, one level
//     more precise;
//   - a definition's value reads another of the merge names (the substitutions would need an order
//     between them that the join statement does not fix);
//   - a definition's value carries an EFFECT — a call or a gap marker. One statement's operands
//     have no evaluation order in C, so folding two effectful expressions into it would let the
//     backend choose an order the asm did not;
//   - a definition's value performs a VOLATILE access. `exprHasEffect` above answers "a call, or a
//     marker" and says nothing about a qualifier, so it is not the test for this: the refusal is
//     asked of the qualifier's own model (`exprReadsVolatile`), which knows all three spellings —
//     the cast, the pointee-volatile pointer local, and the volatile local object;
//   - an arm is neither TERMINAL (a run of assignments defining the names) nor a RUNG (its last
//     statement is an `if`, whose arms are asked the same question one level down — any nested
//     `if` TREE qualifies, not only a right-nested else-if chain);
//   - the terminal arms are not ALL of the name's definitions, or a merge name is still mentioned
//     in the rewritten statement — the two halves of totality, below.
//
// THE ARMS ARE THE PATHS, WHICH IS WHY THE LADDER IS THE SAME REWRITE. agbcc cross-jumps the shared
// tail of an else-if CHAIN exactly as it cross-jumps a two-armed `if`'s, and the lifted tree then
// hands this pass an outer `if` whose `else` is another `if`. Every path out of that ladder leaves
// through exactly one TERMINAL arm, so a copy at the end of each terminal arm runs exactly once per
// path — the two-arm argument above, read inductively. Statements before a rung's trailing `if` are
// untouched and no moved value crosses them: they run before the rung is entered. The chain is what
// the corpus holds, and the argument never used it: ANY nested `if` tree bottoming out in terminal
// arms satisfies "every path leaves through exactly one", and any such tree fires. `pushJoin`'s own
// note carries that and the reason it needs no cap.
//
// TOTALITY IS WHAT REPLACES THE ARITY. "Assigned exactly once in each arm" was a count of TWO, and
// a five-arm ladder assigns five times; the gate is now "assigned at least twice", carried by two
// checks that together say the same thing without naming a number: every assignment in the function
// is one of the terminal arms this rewrite consumed, AND no merge name is still mentioned in the
// result. The second is not redundant — `localMentions` is read once, before any rewriting, and
// this pass duplicates statements, so an earlier site can leave the map short by exactly the number
// the ladder consumes and make the first check agree by coincidence. Only re-reading the result
// catches that, and `test/unmerge.test.ts` builds the tree where it must.
//
// AND THE SCOPE OF THE VOLATILE ONE IS WHAT MOVES, which is exactly one thing. A kept statement
// holds its position, and the join runs where it already ran (immediately after that arm), so the
// only access whose point in the sequence changes is a DEFINITION's value — moved down to the
// arm's end, past every kept statement. A plain read may make that trip, because the kept
// statements from the first definition on are effect-free assignments to DECLARED LOCALS and so
// none of them writes memory that could answer it differently — which is what the three gates
// above establish, the local-target one included. An observable read may not make the trip: a
// volatile access is one the source pinned so it would not be duplicated or moved, and its ORDER
// against the other device accesses beside it is observable — which is why THAT gate is stated on
// the moved value and needs no clause for the statements that stay put.
//
// WHAT THE LOCAL-TARGET GATE DOES NOT CLOSE, stated rather than implied: ALIASING. A moved value
// reading `*p` and a kept assignment to an address-taken local can name the same object under two
// spellings, and the name-keyed refusal below (an intervening assignment writes a name one of
// those values READS) cannot see it. That is one question further out than this pass models —
// every other lever here defers it to the same name-keyed model — and the sweep behind this note
// found no inhabitant: 0 arms this pass ACCEPTS hold a kept assignment to an address-taken local
// after the first definition, the same sweep that found 0 holding one to a global. That sweep's
// population was the agbcc rows whose BASE TREE the rig could build, which is not the corpus's
// agbcc row count, so re-run it before quoting a count off it.
import {
  type Expr,
  type SFn,
  type Stmt,
  exprHasEffect,
  exprReadsVolatile,
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
function armDefs(
  arm: Stmt[],
  names: ReadonlySet<string>,
  declared: ReadonlySet<string>,
): { defs: Map<string, Expr>; keep: Stmt[] } | null {
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
  // From the first definition on, nothing but EFFECT-FREE assignments TO A DECLARED LOCAL: a store
  // or a call there would run BEFORE a value this moves to the arm's end, and could answer a load
  // inside it differently. Neither the KIND nor the VALUE alone says that. Not the kind — an
  // `assign` whose value is a call is an intervening call — so the effect test is applied to the
  // kept statements too, not only to the definition values below. And not the value either: an
  // `assign` names a VARIABLE, and structure.ts spells a write to a scalar global as one, so
  // `gBlendValue = v;` passes both tests and writes memory. `declared` is the tree's own locals
  // and params, so the target has to be an object no moved read can reach except by the name the
  // refusal below already keys on.
  if (arm.slice(first).some((s) => s.k !== 'assign' || !declared.has(s.name) || exprHasEffect(s.value))) {
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

/** One arm with `join` pushed into it, and how many COPIES of the join that took — the count the
 *  caller needs to prove every definition of every merge name was consumed. One arm, one copy.
 *
 *  The value guard lives here rather than at the call site because the values it judges are the
 *  ones THIS arm moves: an effectful or volatile value, or one reading another merge name, is a
 *  value the substitution may not relocate to the arm's end. Same set of values as before, asked
 *  one arm earlier. */
function pushJoin(
  arm: Stmt[],
  names: ReadonlySet<string>,
  declared: ReadonlySet<string>,
  join: Joinable,
  sfn: SFn,
): { arm: Stmt[]; used: number } | null {
  const here = armDefs(arm, names, declared);
  if (here !== null) {
    for (const v of here.defs.values()) {
      if (exprHasEffect(v) || exprReadsVolatile(v, sfn) || [...readsIn(v)].some((n) => names.has(n))) {
        return null;
      }
    }
    return { arm: [...here.keep, substitute(join, here.defs)], used: 1 };
  }
  // NOT a terminal arm. It is a RUNG when its LAST statement is an `if` — then the copy belongs
  // one level down, in that `if`'s own arms, and the statements before it are untouched: they run
  // before the rung is entered, so no value this moves crosses them.
  //
  // THE SHAPE ADMITTED IS ANY NESTED `if` TREE, not only a right-nested else-if chain. Nothing
  // here restricts the recursion to one side, and nothing should: the soundness argument is "every
  // path out leaves through exactly one terminal arm", which a BALANCED tree satisfies as fully as
  // a chain — `if (c) { if (d) A else B } else { if (e) C else D }` fires and takes four copies.
  // Call it a ladder because that is what the corpus holds, not because the code tests for one.
  //
  // NO CAP, and none is wanted: the copy count is exactly the number of TERMINAL ARMS, so the work
  // and the emitted source are LINEAR in the subtree the recursion walks — a depth-6 balanced tree
  // is 64 leaves and 64 copies, the same one-copy-per-path the two-arm case makes. The corpus
  // maximum is 5 (`synthetic:armcb`). A refusal above some arm count would be a gate with no
  // inhabitant, which this file's own standard rejects.
  //
  // REFUSES when the tail is anything else, and THIS REFUSAL HAS INHABITANTS — do not read the
  // success count as evidence about it. Instrumented at the return below and re-run over the
  // synthetic agbcc tier (281 rows, exit 0): 56 firings in 2 functions — 40 on an `assign` tail
  // (32 in `maskchain`, 8 in `dmascope2`) and 16 on an EMPTY arm (`maskchain`). `dmascope2` is not
  // one of the four rows that reach the ladder SUCCESSFULLY, so it appears in no success count at
  // all. Only `while` and `switch` tails are unwitnessed; a plain statement is not.
  //
  // An EMPTY arm is delivered its refusal HERE, not by `armDefs`: `armDefs` declines it first
  // (`names` is never empty, so no run of statements in an empty arm can supply it) and the tail
  // check is what turns that decline into the site's. Same for an arm whose statements simply do
  // not define the names.
  const last = arm[arm.length - 1];
  if (last === undefined || last.k !== 'if') {
    return null;
  }
  const t = pushJoin(last.then, names, declared, join, sfn);
  const e = pushJoin(last.else, names, declared, join, sfn);
  if (t === null || e === null) {
    return null;
  }
  return { arm: [...arm.slice(0, -1), { ...last, then: t.arm, else: e.arm }], used: t.used + e.used };
}

/** true when `s`, or anything under it, still names one of `names` — as an assignment TARGET (which
 *  carries no expression and so no walk over values can see) or as a read. */
function mentionsAny(s: Stmt, names: ReadonlySet<string>): boolean {
  for (const x of walkStmts([s])) {
    if (x.k === 'assign' && names.has(x.name)) {
      return true;
    }
  }
  for (const e of walkExprs([s])) {
    if ((e.k === 'var' || e.k === 'addr') && names.has(e.name)) {
      return true;
    }
  }
  return false;
}

/** The tree with every eligible join statement pushed back into its arms, or null when no site
 *  qualified — the lever declines rather than re-emitting the primary spelling. */
export function unmergeJoins(sfn: SFn): SFn | null {
  const mentions = localMentions(sfn);
  const localNames = new Set(sfn.locals.map((l) => l.name));
  // Locals AND params — both name an automatic object, and an assignment to either is the write
  // `armDefs` may keep. Separate from `localNames` above, which answers a different question
  // (which of the join's reads a substitution could supply) and is deliberately locals-only.
  const declaredNames = new Set([...localNames, ...sfn.params.map((p) => p.name)]);
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
      // `written.has(n)` is a CANDIDATE condition, not only the bystander test below. Under the
      // old `assigns === 2` a name the arms never write could not reach two assignments inside
      // them and so was a bystander by arithmetic; under `assigns >= 2` it can, and a candidate
      // the arms cannot define refuses the WHOLE SITE (`armDefs` returns null) instead of being
      // ignored. Measured on the shape `n = 1; n = 2; n = 3; if (c) x = 1; else x = 2; n[0] = x;`
      // — `origin/main` un-merges `x`, and the widening alone declined the site outright. The
      // conjunct costs nothing: a name the arms do not write can never satisfy `armDefs`, so this
      // prunes only candidates that were guaranteed to refuse.
      if (m && written.has(n) && m.assigns >= 2 && readsOf(m) === 1 && m.addrTaken === 0) {
        merge.add(n);
      } else if (written.has(n)) {
        return null; // the arms write it and this cannot substitute it
      }
    }
    if (merge.size === 0) {
      return null;
    }
    const then = pushJoin(iff.then, merge, declaredNames, join, sfn);
    const els = pushJoin(iff.else, merge, declaredNames, join, sfn);
    if (then === null || els === null) {
      return null;
    }
    // TOTALITY, which is what `assigns === 2` used to say and can no longer: every assignment to a
    // merge name ANYWHERE in the function has to be one of the terminal arms just rewritten. A
    // definition the rewrite did not consume survives with nothing left to read it, and the local
    // it names is about to be deleted.
    const used = then.used + els.used;
    if ([...merge].some((n) => mentions.get(n)?.assigns !== used)) {
      return null;
    }
    const out: Stmt = { ...iff, then: then.arm, else: els.arm };
    // AND THE COUNTS ARE STALE, so totality is checked against the RESULT as well. `mentions` is
    // read once, before the pass rewrites anything, while this pass DUPLICATES statements — an
    // earlier site inside this same tree can turn one assignment to a name into two, leaving the
    // map short by exactly the number of arms the ladder then consumes. The two counts agree by
    // coincidence and a definition survives. Re-reading the rewritten statement is the check that
    // does not depend on the map: if a merge name is still mentioned in it, the rewrite did not
    // consume that name and the declaration may not go. `test/unmerge.test.ts` builds the tree
    // where totality alone admits it. What this does NOT cover, stated rather than implied: a
    // mention outside `out`, which `readsOf(m) === 1` answers from the same stale map — the
    // arity gate was the reason that could not bite before, and a sibling site duplicating a read
    // is the shape that would. No inhabitant is known; it is the pass's standing model, not this
    // gate's job.
    if (mentionsAny(out, merge)) {
      return null;
    }
    merge.forEach((n) => consumed.add(n));
    return out;
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
