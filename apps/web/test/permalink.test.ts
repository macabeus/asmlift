import { expect, test } from 'vitest';

import { decodeShare, encodeShare } from '../src/shared/utils/permalink';

test('share state round-trips through the share encoding', () => {
  const s = { target: 'ido-mips', backend: 'c', name: 'add1', asm: '00000000 <add1>:\n   0:\tjr\tra\n' };
  expect(decodeShare(encodeShare(s))).toEqual(s);
});

test('name is omitted when absent and preserved when present', () => {
  const s = { target: 'agbcc-arm', backend: 'pascal', asm: 'clamp0:\n\tcmp r0, #0\n' };
  const round = decodeShare(encodeShare(s));
  expect(round).toEqual(s);
  expect(round && 'name' in round).toBe(false);
});

test('the C++ spec text round-trips', () => {
  const s = { target: 'mwcc-ppc', backend: 'cpp', spec: '{"method":"dot","cls":"Vec"}', asm: 'blr\n' };
  expect(decodeShare(encodeShare(s))).toEqual(s);
});

test('garbage payloads decode to null, never throw', () => {
  expect(decodeShare('')).toBeNull();
  expect(decodeShare('not-lz-data-!!!')).toBeNull();
  expect(decodeShare(encodeShare({ target: 'x', backend: 'c', asm: 'y' }).slice(0, 5))).toBeNull();
});
