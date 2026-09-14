// Everything the Fan Explorer derives from the published artifact, in one pure module: per-variation
// totals for the catalogue and the charts, and the row list of one variation's drawer.
//
// ONE SOURCE FOR EVERY NUMBER. The catalogue, both charts and the drawer read the same rows through
// the functions below, so a variation cannot read "no win" in a chart and "12 rows" in the drawer it
// opens. Two fields feed them:
//   • `winnerVariations` says what the WINNER carries — a win.
//   • `fanVariations` says what the whole FAN carried, with how many candidates carried each — the
//     cost, and the denominator a win rate needs.
// A variation the fan carried and the winner does not is one the row considered and lost.
//
// A TALLY, NEVER A FACTORISATION. Enumeration gates prune the fan, so per-variation counts do not
// multiply to a fan's size, and nothing here tries to.
import type { FunctionResult } from '@asmlift/bench-schema';
import {
  VARIATION_KINDS,
  VARIATION_TOKENS,
  type VariationKind,
  type VariationName,
  parseVariation,
} from '@asmlift/core/variation-tokens';

export interface VariationStats {
  name: VariationName;
  kind: VariationKind;
  /** rows whose winner carries the variation */
  winners: number;
  /** rows whose fan carried it */
  rows: number;
  /** candidates carrying it, summed over those rows — dropped and withheld included */
  candidates: number;
  /** the refused part of `candidates` */
  dropped: number;
  withheld: number;
  /** distinct toolchains among the rows that carried it or won with it */
  toolchains: number;
}

/** The registered names a row's winner carries, once each: `coalesce-v0-v1` and `coalesce-v2-v3`
 *  are one win for `coalesce`. */
export function winnerNames(row: FunctionResult): Set<VariationName> {
  return new Set((row.asmlift.winnerVariations ?? []).map((part) => parseVariation(part).name));
}

/** Every registered variation's totals over `rows`, zeros included: a variation no row carried is
 *  still an entry, and the catalogue shows its definition. */
export function variationStats(rows: readonly FunctionResult[]): Map<VariationName, VariationStats> {
  const acc = new Map(
    VARIATION_TOKENS.map((t) => [
      t.name,
      {
        name: t.name,
        kind: t.variationKind,
        winners: 0,
        rows: 0,
        candidates: 0,
        dropped: 0,
        withheld: 0,
        toolchainSet: new Set<string>(),
      },
    ]),
  );
  for (const row of rows) {
    for (const name of winnerNames(row)) {
      const e = acc.get(name)!;
      e.winners++;
      e.toolchainSet.add(row.toolchain);
    }
    for (const [key, tally] of Object.entries(row.asmlift.fanVariations ?? {})) {
      const e = acc.get(parseVariation(key).name)!;
      e.rows++;
      e.candidates += tally.candidates;
      e.dropped += tally.dropped ?? 0;
      e.withheld += tally.withheld ?? 0;
      e.toolchainSet.add(row.toolchain);
    }
  }
  return new Map([...acc].map(([name, { toolchainSet, ...e }]) => [name, { ...e, toolchains: toolchainSet.size }]));
}

/** Winners per row whose fan carried the variation; null when no fan carried it. */
export function winRate(s: VariationStats): number | null {
  return s.rows === 0 ? null : s.winners / s.rows;
}

/** Candidates carried per win; null when it never won — which is not infinity, and is never drawn
 *  as one. */
export function pricePerWin(s: VariationStats): number | null {
  return s.winners === 0 ? null : s.candidates / s.winners;
}

/** Ranked by winners, then by reach, then by name, so a kind's list reads as a ranking with no sort
 *  control. */
function byWinners(a: VariationStats, b: VariationStats): number {
  return b.winners - a.winners || b.rows - a.rows || b.candidates - a.candidates || (a.name < b.name ? -1 : 1);
}

export interface CatalogueGroup {
  kind: VariationKind;
  variations: VariationStats[];
}

/** The catalogue: every registered variation, grouped by kind in name order, ranked by winners. */
export function catalogue(stats: Map<VariationName, VariationStats>): CatalogueGroup[] {
  return VARIATION_KINDS.map((kind) => ({
    kind,
    variations: [...stats.values()].filter((s) => s.kind === kind).sort(byWinners),
  }));
}

/** The variations some fan carried — the only ones a cost can be stated for — dearest win first,
 *  with the never-won after them, largest cost first. */
export function priced(stats: Map<VariationName, VariationStats>): VariationStats[] {
  return [...stats.values()]
    .filter((s) => s.rows > 0)
    .sort((a, b) => {
      const pa = pricePerWin(a);
      const pb = pricePerWin(b);
      if ((pa === null) !== (pb === null)) {
        return pa === null ? 1 : -1;
      }
      return (pb ?? 0) - (pa ?? 0) || b.candidates - a.candidates || (a.name < b.name ? -1 : 1);
    });
}

/** What the cost views stand on: the rows that recorded their fan, and the candidates in those fans. */
export function fanCoverage(rows: readonly FunctionResult[]): { rows: number; candidates: number } {
  let n = 0;
  let candidates = 0;
  for (const r of rows) {
    if (r.asmlift.fanVariations) {
      n++;
      candidates += r.asmlift.fanSize ?? 0;
    }
  }
  return { rows: n, candidates };
}

/** One part of a winner's variations, with whether it is the variation being looked at. */
export interface WinnerPart {
  part: string;
  name: VariationName;
  lit: boolean;
}

export interface VariationRow {
  row: FunctionResult;
  /** the winner carries the variation */
  won: boolean;
  /** this row's fan tally for the variation; absent when its fan did not carry it */
  tally?: { candidates: number; dropped?: number; withheld?: number };
  /** the winner's variations, in order, the looked-at one lit; empty when there is no winner */
  winner: WinnerPart[];
}

/** The rows a variation touched — its fan carried it, or its winner does — winners first, then by
 *  how many of the fan's candidates carried it. */
export function rowsFor(rows: readonly FunctionResult[], name: VariationName): VariationRow[] {
  const out: VariationRow[] = [];
  for (const row of rows) {
    const winner = (row.asmlift.winnerVariations ?? []).map((part) => {
      const n = parseVariation(part).name;
      return { part, name: n, lit: n === name };
    });
    const won = winner.some((p) => p.lit);
    const tally = row.asmlift.fanVariations?.[name];
    if (won || tally) {
      out.push({ row, won, tally, winner });
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.won) - Number(a.won) ||
      (b.tally?.candidates ?? 0) - (a.tally?.candidates ?? 0) ||
      a.row.id.localeCompare(b.row.id),
  );
}
