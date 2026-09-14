// The Fan Explorer tab and its variation drawer as they actually render, over the committed artifact
// and over `FAN_SAMPLE`, ranked rows that carry `fanVariations`. apps/web has no DOM, so this is
// `renderToStaticMarkup`: enough to hold that every entry is on the page with its definition, that
// every link resolves, and that every cost view carries its sentence.
import { type FunctionResult, resolveRow } from '@asmlift/bench-schema';
import {
  READER_WORDS,
  TARGET_BEHAVIOR_READINGS,
  VARIATION_DEFINITIONS,
  VARIATION_KIND_DEFINITIONS,
} from '@asmlift/core/variation-definitions';
import { readerRules } from '@asmlift/core/variation-gates';
import { VARIATION_KINDS, VARIATION_TOKENS, variationToken } from '@asmlift/core/variation-tokens';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { FanExplorer } from '../src/pages/benchmark/components/FanExplorer';
import { VariationDetailBody } from '../src/pages/benchmark/components/VariationDetail';
import { VariationCostGain, bubbleSize } from '../src/pages/benchmark/components/charts/VariationCostGain';
import { fanCoverage, priced, rowsFor, variationStats } from '../src/pages/benchmark/lib/fan';
import { hashToSearchParams } from '../src/shared/utils/hash-params';
import { FAN_SAMPLE } from './fan-sample';

const artifact = (
  JSON.parse(readFileSync(join(import.meta.dirname, '../src/pages/benchmark/data/results.json'), 'utf8')) as {
    results: FunctionResult[];
  }
).results;

const HASH = '#view=benchmark&tab=fan';
const NOT_WASTE = 'A losing candidate is not waste.';
const NO_FAN = 'No fan in this artifact was counted, so there is nothing to price.';
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
      for (const piece of prose(w.command ?? '')) {
        expect(html, w.word).toContain(escaped(piece));
      }
    }
    for (const k of VARIATION_KINDS) {
      expect(html).toContain(VARIATION_KIND_DEFINITIONS[k].title);
    }
    expect(html).not.toContain('`');
  });

  test("every entry links to its own drawer over the reader's view", () => {
    const links = hrefs(html).map(hashToSearchParams);
    expect(new Set(links.map((p) => p.get('variation')))).toEqual(new Set(VARIATION_TOKENS.map((t) => t.name)));
    expect(links.every((p) => p.get('tab') === 'fan')).toBe(true);
  });

  test('the catalogue comes before the cost views, which carry the sentence once, above both charts', () => {
    const counted = fanCoverage(rows).rows > 0;
    expect(html.indexOf('>Every variation<')).toBeGreaterThan(-1);
    expect(html.includes(NO_FAN)).toBe(!counted);
    expect(count(html, NOT_WASTE)).toBe(counted ? 1 : 0);
    if (counted) {
      expect(html.indexOf('>Every variation<')).toBeLessThan(html.indexOf('>Cost against gain<'));
      expect(html.indexOf(NOT_WASTE)).toBeLessThan(html.indexOf('>Cost against gain<'));
    }
  });

  test('a variation some fan carried and that never won is listed beside the price chart, not drawn in it', () => {
    const never = html.slice(html.indexOf('Never won, so no price'));
    const { neverWon } = priced(variationStats(rows));
    const listed = hrefs(never).map((h) => hashToSearchParams(h).get('variation'));
    expect(listed).toEqual(neverWon.map((s) => s.name));
  });

  test('a toolchain count, never a project count', () => {
    expect(html).toContain('toolchains</div>');
    expect(html).not.toMatch(/>projects?</);
  });
});

test('an artifact with no counted fan says so, instead of drawing empty charts', () => {
  const uncounted = FAN_SAMPLE.map((r) => {
    const { fanSize: _size, fanVariations: _tally, ...asmlift } = r.asmlift;
    return { ...r, asmlift };
  });
  const html = renderToStaticMarkup(<FanExplorer rows={uncounted} hash={HASH} onOpenVariation={noop} />);
  expect(html).toContain(NO_FAN);
  expect(html).not.toContain('>Cost against gain<');
  expect(html).not.toContain('>Price per win<');
  expect(html).not.toContain(NOT_WASTE);
  expect(html).toContain('>Every variation<');
});

describe('the cost-against-gain chart', () => {
  test('its key names every kind, in kind order, as page text that wraps', () => {
    const html = renderToStaticMarkup(
      <VariationCostGain data={priced(variationStats(FAN_SAMPLE)).neverWon} onPointClick={noop} />,
    );
    const key = html.slice(0, html.indexOf('</ul>'));
    const titles = VARIATION_KINDS.map((k) => VARIATION_KIND_DEFINITIONS[k].title);
    expect(titles.map((t) => key.indexOf(`>${t}</li>`))).toEqual(
      titles.map((t) => key.indexOf(`>${t}</li>`)).sort((a, b) => a - b),
    );
    expect(titles.every((t) => key.includes(`>${t}</li>`))).toBe(true);
  });

  test("a bubble's area is proportional to its rows, above the smallest size", () => {
    const area = (rows: number) => bubbleSize(rows) ** 2;
    expect(area(680) / area(170)).toBeCloseTo(4);
    expect(area(100) / area(25)).toBeCloseTo(4);
    expect(bubbleSize(1)).toBe(bubbleSize(4));
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
      // the sentence rides with a cost, and a variation no fan carried has none
      const s = variationStats(rows).get(name)!;
      expect(html.includes(NOT_WASTE), name).toBe(s.candidates > 0);
      expect(html, name).not.toContain('`');
      const rowLinks = hrefs(html)
        .map(hashToSearchParams)
        .filter((p) => p.has('fn'));
      expect(rowLinks.length, name).toBe(rowsFor(rows, name).length);
      // the caption counts the rows the table lists, from the population the figures count
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

  test('when it is offered is read from the code: every rule of its tables, its condition, its target', () => {
    for (const { name } of VARIATION_TOKENS) {
      const offer = VARIATION_DEFINITIONS[name].offeredWhen;
      const gate = variationToken(name).target;
      const html = renderToStaticMarkup(
        <VariationDetailBody name={name} rows={FAN_SAMPLE} hash={HASH} onClose={noop} onOpenVariation={noop} />,
      );
      const offered = html.slice(html.indexOf('Offered when'), html.indexOf('In this benchmark'));
      if (offer === 'always') {
        expect(offered, name).toContain('On every function.');
        continue;
      }
      const text = [
        'judges' in offer ? offer.judges : offer.when,
        ...readerRules(offer.gates ?? []).map((r) => r.why),
        ...(gate ? [TARGET_BEHAVIOR_READINGS[gate.behavior].reads] : []),
      ];
      for (const piece of text.flatMap(prose)) {
        expect(offered, name).toContain(escaped(piece.trim()));
      }
      if ('decidedBy' in offer) {
        expect(offered, name).toContain(`>${offer.decidedBy.symbol}</code>`);
      }
    }
  });

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
