// A NARROWING EXTENSION FUSED WITH ITS SCALE (raise/extscale.ts). agbcc's combiner merges the right
// half of a cast's shift pair with a following left shift, so `(u8)x << 3` is `lsl #24; lsr #21`.
// The fold re-splits it into `shl(zext8(x), 3)`; the refusals keep it off every other pair of
// shifts, and the placement is what lets raise/paramwidth.ts see a declared width that the fused
// pair hid.
//
// The corpus fixtures are real agbcc output, compiled with this benchmark's own command:
//   agbcc-extscale-narrow.s  void extscale(u8 a, u8 b)  { gA |= 4; gB = (u32)&gT + a * 4;     gC = b; }
//   agbcc-extscale-wide.s    void extscale(u32 a, u8 b) { gA |= 4; gB = (u32)&gT + (u8)a * 4; gC = b; }
//   agbcc-extscale-table.s   void entrylookup(u8 idx) { u8 *flags = gFlags; const u8 *t = gTable;
//                              const u8 *e = &t[(u32)idx * 8]; flags[0x11] = e[5]; flags[0x12] = e[6]; }
//   agbcc-extscale-pool.s    void extscale(u32 a) { gB = (u32)&gT + (u8)a * 4; }
//   agbcc-extscale-unclaimed.s  void extscale(u8 a, u8 b, u16 *p) { u32 i; a++;
//                              for (i = 0; i < 5; i++) p[i] = (p[i] & 0xfff) | (b << 12); gB = a; }
// The first two differ ONLY in where the `lsl r0, r0, #0x18` sits — prologue against body — and
// must reach different signatures. The third is a body cast with nothing but a pool load ahead of
// it, the shape paramwidth's scan cannot tell from a prologue. Toolchain-free: the round trip is
// the matching suite's (packages/cli/test/matching/extscale.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { dce } from '../src/pattern/engine';
import { decompile } from '../src/pipeline';
import { recognizeArrays } from '../src/raise/arrays';
import { foldScaledExtensions, foldsShiftPairCasts, restoreUnclaimedScales } from '../src/raise/extscale';
import { narrowEntryParams } from '../src/raise/paramwidth';
import { PRE_RECOVERY_PASSES } from '../src/raise/pre-recovery';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC } from '../src/target';

const fold = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = foldScaledExtensions(fn);
  verify(fn);
  return { n, ir: print(fn) };
};

/** `shr(shl(%0, L), R)` feeding a store, the shape the Thumb frontend lifts a shift pair to. */
const pair = (l: number, r: number, shr = 'shr_u') => `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = shl %0 {imm=${l}}
  %3: unk32 = ${shr} %2 {imm=${r}}
  store %1, %3 {off=0, width=4}
  ret
}
`;

const corpus = (file: string) => readFileSync(join(import.meta.dirname, 'corpus', file), 'utf8');
const source = (sym: string, file: string) =>
  decompile(sym, corpus(file), ARMV4T_AGBCC, { prototypes: { [sym]: { returnsVoid: true } } }).source;

