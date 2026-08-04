// The searching and grouping behind <MultiSelect>. Pure, so it can be tested without a DOM.
import { describe, expect, it } from 'vitest';

import {
  type MultiSelectOption,
  filterOptions,
  matchesQuery,
  toggleValue,
} from '../src/shared/components/multi-select-options';

const OPTIONS: MultiSelectOption[] = [
  { value: 'loop', label: 'Loop', group: 'Control flow', description: 'a for, while or do-while loop' },
  { value: 'switch', label: 'Switch', group: 'Control flow', description: 'a switch statement' },
  { value: 'div-const', label: 'Divide by a constant', group: 'Arithmetic', description: 'division by a constant' },
  { value: 'ungrouped', label: 'No group here' },
];

describe('matchesQuery', () => {
  it('matches on the id, the label and the description alike', () => {
    expect(matchesQuery(OPTIONS[0], 'loop')).toBe(true); //        id
    expect(matchesQuery(OPTIONS[2], 'divide')).toBe(true); //      label
    expect(matchesQuery(OPTIONS[1], 'statement')).toBe(true); //   description
    expect(matchesQuery(OPTIONS[1], 'nonsense')).toBe(false);
  });

  it('AND-s the words, so word order does not matter', () => {
    expect(matchesQuery(OPTIONS[2], 'constant divide')).toBe(true);
    expect(matchesQuery(OPTIONS[2], 'divide loop')).toBe(false);
  });

  it('is case-insensitive and treats an empty query as "everything"', () => {
    expect(matchesQuery(OPTIONS[0], 'LOOP')).toBe(true);
    expect(matchesQuery(OPTIONS[0], '   ')).toBe(true);
  });
});

describe('filterOptions', () => {
  it('buckets by group, ungrouped first, preserving caller order within a group', () => {
    const groups = filterOptions(OPTIONS, '');
    expect(groups.map((g) => g.group)).toEqual([undefined, 'Control flow', 'Arithmetic']);
    expect(groups[1].options.map((o) => o.value)).toEqual(['loop', 'switch']);
  });

  it('drops a group whose every option was filtered out, header included', () => {
    const groups = filterOptions(OPTIONS, 'switch');
    expect(groups.map((g) => g.group)).toEqual(['Control flow']);
    expect(groups[0].options.map((o) => o.value)).toEqual(['switch']);
  });

  it('KEEPS a selected option that does not match the query', () => {
    // otherwise typing a search hides the filter you already applied, and it cannot be removed
    const groups = filterOptions(OPTIONS, 'switch', ['div-const']);
    expect(groups.flatMap((g) => g.options.map((o) => o.value)).sort()).toEqual(['div-const', 'switch']);
  });

  it('returns no groups at all when nothing matches', () => {
    expect(filterOptions(OPTIONS, 'zzz')).toEqual([]);
  });
});

describe('toggleValue', () => {
  it('adds at the end and removes in place, preserving selection order', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleValue(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});
