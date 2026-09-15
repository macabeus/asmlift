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
// ONE POPULATION: the rows whose fan was counted. A win is counted only on a row whose fan carried
// the variation, so a win rate cannot exceed one and a price per win never divides one set of rows'
// cost by another set's wins. The producer writes `fanVariations` on every row it ranks, and a
// winner's names are always keys of it (`apps/benchmark/test/fan-price.test.ts`).
//
// A TALLY, NEVER A FACTORISATION. Enumeration gates prune the fan, so per-variation counts do not
// multiply to a fan's size, and nothing here tries to.
//
// PRICED PER OPTIMISATION LEVEL. A variation that wins at -O2 can cost the same and never win at -O1,
// so the rows are partitioned by the level the compiler acts on, read off each row's flags through
// core, and `variationStats` runs on each partition: a level's win rate and price per win never
// divide one level's cost by another level's wins.
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

import { rowLevel } from './flags';

export interface VariationStats {
  name: VariationName;
  kind: VariationKind;
  /** rows whose fan carried the variation */
  rows: number;
  /** those rows whose winner carries it */
  winners: number;
  /** candidates carrying it, summed over those rows — dropped and withheld included */
  candidates: number;
  /** the refused part of `candidates` */
  dropped: number;
  withheld: number;
  /** distinct toolchains among those rows */
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
    const won = winnerNames(row);
    for (const [key, tally] of Object.entries(row.asmlift.fanVariations ?? {})) {
      const name = parseVariation(key).name;
      const e = acc.get(name)!;
      e.rows++;
      if (won.has(name)) {
        e.winners++;
      }
      e.candidates += tally.candidates;
      e.dropped += tally.dropped ?? 0;
      e.withheld += tally.withheld ?? 0;
      e.toolchainSet.add(row.toolchain);
    }
  }
  return new Map([...acc].map(([name, { toolchainSet, ...e }]) => [name, { ...e, toolchains: toolchainSet.size }]));
}

/** The share of the rows whose fan carried the variation that won with it; null when no fan
 *  carried it. */
export function winRate(s: VariationStats): number | null {
  return s.rows === 0 ? null : s.winners / s.rows;
}

/** Candidates carried per win; null when it never won (no fan carrying it included) — which is not
 *  infinity, and is never drawn as one. */
export function pricePerWin(s: VariationStats): number | null {
  return s.winners === 0 ? null : s.candidates / s.winners;
}

/** Ranked by winners, then by rows, then by candidates, then by name, so a kind's list reads as a
 *  ranking with no sort control. */
function byWinners(a: VariationStats, b: VariationStats): number {
  return b.winners - a.winners || b.rows - a.rows || b.candidates - a.candidates || (a.name < b.name ? -1 : 1);
}

export interface CatalogueGroup {
  kind: VariationKind;
  variations: VariationStats[];
}

/** The catalogue: every registered variation, grouped by kind in kind order, ranked by winners. */
export function catalogue(stats: Map<VariationName, VariationStats>): CatalogueGroup[] {
  return VARIATION_KINDS.map((kind) => ({
    kind,
    variations: [...stats.values()].filter((s) => s.kind === kind).sort(byWinners),
  }));
}

/** A variation that won, with its price per win. */
export interface PricedVariation extends VariationStats {
  price: number;
}

/** The variations some fan carried — the only ones a cost can be stated for — split in two: those
 *  that won, dearest win first, and those that never won, largest cost first, which have no price. */
export function priced(stats: Map<VariationName, VariationStats>): {
  won: PricedVariation[];
  neverWon: VariationStats[];
} {
  const carried = [...stats.values()].filter((s) => s.rows > 0);
  const byName = (a: VariationStats, b: VariationStats) => (a.name < b.name ? -1 : 1);
  const won = carried
    .flatMap((s) => {
      const price = pricePerWin(s);
      return price === null ? [] : [{ ...s, price }];
    })
    .sort((a, b) => b.price - a.price || b.candidates - a.candidates || byName(a, b));
  const neverWon = carried.filter((s) => s.winners === 0).sort((a, b) => b.candidates - a.candidates || byName(a, b));
  return { won, neverWon };
}

/** What the cost views stand on: the rows whose fan was counted, and the candidates in those fans. */
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

/** The bucket of a row whose flags name no level, in a family with no measured default. */
export const NO_LEVEL = 'no level';

/** The optimisation level a row's fan is priced at: the one the compiler acts on (IDO `-O2 -g` is
 *  `-O1`). A level several families spell alike, such as `-O2` on agbcc, IDO and KMC gcc, is one bucket. */
export function fanLevel(row: FunctionResult): string {
  return rowLevel(row) ?? NO_LEVEL;
}

