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
// A LEVER, NOT A DEFAULT, and the reason is the tower's: the LIFTED TREE underdetermines the
// source. This is a compiler claim, so it was compiled — agbcc `gcc 2.9-arm-000512` at
// `TOOLCHAIN.agbccFlags`, both spellings, `diff` on the `.s`:
//
//   - the example above (an ADDRESS temp and a VALUE temp, against `*gA1 = gB1;` in one arm and
//     `*gA2 = gB2;` in the other, `v17` typed as the store's own type) is BYTE-IDENTICAL. There
//     the merge really is the compiler's own, and the lever costs one candidate to say so.
//   - `synthetic:armcb2`'s shape is NOT. Only the VALUE merges there — the store's address,
//     `gSlot[1]`, is common to both arms — and the per-arm spelling keeps TWO literal-pool
//     islands and a `b` to the join where the merged one has a single island and no `b`.
//
// So the mapping from this tree back to a source is not a function, and it is not uniformly
// many-to-one either: which way it goes is a property of the SHAPE, which no gate here can read
// off the tree. That is exactly the tower's test for an axis rather than a default. Both
// spellings are emitted and the differ referees.
//
// Re-compile before restating either half: the VALUE TEMP'S TYPE alone changes the answer. Give
// `v17` a type wider than the store and the byte-identical case above grows an `ldr`/`ldrh`
// divergence that has nothing to do with the merge.
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
// THESE REFUSALS ARE AN `l3/gates.ts` TABLE — five of them, at four contexts, because a `Gate<Ctx>`
// is per-context and this pass judges four: the SITE (an `if` and the statement after it), one
// ARM's trailing run, one moved VALUE, and an arm as a RUNG. The fifth judges the REWRITTEN site,
// which exists only once the other four have admitted. What licensed the conversion is the
// instrument episode recorded at `pushJoin`'s tail refusal below (56 firings, split 40/16), which
// is the trigger `docs/level-tower.md` states — `grep -n "THE UNIT OF THAT DECISION" docs/level-tower.md`.
// The 40/16 split is now two gates, so that census is a `tallying()` call rather than a patch.
//
// THE RESIDUE, NAMED. `list`'s `s.k === 'if' && isJoinable(join)` is the ENUMERATOR — which pairs
// are judged at all — and enumeration is not residue. Nor are the `null`s `unmergeAt` and
// `pushJoin` propagate out of a nested call: that refusal was already delivered, and counting it
// twice would make the census read as if a second rule fired.
//
// THE ARMS ARE THE PATHS, WHICH IS WHY THE LADDER IS THE SAME REWRITE. agbcc cross-jumps the shared
// tail of an else-if CHAIN exactly as it cross-jumps a two-armed `if`'s, and the lifted tree then
// hands this pass an outer `if` whose `else` is another `if`. Every path out of that ladder leaves
// through exactly one TERMINAL arm, so a copy at the end of each runs exactly once per path — the
// two-arm argument above, read inductively. `pushJoin`'s own note carries which shapes that admits
// (any nested `if` tree, not only a chain) and why it needs no cap.
//
// TOTALITY, NOT AN ARM COUNT, is what pins "and nowhere else" — a ladder assigns its merge name
// once per arm, so no number belongs in the gate. Two checks say it without one: every assignment
// in the function is one of the terminal arms this rewrite consumed, AND no merge name is still
// mentioned in the result. The second is not redundant — `localMentions` is read once, before any
// rewriting, and this pass duplicates statements, so an earlier site can leave the map short by
// exactly the number the ladder consumes and make the first check agree by coincidence. Only
// re-reading the result catches that, and `test/unmerge.test.ts` builds the tree where it must.
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
import { type Gate, firstRejection } from './gates';
import { localMentions, mentionsAnyLocal, readsOf } from './mentions';

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

// ── THE REFUSALS, AS DATA ────────────────────────────────────────────────────────────────────

/** What the SITE table judges: one `if` and the statement that follows it.
 *
 *  THE FIELDS ARE LAZY. Classifying the join's reads walks both arms and reads the function-wide
 *  mention counts, and a site with an empty arm is refused before either is asked. */
