// The nuqs glue: the ?s= ShareState parser, including the URLSearchParams '+' → space quirk.
import { expect, test } from 'vitest';

import { encodeShare } from '../src/shared/utils/permalink';
import { parseAsShareState } from '../src/shared/utils/url-state';

const share = { target: 'agbcc', backend: 'c', name: 'add1', asm: 'add1:\n\tadd r0, r0, #1\n\tbx lr\n' };

test('ShareState round-trips through the ?s= parser', () => {
  expect(parseAsShareState.parse(parseAsShareState.serialize(share))).toEqual(share);
});

test("a '+' decoded to a space by URLSearchParams is restored before lz decoding", () => {
  // Find a state whose encoding actually contains '+' (the lz URI alphabet includes it), then
  // simulate what URLSearchParams hands the parser: every '+' already turned into a space.
  let s = share;
  let encoded = encodeShare(s);
  for (let i = 0; !encoded.includes('+') && i < 500; i++) {
    s = { ...share, asm: `${share.asm}// pad ${i}\n` };
    encoded = encodeShare(s);
  }
  expect(encoded).toContain('+');
  expect(parseAsShareState.parse(encoded.replaceAll('+', ' '))).toEqual(s);
});

test('garbage ?s= values parse to null, never throw', () => {
  expect(parseAsShareState.parse('not-lz-data-!!!')).toBeNull();
  expect(parseAsShareState.parse('')).toBeNull();
});
