// `pnpm bench fan <row>` — the candidate fan the harness ALREADY computes for one row, printed
// instead of discarded.
//
// `eval/asmlift.ts` ranks every candidate spelling and then publishes four facts out of the
// result: the winner's label, the winner's source, the dropped list and the withheld list.
// `RankedResult.candidates` — every OTHER spelling, each carrying its own label, its score and
// the exact source it was scored from — is computed, paid for, and dropped on the floor. This is
// the supported way to read it, taking a row id.
//
// WHY A SUBCOMMAND AND NOT A `bench run` FLAG: the question is always about ONE row, and a flag on
// `run` prices a one-row question at a full tier (~2,100 s). This builds one target, ranks one
// function, and exits.
//
// WHY IT IS NOT `pnpm asmlift --score-against`: that command prints the same `[score]` table, but
// it is reached through the PROJECT CHECKOUT and a hand-written `--proto`, and
// docs/ranked-repro.md is a long document about how easily that configuration drifts from the
// benchmark's (112,896 vs 135,936 candidates for one function across two checkouts of one
// project). Here the row IS the configuration: the case's own target object, prototypes, context
// compiler and vendored symbol map, assembled by the one function the harness assembles them with
// (`rankOptionsFor`). What this prints is what the benchmark measured, by construction.
//
// The line shapes are deliberately the CLI's (`asmlift: [score] …`, `[dropped]`, `[withheld]`,
// `[ranked]`), so docs/ranked-repro.md's comparison recipe — `grep -F '[score]'` over two runs —
// works across the two commands without a second recipe to keep in step.
import type { BenchOutput } from '@asmlift/bench-schema';
import { declaredBlock } from '@asmlift/cli/declare';
import { isDecline } from '@asmlift/cli/decline';
import { bakedBuild, sampleSourceTree, sourceStamp } from '@asmlift/cli/provenance';
import type { RankOptions, RankedCandidate, RankedResult } from '@asmlift/cli/rank';
import { enumerateRanked } from '@asmlift/cli/rank';
import { rankedSummaryLine, scoreOf } from '@asmlift/cli/score-format';
import type { SymbolRef } from '@asmlift/core/l3/symbol-refs';
import { decompile } from '@asmlift/core/pipeline';
import type { Candidate, DroppedCandidate, WithheldCandidate } from '@asmlift/core/rank';
import { NoScorableCandidateError, NoSpellableCandidateError } from '@asmlift/core/rank';
import { readFileSync } from 'node:fs';

import { scrubObjectHeader } from '../asm-scrub';
import { realCases } from '../cases/real';
import { syntheticCases } from '../cases/synthetic';
import type { Case } from '../cases/types';
import { asmliftFan, fanSize, fanSizeOfError, rankOptionsFor } from '../eval/asmlift';
import { readCommitted } from '../report/committed';
import { fanMove } from '../report/diff';
import { TOOLCHAINS, type Toolchain } from '../toolchains';

/** How many candidates this command will COMPILE before refusing without `--force`.
 *
 *  The scope guard, and it is not decorative: a fan is a product over enumeration axes, so row
 *  sizes are not on ONE scale. `synthetic:sizebound:agbcc` enumerates 800 and scores them here in
 *  **48 s cold, 10 s once the candidate cache holds them** (both measured on this machine) — a
 *  fine price for a diagnostic, and the limit has to sit well above it or the command refuses the
 *  very rows it exists for. At the cold rate this limit is about two minutes, and the refusal says
 *  so with the row's own count rather than a fixed scare sentence (`SCORE_SECONDS_PER_CANDIDATE`).
 *  `LoadBGTilemapData` enumerates 225,792 (docs/ranked-repro.md) and is a REAL row, so at that
 *  tier's measured rate its fan is over FIVE HOURS — a run a round starts on purpose or not at all.
 *
 *  A one-row diagnostic that can silently become an overnight job is a trap, and the cheap answer
 *  — `--enumerate`, which compiles nothing and still prints every label and, with `--show`, any
 *  candidate's source — is one flag away. It is CHEAP RELATIVE TO COMPILING and not cheap
 *  absolutely: `kleod:CountCollectedGems:agbcc`'s 5,952 labels take 50 s wall, target build
 *  included (~120 candidates/s), so LBG's fan is ~30 minutes to merely LIST — and this guard is
 *  checked after the pre-count enumeration, so the refusal itself pays that. */
export const FAN_SCORE_LIMIT = 2000;

/** Seconds per candidate on the SCORING path — a compile plus an objdiff alignment — PER TIER,
 *  because the two tiers do not compile the same thing.
 *
 *  Both numbers are cold measurements on this machine with `ASMLIFT_CANDCACHE=0`:
 *
 *  | tier | row | candidates | SCORING wall | per candidate |
 *  |---|---|---|---|---|
 *  | synthetic | `synthetic:sizebound:agbcc` | 800 | 47.9 s | 60 ms |
 *  | real | `kleod:CountCollectedGems:agbcc` | 5,952 | 518 s | 87 ms |
 *  | real | the same row, a second run on a quieter machine | 5,952 | 483 s | 81 ms |
 *
 *  (Both real-tier walls are the total minus a separately measured 50 s of target build plus
 *  enumeration, and both runs reproduced the published `171/387`. The constant is the middle of
 *  the two; the spread is machine load, and the tier gap is 40% either way.)
 *
 *  ONE rate for both under-prices the real tier by ~35%, and that is the tier the refusal quotes
 *  on `CountCollectedGems`. The mechanism is in `compile/real.ts`: a real candidate escalates
 *  through up to three preludes (`makeRealCompile`), where a synthetic one is a single small
 *  prelude — so the real tier pays more compiler invocations per candidate, and the gap is
 *  structural rather than noise.
 *
 *  The point of the constant is that the refusal QUOTES a price instead of asserting one: a reader
 *  steered off `--force` by a wrong number loses the answer the command exists to give. */