export interface UnmergeSite {
  readonly iff: Extract<Stmt, { k: 'if' }>;
  /** the merge temps a rewrite here would substitute */
  readonly merge: ReadonlySet<string>;
  /** names the arms write that this cannot substitute — a copy would read a different value */
  readonly unsubstitutable: ReadonlySet<string>;
}

export const UNMERGE_SITE_GATES: readonly Gate<UnmergeSite>[] = [
  {
    id: 'empty-arm',
    why: 'that path would get no copy of the join at all',
    // Not sound only because it is not the LAST word: an empty arm defines nothing, so the rung
    // table below refuses it a second time. This one is the scope statement, stated where a reader
    // looks for it.
    sound: false,
    // THE GUARD IS THE CENSUS, not the decline. Deleted from this table, the whole core suite
    // stays green — the rung table refuses an empty arm a second time — so the only test that can
    // tell this gate apart from its shadow is the one that reads the ID back.
    guardedBy: 'unmerge.test.ts: a census names the rule that refused each site, and counts it',
    rejects: (c) => c.iff.then.length === 0 || c.iff.else.length === 0,
  },
  {
    id: 'arm-writes-a-name-this-cannot-substitute',
    why: 'the copy would read that name at the arm`s end, where it holds a different value',
    sound: true,
    // THE GUARD IS NOT THE TEST THAT NAMES THIS REFUSAL. Ablated alone, `a join reading a local
    // the arms WRITE but this cannot substitute refuses` stays GREEN — that fixture is refused a
    // second time further down — while three others go red. The one named here is the informative
    // one: it is the shape `moved-value-reads-another-merge-name` claims to catch, and this gate
    // is what actually catches it (see that gate).
    guardedBy: 'unmerge.test.ts: a definition whose value reads ANOTHER merge temp refuses',
    rejects: (c) => c.unsubstitutable.size > 0,
  },
  {
    id: 'no-merge-name',
    why: 'the join reads nothing the arms define — there is no merge to undo',
    sound: false,
    // Same shadowing as `empty-arm` above, and the same guard: ablated alone, the named decline
    // test stays green (a join reading no merge name defines nothing to move, so the arm table
    // refuses it next), and only the census distinguishes which rule spoke.
    guardedBy: 'unmerge.test.ts: a census names the rule that refused each site, and counts it',
    rejects: (c) => c.merge.size === 0,
  },
];

/** What the ARM table judges: whether one arm is TERMINAL — a trailing run of assignments defining
 *  every merge name, with nothing beside them that could answer a moved read differently.
 *
 *  THE FIELDS ARE LAZY for the same reason: `first` is `Math.min` over an empty map when the arm
 *  does not define them all, and `clobbersAMovedRead` reads every definition's value. */
export interface UnmergeArm {
  /** where in the arm each merge name is defined */
  readonly at: ReadonlyMap<string, number>;
  readonly names: ReadonlySet<string>;
  /** the tree's own locals and params — the objects a kept assignment may write */
  readonly declared: ReadonlySet<string>;
  /** the arm from its FIRST definition on: the run the copy is appended to */
  readonly trailing: readonly Stmt[];
  /** does a kept assignment after that point write a name one of the moved values reads? */
  readonly clobbersAMovedRead: boolean;
}

