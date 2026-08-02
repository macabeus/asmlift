// Value numbering for operand-free pure definitions + redundant-param elimination (raise/gvn.ts).
//
// A compiler materializes a global's address wherever it needs one, so two arms of an `if` that both
// touch `gTable` lift to two DISTINCT `gaddr` values, and the merge gets a block param over them.
// Nothing downstream can see they are equal, so the structurer destroys that param into a local and
// assigns it in every arm — inventing a variable the source never had. These two passes only work as
// a pair: numbering makes the incoming values identical, elimination then retires the phi.
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import { dropRedundantParams, numberPureValues } from '../src/raise/gvn';

const TWO_ARMS = `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: u16* = gaddr {sym="gTable"}
  br ^bb3(%3)
^bb2():
  %4: u16* = gaddr {sym="gTable"}
  br ^bb3(%4)
^bb3(%5: u16*):
  %6: s32 = load %5 {off=0, signed=false, width=2}
  ret %6
}
`;

describe('value numbering', () => {
  test('two gaddr of ONE symbol collapse to a single entry-block definition', () => {
    const fn = parse(TWO_ARMS);
    expect(numberPureValues(fn)).toBe(2);
    const out = print(fn);
    expect(out.match(/gaddr/g)).toHaveLength(1);
    // it lands in the ENTRY block, which dominates every use
    expect(fn.blocks[0].ops[0].opcode).toBe('gaddr');
    verify(fn);
  });

  test('DIFFERENT symbols are not numbered together', () => {
    const fn = parse(TWO_ARMS.replace('sym="gTable"}\n  br ^bb3(%4)', 'sym="gOther"}\n  br ^bb3(%4)'));
    expect(numberPureValues(fn)).toBe(0);
    expect(print(fn).match(/gaddr/g)).toHaveLength(2);
  });

  test('a single definition is left alone — it already dominates its own uses', () => {
    const fn = parse(`fn f {
^bb0(%0: s32):
  %1: u16* = gaddr {sym="gTable"}
  %2: s32 = load %1 {off=0, signed=false, width=2}
  ret %2
}
`);
    expect(numberPureValues(fn)).toBe(0);
  });

  test('the `code` attr separates a promoted function pointer from a data address', () => {
    // a code symbol renders `(u32)Name`, a data one `&Name` — the attr is part of what it spells
    const fn = parse(TWO_ARMS.replace('%4: u16* = gaddr {sym="gTable"}', '%4: u16* = gaddr {sym="gTable", code=true}'));
    expect(numberPureValues(fn)).toBe(0);
  });
});

describe('redundant params', () => {
  test('a param whose every edge carries one value is retired', () => {
    const fn = parse(TWO_ARMS);
    numberPureValues(fn);
    expect(dropRedundantParams(fn)).toBe(1);
    expect(fn.blocks.find((b) => b.params.length > 0 && b !== fn.blocks[0])).toBeUndefined();
    verify(fn);
  });

  test('a GENUINE phi (different incoming values) is kept', () => {
    const fn = parse(`fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=7}
  br ^bb3(%3)
^bb2():
  %4: s32 = const {value=9}
  br ^bb3(%4)
^bb3(%5: s32):
  ret %5
}
`);
    expect(dropRedundantParams(fn)).toBe(0);
    verify(fn);
  });

  test('a SELF-REFERENTIAL back-edge arg does not block it — `p = phi(v, p)` is `v`', () => {
    const fn = parse(`fn f {
^bb0(%0: s32):
  %1: u16* = gaddr {sym="gTable"}
  br ^bb1(%1)
^bb1(%2: u16*):
  %3: s32 = load %2 {off=0, signed=false, width=2}
  %4: s32 = const {value=0}
  %5: u32 = icmp_ne %3, %4
  cond_br %5, ^bb1(%2), ^bb2()
^bb2():
  ret %3
}
`);
    expect(dropRedundantParams(fn)).toBe(1);
    verify(fn);
  });

  test('the ENTRY block’s params are never dropped — they are the function’s own parameters', () => {
    const fn = parse(`fn f {
^bb0(%0: s32):
  ret %0
}
`);
    expect(dropRedundantParams(fn)).toBe(0);
    expect(fn.blocks[0].params).toHaveLength(1);
  });
});
