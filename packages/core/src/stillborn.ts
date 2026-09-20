// asmlift — THE STILLBORN FAN: when to stop compiling a fan that cannot compile.
//
// A fan is a product of variations over ONE function body, and every variation only re-spells
// statements. When the body holds a statement the compiler refuses for a reason no variation
// reaches — a call with more arguments than the project's header declares, a struct-typed global
// read as a scalar — every candidate is refused for it, and the fan's size is the number of times
// the same sentence gets printed: 30,240 on `kleod:PauseMenuScreenHandler`.
//
// THE RULE. The DEFAULT candidate (first in enumeration order) is compiled first. Only if the
// compiler REJECTS it is anything else asked: a PROBE per variation name in the fan — the
// candidate with the fewest variations that carries it — is compiled, and the fan is stillborn
// only when the default and every probe were all rejected with the SAME non-empty error key
// (compiler-diagnostics.ts `errorKey`: the multiset of error messages, positions normalised
// away). Then the remaining candidates are NOT COMPILED, and are reported as exactly that.
//
// Anything else ranks the whole fan. A probe that compiles or is withheld: the fan is alive. A
// probe whose key DIFFERS: its variation reaches the failing statement, so a product of
// variations may cure what no single one does. A key that is null: the diagnostic was not
// understood, and an unread sentence equals nothing. A throw that is not a `CompilerRejection`: a
// timeout or a killed compiler says nothing about the candidate.
//
// THE RESIDUAL COUNTER-CASE, which this rule does NOT close: ONE error instance that needs TWO
// variations jointly. `a & b` is `invalid operands to binary &` while either operand is a struct;
// if one variation re-types `a` and another re-types `b`, each probe leaves the multiset exactly
// as it found it, and only their product compiles. No variation in the vocabulary re-types an
// operand today; a variation that does must revisit this rule. (Two DIFFERENT errors each cured
// by its own variation are not this case: each probe removes its error from the multiset, the
// key differs, and the fan is ranked whole.)
//
// ONE COPY. Probe selection and the verdict are pure functions over indices, so the sync driver
// (rank.ts `rankBy`), the pooled CLI driver and the webapp's async loop all sequence their own
// compiles and ask the same question. Every driver finishes the probe phase before compiling
// anything else, which is what keeps the verdict independent of a scheduler.
import { CompilerRejection, errorKey, errorMessages } from './compiler-diagnostics';

/** What compiling one candidate came to, as far as this rule reads it. `compiled` covers scored
 *  AND withheld: either way the compiler accepted the text. */
export type ProbeOutcome = 'compiled' | { thrown: unknown };

/** The candidates to compile once the default was rejected: for every variation name in the fan,
 *  the index of the candidate with the FEWEST variations that carries it, enumeration order
 *  breaking a tie. Ascending, and without the default itself.
 *
 *  A NAME is the whole part as the candidate carries it, subject included: `argcopy-a0@1.0` and
 *  `argcopy-a0@2.0` are two probes, because each re-spells a different statement and the rule asks
 *  whether ANY re-spelling reaches the failing one. Collapsing them to the registered name would
 *  probe one region and answer for both. */
export function probeIndices(candidates: readonly { variations: readonly string[] }[]): number[] {
  const smallest = new Map<string, number>();
  candidates.forEach((c, i) => {
    for (const v of c.variations) {
      const held = smallest.get(v);
      if (held === undefined || c.variations.length < candidates[held].variations.length) {
        smallest.set(v, i);
      }
    }
  });
  return [...new Set(smallest.values())].filter((i) => i !== 0).sort((a, b) => a - b);
}

/** A fan declared stillborn. */
export interface Stillborn {
  /** the error messages the default and every probe share, as the compiler worded them */
  messages: string[];
  /** indices that WERE compiled — the default and the probes, ascending */
  compiled: number[];
  /** indices that were not, ascending: the rest of the fan */
  notCompiled: number[];
}

/** The verdict over a fan whose default and probes have all been compiled — null for "rank the
 *  whole fan", which is every case but one (the module header states the rule).
 *
 *  `outcomeOf` is asked for index 0 and then, only while the answer can still be "stillborn", for
 *  the probes in order — so a synchronous driver may compile on demand inside it and pays for no
 *  probe past the first that disagrees. It must answer whenever asked: a driver that skipped a
 *  probe has not run the rule, and "stillborn" over the probes it happened to compile would be a
 *  different, weaker rule. */
export function stillbornVerdict(
  candidates: readonly { variations: readonly string[] }[],
  outcomeOf: (index: number) => ProbeOutcome | undefined,
): Stillborn | null {
  if (candidates.length === 0) {
    return null;
  }
  const diagnosticAt = (i: number): string | null => {
    const outcome = outcomeOf(i);
    if (outcome === undefined) {
      throw new Error(`internal: the stillborn verdict was asked before candidate ${i} was compiled`);
    }
    return outcome !== 'compiled' && outcome.thrown instanceof CompilerRejection ? outcome.thrown.diagnostic : null;
  };
  const keyAt = (i: number): string | null => {
    const diagnostic = diagnosticAt(i);
    return diagnostic === null ? null : errorKey(diagnostic);
  };
  const diagnostic = diagnosticAt(0);
  const key = diagnostic === null ? null : errorKey(diagnostic);
  if (diagnostic === null || key === null) {
    return null;
  }
  const probes = probeIndices(candidates);
  if (!probes.every((i) => keyAt(i) === key)) {
    return null;
  }
  const compiled = [0, ...probes];
  const tried = new Set(compiled);
  return {
    messages: errorMessages(diagnostic),
    compiled,
    notCompiled: candidates.map((_, i) => i).filter((i) => !tried.has(i)),
  };
}

/** Whether a driver that has compiled ONLY the default should now compile the probes — i.e.
 *  whether the default was rejected in a way the rule can read. A driver may skip this and compile
 *  the probes regardless; asking first is what keeps an ordinary fan's compile order untouched. */
export function defaultIsKeyedRejection(outcome: ProbeOutcome): boolean {
  return (
    outcome !== 'compiled' &&
    outcome.thrown instanceof CompilerRejection &&
    errorKey(outcome.thrown.diagnostic) !== null
  );
}
