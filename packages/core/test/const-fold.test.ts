// The 32-bit-literal fold (`raise/const.ts` recognizeConsts, L1 pre-recovery): a const/const `or`/`add`
// becomes one `const`, because that is how a RISC target spells a 32-bit literal it cannot encode in one
// instruction (`lui;ori`, `lis;ori`) and the later levels need it as ONE value to type or to divide by.
//
// What these tests pin is the pass's CLIENTELE, which is the whole of its correctness: an operand a
// terminator also hands to a successor's block-parameter is a register the compiler held live across a
// branch, whose value on this path happens to be constant, and folding it deletes the register. The pair
// the pass exists for is NOT confined to one block and NOT confined to a RISC target (see the module
// header for both measurements), so the refusal is bought back by two carve-outs, one per case below:
// case (b) an address literal an arm carries, case (d) a recognisable hi/lo pair an arm carries.
//
// Asserted on the IR wherever what is at stake is whether a value still exists. The ONE exception is
// the last case, which asserts the emitted C: an IR-only suite is exactly what let the refusal ship a
// candidate spelling `v = 0 + 1;`, so the residue's SPELLING needs a pin of its own.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { Fn, Op } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recognizeConsts } from '../src/raise/const';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const ops = (fn: Fn): Op[] => fn.blocks.flatMap((b) => b.ops);
const run = (ir: string): { fn: Fn; changed: boolean } => {
  const fn = parse(ir);
  verify(fn);
  const changed = recognizeConsts(fn);
  verify(fn);
  return { fn, changed };
};

// ── (a) the clientele: a two-instruction 32-bit literal ──────────────────────────────────────
// `lui $t,0x0800 ; ori $t,$t,0x1234` — two consts defined in the same block, neither of which the
// compiler ever held in a register on its own.
const HILO = `fn hilo {
^bb0(%0: s32*):
  %1: s32 = const {value=134217728}
  %2: s32 = const {value=4660}
  %3: s32 = or %1, %2
  store %0, %3 {off=0, width=4}
  ret
}
`;

test('the RISC hi/lo pair still folds to one const', () => {
  const { fn, changed } = run(HILO);
  expect(changed).toBe(true);
  const or = ops(fn).find((o) => o.opcode === 'or');
  expect(or).toBeUndefined();
  const folded = ops(fn).filter((o) => o.opcode === 'const' && o.attrs.value === 0x08001234);
  expect(folded).toHaveLength(1);
});

// ── (b) the carve-out: an address literal an arm carries ─────────────────────────────────────
// `%2` IS handed to ^bb1 as a block-parameter, so the refusal's first clause holds — but the fold's
// result is a load's base, i.e. the value is an address being materialised, which is what the pass
// exists for. It folds.
const ADDRLIT = `fn addrlit {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=50337792}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb1(%2), ^bb2()
^bb1(%5: s32):
  store %1, %5 {off=0, width=4}
  ret
^bb2():
  %6: s32 = const {value=1206}
  %7: s32 = add %2, %6
  %8: s32 = load %7 {off=0, width=4, signed=true}
  store %1, %8 {off=0, width=4}
  ret
}
`;

test('a const base an arm carries still folds when the result is a memory base', () => {
  const { fn, changed } = run(ADDRLIT);
  expect(changed).toBe(true);
  expect(ops(fn).find((o) => o.opcode === 'add')).toBeUndefined();
  expect(ops(fn).filter((o) => o.opcode === 'const' && o.attrs.value === 50337792 + 1206)).toHaveLength(1);
});

// ── (c) the refusal: an accumulator ──────────────────────────────────────────────────────────
// agbcc's `s = 0; if (c) s += 1;`. `%2` is the accumulator's zero-init, handed to the join on the
// not-taken edge; the taken arm's `add %2, 1` is an INCREMENT of that register, not a literal. Fold
// it and `%2` has no use left, the join sees an arm that materialises `1`, and `/merge-home` — the
// axis that would hoist the init — never enumerates because its merge feed is gone.
const ACC = `fn acc {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb2(%2), ^bb1()
^bb1():
  %5: s32 = const {value=1}
  %6: s32 = add %2, %5
  br ^bb2(%6)
^bb2(%7: s32):
  store %1, %7 {off=0, width=4}
  ret
}
`;

