// The searching and grouping behind <MultiSelect>. Pure, so it can be unit-tested without a DOM.

export interface MultiSelectOption {
  value: string;
  label: string;
  /** renders a section header; ungrouped options are listed first, under no header */
  group?: string;
  /** shown under the label, and matched by the search box */
  description?: string;
  /** right-aligned figure — how many things this option would select */
  count?: number;
  /** greyed and unselectable, but still VISIBLE: a zero-count option is information */
  disabled?: boolean;
  /** renders a "read more" affordance on the row */
  href?: string;
}

export interface OptionGroup {
  /** undefined for the ungrouped bucket */
  group?: string;
  options: MultiSelectOption[];
}

/** Case-insensitive match over value, label and description. Multi-word queries are AND-ed, so
 *  "div const" finds "Divide by a constant" regardless of the word order it was typed in. */
export function matchesQuery(option: MultiSelectOption, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const haystack = `${option.value} ${option.label} ${option.description ?? ''}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/** Filter by `query` and bucket into groups, preserving the caller's option order within each
 *  group and the order in which groups first appear. Selected values are always kept, even when
 *  they do not match the query — a filter you cannot see is a filter you cannot remove.
 *
 *  Empty groups are dropped, so a search that eliminates a whole section does not leave its
 *  header behind. */
export function filterOptions(
  options: readonly MultiSelectOption[],
  query: string,
  selected: readonly string[] = [],
): OptionGroup[] {
  const keep = new Set(selected);
  const visible = options.filter((o) => keep.has(o.value) || matchesQuery(o, query));
  const buckets: OptionGroup[] = [];
  const byGroup = new Map<string | undefined, OptionGroup>();
  for (const o of visible) {
    let bucket = byGroup.get(o.group);
    if (!bucket) {
      byGroup.set(o.group, (bucket = { group: o.group, options: [] }));
      buckets.push(bucket);
    }
    bucket.options.push(o);
  }
  // the ungrouped bucket first, then groups in first-seen order
  return buckets.sort((a, b) => (a.group === undefined ? -1 : b.group === undefined ? 1 : 0));
}

/** Toggle one value in a selection, preserving order of first selection. */
export function toggleValue(selected: readonly string[], value: string): string[] {
  return selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
}