export const SCORE_SECONDS_PER_CANDIDATE: Record<Case['tier'], number> = {
  synthetic: 0.06,
  real: 0.085,
};

/** The price of scoring `n` candidates of this row's tier, rounded to a unit a reader can act on.
 *  Never a bare second-count above a minute: the decision this informs is "do I start this now",
 *  and 357 s is a number one has to divide before it means anything. */
export function estimatedScoreTime(n: number, tier: Case['tier']): string {
  const seconds = n * SCORE_SECONDS_PER_CANDIDATE[tier];
  if (seconds < 90) {
    return `about ${Math.max(1, Math.round(seconds))} s`;
  }
  const minutes = seconds / 60;
  return minutes < 90 ? `about ${Math.round(minutes)} min` : `about ${(minutes / 60).toFixed(1)} h`;
}

export interface FanOptions {
  /** print this candidate's SOURCE (its label, or `best`) after the table */
  show?: string;
  /** COMPARE this row's fan against the count the artifact at this ref recorded for it — the
   *  fan multiplier a round is asked to report before it merges an axis. Spelled `--base` rather
   *  than a second word for "which committed artifact to compare against": `diff`, `regression`,
   *  `baseline` and `stale-check` all already take it, and two names for one ref is how the two
   *  spellings come to mean different things. */
  base?: string;
  /** List the fan without compiling anything. Cheap against the scoring pass and not free:
   *  5,952 labels took 50 s wall here (`kleod:CountCollectedGems:agbcc`, target build included),
   *  so the biggest fans take minutes to merely list. */
  enumerateOnly?: boolean;
  /** score a fan larger than FAN_SCORE_LIMIT anyway */
  force?: boolean;
}

/** THE FAN MULTIPLIER, against what the artifact at `base` recorded for this same row — one line,
 *  and the number a round that ships an axis is asked to report before it merges.
 *
 *  It is a comparison of THIS TREE's enumeration against a RECORDED one, which is sound only
 *  because both are the same call: the run wrote `candidateCount` out of `rankOptionsFor`'s
 *  options, and this command enumerates under those same options for the same row id. A fan
 *  enumerated under options assembled a second time is a fan of a different configuration —
 *  docs/ranked-repro.md documents a 112,896-vs-135,936 spread from exactly that.
 *
 *  Every way the comparison cannot be made is a SENTENCE rather than a silence, because the
 *  answer this returns is the one a round pastes: an artifact that predates the field, a row the
 *  base never had, and a ref nothing can read are three different facts and only one of them is
 *  about the fan.
 *
 *  Pure — the caller prints it — and it takes the base artifact rather than reading it, so the
 *  three refusals are testable without a checkout to compare against. */
export function fanDiffLine(
  rowId: string,
  now: number,
  base: string,
  committed: BenchOutput | { error: string },
): string {
  if ('error' in committed) {
    return `asmlift: [fan-diff] cannot read the artifact at ${base}: ${committed.error.split('\n')[0]}`;
  }
  const was = committed.results.find((r) => r.id === rowId);
  if (was === undefined) {
    return (
      `asmlift: [fan-diff] ${rowId} is not in the artifact at ${base} — this row was added since, so ` +
      `there is no earlier fan to compare. This run enumerates ${now}.`
    );
  }
  const from = was.asmlift.candidateCount;
  if (from === undefined) {
    return (
      `asmlift: [fan-diff] the artifact at ${base} records no candidate count for ${rowId} ` +
      `(it predates the field, or the row never ranked there). This run enumerates ${now}; the ` +
      `series starts here.`
    );
  }
  return `asmlift: [fan-diff] ${rowId}: ${fanMove(from, now)} vs ${base}`;
}

/** IS THIS SYMBOL EVEN IN THIS FILE — asked of the raw text, and answered as a fact about the
 *  text rather than as a claim about which label is a function.
 *
 *  The Thumb frontend REFUSES a name that is not a function label when the file holds two or more
 *  functions ("not a function label in this asm (functions present: …)"). On a ONE-function file
 *  it deliberately does the opposite: it treats the name as an intentional rename and lifts that
 *  one function under it — which is the klonoa workflow (`sub_0800D188:` in the split, the name
 *  you are decompiling it under on the command line), so refusing it here would break the very
 *  case `--asm` exists for. What it must not do is stay SILENT: a typo'd symbol then prices
 *  whatever function the file holds, under a name that exists nowhere, and exits 0 with a
 *  confident count.
 *
 *  So: a label definition anywhere in the file (`name:`, or a `*_func_start NAME` splitter macro)
 *  is enough to say nothing. Otherwise the caller warns and NAMES what the file does define.
 *  Deliberately not a second function-label parser — a second spelling of the frontend's rule
 *  would be a new way to be confidently wrong about which label is a function. */