test('an increment of a register carried across a branch is left unfolded', () => {
  const { fn, changed } = run(ACC);
  expect(changed).toBe(false);
  const add = ops(fn).find((o) => o.opcode === 'add');
  expect(add).toBeDefined();
  // the accumulator's init is still a value the arm reads — which is the point
  expect(add?.operands[0]).toBe(fn.blocks[0].ops[0].results[0]);
  expect(ops(fn).some((o) => o.opcode === 'const' && o.attrs.value === 1 && o.results[0] === add?.results[0])).toBe(
    false,
  );
});

// ── (d) the carve-out: a genuine hi/lo pair the compiler SHARED across a branch ───────────────
// mwcc builds `0x12349ABC` as `lis r,0x1235 ; addi r,r,-25924` and hoists the `lis` above a branch
// whenever the high half is live at the join, so the pass's OWN clientele arrives edge-carried and
// case (c)'s proxy would refuse it. The result here is a store's VALUE, not a base, so the address
// carve-out cannot save it — the hi/lo shape must. Measured on the real toolchain before this case
// existed: mwcc_242_81 emitted `*a2 = 305397760 + 22136;` where every other toolchain emitted the
// folded literal, and a literal split in two is no longer one value for magic-division recovery,
// type recovery or the symbol map.
//
// Note the NEGATIVE low half: `addi`'s immediate is signed, so a low half with bit 15 set arrives as
// a negative number and a low-half test written for `ori`'s unsigned immediate alone rejects it.
const HILOEDGE = `fn hiloedge {
^bb0(%0: s32, %1: s32*, %2: s32*):
  %3: s32 = const {value=305463296}
  %4: s32 = const {value=0}
  %5: u32 = icmp_eq %0, %4
  cond_br %5, ^bb2(%3), ^bb1()
^bb1():
  %6: s32 = const {value=-25924}
  %7: s32 = add %3, %6
  store %2, %7 {off=0, width=4}
  ret
^bb2(%8: s32):
  store %1, %8 {off=0, width=4}
  ret
}
`;

test('a hi/lo pair an arm carries still folds, negative low half included', () => {
  const { fn, changed } = run(HILOEDGE);
  expect(changed).toBe(true);
  expect(ops(fn).find((o) => o.opcode === 'add')).toBeUndefined();
  expect(ops(fn).filter((o) => o.opcode === 'const' && o.attrs.value === 0x12349abc)).toHaveLength(1);
});

// The degenerate "high half" is what separates (d) from (c): `lui rD, 0` is a no-op no compiler
// emits, so a `const 0` must NOT be read as a materialised half. Without that exclusion (d)'s rule
// swallows every accumulator init and case (c) is dead.
const ACCLIKE_HI = `fn acclikehi {
^bb0(%0: s32, %1: s32*):
  %2: s32 = const {value=0}
  %3: s32 = const {value=0}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb2(%2), ^bb1()
^bb1():
  %5: s32 = const {value=4660}
  %6: s32 = add %2, %5
  br ^bb2(%6)
^bb2(%7: s32):
  store %1, %7 {off=0, width=4}
  ret
}
`;

test('a zero init is not a high half, so a large increment of it is still refused', () => {
  const { fn, changed } = run(ACCLIKE_HI);
  expect(changed).toBe(false);
  expect(ops(fn).find((o) => o.opcode === 'add')).toBeDefined();
});

// ── (e) the residue's SPELLING: a refused pair must still print as the literal it is ──────────
// Case (c) leaves `add(const 0, const 1)` in the IR on purpose, so that `/merge-home` can enumerate
// `v = 0; if (c) v = v + 1;`. Every candidate that does NOT take that axis inlines both operands,
// and without a print-time fold the winning source ships `v = 0 + 1;` — measured on
// `synthetic:fib:gcc2.7.2kmc`, which regressed from `v1 = 1;` to `v1 = 0 + 1;` and stayed diff:12
// throughout, because the target compiler folds the constant expression and no score gate can see
// the difference. What is at stake is the artifact, so this one is asserted on the string.
test('a refused pair still prints as its literal in a candidate that does not home the register', () => {
  const fn = parse(ACC);
  verify(fn);
  recognizeConsts(fn);
  recoverTypes(fn);
  const out = cBackend.emit(structure(fn, { homeMergeFeeds: false, returnsVoid: true }));
  expect(out).not.toMatch(/0 \+ 1/);
  expect(out).toMatch(/= 1;/);
});