/** One optimisation level's part of the fan. */
export interface LevelStats {
  level: string;
  /** the level's rows whose fan was counted, and the candidates in those fans */
  coverage: { rows: number; candidates: number };
  /** those rows per toolchain, most first: one entry per distinct toolchain */
  toolchainRows: { toolchain: string; rows: number }[];
  /** `variationStats` over those rows alone */
  stats: Map<VariationName, VariationStats>;
}

/** The rows whose fan was counted, partitioned by level: most counted rows first, then by level. */
export function levelStats(rows: readonly FunctionResult[]): LevelStats[] {
  const byLevel = new Map<string, FunctionResult[]>();
  for (const row of rows) {
    if (!row.asmlift.fanVariations) {
      continue;
    }
    const level = fanLevel(row);
    const bucket = byLevel.get(level) ?? [];
    byLevel.set(level, bucket);
    bucket.push(row);
  }
  return [...byLevel]
    .map(([level, levelRows]) => ({
      level,
      coverage: fanCoverage(levelRows),
      toolchainRows: rowsByToolchain(levelRows),
      stats: variationStats(levelRows),
    }))
    .sort((a, b) => b.coverage.rows - a.coverage.rows || (a.level < b.level ? -1 : 1));
}

/** Rows per toolchain, most first, then by name. */
function rowsByToolchain(rows: readonly FunctionResult[]): { toolchain: string; rows: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.toolchain, (counts.get(r.toolchain) ?? 0) + 1);
  }
  return [...counts]
    .map(([toolchain, n]) => ({ toolchain, rows: n }))
    .sort((a, b) => b.rows - a.rows || (a.toolchain < b.toolchain ? -1 : 1));
}

/** One variation at each level whose fans carried it. */
export function variationLevels(
  levels: readonly LevelStats[],
  name: VariationName,
): { level: string; s: VariationStats }[] {
  return levels.flatMap((l) => {
    const s = l.stats.get(name)!;
    return s.rows > 0 ? [{ level: l.level, s }] : [];
  });
}

/** Up to this many toolchains, a level names each with its rows; past it, it counts them. */
const NAMED_TOOLCHAINS = 3;

/** A level's toolchains: `gcc2.7.2 ×23, agbcc ×1`, or `4 toolchains`. A level several compilers share is
 *  read with them named, since a price at one level can be one compiler's price. */
export function levelToolchains(l: LevelStats): string {
  return l.toolchainRows.length <= NAMED_TOOLCHAINS
    ? l.toolchainRows.map((t) => `${t.toolchain} ×${t.rows}`).join(', ')
    : plural(l.toolchainRows.length, 'toolchain');
}

/** `1 row`, `3 rows`. */
export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** One variation at one level, in a catalogue line: `-O2 · 2 toolchains · 11 wins over 212 rows · 38
 *  candidates per win`, the price left out when it never won there. */
export function levelLine(level: string, s: VariationStats): string {
  const price = pricePerWin(s);
  return [
    level,
    plural(s.toolchains, 'toolchain'),
    `${plural(s.winners, 'win')} over ${plural(s.rows, 'row')}`,
    ...(price === null ? [] : [`${Math.round(price).toLocaleString()} candidates per win`]),
  ].join(' · ');
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
  tally: VariationTally;
}

/** The winning spelling: the winner's variations grouped by kind, each kind in the order the winner
 *  applied them. Empty when the row has no winner, or when its fan was not counted: the spelling is
 *  part of the fan's account, and a winner's names are always keys of its fan's tally. */
export function winningSpelling(row: FunctionResult): KindGroup<SpellingPart>[] {
  const roster = row.asmlift.fanVariations;
  if (!roster) {
    return [];
  }
  const parts = (row.asmlift.winnerVariations ?? []).map((part) => {
    const { name, subject } = parseVariation(part);
    return { part, name, subject, tally: roster[name] };
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
 *  carried. */
export function consideredButLost(row: FunctionResult): KindGroup<LostVariation>[] {
  const won = winnerNames(row);
  const lost = Object.entries(row.asmlift.fanVariations ?? {})
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
  /** this row's fan tally for the variation */
  tally: VariationTally;
  /** the winner's variations, in order, the looked-at one lit; empty when there is no winner */
  winner: WinnerPart[];
}

/** The rows whose fan carried a variation — the population `variationStats` counts — winners first,
 *  then by how many of the fan's candidates carried it. */
export function rowsFor(rows: readonly FunctionResult[], name: VariationName): VariationRow[] {
  const out: VariationRow[] = [];
  for (const row of rows) {
    const tally = row.asmlift.fanVariations?.[name];
    if (!tally) {
      continue;
    }
    const winner = (row.asmlift.winnerVariations ?? []).map((part) => {
      const n = parseVariation(part).name;
      return { part, name: n, lit: n === name };
    });
    out.push({ row, won: winner.some((p) => p.lit), tally, winner });
  }
  return out.sort(
    (a, b) =>
      Number(b.won) - Number(a.won) || b.tally.candidates - a.tally.candidates || a.row.id.localeCompare(b.row.id),
  );
}
