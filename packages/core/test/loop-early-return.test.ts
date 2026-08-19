// The early `return` out of a loop body — `while (…) { if (found) return hit; … }`. The compiler
// merges every `return` into ONE epilogue block, so the post-dominator of a body `if` sits AFTER
// the loop; structuring the in-loop arm towards it walks through the latch and back into the
// header. The join a body `if` really has is the loop's own continuation.
//
// Every refusal case runs the accepted fixture as a positive control first, so a decline for the
// wrong reason cannot read as a pass.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { StructureError, structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// `while (*a == *b) { if (*a == 0) return 0; a++; b++; } return *a - *b;` — ^bb2's `if` leaves the
// loop for ^bb5, which ^bb4 (the post-loop path) also reaches, so the CFG join of ^bb2 is ^bb5.
const STRCMP_EARLY_RETURN = `fn strcmpearly {
^bb0(%0: u8*, %1: u8*):
  br ^bb1(%0, %1)
^bb1(%2: u8*, %3: u8*):
  %4: s32 = load %2 {off=0, signed=false, width=1}
  %5: s32 = load %3 {off=0, signed=false, width=1}
  %6: u32 = icmp_eq %4, %5
  cond_br %6, ^bb2(), ^bb4()
^bb2():
  %7: s32 = const {value=0}
  %8: u32 = icmp_ne %4, %7
  cond_br %8, ^bb3(), ^bb5(%7)
^bb3():
  %9: s32 = const {value=1}
  %10: u8* = add %2, %9
  %11: u8* = add %3, %9
  br ^bb1(%10, %11)
^bb4():
  %12: s32 = load %2 {off=0, signed=false, width=1}
  %13: s32 = load %3 {off=0, signed=false, width=1}
  %14: s32 = sub %12, %13
  br ^bb5(%14)
^bb5(%15: s32):
  ret %15
}
`;

test('a body `if` whose arm returns joins at the loop, not at the merged epilogue', () => {
  expect(emit(STRCMP_EARLY_RETURN)).toBe(
    's32 strcmpearly(u8 * a0, u8 * a1) {\n' +
      '    u8 * v0;\n' +
      '    u8 * v1;\n' +
      '    s32 v2;\n' +
      '    v0 = a0;\n' +
      '    v1 = a1;\n' +
      '    while (*v0 == *v1) {\n' +
      '        if (*v0 != 0) {\n' +
      '            v0 = v0 + 1;\n' +
      '            v1 = v1 + 1;\n' +
      '        } else {\n' +
      '            v2 = 0;\n' +
      '            return v2;\n' +
      '        }\n' +
      '    }\n' +
      '    v2 = *v0 - *v1;\n' +
      '    return v2;\n' +
      '}\n',
  );
});

// REFUSAL — the epilogue carries a store, so it is not an early-`return` arm: the loop reaches it
// from inside AND the post-loop path reaches it too, and both would emit it. Admission still takes
// the loop (the target is ret-terminated), so this is the case the clamp's own guard must catch.
const SHARED_EPILOGUE_STORE = STRCMP_EARLY_RETURN.replace(
  '^bb5(%15: s32):\n  ret %15',
  '^bb5(%15: s32):\n  store %0, %15 {off=0, width=4}\n  ret %15',
);

test('an epilogue that stores is not an arm — the join stands and the loop declines', () => {
  expect(SHARED_EPILOGUE_STORE).not.toBe(STRCMP_EARLY_RETURN);
  expect(() => emit(STRCMP_EARLY_RETURN)).not.toThrow();
  expect(() => emit(SHARED_EPILOGUE_STORE)).toThrow(StructureError);
});
