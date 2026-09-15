// agbcc `-g` leaves `.text` byte-identical at agbcc's canonical level and appends debug output to the
// textual `.s`: `.debug_*` sections after the functions, and marker labels (`.LFB1`, `.LM3`,
// `.LBB2`, …) inside them. The pair (`scripts/regen-flag-pair-probes.ts`) is one source at the
// canonical flags with and without `-g`, and the Thumb frontend must lift exactly the same function
// from both.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const read = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');

test('the -g build carries debug sections and marker labels the plain build does not', () => {
  const plain = read('agbcc-debug.s');
  const debug = read('agbcc-debug-g.s');
  expect(plain).not.toMatch(/\.section\s+\.debug/);
  expect(debug).toMatch(/\.section\s+\.debug/);
  expect(debug).toMatch(/^\.LBB\d+:$/m);
});

// `gcd`'s loop is the case a marker label restructures: `.LBB3` inside the `while` body starts a
// block, and a lift that keeps it spells the loop as an `if` around a `do`.
test.each(['gcd', 'pick'])('%s: the -g build lifts to the same C as the plain build', (sym) => {
  const plain = decompile(sym, read('agbcc-debug.s'), ARMV4T_AGBCC);
  const debug = decompile(sym, read('agbcc-debug-g.s'), ARMV4T_AGBCC);
  expect(plain.diagnostics).toEqual([]);
  expect(debug.diagnostics).toEqual([]);
  expect(debug.source).toBe(plain.source);
});
