// The variation registry, held to itself and to the code that mints variations.
//
// The corpus-scale checks — every name the committed artifact publishes and every name the
// enumerated corpus mints — live in `apps/benchmark/test/variation-closure.test.ts`, because only
// that tree reads the artifact and the dataset. This file is the one that runs in `test:offline`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { SIGN_CANDS } from '../src/rank-axes';
import {
  VARIATION_KINDS,
  VARIATION_TOKENS,
  hasVariation,
  hasVariations,
  parseVariation,
  variationToken,
} from '../src/variation-tokens';

const names = VARIATION_TOKENS.map((t) => t.name);

describe('the registry is well-formed', () => {
  test('one entry per name, each with exactly one known kind', () => {
    expect(new Set(names).size).toBe(names.length);
    for (const t of VARIATION_TOKENS) {
      expect(VARIATION_KINDS).toContain(t.variationKind);
    }
  });

  test('a name is one lowercase word that no candidate name or URL list splits', () => {
    for (const n of names) {
      expect(n).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    }
  });

  test('`winner` and `best` are never variations: `bench fan --show` reserves them', () => {
    expect(names).not.toContain('winner');
    expect(names).not.toContain('best');
  });

  test('the signedness variations are exactly the ones enumeration pins', () => {
    const signedness = VARIATION_TOKENS.filter((t) => t.variationKind === 'signedness').map((t) => t.name);
    expect(signedness).toEqual(SIGN_CANDS.map((s) => s.label));
  });

  // `rank.ts` strips one structure variation out of a structure suffix with a substring `replace`,
  // which removes the FIRST occurrence: a structure variation spelled inside another would strip
  // the wrong one.
  test('no structure variation is spelled inside another', () => {
    const structure = VARIATION_TOKENS.filter((t) => t.variationKind === 'structure').map((t) => `/${t.name}`);
    const collisions = structure.flatMap((a) =>
      structure.filter((b) => a !== b && b.includes(a)).map((b) => `${a} in ${b}`),
    );
    expect(collisions).toEqual([]);
  });

  test('every subject-taking name is the longest match for its own subjects', () => {
    const cases: [string, string, string | undefined][] = [
      ['coalesce-v0-v1', 'coalesce', 'v0-v1'],
      ['coalesce-v1-v0', 'coalesce', 'v1-v0'],
      ['scopebase-coalesce-v2-v4', 'scopebase-coalesce', 'v2-v4'],
      ['volatile', 'volatile', undefined],
      ['volatile-p1', 'volatile', 'p1'],
      ['volatile-p0-p1-p2', 'volatile', 'p0-p1-p2'],
      ['regcopy', 'regcopy', undefined],
      ['regcopy-ret', 'regcopy', 'ret'],
      ['regcopy-ret-fresh', 'regcopy', 'ret-fresh'],
      ['homesplit-0x40000d4.4s', 'homesplit', '0x40000d4.4s'],
      ['homesplit-gFoo<u8*>.1u', 'homesplit', 'gFoo<u8*>.1u'],
      ['sense-3', 'sense', '3'],
      ['livebase-block', 'livebase-block', undefined],
      ['vol-slot', 'vol-slot', undefined],
      ['site-sense', 'site-sense', undefined],
    ];
    for (const [part, name, subject] of cases) {
      expect(parseVariation(part)).toEqual(subject === undefined ? { name } : { name, subject });
    }
  });

  test('a part no registered variation spells throws, subject shape included', () => {
    for (const part of [
      'volatile-slot',
      'coalesce-',
      'coalesce-x',
      'sense-a',
      'regcopy-fresh',
      'livebase-p1',
      'nosuch',
      '',
    ]) {
      expect(() => parseVariation(part)).toThrow(/names no registered variation/);
    }
  });
});

