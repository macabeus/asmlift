// The Benchmark view's URL state, shared between Benchmark.tsx (sub-tab, preset deep links) and
// Explorer.tsx (filters, sort, selected row): every explorer view — including an open
// FunctionDetail — is a shareable link. Defaults are cleared from the URL (nuqs clearOnDefault).
import { type inferParserType, parseAsString, parseAsStringLiteral } from 'nuqs';

export const TAB_IDS = ['overview', 'explorer', 'gap', 'methodology'] as const;
export type TabId = (typeof TAB_IDS)[number];
export const tabParser = parseAsStringLiteral(TAB_IDS).withDefault('overview');

export const SORT_KEYS = ['sym', 'project', 'toolchain', 'asmlift', 'm2c'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const SORT_PARSERS = {
  sort: parseAsStringLiteral(SORT_KEYS).withDefault('sym'),
  dir: parseAsStringLiteral(['asc', 'desc'] as const).withDefault('asc'),
};

const VERDICTS = ['', 'asmlift-only', 'm2c-only', 'both', 'neither', 'disagree'] as const;
export type Verdict = (typeof VERDICTS)[number];

// '' = "All". Selects whose options are derived from the data stay plain strings; the closed
// vocabularies get literal parsers, so a hand-edited bogus value falls back to the default
// instead of a never-matching filter.
export const FILTER_PARSERS = {
  project: parseAsString.withDefault(''),
  isa: parseAsString.withDefault(''),
  compiler: parseAsString.withDefault(''),
  toolchain: parseAsString.withDefault(''),
  tier: parseAsString.withDefault(''),
  outcomeDecompiler: parseAsStringLiteral(['any', 'asmlift', 'm2c'] as const).withDefault('any'),
  outcome: parseAsString.withDefault(''),
  verdict: parseAsStringLiteral(VERDICTS).withDefault(''),
  feature: parseAsString.withDefault(''),
  decline: parseAsString.withDefault(''),
  search: parseAsString.withDefault(''),
};

// Short, stable URL names — the state keys stay descriptive in code.
export const FILTER_URL_KEYS = {
  project: 'project',
  isa: 'isa',
  compiler: 'cc',
  toolchain: 'tc',
  tier: 'tier',
  outcomeDecompiler: 'of',
  outcome: 'outcome',
  verdict: 'vs',
  feature: 'feature',
  decline: 'decline',
  search: 'q',
} as const;

export type Filters = inferParserType<typeof FILTER_PARSERS>;
export type ExplorerPreset = Partial<Filters>;

/** A preset deep-link REPLACES the whole filter set: spread this under it to reset the rest. */
export const FILTERS_RESET: { [K in keyof Filters]: null } = {
  project: null,
  isa: null,
  compiler: null,
  toolchain: null,
  tier: null,
  outcomeDecompiler: null,
  outcome: null,
  verdict: null,
  feature: null,
  decline: null,
  search: null,
};
