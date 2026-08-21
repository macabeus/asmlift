// Dead join-param pruning (ir/simplify.ts pruneDeadParams).
//
// A register two paths leave holding different values joins as a phi even when nothing ever reads
// the join — the lifter's on-demand construction can mint the phi for a read that later turns out
// to belong to elided epilogue bookkeeping. Left in place, the structurer materializes exit copies
// for it (`a3 = v0` after a loop whose counter nobody consumes) and the guarded-loop machinery
// sees an exit that "carries" a value.
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { pruneDeadParams } from '../src/ir/simplify';
import { verify } from '../src/ir/verify';

const DEAD_JOIN = `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(), ^bb2(%1)
^bb1():
  %3: s32 = const {value=7}
  br ^bb2(%3)
^bb2(%4: s32):
  ret
}
`;

const LIVE_JOIN = `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(), ^bb2(%1)
^bb1():
  %3: s32 = const {value=7}
  br ^bb2(%3)
^bb2(%4: s32):
  ret %4
}
`;

// %5 is read only as the edge arg feeding %7, and %7 is read by nothing: both are dead, but %5
// only becomes visibly dead once %7's slot is gone.
const CHAINED_DEAD = `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(%1), ^bb2(%0)
^bb1(%5: s32):
  br ^bb2(%5)
^bb2(%7: s32):
  ret
}
`;

// The back edge feeds %4 into its own slot; the only other reader is that self-feed.
const SELF_FEED = `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%4: s32):
  %2: u32 = icmp_ne %0, %4
  cond_br %2, ^bb1(%4), ^bb2()
^bb2():
  ret
}
`;

describe('pruneDeadParams', () => {
  test('a join param nothing reads is removed with its edge args', () => {
    const fn = parse(DEAD_JOIN);
    expect(pruneDeadParams(fn)).toBe(1);
    verify(fn);
    const out = print(fn);
    expect(out).toContain('^bb2():');
    expect(out).not.toContain('cond_br %2, ^bb1(), ^bb2(%1)');
  });

  test('a join param the ret reads stays', () => {
    const fn = parse(LIVE_JOIN);
    expect(pruneDeadParams(fn)).toBe(0);
    verify(fn);
  });

  test('a chain of dead params retires across fixpoint rounds', () => {
    const fn = parse(CHAINED_DEAD);
    expect(pruneDeadParams(fn)).toBe(2);
    verify(fn);
    expect(print(fn)).toContain('^bb1():');
  });

  test('a self-feeding back-edge arg does not keep its param alive, a real read does', () => {
    const fn = parse(SELF_FEED);
    expect(pruneDeadParams(fn)).toBe(0); // %4 is read by the icmp — genuinely live
    const dead = parse(SELF_FEED.replace('icmp_ne %0, %4', 'icmp_ne %0, %0'));
    expect(pruneDeadParams(dead)).toBe(1);
    verify(dead);
  });

  test('entry params are never pruned, read or not', () => {
    const fn = parse(DEAD_JOIN);
    pruneDeadParams(fn);
    expect(print(fn)).toContain('^bb0(%0: s32):');
  });
});