export const UNMERGE_ARM_GATES: readonly Gate<UnmergeArm>[] = [
  {
    id: 'arm-does-not-define-them-all',
    why: 'a name with no definition here has nothing to substitute',
    sound: true,
    // Ablated, `a merge temp assigned in only ONE arm (or three times) refuses` stays green —
    // totality catches that one — and the LADDERS break instead, which is the real cost: this is
    // the gate that says an arm is not terminal, so without it a rung is rewritten as though it
    // were a leaf.
    guardedBy: 'unmerge.test.ts: a THREE-arm ladder puts the join in all three',
    rejects: (c) => c.at.size !== c.names.size,
  },
  // The three halves of "nothing but an EFFECT-FREE assignment TO A DECLARED LOCAL stands between
  // the first definition and the arm's end", one gate each — the header says all three are tested,
  // and separating them is what lets a census say WHICH one a corpus actually hits. A disjunction
  // of existentials is the existential of the disjunction, so the split is exact.
  {
    id: 'trailing-run-holds-a-non-assignment',
    why: 'a store or a call there runs before a value this moves to the arm`s end',
    sound: true,
    guardedBy: 'unmerge.test.ts: a definition that is NOT in the arm',
    rejects: (c) => c.trailing.some((s) => s.k !== 'assign'),
  },
  {
    id: 'trailing-run-writes-an-undeclared-name',
    why: 'structure.ts spells a write to a scalar GLOBAL as an `assign`, and that writes memory',
    sound: true,
    guardedBy: 'unmerge.test.ts: an intervening assignment to a GLOBAL refuses',
    rejects: (c) => c.trailing.some((s) => s.k === 'assign' && !c.declared.has(s.name)),
  },
  {
    id: 'trailing-run-holds-an-effectful-value',
    why: 'a call on the right-hand side answers a moved load after itself instead of before',
    sound: true,
    guardedBy: 'unmerge.test.ts: an intervening assignment whose VALUE is a CALL refuses',
    rejects: (c) => c.trailing.some((s) => s.k === 'assign' && exprHasEffect(s.value)),
  },
  {
    id: 'intervening-write-to-a-moved-read',
    why: 'it would change a value this moves past it',
    sound: true,
    guardedBy: 'unmerge.test.ts: an intervening assignment that CLOBBERS what a definition reads refuses',
    rejects: (c) => c.clobbersAMovedRead,
  },
];

/** What the VALUE table judges: ONE definition's value, asked whether the substitution may
 *  relocate it to the arm's end. Per value, not per arm — a table entry names the reason. */
export interface UnmergeMovedValue {
  readonly value: Expr;
  readonly names: ReadonlySet<string>;
  readonly sfn: SFn;
}

export const UNMERGE_VALUE_GATES: readonly Gate<UnmergeMovedValue>[] = [
  {
    id: 'moved-value-has-an-effect',
    why: 'C fixes no order between one statement`s operands, so the backend would choose one',
    // SHADOWED, not sound — and PROVABLY, not just unwitnessed. Every definition sits at a
    // position in `at`, all of which are `>= first`, so every definition is in the arm ctx's
    // `trailing`; an effectful one is therefore already refused by
    // `trailing-run-holds-an-effectful-value` one context up. Ablated on its own, 0 of the 45 tests
    // in unmerge.test.ts and unmerge-fuzz.test.ts redden — `a definition carrying an EFFECT
    // refuses` included. It stays because the scope it states is the pass's, and deleting a rule
    // that is correct-but-shadowed is how the shadowing rule silently becomes load-bearing.
    sound: false,
    rejects: (c) => exprHasEffect(c.value),
  },
  {
    id: 'moved-value-reads-volatile',
    why: 'the source pinned that access so it would not be moved, and its order is observable',
    sound: true,
    guardedBy: 'unmerge.test.ts: a definition reading a DEVICE REGISTER refuses',
    rejects: (c) => exprReadsVolatile(c.value, c.sfn),
  },
  {
    id: 'moved-value-reads-another-merge-name',
    why: 'the substitutions would need an order between them that the join statement does not fix',
    // SHADOWED BY THE SITE TABLE, provably. A merge name is one the join reads and that
    // `readsOf(m) === 1` says is read NOWHERE ELSE; a definition value reading it is a second
    // read, so it was never in `merge` — it landed in `unsubstitutable` and
    // `arm-writes-a-name-this-cannot-substitute` refused the whole site. Ablated on its own, 0 of
    // the 45 tests redden, its own namesake fixture included, which is why that fixture is the
    // guard named on the site gate instead. Kept for the same reason as the gate above.
    sound: false,
    rejects: (c) => [...readsIn(c.value)].some((n) => c.names.has(n)),
  },
];

