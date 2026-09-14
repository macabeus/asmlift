// The variation registry, held to itself.
//
// Whether the code that mints variations still mints every entry is `variation-mints.test.ts`. The
// corpus-scale checks — every name the committed artifact publishes and every name the enumerated
// corpus mints — live in `apps/benchmark/test/variation-closure.test.ts`, because only that tree
// reads the artifact and the dataset.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { enumerateCandidates } from '../src/rank';
import { SIGNEDNESS } from '../src/rank-variations';
import { ARMV4T_AGBCC } from '../src/target';
import {
  VARIATION_KINDS,
  VARIATION_TOKENS,
  hasVariation,
  hasVariations,
  joinVariations,
  parseVariation,
  splitVariations,
  tallyFanVariations,
  variationToken,
  withSubject,
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

  test('`winner` is never a variation: `bench fan --show` reserves it', () => {
    expect(names).not.toContain('winner');
  });

  test('the signedness variations are exactly the ones enumeration pins', () => {
    const signedness = VARIATION_TOKENS.filter((t) => t.variationKind === 'signedness').map((t) => t.name);
    expect(signedness).toEqual(SIGNEDNESS.map((s) => s.variation));
  });

  test('every subject-taking name is the longest match for its own subjects', () => {
    const cases: [string, string, string | undefined][] = [
      ['coalesce-v0-v1', 'coalesce', 'v0-v1'],
      ['coalesce-v1-v0', 'coalesce', 'v1-v0'],
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
      ['orderbase-scoped', 'orderbase-scoped', undefined],
      ['vol-slot', 'vol-slot', undefined],
      ['site-sense', 'site-sense', undefined],
    ];
    for (const [part, name, subject] of cases) {
      expect(parseVariation(part)).toEqual(subject === undefined ? { name } : { name, subject });
    }
  });

  test('withSubject mints exactly what parseVariation reads back, and refuses a subject its pattern does not fit', () => {
    expect(withSubject('coalesce', 'v0-v1')).toBe('coalesce-v0-v1');
    expect(parseVariation(withSubject('regcopy', 'ret-fresh'))).toEqual({ name: 'regcopy', subject: 'ret-fresh' });
    expect(parseVariation(withSubject('homesplit', '0x40000d4.4s'))).toEqual({
      name: 'homesplit',
      subject: '0x40000d4.4s',
    });
    for (const [name, subject] of [
      ['sense', 'a'],
      ['coalesce', ''],
      ['volatile', 'slot'],
      ['regcopy', 'fresh'],
      ['homesplit', 'a/b'],
    ] as const) {
      expect(() => withSubject(name, subject)).toThrow(/takes no subject/);
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
      'scoped',
      'scopebase-coalesce-v2-v4',
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

// A name is printed, typed back, hashed and used as a key through its `/` join, so the join has to
// be injective: two different lists must never print alike.
describe('the `/` join names exactly one list of variations', () => {
  test('a list joins to its printed name and splits back to itself', () => {
    expect(joinVariations(['unsigned', 'defsite', 'raw-globals'])).toBe('unsigned/defsite/raw-globals');
    expect(splitVariations('unsigned/defsite/raw-globals')).toEqual(['unsigned', 'defsite', 'raw-globals']);
    expect(splitVariations(joinVariations(['signed']))).toEqual(['signed']);
  });

  test('an entry holding `/` cannot be joined, so `["a/b"]` and `["a", "b"]` never share a name', () => {
    expect(joinVariations(['a', 'b'])).toBe('a/b');
    expect(() => joinVariations(['a/b'])).toThrow(/cannot be one variation/);
    expect(() => joinVariations(['unsigned', 'orderbase/scoped'])).toThrow(/cannot be one variation/);
  });

  test('an empty entry or an empty list is refused both ways', () => {
    expect(() => joinVariations([])).toThrow();
    expect(() => joinVariations(['unsigned', ''])).toThrow(/cannot be one variation/);
    for (const name of ['', 'unsigned//defsite', '/unsigned', 'unsigned/']) {
      expect(() => splitVariations(name)).toThrow(/cannot be one variation/);
    }
  });
});

// A row's published `fanVariations` is this tally over ranking's partition of its fan.
describe('tallyFanVariations counts the candidates carrying each registered variation', () => {
  type Named = { variations: readonly string[] };
  /** A real fan with subject-taking variations (`volatile-p0`, `homesplit-…`) and three kinds,
   *  split three ways the way ranking partitions one. */
  const fan = enumerateCandidates(
    'dmapoll',
    readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-dmapoll.s'), 'utf8'),
    ARMV4T_AGBCC,
  );
  const third = (r: number): Named[] => fan.filter((_, i) => i % 3 === r);
  const partition = { candidates: third(0), dropped: third(1), withheld: third(2) };
  const carrying = (list: readonly Named[], name: string): number =>
    list.filter((c) => hasVariation(c.variations, name)).length;

  test('the fixture exercises subjects, several kinds and all three lists', () => {
    const parts = fan.flatMap((c) => c.variations);
    expect(parts.some((p) => parseVariation(p).subject !== undefined)).toBe(true);
    expect(new Set(parts.map((p) => variationToken(parseVariation(p).name).variationKind)).size).toBeGreaterThan(2);
    expect(Object.values(partition).every((l) => l.length > 0)).toBe(true);
  });

  test('each count equals a direct count over the enumeration, refusals included', () => {
    const expected = Object.fromEntries(
      names
        .filter((n) => carrying(fan, n) > 0)
        .map((n) => {
          const dropped = carrying(partition.dropped, n);
          const withheld = carrying(partition.withheld, n);
          return [
            n,
            { candidates: carrying(fan, n), ...(dropped ? { dropped } : {}), ...(withheld ? { withheld } : {}) },
          ];
        }),
    );
    expect(tallyFanVariations(partition)).toEqual(expected);
  });

  test('the two signedness entries sum to the fan size', () => {
    const t = tallyFanVariations(partition);
    expect((t.unsigned?.candidates ?? 0) + (t.signed?.candidates ?? 0)).toBe(fan.length);
  });

  test('a candidate counts once under each registered name, however many subjects it applies', () => {
    const t = tallyFanVariations({
      candidates: [{ variations: ['unsigned', 'coalesce-v0-v1', 'coalesce-v2-v3', 'volatile-p0'] }],
      dropped: [{ variations: ['signed', 'volatile', 'raw-globals'] }],
      withheld: [],
    });
    expect(t).toEqual({
      unsigned: { candidates: 1 },
      signed: { candidates: 1, dropped: 1 },
      coalesce: { candidates: 1 },
      volatile: { candidates: 2, dropped: 1 },
      'raw-globals': { candidates: 1, dropped: 1 },
    });
  });

  test('keys run in kind order, then by name, whatever order the fan is listed in', () => {
    const forward = tallyFanVariations(partition);
    const reversed = tallyFanVariations({
      candidates: [...partition.withheld].reverse(),
      dropped: [...partition.dropped].reverse(),
      withheld: [...partition.candidates].reverse(),
    });
    expect(Object.keys(reversed)).toEqual(Object.keys(forward));
    const kinds = Object.keys(forward).map((n) => VARIATION_KINDS.indexOf(variationToken(n).variationKind));
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
    for (const kind of new Set(kinds)) {
      const inKind = Object.keys(forward).filter(
        (n) => VARIATION_KINDS.indexOf(variationToken(n).variationKind) === kind,
      );
      expect(inKind).toEqual([...inKind].sort());
    }
    expect(JSON.stringify(tallyFanVariations({ ...partition, candidates: [...partition.candidates].reverse() }))).toBe(
      JSON.stringify(forward),
    );
  });

  test('an unregistered variation throws', () => {
    expect(() =>
      tallyFanVariations({ candidates: [{ variations: ['unsigned', 'nosuch'] }], dropped: [], withheld: [] }),
    ).toThrow(/names no registered variation/);
  });
});
