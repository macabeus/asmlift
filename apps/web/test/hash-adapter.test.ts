// The fragment transport: pure string <-> URLSearchParams helpers behind the nuqs hash adapter.
// Everything here is string-level, so it runs in vitest's node environment with no DOM.
import { expect, test } from 'vitest';

import { hashToSearchParams, hashUrl, searchParamsToHash } from '../src/shared/utils/hash-adapter';
import { encodeShare } from '../src/shared/utils/permalink';
import { parseAsShareState } from '../src/shared/utils/url-state';

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
  expect(hashToSearchParams(searchParamsToHash(params)).get('x')).toBe(nasty);
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
  const back = hashToSearchParams(searchParamsToHash(params)).get('s');
  expect(back).toBe(encoded);
  expect(parseAsShareState.parse(back!)).toEqual(state);
});

test('an empty param set makes an empty fragment, and hashUrl then writes no #', () => {
  expect(searchParamsToHash(new URLSearchParams())).toBe('');
  expect(hashUrl('https://x.test/asmlift/?keep=1#view=benchmark', new URLSearchParams())).toBe(
    'https://x.test/asmlift/?keep=1',
  );
});

test('hashUrl changes only the fragment', () => {
  const params = new URLSearchParams();
  params.set('view', 'benchmark');
  params.set('s', 'a+b');
  expect(hashUrl('https://x.test/asmlift/?keep=1#old=1', params)).toBe(
    'https://x.test/asmlift/?keep=1#view=benchmark&s=a%2Bb',
  );
});

test('a 200,000-character payload round-trips (the fragment has no transport ceiling)', () => {
  const huge = 'A'.repeat(200_000);
  const params = new URLSearchParams();
  params.set('s', huge);
  expect(hashToSearchParams(searchParamsToHash(params)).get('s')).toBe(huge);
});
