// The two domain adapters over the generic <MultiSelect>: each turns a closed vocabulary into
// options. What a tag means lives in @asmlift/bench-schema, what a decline class means in
// lib/declines — neither belongs inside a shared UI component.
import { FEATURES, FEATURE_GROUP_LABEL, GROUP_ORDER } from '@asmlift/bench-schema';
import { useMemo } from 'react';

import { MultiSelect, type MultiSelectOption } from '../../../shared/components/MultiSelect';
import { useCurrentHash } from '../../../shared/utils/hash-adapter';
import { DECLINE_CLASSES, OTHER_CLASS } from '../lib/declines';
import { FEATURE_TERM_KEY, featureHref } from '../lib/explorer-url';

/** Feature tags, grouped by the vocabulary's user-facing axis.
 *
 *  `counts` is over the CURRENTLY FILTERED rows, not the whole dataset: the selection is AND-ed, so
 *  an option that would empty the table has to say so before it is clicked. Zero-count options go
 *  disabled but stay visible — that a tag exists and selects nothing here is worth seeing. */
export function FeaturePicker({
  value,
  onChange,
  counts,
  onOpenFeature,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  counts: Map<string, number>;
  onOpenFeature: (id: string) => void;
}) {
  // Each option's `href` is a permalink to this view with the drawer open, so it has to be rebuilt
  // when the URL moves; `counts` alone changes a render before the write lands.
  const hash = useCurrentHash();
  const options = useMemo<MultiSelectOption[]>(() => {
    const rank = new Map(GROUP_ORDER.map((g, i) => [g, i]));
    return [...FEATURES]
      .filter((f) => !f.deprecated)
      .sort((a, b) => rank.get(a.group)! - rank.get(b.group)! || a.label.localeCompare(b.label))
      .map((f) => ({
        value: f.id,
        label: f.label,
        group: FEATURE_GROUP_LABEL[f.group],
        description: f.summary,
        count: counts.get(f.id) ?? 0,
        disabled: (counts.get(f.id) ?? 0) === 0,
        href: featureHref(f.id, hash),
      }));
  }, [counts, hash]);

  return (
    <MultiSelect
      label="Feature"
      options={options}
      value={value}
      onChange={onChange}
      placeholder="All"
      searchPlaceholder="Search features…"
      emptyText="No feature matches."
      onNavigate={(href) => onOpenFeature(new URLSearchParams(href.slice(1)).get(FEATURE_TERM_KEY) ?? '')}
    />
  );
}

/** asmlift's decline classes: the same closed-vocabulary shape, without a group axis or
 *  definitions to link to. */
export function DeclinePicker({
  value,
  onChange,
  counts,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  counts: Map<string, number>;
}) {
  const options = useMemo<MultiSelectOption[]>(
    () =>
      [...DECLINE_CLASSES, OTHER_CLASS].map((c) => ({
        value: c.key,
        label: c.label,
        count: counts.get(c.key) ?? 0,
        disabled: (counts.get(c.key) ?? 0) === 0,
      })),
    [counts],
  );

  return (
    <MultiSelect
      label="asmlift decline"
      options={options}
      value={value}
      onChange={onChange}
      placeholder="All"
      searchPlaceholder="Search decline reasons…"
      emptyText="No decline class matches."
    />
  );
}
