import { expect, test } from 'vitest';

import { decodeShare, encodeShare } from '../src/shared/utils/permalink';

test('share state round-trips through the share encoding', () => {
  const s = { target: 'ido7.1', backend: 'c', name: 'add1', asm: '00000000 <add1>:\n   0:\tjr\tra\n' };
  expect(decodeShare(encodeShare(s))).toEqual(s);
});

test('name is omitted when absent and preserved when present', () => {
  const s = { target: 'agbcc', backend: 'pascal', asm: 'clamp0:\n\tcmp r0, #0\n' };
  const round = decodeShare(encodeShare(s));
  expect(round).toEqual(s);
  expect(round && 'name' in round).toBe(false);
});

test('the C++ spec text round-trips', () => {
  const s = { target: 'mwcc_242_81', backend: 'cpp', spec: '{"method":"dot","cls":"Vec"}', asm: 'blr\n' };
  expect(decodeShare(encodeShare(s))).toEqual(s);
});

test('the symbols JSON rides the same channel: omitted when absent, preserved when present', () => {
  const s = {
    target: 'agbcc',
    backend: 'c',
    symbols: '{"0x03001234": [{"name": "gCounter", "kind": "data"}]}',
    asm: 'f:\n\tbx lr\n',
  };
  expect(decodeShare(encodeShare(s))).toEqual(s);
  const bare = decodeShare(encodeShare({ target: 'agbcc', backend: 'c', asm: 'f:\n\tbx lr\n' }));
  expect(bare && 'symbols' in bare).toBe(false);
});

test('garbage payloads decode to null, never throw', () => {
  expect(decodeShare('')).toBeNull();
  expect(decodeShare('not-lz-data-!!!')).toBeNull();
  expect(decodeShare(encodeShare({ target: 'x', backend: 'c', asm: 'y' }).slice(0, 5))).toBeNull();
});
