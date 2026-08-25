// THE RETURN REGISTER IS A WORD. `returnType` reads the type of the value a `ret` carries, and that
// value's type says how it was COMPUTED — in the pipeline today, only ever by raise/paramwidth.ts
// narrowing the parameter it returns — not what the header spelled. The two load cases below carry
// a width no frontend produces (every lifted value starts `unk32`, and recovery types a load's BASE
// rather than its result); they pin the rule over the whole `int` domain, not a reachable shape. Declaring the narrow type is a different function on a compiler whose ABI puts
// the extension on the caller: compiled against the benchmark's own mwcc, `s8 sextb(s8 x) { return
// x; }` drops the `extsb` that `s32 sextb(s8 x) { return x; }` keeps and the target has, while
// agbcc emits both spellings identically. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { returnType } from '../src/raise/recover';

const retOf = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  return returnType(fn);
};

const returning = (decl: string, value: string) => `fn f {
^bb0(%0: s32*):
  ${decl}
  ret ${value}
}
`;

describe('a narrow value in the return register does not narrow the declared return type', () => {
  test('a byte load returns a word', () => {
    expect(retOf(returning('%1: u8 = load %0 {off=0, width=1, signed=false}', '%1'))).toEqual(T.s(32));
  });

  test('a half load returns a word', () => {
    expect(retOf(returning('%1: s16 = load %0 {off=0, width=2, signed=true}', '%1'))).toEqual(T.s(32));
  });

  test('a prologue-narrowed parameter returns a word', () => {
    expect(
      retOf(`fn f {
^bb0(%0: s16):
  ret %0
}
`),
    ).toEqual(T.s(32));
  });
});

describe('everything else the return register can carry is unchanged', () => {
  test('a word keeps its own signedness', () => {
    expect(retOf(returning('%1: u32 = load %0 {off=0, width=4, signed=false}', '%1'))).toEqual(T.u(32));
  });

  test('a pointer is a pointer', () => {
    expect(retOf(returning('%1: s32* = load %0 {off=0, width=4, signed=true}', '%1'))).toEqual(T.ptr(T.s(32)));
  });

  test('an operand-less `ret` is void', () => {
    expect(
      retOf(`fn f {
^bb0(%0: s32*):
  ret
}
`),
    ).toEqual(T.void());
  });
});
