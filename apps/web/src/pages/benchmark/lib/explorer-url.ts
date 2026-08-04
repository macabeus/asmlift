// The Benchmark view's URL state, shared between Benchmark.tsx (sub-tab, preset deep links) and
// Explorer.tsx (filters, sort, selected row): every explorer view — including an open
// FunctionDetail — is a shareable link. Defaults are cleared from the URL (nuqs clearOnDefault).
import { type inferParserType, parseAsArrayOf, parseAsString, parseAsStringLiteral } from 'nuqs';

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
  toolchain: parseAsString.withDefault(''),
  tier: parseAsString.withDefault(''),
  outcomeDecompiler: parseAsStringLiteral(['any', 'asmlift', 'm2c'] as const).withDefault('any'),
  outcome: parseAsString.withDefault(''),
  verdict: parseAsStringLiteral(VERDICTS).withDefault(''),
  // Multi-select, AND-ed: a row must carry EVERY selected tag / exhibit every selected class.
  // Comma-separated, so a single-value link still parses as a one-element list.
  feature: parseAsArrayOf(parseAsString).withDefault([]),
  decline: parseAsArrayOf(parseAsString).withDefault([]),
  // 'with' = only rows asmlift ran WITH the project's symbol map (asmlift.symbolMap provenance)
  symbols: parseAsStringLiteral(['', 'with'] as const).withDefault(''),
  search: parseAsString.withDefault(''),
};

// Short, stable URL names — the state keys stay descriptive in code.
export const FILTER_URL_KEYS = {
  project: 'project',
  isa: 'isa',
  toolchain: 'tc',
  tier: 'tier',
  outcomeDecompiler: 'of',
  outcome: 'outcome',
  verdict: 'vs',
  feature: 'feature',
  decline: 'decline',
  symbols: 'symbols',
  search: 'q',
} as const;

export type Filters = inferParserType<typeof FILTER_PARSERS>;
export type ExplorerPreset = Partial<Filters>;

/** The definition drawer's subject — the same URL-state shape as `fn`, the row drawer. */
export const FEATURE_TERM_PARSER = parseAsString.withDefault('');
export const FEATURE_TERM_KEY = 'about';

/** Link that opens the definition drawer for `id`. A real `href`, so middle-click and copy-link
 *  work; built from the CURRENT query, so opening one never discards the filters already set. */
export function featureHref(id: string, search = typeof window === 'undefined' ? '' : window.location.search): string {
  const params = new URLSearchParams(search);
  params.set(FEATURE_TERM_KEY, id);
  return `?${params.toString()}`;
}

/** A preset deep-link REPLACES the whole filter set: spread this under it to reset the rest. */
export const FILTERS_RESET: { [K in keyof Filters]: null } = {
  project: null,
  isa: null,
  toolchain: null,
  tier: null,
  outcomeDecompiler: null,
  outcome: null,
  verdict: null,
  feature: null,
  decline: null,
  symbols: null,
  search: null,
};
