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
  type VariationTally,
  parseVariation,
  variationToken,
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

/** Past this many candidates a row's fan size is shown in the Function Explorer; at or below it the
 *  cell stays blank. The column is sparse on purpose: a few rows hold most of the candidates, and a
 *  number on every row would read as a ranking of rows that the fan's size is not. */
export const FAN_CHIP_FLOOR = 100;

/** A row's fan size when the Function Explorer shows it, null when the cell is blank. */
export function fanChip(row: FunctionResult): number | null {
  const n = row.asmlift.fanSize;
  return n !== undefined && n > FAN_CHIP_FLOOR ? n : null;
}

/** The Function Explorer's fan-column order. Blank cells sort last in BOTH directions, by symbol:
 *  a sparse column sorted ascending would otherwise open on hundreds of blank rows. */
export function compareFanChip(a: FunctionResult, b: FunctionResult, dir: 1 | -1): number {
  const av = fanChip(a);
  const bv = fanChip(b);
  if (av === null || bv === null) {
    return av === bv ? a.sym.localeCompare(b.sym) : av === null ? 1 : -1;
  }
  return (av - bv) * dir || a.sym.localeCompare(b.sym);
}

/** `440`, `8.4k`, `27k`: a table chip has room for about four characters. */
export function compactCount(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  return n < 9_950 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(n / 1000)}k`;
}

/** Items of one variation kind, in a list grouped by kind. */
export interface KindGroup<T> {
  kind: VariationKind;
  items: T[];
}

/** `items` grouped by kind, in `VARIATION_KINDS` order, with no empty group; each group keeps the
 *  order `items` came in. */
function groupByKind<T extends { name: VariationName }>(items: readonly T[]): KindGroup<T>[] {
  return VARIATION_KINDS.map((kind) => ({
    kind,
    items: items.filter((it) => variationToken(it.name).variationKind === kind),
  })).filter((g) => g.items.length > 0);
}

/** One part of the winner's variations, as published, with this row's fan tally for its name. */
export interface SpellingPart {
  part: string;
  name: VariationName;
  subject?: string;
  /** absent when the artifact did not record the row's fan */
  tally?: VariationTally;
}

/** The winning spelling: the winner's variations grouped by kind, each kind in the order the winner
 *  applied them. Empty when the row has no winner. */
export function winningSpelling(row: FunctionResult): KindGroup<SpellingPart>[] {
  const parts = (row.asmlift.winnerVariations ?? []).map((part) => {
    const { name, subject } = parseVariation(part);
    return { part, name, subject, tally: row.asmlift.fanVariations?.[name] };
  });
  return groupByKind(parts);
}

/** A variation the row's fan carried and its winner does not. */
export interface LostVariation {
  name: VariationName;
  tally: VariationTally;
}

/** What the row considered and lost: every variation its fan carried that the winner does not,
 *  grouped by kind, most candidates first. On a row with no winner that is every variation the fan
 *  carried. Null when the artifact did not record the row's fan, which is not the same as nothing
 *  lost. */
export function consideredButLost(row: FunctionResult): KindGroup<LostVariation>[] | null {
  const roster = row.asmlift.fanVariations;
  if (!roster) {
    return null;
  }
  const won = winnerNames(row);
  const lost = Object.entries(roster)
    .map(([key, tally]) => ({ name: parseVariation(key).name, tally }))
    .filter((v) => !won.has(v.name))
    .sort((a, b) => b.tally.candidates - a.tally.candidates || (a.name < b.name ? -1 : 1));
  return groupByKind(lost);
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
