// `pnpm bench fan <row>` — the candidate fan the harness ALREADY computes for one row, printed
// instead of discarded.
//
// `eval/asmlift.ts` ranks every candidate spelling and then publishes four facts out of the
// result: the winner's label, the winner's source, the dropped list and the withheld list.
// `RankedResult.candidates` — every OTHER spelling, each carrying its own label, its score and
// the exact source it was scored from — is computed, paid for, and dropped on the floor. Six
// consecutive rounds hand-wrote the same ~25-line script to recompute it. This is that script,
// with a row id instead of a hard-coded symbol.
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
import { declaredBlock } from '@asmlift/cli/declare';
import { bakedBuild, sampleSourceTree, sourceStamp } from '@asmlift/cli/provenance';
import type { RankedCandidate, RankedResult } from '@asmlift/cli/rank';
import { enumerateRanked } from '@asmlift/cli/rank';
import { rankedSummaryLine, scoreOf } from '@asmlift/cli/score-format';
import type { SymbolRef } from '@asmlift/core/l3/symbol-refs';
import { decompile } from '@asmlift/core/pipeline';
import type { Candidate, DroppedCandidate, WithheldCandidate } from '@asmlift/core/rank';
import { NoScorableCandidateError } from '@asmlift/core/rank';

import { scrubObjectHeader } from '../asm-scrub';
import { realCases } from '../cases/real';
import { syntheticCases } from '../cases/synthetic';
import type { Case } from '../cases/types';
import { asmliftFan, rankOptionsFor } from '../eval/asmlift';

/** How many candidates this command will COMPILE before refusing without `--force`.
 *
 *  The scope guard, and it is not decorative: a fan is a product over enumeration axes, so row
 *  sizes are not on ONE scale. `synthetic:sizebound:agbcc` enumerates 800 and scores them here in
 *  **48 s cold, 10 s once the candidate cache holds them** (both measured on this machine) — a
 *  fine price for a diagnostic, and the limit has to sit well above it or the command refuses the
 *  very rows it exists for. At the cold rate this limit is about two minutes, and the refusal says
 *  so with the row's own count rather than a fixed scare sentence (`SCORE_SECONDS_PER_CANDIDATE`).
 *  `LoadBGTilemapData` enumerates 225,792 (docs/ranked-repro.md); the same rate puts its fan at
 *  nearly FOUR HOURS, which is a run a round starts on purpose or not at all.
 *
 *  A one-row diagnostic that can silently become an overnight job is a trap, and the cheap answer
 *  — `--enumerate`, which compiles nothing and still prints every label and, with `--show`, any
 *  candidate's source — is one flag away. It is CHEAP RELATIVE TO COMPILING and not cheap
 *  absolutely: enumeration ran at 128 candidates/s on `kleod:CountCollectedGems:agbcc` (5,952 in
 *  46 s), so LBG's fan is ~30 minutes to merely LIST — and this guard is checked after the
 *  pre-count enumeration, so the refusal itself pays that. Both prices are stated where they are
 *  paid rather than promised away. */
export const FAN_SCORE_LIMIT = 2000;

/** Seconds per candidate on the SCORING path — a compile plus an objdiff alignment — from the
 *  slowest cold measurement on this machine: `synthetic:sizebound:agbcc`, 800 candidates in 47.9 s
 *  with `ASMLIFT_CANDCACHE=0`. (`kleod:SetupBG3WindowOverlay`'s 1,024 ran at ~29 ms each, so this
 *  is the pessimistic end; a warm candidate cache is ~5x faster again.)
 *
 *  It exists to make the refusal QUOTE A PRICE rather than assert one: the sentence this replaces
 *  said a fan over the limit is "well over an hour" while the constant's own doc-comment two
 *  screens up said two and a half minutes, and the second one was right. A reader who is steered
 *  off `--force` by a number that is wrong by 20x loses the answer the command exists to give. */
export const SCORE_SECONDS_PER_CANDIDATE = 0.06;

/** The price of scoring `n` candidates, rounded to a unit a reader can act on. Never a bare
 *  second-count above a minute: the decision this informs is "do I start this now", and 357 s is a
 *  number one has to divide before it means anything. */
export function estimatedScoreTime(n: number): string {
  const seconds = n * SCORE_SECONDS_PER_CANDIDATE;
  if (seconds < 90) {
    return `about ${Math.max(1, Math.round(seconds))} s`;
  }
  const minutes = seconds / 60;
  return minutes < 90 ? `about ${Math.round(minutes)} min` : `about ${(minutes / 60).toFixed(1)} h`;
}

