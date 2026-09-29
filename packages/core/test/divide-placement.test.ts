// A DIVIDE THE ASM RAN AHEAD OF AN EFFECT stays ahead of it in the C.
//
// `expr()` renders a pure op at its use, and a divide is pure except that it may fault, so inlined
// past a store or a call it changes what had run when it faults. On agbcc it is also a call to
// `__divsi3`, which no compiler moves past a store, so the inlined spelling never recompiles to the
// target. The rule (structure/analysis.ts, the trapping-op clause) names a divide that may fault at
// its def when an effect lies between it and a render position, and leaves every other divide inline.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { frontendFor } from '../src/frontend/registry';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { applyIdiomPatterns, raiseRecovered } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// `t = k / n; *q = n; return t + 1;`
const DIV_STORE = `fn f {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = sdiv %2, %1
  store %0, %1 {off=0, width=4}
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  ret %5
}
`;

test('a divide ahead of a store is named where it ran', () => {
  const src = emit(DIV_STORE);
  expect(src).toMatch(/v0 = a2 \/ a1;\n\s+\*a0 = a1;\n\s+return v0 \+ 1;/);
});

test.each(['udiv', 'smod', 'umod'])('%s is placed the same way', (opcode) => {
  const src = emit(DIV_STORE.replace('sdiv', opcode));
  expect(src).toMatch(/v0 = (\(u32\))?a2 [/%] a1;\n\s+\*a0 = a1;/);
});

test('a call between the divide and its use names it too', () => {
  const src = emit(DIV_STORE.replace('store %0, %1 {off=0, width=4}', '%9: s32 = call %1 {target="g"}'));
  expect(src).toMatch(/v0 = a2 \/ a1;\n\s+g\(a1\);\n\s+return v0 \+ 1;/);
});

test('with no effect between, the divide stays inline', () => {
  const src = emit(DIV_STORE.replace('store %0, %1 {off=0, width=4}\n', ''));
  expect(src).toMatch(/return a2 \/ a1 \+ 1;/);
});

test('a store after the use is not between them', () => {
  const src = emit(`fn f {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = sdiv %2, %1
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  store %0, %5 {off=0, width=4}
  store %0, %1 {off=4, width=4}
  ret %1
}
`);
  expect(src).toMatch(/\*a0 = a2 \/ a1 \+ 1;/);
});

// `if (a0 > 0 && k / n != 0)` with the divide folded above a store: raise/shortcircuit.ts lifts a
// guarded operand's cone into the block above the branch, so its def block says nothing about where
// the source divided, and a name there would divide on the path the `&&` skips.
test('a divide in a connective’s guarded operand stays unnamed', () => {
  const src = emit(`fn f {
^bb0(%0: unk32, %1: s32, %2: s32):
  %3: s32 = sdiv %2, %1
  store %0, %1 {off=0, width=4}
  %4: s32 = const {value=0}
  %5: u32 = icmp_sgt %1, %4
  %6: u32 = icmp_ne %3, %4
  %7: u32 = logic_and %5, %6
  cond_br %7, ^bb1(), ^bb2()
^bb1():
  ret %1
^bb2():
  ret %4
}
`);
  expect(src).not.toMatch(/= a2 \/ a1;/);
  expect(src).toMatch(/\*a0 = a1;\n\s+if \(a1 <= 0 \|\| a2 \/ a1 == 0\)/);
});

// agbcc: `t = k / n; *q = n; return t + 1;` — the `bl __divsi3` ahead of the `str`, which
// raise/softdiv.ts folds to the `sdiv` the rule places.
const THUMB_DIV_STORE = `sl:
	push	{r4, r5, lr}
	add	r5, r0, #0
	add	r4, r1, #0
	add	r0, r2, #0
	add	r1, r4, #0
	bl	__divsi3
	str	r4, [r5]
	add	r0, r0, #0x1
	pop	{r4, r5}
	pop	{r1}
	bx	r1
`;

test('agbcc’s __divsi3 ahead of a store stays ahead of it through the pipeline', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('sl', THUMB_DIV_STORE, ARMV4T_AGBCC, { sl: { params: 3 } });
  applyIdiomPatterns(fn, ARMV4T_AGBCC);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, { params: 3 });
  const src = cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)));
  expect(src).toMatch(/v0 = a2 \/ a1;\n\s+\*a0 = a1;\n\s+return v0 \+ 1;/);
});

test('a divide by a nonzero constant cannot fault, and stays inline', () => {
  const src = emit(DIV_STORE.replace('%3: s32 = sdiv %2, %1', '%8: s32 = const {value=15}\n  %3: s32 = sdiv %2, %8'));
  expect(src).toMatch(/\*a0 = a1;\n\s+return a2 \/ 15 \+ 1;/);
});
