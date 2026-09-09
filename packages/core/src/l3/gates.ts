// A pass's admission rules as DATA, so "does every sound gate have a test that fails without it?"
// is a query instead of an audit.
//
// Because the table is a value, a test can drop one entry and re-run the pass: the real predicate,
// on real input, with no test-only branch in the shipped path. That makes `sound` cost something to
// declare — see `gateTableDefects` and the contract test that pairs with it.
//
// `why` is a LABEL, one line. The argument for why the rule is correct belongs in the file header,
// which has room; duplicating it here is how a table stops paying for itself.
export interface Gate<Ctx> {
  /** stable, kebab-case; appears in test names and in the contract report */
  readonly id: string;
  /** one line: the reason the rule exists */
  readonly why: string;
  /** Remove it and some candidate is WRONG, not merely worse. Everything else is a codegen
   *  heuristic the differ still referees. This flag is what makes `guardedBy` mandatory. */
  readonly sound: boolean;
  /** the test that fails when this gate is removed — required for a sound gate */
  readonly guardedBy?: string;
  /** true ⇒ REJECT this candidate */
  readonly rejects: (c: Ctx) => boolean;
}

/** The id of the first gate that rejects `c`, or null when every gate admits it. FIRST, not all:
 *  one decisive rule is what makes a refusal attributable, and it keeps the cost the same as the
 *  `||` chain this replaces — evaluation still short-circuits. */
export function firstRejection<Ctx>(gates: readonly Gate<Ctx>[], c: Ctx): string | null {
  for (const g of gates) {
    if (g.rejects(c)) {
      return g.id;
    }
  }
  return null;
}

/** A gate table with one entry removed — the ablation, as a value. Throws on an unknown id: a
 *  typo'd ablation that silently tests nothing is the failure this file exists to prevent. */
export function without<Ctx>(gates: readonly Gate<Ctx>[], id: string): readonly Gate<Ctx>[] {
  if (!gates.some((g) => g.id === id)) {
    throw new Error(`no gate '${id}' to ablate (have: ${gates.map((g) => g.id).join(', ')})`);
  }
  return gates.filter((g) => g.id !== id);
}

// NO `just(table, ids)` SELECTOR, deliberately. Selecting rule OBJECTS by id shares the predicate
// AND the `sound` claim AND the `guardedBy` guard, and a second consumer of a rule wants only the
// first of the three: a rule that is sound for a declaration is a heuristic for a generated
// candidate, and the guard the contract test then checks ablates the rule against the OTHER
// consumer. What a second consumer shares is a PREDICATE — an ordinary function — and what it owns
// is its own rule objects. `ORDER_SHAPE_GATES` (raise/globalshape.ts) is the worked example, with
// the over-admission id-selection would carry.

/** `without` for SHIPPED code. A test may ablate any gate — that is how `guardedBy` differential
 *  tests work — but a pass that re-runs itself with an ablated table as a ranked candidate may
 *  only drop a HEURISTIC: ablating a `sound: true` gate would ship semantically wrong candidates,
 *  and on a nonmatch row the best-scoring source is shown to the user. A derived table is a
 *  top-level const, so the throw fires at import — the mistake cannot ship. */
export function ablateHeuristic<Ctx>(gates: readonly Gate<Ctx>[], id: string): readonly Gate<Ctx>[] {
  const g = gates.find((x) => x.id === id);
  if (g?.sound) {
    throw new Error(`gate '${id}' is sound — a shipped ablation of it emits wrong candidates`);
  }
  return without(gates, id);
}

/** Structural defects in a gate table — the part checkable without running the pass. Returns
 *  findings rather than throwing, so core stays free of a test-framework import. */
export function gateTableDefects<Ctx>(gates: readonly Gate<Ctx>[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of gates) {
    if (seen.has(g.id)) {
      out.push(`duplicate gate id '${g.id}'`);
    }
    seen.add(g.id);
    if (!/^[a-z][a-z0-9-]*$/.test(g.id)) {
      out.push(`gate id '${g.id}' is not kebab-case`);
    }
    if (g.why.trim().length < 12) {
      out.push(`gate '${g.id}' has no usable \`why\``);
    }
    // the one rule that costs something to declare
    if (g.sound && !g.guardedBy?.trim()) {
      out.push(`gate '${g.id}' is marked sound but names no guard`);
    }
  }
  return out;
}

/** A gate table that counts its own refusals — {@link tallying}'s return. */
export interface Tallied<Ctx> {
  /** Hand this to the pass, in place of the table it wraps. */
  readonly gates: readonly Gate<Ctx>[];
  /** The census so far, most-refused first, ties in table order. A snapshot: counts keep
   *  accumulating across every later call, which is what a corpus-wide census wants. */
  readonly refusals: () => readonly (readonly [string, number])[];
}

/** The same table, wrapping each `rejects` in a counter — so a caller OUTSIDE core can obtain the
 *  per-id census that `l3/coalesce.ts`, `l3/scopebase.ts` and `structure/namecoalesce.ts` each
 *  hand-rolled into their return type, from any pass that takes its table as a parameter:
 *
 *      const t = tallying(UNMERGE_SITE_GATES);
 *      for (const sfn of corpus) unmergeJoins(sfn, { site: t.gates });
 *      console.log(t.refusals());   // [['no-merge-name', 214], ['empty-arm', 31]]
 *
 *  WHAT IT COUNTS IS AN EVALUATION THAT ANSWERED TRUE, not a site. Under `firstRejection` — which
 *  short-circuits — that is the FIRST rejecter, so this produces exactly the census those three
 *  passes produce, with the same reading: an id absent from it is starved OR SHADOWED by an earlier
 *  rule, and telling the two apart takes the same rule run with the rest of the table empty
 *  (`grep -n "ON ITS OWN" packages/core/src/raise/globalshape.ts` ships two inhabitants of the
 *  second case). A consumer that asks the table something else — `.some`, `.filter` — gets one
 *  count per evaluation instead, which is a different question and rarely the one wanted.
 *
 *  IT CHANGES NO BEHAVIOUR: each wrapper's predicate IS the original's, `id`/`why`/`sound`/
 *  `guardedBy` are carried, so `without`, `ablateHeuristic` and `gateTableDefects` all still hold
 *  over the result. What it does change is the table's IDENTITY — `rank.ts` memoizes a census on
 *  it — so wrap once and reuse `gates`, rather than per call. */
export function tallying<Ctx>(gates: readonly Gate<Ctx>[]): Tallied<Ctx> {
  const counts = new Map<string, number>();
  const order = new Map(gates.map((g, i) => [g.id, i]));
  return {
    gates: gates.map((g) => ({
      ...g,
      rejects: (c: Ctx) => {
        const r = g.rejects(c);
        if (r) {
          counts.set(g.id, (counts.get(g.id) ?? 0) + 1);
        }
        return r;
      },
    })),
    refusals: () =>
      [...counts].sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0)) as readonly (readonly [
        string,
        number,
      ])[],
  };
}
