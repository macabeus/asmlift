// CodeWarrior 2.4.x's branch-free compares (pattern/engine.ts MWCC_COMPARE_PATTERNS): bit tricks
// over the two operands, with no carry and no branch. Toolchain-free: each fixture is the objdump
// text 2.4.2 and 2.4.7 emit at -O4,p, lifted and EVALUATED over edge words (`evalWords`) — raw, and
// again after the idiom folds, where the function must be the one compare the source wrote.
import { describe, expect, test } from 'vitest';

import { lift } from '../src/frontend/ppc';
import type { Fn } from '../src/ir/core';
import { applyIdiomPatterns } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';
import { agreesOverWords, edgeWords, ppcFixture } from './helpers';

const WORDS = edgeWords(24);
const u = (x: number) => x >>> 0;
const s = (x: number) => x | 0;
const b = (c: boolean) => (c ? 1 : 0);

const lifted = (body: string[], fold: boolean): Fn => {
  const fn = lift('f', ppcFixture('f', body), PPC_MWCC);
  if (fold) {
    applyIdiomPatterns(fn, PPC_MWCC);
  }
  return fn;
};

// a = r3, b = r4; `>`/`<=` are the same code with the registers swapped, and the `k` forms put
// `li rN,10` (or `subfic`/`addi -10`) where the compiler does.
const FORMS: [string, string, string[], (a: number, b: number) => boolean][] = [
  [
    'a <u b',
    'icmp_ult',
    ['xor     r0,r4,r3', 'cntlzw  r0,r0', 'slw     r0,r4,r0', 'srwi    r3,r0,31'],
    (x, y) => u(x) < u(y),
  ],
  [
    'a >u b',
    'icmp_ult',
    ['xor     r0,r3,r4', 'cntlzw  r0,r0', 'slw     r0,r3,r0', 'srwi    r3,r0,31'],
    (x, y) => u(x) > u(y),
  ],
  [
    'a <u 10',
    'icmp_ult',
    ['li      r4,10', 'xor     r0,r4,r3', 'cntlzw  r0,r0', 'slw     r0,r4,r0', 'srwi    r3,r0,31'],
    (x) => u(x) < 10,
  ],
  [
    'a >=u b',
    'icmp_uge',
    ['subf    r0,r4,r3', 'orc     r3,r3,r4', 'srwi    r0,r0,1', 'subf    r0,r0,r3', 'srwi    r3,r0,31'],
    (x, y) => u(x) >= u(y),
  ],
  [
    'a <=u b',
    'icmp_uge',
    ['subf    r0,r3,r4', 'orc     r3,r4,r3', 'srwi    r0,r0,1', 'subf    r0,r0,r3', 'srwi    r3,r0,31'],
    (x, y) => u(x) <= u(y),
  ],
  [
    'a <=u 10',
    'icmp_uge',
    [
      'subfic  r0,r3,10',
      'li      r4,10',
      'orc     r3,r4,r3',
      'srwi    r0,r0,1',
      'subf    r0,r0,r3',
      'srwi    r3,r0,31',
    ],
    (x) => u(x) <= 10,
  ],
  [
    'a >=u 10',
    'icmp_uge',
    [
      'addi    r0,r3,-10',
      'li      r4,10',
      'orc     r3,r3,r4',
      'srwi    r0,r0,1',
      'subf    r0,r0,r3',
      'srwi    r3,r0,31',
    ],
    (x) => u(x) >= 10,
  ],
  [
    'a <s b',
    'icmp_slt',
    ['xor     r0,r4,r3', 'srawi   r3,r0,1', 'and     r0,r0,r4', 'subf    r0,r0,r3', 'srwi    r3,r0,31'],
    (x, y) => s(x) < s(y),
  ],
  [
    'a >s b',
    'icmp_slt',
    ['xor     r0,r3,r4', 'srawi   r4,r0,1', 'and     r0,r0,r3', 'subf    r0,r0,r4', 'srwi    r3,r0,31'],
    (x, y) => s(x) > s(y),
  ],
  [
    'a <s 10',
    'icmp_slt',
    [
      'li      r4,10',
      'xor     r0,r4,r3',
      'srawi   r3,r0,1',
      'and     r0,r0,r4',
      'subf    r0,r0,r3',
      'srwi    r3,r0,31',
    ],
    (x) => s(x) < 10,
  ],
];

describe('2.4.x branch-free compares fold to the compare, and still compute it', () => {
  test.each(FORMS)('%s', (_, cmp, body, want) => {
    agreesOverWords(lifted(body, false), (x, y) => b(want(x, y)), WORDS);
    const fn = lifted(body, true);
    agreesOverWords(fn, (x, y) => b(want(x, y)), WORDS);
    expect(fn.blocks[0].ops.map((o) => o.opcode).filter((o) => o !== 'const')).toEqual([cmp, 'ret']);
  });

  test('a shape whose operands disagree computes something else and is left written', () => {
    // the clz form shifts neither xor operand; the orc form subtracts the wrong way round; the
    // signed form masks with neither
    for (const body of [
      ['xor     r0,r4,r3', 'cntlzw  r0,r0', 'slw     r0,r5,r0', 'srwi    r3,r0,31'],
      ['subf    r0,r3,r4', 'orc     r3,r3,r4', 'srwi    r0,r0,1', 'subf    r0,r0,r3', 'srwi    r3,r0,31'],
      ['xor     r0,r4,r3', 'srawi   r3,r0,1', 'and     r0,r0,r5', 'subf    r0,r0,r3', 'srwi    r3,r0,31'],
    ]) {
      expect(lifted(body, true).blocks[0].ops.some((o) => o.opcode.startsWith('icmp_'))).toBe(false);
    }
  });

  test('another compiler keeps the arithmetic', () => {
    const fn = lift('f', ppcFixture('f', FORMS[0][2]), PPC_MWCC);
    applyIdiomPatterns(fn, { ...PPC_MWCC, compiler: 'agbcc' });
    expect(fn.blocks[0].ops.some((o) => o.opcode.startsWith('icmp_'))).toBe(false);
  });
});
