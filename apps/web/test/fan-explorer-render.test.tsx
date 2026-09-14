// The Fan Explorer tab and its variation drawer as they actually render, over the committed artifact
// and over `FAN_SAMPLE`, ranked rows that carry `fanVariations`. apps/web has no DOM, so this is
// `renderToStaticMarkup`: enough to hold that every entry is on the page with its definition, that
// every link resolves, and that every cost view carries its sentence.
import { type FunctionResult, resolveRow } from '@asmlift/bench-schema';
import { READER_WORDS, VARIATION_DEFINITIONS, VARIATION_KIND_DEFINITIONS } from '@asmlift/core/variation-definitions';
import { VARIATION_KINDS, VARIATION_TOKENS } from '@asmlift/core/variation-tokens';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { FanExplorer } from '../src/pages/benchmark/components/FanExplorer';
import { VariationDetailBody } from '../src/pages/benchmark/components/VariationDetail';
import { rowsFor, variationStats } from '../src/pages/benchmark/lib/fan';
import { hashToSearchParams } from '../src/shared/utils/hash-params';
import { FAN_SAMPLE } from './fan-sample';

const artifact = (
  JSON.parse(readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8')) as {
    results: FunctionResult[];
  }
).results;

const HASH = '#view=benchmark&tab=fan';
const NOT_WASTE = 'A losing candidate is not waste.';
const noop = () => {};

/** React escapes text; the definitions are compared as the reader sees them. */
const escaped = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
/** The text of a definition string outside its code spans, which render as `<code>`. */
const prose = (s: string) => s.split('`').filter((piece, i) => i % 2 === 0 && piece.trim());
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const count = (html: string, s: string) => html.split(s).length - 1;

describe.each([
  ['the committed artifact', artifact],
  ['the sample', FAN_SAMPLE],
])('the tab over %s', (_, rows) => {
  const html = renderToStaticMarkup(<FanExplorer rows={rows} hash={HASH} onOpenVariation={noop} />);

  test("every registered variation is an entry, with its title and its summary's words", () => {
    for (const { name } of VARIATION_TOKENS) {
      const def = VARIATION_DEFINITIONS[name];
      for (const piece of [...prose(def.title), ...prose(def.summary)]) {
        expect(html, name).toContain(escaped(piece));
      }
    }
  });

  test('the glossary: the six words and the five kinds', () => {
    for (const w of READER_WORDS) {
      expect(html).toContain(`>${w.word}</dt>`);
    }
    for (const k of VARIATION_KINDS) {
      expect(html).toContain(VARIATION_KIND_DEFINITIONS[k].title);
    }
    expect(html).not.toContain('`');
  });

  test("every entry links to its own drawer over the reader's view", () => {
    const links = hrefs(html).map(hashToSearchParams);
    expect(links.map((p) => p.get('variation')).sort()).toEqual(VARIATION_TOKENS.map((t) => t.name).sort());
    expect(links.every((p) => p.get('tab') === 'fan')).toBe(true);
  });

  test('every cost view carries the sentence', () => {
    expect(count(html, NOT_WASTE)).toBe(2);
  });

  test('a toolchain count, never a project count', () => {
    expect(html).toContain('toolchains</div>');
    expect(html).not.toMatch(/>projects?</);
  });
});

describe('the variation drawer', () => {
  test.each([
    ['the committed artifact', artifact],
    ['the sample', FAN_SAMPLE],
  ])('renders every registered variation over %s, and every row link opens its row', (_, rows) => {
    for (const { name } of VARIATION_TOKENS) {
      const html = renderToStaticMarkup(
        <VariationDetailBody name={name} rows={rows} hash={HASH} onClose={noop} onOpenVariation={noop} />,
      );
      for (const piece of prose(VARIATION_DEFINITIONS[name].title)) {
        expect(html, name).toContain(escaped(piece));
      }
      expect(html, name).toContain(NOT_WASTE);
      expect(html, name).not.toContain('`');
      const rowLinks = hrefs(html)
        .map(hashToSearchParams)
        .filter((p) => p.has('fn'));
      expect(rowLinks.length, name).toBe(rowsFor(rows, name).length);
      // the caption counts the rows the table lists, from the population the figures count
      const s = variationStats(rows).get(name)!;
      expect(html, name).toContain(`Rows — ${s.winners} won with it, ${s.rows - s.winners} considered it and lost`);
      for (const p of rowLinks) {
        expect(p.get('tab')).toBe('explorer');
        expect(p.get('view')).toBe('benchmark');
        expect(resolveRow(rows as FunctionResult[], p.get('fn')!), p.get('fn')!).toBeDefined();
      }
    }
  });

  test.each(['volatile', 'coalesce'] as const)(
    "the Winner's variations column lights the drawer's variation, subject and all: %s",
    (name) => {
      const html = renderToStaticMarkup(
        <VariationDetailBody name={name} rows={FAN_SAMPLE} hash={HASH} onClose={noop} onOpenVariation={noop} />,
      );
      expect(html).toContain('Winner&#x27;s variations');
      const lit = [...html.matchAll(/<span class="font-semibold text-teal-300">([^<]*)<\/span>/g)].map((m) => m[1]);
      const expected = rowsFor(FAN_SAMPLE, name).flatMap((r) => r.winner.filter((p) => p.lit).map((p) => p.part));
      expect(lit).toEqual(expected);
      expect(lit.length).toBeGreaterThan(0);
    },
  );

  test('a subject-taking variation explains its subject; one that takes none does not', () => {
    const render = (name: 'coalesce' | 'unmerge') =>
      renderToStaticMarkup(
        <VariationDetailBody name={name} rows={FAN_SAMPLE} hash={HASH} onClose={noop} onOpenVariation={noop} />,
      );
    expect(render('coalesce')).toContain('Its subject');
    expect(render('unmerge')).not.toContain('Its subject');
  });

  test("a see-also link keeps the reader's view and swaps the variation", () => {
    const def = VARIATION_DEFINITIONS.unsigned;
    const html = renderToStaticMarkup(
      <VariationDetailBody
        name="unsigned"
        rows={FAN_SAMPLE}
        hash="#tab=explorer&fn=sa3:sub_803213C:agbcc&variation=unsigned"
        onClose={noop}
        onOpenVariation={noop}
      />,
    );
    // the row links carry no variation; every other link is a see-also
    const seeAlso = hrefs(html)
      .map(hashToSearchParams)
      .filter((p) => p.has('variation'));
    expect(seeAlso.map((p) => p.get('variation'))).toEqual([...(def.seeAlso ?? [])]);
    expect(seeAlso.every((p) => p.get('tab') === 'explorer' && p.get('fn') === 'sa3:sub_803213C:agbcc')).toBe(true);
  });
});