export function definedLabels(asm: string): string[] {
  const out = new Set<string>();
  for (const line of asm.split('\n')) {
    // `.`-prefixed labels are the assembler's own (`.L6`, `.Lfe1`, `.gcc2_compiled.`): never a
    // symbol anyone types, and listing them buries the one name the reader is looking for.
    const label = line.match(/^\s*([A-Za-z_$][\w$.]*)\s*:/);
    if (label) {
      out.add(label[1]);
    }
    const macro = line.match(/^\s*(?:non_word_aligned_thumb_func_start|thumb_func_start|arm_func_start)\s+(\S+)/);
    if (macro) {
      out.add(macro[1]);
    }
  }
  return [...out];
}

/** The warning for a `--asm` symbol the file never defines, or `undefined` when there is nothing
 *  to warn about (the symbol is there, or the file defines no labels at all and any claim about
 *  what was lifted would be invented). */
export function renameWarning(sym: string, asmPath: string, labels: string[]): string | undefined {
  if (labels.length === 0 || labels.includes(sym)) {
    return undefined;
  }
  const shown = labels.slice(0, 8);
  return (
    `${JSON.stringify(sym)} is not defined anywhere in ${asmPath} — the lift below is of whatever ` +
    `function this file holds, RENAMED to ${sym} (the frontend allows that on a single-function ` +
    `file). Labels this file defines: ${shown.join(', ')}${labels.length > shown.length ? ', …' : ''}. ` +
    `If you meant one of those, pass it: the count is that function's fan either way, so a typo ` +
    `here prices the right function under a name that does not exist.`
  );
}

/** The base artifact, or the reason it could not be read — `readCommitted` throws, and a throw
 *  here would take down a fan the reader has already paid tens of seconds to enumerate. */