export interface FanOptions {
  /** print this candidate's SOURCE (its label, or `best`) after the table */
  show?: string;
  /** List the fan without compiling anything. Cheap against the scoring pass and not free:
   *  enumeration ran at 128 candidates/s here (`kleod:CountCollectedGems:agbcc`, 5,952 in 46 s),
   *  so the biggest fans take minutes to merely list. */
  enumerateOnly?: boolean;
  /** score a fan larger than FAN_SCORE_LIMIT anyway */
  force?: boolean;
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
 *  There is one, and it was shipped working: `--enumerate --show best` printed `candidate
 *  unsigned` on `synthetic:sizebound:agbcc`, whose real winner scores 8/81 while `unsigned` is
 *  near the bottom of the same fan. Nothing had been scored, so `best` resolved to whatever
 *  enumeration emitted first — a near-worst spelling, presented under the name of the winner, to a
 *  round that both briefs had told `--show best` is the winner and `--enumerate` still serves
 *  `--show`. A wrong answer in the shape of a right one is worse than a refusal. */
export function optionRefusal(o: FanOptions): string | undefined {
  if (o.enumerateOnly && o.show === 'best') {
    return (
      `--show best names the WINNER and --enumerate scores nothing, so there is no winner to name ` +
      `(an enumerated fan is in enumeration order, not score order). Drop --enumerate to score the ` +
      `fan and get a real best, or pass --show <label> for a spelling you can name.`
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
 *  never a Node stack trace.
 *
 *  Both of the ranked path's calls can throw, and each throw is a fact about the ROW rather than a
 *  harness defect: enumeration throws on the unmodelled construct that made the row `declined`
 *  (233 rows), and scoring throws when every spelling failed to compile (the 4 `noncompile` rows).
 *  Shipped unguarded, both printed a stack trace and exited 1 — indistinguishable, to a script or
 *  a fresh agent, from the harness being broken, which is exactly the reading that sends a round
 *  back to the hand-written script this command replaced.
 *
 *  On the scoring failure the DROP LIST is printed in full: `rankBy` has no result to return, so
 *  those lines are the whole fan, and the one line the exception itself carries is the LAST
 *  spelling refused — neither the first nor a representative one. */
function noFan(c: Case, e: unknown, phase: 'enumerating' | 'scoring'): number {
  const dropped = e instanceof NoScorableCandidateError ? e.dropped : [];
  const withheld = e instanceof NoScorableCandidateError ? e.withheld : [];
  if (dropped.length > 0 || withheld.length > 0) {
    console.log([...dropped.map(dropLine), ...withheld.map(withheldLine)].join('\n'));
  }
  const first = ((e as Error).message ?? String(e)).split('\n')[0];
  note(`asmlift: [fan] no fan for ${c.id}: ${phase} threw — ${first}`);
  note(
    phase === 'enumerating'
      ? `asmlift: [fan] the gap named above is the one this row DECLINES on: enumeration has no ` +
          `annotate mode, so it throws where the published row gets an ASMLIFT_ERROR marker. Close ` +
          `the gap and the fan exists; until then there is nothing to score.`
      : `asmlift: [fan] every candidate was refused, so there is no ranking — the ${dropped.length} ` +
          `[dropped] line(s) above ARE this row's fan. This is what the published row's ` +
          `"noncompile" outcome means.`,
  );
  return 2;
}

/** `--show <label>` on a label that IS in the fan but carries no scored source. A dropped
 *  candidate never compiled and a withheld one was refused publication; neither is in
 *  `[score]`, so "see the [score] lines above" sends the reader to look for a line that will
 *  never be there. `--enumerate` carries every candidate's source, including these, and is the
 *  answer — the source of the spelling that FAILED to compile is usually the one worth reading. */
export function unshowable(label: string, ranked: RankedResult): string {
  const where = ranked.dropped.some((d) => d.label === label)
    ? 'was dropped (it did not compile), so it has no scored source'
    : ranked.withheld.some((w) => w.label === label)
      ? 'was withheld (it scored but is unpublishable), so it is not in the [score] table'
      : undefined;
  return where === undefined
    ? `no candidate labelled ${JSON.stringify(label)} — see the [score] lines above`
    : `${JSON.stringify(label)} ${where}. Its source is still readable: re-run with --enumerate --show ${label}`;
}

export function fan(rowId: string, o: FanOptions = {}): number {
  const refusal = optionRefusal(o);
  if (refusal !== undefined) {
    note(refusal);
    return 2;
  }
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

  // The runner's own build, header scrub included: the disassembly asmlift sees must be the bytes
  // the row was measured from, and the scrub is part of them — through `scrubObjectHeader`, the
  // one spelling the runner and the evaluator use, so this command cannot drift from the run it
  // claims to reproduce.
  const { obj, asm: raw } = c.build();
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
  const withLevers = {
    ...opts,
    onLeverError: (label: string, error: string) => leverErrors.set(label, error.split('\n')[0]),
  };
  // ONCE PER LABEL. Both the pre-count enumeration and the scoring pass enumerate, and each
  // re-runs every lever, so a lever that throws throws twice — reported twice, it reads as two
  // broken levers.
  const printedLevers = new Set<string>();
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
    // publish `declined` on exactly such a gap. Unguarded, this command printed "the fan below is
    // what WOULD be scored" and then a Node stack trace with no fan below it — on the very rows
    // `attribute-function.md` sends a round here to read.
    let cands: Candidate[];
    try {
      cands = enumerateRanked(c.sym, asm, c.toolchain.targetDesc, withLevers);
    } catch (e) {
      printLevers();
      return noFan(c, e, 'enumerating');
    }
    printLevers();
    if (o.enumerateOnly) {
      console.log(cands.map((cand) => `asmlift: [candidate] ${cand.label}`).join('\n'));
      console.log(`asmlift: [fan] ${cands.length} candidate(s) enumerated, none scored (--enumerate)`);
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
    if (cands.length > FAN_SCORE_LIMIT) {
      note(
        `${c.id} enumerates ${cands.length} candidates — over the ${FAN_SCORE_LIMIT} this command will ` +
          `compile without being told to. That is a compile each: ${estimatedScoreTime(cands.length)} at ` +
          `this machine's measured cold rate (${SCORE_SECONDS_PER_CANDIDATE * 1000} ms/candidate, and ` +
          `several times faster warm). Re-run with --enumerate for the labels and sources without ` +
          `compiling, or --force to score them all.`,
      );
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
    return noFan(c, e, 'scoring');
  }
  printLevers();
  console.log(renderFan(ranked, { synthesized: synthesizedRefs(c.tier, ranked.best), stamp: stampFrom(treeBefore) }));
  if (o.show) {
    const picked = pickCandidate(ranked.candidates, o.show);
    if (!picked) {
      note(unshowable(o.show, ranked));
      return 2;
    }
    console.log(showSource(picked.label, picked.source));
  }
  return 0;
}