describe('the fold', () => {
  test('`x << 24 >>u 21` is `zext8(x) << 3`', () => {
    const { n, ir } = fold(pair(24, 21));
    expect(n).toBe(1);
    expect(ir).toContain('= zext %0 {width=8}');
    expect(ir).toMatch(/= shl %\d+ \{imm=3\}/);
    expect(ir).not.toContain('shr_u');
  });

  test('`x << 16 >>s 15` is `sext16(x) << 1`', () => {
    const { n, ir } = fold(pair(16, 15, 'shr_s'));
    expect(n).toBe(1);
    expect(ir).toContain('= sext %0 {width=16}');
    expect(ir).toMatch(/= shl %\d+ \{imm=1\}/);
  });

  test('the extension is placed where the `shl` stood, the scale where the right shift stood', () => {
    // Body code between the two halves — the narrow fixture's shape. The extension must come out
    // AHEAD of the store, or paramwidth reads it as body code.
    const { ir } = fold(`fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = shl %0 {imm=24}
  %3: unk32 = const {value=1}
  store %1, %3 {off=0, width=4}
  %4: unk32 = shr_u %2 {imm=22}
  store %1, %4 {off=4, width=4}
  ret
}
`);
    const lines = ir.split('\n').map((l) => l.trim());
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(at(/= zext %0/)).toBeLessThan(at(/^store %1, %\d+ \{off=0/));
    expect(at(/= shl %\d+ \{imm=2\}/)).toBeGreaterThan(at(/^store %1, %\d+ \{off=0/));
  });

  test('two scales off one `shl` share one extension', () => {
    const { n, ir } = fold(`fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = shl %0 {imm=24}
  %3: unk32 = shr_u %2 {imm=22}
  store %1, %3 {off=0, width=4}
  %4: unk32 = shr_u %2 {imm=21}
  store %1, %4 {off=4, width=4}
  ret
}
`);
    expect(n).toBe(2);
    expect(ir.match(/= zext /g)).toHaveLength(1);
  });
});

describe('refusals — every other pair of shifts is left as it is', () => {
  test('`R == L` is the plain cast, CAST_PATTERNS territory', () => {
    expect(fold(pair(24, 24)).n).toBe(0);
  });

  test('`R > L` is a bitfield extract, which scales nothing', () => {
    expect(fold(pair(24, 28)).n).toBe(0);
    expect(fold(pair(16, 20, 'shr_s')).n).toBe(0);
  });

  test('a width no C cast spells', () => {
    // `lsl #28; lsr #26` is `(x & 15) << 2`
    expect(fold(pair(28, 26)).n).toBe(0);
  });

  test('a two-register shift carries no amount to read', () => {
    expect(
      fold(`fn f {
^bb0(%0: unk32, %1: unk32, %2: s32*):
  %3: unk32 = shl %0 {imm=24}
  %4: unk32 = shr_u %3, %1
  store %2, %4 {off=0, width=4}
  ret
}
`).n,
    ).toBe(0);
  });

  test('the pass runs where the cast idiom does, and nowhere else', () => {
    const pass = PRE_RECOVERY_PASSES.find((p) => p.id === 'extscale')!;
    expect(pass.gate).toBe(foldsShiftPairCasts);
    expect(foldsShiftPairCasts(ARMV4T_AGBCC)).toBe(true);
    // Both MIPS compilers zero-extend with `andi`, so a `sll; srl` there is not a cast's lowering.
    // MIPS gcc is where the gate has inhabitants: with it ablated, the fold fires on 6 of the
    // benchmark's non-agbcc rows, all gcc2.7.2/gcc2.7.2kmc (`sll 16; sra 13` is a real shift pair
    // there), and on none under IDO or mwcc.
    expect(foldsShiftPairCasts(MIPS_GCC)).toBe(false);
    expect(foldsShiftPairCasts(MIPS_IDO)).toBe(false);
    expect(foldsShiftPairCasts(PPC_MWCC)).toBe(false);
  });
});

describe('the body cast behind a pool load — the order is read off the LIFTED entry block', () => {
  const behind = (first: string, second: string) => `fn f {
^bb0(%0: unk32):
  ${first}
  ${second}
  %3: unk32 = shr_u %2 {imm=22}
  %4: unk32 = add %3, %1
  store %1, %4 {off=0, width=4}
  ret
}
`;
  const gaddr = '%1: unk32 = gaddr {sym="gB"}';

  test("an entry parameter's pair whose `shl` follows a pool load is left as it is", () => {
    expect(fold(behind(gaddr, '%2: unk32 = shl %0 {imm=24}')).n).toBe(0);
  });

  test('the same pair ahead of the pool load folds — the declared-parameter order', () => {
    expect(fold(behind('%2: unk32 = shl %0 {imm=24}', gaddr)).n).toBe(1);
  });

  test('a pair over a BODY value folds wherever it sits — no width pass reads it', () => {
    const { n } = fold(`fn f {
^bb0(%0: unk32):
  %1: unk32 = gaddr {sym="gB"}
  %2: unk32 = load %1 {off=0, width=4, signed=false}
  %3: unk32 = shl %2 {imm=24}
  %4: unk32 = shr_u %3 {imm=22}
  store %1, %4 {off=0, width=4}
  ret
}
`);
    expect(n).toBe(1);
  });
});

describe('what nobody claimed goes back to the pair the frontend lifted', () => {
  const lifted = `fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = const {value=1}
  store %1, %2 {off=0, width=4}
  %3: unk32 = shl %0 {imm=24}
  %4: unk32 = shr_u %3 {imm=21}
  store %1, %4 {off=4, width=4}
  ret
}
`;

  test('an unclaimed scale is rewritten to its pair, in place, and the IR is the lifted IR again', () => {
    const fn = parse(lifted);
    expect(foldScaledExtensions(fn)).toBe(1);
    dce(fn);
    expect(print(fn)).toContain('zext');
    expect(restoreUnclaimedScales(fn)).toBe(1);
    dce(fn);
    verify(fn);
    expect(print(fn)).toBe(print(parse(lifted)));
  });

  test('a scale whose amount changed after the fold is left alone rather than rebuilt from stale amounts', () => {
    const fn = parse(lifted);
    foldScaledExtensions(fn);
    dce(fn);
    const scale = fn.blocks[0].ops.find((o) => o.opcode === 'shl' && o.attrs.imm === 3)!;
    scale.attrs = { imm: 2 };
    expect(restoreUnclaimedScales(fn)).toBe(0);
    expect(print(fn)).toMatch(/= shl %\d+ \{imm=2\}/);
  });

  test('a scale whose extension paramwidth took is claimed, and stays folded', () => {
    // No body code ahead of the `shl` here, so the extension is a prologue one.
    const fn = parse(`fn f {
^bb0(%0: unk32, %1: s32*):
  %2: unk32 = shl %0 {imm=24}
  %3: unk32 = shr_u %2 {imm=21}
  store %1, %3 {off=4, width=4}
  ret
}
`);
    foldScaledExtensions(fn);
    dce(fn);
    expect(narrowEntryParams(fn)).toBe(1);
    expect(restoreUnclaimedScales(fn)).toBe(0);
    expect(print(fn)).toMatch(/= shl %0 \{imm=3\}/);
  });

  test('a scale an array recognizer legalized is claimed; its twin nobody took is restored', () => {
    // One `shl`, two scales: `<< 2` indexes a word table (arrays.ts takes it), `<< 3` is stored as
    // a value. The shared extension stays for the index, and the value gets its pair back.
    const fn = parse(`fn f {
^bb0(%0: unk32, %1: s32*, %2: unk32):
  %3: unk32 = shl %2 {imm=24}
  %4: unk32 = shr_u %3 {imm=22}
  %5: unk32 = add %0, %4
  %6: unk32 = load %5 {off=0, width=4, signed=false}
  store %1, %6 {off=0, width=4}
  %7: unk32 = shr_u %3 {imm=21}
  store %1, %7 {off=4, width=4}
  ret
}
`);
    expect(foldScaledExtensions(fn)).toBe(2);
    dce(fn);
    expect(recognizeArrays(fn)).toBe(1);
    dce(fn);
    expect(restoreUnclaimedScales(fn)).toBe(1);
    dce(fn);
    verify(fn);
    const ir = print(fn);
    expect(ir).toMatch(/= aload %0, %\d+ \{elemSize=4/);
    expect(ir).toContain('= zext %2 {width=8}');
    expect(ir).toMatch(/= shr_u %\d+ \{imm=21\}/);
  });
});

describe('what the fold hands the passes below it', () => {
  test('a declared narrow parameter: its prologue `lsl` now reads as the extension it is', () => {
    // …and the scan no longer stops at it, so the SECOND parameter's width is recovered too.
    const src = source('extscale', 'agbcc-extscale-narrow.s');
    expect(src).toContain('void extscale(u8 a0, u8 a1)');
    expect(src).toContain('(a0 << 2)');
  });

  test('a cast in the body: both halves at the use, so the parameter stays wide', () => {
    // `gA`'s pool load runs before the pair, so it is also left as lifted (the next describe).
    const src = source('extscale', 'agbcc-extscale-wide.s');
    expect(src).toMatch(/void extscale\([su]32 a0, u8 a1\)/);
    expect(src).toContain('(a0 << 24) >> 22');
  });

  test('a body cast behind nothing but a pool load keeps its parameter wide', () => {
    // paramwidth's scan steps over a pool-loaded address, so a folded pair here would read as a
    // prologue extension and narrow `a` to `u8` — objdiff 2 where the raw pair is byte-exact.
    const src = source('extscale', 'agbcc-extscale-pool.s');
    expect(src).toMatch(/void extscale\([su]32 a0\)/);
    expect(src).toContain('(a0 << 24) >> 22');
  });

  test('a fold nobody claims prints as the pair it replaced', () => {
    // kleod's `SetWorldMapTilePalette` prologue: `a` is incremented in agbcc's shifted domain, so
    // paramwidth's scan stops at its `shl` and refuses `b`'s extension as body code. Nothing else
    // reads `b`'s scale, and the cast spelling that would print is not the lifted pair's object.
    const src = source('extscale', 'agbcc-extscale-unclaimed.s');
    expect(src).toContain('(a1 << 24) >> 12');
    expect(src).not.toContain('(u8)a1');
  });

  test('the element stride of a struct table indexed by a narrow parameter', () => {
    // `shl(zext8(idx), 3)` is an 8-byte element; the raw pair was an opaque byte offset.
    const src = source('entrylookup', 'agbcc-extscale-table.s');
    expect(src).toContain('void entrylookup(u8 a0)');
    expect(src).toMatch(/\)\[a0\]\.field_5/);
  });
});
