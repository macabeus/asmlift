// asmlift — THE STILLBORN FAN: when to stop compiling a fan that cannot compile.
//
// A fan is a product of variations over ONE function body, and every variation only re-spells
// statements. When the body holds a statement the compiler refuses for a reason no variation
// reaches — a call with more arguments than the project's header declares, a struct-typed global
// read as a scalar — every candidate is refused for it, and the fan's size is the number of times
// the same sentence gets printed: 30,240 on `kleod:PauseMenuScreenHandler`.
//
// THE RULE. The DEFAULT candidate (first in enumeration order) is compiled first. Only if the
// compiler REJECTS it is anything else asked: a PROBE per variation name — the candidate with the
// fewest variations that carries it, per signedness half (HALF BY HALF) — is compiled, and the fan
// is stillborn only when the default holds an error that SURVIVES every probe: a message the probe
// was rejected with too, exactly as many times as the default was (compiler-diagnostics.ts
// `errorMessages`, positions normalised away). Then the remaining candidates are NOT COMPILED, and
// are reported as exactly that.
//
// WHAT IT BETS ON: that a statement no probe re-spells is re-spelled by no product of the probes'
// variations either, so its error is in every candidate. That is a bet, not a theorem — a product
// is not the sum of its variations (THE RESIDUALS, below) — and the rule never compiles a product
// to check it.
//
// One survivor is enough; the probes may reach the default's other errors. In
// `ac-decomp:aINS_destruct:mwcc_242_81`'s vendored-context attempt `/setup-args` cures the call to
// `mPlib_Get_item_net_catch_label`, both `illegal implicit conversion` errors stay, and the fan of
// 12 stops after 8 compiles.
//
// EXACTLY as many times: a probe that prints the survivor more often has re-spelled a statement
// that raises it (`/reread-globals` re-reading a global whose type is refused), and a probe that
// prints it fewer times has cured one. Either one reached it, so neither vouches that a product
// leaves it alone.
//
// PER ATTEMPT. A rejection may hold several compiles (compiler-diagnostics.ts `attemptsOf`: the
// benchmark's real tier tries every candidate in a ladder of contexts and two dialects), and a
// candidate compiles when ANY attempt does. So a survivor is asked of EACH attempt, and one attempt
// without a survivor keeps the fan alive: an attempt no candidate can compile in — a context that
// cannot open its own headers — prints the same sentences for every candidate, and those survive
// every probe while another attempt's product compiles. Every probe must have been tried in the
// same attempts, under the same labels, as the default.
//
// HALF BY HALF. Every fan is enumerated at BOTH signednesses (variation-tokens.ts, kind
// `signedness`), and a signedness re-types the whole body, so the survivor is worded once per half:
// aINS_destruct's `illegal implicit conversion` to `struct game_s *` names `unsigned long` in one
// half and `long` in the other, and asked over the whole fan nothing in its vendored-context
// attempt survives the `signed` probe. So each half is asked as a fan of its own — its first
// candidate is its default, its probes are the smallest carrier of each variation name INSIDE it —
// and the fan is stillborn only when every half is. A half is found by the registry's kind, never
// by a name, and a fan with no signedness in its names is one half. A stopped fan pays both halves'
// probes.
//
// KNOWN GAP: a variation that re-words the survivor in PART of the fan is not split on, so its
// probe leaves that attempt without a survivor and the fan is ranked whole —
// `kleod:WorldMapScreenUnlockNewWorld:agbcc`'s only vendored-context error, `incompatible types in
// assignment`, reads `invalid operands to binary &` under `/derived-home` and `/setup-args`.
//
// Anything else ranks the whole fan. A probe that compiles or is withheld: the fan is alive. An
// attempt with no survivor: a product of variations may cure what no single one does. An attempt
// whose errors are not read — none recognised, or the compiler stopped reporting — or an attempt
// list that differs from the default's: an unread sentence equals nothing. A throw that is not a
// `CompilerRejection`: a timeout or a killed compiler says nothing about the candidate.
//
// THE RESIDUALS, which this rule does NOT close: a product that cures the survivor while every
// probe keeps it. One survivor being enough, a stop may rest its whole bet on a single message in
// the one attempt a candidate could compile in. Two shapes are known.
//
// JOINT CURE: ONE error MESSAGE that needs TWO variations together. `a & b` is `invalid operands
// to binary &` while either operand is a struct; if one variation re-types `a` and another re-types
// `b`, each probe leaves the message where it was, and only their product compiles. The same shape
// arises without any re-typing wherever the compiler prints ONE message for a statement holding TWO
// defects: mwcc and IDO report `y = g(1, 2) + h(3, 4)` as a single message, and agbcc, kmc and IDO
// report an undeclared name once however many times it is used. Two DIFFERENT messages each cured
// by its own variation are not this case: each probe removes its message, and neither survives.
// Signedness re-types operands and can cure half a statement — against a declared
// `CARDGetSectorSize(long, unsigned long *)`, `signed` turns a call's `(unsigned long, long *)` into
// `(long, long *)`, one message either way — and HALF BY HALF is what closes it there: a half holds
// its signedness fixed. Any OTHER variation that re-types an operand or cures half a statement
// must revisit this rule.
//
// INTERACTION: a variation whose reach depends on another. A respell runs over whatever tree the
// structure variations built, so a structure variation × respell product re-spells statements
// neither of its probes touched: `/unmerge` copies a join's call into both arms only on the
// `/flip-join` tree, so their product can print a message more often than the default and either
// probe do. A product that moves a survivor UP keeps it an error; one that moved it to zero, leaving
// no other error, would be a candidate that compiles and that the stop never compiles.
//
// ONE COPY. Probe selection and the verdict are pure functions over indices, so the sync driver
// (rank.ts `rankBy`), the pooled CLI driver and the webapp's async loop all sequence their own
// compiles and ask the same question. Every driver finishes the probe phase before compiling
// anything else, which is what keeps the verdict independent of a scheduler.
import { CompilerRejection, attemptsOf, verdictMessages } from './compiler-diagnostics';
import { VARIATION_TOKENS } from './variation-tokens';

