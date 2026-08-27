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

// %2 and %4 feed ONLY each other around the loop and no op reads either: a mutually-dead cycle,
// the shape the Thumb frontend mints for a register the epilogue leaves holding a stale pointer.
// A per-round reader scan calls each one the other's reader and neither ever dies.
const DEAD_CYCLE = `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_ne %0, %0
  cond_br %3, ^bb2(%2), ^bb3()
^bb2(%4: s32):
  br ^bb1(%4)
^bb3():
  ret
}
`;

// The same cycle with ONE real op operand on it: liveness has to flow backwards around the whole
// ring, so neither slot may go.
const LIVE_CYCLE = DEAD_CYCLE.replace('br ^bb1(%4)', '%5: s32 = add %4, %4\n  br ^bb1(%4)');

// An entry block that is ALSO a loop header: nothing reads entry param %1, but entry params are
// never removed, so the back edge keeps feeding slot 1 — and %4, which is what it feeds, must stay
// defined or that arg dangles.
const ENTRY_IS_HEADER = `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_ne %0, %2
  cond_br %3, ^bb1(%2), ^bb2()
^bb1(%4: s32):
  br ^bb0(%0, %4)
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

  test('a mutually-dead cycle of params dies — an edge arg is a read only if its slot is live', () => {
    const fn = parse(DEAD_CYCLE);
    expect(pruneDeadParams(fn)).toBe(2);
    verify(fn);
    const out = print(fn);
    expect(out).toContain('^bb1():');
    expect(out).toContain('^bb2():');
    expect(out).toContain('^bb2(), ^bb3()'); // the forward arg went with the slot
    expect(out).toContain('br ^bb1()'); // and so did the back edge's
  });

  test('one real op operand keeps the whole cycle', () => {
    const fn = parse(LIVE_CYCLE);
    expect(pruneDeadParams(fn)).toBe(0);
    verify(fn);
  });

  test('a function with no blocks is a no-op, not a throw', () => {
    expect(pruneDeadParams(parse('fn f {\n}\n'))).toBe(0);
  });

  test('a back edge into the entry block keeps what it feeds, even into a slot nothing reads', () => {
    const fn = parse(ENTRY_IS_HEADER);
    expect(pruneDeadParams(fn)).toBe(0);
    verify(fn);
    expect(print(fn)).toContain('^bb1(%4: s32):');
  });

  // Liveness here runs BACKWARD along the edges, so a round-robin sweep of `fn.blocks` in forward
  // order advances it one hop per round and costs the SQUARE of the chain length. A worklist over
  // an inverted edge index is linear whatever the block order. This is shared L1 substrate that
  // runs once per lift on every ISA, and klonoa holds a single 28652-byte function; today's agbcc
  // corpus tops out at 107 blocks, so nothing but a test reaches the shape.
  //
  // The budget is measured against `parse` OF THE SAME TEXT rather than a wall clock: parsing is
  // linear in the graph and touches the same structures, so the ratio calibrates itself to the
  // machine. Over a 3001-block chain the two spellings are two orders of magnitude apart —
  // worklist 0.45–0.47× parse, round-robin 48.5–50.7× — so 5 is a threshold neither noise nor a
  // faster laptop can cross. Minimum of three runs, because scheduler noise only ever adds.
  test('liveness is a worklist, not a round-robin sweep — a long param chain stays linear', () => {
    const n = 3000;
    const L = ['fn f {', '^bb0(%0: s32):', '  br ^bb1(%0)'];
    for (let i = 1; i < n; i++) {
      L.push(`^bb${i}(%${i}: s32):`, `  br ^bb${i + 1}(%${i})`);
    }
    L.push(`^bb${n}(%${n}: s32):`, `  %${n + 1}: u32 = icmp_ne %${n}, %${n}`, '  ret', '}');
    const src = L.join('\n') + '\n';

    let parseMs = Infinity,
      pruneMs = Infinity;
    for (let r = 0; r < 3; r++) {
      let t0 = process.hrtime.bigint();
      const fn = parse(src);
      parseMs = Math.min(parseMs, Number(process.hrtime.bigint() - t0) / 1e6);
      t0 = process.hrtime.bigint();
      expect(pruneDeadParams(fn)).toBe(0); // ONE real reader at the far end: nothing is removable
      pruneMs = Math.min(pruneMs, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    expect(pruneMs / parseMs).toBeLessThan(5);
  });
});
