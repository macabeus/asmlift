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
// only when the default holds an error that SURVIVES every probe: a message the probe was
// rejected with too, exactly as many times as the default was (compiler-diagnostics.ts
// `errorMessages`, positions normalised away). A statement no single variation reaches is re-spelled
// by no product of them either, so its error is in every candidate. Then the remaining candidates
// are NOT COMPILED, and are reported as exactly that.
//
// PER ATTEMPT. A rejection may hold several compiles (compiler-diagnostics.ts `attemptsOf`: the
// benchmark's real tier tries every candidate in a ladder of contexts and two dialects), and a
// candidate compiles when ANY attempt does. So a survivor is asked of EACH attempt, and one attempt
// without a survivor keeps the fan alive: an attempt no candidate can compile in — a context that
// cannot open its own headers — prints the same sentences for every candidate, and those survive
// every probe while another attempt's product compiles. Every probe must have been tried in the
// same attempts, under the same labels, as the default.
//
// Why EXACTLY as many times: a probe that prints the survivor more often has re-spelled a
// statement that raises it (`/reread-globals` re-reading a global whose type is refused), and a
// probe that prints it fewer times has cured one. Either one reached it, so neither vouches that
// a product leaves it alone.
//
// This is the old rule's strict generalisation: a probe rejected with the default's whole
// multiset of errors leaves every message a survivor. What it adds is a fan whose variations DO
// reach some of its errors — `/setup-args` curing a call's arity — while another error stays where
// it was in every probe: pikmin's C++ `setMatMatrices`, once it lifted, compiled all 768
// candidates for a `GXLoadTexMtxImm` argument no variation re-types.
//
// Anything else ranks the whole fan. A probe that compiles or is withheld: the fan is alive. An
// attempt with no survivor: a product of variations may cure what no single one does. An attempt
// whose errors are not read — none recognised, or the compiler stopped reporting — or an attempt
// list that differs from the default's: an unread sentence equals nothing. A throw that is not a
// `CompilerRejection`: a timeout or a killed compiler says nothing about the candidate.
//
// THE RESIDUAL COUNTER-CASE, which this rule does NOT close: ONE error MESSAGE that needs TWO
// variations jointly. `a & b` is `invalid operands to binary &` while either operand is a struct;
// if one variation re-types `a` and another re-types `b`, each probe leaves the message where it
// was, and only their product compiles. The same shape arises without any re-typing wherever the
// compiler prints ONE message for a statement holding TWO defects: mwcc and IDO report
// `y = g(1, 2) + h(3, 4)` as a single message, and agbcc, kmc and IDO report an undeclared name
// once however many times it is used — a probe that cures one of the two defects leaves the
// message where it was. Two DIFFERENT messages each cured by its own variation are not this case:
// each probe removes its message, neither survives, and the fan is ranked whole. The rule used to
// ask that every probe leave EVERY message where it was; asking it of one message per attempt
// leaves the residual the same case, in more fans: whatever the probes did to the other errors, the
// survivor is the one that would need curing jointly. No variation in the vocabulary re-types an
// operand or cures half a statement today; a variation that does must revisit this rule.
//
// ONE COPY. Probe selection and the verdict are pure functions over indices, so the sync driver
// (rank.ts `rankBy`), the pooled CLI driver and the webapp's async loop all sequence their own
// compiles and ask the same question. Every driver finishes the probe phase before compiling
// anything else, which is what keeps the verdict independent of a scheduler.
import { CompilerRejection, attemptsOf, verdictMessages } from './compiler-diagnostics';

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
  /** the default candidate's errors that survived every probe, as the compiler worded them: each
   *  attempt's survivors, a message named once at the most times one attempt printed it */
  messages: string[];
  /** indices that WERE compiled — the default and the probes, ascending */
  compiled: number[];
  /** indices that were not, ascending: the rest of the fan */
  notCompiled: number[];
}

/** A rejection read attempt by attempt: each attempt's label and the multiset of its error
 *  messages. Null for anything the rule cannot read as a verdict — a compile, a throw that is no
 *  `CompilerRejection`, or any attempt whose errors are unread. */