/** What compiling one candidate came to, as far as this rule reads it. `compiled` covers scored
 *  AND withheld: either way the compiler accepted the text. */
export type ProbeOutcome = 'compiled' | { thrown: unknown };

/** The signedness names, read off the registry by kind. */
const SIGNEDNESS = new Set<string>(VARIATION_TOKENS.filter((t) => t.variationKind === 'signedness').map((t) => t.name));

/** The fan's signedness HALVES: candidates grouped by the signedness their names carry, each in
 *  enumeration order, the halves in the order of their first candidate. Index 0 opens the first. */
function halvesOf(candidates: readonly { variations: readonly string[] }[]): number[][] {
  const halves = new Map<string, number[]>();
  candidates.forEach((c, i) => {
    const key = c.variations.filter((v) => SIGNEDNESS.has(v)).join('/');
    const half = halves.get(key);
    if (half === undefined) {
      halves.set(key, [i]);
    } else {
      half.push(i);
    }
  });
  return [...halves.values()];
}

/** A half's probes: for every variation name in the half, the index of the candidate IN THE HALF
 *  with the FEWEST variations that carries it, enumeration order breaking a tie. Ascending, and
 *  without the half's own first candidate, which is its default.
 *
 *  A NAME is the whole part as the candidate carries it, subject included: `argcopy-a0@1.0` and
 *  `argcopy-a0@2.0` are two probes, because each re-spells a different statement and the rule asks
 *  whether ANY re-spelling reaches the failing one. Collapsing them to the registered name would
 *  probe one region and answer for both. */
function probesOf(candidates: readonly { variations: readonly string[] }[], half: readonly number[]): number[] {
  const smallest = new Map<string, number>();
  for (const i of half) {
    for (const v of candidates[i].variations) {
      const held = smallest.get(v);
      if (held === undefined || candidates[i].variations.length < candidates[held].variations.length) {
        smallest.set(v, i);
      }
    }
  }
  return [...new Set(smallest.values())].filter((i) => i !== half[0]).sort((a, b) => a - b);
}

/** The candidates to compile once the default was rejected: every half's default and probes
 *  (`halvesOf`, `probesOf`). Ascending, and without the default itself. */
export function probeIndices(candidates: readonly { variations: readonly string[] }[]): number[] {
  const probes = new Set<number>();
  for (const half of halvesOf(candidates)) {
    for (const i of [half[0], ...probesOf(candidates, half)]) {
      probes.add(i);
    }
  }
  probes.delete(0);
  return [...probes].sort((a, b) => a - b);
}

/** A fan declared stillborn. */
export interface Stillborn {
  /** each half's default's errors that survived every probe of that half, as the compiler worded
   *  them in that half: a message named at the most times one attempt printed it */
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

/** Whether a throw is the compiler REFUSING the text: a `CompilerRejection`. Any other throw — a
 *  killed compiler, a Docker outage, a timeout — says nothing about the candidate. The rule reads a
 *  probe through it, and so does whatever checks the rule's bet by compiling a stopped fan's rest
 *  (the benchmark's `bench fan --whole`): a second test there could count a transient as a refusal. */
export const refusedByCompiler = (thrown: unknown): thrown is CompilerRejection => thrown instanceof CompilerRejection;

function readingOf(outcome: ProbeOutcome): Reading | null {
  if (outcome === 'compiled' || !refusedByCompiler(outcome.thrown)) {
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
 *  the probes of its half in order, then for each further half's default and probes — so a
 *  synchronous driver may compile on demand inside it and pays for no probe past the first that
 *  ends it. It must answer whenever asked: a driver that skipped a
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
  const perHalf: Map<string, number>[][] = [];
  for (const half of halvesOf(candidates)) {
    const left = survivors(half[0], probesOf(candidates, half), asked);
    if (left === null) {
      return null;
    }
    perHalf.push(left);
  }
  const compiled = [0, ...probeIndices(candidates)];
  const tried = new Set(compiled);
  return {
    messages: namedOnce(perHalf.flat()),
    compiled,
    notCompiled: candidates.map((_, i) => i).filter((i) => !tried.has(i)),
  };
}

/** Every half's and attempt's survivors as one list: a message in the order it first appears, as
 *  many times as the attempt that printed it most. */
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
export function defaultIsReadableRejection(outcome: ProbeOutcome): boolean {
  return readingOf(outcome) !== null;
}
