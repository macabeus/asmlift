// A row's compiler flags as the benchmark pages show them: the words the compiler acts on, the build's
// own spelling with every overridden word marked, where the flags came from, and how the row's profile
// differs from the one most of its project's rows share, said in the build's words. The level is read
// through core, per row, as a feature tag is: no artifact field stores it.
import type { FunctionResult } from '@asmlift/bench-schema';
import { type CodegenProfile, optLevel, parseFlags, profileKey, shellJoinFlags } from '@asmlift/core/codegen-flags';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';

export function rowProfile(row: FunctionResult): CodegenProfile {
  return parseFlags(TOOLCHAIN_TARGETS[row.toolchain].family, row.cflags);
}

/** The optimisation level the compiler acts on (`-O2`, `-O4,p`; IDO `-O2 -g` is `-O1`), or null when
 *  the flags name none and the family has no measured default. */
export function rowLevel(row: FunctionResult): string | null {
  return optLevel(TOOLCHAIN_TARGETS[row.toolchain].family, row.cflags);
}

/** The profile most of a project's rows of one toolchain compile at, and how many do. */
export interface ProjectProfile {
  profile: CodegenProfile;
  rows: number;
  /** the project's rows of that toolchain */
  of: number;
}

const peerKey = (row: FunctionResult) => `${row.project}:${row.toolchain}`;

/** For every project and toolchain of the real tier, the profile most of its rows share; a tie goes to
 *  the profile whose key sorts first, so the choice does not depend on row order. */
export function projectProfiles(rows: readonly FunctionResult[]): Map<string, ProjectProfile> {
  const counts = new Map<string, Map<string, { profile: CodegenProfile; rows: number }>>();
  for (const row of rows) {
    if (row.tier !== 'real') {
      continue;
    }
    const profile = rowProfile(row);
    const key = profileKey(profile);
    const byProfile = counts.get(peerKey(row)) ?? new Map();
    counts.set(peerKey(row), byProfile);
    byProfile.set(key, { profile, rows: (byProfile.get(key)?.rows ?? 0) + 1 });
  }
  const out = new Map<string, ProjectProfile>();
  for (const [peer, byProfile] of counts) {
    const ranked = [...byProfile].sort(([ka, a], [kb, b]) => b.rows - a.rows || (ka < kb ? -1 : 1));
    const of = ranked.reduce((n, [, e]) => n + e.rows, 0);
    out.set(peer, { profile: ranked[0][1].profile, rows: ranked[0][1].rows, of });
  }
  return out;
}

/** The profile a row is compared with: its project's, for a real row of a project with other rows of
 *  its toolchain. A synthetic row compiles at its toolchain's canonical flags and has no project build. */
export function peerProfile(profiles: ReadonlyMap<string, ProjectProfile>, row: FunctionResult): ProjectProfile | null {
  const peer = row.tier === 'real' ? profiles.get(peerKey(row)) : undefined;
  return peer && peer.of > 1 ? peer : null;
}

/** A slot in the build's words. The level is the one the compiler acts on, which a word can imply
 *  without spelling it (IDO `-O2 -g`). */
const words = (p: CodegenProfile, slot: string): string =>
  slot === 'O' ? `-O${p.slots.O}` : (p.spelled[slot] ?? `${slot} ${p.slots[slot]}`);

const levelFirst = (a: string, b: string) => (a === 'O' ? -1 : b === 'O' ? 1 : a < b ? -1 : a > b ? 1 : 0);

/** What `to` spells differently from `from`, in the build's words: a changed slot as `old → new`, a
 *  word only `to` has as `+word`, one only `from` has as `no word`. The level comes first, unless
 *  `withLevel` is false. */
