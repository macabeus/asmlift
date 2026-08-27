// The promise between `ir/simplify.ts`'s param prune and `raise/struct-arrays.ts`'s block-arg
// guard. Each is unit-tested alone (dead-params.test.ts, struct-arrays-guards.test.ts); what has
// no other home is that the guard is only AFFORDABLE because the prune runs first.
//
// The guard refuses any element pointer that reaches a successor arg, because a carried element
// is a use the rewrite cannot see — retype the base under a live carry and the scaling `add`
// starts rendering as pointer arithmetic, double-scaling the index into a wrong address. The
// price of stating it that bluntly is that an ARTEFACTUAL carry refuses too, and the frontend
// mints those: a register left holding a stale pointer joins as a ring of block params that feed
// only each other. Weaken the guard and the hazard is back; drop the prune and the capability
// silently stops firing on every function that has such a ring.
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { pruneDeadParams } from '../src/ir/simplify';
import { verify } from '../src/ir/verify';
import { recognizeStructArrays } from '../src/raise/struct-arrays';

// One element pointer with ONE field access, threaded around a two-block ring that nothing reads —
// synthetic:dmanest's shape, reduced. %7 and %8 feed only each other.
const DEAD_RING = `fn f {
^bb0(%0: s32, %1: unk32):
  %2: s32 = const {value=0}
  %3: s32 = shl %0 {imm=3}
  %4: unk32 = add %1, %3
  %5: s32 = load %4 {off=4, signed=true, width=4}
  %6: u32 = icmp_ne %5, %2
  br ^bb1(%4)
^bb1(%7: unk32):
  cond_br %6, ^bb2(%7), ^bb3()
^bb2(%8: unk32):
  br ^bb1(%8)
^bb3():
  ret %5
}
`;

// The same ring, but the loop exit hands the element pointer to `ret` — a carry a reader really
// does depend on, and the one the guard exists for.
const LIVE_RING = DEAD_RING.replace('cond_br %6, ^bb2(%7), ^bb3()', 'cond_br %6, ^bb2(%7), ^bb3(%7)')
  .replace('^bb3():', '^bb3(%9: unk32):')
  .replace('ret %5', 'ret %9');

describe('struct-array recovery through a dead param ring', () => {
  test('an element pointer carried only by a dead ring recovers once the ring is gone', () => {
    const fn = parse(DEAD_RING);
    expect(pruneDeadParams(fn)).toBe(2);
    verify(fn);
    expect(recognizeStructArrays(fn)).toBe(1);
  });

  test('the prune is load-bearing: the same function declines with the ring still on it', () => {
    const fn = parse(DEAD_RING);
    expect(recognizeStructArrays(fn)).toBe(0);
  });

  test('a carry a reader depends on still declines, prune or no prune', () => {
    const fn = parse(LIVE_RING);
    expect(pruneDeadParams(fn)).toBe(0);
    verify(fn);
    expect(recognizeStructArrays(fn)).toBe(0);
  });
});
