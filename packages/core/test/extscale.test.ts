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
// The first two differ ONLY in where the `lsl r0, r0, #0x18` sits — prologue against body — and
// must reach different signatures. Toolchain-free: the round trip is the matching suite's
// (packages/cli/test/matching/extscale.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { decompile } from '../src/pipeline';
import { foldScaledExtensions, foldsShiftPairCasts } from '../src/raise/extscale';
import { PRE_RECOVERY_PASSES } from '../src/raise/pre-recovery';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';

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
    // IDO zero-extends with `andi`, so a `sll; srl` there is not a cast's lowering
    expect(foldsShiftPairCasts(MIPS_IDO)).toBe(false);
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
    const src = source('extscale', 'agbcc-extscale-wide.s');
    expect(src).toMatch(/void extscale\([su]32 a0, u8 a1\)/);
    expect(src).toContain('((u8)a0 << 2)');
  });

  test('the element stride of a struct table indexed by a narrow parameter', () => {
    // `shl(zext8(idx), 3)` is an 8-byte element; the raw pair was an opaque byte offset.
    const src = source('entrylookup', 'agbcc-extscale-table.s');
    expect(src).toContain('void entrylookup(u8 a0)');
    expect(src).toMatch(/\)\[a0\]\.field_5/);
  });
});