/** What the RUNG table judges: an arm that is not terminal, asked whether the copy belongs one
 *  level down instead. Two gates rather than one because the instrument episode the header cites
 *  measured them SEPARATELY — 40 firings on a non-`if` tail, 16 on an empty arm — and a table that
 *  fused them could not reproduce that split. */
export interface UnmergeRung {
  readonly arm: readonly Stmt[];
}

export const UNMERGE_RUNG_GATES: readonly Gate<UnmergeRung>[] = [
  {
    id: 'empty-arm-has-no-tail',
    why: 'there is no statement here to recurse into, and nothing defined the names either',
    sound: false,
    // Shadowed by `tail-is-not-an-if` below (`arm[len - 1]` of an empty arm is `undefined`, whose
    // `?.k` is not `'if'`), so the census test is the guard — it is also what the SPLIT this table
    // exists to reproduce is asserted by.
    guardedBy: 'unmerge.test.ts: the RUNG census reproduces the split the instrumented run measured, without the patch',
    rejects: (c) => c.arm.length === 0,
  },
  {
    id: 'tail-is-not-an-if',
    why: 'the ladder bottoms out only on an `if`; anything else is neither terminal nor a rung',
    sound: false,
    // Shadowed by the type narrowing in `pushJoin` — which has to stand there whatever this table
    // says, because both gates here are ablatable. The census test is the guard that survives that.
    guardedBy: 'unmerge.test.ts: the RUNG census reproduces the split the instrumented run measured, without the patch',
    rejects: (c) => c.arm[c.arm.length - 1]?.k !== 'if',
  },
];

/** What the TOTALITY table judges: the REWRITTEN site. It exists only once every other table has
 *  admitted, which is why it is a table of its own rather than three more site gates.
 *
 *  `out` IS LAZY: the first gate reads only counts, and building the rewritten `if` for a site
 *  that fails it would be a spread nothing reads. */
export interface UnmergeTotality {
  readonly merge: ReadonlySet<string>;
  readonly mentions: ReturnType<typeof localMentions>;
  /** how many copies of the join the rewrite took — one per terminal arm */
  readonly used: number;
  readonly out: Stmt;
}

export const UNMERGE_TOTALITY_GATES: readonly Gate<UnmergeTotality>[] = [
  {
    id: 'a-definition-the-rewrite-did-not-consume',
    why: 'it survives with nothing left to read it, and its local is about to be deleted',
    sound: true,
    guardedBy: 'unmerge.test.ts: a definition OUTSIDE the terminal arms refuses',
    rejects: (c) => [...c.merge].some((n) => c.mentions.get(n)?.assigns !== c.used),
  },
  {
    id: 'merge-name-survives-the-rewrite',
    why: 'the counts are STALE, so totality is asked of the result as well as of the map',
    sound: true,
    guardedBy: 'unmerge.test.ts: a definition an earlier rewrite duplicated leaves the count agreeing',
    rejects: (c) => mentionsAnyLocal([c.out], c.merge),
  },
];

/** The tables `unmergeJoins` consults, each overridable — which is how a caller outside core takes
 *  a per-id refusal census (`tallying`) or an ablation (`without`) off this pass without editing
 *  it. Test and diagnostic seam; the shipped path passes nothing. */
export interface UnmergeGates {
  readonly site?: readonly Gate<UnmergeSite>[];
  readonly arm?: readonly Gate<UnmergeArm>[];
  readonly value?: readonly Gate<UnmergeMovedValue>[];
  readonly rung?: readonly Gate<UnmergeRung>[];
  readonly totality?: readonly Gate<UnmergeTotality>[];
}

/** The arm's definitions of `names` and the statements that survive beside them, or null when the
 *  substituted copy would not evaluate to the same values at the arm's end — `UNMERGE_ARM_GATES`
 *  carries every reason. */
