// PowerPC global recovery from relocations, and the symbol-naming policy that decides which
// recovered names may be written down at all. The sibling capability is frontend/mips.ts's
// `%hi`/`%lo` fold (test/mips-reloc-globals.test.ts); the listings here are hand-authored in the
// exact shape mwcc's objdump prints, relocation lines and all.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';

const dis = (sym: string, lines: string) => decompile(sym, `0 <${sym}>:\n${lines}`, PPC_MWCC).source;

// Each refusing kind of the naming policy, seen through a real lift. The symbol spellings are
// corpus spellings; the point of each case is that the refusal SAYS WHICH KIND it saw, so a reader
// of the artifact learns why the row is a dead end rather than a capability gap.
test('an anonymous constant pool entry is refused by name', () => {
  const asm = '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\t@193\n   4:\tblr\n';
  expect(() => dis('pool', asm)).toThrow(/anonymous constant pool entry \('@193'\)/);
});

test('a section-relative label is refused by name', () => {
  const asm = '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\t...bss.0\n   4:\tblr\n';
  expect(() => dis('sect', asm)).toThrow(/section-relative label \('\.\.\.bss\.0'\)/);
});

test("a function-scope static's mangled name is refused by name", () => {
  const asm = '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\tsprHideTbl$797\n   4:\tblr\n';
  expect(() => dis('stat', asm)).toThrow(/function-scope static \('sprHideTbl\$797'\)/);
});

test('a C++ vtable is refused although declaring it would compile', () => {
  // `extern u32 __vt__6System;` is valid C — nothing downstream would object. Only the policy
  // catches it, and this is the `unksp0` failure mode the policy exists to prevent.
  const asm = '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\t__vt__6System\n   4:\tblr\n';
  expect(() => dis('vt', asm)).toThrow(/C\+\+ virtual table \('__vt__6System'\)/);
});

test('a spellable symbol still declines as a capability gap, not as an unspellable name', () => {
  // The two refusals must stay distinguishable: `g_fdinfo` is an ordinary extern, so the reason
  // this declines is that nothing folds the halves yet — a gap, not a dead end.
  const asm = '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\tg_fdinfo\n   4:\tblr\n';
  expect(() => dis('plain', asm)).toThrow(/carries a data relocation \('g_fdinfo'\)/);
});
