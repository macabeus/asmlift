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

test('a spellable symbol is never refused BY NAME — its decline is structural', () => {
  // The two refusals must stay distinguishable. `g_fdinfo` is an ordinary extern, so nothing about
  // the NAME stops it; this listing declines because the `@ha` half has no `@l` completing it.
  const asm = '   0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA\tg_fdinfo\n   4:\tblr\n';
  expect(() => dis('plain', asm)).toThrow(/no modelled instruction consumes its '@l' half/);
  expect(() => dis('plain', asm)).not.toThrow(/no C source|cannot enter|nothing to declare/);
});

// ── the small-data (SDA) memory operand ────────────────────────────────────────────────────────
// `R_PPC_EMB_SDA21` is the simpler half of the same capability: one relocation, one instruction,
// nothing to pair. The printed `0(0)` says nothing — the linker substitutes r13/r2 for the base
// register and a section-relative displacement for the offset — so the address is exactly the
// relocation's symbol plus its addend.

test('an SDA load recovers the named global rather than a read through a fabricated base', () => {
  // marioparty4:HuSysVWaitGet, verbatim, whose reference source is `return (s16) minimumVcount;`.
  const asm = '   0:\tlwz     r0,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\tminimumVcount\n   4:\textsh   r3,r0\n   8:\tblr\n';
  expect(dis('HuSysVWaitGet', asm)).toContain('minimumVcount');
});

test('an SDA store writes the named global', () => {
  const asm = '   0:\tstw     r3,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\tboardRandSeed\n   4:\tblr\n';
  expect(dis('setseed', asm)).toContain('boardRandSeed = ');
});

test("the relocation's addend picks the word — SYM and SYM+0x4 are different accesses", () => {
  // marioparty4:SLSerialNoCheck's shape. Before the addend was carried, both relocations read the
  // same name and the second load silently read the wrong word.
  const asm =
    '   0:\tlwz     r3,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\tSLSerialNo\n' +
    '   4:\tlwz     r4,0(0)\n\t\t\t4: R_PPC_EMB_SDA21\tSLSerialNo+0x4\n' +
    '   8:\tadd     r3,r3,r4\n   c:\tblr\n';
  const src = dis('serial', asm);
  expect(src).toContain('&SLSerialNo'); // the symbol is recovered…
  expect(src).toContain('p0[1]'); // …and the +4 access is the NEXT word
  // Rendering-independent: the same listing with BOTH relocations at +0 must differ, which is the
  // whole content of "the addend is part of the address".
  expect(src).not.toBe(dis('serial', asm.replace('SLSerialNo+0x4', 'SLSerialNo')));
});

test('`li rD,0` under the same relocation is the ADDRESS of the global', () => {
  // SDA21 address formation encodes rA=0, so objdump prints `li rD,0`; the linker rewrites it to
  // `addi rD,r13,SYM@sdarx`. Same relocation, same recovery — a different operand field.
  const asm = '   0:\tli      r3,0\n\t\t\t0: R_PPC_EMB_SDA21\tgSda\n   4:\tblr\n';
  expect(dis('addrof', asm)).toContain('&gSda');
});

test('an SDA relocation whose printed operand is not the placeholder refuses, naming what it saw', () => {
  // The recovery DISCARDS the printed operand, so it must first prove the operand says nothing.
  // A linked listing prints a real base and displacement; lifting that as `&SYM + 0` would be wrong.
  const asm = '   0:\tlwz     r3,-32752(r2)\n\t\t\t0: R_PPC_EMB_SDA21\tgSda\n   4:\tblr\n';
  expect(() => dis('linked', asm)).toThrow(/not the expected '0\(0\)' placeholder/);
});

test('a `0(0)` base with NO relocation still refuses loudly', () => {
  // The recovery is driven by the relocation, never by the printed placeholder: without a symbol
  // there is nothing to name, and the old refusal must survive untouched.
  expect(() => dis('noreloc', '   0:\tstw     r3,0(0)\n   4:\tblr\n')).toThrow(
    /SDA\/global-relative access not supported/,
  );
});

test('an SDA relocation naming an unspellable symbol refuses by kind and recovers nothing', () => {
  // The naming policy runs BEFORE the recovery, so `@6` never reaches the declaration minter.
  const asm = '   0:\tlwz     r3,0(0)\n\t\t\t0: R_PPC_EMB_SDA21\t@6\n   4:\tblr\n';
  expect(() => dis('pool', asm)).toThrow(/anonymous constant pool entry \('@6'\)/);
});

// ── the `@ha`/`@l` pair: the immediate half of the same capability ─────────────────────────────
// `lis rD,SYM@ha` + `addi rD,rD,SYM@l` materialises an absolute address across TWO instructions,
// and in a relocatable object both printed immediates are 0 — the address lives entirely in the
// pair of relocation records. The high half is never written; the `gaddr` is emitted where the low
// half lands, exactly as frontend/mips.ts folds `lui %hi` into its `%lo` consumer.

