// Magic-number constant-division recovery (src/raise/magicdiv.ts). Offline (IR-level): each
// golden shape is the exact DAG the frontends lift from real gcc-mips/mwcc-ppc output; each
// negative is a near-miss that must DECLINE (leave the transient mulh in place → the
// structurer loud-fails on it — never a nonsense divide).
//
// Magic constants (Hacker's Delight): signed d=5 → (0x66666667, s=1); signed d=7 →
// (0x92492493, s=2, needs +x); unsigned d=5 → (0xCCCCCCCD, s=2); unsigned d=7 →
// (0x24924925, s=3, add-correction form).
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { recognizeMagicDivision } from '../src/raise/magicdiv';

const rewrite = (text: string): { changed: boolean; out: string } => {
  const fn = parse(text);
  const changed = recognizeMagicDivision(fn);
  return { changed, out: print(fn) };
};

describe('signed magic division', () => {
  test('simple form (d=5, MIPS `- (x>>31)` correction) → sdiv x, 5', () => {
    const { changed, out } = rewrite(`fn s5 {
^bb0(%0: s32):
  %1: s32 = const {value=1717986919}
  %2: s32 = mulh %0, %1
  %4: s32 = shr_s %2 {imm=1}
  %5: s32 = shr_s %0 {imm=31}
  %6: s32 = sub %4, %5
  ret %6
}
`);
    expect(changed).toBe(true);
    expect(out).toContain('sdiv');
    expect(out).toContain('{value=5}');
  });

  test('add-correction form (d=7, M ≥ 2^31 needs the +x) → sdiv x, 7', () => {
    const { changed, out } = rewrite(`fn s7 {
^bb0(%0: s32):
  %1: s32 = const {value=${0x92492493 | 0}}
  %2: s32 = mulh %0, %1
  %3: s32 = add %2, %0
  %4: s32 = shr_s %3 {imm=2}
  %5: s32 = shr_s %0 {imm=31}
  %6: s32 = sub %4, %5
  ret %6
}
`);
    expect(changed).toBe(true);
    expect(out).toContain('sdiv');
    expect(out).toContain('{value=7}');
  });

  test('PPC correction form (`+ (t >>u 31)`) → sdiv x, 5', () => {
    const { changed, out } = rewrite(`fn p5 {
^bb0(%0: s32):
  %1: s32 = const {value=1717986919}
  %2: s32 = mulh %0, %1
  %4: s32 = shr_s %2 {imm=1}
  %5: s32 = shr_u %4 {imm=31}
  %6: s32 = add %4, %5
  ret %6
}
`);
    expect(changed).toBe(true);
    expect(out).toContain('sdiv');
    expect(out).toContain('{value=5}');
  });

  // ── M4: the +x correction must be tied to M's sign bit (confirmed numerically) ──
  test('M4: a SPURIOUS +x on a low-M magic (d=5) declines — not x/5', () => {
    // the matched asm computes a different value than x/5 (70 vs 20 at x=100)
    const { changed, out } = rewrite(`fn spurious {
^bb0(%0: s32):
  %1: s32 = const {value=1717986919}
  %2: s32 = mulh %0, %1
  %3: s32 = add %2, %0
  %4: s32 = shr_s %3 {imm=1}
  %5: s32 = shr_s %0 {imm=31}
  %6: s32 = sub %4, %5
  ret %6
}
`);
    expect(changed).toBe(false);
    expect(out).toContain('mulh'); // left in place → loud-fails downstream
  });

  test('M4: a MISSING +x on a high-M magic (d=7) declines — not x/7', () => {
    // the matched asm computes −11 at x=100; x/7 is 14
    const { changed, out } = rewrite(`fn missing {
^bb0(%0: s32):
  %1: s32 = const {value=${0x92492493 | 0}}
  %2: s32 = mulh %0, %1
  %4: s32 = shr_s %2 {imm=2}
  %5: s32 = shr_s %0 {imm=31}
  %6: s32 = sub %4, %5
  ret %6
}
`);
    expect(changed).toBe(false);
    expect(out).toContain('mulh');
  });

  test('an (M, s) pair no divisor reproduces declines', () => {
    // NB: d=5's magic with a LARGER shift can be a real divisor's magic (0x66666667 with s=7 is
    // d=320 — multipliers repeat across scales), so the negative probe uses a non-magic M.
    const { changed } = rewrite(`fn bogus {
^bb0(%0: s32):
  %1: s32 = const {value=${0x11111111}}
  %2: s32 = mulh %0, %1
  %4: s32 = shr_s %2 {imm=3}
  %5: s32 = shr_s %0 {imm=31}
  %6: s32 = sub %4, %5
  ret %6
}
`);
    expect(changed).toBe(false);
  });

  test("a scaled magic (d=5's M at s=7) recognizes the REAL divisor d=320", () => {
    const { changed, out } = rewrite(`fn s320 {
^bb0(%0: s32):
  %1: s32 = const {value=1717986919}
  %2: s32 = mulh %0, %1
  %4: s32 = shr_s %2 {imm=7}
  %5: s32 = shr_s %0 {imm=31}
  %6: s32 = sub %4, %5
  ret %6
}
`);
    expect(changed).toBe(true);
    expect(out).toContain('{value=320}');
  });

  test('a mulh chain that is not a division shape declines (no sign correction)', () => {
    const { changed, out } = rewrite(`fn nodiv {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=1717986919}
  %3: s32 = mulh %0, %2
  %4: s32 = shr_s %3 {imm=1}
  %5: s32 = add %4, %1
  ret %5
}
`);
    expect(changed).toBe(false);
    expect(out).toContain('mulh');
  });

  test('mulh of two non-constant values declines', () => {
    const { changed } = rewrite(`fn twovars {
^bb0(%0: s32, %1: s32):
  %2: s32 = mulh %0, %1
  %3: s32 = shr_s %2 {imm=1}
  %4: s32 = shr_s %0 {imm=31}
  %5: s32 = sub %3, %4
  ret %5
}
`);
    expect(changed).toBe(false);
  });
});

