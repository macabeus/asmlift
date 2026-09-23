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
    ['statbuff__9CmdStream', 'cpp-mangled'],
    ['_instances__15PikiShapeObject', 'cpp-mangled'],
    ['TEKI_OPTION_SHADOW_VISIBLE__5BTeki', 'cpp-mangled'],
    ['__ct__Q26Action5ChildFv', 'cpp-mangled'],
  ];
  expect(corpus.map(([s]) => [s, classifyRelocSymbol(s)])).toEqual(corpus.map(([s, k]) => [s, k]));
});

test('exactly the plain kind is spellable; every other kind refuses naming what it saw', () => {
  expect(unspellableReason('minimumVcount')).toBeNull();
  expect(unspellableReason('lbl_1_bss_2464')).toBeNull();
  for (const sym of ['@193', '...bss.0', 'sprHideTbl$797', '__vt__6System', 'statbuff__9CmdStream', 'a-b']) {
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

test('a C++ class-scoped data symbol is refused for the DECLARATION, not for the spelling', () => {
  // pikmin:initSoftReset__9StdSystemFv's relocation. Its lift is CORRECT: the global really is
  // `CmdStream::statbuff`, and — measured in the shape the harness compiles, inside the
  // `extern \"C\"` block a C++ row's candidate is wrapped in — `extern int statbuff__9CmdStream;`
  // references EXACTLY that symbol. What is missing is the declaration: the row's own unit declares
  // the member under its class scope and nothing here decodes that scope, so the candidate would
  // name an identifier no declaration introduces. The refusal must say that, not claim the name is
  // unspellable.
  expect(classifyRelocSymbol('statbuff__9CmdStream')).toBe('cpp-mangled');
  expect(unspellableReason('statbuff__9CmdStream')).toMatch(/can DECLARE it/);
  expect(unspellableReason('statbuff__9CmdStream')).not.toMatch(/not what any source writes/);
});

test('an ordinary C name with a double underscore is NOT mistaken for a mangling', () => {
  // The mangling marker is `__` followed by a class-name LENGTH (or mwcc's `Q<n>` nesting prefix),
  // not a double underscore — a rule that fires on `__` alone would refuse ordinary C globals.
  expect(classifyRelocSymbol('g_my__table')).toBe('plain');
  expect(classifyRelocSymbol('__initialised')).toBe('plain');
});

test('a static counter hung off another kind of name keeps that kind, and its sentence', () => {
  // FAILS ON: testing the gcc counter as a bare `\.\d+$` suffix, or testing it before the two C++
  // prefixes. Under either, all four names below answer `local-static` and then refuse with a
  // sentence about "a translation-unit-wide counter the compiler assigned" — true of `tide.3`,
  // false of a vtable, of a class-scoped member, and of gcc's IPA clones, which are not statics of
  // any kind. The suffix is the weakest evidence in the file and so it is asked last.
  expect(classifyRelocSymbol('__vt__6System.1')).toBe('cpp-vtable');
  expect(classifyRelocSymbol('statbuff__9CmdStream.0')).toBe('cpp-mangled');
  for (const clone of ['foo.isra.0', 'foo.part.0', 'foo.cold.1']) {
    expect(classifyRelocSymbol(clone)).toBe('not-an-identifier');
  }
  expect(unspellableReason('__vt__6System.1')).toMatch(/C\+\+ virtual table/);
  expect(unspellableReason('foo.isra.0')).toMatch(/is not a C identifier/);
});

test('the gcc function-scope static still classifies, base name and counter', () => {
  // The shape the rule is FOR, so the anchoring above cannot be read as having removed it. agbcc
  // spells these; `tide.3` is the one a benchmark row carries.
  expect(classifyRelocSymbol('tide.3')).toBe('local-static');
  expect(classifyRelocSymbol('zeroes.13')).toBe('local-static');
  expect(unspellableReason('tide.3')).toMatch(/function-scope static/);
});
