// The reader definitions (`packages/core/src/variation-definitions.ts`), held to the variation
// registry and to `docs/vocabulary.md`.
//
// CLOSURE: every registered variation has exactly one definition and every definition names a
// registered variation. The type of `VARIATION_DEFINITIONS` says the same to `tsc`; this says it to
// the suite that runs without a type check. Every name the committed artifact publishes is checked
// against the definitions in `apps/benchmark/test/variation-closure.test.ts`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  EXAMPLE_FUNCTION,
  EXAMPLE_HOLE,
  READER_WORDS,
  VARIATION_DEFINITIONS,
  VARIATION_KIND_DEFINITIONS,
} from '../src/variation-definitions';
import { VARIATION_KINDS, VARIATION_TOKENS, parseVariation, variationToken } from '../src/variation-tokens';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const names = VARIATION_TOKENS.map((t) => t.name);
const entries = Object.entries(VARIATION_DEFINITIONS);

describe('one definition per registered variation', () => {
  test('every registered variation has a definition', () => {
    expect(names.filter((n) => !Object.hasOwn(VARIATION_DEFINITIONS, n))).toEqual([]);
  });

  test('every definition names a registered variation', () => {
    const registered = new Set<string>(names);
    expect(Object.keys(VARIATION_DEFINITIONS).filter((n) => !registered.has(n))).toEqual([]);
  });
});

describe('the definitions are well-formed', () => {
  test('every definition carries a title, a summary, a detail, when it is offered and an example', () => {
    const blank = entries.flatMap(([n, d]) =>
      [d.title, d.summary, d.detail, d.offeredWhen, d.example.before, d.example.after].some((s) => s.trim() === '')
        ? [n]
        : [],
    );
    expect(blank).toEqual([]);
  });

  test('titles are distinct, so no two catalogue rows read alike', () => {
    const titles = entries.map(([, d]) => d.title);
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);
  });

  test('an example is a pair of two different spellings', () => {
    expect(entries.filter(([, d]) => d.example.before === d.example.after).map(([n]) => n)).toEqual([]);
  });

  // What `packages/cli/test/matching/variation-examples.test.ts` compiles. Checked here too, where no
  // compiler is needed, so a malformed unit fails the fast suite rather than only the toolchain one.
  test("an example's unit holds its hole exactly once, and neither spelling holds one", () => {
    const bad = entries.flatMap(([n, { example: e }]) =>
      e.unit.split(EXAMPLE_HOLE).length !== 2 || e.before.includes(EXAMPLE_HOLE) || e.after.includes(EXAMPLE_HOLE)
        ? [n]
        : [],
    );
    expect(bad).toEqual([]);
  });

  test('both spellings of an example define the function the objects are compared on', () => {
    const defines = (unit: string, spelling: string) =>
      new RegExp(`\\b${EXAMPLE_FUNCTION}\\s*\\([^;]*\\)\\s*\\{`).test(unit.replace(EXAMPLE_HOLE, spelling));
    const bad = entries.flatMap(([n, { example: e }]) =>
      defines(e.unit, e.before) && defines(e.unit, e.after) ? [] : [n],
    );
    expect(bad).toEqual([]);
  });

  test('a subject is explained exactly where the registry lets the variation take one', () => {
    const wrong = entries.flatMap(([n, d]) =>
      (variationToken(n).subject !== undefined) !== (d.subject !== undefined) ? [n] : [],
    );
    expect(wrong).toEqual([]);
  });

  test('each subject example parses to its own variation, with a subject', () => {
    const bad = entries.flatMap(([n, d]) =>
      (d.subject?.examples ?? []).flatMap((part) => {
        const p = parseVariation(part);
        return p.name === n && p.subject !== undefined ? [] : [`${n}: ${part}`];
      }),
    );
    expect(bad).toEqual([]);
    expect(entries.filter(([, d]) => d.subject !== undefined && d.subject.examples.length === 0)).toEqual([]);
  });

  test('every seeAlso names another registered variation', () => {
    const registered = new Set<string>(names);
    const bad = entries.flatMap(([n, d]) =>
      (d.seeAlso ?? []).filter((s) => s === n || !registered.has(s)).map((s) => `${n} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  test('every implementedIn is a file in the repository', () => {
    expect(entries.filter(([, d]) => !existsSync(join(REPO_ROOT, d.implementedIn))).map(([n]) => n)).toEqual([]);
  });

  // A code span renders as a padded chip, so a letter written straight after one detaches from it:
  // "`if`s" reads "if s". Write "`if` statements" instead.
  test('no code span runs into a letter', () => {
    const glued = (s: string) => s.split('`').some((piece, i) => i % 2 === 0 && i > 0 && /^[A-Za-z]/.test(piece));
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
    const all = [READER_WORDS, VARIATION_KIND_DEFINITIONS, VARIATION_DEFINITIONS].flatMap(strings);
    expect(all.length).toBeGreaterThan(300);
    expect(all.filter(glued)).toEqual([]);
  });
});

describe('the variation kinds', () => {
  test('one definition per kind, in kind order', () => {
    expect(Object.keys(VARIATION_KIND_DEFINITIONS)).toEqual([...VARIATION_KINDS]);
  });

  test("each kind's examples are registered variations of that kind", () => {
    const bad = VARIATION_KINDS.flatMap((kind) =>
      VARIATION_KIND_DEFINITIONS[kind].examples.flatMap((part) =>
        variationToken(parseVariation(part).name).variationKind === kind ? [] : [`${kind}: ${part}`],
      ),
    );
    expect(bad).toEqual([]);
  });
});

// `docs/vocabulary.md` is the repository's definition of these words, and the webapp renders its
// glossary from `READER_WORDS` and `VARIATION_KIND_DEFINITIONS`. Holding the two tables to the data
// text for text is what keeps one wording.
describe('docs/vocabulary.md says the same', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs', 'vocabulary.md'), 'utf8');

  /** The body rows of the first table under `heading`, each split into its trimmed cells. */
  function tableRows(heading: string): string[][] {
    const section = doc.split(/^## /m).find((s) => s.startsWith(`${heading}\n`));
    if (section === undefined) {
      throw new Error(`docs/vocabulary.md has no "## ${heading}" section`);
    }
    const lines = section.split('\n').filter((l) => l.startsWith('|'));
    return lines.slice(2).map((l) =>
      l
        .slice(1, -1)
        .split(' | ')
        .map((c) => c.trim()),
    );
  }

  test('the six words table', () => {
    expect(tableRows('The six words a reader needs')).toEqual(
      READER_WORDS.map((w) => [`**${w.word}**`, w.command ? `${w.meaning} ${w.command}` : w.meaning]),
    );
  });

  test('the variation kinds table', () => {
    expect(tableRows('Variation kinds')).toEqual(
      VARIATION_KINDS.map((k) => {
        const d = VARIATION_KIND_DEFINITIONS[k];
        return [`**${d.title}**`, d.meaning, d.examples.map((e) => `\`${e}\``).join(', ')];
      }),
    );
  });
});
