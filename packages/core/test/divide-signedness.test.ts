// The DIVIDE half of the signedness-carrying pairs (l3/ast.ts BinOp `/u`/`%u`, backend/cfamily.ts
// C_SPELLING). C spells the signed and unsigned quotient with the same `/`, choosing between them
// by the usual arithmetic conversions over both operands — so a `udiv` whose operands render signed
// recompiles to `__divsi3` where the target called `__udivsi3`, and the operand cast is what says
// which. Verified by compiling with the row's own agbcc: `((u32)a / b) / 7` calls `__udivsi3`
// twice, `(s32)((u32)a / b) / 7` calls `__udivsi3` then `__divsi3`.
//
// The refusal is what keeps this off the corpus: operands that ALREADY render unsigned take no
// cast, which is every currently-matching udiv row (`u32 a0; a0 / 7`).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import type { Expr, SFn } from '../src/l3/ast';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, {}));
};

// A `udiv` over two s32-declared parameters — the GetAnchorCoord shape, where the divisor also
// feeds a signed compare so no declaration flip can carry the unsignedness.
const UDIV_SIGNED_OPERANDS = `fn udivsigned {
^bb0(%0: s32, %1: s32):
  %2: s32 = udiv %0, %1
  ret %2
}
`;

test('an unsigned divide over signed-rendering operands takes the (u32) cast', () => {
  expect(emit(UDIV_SIGNED_OPERANDS)).toContain('(u32)a0 / a1');
});

// The same divide with both operands already unsigned: one cast is enough to carry the operation,
// and zero are needed when nothing renders signed.
const UDIV_UNSIGNED_OPERANDS = `fn udivunsigned {
^bb0(%0: u32, %1: u32):
  %2: u32 = udiv %0, %1
  ret %2
}
`;

test('an unsigned divide over unsigned-rendering operands keeps its spelling', () => {
  const src = emit(UDIV_UNSIGNED_OPERANDS);
  expect(src).toContain('a0 / a1');
  expect(src).not.toContain('(u32)');
});

const UMOD_SIGNED_OPERANDS = `fn umodsigned {
^bb0(%0: s32, %1: s32):
  %2: s32 = umod %0, %1
  ret %2
}
`;

test('an unsigned remainder takes the same cast', () => {
  expect(emit(UMOD_SIGNED_OPERANDS)).toContain('(u32)a0 % a1');
});

// The SIGNED direction, and the reason it cannot be skipped: one unsigned operand is enough to
// make C's division unsigned, so a signed divide standing on an unsigned-rendering value silently
// calls the wrong helper. Here the dividend is a u32 parameter.
const SDIV_UNSIGNED_OPERAND = `fn sdivunsigned {
^bb0(%0: u32, %1: s32):
  %2: s32 = sdiv %0, %1
  ret %2
}
`;

test('a signed divide over an unsigned-rendering operand takes the (s32) cast', () => {
  expect(emit(SDIV_UNSIGNED_OPERAND)).toContain('(s32)a0 / a1');
});

// A signed divide whose operands already render signed — the everyday case, and why this cannot
// churn the corpus's signed-division rows.
const SDIV_OK = `fn sdivok {
^bb0(%0: s32, %1: s32):
  %2: s32 = sdiv %0, %1
  ret %2
}
`;

test('a signed divide over signed-rendering operands keeps its spelling', () => {
  const src = emit(SDIV_OK);
  expect(src).toContain('a0 / a1');
  expect(src).not.toContain('(s32)');
});

// COMPOSITION. The pin makes the division RENDER unsigned, so every consumer that reads its
// operand's signedness has to see that — an arithmetic shift over it must re-pin to signed, or the
// `asr` the machine did recompiles to `lsr`. Compiled: `((u32)a / b) >> 3` is `lsr`,
// `(s32)((u32)a / b) >> 3` is `asr`.
const SHIFT_OVER_UDIV = `fn shiftoverudiv {
^bb0(%0: s32, %1: s32):
  %2: s32 = udiv %0, %1
  %3: s32 = const {value=3}
  %4: s32 = shr_s %2, %3
  ret %4
}
`;