function armDefs(
  arm: Stmt[],
  names: ReadonlySet<string>,
  declared: ReadonlySet<string>,
  gates: readonly Gate<UnmergeArm>[],
): { defs: Map<string, Expr>; keep: Stmt[] } | null {
  const at = new Map<string, number>();
  arm.forEach((s, i) => {
    if (s.k === 'assign' && names.has(s.name)) {
      at.set(s.name, i);
    }
  });
  const valueAt = (i: number): Expr => (arm[i] as Extract<Stmt, { k: 'assign' }>).value;
  let first: number | undefined;
  const firstDef = (): number => (first ??= Math.min(...at.values()));
  let clobbers: boolean | undefined;
  const ctx: UnmergeArm = {
    at,
    names,
    declared,
    get trailing() {
      return arm.slice(firstDef());
    },
    get clobbersAMovedRead() {
      if (clobbers === undefined) {
        // `declared` is the tree's own locals and params, so a kept assignment's target is an
        // object no moved read can reach except by the name this keys on.
        const read = new Set([...at.values()].flatMap((i) => [...readsIn(valueAt(i))]));
        clobbers = arm.some((s, i) => i > firstDef() && s.k === 'assign' && !names.has(s.name) && read.has(s.name));
      }
      return clobbers;
    },
  };
  if (firstRejection(gates, ctx) !== null) {
    return null;
  }
  const defs = new Map([...at].map(([n, i]) => [n, valueAt(i)] as const));
  // Everything but the definitions themselves, which the substitution consumed.
  const keep = arm.filter((s, i) => !(i >= firstDef() && s.k === 'assign' && names.has(s.name)));
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
  gates: UnmergeGates,
): { arm: Stmt[]; used: number } | null {
  const here = armDefs(arm, names, declared, gates.arm ?? UNMERGE_ARM_GATES);
  if (here !== null) {
    for (const v of here.defs.values()) {
      if (firstRejection(gates.value ?? UNMERGE_VALUE_GATES, { value: v, names, sfn }) !== null) {
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
  // success count as evidence about it. Instrumented at this return and re-run over the synthetic
  // agbcc tier (281 rows, exit 0): 56 firings in 2 functions — 40 on an `assign` tail (32 in
  // `maskchain`, 8 in `dmascope2`) and 16 on an EMPTY arm (`maskchain`). `dmascope2` is not one of
  // the four rows that reach the ladder SUCCESSFULLY, so it appears in no success count at all.
  // Only `while` and `switch` tails are unwitnessed; a plain statement is not. That episode is the
  // instrument evidence this pass's tables were converted on, and the two counts it produced are
  // now the two `UNMERGE_RUNG_GATES` ids.
  //
  // An EMPTY arm is delivered its refusal HERE, not by `armDefs`: `armDefs` declines it first
  // (`names` is never empty, so no run of statements in an empty arm can supply it) and the tail
  // check is what turns that decline into the site's. Same for an arm whose statements simply do
  // not define the names.
  if (firstRejection(gates.rung ?? UNMERGE_RUNG_GATES, { arm }) !== null) {
    return null;
  }
  // The gate above owns the ATTRIBUTION; this owns the TYPE. They are not the same job: both rung
  // gates are `sound: false`, so `ablateHeuristic` sanctions a shipped table without
  // `tail-is-not-an-if`, and a cast here would then read `.then` off an `assign` — a TypeError
  // inside `rank.ts`'s `try { pf.apply(sfn) } catch {}`, i.e. a silent zero-candidate decline.
  const last = arm[arm.length - 1];
  if (last === undefined || last.k !== 'if') {
    return null;
  }
  const t = pushJoin(last.then, names, declared, join, sfn, gates);
  const e = pushJoin(last.else, names, declared, join, sfn, gates);
  if (t === null || e === null) {
    return null;
  }
  return { arm: [...arm.slice(0, -1), { ...last, then: t.arm, else: e.arm }], used: t.used + e.used };
}

/** The tree with every eligible join statement pushed back into its arms, or null when no site
 *  qualified — the lever declines rather than re-emitting the primary spelling. */
export function unmergeJoins(sfn: SFn, gates: UnmergeGates = {}): SFn | null {
  const mentions = localMentions(sfn);
  const localNames = new Set(sfn.locals.map((l) => l.name));
  // Locals AND params — both name an automatic object, and an assignment to either is the write
  // `armDefs` may keep. Separate from `localNames` above, which answers a different question
  // (which of the join's reads a substitution could supply) and is deliberately locals-only.
  const declaredNames = new Set([...localNames, ...sfn.params.map((p) => p.name)]);
  const consumed = new Set<string>();

  /** The join's reads, split into the merge temps a rewrite would substitute and the names the
   *  arms write that it could not. ONE walk, because both gates read the same classification and
   *  the site's first gate may refuse before either is asked. */
  const classify = (iff: Extract<Stmt, { k: 'if' }>, join: Joinable) => {
    const read = namesRead(join, localNames);
    const written = new Set(
      [...iff.then, ...iff.else].flatMap((s) => [...walkStmts([s])].filter((x) => x.k === 'assign').map((x) => x.name)),
    );
    const merge = new Set<string>();
    const unsubstitutable = new Set<string>();
    for (const n of read) {
      const m = mentions.get(n);
      // `written.has(n)` is a CANDIDATE condition, not only the bystander test, and it ADMITS
      // sites an arity gate alone declines. A candidate the arms cannot define refuses the WHOLE
      // SITE instead of being ignored, and `m.assigns` is `localMentions`'s FUNCTION-WIDE count,
      // never arm-scoped — so without this conjunct a name assigned only OUTSIDE the arms reaches
      // the candidate set and sinks the site. Measured, against the same pass with the conjunct
      // removed:
      //
      //   n = 1; n = 2;  if (c) x = 1; else x = 2;  n[0] = x;   without: NULL · here: FIRES
      //   y = 1; y = 2;  if (c) p = a; else p = b;  *p = y;     without: NULL · here: FIRES
      //
      // (`y` is a bystander read carried into both copies, `p` is the merge; nothing `y` reads
      // moves, because the copy is always LAST in its arm.) Both admissions are pinned as RULE
      // tests in unmerge.test.ts.
      if (m && written.has(n) && m.assigns >= 2 && readsOf(m) === 1 && m.addrTaken === 0) {
        merge.add(n);
      } else if (written.has(n)) {
        unsubstitutable.add(n);
      }
    }
    return { merge, unsubstitutable };
  };

  const unmergeAt = (iff: Extract<Stmt, { k: 'if' }>, join: Joinable): Stmt | null => {
    let split: { merge: Set<string>; unsubstitutable: Set<string> } | undefined;
    const of = () => (split ??= classify(iff, join));
    const site: UnmergeSite = {
      iff,
      get merge() {
        return of().merge;
      },
      get unsubstitutable() {
        return of().unsubstitutable;
      },
    };
    if (firstRejection(gates.site ?? UNMERGE_SITE_GATES, site) !== null) {
      return null;
    }
    const merge = of().merge;
    const then = pushJoin(iff.then, merge, declaredNames, join, sfn, gates);
    const els = pushJoin(iff.else, merge, declaredNames, join, sfn, gates);
    if (then === null || els === null) {
      return null;
    }
    // TOTALITY: every assignment to a merge name ANYWHERE in the function has to be one of the
    // terminal arms just rewritten, AND the counts are STALE — an earlier site inside this same
    // tree can turn one assignment into two, leaving `mentions` short by exactly the number of
    // arms the ladder then consumes, so the two counts agree by coincidence. Only re-reading the
    // RESULT catches that, which is why the second gate exists and why `out` is what it reads.
    //
    // What this does NOT cover, stated rather than implied: a mention OUTSIDE `out`, which
    // `readsOf(m) === 1` answers from the same stale map. A sibling site duplicating a read is the
    // shape that would reach it; no inhabitant is known. That is the pass's standing model, not
    // this table's job.
    let out: Stmt | undefined;
    const totality: UnmergeTotality = {
      merge,
      mentions,
      used: then.used + els.used,
      get out() {
        return (out ??= { ...iff, then: then.arm, else: els.arm });
      },
    };
    if (firstRejection(gates.totality ?? UNMERGE_TOTALITY_GATES, totality) !== null) {
      return null;
    }
    merge.forEach((n) => consumed.add(n));
    return totality.out;
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