test('an adjacent `@ha`/`@l` pair recovers the named global', () => {
  // ac-decomp:bite_check's opening, verbatim: `(GYOEI_ACTOR *)aGYO_ctrlActor`.
  const asm =
    '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\taGYO_ctrlActor\n' +
    '   4:\taddi    r4,r4,0\n\t\t\t6: R_PPC_ADDR16_LO\taGYO_ctrlActor\n' +
    '   8:\tlwz     r3,0(r4)\n   c:\tblr\n';
  expect(dis('bite_check', asm)).toContain('aGYO_ctrlActor');
});

test('a pair eleven instructions apart folds — the pairing never looks at adjacency', () => {
  // pikmin:searchKanjiCode__FUs's shape: the `lis` is hoisted to the top of the prologue and its
  // `addi` lands after six unrelated instructions. 26% of the corpus's pairs are not adjacent.
  const filler = [2, 3, 4, 5, 6, 7].map((k) => `  ${k}0:\tli      r${k + 20},${k}\n`).join('');
  const asm =
    '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tkanji_convert_table\n' +
    filler +
    '  80:\taddi    r29,r4,0\n\t\t\t82: R_PPC_ADDR16_LO\tkanji_convert_table\n' +
    '  84:\tlbz     r3,0(r29)\n  88:\tblr\n';
  expect(dis('searchKanji', asm)).toContain('kanji_convert_table');
});

test('a register REUSED between the two halves refuses rather than pairing across the overwrite', () => {
  // `mr r4,r3` redefines the register between the halves, so the `addi` is completing something
  // else entirely. Pairing by symbol and order alone would fold it and emit a wrong address.
  const asm =
    '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tgSym\n' +
    '   4:\tmr      r4,r3\n' +
    '   8:\taddi    r5,r4,0\n\t\t\ta: R_PPC_ADDR16_LO\tgSym\n' +
    '   c:\tblr\n';
  expect(() => dis('reuse', asm)).toThrow(/r4 holds no high half|never completed/);
});

test('the high half read as a VALUE refuses, naming the symbol it belongs to', () => {
  // The `lis` leaves r4 unwritten on purpose, so a read of r4 would hand back whatever def reached
  // before it. That is the silent-wrong-address case this whole design exists to make impossible.
  const asm = '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tgSym\n' + '   4:\tadd     r3,r4,r5\n   8:\tblr\n';
  expect(() => dis('halfval', asm)).toThrow(/r4 holds the high half of 'gSym'/);
});

test('an `@ha` whose `@l` never arrives refuses — the `lis` is not silently dropped', () => {
  const asm = '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tgSym\n   4:\tli      r3,0\n   8:\tblr\n';
  expect(() => dis('dangling', asm)).toThrow(/no modelled instruction consumes its '@l' half/);
});

test('the `@l` consumers this frontend does not model still refuse — none of them completes quietly', () => {
  // Only `addi` is modelled, because only `addi` has an inhabitant. The other two shapes that can
  // carry `R_PPC_ADDR16_LO` each refuse at their OWN guard, reached before the dangling-`@ha` one:
  // a float load has no register destination to degrade, and `ori` is a relocation placeholder.
  // What matters is that neither one silently completes the address.
  const flt =
    '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tgFloat\n' +
    '   4:\tlfs     f1,0(r4)\n\t\t\t6: R_PPC_ADDR16_LO\tgFloat\n' +
    '   8:\tblr\n';
  expect(() => dis('flt', flt)).toThrow(/unmodelled effect instruction 'lfs'/);
  const ori =
    '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tgVal\n' +
    '   4:\tori     r4,r4,0\n\t\t\t6: R_PPC_ADDR16_LO\tgVal\n' +
    '   8:\tblr\n';
  expect(() => dis('ori', ori)).toThrow(/'ori' at 0x4 carries a data relocation \('gVal'\)/);
});

test('an `@l` whose symbol differs from the pending `@ha` refuses', () => {
  const asm =
    '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tgOne\n' +
    '   4:\taddi    r5,r4,0\n\t\t\t6: R_PPC_ADDR16_LO\tgTwo\n' +
    '   8:\tblr\n';
  expect(() => dis('mixed', asm)).toThrow(/r4 holds the high half of 'gOne'/);
});

test('an `@l` with no `@ha` at all refuses', () => {
  const asm = '   0:\taddi    r5,r4,0\n\t\t\t2: R_PPC_ADDR16_LO\tgSym\n   4:\tblr\n';
  expect(() => dis('loonly', asm)).toThrow(/r4 holds no high half/);
});

test('an unspellable `@ha` symbol is refused by kind before anything is paired', () => {
  const asm =
    '   0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\t@1135\n' +
    '   4:\taddi    r4,r4,0\n\t\t\t6: R_PPC_ADDR16_LO\t@1135\n' +
    '   8:\tblr\n';
  expect(() => dis('poolpair', asm)).toThrow(/anonymous constant pool entry \('@1135'\)/);
});
