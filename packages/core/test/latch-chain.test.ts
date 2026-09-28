// A DO-WHILE WHOSE `||` TEST IS STILL THREE BRANCHES.
//
// `do { t = f(); } while (t == a || g(t) < b || t < 3);` reaches the structurer as a loop with three
// latches, whenever the IR could not fold the test into one value: a later term calls a function,
// and a fold would run the call on every iteration where the asm ran it only when the terms before
// it failed. The latches form a chain at the loop bottom (`latchChain`), and the chain is the test.
// It is spelled `||` when the later terms render as pure expressions, and `while (1)` with one
// `if (term) continue;` per latch when one of them holds a statement, which no `||` term can carry.
//
// Each accepted fixture is run against its own IR (`irAgreement`), as `structure()` returns it and
// as it ships after `readabilityRewrites`.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { dominators, predecessors } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { analyzeLoops, latchChain } from '../src/structure/loops';
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

const chainOf = (ir: string): number[] | null => {
  const fn = parse(ir);
  const forest = analyzeLoops(fn, dominators(fn));
  const [nl] = forest.byHeader.values();
  return latchChain(nl, predecessors(fn))?.map((b) => fn.blocks.indexOf(b)) ?? null;
};

/** The header is the first term: `do { t = f(a0); } while (t == a1 || g(t) < a0 || t < 3);`. */
const HEADER_FIRST = `fn chain {
^bb0(%0: s32, %1: s32):
  br ^bb1()
^bb1():
  %2: s32 = call %0 {target="f"}
  %3: u32 = icmp_eq %2, %1
  cond_br %3, ^bb1(), ^bb2()
^bb2():
  %4: s32 = call %2 {target="g"}
  %5: u32 = icmp_slt %4, %0
  cond_br %5, ^bb1(), ^bb3()
^bb3():
  %6: s32 = const {value=3}
  %7: u32 = icmp_slt %2, %6
  cond_br %7, ^bb1(), ^bb4()
^bb4():
  ret %2
}`;

/** A loop variable the first latch updates, which every later term hands the header unchanged:
 *  `i = 0; do { i++; t = f(i); } while (t == a1 || g(t) < a0);`. */
const CARRIED = `fn carried {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = call %5 {target="f"}
  %7: u32 = icmp_eq %6, %1
  cond_br %7, ^bb1(%5), ^bb2()
^bb2():
  %8: s32 = call %6 {target="g"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%5), ^bb3()
^bb3():
  ret %5
}`;

/** A later term that holds a STATEMENT — a call whose result nothing reads, run only where the first
 *  term failed. */
const STATEMENT_IN_A_TERM = `fn stmtterm {
^bb0(%0: s32, %1: s32):
  br ^bb1()
^bb1():
  %2: s32 = call %0 {target="f"}
  %3: u32 = icmp_eq %2, %1
  cond_br %3, ^bb1(), ^bb2()
^bb2():
  %4: s32 = call %2 {target="h"}
  %5: s32 = const {value=3}
  %6: u32 = icmp_slt %2, %5
  cond_br %6, ^bb1(), ^bb3()
^bb3():
  ret %2
}`;

/** A later term reading the loop variable's PRE-update value: the update copy has run by the time
 *  any term is tested, so the name holds the next value and the read has no spelling. */
const TERM_READS_PRE_UPDATE = `fn preupd {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = call %5 {target="f"}
  %7: u32 = icmp_eq %6, %1
  cond_br %7, ^bb1(%5), ^bb2()
^bb2():
  %8: s32 = call %3 {target="g"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%5), ^bb3()
^bb3():
  ret %5
}`;

/** Two latches whose back edges carry DIFFERENT values — one update per term, so no single set of
 *  copies serves the test. Not a chain. */
const DIFFERENT_UPDATES = `fn diffupd {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = call %5 {target="f"}
  %7: u32 = icmp_eq %6, %1
  cond_br %7, ^bb1(%5), ^bb2()
^bb2():
  %8: s32 = call %6 {target="g"}
  %9: u32 = icmp_slt %8, %0
  cond_br %9, ^bb1(%4), ^bb3()
^bb3():
  ret %5
}`;

test('the latches of an unfolded `||` test are a chain, header first', () => {
  expect(chainOf(HEADER_FIRST)).toEqual([1, 2, 3]);
  expect(chainOf(CARRIED)).toEqual([1, 2]);
});

test('latches handing the header different values are not a chain', () => {
  expect(chainOf(DIFFERENT_UPDATES)).toBeNull();
});

test('a chain with pure later terms is one `||` test, with its call inside the term that ran it', () => {
  const r = judged(HEADER_FIRST);
  expect(r.src).toBe(
    's32 chain(s32 a0, s32 a1) {\n    s32 v0;\n    do {\n        v0 = f(a0);\n' +
      '    } while (v0 == a1 || (s32)g(v0) < a0 || v0 < 3);\n    return v0;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a chain whose first latch updates a loop variable reads the updated name in every term', () => {
  const r = judged(CARRIED);
  expect(r.src).toBe(
    's32 carried(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    v1 = 0;\n    do {\n' +
      '        v0 = f(v1 + 1);\n        v1 = v1 + 1;\n    } while (v0 == a1 || (s32)g(v0) < a0);\n' +
      '    return v1;\n}\n',
  );
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a later term holding a statement is spelled `while (1)` with a `continue` per term', () => {
  const r = judged(STATEMENT_IN_A_TERM);
  expect(r.src).toContain('while (1) {');
  expect(r.src).toContain('continue;');
  expect(r.src).toContain('break;');
  expect(r.agreement).toEqual({ judged: SEEDS.length, disagree: 0 });
  expect(r.shipped).toEqual({ judged: SEEDS.length, disagree: 0 });
});

test('a later term reading a pre-update loop variable declines LOUD', () => {
  expect(() => judged(TERM_READS_PRE_UPDATE)).toThrow(/reads a pre-update loop variable/);
});

test('latches with different updates still decline LOUD', () => {
  expect(() => judged(DIFFERENT_UPDATES)).toThrow(/unrecovered back-edge/);
});
