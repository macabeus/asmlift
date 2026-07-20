// Central color + label constants. Keep every hue here (not inline) so new charts stay cheap.
import type { DecompilerId, Outcome, ToolchainId } from '@asmlift/bench-schema';

/** Per-decompiler brand colors. */
export const DECOMPILER_COLOR: Record<DecompilerId, string> = {
  asmlift: '#2dd4bf', // teal-400 (brand)
  m2c: '#a855f7', // purple-500
};

/** Outcome status colors. */
export const OUTCOME_COLOR: Record<Outcome, string> = {
  match: '#22c55e', // emerald-500
  nonmatch: '#f59e0b', // amber-500
  noncompile: '#ef4444', // red-500
  declined: '#a855f7', // purple-500 — explicit marker-bearing decline (never scored)
  failed: '#64748b', // slate-500
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  match: 'match',
  nonmatch: 'non-match',
  noncompile: 'non-compile',
  declined: 'declined',
  failed: 'failed',
};

/** Ordered so stacked bars always read best -> worst, left to right. */
export const OUTCOME_ORDER: Outcome[] = ['match', 'nonmatch', 'noncompile', 'declined', 'failed'];

/** One-sentence definition of each outcome — shown when hovering the legend labels. */
export const OUTCOME_GLOSS: Record<Outcome, string> = {
  match: 'compiled and byte-exact (objdiff score 0)',
  nonmatch: 'compiled but not byte-exact (score > 0)',
  noncompile:
    'marker-free source that claims completeness but fails to compile (the source and compiler diagnostics are kept)',
  declined:
    "output bearing explicit incompleteness markers (ASMLIFT_ERROR / M2C_ERROR / M2C_UNK / '?' placeholders) — deliberately uncompilable, never scored. Functions that decline only for missing context receive it (see Methodology); remaining declines are genuine modeling gaps on both sides",
  failed: 'no usable output at all (crash, function not found, empty)',
};

/** Gap-size buckets for the Explorer's GapBadge (measured absolute objdiff diff of the best
 *  candidate). Neutral blues on purpose: the color must not imply an easy/hard judgment the
 *  data does not measure. */
export const GAP_BUCKETS = [
  { key: '1-3', label: '1–3 instructions', max: 3 },
  { key: '4-10', label: '4–10 instructions', max: 10 },
  { key: '11-30', label: '11–30 instructions', max: 30 },
  { key: '31+', label: '31+ instructions', max: Infinity },
] as const;
export type GapBucketKey = (typeof GAP_BUCKETS)[number]['key'];
export const GAP_BUCKET_COLOR: Record<GapBucketKey, string> = {
  '1-3': '#7dd3fc', // sky-300
  '4-10': '#38bdf8', // sky-400
  '11-30': '#0284c7', // sky-600
  '31+': '#075985', // sky-800
};

/** Human labels for the four toolchains. */
export const TOOLCHAIN_LABEL: Record<ToolchainId, string> = {
  'agbcc-arm': 'agbcc / ARM',
  'ido-mips': 'ido / MIPS',
  'gcc-mips': 'gcc / MIPS',
  'mwcc-ppc': 'mwcc / PPC',
};

export const TOOLCHAIN_ORDER: ToolchainId[] = ['agbcc-arm', 'ido-mips', 'gcc-mips', 'mwcc-ppc'];

/** Human labels for the ISAs (the "assembly" axis) and compilers. */
export const ISA_LABEL: Record<string, string> = {
  arm: 'ARM (GBA)',
  mips: 'MIPS (N64)',
  ppc: 'PowerPC (GC)',
};

export const ISA_ORDER: string[] = ['arm', 'mips', 'ppc'];

export const COMPILER_LABEL: Record<string, string> = {
  agbcc: 'agbcc',
  ido: 'IDO',
  gcc: 'KMC GCC',
  mwcc: 'CodeWarrior',
};

export const COMPILER_ORDER: string[] = ['agbcc', 'ido', 'gcc', 'mwcc'];

/** Head-to-head verdict colors (both-match / asmlift-only / m2c-only / neither). */
export const H2H_COLOR = {
  both: '#22c55e', // emerald — both byte-exact
  asmliftOnly: '#2dd4bf', // teal-400 — asmlift matches, m2c does not
  m2cOnly: '#a855f7', // purple — m2c matches, asmlift does not
  neither: '#475569', // slate — neither matched
} as const;

export const H2H_LABEL = {
  both: 'both match',
  asmliftOnly: 'asmlift only',
  m2cOnly: 'm2c only',
  neither: 'neither',
} as const;

/** Shared chart chrome. */
export const CHART = {
  grid: '#334155', // slate-700 gridlines
  axisLabel: '#94a3b8', // slate-400
  tooltipBg: '#1e293b', // slate-800
  tooltipBorder: '#334155',
  tooltipText: '#e2e8f0',
} as const;
