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
      '        if (*v0 == 0) {\n' +
      '            v2 = 0;\n' +
      '            return v2;\n' +
      '        } else {\n' +
      '            v0 = v0 + 1;\n' +
      '            v1 = v1 + 1;\n' +
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

// A do-while scan whose arm reads a value the loop COMPUTED (`table[i]`) — the arm renders inside
// the body, ahead of `i++`, so that read is the pre-update value it wants. ^bb3 is the arm, reached
// only from ^bb2; ^bb5 is the epilogue both it and the post-loop path reach.
const SCAN_RETURN_HIT = `fn findstore {
^bb0(%0: s32*, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32* = gaddr {sym="table"}
  %5: s32 = const {value=8}
  %6: s32 = mul %3, %5
  %7: s32* = add %4, %6
  %8: s32 = load %7 {off=0, signed=true, width=4}
  %9: u32 = icmp_ne %8, %1
  cond_br %9, ^bb4(), ^bb2()
^bb2():
  %10: s32 = load %7 {off=4, signed=true, width=4}
  %11: s32 = const {value=0}
  %12: u32 = icmp_eq %10, %11
  cond_br %12, ^bb4(), ^bb3()
^bb3():
  %17: s32 = load %7 {off=4, signed=true, width=4}
  br ^bb5(%17)
^bb4():
  %13: s32 = const {value=1}
  %14: s32 = add %3, %13
  %15: s32 = const {value=10}
  %16: u32 = icmp_slt %14, %15
  %18: s32 = const {value=-1}
  cond_br %16, ^bb1(%14), ^bb5(%18)
^bb5(%19: s32):
  ret %19
}
`;

test('an arm reading a loop-computed value is not a post-loop read of it', () => {
  expect(emit(SCAN_RETURN_HIT)).toBe(
    's32 findstore(s32 * a0, s32 a1) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    v0 = 0;\n' +
      '    do {\n' +
      '        if (*(s32 *)((u32)&table + v0 * 8) == a1) {\n' +
      '            if (((s32 *)((u32)&table + v0 * 8))[1] != 0) {\n' +
      '                v1 = ((s32 *)((u32)&table + v0 * 8))[1];\n' +
      '                return v1;\n' +
      '            }\n' +
      '        }\n' +
      '        v0 = v0 + 1;\n' +
      '    } while (v0 < 10);\n' +
      '    v1 = -1;\n' +
      '    return v1;\n' +
      '}\n',
  );
});

// The same scan, with the arm STORING what it found instead of returning it — the effect a loop
// with one real exit could not carry before.
const SCAN_STORE_HIT = SCAN_RETURN_HIT.replace('  br ^bb5(%17)', '  store %0, %17 {off=0, width=4}\n  br ^bb5(%17)');

test('an arm the edge exclusively reaches may carry a store', () => {
  expect(emit(SCAN_STORE_HIT)).toContain(
    '                v0 = ((s32 *)((u32)&table + v1 * 8))[1];\n                *a0 = v0;\n                return v0;\n',
  );
});

// REFUSAL — the same store in the epilogue instead. Both the arm and the post-loop path reach it,
// so structuring it on the arm's edge writes the effect twice into source no compiler wrote.
const SHARED_EPILOGUE_EFFECT = SCAN_RETURN_HIT.replace(
  '^bb5(%19: s32):\n  ret %19',
  '^bb5(%19: s32):\n  store %0, %19 {off=0, width=4}\n  ret %19',
);

test('a store in the shared epilogue is not an arm the loop may own — declines', () => {
  expect(SHARED_EPILOGUE_EFFECT).not.toBe(SCAN_RETURN_HIT);
  expect(() => emit(SCAN_STORE_HIT)).not.toThrow();
  expect(() => emit(SHARED_EPILOGUE_EFFECT)).toThrow(StructureError);
});

// The OTHER arm site: a conditional latch, where one edge of the cond_br IS the back-edge. That
// emitter puts the loop update ahead of the arm, so a value the arm reads has already moved on —
// `store %out, %i` must render before `i++`, not after it.
const LATCH_ARM_STORE = `fn latcharm {
^bb0(%0: s32*):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = const {value=10}
  %4: u32 = icmp_slt %2, %3
  cond_br %4, ^bb2(), ^bb4()
^bb2():
  %5: s32* = gaddr {sym="gFlag"}
  %6: s32 = load %5 {off=0, signed=true, width=4}
  %7: u32 = icmp_eq %6, %1
  %8: s32 = const {value=1}
  %9: s32 = add %2, %8
  cond_br %7, ^bb3(), ^bb1(%9)
^bb3():
  store %0, %2 {off=0, width=4}
  br ^bb5(%8)
^bb4():
  br ^bb5(%1)
^bb5(%10: s32):
  ret %10
}
`;

test('a conditional-latch arm stores the value the IR read, not the updated one', () => {
  // The update moves into the arm that does NOT return: reaching the returning one means this
  // iteration ended there, so the increment it would have run never happens.
  expect(emit(LATCH_ARM_STORE)).toBe(
    's32 latcharm(s32 * a0) {\n' +
      '    s32 v0;\n' +
      '    s32 v1;\n' +
      '    v0 = 0;\n' +
      '    while (v0 < 10) {\n' +
      '        if (gFlag != 0) {\n' +
      '            v0 = v0 + 1;\n' +
      '        } else {\n' +
      '            *a0 = v0;\n' +
      '            v1 = 1;\n' +
      '            return v1;\n' +
      '        }\n' +
      '    }\n' +
      '    v1 = 0;\n' +
      '    return v1;\n' +
      '}\n',
  );
});

