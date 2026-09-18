// The symbol-naming policy (frontend/reloc-symbol.ts), pinned against the spellings that actually
// occur in the GameCube corpus rather than invented ones. Every symbol below was taken from an
// `R_PPC_ADDR16_*` / `R_PPC_EMB_SDA21` line in a benchmark row's own objdump listing.
import { expect, test } from 'vitest';

import { classifyRelocSymbol, unspellableReason } from '../src/frontend/reloc-symbol';

test('every corpus spelling classifies as the kind the policy names', () => {
  const corpus: [string, string][] = [
    // plain externals — the decomp projects' own headers declare these
    ['aGYO_ctrlActor', 'plain'],
    ['minimumVcount', 'plain'],
    ['g_fdinfo', 'plain'],
    ['kanji_convert_table', 'plain'],
    ['SLSerialNo', 'plain'],
    // generated REL labels are ORDINARY names: the project declares them and its sources spell them
    ['lbl_1_bss_2464', 'plain'],
    ['lbl_1_data_EC', 'plain'],
    ['fn_1_458', 'plain'],
    // the four unspellable kinds
    ['@193', 'anon-pool'],
    ['@1135', 'anon-pool'],
    ['...bss.0', 'section-local'],
    ['...data.0', 'section-local'],
    ['sprHideTbl$797', 'local-static'],
    ['t_seiyo_days_tbl$32', 'local-static'],
    ['__vt__6System', 'cpp-vtable'],
    ['__vt__12RefCountable', 'cpp-vtable'],
  ];
  expect(corpus.map(([s]) => [s, classifyRelocSymbol(s)])).toEqual(corpus.map(([s, k]) => [s, k]));
});

test('exactly the plain kind is spellable; every other kind refuses naming what it saw', () => {
  expect(unspellableReason('minimumVcount')).toBeNull();
  expect(unspellableReason('lbl_1_bss_2464')).toBeNull();
  for (const sym of ['@193', '...bss.0', 'sprHideTbl$797', '__vt__6System', 'a-b']) {
    expect(unspellableReason(sym)).toContain(sym); // the message says which name was refused
  }
});

test('a C++ vtable is refused although `extern u32 __vt__6System;` would COMPILE', () => {
  // The whole point of the policy: this name passes every downstream check — it is a valid C
  // identifier and nothing would reject the declaration. Only a rule about the KIND catches it.
  expect(classifyRelocSymbol('__vt__6System')).toBe('cpp-vtable');
  expect(unspellableReason('__vt__6System')).toMatch(/virtual table/);
});

test('a name of no known kind that is not an identifier is still refused, not passed through', () => {
  // The catch-all is what makes the policy safe against a spelling the corpus has not shown:
  // an unrecognised shape refuses rather than reaching the declaration minter.
  expect(classifyRelocSymbol('foo.bar')).toBe('not-an-identifier');
  expect(classifyRelocSymbol('2bad')).toBe('not-an-identifier');
  expect(unspellableReason('foo.bar')).toMatch(/not a C identifier/);
});