interface Reading {
  labels: string[];
  errors: Map<string, number>[];
}

function readingOf(outcome: ProbeOutcome): Reading | null {
  if (outcome === 'compiled' || !(outcome.thrown instanceof CompilerRejection)) {
    return null;
  }
  const attempts = attemptsOf(outcome.thrown.diagnostic);
  const errors: Map<string, number>[] = [];
  for (const attempt of attempts) {
    const messages = verdictMessages(attempt.diagnostic);
    if (messages === null) {
      return null;
    }
    const tally = new Map<string, number>();
    for (const m of messages) {
      tally.set(m, (tally.get(m) ?? 0) + 1);
    }
    errors.push(tally);
  }
  return { labels: attempts.map((a) => a.label), errors };
}

/** The default's errors that survive `probes`, per attempt — null as soon as one attempt has none
 *  left, or a probe cannot be read against the default. Asks `outcomeOf` for the probes in order
 *  and for none past the first that ends it. */
function survivors(
  anchor: number,
  probes: readonly number[],
  outcomeOf: (index: number) => ProbeOutcome,
): Map<string, number>[] | null {
  const anchored = readingOf(outcomeOf(anchor));
  if (anchored === null) {
    return null;
  }
  const left = anchored.errors.map((tally) => new Map(tally));
  for (const i of probes) {
    const probe = readingOf(outcomeOf(i));
    if (
      probe === null ||
      probe.labels.length !== anchored.labels.length ||
      probe.labels.some((label, k) => label !== anchored.labels[k])
    ) {
      return null;
    }
    for (const [k, tally] of left.entries()) {
      for (const [message, times] of tally) {
        if (probe.errors[k].get(message) !== times) {
          tally.delete(message);
        }
      }
      if (tally.size === 0) {
        return null;
      }
    }
  }
  return left;
}

/** The verdict over a fan whose default and probes have all been compiled — null for "rank the
 *  whole fan", which is every case but one (the module header states the rule).
 *
 *  `outcomeOf` is asked for index 0 and then, only while the answer can still be "stillborn", for
 *  the probes in order — so a synchronous driver may compile on demand inside it and pays for no
 *  probe past the first that ends it. It must answer whenever asked: a driver that skipped a
 *  probe has not run the rule, and "stillborn" over the probes it happened to compile would be a
 *  different, weaker rule. */
export function stillbornVerdict(
  candidates: readonly { variations: readonly string[] }[],
  outcomeOf: (index: number) => ProbeOutcome | undefined,
): Stillborn | null {
  if (candidates.length === 0) {
    return null;
  }
  const asked = (i: number): ProbeOutcome => {
    const outcome = outcomeOf(i);
    if (outcome === undefined) {
      throw new Error(`internal: the stillborn verdict was asked before candidate ${i} was compiled`);
    }
    return outcome;
  };
  const probes = probeIndices(candidates);
  const left = survivors(0, probes, asked);
  if (left === null) {
    return null;
  }
  const compiled = [0, ...probes];
  const tried = new Set(compiled);
  return {
    messages: namedOnce(left),
    compiled,
    notCompiled: candidates.map((_, i) => i).filter((i) => !tried.has(i)),
  };
}

/** Every attempt's survivors as one list: a message in the order it first appears, as many times
 *  as the attempt that printed it most. */
function namedOnce(perAttempt: readonly Map<string, number>[]): string[] {
  const most = new Map<string, number>();
  for (const tally of perAttempt) {
    for (const [message, times] of tally) {
      most.set(message, Math.max(most.get(message) ?? 0, times));
    }
  }
  return [...most].flatMap(([message, times]) => Array.from({ length: times }, () => message));
}

/** Whether a driver that has compiled ONLY the default should now compile the probes — i.e.
 *  whether the default was rejected in a way the rule can read. A driver may skip this and compile
 *  the probes regardless; asking first is what keeps an ordinary fan's compile order untouched. */
export function defaultIsKeyedRejection(outcome: ProbeOutcome): boolean {
  return readingOf(outcome) !== null;
}
