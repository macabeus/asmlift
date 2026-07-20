// CONTRACT: the Benchmark view's "Open in playground" builder (src/pages/benchmark/lib/playground.ts)
// produces a ShareState in the exact shape the Playground owns (src/shared/utils/permalink.ts). Both live in
// this app, so this is an internal contract — but still worth pinning: a field rename on
// either side would silently break the hand-off (and the shareable permalink it round-trips to).
import type { FunctionResult } from '@asmlift/bench-schema';
import { expect, test } from 'vitest';

import { canOpenInPlayground, playgroundShare } from '../src/pages/benchmark/lib/playground';
import { decodeShare, encodeShare } from '../src/shared/utils/permalink';

const row = (over: Partial<FunctionResult>): FunctionResult =>
  ({ toolchain: 'ido-mips', sym: 'add1', targetAsm: '00000000 <add1>:\n   0:\tjr\tra\n', ...over }) as FunctionResult;

test("a row's share is the exact playground state and round-trips through the permalink codec", () => {
  const share = playgroundShare(row({}))!;
  expect(share).toEqual({
    target: 'ido-mips',
    backend: 'c',
    name: 'add1',
    asm: '00000000 <add1>:\n   0:\tjr\tra\n',
  });
  // The shell hands `share` to the editor and the editor re-encodes it into the `?s=` param — so it
  // must survive an encode/decode round-trip unchanged.
  expect(decodeShare(encodeShare(share))).toEqual(share);
});

test('every benchmark toolchain id is a playground-eligible target', () => {
  for (const t of ['agbcc-arm', 'ido-mips', 'gcc-mips', 'mwcc-ppc'] as FunctionResult['toolchain'][]) {
    expect(canOpenInPlayground(row({ toolchain: t }))).toBe(true);
  }
});

test('oversized asm and unknown toolchains produce no share', () => {
  expect(playgroundShare(row({ targetAsm: 'x'.repeat(40_000) }))).toBeNull();
  // a future toolchain id the playground doesn't know — deliberately outside the union
  expect(playgroundShare(row({ toolchain: 'sh2-future' as FunctionResult['toolchain'] }))).toBeNull();
});
