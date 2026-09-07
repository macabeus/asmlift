// The 32-bit-literal fold (`raise/const.ts` recognizeConsts, L1 pre-recovery): a const/const `or`/`add`
// becomes one `const`, because that is how a RISC target spells a 32-bit literal it cannot encode in one
// instruction (`lui;ori`, `lis;ori`) and the later levels need it as ONE value to type or to divide by.
//
// What these tests pin is the pass's CLIENTELE, which is the whole of its correctness: the pair it exists
// for is two consts materialised inside one block, so an operand a terminator also hands to a successor's
// block-parameter — a register the compiler held live across a branch, whose value on this path happens to
// be constant — is NOT that pair, and folding it deletes the register. The carve-out for a result used as
// a memory base is the address literal, which is the clientele even when an arm carries the base.
//
// Asserted on the IR, never on an emitted string: what is at stake is whether a value still exists.
import { expect, test } from 'vitest';

import { Fn, Op } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recognizeConsts } from '../src/raise/const';

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
