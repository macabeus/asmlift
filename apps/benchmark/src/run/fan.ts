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
import type { RankedCandidate, RankedResult } from '@asmlift/cli/rank';
import { enumerateRanked } from '@asmlift/cli/rank';
import { scoreOf } from '@asmlift/cli/score-format';
import { decompile } from '@asmlift/core/pipeline';
import type { Candidate } from '@asmlift/core/rank';

import { realCases } from '../cases/real';
import { syntheticCases } from '../cases/synthetic';
import type { Case } from '../cases/types';
import { asmliftFan, rankOptionsFor } from '../eval/asmlift';

/** How many candidates this command will COMPILE before refusing without `--force`.
 *
 *  The scope guard, and it is not decorative: a fan is a product over enumeration axes, so row
 *  sizes are not on ONE scale. `synthetic:sizebound:agbcc` enumerates 800 and scores them here in
 *  **57 s cold, 8 s once the candidate cache holds them** (both measured on this machine) — a fine
 *  price for a diagnostic, and the limit has to sit well above it or the command refuses the very
 *  rows it exists for. At the cold rate this limit is about two and a half minutes.
 *  `LoadBGTilemapData` enumerates 225,792 (docs/ranked-repro.md); the same rate puts its fan at
 *  FOUR HOURS, which is a run a round starts on purpose or not at all.
 *
 *  A one-row diagnostic that can silently become an overnight job is a trap, and the cheap answer
 *  — `--enumerate`, which compiles nothing and still prints every label and, with `--show`, any
 *  candidate's source — is one flag away, so the refusal costs seconds and names its own way out. */
export const FAN_SCORE_LIMIT = 2000;

export interface FanOptions {
  /** print this candidate's SOURCE (its label, or `best`) after the table */
  show?: string;
  /** list the fan without compiling anything — the whole command in seconds, at any fan size */
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

/** The whole scored fan: every candidate, then the two refusal lists, then the summary line.
 *
 *  `dropped` and `withheld` are printed IN FULL here, where the CLI prints a count plus the first
 *  one. The CLI's line is a footnote under a score a user is reading; this command is the one
 *  place whose entire purpose is the fan, and "3 candidates failed to score; first: …" is exactly
 *  the shape that sent rounds back to a hand-written script. */
export function renderFan(ranked: RankedResult): string {
  const lines = ranked.candidates.map(scoreLine);
  for (const d of ranked.dropped) {
    lines.push(`asmlift: [dropped] ${d.label}: ${d.error.split('\n')[0]}`);
  }
  for (const w of ranked.withheld) {
    lines.push(`asmlift: [withheld] ${w.label} at ${scoreOf(w)}: ${w.why}`);
  }
  lines.push(
    `asmlift: [ranked] ${ranked.candidates.length} candidate(s) scored, ${ranked.dropped.length} dropped, ` +
      `${ranked.withheld.length} withheld, best ${ranked.best.label}: ${scoreOf(ranked.best.score)}`,
  );
  return lines.join('\n');
}

/** `--show`: the named candidate, or the winner under the reserved name `best`. Undefined ⇒ the
 *  caller lists what there was, because a typo'd label and a lever that produced no candidate at
 *  all are the same silence otherwise. */
export function pickCandidate<C extends Candidate>(candidates: C[], label: string): C | undefined {
  if (label === 'best') {
    return candidates[0];
  }
  return candidates.find((c) => c.label === label);
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

export function fan(rowId: string, o: FanOptions = {}): number {
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
  // the row was measured from, and the scrub is part of them (runner.ts).
  const { obj, asm: raw } = c.build();
  const asm = raw.replace(/^\/\S+\.o:/m, 'target.o:');
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
        `asmlift: [declined] this row publishes outcome "declined" — the fan below is what WOULD ` +
          `be scored if the gap(s) above closed`,
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
  const printLevers = (): void => {
    for (const [label, error] of leverErrors) {
      note(`asmlift: [lever] ${label} threw (no candidate from it): ${error}`);
    }
  };

  // ENUMERATE-ONLY, and also the pre-count the size guard needs. Skipped under `--force`, which
  // has already answered the question the count would ask — enumeration on the rows this guard
  // exists for is itself the expensive part.
  if (o.enumerateOnly || !o.force) {
    const cands = enumerateRanked(c.sym, asm, c.toolchain.targetDesc, withLevers);
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
          `compile — a compile each, and at this machine's measured rate that is well over an hour. ` +
          `Re-run with ` +
          `--enumerate for the labels and sources without compiling, or --force to score them all.`,
      );
      return 2;
    }
  }

  // …and the scoring pass, through the harness's own driver.
  const ranked = asmliftFan(c.toolchain, c.sym, asm, obj, {
    ...withLevers,
    onProgress: (done, total, bestSoFar) => {
      const every = Math.max(1, Math.floor(total / 10));
      if (done === 1 || done === total || done % every === 0) {
        const best = bestSoFar === undefined ? '' : `, best so far ${scoreOf(bestSoFar)}`;
        note(`asmlift: [progress] ${done}/${total} candidates scored${best}`);
      }
    },
  });
  printLevers();
  console.log(renderFan(ranked));
  if (o.show) {
    const picked = pickCandidate(ranked.candidates, o.show);
    if (!picked) {
      note(`no candidate labelled ${JSON.stringify(o.show)} — see the [score] lines above`);
      return 2;
    }
    console.log(showSource(picked.label, picked.source));
  }
  return 0;
}
