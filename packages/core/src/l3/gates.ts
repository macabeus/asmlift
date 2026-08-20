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

/** `without` for SHIPPED code. A test may ablate any gate — that is how `guardedBy` differential
 *  tests work — but a pass that re-runs itself with an ablated table as a ranked candidate may
 *  only drop a HEURISTIC: ablating a `sound: true` gate would ship semantically wrong candidates,
 *  and on a nonmatch row the best-scoring source is shown to the user. Throws at module load, so
 *  the mistake cannot ship. */
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
