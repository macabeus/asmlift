// The Explorer's URL contract: every filter view is a shareable link, so these parsers are what a
// permalink is built on.
import { expect, test } from 'vitest';

import {
  FEATURE_TERM_KEY,
  FILTERS_RESET,
  FILTER_PARSERS,
  FILTER_URL_KEYS,
  TAB_IDS,
  featureHref,
  tabParser,
} from '../src/pages/benchmark/lib/explorer-url';

test('feature and decline parse as lists', () => {
  expect(FILTER_PARSERS.feature.parse('loop,table')).toEqual(['loop', 'table']);
  expect(FILTER_PARSERS.decline.parse('float,mips-calls')).toEqual(['float', 'mips-calls']);
});

test('a single-value link written before the list change still parses', () => {
  // ?feature=loop was the whole filter for the entire life of the old <select>
  expect(FILTER_PARSERS.feature.parse('loop')).toEqual(['loop']);
  expect(FILTER_PARSERS.decline.parse('float')).toEqual(['float']);
});

test('the default is an empty selection, not a selection of nothing-in-particular', () => {
  // `[]` must mean "no feature filter" — an AND over an empty list keeps every row
  expect(FILTER_PARSERS.feature.defaultValue).toEqual([]);
  expect(FILTER_PARSERS.decline.defaultValue).toEqual([]);
});

test('every filter key has a URL name and a reset entry, so a preset cannot leave one behind', () => {
  const keys = Object.keys(FILTER_PARSERS).sort();
  expect(Object.keys(FILTER_URL_KEYS).sort()).toEqual(keys);
  expect(Object.keys(FILTERS_RESET).sort()).toEqual(keys);
});

test('a feature definition is a link, and opening one PRESERVES the filters already set', () => {
  // the drawer sits over whatever tab is showing, so its link must not reset the reader's view
  const href = featureHref('div-const', '?tab=explorer&feature=loop,table&project=kleod');
  const params = new URLSearchParams(href.slice(1));
  expect(params.get(FEATURE_TERM_KEY)).toBe('div-const');
  expect(params.get('tab')).toBe('explorer');
  expect(params.get('feature')).toBe('loop,table');
  expect(params.get('project')).toBe('kleod');
});

test('opening a second definition replaces the first rather than appending', () => {
  const href = featureHref('magic-div', featureHref('div-const', '?tab=explorer').slice(0));
  expect(new URLSearchParams(href.slice(1)).getAll(FEATURE_TERM_KEY)).toEqual(['magic-div']);
});

test('the Glossary tab is gone — definitions are a drawer, not a page', () => {
  expect(TAB_IDS).not.toContain('glossary');
  expect(tabParser.parse('glossary')).toBeNull(); // nuqs then applies withDefault('overview')
});