export function profileChanges(from: CodegenProfile, to: CodegenProfile, { withLevel = true } = {}): string[] {
  const out: string[] = [];
  for (const s of [...new Set([...Object.keys(from.slots), ...Object.keys(to.slots)])].sort(levelFirst)) {
    if (from.slots[s] === to.slots[s] || (s === 'O' && !withLevel)) {
      continue;
    }
    out.push(
      !(s in from.slots)
        ? `+${words(to, s)}`
        : !(s in to.slots)
          ? `no ${words(from, s)}`
          : `${words(from, s)} → ${words(to, s)}`,
    );
  }
  const fromWords = new Set(from.unclassified);
  const toWords = new Set(to.unclassified);
  out.push(...to.unclassified.filter((w) => !fromWords.has(w)).map((w) => `+${w}`));
  out.push(...from.unclassified.filter((w) => !toWords.has(w)).map((w) => `no ${w}`));
  if (out.length === 0 && withLevel && profileKey(from) !== profileKey(to)) {
    out.push('the same words in another order');
  }
  return out;
}

/** One flag word as the page prints it: quoted only where the shell needs it (`'cats off'`). */
export interface FlagWord {
  text: string;
  /** a later word overrides or repeats it, so the compiler does not act on it */
  overridden: boolean;
}

/** Words that never wrap apart: an option and its arguments (`-inline auto`, `-pragma 'cats off'`,
 *  `-str reuse, readonly`), as core spans them. */
export type FlagGroup = FlagWord[];

function groupWords(argv: readonly string[], profile: CodegenProfile): FlagGroup[] {
  const overridden = new Set(profile.overriddenAt);
  return profile.spans.map((span) =>
    span.map((k) => ({ text: shellJoinFlags([argv[k]]), overridden: overridden.has(k) })),
  );
}

/** Where a row's flags came from. */
export type FlagsSource =
  | { kind: 'canonical'; label: string }
  /** `label` names the build file at its commit; `derivation` is the recipe line or the dtk unit it was
   *  read off; `unit` is the source file the function compiles in */
  | { kind: 'build'; label: string; derivation: string; unit: string };

export function flagsSource(row: FunctionResult): FlagsSource {
  if (row.tier === 'synthetic') {
    return { kind: 'canonical', label: `${row.toolchain}'s canonical flags` };
  }
  const from = row.flagsFrom;
  return {
    kind: 'build',
    label: `${from.file} @ ${from.commit.slice(0, 8)}`,
    derivation: from.from === 'makefile' ? from.command : `objdiff.json unit ${from.unit}`,
    unit: row.unit,
  };
}

export interface RowFlags {
  level: string | null;
  /** the build's own words, grouped, every overridden word marked */
  raw: FlagGroup[];
  /** the words the compiler acts on, grouped, in build order */
  effective: FlagGroup[];
  /** some word is overridden, so the raw and effective views differ */
  hasOverrides: boolean;
  /** codegen words asmlift's flag table does not name; the compiler still receives them */
  unclassified: readonly string[];
  source: FlagsSource;
  /** how the row compares with its project's profile; null for a synthetic row, or a project with no
   *  other row of the toolchain */
  peer: { rows: number; of: number; same: boolean; changes: string[] } | null;
}

export function rowFlags(row: FunctionResult, peer: ProjectProfile | null): RowFlags {
  const profile = rowProfile(row);
  const raw = groupWords(row.cflags, profile);
  const same = peer !== null && profileKey(peer.profile) === profileKey(profile);
  return {
    level: rowLevel(row),
    raw,
    effective: raw.map((g) => g.filter((w) => !w.overridden)).filter((g) => g.length > 0),
    hasOverrides: profile.overriddenAt.length > 0,
    unclassified: profile.unclassified,
    source: flagsSource(row),
    peer: peer && { rows: peer.rows, of: peer.of, same, changes: same ? [] : profileChanges(peer.profile, profile) },
  };
}

/** The Function Explorer's flags cell. */
export interface ExplorerFlags {
  level: string | null;
  /** the row's profile is not its project's */
  differs: boolean;
  /** what separates it besides the level, which the cell already shows */
  delta: string[];
  /** every change, the level included, for the cell's title */
  changes: string[];
}

export function explorerFlags(row: FunctionResult, peer: ProjectProfile | null): ExplorerFlags {
  const profile = rowProfile(row);
  const level = rowLevel(row);
  if (peer === null || profileKey(peer.profile) === profileKey(profile)) {
    return { level, differs: false, delta: [], changes: [] };
  }
  return {
    level,
    differs: true,
    delta: profileChanges(peer.profile, profile, { withLevel: false }),
    changes: profileChanges(peer.profile, profile),
  };
}
