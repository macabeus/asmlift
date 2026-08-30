// The nuqs glue: the `s=` ShareState parser. The transport is the FRAGMENT (see hash-adapter.ts),
// which round-trips a payload verbatim, so the parser does no repair of its own — the '+'-carrying
// payload that proves it is exercised end to end in hash-params.test.ts.
import { expect, test } from 'vitest';

import { parseAsShareState } from '../src/shared/utils/url-state';

const share = { target: 'agbcc', backend: 'c', name: 'add1', asm: 'add1:\n\tadd r0, r0, #1\n\tbx lr\n' };

test('ShareState round-trips through the s= parser', () => {
  expect(parseAsShareState.parse(parseAsShareState.serialize(share))).toEqual(share);
});

test('garbage s= values parse to null, never throw', () => {
  expect(parseAsShareState.parse('not-lz-data-!!!')).toBeNull();
  expect(parseAsShareState.parse('')).toBeNull();
});