function baseArtifact(base: string): BenchOutput | { error: string } {
  try {
    return readCommitted(base);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Resolve a row the way a reader names one: the exact id first, then a substring of it.
 *
 *  Exact-first matters and is not just convenience — `--only` elsewhere in the harness is a
 *  substring match, so a round that has been typing symbol names all day types one here; but a row
 *  id that is a substring of another row's id (a symbol and its `_2` sibling) must still resolve to
 *  itself rather than to an ambiguity error. Returns every match so the caller can print them: a
 *  command that silently picks one of four toolchains for a symbol answers a question nobody
 *  asked. */
export function selectCases(cases: Case[], query: string): Case[] {
  const exact = cases.filter((c) => c.id === query);
  return exact.length > 0 ? exact : cases.filter((c) => c.id.includes(query));
}

/** One candidate as the CLI spells it — through the CLI's OWN renderer, denominator included.
 *  `scoreOf` exists because a numerator alone reads as a subtraction on a fixed scale and is not
 *  one (`290/404 → 171/387`, PR #174); a second renderer here would re-open exactly that. */
export function scoreLine(c: RankedCandidate): string {
  return `asmlift: [score] ${c.label}: ${scoreOf(c.score)}`;
}

/** The two refusal lists, one line each and IN FULL — where the CLI prints a count plus the first
 *  one. The CLI's line is a footnote under a score a user is reading; this command is the one
 *  place whose entire purpose is the fan, and "3 candidates failed to score; first: …" is exactly
 *  the shape that sent rounds back to a hand-written script.
 *
 *  Separate from `renderFan` because they are also the ONLY output a row whose every candidate
 *  failed to compile has: `rankBy` throws there rather than returning, so the fan reaches the
 *  reader through the thrown error's own lists (`NoScorableCandidateError`). One spelling for both
 *  paths. */
export const dropLine = (d: DroppedCandidate): string => `asmlift: [dropped] ${d.label}: ${d.error.split('\n')[0]}`;
export const withheldLine = (w: WithheldCandidate): string =>
  `asmlift: [withheld] ${w.label} at ${scoreOf(w)}: ${w.why}`;

/** The whole scored fan: every candidate, then the two refusal lists, then the `[declared]` block
 *  and the summary line.
 *
 *  `synthesized` and `stamp` are ARGUMENTS rather than something computed here because they are
 *  not facts about the fan: the first is a claim about the world the candidates compiled in (the
 *  caller knows the row's tier), the second about the tree that produced them. They are on the
 *  line because the line is what a round pastes — see `rankedSummaryLine`, which both this command
 *  and the CLI's own ranked run now render through. */
export function renderFan(ranked: RankedResult, a: { synthesized: SymbolRef[]; stamp: string }): string {
  const lines = ranked.candidates.map(scoreLine);
  lines.push(...ranked.dropped.map(dropLine), ...ranked.withheld.map(withheldLine));
  if (a.synthesized.length > 0) {
    lines.push(declaredBlock(a.synthesized).trimEnd());
  }
  lines.push(
    rankedSummaryLine({
      scored: ranked.candidates.length,
      dropped: ranked.dropped.length,
      withheld: ranked.withheld.length,
      synthesized: a.synthesized.length,
      best: ranked.best,
      stamp: a.stamp,
    }),
  );
  return lines.join('\n');
}

/** WHICH of the winner's declarations asmlift INVENTED, in the world this row is scored in — the
 *  list the `[declared]` block names and the count the `[ranked]` line carries.
 *
 *  The CLI asks its compiler seam (`compilers.selfDeclared()`); the benchmark cannot — its
 *  `benchCompilerFor` hands back the bare compile function and drops the probe's verdict. The row
 *  itself answers instead, and the answer is the tier: a REAL row is compiled through
 *  `makeRealCompile`, whose every rung is a headers world ("the rest of the synthesized block
 *  stays dropped: the context owns it", compile/real.ts) — so no score there rests on an invented
 *  declaration, and the count is 0. A SYNTHETIC row has no project context, so the block is the
 *  only declaration its candidates have.
 *
 *  Wrong in ONE direction only, and deliberately: a synthetic toolchain whose prelude probe fails
 *  would make this over-report, which prints declarations to check that turn out to have been
 *  ignored. Under-reporting would publish a `(match)` resting on declarations nobody was told
 *  about. */
export function synthesizedRefs(tier: Case['tier'], best: RankedCandidate): SymbolRef[] {
  return tier === 'real' ? [] : (best.symbolRefs ?? []).filter((r) => r.synthesized);
}

/** `--show`: the named candidate, or the winner under the reserved name `best`. Undefined ⇒ the
 *  caller lists what there was, because a typo'd label and a lever that produced no candidate at
 *  all are the same silence otherwise.
 *
 *  `best` IS `candidates[0]` and only because the caller hands it a SCORED list: `rankBy` sorts
 *  best-first (core rank.ts `compareScored`). An enumerated list is in enumeration order and has
 *  no best at all, so that combination is refused before any work happens — see `optionRefusal`,
 *  which exists because this function cannot tell the two arrays apart. */
export function pickCandidate<C extends Candidate>(candidates: C[], label: string): C | undefined {
  if (label === 'best') {
    return candidates[0];
  }
  return candidates.find((c) => c.label === label);
}

/** Flag combinations that cannot mean anything, refused BEFORE the row is built — enumeration on a
 *  big row costs ~46 s, and paying it to be told the flags were nonsense is the worst order.
 *
 *  There are two, and both are a flag about SCORING passed to a path that scores nothing:
 *
 *  `--enumerate --show best` — nothing has been scored, so `best` would resolve to whatever
 *  enumeration emitted first: a near-worst spelling presented under the name of the winner, to a
 *  round both briefs have told that `--show best` is the winner and that `--enumerate` still
 *  serves `--show`. A wrong answer in the shape of a right one is worse than a refusal.
 *
 *  `--enumerate --force` — `--force` raises the FAN_SCORE_LIMIT compile guard, and a path that
 *  compiles nothing has no guard to raise. It was accepted and ignored in silence, on both
 *  enumeration-only paths: `--asm --force` reached here as `enumerateOnly: true` and was dropped
 *  the same way. A flag a user passes to change the run and that changes nothing is the silence
 *  this whole file refuses elsewhere. */
export function optionRefusal(o: FanOptions): string | undefined {
  if (o.enumerateOnly && o.show === 'best') {
    return (
      `--show best names the WINNER and --enumerate scores nothing, so there is no winner to name ` +
      `(an enumerated fan is in enumeration order, not score order). Drop --enumerate to score the ` +
      `fan and get a real best, or pass --show <label> for a spelling you can name.`
    );
  }
  if (o.enumerateOnly && o.force) {
    return (
      `--force raises the ${FAN_SCORE_LIMIT}-candidate limit on COMPILING a fan, and nothing is ` +
      `compiled here (--enumerate lists the fan; --asm has no target object to score against), so ` +
      `it cannot mean anything. Drop --force to list the fan, or drop --enumerate to score it.`
    );
  }
  return undefined;
}

/** A candidate's source, with the header that says which spelling it is — a non-winning
 *  candidate's C is otherwise indistinguishable from the published row's. */
function showSource(label: string, source: string): string {
  return `/* candidate ${label} */\n${source.trimEnd()}`;
}

/** stderr, so `bench fan <row> > fan.txt` keeps the table and drops the noise. */
function note(s: string): void {
  console.error(s);
}

/** The stamp the `[ranked]` line carries: which tree produced these numbers. Two samples, before
 *  and after the run — see provenance.ts for why one is not enough. */
const stampFrom = (treeBefore: ReturnType<typeof sampleSourceTree>): string =>
  sourceStamp(treeBefore, sampleSourceTree(), bakedBuild());

/** THERE IS NO FAN, as an ANSWER rather than a crash — the command's own exit 2 and a sentence,
 *  never a Node stack trace, and the sentence is chosen BY THE ERROR.
 *
 *  Three different facts arrive at this function's two call sites, and they are not the same fact:
 *
 *  - `NoScorableCandidateError` — every spelling compiled-and-failed. That is `noncompile`, and
 *    the drop list riding on the error IS the row's whole fan, so it is printed in full: the one
 *    line the exception itself carries is the LAST spelling refused, neither the first nor a
 *    representative one.
 *  - `NoSpellableCandidateError` — the backend refused every tree before any compile. Nothing was
 *    dropped because nothing was ever built.
 *  - a DECLINE (`isDecline`) — the unmodelled construct that makes the published row `declined`
 *    (233 of 1,035 rows). Enumeration has no annotate mode, so it throws where the published row
 *    gets an `ASMLIFT_ERROR` marker.
 *
 *  The sentence is chosen by the ERROR and never by which call site caught it: `--force` skips the
 *  guarded pre-count enumeration, so a declined row's lift error arrives at the scoring catch,
 *  where a call-site guess would call it `noncompile`. Both briefs tell a round to pass `--force`.
 *
 *  Anything the three tests do not classify is a HARNESS DEFECT and says so, with the stack: a
 *  guard that swallows a `TypeError` into a confident sentence about the row is strictly worse
 *  than the crash it replaced. */
export interface NoFanReport {
  /** the two refusal lists — on stdout, because on this path they ARE the fan */
  fan: string[];
  /** the diagnosis — on stderr, so `bench fan <row> > fan.txt` keeps the fan and drops the prose */
  notes: string[];
  /** unclassified: the caller prints the raw error too, stack and all */
  harnessDefect: boolean;
}

export function noFanReport(rowId: string, e: unknown, show?: string): NoFanReport {
  const nsc = e instanceof NoScorableCandidateError ? e : undefined;
  const dropped: DroppedCandidate[] = nsc?.dropped ?? [];
  const withheld: WithheldCandidate[] = nsc?.withheld ?? [];
  const message = e instanceof Error ? e.message : String(e);
  const first = message.split('\n')[0];

  const notes: string[] = [];
  const harnessDefect = nsc === undefined && !(e instanceof NoSpellableCandidateError) && !isDecline(e);
  notes.push(`asmlift: [fan] no fan for ${rowId}: ${first}`);
  if (nsc !== undefined) {
    // Count BOTH lists. `rankBy` has a reachable all-withheld branch ("N candidate(s) withheld,
    // none scored"), where a dropped-only count reads "the 0 [dropped] line(s) above ARE this
    // row's fan" printed under N withheld lines.
    notes.push(
      `asmlift: [fan] every candidate was refused, so there is no ranking — the ` +
        `${dropped.length} [dropped] and ${withheld.length} [withheld] line(s) above ARE this ` +
        `row's fan. This is what the published row's "noncompile" outcome means.`,
    );
  } else if (e instanceof NoSpellableCandidateError) {
    notes.push(
      `asmlift: [fan] the backend refused every spelling this row enumerates, before anything was ` +
        `compiled — so the fan is empty by construction and nothing was dropped. The line above is ` +
        `the LAST refusal, not the only one.`,
    );
  } else if (isDecline(e)) {
    notes.push(
      `asmlift: [fan] the gap named above is the one this row DECLINES on: enumeration has no ` +
        `annotate mode, so it throws where the published row gets an ASMLIFT_ERROR marker. Close ` +
        `the gap and the fan exists; until then there is nothing to score.`,
    );
  } else {
    notes.push(
      `asmlift: [fan] that is not a decline and not an empty fan — it is a HARNESS defect, not a ` +
        `fact about this row. The stack follows; do not read it as the row's outcome.`,
    );
  }

  // `--show` is answered on this path too — a noncompile row is the one row class where EVERY
  // candidate is unshowable, which is exactly where the flag's advice earns its keep.
  if (show !== undefined) {
    notes.push(
      dropped.length + withheld.length === 0
        ? `--show ${JSON.stringify(show)} cannot be answered: this row produced no candidates at ` +
            `all, so there is no source to print.`
        : unshowable(show, { dropped, withheld }, 'the [dropped]/[withheld] lines above — this row scored nothing'),
    );
  }
  return { fan: [...dropped.map(dropLine), ...withheld.map(withheldLine)], notes, harnessDefect };
}

/** `noFanReport`, printed. Exit 2 — the command's own "I have no answer", distinct from the
 *  ranked path's 0. */
function noFan(c: Case, e: unknown, show?: string): number {
  const r = noFanReport(c.id, e, show);
  if (r.fan.length > 0) {
    console.log(r.fan.join('\n'));
  }
  for (const n of r.notes) {
    note(n);
  }
  if (r.harnessDefect) {
    console.error(e);
  }
  return 2;
}

/** `--show <label>` on a label that IS in the fan but carries no scored source. A dropped
 *  candidate never compiled and a withheld one was refused publication; neither is in
 *  `[score]`, so "see the [score] lines above" sends the reader to look for a line that will
 *  never be there. `--enumerate` carries every candidate's source, including these, and is the
 *  answer — the source of the spelling that FAILED to compile is usually the one worth reading.
 *
 *  `listedIn` is a parameter because this serves TWO tables: the scored one, and the drop list a
 *  `noncompile` row reaches through `noFanReport`, where there are no `[score]` lines to send a
 *  reader to. That row class is precisely where every candidate is unshowable. */
export function unshowable(
  label: string,
  fan: { dropped: DroppedCandidate[]; withheld: WithheldCandidate[] },
  listedIn = 'the [score] lines above',
): string {
  const where = fan.dropped.some((d) => d.label === label)
    ? 'was dropped (it did not compile), so it has no scored source'
    : fan.withheld.some((w) => w.label === label)
      ? 'was withheld (it scored but is unpublishable), so it is not in the [score] table'
      : undefined;
  return where === undefined
    ? `no candidate labelled ${JSON.stringify(label)} — see ${listedIn}`
    : `${JSON.stringify(label)} ${where}. Its source is still readable: re-run with --enumerate --show ${label}`;
}

/** THE FAN OF A FUNCTION THAT IS NOT A BENCHMARK ROW — one `.s` file, one toolchain, no target
 *  object, nothing compiled.
 *
 *  The command above is dataset-row-scoped by construction and that is right for what it does: the
 *  row IS the configuration, so what it prints is what the benchmark measured. But the question
 *  "what would this function's fan cost" is asked about functions that have no row yet — the one
 *  a dogfooding round is about to attempt, the one a round is deciding whether to add, the one
 *  `fan.ts` prices at five hours and nobody has ever enumerated. There was no way to ask it, so
 *  rounds hand-built a driver, and 41 of 51 of those hit `ERR_MODULE_NOT_FOUND` before they got an
 *  answer.
 *
 *  ENUMERATION ONLY, and that is a refusal rather than an omission: scoring needs a target object
 *  to diff against and a compiler configured to build against that object's world, which is
 *  exactly the configuration a row carries and a bare `.s` does not. A fan listed from a `.s` is
 *  an honest count of spellings; a SCORE from one would be a number against a target nobody named.
 *
 *  It is also NOT the harness's configuration: no prototypes, no side-table `asmData`, no symbol
 *  map. So its count is comparable with another `.s` run, and with itself across two revisions —
 *  which is what it is for — and not with a row's recorded `candidateCount`. Said out loud, because
 *  a number that looks like the row's and is not is worse than no number. */
export function fanOfAsm(sym: string, asmPath: string, toolchainId: string, o: FanOptions = {}): number {
  const tc = (TOOLCHAINS as Record<string, Toolchain | undefined>)[toolchainId];
  if (tc === undefined) {
    note(`unknown --toolchain ${JSON.stringify(toolchainId)} — one of: ${Object.keys(TOOLCHAINS).join(', ')}`);
    return 2;
  }
  if (o.base !== undefined) {
    note(
      `--base compares against a row's RECORDED fan and a raw .s is not a row, so there is nothing ` +
        `to look it up by. Enumerate the .s in both trees and compare the two counts.`,
    );
    return 2;
  }
  let asm: string;
  try {
    asm = scrubObjectHeader(readFileSync(asmPath, 'utf8'));
  } catch (e) {
    note(`cannot read ${asmPath}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    return 2;
  }
  const refusal = optionRefusal({ ...o, enumerateOnly: true });
  if (refusal !== undefined) {
    note(refusal);
    return 2;
  }
  // WHICH FUNCTION IS BEING PRICED. The only place in this command where a user-supplied symbol
  // meets a user-supplied file, and on a one-function `.s` the frontend renames rather than
  // refuses — so a name that is in no label silently prices the file's own function under it.
  const warning = renameWarning(sym, asmPath, definedLabels(asm));
  if (warning !== undefined) {
    note(`asmlift: [fan] WARNING: ${warning}`);
  }
  note(
    `${sym} from ${asmPath} — toolchain ${toolchainId}, ENUMERATION ONLY: no target object, so ` +
      `nothing is compiled or scored, and no prototypes, asm-data side table or symbol map are in ` +
      `scope. This count is comparable with another .s run of the same file, NOT with a benchmark ` +
      `row's recorded candidateCount.`,
  );

  // The same phase-1 verdict the row path states first: a gap here is what would make a published
  // row `declined`, and enumeration below throws on it rather than annotating.
  try {
    const dec = decompile(sym, asm, tc.targetDesc, { onGap: 'annotate' });
    for (const d of dec.diagnostics) {
      note(`asmlift: [declined] ${d.stage}: ${d.reason.split('\n')[0].slice(0, 200)}`);
    }
  } catch (e) {
    note(`asmlift: [declined] annotate pass threw: ${(e as Error).message.split('\n')[0]}`);
  }

  const leverErrors = new Map<string, string>();
  let cands: Candidate[];
  try {
    cands = enumerateRanked(sym, asm, tc.targetDesc, {
      onLeverError: (label: string, error: string) => leverErrors.set(label, error.split('\n')[0]),
    });
  } catch (e) {
    for (const [label, error] of leverErrors) {
      note(`asmlift: [lever] ${label} threw (no candidate from it): ${error}`);
    }
    const r = noFanReport(`${sym} (${asmPath})`, e, o.show);
    if (r.fan.length > 0) {
      console.log(r.fan.join('\n'));
    }
    for (const n of r.notes) {
      note(n);
    }
    if (r.harnessDefect) {
      console.error(e);
    }
    return 2;
  }
  for (const [label, error] of leverErrors) {
    note(`asmlift: [lever] ${label} threw (no candidate from it): ${error}`);
  }
  console.log(cands.map((cand) => `asmlift: [candidate] ${cand.label}`).join('\n'));
  console.log(`asmlift: [fan] ${cands.length} candidate(s) enumerated, none scored (--asm)`);
  if (o.show) {
    const picked = pickCandidate(cands, o.show);
    if (!picked) {
      note(`no candidate labelled ${JSON.stringify(o.show)} — see the [candidate] lines above`);
      return 2;
    }
    console.log(showSource(picked.label, picked.source));
  }
  return 0;
}

export function fan(rowId: string, o: FanOptions = {}): number {
  // The tree BEFORE the run, for the stamp on the `[ranked]` line. A pair of samples, as
  // provenance.ts requires: one reading is blind to any edit not standing at that instant, and a
  // parallel round editing `packages/` is the normal state of this machine.
  const treeBefore = sampleSourceTree();
  const matches = selectCases([...syntheticCases(), ...realCases()], rowId);
  if (matches.length === 0) {
    note(`no such row: ${rowId} (ids are project:sym:toolchain)`);
    return 2;
  }
  if (matches.length > 1) {
    note(`${rowId} matches ${matches.length} rows — name one:\n${matches.map((c) => `  ${c.id}`).join('\n')}`);
    return 2;
  }
  const c = matches[0];
  if (!c.toolchain.available()) {
    note(`${c.id}: toolchain ${c.toolchain.id} unavailable — nothing to enumerate`);
    return 2;
  }
  // AFTER the row is resolved, and before it is built. A nonsense flag pair is worth refusing
  // before a ~46 s enumeration is paid for it — but not before the command can say the row does
  // not exist. Case selection is in-memory, so this ordering costs nothing.
  const refusal = optionRefusal(o);
  if (refusal !== undefined) {
    note(refusal);
    return 2;
  }

  // The runner's own build, header scrub included: the disassembly asmlift sees must be the bytes
  // the row was measured from, and the scrub is part of them — through `scrubObjectHeader`, the
  // one spelling the runner and the evaluator use, so this command cannot drift from the run it
  // claims to reproduce.
  //
  // GUARDED, and it is the one throw on this path that is NOT a fact about the row: a target that
  // will not build is the harness broken (the runner names it the same way — "a HARNESS defect,
  // not a decompiler outcome").
  let built: ReturnType<Case['build']>;
  try {
    built = c.build();
  } catch (e) {
    note(`${c.id}: building the target threw — a HARNESS defect, not a decompiler outcome:`);
    console.error(e);
    return 2;
  }
  const { obj, asm: raw } = built;
  const asm = scrubObjectHeader(raw);
  const opts = rankOptionsFor(c.toolchain, obj, c.proto, c.compile, c.symbols);
  note(`${c.id} — tier ${c.tier}, toolchain ${c.toolchain.id}${c.symbols ? ', symbol map' : ''}`);

  // The harness's PHASE 1 verdict, stated before any number: a gapped row is published `declined`
  // and its fan is never scored at all, so a reader handed this table without the warning would be
  // reading candidate scores for a row whose published outcome has no score in it.
  try {
    const dec = decompile(c.sym, asm, c.toolchain.targetDesc, { ...opts, onGap: 'annotate' });
    for (const d of dec.diagnostics) {
      note(`asmlift: [declined] ${d.stage}: ${d.reason.split('\n')[0].slice(0, 200)}`);
    }
    if (dec.diagnostics.length > 0) {
      note(
        `asmlift: [declined] this row publishes outcome "declined" — a fan below, IF enumeration ` +
          `reaches one, is what WOULD be scored once the gap(s) above closed`,
      );
    }
  } catch (e) {
    note(`asmlift: [declined] annotate pass threw: ${(e as Error).message.split('\n')[0]}`);
  }

  // A lever that THREW produced no candidate to drop, and the benchmark supplies no sink for that
  // channel — cli/rank.ts says so at the field: "a whole pre-fan half of a row's fan can still
  // vanish from a `pnpm bench run` with nothing printed". Here it is printed.
  const leverErrors = new Map<string, string>();
  // ANNOTATED, for the same reason `rankOptionsFor`'s return type is: a mistyped option key is a
  // SILENTLY DROPPED option, and a dropped `symbols` is the 112,896-vs-135,936 discrepancy class
  // docs/ranked-repro.md is about. `rankOptionsFor`'s own annotation does not reach here —
  // excess-property checking fires on a literal only where that literal is itself annotated.
  const withLevers: RankOptions = {
    ...opts,
    onLeverError: (label: string, error: string) => leverErrors.set(label, error.split('\n')[0]),
  };
  // ONCE PER LABEL. Both the pre-count enumeration and the scoring pass enumerate, and each
  // re-runs every lever, so a lever that throws throws twice — reported twice, it reads as two
  // broken levers.
  const printedLevers = new Set<string>();
  // THE MULTIPLIER, on stdout beside the fan it is about — printed at whichever of the FOUR exits
  // this run reaches, because all four know a count: the `--enumerate` listing, the over-limit
  // refusal (which is the one that matters most on the big rows — you learn what the fan did
  // without paying a compile for any of it), the scored table, and the `noncompile` path, where
  // every spelling was refused and the refusal lists ARE the fan (`fanSizeOfError`, the same sum
  // the run records for that row class).
  //
  // AN UNREADABLE `--base` IS NOT ONE OF THE THREE no-comparison ANSWERS. "The base predates the
  // field" and "the row was added since" are facts about the data and belong on stdout beside the
  // count; a ref nothing can read is a bad ARGUMENT — the one thing the flag was passed to produce
  // did not happen. It goes to stderr with every other diagnostic (so `bench fan <row> > fan.txt`
  // does not swallow it into the table) and it moves the exit code, because `bench fan --base X &&
  // …` otherwise reads success from a run that compared nothing.
  let baseUnreadable = false;
  const printFanDiff = (n: number): void => {
    if (o.base === undefined) {
      return;
    }
    const artifact = baseArtifact(o.base);
    const line = fanDiffLine(c.id, n, o.base, artifact);
    if ('error' in artifact) {
      baseUnreadable = true;
      note(line);
      return;
    }
    console.log(line);
  };
  /** The success exit, downgraded when a `--base` the user named could not be read. */
  const exitOk = (): number => (baseUnreadable ? 2 : 0);
  /** THE FAN-LESS EXIT, which is not always a count-less one. A `noncompile` row — every spelling
   *  refused — throws, and the error carries both refusal lists, so the run RECORDS a
   *  `candidateCount` for exactly this class (`fanSizeOfError`). It was the one row class whose
   *  fan the artifact knows and whose `--base` comparison this command declined to make. */
  const noFanWithDiff = (e: unknown): number => {
    const code = noFan(c, e, o.show);
    const n = fanSizeOfError(e);
    if (n !== undefined) {
      printFanDiff(n);
    }
    return code;
  };
  const printLevers = (): void => {
    for (const [label, error] of leverErrors) {
      if (!printedLevers.has(label)) {
        printedLevers.add(label);
        note(`asmlift: [lever] ${label} threw (no candidate from it): ${error}`);
      }
    }
  };

  // ENUMERATE-ONLY, and also the pre-count the size guard needs. Skipped under `--force`, which
  // has already answered the question the count would ask — enumeration on the rows this guard
  // exists for is itself the expensive part.
  if (o.enumerateOnly || !o.force) {
    // GUARDED, because `enumerateCandidates` has no annotate mode: the gap the phase-1 pass above
    // turns into an `ASMLIFT_ERROR` marker is a THROW here, and 233 of the corpus's 1,035 rows
    // publish `declined` on exactly such a gap — the very rows `attribute-function.md` sends a
    // round here to read.
    let cands: Candidate[];
    try {
      cands = enumerateRanked(c.sym, asm, c.toolchain.targetDesc, withLevers);
    } catch (e) {
      printLevers();
      return noFanWithDiff(e);
    }
    printLevers();
    if (o.enumerateOnly) {
      console.log(cands.map((cand) => `asmlift: [candidate] ${cand.label}`).join('\n'));
      console.log(`asmlift: [fan] ${cands.length} candidate(s) enumerated, none scored (--enumerate)`);
      printFanDiff(cands.length);
      if (o.show) {
        const picked = pickCandidate(cands, o.show);
        if (!picked) {
          note(`no candidate labelled ${JSON.stringify(o.show)} — see the [candidate] lines above`);
          return 2;
        }
        console.log(showSource(picked.label, picked.source));
      }
      return exitOk();
    }
    if (cands.length > FAN_SCORE_LIMIT) {
      note(
        `${c.id} enumerates ${cands.length} candidates — over the ${FAN_SCORE_LIMIT} this command will ` +
          `compile without being told to. That is a compile each: ${estimatedScoreTime(cands.length, c.tier)} ` +
          `at this machine's measured cold rate for the ${c.tier} tier ` +
          `(${SCORE_SECONDS_PER_CANDIDATE[c.tier] * 1000} ms/candidate, and several times faster warm). ` +
          `Re-run with --enumerate for the labels and sources without ` +
          `compiling, or --force to score them all.`,
      );
      // …and the comparison anyway: the row this refusal fires on is exactly the row whose fan
      // multiplier is worth knowing, and nothing was compiled to learn it.
      printFanDiff(cands.length);
      return 2;
    }
  }

  // …and the scoring pass, through the harness's own driver. GUARDED for the same reason as the
  // enumeration and a different failure: `rankBy` throws when EVERY candidate was refused, which
  // is what the corpus's four `noncompile` rows are — and the drop list it throws with is that
  // row's entire fan, i.e. precisely what a reader came here for.
  let ranked: RankedResult;
  try {
    ranked = asmliftFan(c.toolchain, c.sym, asm, obj, {
      ...withLevers,
      onProgress: (done, total, bestSoFar) => {
        const every = Math.max(1, Math.floor(total / 10));
        if (done === 1 || done === total || done % every === 0) {
          const best = bestSoFar === undefined ? '' : `, best so far ${scoreOf(bestSoFar)}`;
          note(`asmlift: [progress] ${done}/${total} candidates scored${best}`);
        }
      },
    });
  } catch (e) {
    printLevers();
    return noFanWithDiff(e);
  }
  printLevers();
  console.log(renderFan(ranked, { synthesized: synthesizedRefs(c.tier, ranked.best), stamp: stampFrom(treeBefore) }));
  // `fanSize`, not `candidates.length`: the recorded count this is compared against is the whole
  // fan, refusals included, and comparing the published half against the whole would report a
  // shrink on any row that dropped a spelling.
  printFanDiff(fanSize(ranked));
  if (o.show) {
    const picked = pickCandidate(ranked.candidates, o.show);
    if (!picked) {
      note(unshowable(o.show, ranked));
      return 2;
    }
    console.log(showSource(picked.label, picked.source));
  }
  return exitOk();
}