test('an arithmetic shift over an unsigned divide re-pins to signed', () => {
  expect(emit(SHIFT_OVER_UDIV)).toContain('(s32)((u32)a0 / a1) >> 3');
});

// The same composition through a SIGNED COMPARE, the hazard that makes the compare pin a
// prerequisite rather than a nicety: agbcc compiles `(u32)a / b < 0` to `mov r0, #0; bx lr`,
// deleting the `__udivsi3` call along with the branch.
const CMP_OVER_UDIV = `fn cmpoverudiv {
^bb0(%0: s32, %1: s32):
  %2: s32 = udiv %0, %1
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %2, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  %5: s32 = const {value=1}
  ret %5
^bb2():
  %6: s32 = const {value=2}
  ret %6
}
`;

test('a signed compare over an unsigned divide re-pins to signed', () => {
  expect(emit(CMP_OVER_UDIV)).toMatch(/\(s32\)\(\(u32\)a0 \/ a1\) [<>]=? 0/);
});

// IDO Pascal has no unsigned-division spelling: `div` over this backend's signed `Integer` is the
// signed one, so borrowing it would emit the division the machine did not do. Loud, like `%`.
test('the Pascal backend declines an unsigned divide', () => {
  const fn = parse(UDIV_SIGNED_OPERANDS);
  verify(fn);
  recoverTypes(fn);
  expect(() => pascalBackend.emit(structure(fn, {}))).toThrow(/unsigned divide|operator|spelling/i);
});

// The same rule over an operand the model cannot determine. With `u32 getv(void);` in scope agbcc
// compiles `getv() / a0` to `bl __udivsi3` and `(s32)getv() / a0` to `bl __divsi3`; a redundant
// cast where the callee really returns `int` is instruction-for-instruction identical.
const SDIV_CALL = `fn sdivcall {
^bb0(%0: s32):
  %1: s32 = call {target="getv"}
  %2: s32 = sdiv %1, %0
  ret %2
}
`;

test('a signed divide over a call takes the (s32) cast', () => {
  expect(emit(SDIV_CALL)).toContain('(s32)getv() / a0');
});

// A decimal constant too big for `int` is unsigned in C89, so it makes the division unsigned:
// `a0 / -2147483648` compiles to `lsr r0, r0, #0x1f` where `a0 / (s32)-2147483648` calls
// `__divsi3`.
const SDIV_INTMIN = `fn sdivintmin {
^bb0(%0: s32):
  %1: s32 = const {value=-2147483648}
  %2: s32 = sdiv %0, %1
  ret %2
}
`;

test('a signed divide by a constant too big for `int` casts the constant', () => {
  expect(emit(SDIV_INTMIN)).toContain('/ (s32)-2147483648');
});

// THE QUALIFIER SURVIVES THE PIN. `recast` REPLACES a 32-bit integer cast rather than wrapping it,
// so a `volatile` one has to be rebuilt with its qualifier — dropping it is a silent change of what
// the access means, and the differ cannot referee it (l3/initfirst.ts's `stripWideIntCast` refuses
// the same peel one pass over). No pass mints a volatile INT cast today; the rule is checked here
// rather than left to whichever one first does.
test('a volatile cast keeps its qualifier when the pin re-types it', () => {
  const volCast: Expr = { k: 'cast', to: T.u(32), volatile: true, e: { k: 'var', name: 'a0' } };
  const sfn: SFn = {
    name: 'volpin',
    params: [{ name: 'a0', type: T.s(32) }],
    locals: [],
    retType: T.s(32),
    body: [{ k: 'return', value: { k: 'bin', op: '/', l: volCast, r: { k: 'const', value: 3 } } }],
  };
  expect(cBackend.emit(sfn)).toContain('(volatile s32)a0 / 3');
});
