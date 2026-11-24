// THE UNSIGNED PIN'S DECLINE, HELD FOR THE SIGNED ONE (rank.ts). `bound-plus-one-counter-wraps` is
// the one structure refusal that reads how the signedness pin declared a counter, so IDO's counted
// loop takes its `for` under the `s32` pin and not the `u32` one; the case body's exit flag
// spells the `u32` reading, so `sw_gotocase2` holds nothing. The fixtures are the benchmark's
// own `synthetic:sw_gotocase2` and `synthetic:sw_gotocase_inner` objects on ido7.1. Toolchain-free.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { parseAsmData } from '../src/frontend/asmdata';
import { enumerateCandidates } from '../src/rank';
import { TOOLCHAIN_TARGETS } from '../src/target';

const corpus = (f: string) => readFileSync(new URL(`corpus/${f}`, import.meta.url), 'utf8');

const enumerate = (sym: string, stem: string) => {
  const dump = corpus(`${stem}.txt`);
  const threw: string[] = [];
  const run = () =>
    enumerateCandidates(sym, corpus(`${stem}.asm`), TOOLCHAIN_TARGETS['ido7.1'].description, {
      prototypes: { [sym]: { returnsVoid: true }, k: { params: 1, returnsVoid: true } },
      asmData: parseAsmData(dump, dump, dump, true),
      onEnumerationError: (v) => threw.push(v.join('/')),
    });
  return { run, threw };
};

test('the unsigned pin builds candidates: the case exit flag spells its loop', () => {
  // under the `u32` pin the counted loop takes no `for`, and its switch's exit past the code after
  // it is spelled with the case body's exit flag (structure.ts `CaseExitRanking`), so nothing is
  // held and both pins build candidates
  const e = enumerate('sw_gotocase2', 'ido71-swgotocase2');
  const cands = e.run();
  expect(cands.some((c) => c.variations[0] === 'signed')).toBe(true);
  expect(cands.some((c) => c.variations[0] === 'unsigned')).toBe(true);
  expect(e.threw).toEqual([]);
}, 60_000);

test('a decline the counter rule did not cause aborts the row, though the rule fired', () => {
  // the rule fires on this function's counted loop, but the decline is the inner switch's case that
  // leaves both switches for the loop's exit, which no pin changes: the row aborts at the unsigned
  // default, as any other default decline does
  const e = enumerate('sw_gotocase_inner', 'ido71-swgotocaseinner');
  expect(e.run).toThrow(/a case body leaves its switch for a loop exit past the switch's end/);
  expect(e.threw).toEqual([]);
}, 60_000);