// REFUSAL — two in-body sides that meet somewhere OTHER than the loop bottom. `stop` is not their
// join, and using it anyway makes each side re-emit everything from the meeting point down: with the
// guard dropped this emits `*a0 = 200` twice, correct but doubled, and doubled again per nesting
// level. ^bb6 is where they meet; ^bb5 is the arm that pushes the CFG join out of the loop.
const INNER_JOIN = `fn innerjoin {
^bb0(%0: s32*):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32* = gaddr {sym="gF"}
  %4: s32 = load %3 {off=0, signed=true, width=4}
  %5: u32 = icmp_ne %4, %1
  cond_br %5, ^bb3(), ^bb4()
^bb3():
  %6: s32 = const {value=100}
  store %0, %6 {off=0, width=4}
  br ^bb6()
^bb4():
  %7: s32* = gaddr {sym="gG"}
  %8: s32 = load %7 {off=0, signed=true, width=4}
  %9: u32 = icmp_ne %8, %1
  cond_br %9, ^bb5(), ^bb6()
^bb5():
  %10: s32 = const {value=7}
  br ^bb8(%10)
^bb6():
  %11: s32 = const {value=200}
  store %0, %11 {off=0, width=4}
  br ^bb7()
^bb7():
  %12: s32 = const {value=1}
  %13: s32 = add %2, %12
  %14: s32 = const {value=10}
  %15: u32 = icmp_slt %13, %14
  cond_br %15, ^bb1(%13), ^bb8(%1)
^bb8(%16: s32):
  ret %16
}
`;

test('two in-body sides meeting below the loop bottom keep the CFG join — and decline', () => {
  expect(() => emit(SCAN_RETURN_HIT)).not.toThrow();
  expect(() => emit(INNER_JOIN)).toThrow(StructureError);
});

// REFUSAL — the arm lands straight on the POST-LOOP join. `^bb5` dominates itself and `^bb2`
// dominates `^bb5`, so ownership by dominance alone would claim it; but the loop's own exit reaches
// it too, and emitting it on both paths writes `gOut` twice.
const ARM_ON_POSTLOOP_JOIN = `fn sharedtail {
^bb0(%0: s32*):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  br ^bb2()
^bb2():
  %3: s32* = gaddr {sym="gF"}
  %4: s32 = load %3 {off=0, signed=true, width=4}
  %5: u32 = icmp_eq %4, %1
  cond_br %5, ^bb5(%2), ^bb3()
^bb3():
  %6: s32 = const {value=1}
  %7: s32 = add %2, %6
  %8: s32 = const {value=10}
  %9: u32 = icmp_slt %7, %8
  cond_br %9, ^bb1(%7), ^bb4()
^bb4():
  %12: s32 = const {value=99}
  br ^bb5(%12)
^bb5(%10: s32):
  %11: s32* = gaddr {sym="gOut"}
  store %11, %10 {off=0, width=4}
  ret %10
}
`;

test('an arm landing on the post-loop join owns nothing — declines', () => {
  expect(() => emit(SCAN_STORE_HIT)).not.toThrow();
  expect(() => emit(ARM_ON_POSTLOOP_JOIN)).toThrow(StructureError);
});

// The same conditional latch with a value-only arm — the half that miscompiled on `main`, returning
// the post-update value where the IR reads the loop variable before the update.
const LATCH_ARM_RETURN = LATCH_ARM_STORE.replace(
  '^bb3():\n  store %0, %2 {off=0, width=4}\n  br ^bb5(%8)',
  '^bb3():\n  ret %2',
);

test('a conditional-latch arm returns the value the IR read, not the updated one', () => {
  expect(LATCH_ARM_RETURN).not.toBe(LATCH_ARM_STORE);
  expect(emit(LATCH_ARM_RETURN)).toContain(
    '        if (gFlag != 0) {\n            v0 = v0 + 1;\n        } else {\n            return v0;\n        }\n',
  );
});

// REFUSAL — a conditional-latch `break` whose POST-LOOP region reads the induction variable
// directly. The break edge carries the pre-update value and the post-loop code renders after the
// update, so `main` emitted `(i + 1) * 100`. `^bb3` is the loop's own exit, not an arm, so the
// clamp cannot stand in for the CFG join either — the shape declines both ways out.
const BREAK_POSTLOOP_READ = `fn brkpost {
^bb0(%0: s32*):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: s32 = const {value=10}
  %4: u32 = icmp_slt %2, %3
  cond_br %4, ^bb2(), ^bb3()
^bb2():
  %5: s32* = gaddr {sym="gFlag"}
  %6: s32 = load %5 {off=0, signed=true, width=4}
  %7: u32 = icmp_eq %6, %1
  %8: s32 = const {value=1}
  %9: s32 = add %2, %8
  cond_br %7, ^bb3(), ^bb1(%9)
^bb3():
  %10: s32 = const {value=100}
  %11: s32 = mul %2, %10
  store %0, %11 {off=0, width=4}
  ret %11
}
`;

test('a break whose post-loop region reads the pre-update induction value declines', () => {
  expect(() => emit(LATCH_ARM_STORE)).not.toThrow();
  expect(() => emit(BREAK_POSTLOOP_READ)).toThrow(StructureError);
});
