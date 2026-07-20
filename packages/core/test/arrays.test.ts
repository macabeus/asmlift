// Isolated golden for the array-recognition legalization pass (raise/arrays.ts): IR text in →
// IR text out, mirroring the per-pattern golden idiom (pattern.test.ts). Proves the variable-
// index addressing shape `load/store(add(base, shl(index, k)))` becomes a typed `aload`/`astore`
// carrying `elemSize = 1 << k` — WITHOUT going through the whole tower. The now-dead address ops
// are reaped by the DRIVER's dce (the pass declares `dce: true` in pre-recovery.ts and does not
// self-clean), so the golden runs dce exactly as the driver does.
import { expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { dce } from '../src/pattern/engine';
import { recognizeArrays } from '../src/raise/arrays';

test("golden: scaled-index load → aload {elemSize}, dead address DCE'd", () => {
  const fn = parse(`fn aget {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = shl %1 {imm=2}
  %3: unk32 = add %0, %2
  %4: unk32 = load %3 {off=0, signed=true, width=4}
  ret %4
}
`);
  expect(recognizeArrays(fn)).toBe(1);
  dce(fn); // the driver's dce (pre-recovery.ts declares dce: true for this pass)
  verify(fn);
  expect(print(fn)).toBe(`fn aget {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = aload %0, %1 {elemSize=4, signed=true}
  ret %2
}
`);
});

test('golden: scaled-index store → astore {elemSize}', () => {
  const fn = parse(`fn aset {
^bb0(%0: unk32, %1: unk32, %2: unk32):
  %3: unk32 = shl %1 {imm=2}
  %4: unk32 = add %0, %3
  store %4, %2 {off=0, width=4}
  ret %2
}
`);
  expect(recognizeArrays(fn)).toBe(1);
  dce(fn); // the driver's dce (pre-recovery.ts declares dce: true for this pass)
  verify(fn);
  expect(print(fn)).toBe(`fn aset {
^bb0(%0: unk32, %1: unk32, %2: unk32):
  astore %0, %1, %2 {elemSize=4}
  ret %2
}
`);
});

test('elemSize/shift must agree: `shl #1` feeding a width-4 load is NOT an array access', () => {
  // 1 << 1 = 2 ≠ 4, so the address is not a correctly-scaled index for this width — leave it a
  // plain load (some other arithmetic), don't mis-legalize.
  const fn = parse(`fn mismatch {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = shl %1 {imm=1}
  %3: unk32 = add %0, %2
  %4: unk32 = load %3 {off=0, signed=true, width=4}
  ret %4
}
`);
  expect(recognizeArrays(fn)).toBe(0);
});

test('commutative: base and scaled index in either add-operand order', () => {
  const fn = parse(`fn rev {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = shl %1 {imm=2}
  %3: unk32 = add %2, %0
  %4: unk32 = load %3 {off=0, signed=true, width=4}
  ret %4
}
`);
  expect(recognizeArrays(fn)).toBe(1);
  dce(fn); // the driver's dce (pre-recovery.ts declares dce: true for this pass)
  verify(fn);
  expect(print(fn)).toContain('aload %0, %1 {elemSize=4, signed=true}');
});
