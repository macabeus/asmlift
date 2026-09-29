// TWO LOOPS ON ONE HEADER.
//
// `do { while ((m = f()) < n); g(m); } while (h(m) < 0);` compiles to a block that branches back to
// itself (the inner `while`) and a later latch that branches back to the same block (the outer
// `do-while`). The back-edge analysis keys a loop by its header, so it reports ONE loop with both
// latches; `sharedHeaderNest` splits it back into the two. The outer loop is a do-while whose body
// opens with the inner one, a single-block do-while.
//
// Each accepted fixture is run against its own IR (`irAgreement`), as `structure()` returns it and
// as it ships after `readabilityRewrites`.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { dominators } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { analyzeLoops, sharedHeaderNest } from '../src/structure/loops';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const judged = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn);
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

const nestOf = (ir: string) => {
  const fn = parse(ir);
  const [nl] = analyzeLoops(fn, dominators(fn)).byHeader.values();
  const nest = sharedHeaderNest(nl);
  return nest && { latch: fn.blocks.indexOf(nest.latch), innerExit: fn.blocks.indexOf(nest.innerExit) };
};

/** `do { while ((m = f(a0)) < a1); g(m); } while (h(m) < 0);` */
const NEST = `fn nest {
^bb0(%0: s32, %1: s32):
  br ^bb1()
^bb1():
  %2: s32 = call %0 {target="f"}
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(), ^bb2()
^bb2():
  %4: s32 = call %2 {target="g"}
  br ^bb3()
^bb3():
  %5: s32 = call %2 {target="h"}
  %6: s32 = const {value=0}
  %7: u32 = icmp_slt %5, %6
  cond_br %7, ^bb1(), ^bb4()
^bb4():
  ret %2
}`;
/** A value both loops carry: `x = 0; do { do { x++; } while (x < a1); g(x); } while (h(x) < a0);` */
const NEST_CARRIED = `fn nestc {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %5, %1
  cond_br %6, ^bb1(%5), ^bb2()
^bb2():
  %7: s32 = call %5 {target="g"}
  br ^bb3()
^bb3():
  %8: s32 = call %5 {target="h"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%5), ^bb4()
^bb4():
  ret %5
}`;
/** The rest of the outer body reads the value the inner header was entered with, which the inner
 *  update copy has already overwritten. */
const NEST_READS_PRE_UPDATE = `fn nestpre {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: u32 = icmp_slt %5, %1
  cond_br %6, ^bb1(%5), ^bb2()
^bb2():
  %7: s32 = call %3 {target="g"}
  br ^bb3()
^bb3():
  %8: s32 = call %5 {target="h"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%5), ^bb4()
^bb4():
  ret %5
}`;

/** The other latch is the block the inner loop leaves for, with no outer body between them: one
 *  loop's `do { m = f(a0); } while (m < a1 || h(m) < 0);` left as branches (`loop-forever.test.ts`),
 *  not a nest. */
const CHAIN = `fn chain {
^bb0(%0: s32, %1: s32):
  br ^bb1()
^bb1():
  %2: s32 = call %0 {target="f"}
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(), ^bb2()
^bb2():
  %4: s32 = call %2 {target="h"}
  %5: s32 = const {value=0}
  %6: u32 = icmp_slt %4, %5
  cond_br %6, ^bb1(), ^bb3()
^bb3():
  ret %2
}`;

test('a header that is its own latch beside another latch is two loops', () => {
  expect(nestOf(NEST)).toEqual({ latch: 3, innerExit: 2 });
  expect(nestOf(CHAIN)).toBeNull();
});

test('the outer do-while opens with the inner self-loop', () => {
  const r = judged(NEST);
  expect(r.src).toBe(
    's32 nest(s32 a0, s32 a1) {\n    s32 v0;\n    do {\n        do {\n            v0 = f(a0);\n' +
      '        } while (v0 < a1);\n        g(v0);\n    } while ((s32)h(v0) < 0);\n    return v0;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a value both loops carry is one variable both updates write', () => {
  const r = judged(NEST_CARRIED);
  expect(r.src).toBe(
    's32 nestc(s32 a0, s32 a1) {\n    s32 v0;\n    v0 = 0;\n    do {\n        do {\n' +
      '            v0 = v0 + 1;\n        } while (v0 < a1);\n        g(v0);\n    } while ((s32)h(v0) < a0);\n' +
      '    return v0;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a read of the value the inner header was entered with, after the inner loop, declines LOUD', () => {
  expect(() => judged(NEST_READS_PRE_UPDATE)).toThrow(/reads a pre-update loop variable/);
});