describe('unsigned magic division', () => {
  test('simple form (d=5) → udiv x, 5', () => {
    const { changed, out } = rewrite(`fn u5 {
^bb0(%0: u32):
  %1: u32 = const {value=${0xcccccccd | 0}}
  %2: u32 = mulhu %0, %1
  %3: u32 = shr_u %2 {imm=2}
  ret %3
}
`);
    expect(changed).toBe(true);
    expect(out).toContain('udiv');
    expect(out).toContain('{value=5}');
  });

  test('add-correction form (d=7): t + ((x−t)>>1) >> (s−1) → udiv x, 7', () => {
    const { changed, out } = rewrite(`fn u7 {
^bb0(%0: u32):
  %1: u32 = const {value=${0x24924925}}
  %2: u32 = mulhu %0, %1
  %3: u32 = sub %0, %2
  %4: u32 = shr_u %3 {imm=1}
  %5: u32 = add %2, %4
  %6: u32 = shr_u %5 {imm=2}
  ret %6
}
`);
    expect(changed).toBe(true);
    expect(out).toContain('udiv');
    expect(out).toContain('{value=7}');
  });

  test('an unsigned (M, s) that only exists as add-correction declines the SIMPLE matcher', () => {
    // d=7's magic (0x24924925, s=3) has add=true — a bare `mulhu >> 3` with it is NOT x/7
    const { changed } = rewrite(`fn u7bare {
^bb0(%0: u32):
  %1: u32 = const {value=${0x24924925}}
  %2: u32 = mulhu %0, %1
  %3: u32 = shr_u %2 {imm=3}
  ret %3
}
`);
    expect(changed).toBe(false);
  });

  test('add-correction with the sub operands swapped (t−x, not x−t) declines', () => {
    const { changed } = rewrite(`fn u7swap {
^bb0(%0: u32):
  %1: u32 = const {value=${0x24924925}}
  %2: u32 = mulhu %0, %1
  %3: u32 = sub %2, %0
  %4: u32 = shr_u %3 {imm=1}
  %5: u32 = add %2, %4
  %6: u32 = shr_u %5 {imm=2}
  ret %6
}
`);
    expect(changed).toBe(false);
  });
});