describe('hasVariation / hasVariations compare whole variations and refuse unregistered names', () => {
  const v = ['signed', 'livebase-block', 'volatile-p0-p1', 'nearbase', 'sinkinit'];

  test('an omitted subject matches any subject; a given one matches exactly', () => {
    expect(hasVariation(v, 'volatile')).toBe(true);
    expect(hasVariation(v, 'volatile', 'p0-p1')).toBe(true);
    expect(hasVariation(v, 'volatile', 'p0')).toBe(false);
    expect(hasVariation(['unsigned', 'volatile'], 'volatile', 'p0')).toBe(false);
  });

  test('a `null` subject matches only the variation applied without one', () => {
    expect(hasVariation(['unsigned', 'regcopy'], 'regcopy', null)).toBe(true);
    expect(hasVariation(['unsigned', 'regcopy-ret'], 'regcopy', null)).toBe(false);
    expect(hasVariation(['unsigned', 'regcopy-ret'], 'regcopy')).toBe(true);
    expect(hasVariation(['unsigned', 'unmerge'], 'unmerge', null)).toBe(true);
  });

  test('never a substring: `livebase` is not `livebase-block`', () => {
    expect(hasVariation(v, 'livebase-block')).toBe(true);
    expect(hasVariation(v, 'livebase')).toBe(false);
  });

  test('a stale predicate throws instead of passing', () => {
    expect(() => hasVariation(v, 'nosuch')).toThrow(/not a registered variation/);
    expect(() => hasVariation(v, 'unmerge', 'p0')).toThrow(/takes no subject/);
    expect(() => hasVariation(v, 'volatile', 'slot')).toThrow(/takes no subject/);
    expect(() => hasVariation(['unsigned', 'nosuch'], 'unmerge')).toThrow(/names no registered variation/);
    expect(() => hasVariations(v, ['nearbase', 'nosuch'])).toThrow(/not a registered variation/);
    expect(() => hasVariations(v, [])).toThrow();
  });

  test('hasVariations matches an adjacent run, in order', () => {
    expect(hasVariations(v, ['nearbase', 'sinkinit'])).toBe(true);
    expect(hasVariations(v, ['livebase-block', 'volatile'])).toBe(true);
    expect(hasVariations(v, ['livebase-block', 'nearbase'])).toBe(false);
    expect(hasVariations(v, ['sinkinit', 'nearbase'])).toBe(false);
  });

  test('variationToken names a registered variation or throws', () => {
    expect(variationToken('raw-globals').variationKind).toBe('symbol-map');
    expect(() => variationToken('winner')).toThrow();
  });
});

// CLOSURE, POINT 1 OF 3: the mint literals. Every `/`-separated segment a string literal in the two
// enumeration files spells must be a registered variation, and every registered variation must be
// spelled by one — so a `respell('/foo', …)` added without a registry entry fails here, in the suite
// CI runs, and so does an entry for a variation nothing mints any more. A parameterized subject
// (`/sense-${m}`, `/homesplit-${tag}`, `${label}-${c.merged}`) contributes its registered prefix.
// Blind spot, stated: a mint with no literal segment at all; the enumerated-corpus check sees it.
describe('closure over the mint literals of rank.ts and rank-axes.ts', () => {
  const src = ['rank.ts', 'rank-axes.ts']
    .map((f) => readFileSync(join(import.meta.dirname, '..', 'src', f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const segments = [
    ...new Set(
      [...src.matchAll(/['`](?:\$\{[a-zA-Z.]+\})?((?:\/[a-z][a-z0-9-]*)+)['`-]/g)].flatMap((m) =>
        m[1]
          .split('/')
          .filter((s) => s !== '')
          .map((s) => s.replace(/-$/, '')),
      ),
    ),
  ].sort();

  test('the scan sees the whole mint set (non-empty floor)', () => {
    expect(segments.length).toBeGreaterThanOrEqual(57);
  });

  test('every minted segment is a registered variation', () => {
    const unregistered = segments.filter((s) => {
      try {
        parseVariation(s);
        return false;
      } catch {
        return true;
      }
    });
    expect(unregistered).toEqual([]);
  });

  test('every registered variation is minted', () => {
    const minted = new Set([...segments.map((s) => parseVariation(s).name), ...SIGN_CANDS.map((s) => s.label)]);
    expect(names.filter((n) => !minted.has(n))).toEqual([]);
  });
});
