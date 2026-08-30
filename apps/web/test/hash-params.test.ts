// The fragment transport: pure string <-> URLSearchParams helpers behind the nuqs hash adapter.
// Everything here is string-level, so it runs in vitest's node environment with no DOM.
import { expect, test } from 'vitest';

import { createSnapshotCache, hashToSearchParams, hashUrl, pickKeys } from '../src/shared/utils/hash-params';
import { encodeShare } from '../src/shared/utils/permalink';
import { parseAsShareState } from '../src/shared/utils/url-state';

/** The WHOLE write-then-read path, not a string-level shortcut: params -> the URL the adapter
 *  hands to `pushState` -> what `location.hash` gives back -> params. `URL`'s hash setter is the
 *  one platform component that could re-encode a payload, and only this route touches it. */
function throughTheFragment(params: URLSearchParams): URLSearchParams {
  return hashToSearchParams(new URL(hashUrl('https://x.test/asmlift/', params)).hash);
}

test('hashToSearchParams strips exactly one leading #, and tolerates none', () => {
  expect([...hashToSearchParams('')]).toEqual([]);
  // `new URLSearchParams('#')` on its own yields one entry keyed '#': the strip must be ours.
  expect([...hashToSearchParams('#')]).toEqual([]);
  expect([...hashToSearchParams('#a=1&b=2')]).toEqual([
    ['a', '1'],
    ['b', '2'],
  ]);
  expect(hashToSearchParams('a=1&b=2').toString()).toBe(hashToSearchParams('#a=1&b=2').toString());
});

test('a hostile value round-trips through the fragment verbatim', () => {
  const nasty = 'a b+c&d=e%f#g"h<i>j`k/l:m?n';
  const params = new URLSearchParams();
  params.set('x', nasty);
  expect(throughTheFragment(params).get('x')).toBe(nasty);
});

test('a real lz-string ShareState whose encoding contains + round-trips through the fragment', () => {
  const base = {
    target: 'agbcc',
    backend: 'c',
    name: 'add1',
    asm: 'add1:\n\tadd r0, r0, #1\n\tbx lr\n',
  };
  // Grow the payload until the lz-string alphabet actually emits a '+' — that character is the
  // one the query-string transport used to mangle into a space.
  let state = base;
  let encoded = encodeShare(state);
  for (let i = 0; !encoded.includes('+') && i < 500; i++) {
    state = { ...base, asm: `${base.asm}// pad ${i}\n` };
    encoded = encodeShare(state);
  }
  expect(encoded).toContain('+');

  const params = new URLSearchParams();
  params.set('s', encoded);
  const back = throughTheFragment(params).get('s');
  expect(back).toBe(encoded);
  expect(parseAsShareState.parse(back!)).toEqual(state);
});

test('an empty param set makes an empty fragment, and hashUrl then writes no #', () => {
  expect(hashUrl('https://x.test/asmlift/#view=benchmark', new URLSearchParams())).toBe('https://x.test/asmlift/');
});

test('hashUrl replaces the fragment and DROPS the query — this app reads none', () => {
  const params = new URLSearchParams();
  params.set('view', 'benchmark');
  params.set('s', 'a+b');
  // The `?s=` is a dead pre-fragment permalink: without the drop it rides along through every
  // share, reload and tab switch, and is counted by the Share button's 20k length warning.
  expect(hashUrl('https://x.test/asmlift/?s=DEAD-LEGACY-PAYLOAD#old=1', params)).toBe(
    'https://x.test/asmlift/#view=benchmark&s=a%2Bb',
  );
});

test('a 200,000-character payload round-trips through the fragment (no transport ceiling)', () => {
  const huge = 'A'.repeat(200_000);
  const params = new URLSearchParams();
  params.set('s', huge);
  expect(throughTheFragment(params).get('s')).toBe(huge);
});

// --- key isolation: nuqs's own filterSearchParams is internal (no hit in any dist/**/*.d.ts),
// so this is a reimplementation, and these are its tests.

const explorer = () =>
  new URLSearchParams('view=benchmark&tab=explorer&project=kleod&feature=loop&feature=table&s=xyz');

test('pickKeys keeps only the watched keys, in their original order', () => {
  expect(pickKeys(explorer(), ['s', 'view']).toString()).toBe('view=benchmark&s=xyz');
});

test('pickKeys with no keys watches everything (nuqs asks for that on the empty set)', () => {
  expect(pickKeys(explorer(), []).toString()).toBe(explorer().toString());
});

test('pickKeys keeps every value of a repeated key', () => {
  expect(pickKeys(explorer(), ['feature']).getAll('feature')).toEqual(['loop', 'table']);
});

test('pickKeys does not mutate its input, and is stable across calls', () => {
  const source = explorer();
  const before = source.toString();
  const a = pickKeys(source, ['view']).toString();
  const b = pickKeys(source, ['view']).toString();
  // That string IS the getSnapshot cache key, so equal input must give an equal key.
  expect(a).toBe(b);
  expect(source.toString()).toBe(before);
});

test('pickKeys drops a watched key that is absent rather than inventing it', () => {
  expect(pickKeys(explorer(), ['nope']).toString()).toBe('');
});

// --- the getSnapshot cache: `useSyncExternalStore` compares with Object.is, so these are
// IDENTITY assertions, not value assertions. They are the two properties that decide whether the
// app re-renders too much (isolation) or not at all (liveness).

test('createSnapshotCache preserves object identity when only an UNWATCHED key moves', () => {
  const snap = createSnapshotCache();
  expect(snap('#view=a&s=1', ['s'])).toBe(snap('#view=b&s=1', ['s']));
  // ... and when nothing moves at all, which is what stops the infinite-loop warning.
  expect(snap('#view=b&s=1', ['s'])).toBe(snap('#view=b&s=1', ['s']));
});

test('createSnapshotCache returns a NEW object when a watched key moves', () => {
  const snap = createSnapshotCache();
  expect(snap('#s=1', ['s'])).not.toBe(snap('#s=2', ['s']));
  expect(snap('#s=2', ['s']).get('s')).toBe('2');
  // Watching everything (nuqs's empty-keys case) still tracks every key.
  const all = createSnapshotCache();
  expect(all('#view=a', [])).not.toBe(all('#view=b', []));
});

test('createSnapshotCache gives each caller its own cell, and takes the hash with or without #', () => {
  const a = createSnapshotCache();
  const b = createSnapshotCache();
  expect(a('#s=1', ['s'])).not.toBe(b('#s=1', ['s']));
  expect(a('#s=1', ['s'])).toBe(a('s=1', ['s']));
});
