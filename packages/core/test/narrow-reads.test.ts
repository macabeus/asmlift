// A narrow loop variable, kept zero-extended and read sign-extended. agbcc holds an `s16`/`s8`
// local in its ZERO-extended form and sign-extends it at each signed use, so a `for` loop leaves
// two extensions of the same increment: one on the back edge, one in the loop test. The test's
// spelling reaches the loop variable's PRE-update value, which the structurer refuses; re-rooted on
// the back-edge argument it is the `(s16)i` the source wrote.
//
// Both spellings are covered — the folded `zext`/`sext` pair, and the raw `shr_u`/`shr_s` pair the
// cast idiom cannot fold because the value under the shifts is not a bare `shl`.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { rerootNarrowReads } from '../src/raise/narrow';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const run = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  const n = rerootNarrowReads(fn);
  verify(fn);
  return { fn, n, ir: print(fn) };
};
// `print` renumbers values positionally, so the re-root is asserted as a SHAPE: the sign extension
// reads the result the zero extension on the line above defines.
const rerooted = (unsigned: string) =>
  new RegExp(`%(\\d+): \\S+ = ${unsigned}\\n\\s+%\\d+: \\S+ = sext %\\1 \\{width=16\\}`);
const emit = (ir: string): string => {
  const { fn } = run(ir);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// `for (s16 i = 0; i <= 5; i++) g[i] = i;` as agbcc leaves it: %5 is what `i` holds next
// iteration, %6 is the same bits sign-extended for the test.
const ZEXT_PAIR = `fn narrowloop {
^bb0():
  %0: s32 = const {value=0}
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = sext %1 {width=16}
  %3: s32* = gaddr {sym="g"}
  astore %3, %2, %2 {elemSize=4}
  %4: s32 = const {value=1}
  %10: s32 = add %2, %4
  %5: s32 = zext %10 {width=16}
  %6: s32 = sext %10 {width=16}
  %7: s32 = const {value=5}
  %8: u32 = icmp_sle %6, %7
  cond_br %8, ^bb1(%5), ^bb2()
^bb2():
  ret
}
`;

// The same loop with the increment folded into the shifted domain — `(i << 16) + 0x10000` — so the
// two extensions are raw shifts of a value that is not a `shl`, and the cast idiom leaves them.
const SHIFT_PAIR = `fn narrowshift {
^bb0():
  %0: s32 = const {value=0}
  br ^bb1(%0)
^bb1(%1: s32):
  %2: s32 = sext %1 {width=16}
  %3: s32* = gaddr {sym="g"}
  astore %3, %2, %2 {elemSize=4}
  %4: s32 = shl %1 {imm=16}
  %9: s32 = const {value=65536}
  %10: s32 = add %4, %9
  %5: s32 = shr_u %10 {imm=16}
  %6: s32 = shr_s %10 {imm=16}
  %7: s32 = const {value=5}
  %8: u32 = icmp_sle %6, %7
  cond_br %8, ^bb1(%5), ^bb2()
^bb2():
  ret
}
`;

test('the folded pair: the loop test re-roots on the back-edge argument', () => {
  const { n, ir } = run(ZEXT_PAIR);
  expect(n).toBe(1);
  expect(ir).toMatch(rerooted('zext %\\d+ \\{width=16\\}'));
});

test('the shift pair: the signed shift becomes a cast of the unsigned one', () => {
  const { n, ir } = run(SHIFT_PAIR);
  expect(n).toBe(1);
  expect(ir).toMatch(rerooted('shr_u %\\d+ \\{imm=16\\}'));
  expect(ir).not.toContain('shr_s'); // the `imm` went with the rest of the attrs
});

test('the loop the re-root unblocks structures, and the test reads the loop variable', () => {
  // Without the re-root the test walks down to the header param — the PRE-update value — and the
  // structurer declines rather than render it one iteration off.
  expect(() => emit(ZEXT_PAIR)).not.toThrow();
  expect(emit(ZEXT_PAIR)).toContain('} while ((s16)v0 <= 5);');
});

// REFUSALS — each a one-fact edit of an accepted fixture, with that fixture run first as a control.
test('an unsigned narrowing that is not an edge argument is left alone', () => {
  // Off an edge nothing guarantees the value is materialized under a name, so re-rooting would put
  // `(s16)(u16)x` where `(s16)x` stood.
  expect(run(ZEXT_PAIR).n).toBe(1);
  const notCarried = ZEXT_PAIR.replace('cond_br %8, ^bb1(%5), ^bb2()', 'cond_br %8, ^bb1(%10), ^bb2()');
  expect(notCarried).not.toBe(ZEXT_PAIR);
  expect(run(notCarried).n).toBe(0);
});

test('an unsigned narrowing that comes AFTER the signed one is left alone', () => {
  // the re-root makes the sign extension read it, so the other order would be a use before a def
  expect(run(ZEXT_PAIR).n).toBe(1);
  const reordered = ZEXT_PAIR.replace(
    '  %5: s32 = zext %10 {width=16}\n  %6: s32 = sext %10 {width=16}\n',
    '  %6: s32 = sext %10 {width=16}\n  %5: s32 = zext %10 {width=16}\n',
  );
  expect(reordered).not.toBe(ZEXT_PAIR);
  expect(run(reordered).n).toBe(0);
});

test('extensions of different widths are not a pair', () => {
  expect(run(ZEXT_PAIR).n).toBe(1);
  const mixed = ZEXT_PAIR.replace('%6: s32 = sext %10 {width=16}', '%6: s32 = sext %10 {width=8}');
  expect(mixed).not.toBe(ZEXT_PAIR);
  expect(run(mixed).n).toBe(0);
});

test('extensions of different VALUES are not a pair', () => {
  expect(run(ZEXT_PAIR).n).toBe(1);
  const other = ZEXT_PAIR.replace('%6: s32 = sext %10 {width=16}', '%6: s32 = sext %2 {width=16}');
  expect(other).not.toBe(ZEXT_PAIR);
  expect(run(other).n).toBe(0);
});

test('a shift pair that narrows to no C type is left alone', () => {
  // `sext`/`zext` carry a width the backend prints as a cast; a 12-bit one has no spelling
  expect(run(SHIFT_PAIR).n).toBe(1);
  const odd = SHIFT_PAIR.replace('%5: s32 = shr_u %10 {imm=16}', '%5: s32 = shr_u %10 {imm=20}').replace(
    '%6: s32 = shr_s %10 {imm=16}',
    '%6: s32 = shr_s %10 {imm=20}',
  );
  expect(odd).not.toBe(SHIFT_PAIR);
  expect(run(odd).n).toBe(0);
});

// THE CROSS-DOMAIN REFUSAL, and the only rule in this file that is a soundness rule. The two
// spellings live in different bit-domains: `zext {width:16}` keeps the LOW halfword, `shr_u
// {imm:16}` keeps the HIGH one and moves it down. Pair them and `x >> 16` becomes `(s16)(u16)x` — a
// different value, silently. Neither fixture above can catch it: each is written in ONE spelling.
test('a zero extension is not paired with a shift of the same operand', () => {
  // one carried `zext {16}` and one `shr_s {imm=16}` of the same value: same integer, different
  // bits, and the low-half/high-half key is the only thing that tells them apart
  const mixed = ZEXT_PAIR.replace('%6: s32 = sext %10 {width=16}', '%6: s32 = shr_s %10 {imm=16}');
  expect(mixed).not.toBe(ZEXT_PAIR);
  expect(run(ZEXT_PAIR).n).toBe(1); // control: the same-spelling pair IS rewritten
  expect(run(mixed).n).toBe(0);
});

test('an unsigned SHIFT is not paired with a sign extension of the same operand', () => {
  const mixed = SHIFT_PAIR.replace('%6: s32 = shr_s %10 {imm=16}', '%6: s32 = sext %10 {width=16}');
  expect(mixed).not.toBe(SHIFT_PAIR);
  expect(run(SHIFT_PAIR).n).toBe(1);
  expect(run(mixed).n).toBe(0);
});
