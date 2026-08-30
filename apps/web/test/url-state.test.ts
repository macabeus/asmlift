// The nuqs glue: the `s=` ShareState parser. The transport is the FRAGMENT (see hash-adapter.ts),
// which round-trips a payload verbatim, so the parser does no repair of its own.
import { expect, test } from 'vitest';

import { encodeShare } from '../src/shared/utils/permalink';
import { parseAsShareState } from '../src/shared/utils/url-state';

const share = { target: 'agbcc', backend: 'c', name: 'add1', asm: 'add1:\n\tadd r0, r0, #1\n\tbx lr\n' };

test('ShareState round-trips through the s= parser', () => {
  expect(parseAsShareState.parse(parseAsShareState.serialize(share))).toEqual(share);
});

test('a payload containing + parses as-is: the parser does no repair of its own', () => {
  // '+' is in lz-string's URI alphabet, and it was the reason url-state.ts used to pre-rewrite
  // ' ' -> '+'. That rewrite was inert twice over: the fragment transport round-trips '+'
  // verbatim, and lz-string's own decompressFromEncodedURIComponent already does
  // `input.replace(/ /g, "+")` (lz-string/libs/lz-string.js:102). So the parser is plain
  // decodeShare, and this pins that a '+'-carrying payload survives it untouched.
  let s = share;
  let encoded = encodeShare(s);
  for (let i = 0; !encoded.includes('+') && i < 500; i++) {
    s = { ...share, asm: `${share.asm}// pad ${i}\n` };
    encoded = encodeShare(s);
  }
  expect(encoded).toContain('+');
  expect(parseAsShareState.parse(encoded)).toEqual(s);
});

test('garbage s= values parse to null, never throw', () => {
  expect(parseAsShareState.parse('not-lz-data-!!!')).toBeNull();
  expect(parseAsShareState.parse('')).toBeNull();
});
