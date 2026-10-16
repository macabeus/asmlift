// The PowerPC carry bit (XER[CA]) — frontend/ppc.ts `readCarry` — and the compares CodeWarrior
// builds through it (pattern/engine.ts MWCC_COMPARE_PATTERNS). Toolchain-free: each fixture is the
// objdump text mwcc emits at -O4,p, lifted and EVALUATED over edge words (`evalWords`) against what
// the instructions compute — raw, and again after the idiom folds, where the function must be the
// one compare the source wrote. The carry-free 2.4.x forms are mwcc-compare.test.ts's.
import { describe, expect, test } from 'vitest';

import { lift } from '../src/frontend/ppc';
import type { Fn } from '../src/ir/core';
import { applyIdiomPatterns, decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';
import { agreesOverWords, edgeWords, ppcFixture } from './helpers';

const fixture = ppcFixture;

const lifted = (body: string[], fold: boolean): Fn => {
  const fn = lift('f', fixture('f', body), PPC_MWCC);
  if (fold) {
    applyIdiomPatterns(fn, PPC_MWCC);
  }
  return fn;
};

const WORDS = edgeWords(24);
const u = (x: number) => x >>> 0;
const s = (x: number) => x | 0;
const b = (c: boolean) => (c ? 1 : 0);
const agrees = (fn: Fn, want: (a: number, b: number) => number) => agreesOverWords(fn, want, WORDS);

describe('each carry writer and reader means what the instruction computes', () => {
  // a in r3, b in r4. `li r0,-1; subfze rD,r0` is ~(-1) + CA = CA: the carry read out bare.
  const bare = ['li      r0,-1', 'subfze  r3,r0'];
  const cases: [string, string[], (a: number, b: number) => number][] = [
    ['subfc: CA = rB >=u rA', ['subfc   r5,r4,r3', ...bare], (a, c) => b(u(a) >= u(c))],
    ['subfco is subfc', ['subfco  r5,r4,r3', ...bare], (a, c) => b(u(a) >= u(c))],
    ['subfic K: CA = K >=u rA', ['subfic  r5,r3,10', ...bare], (a) => b(10 >= u(a))],
    ['subfic 0: CA = rA == 0', ['subfic  r5,r3,0', ...bare], (a) => b(u(a) === 0)],
    ['subfic -1: K is the word 0xffffffff', ['subfic  r5,r3,-1', ...bare], () => 1],
    ['addic -1: CA = rA != 0', ['addic   r5,r3,-1', ...bare], (a) => b(u(a) !== 0)],
    ['addic -10: CA = rA >=u 10', ['addic   r5,r3,-10', ...bare], (a) => b(u(a) >= 10)],
    ['addic 0 never carries', ['addic   r5,r3,0', ...bare], () => 0],
    ['addic 5 carries past 2^32 - 5', ['addic   r5,r3,5', ...bare], (a) => b(u(a) + 5 > 0xffffffff)],
    ['addic. carries as addic', ['addic.  r5,r3,-1', ...bare], (a) => b(u(a) !== 0)],
    ['subfe rY,rY,rY is CA - 1', ['subfc   r0,r4,r3', 'subfe   r3,r0,r0'], (a, c) => b(u(a) >= u(c)) - 1],
    ['subfe over rA = rB - 1 is CA', ['addic   r0,r3,-1', 'subfe   r3,r0,r3'], (a) => b(u(a) !== 0)],
    [
      'subfze over a constant is ~K + CA',
      ['subfc   r0,r4,r3', 'li      r0,5', 'subfze  r3,r0'],
      (a, c) => ~5 + b(u(a) >= u(c)),
    ],
    ['adde is rA + rB + CA', ['subfc   r0,r4,r3', 'adde    r3,r3,r4'], (a, c) => a + c + b(u(a) >= u(c))],
    ['addze is rA + CA', ['subfc   r0,r4,r3', 'addze   r3,r3'], (a, c) => a + b(u(a) >= u(c))],
    [
      'an unmodelled-carry op between leaves the carry',
      ['subfc   r0,r4,r3', 'add     r5,r3,r4', 'addze   r3,r5'],
      (a, c) => a + c + b(u(a) >= u(c)),
    ],
  ];
  test.each(cases)('%s', (_, body, want) => agrees(lifted(body, false), want));
});

describe('the compares mwcc builds through the carry fold to the compare, and still compute it', () => {
  // a = r3, b = r4; `>`/`<=` are the same code with the registers swapped. `>=s` is every build's,
  // the rest 2.3.3's; `==` is every build's, folded once its difference is known to die.
  const forms: [string, string, string[], (a: number, b: number) => boolean][] = [
    [
      'a >=s b',
      'icmp_sge',
      ['srawi   r6,r3,31', 'srwi    r5,r4,31', 'subfc   r0,r4,r3', 'adde    r3,r6,r5'],
      (x, y) => s(x) >= s(y),
    ],
    [
      'a <=s b',
      'icmp_sge',
      ['srawi   r6,r4,31', 'srwi    r5,r3,31', 'subfc   r0,r3,r4', 'adde    r3,r6,r5'],
      (x, y) => s(x) <= s(y),
    ],
    [
      'a >=s 10',
      'icmp_sge',
      ['li      r0,10', 'srawi   r5,r3,31', 'srwi    r4,r0,31', 'subfc   r0,r0,r3', 'adde    r3,r5,r4'],
      (x) => s(x) >= 10,
    ],
    ['2.3.3 a <u b', 'icmp_ult', ['subfc   r3,r4,r3', 'subfe   r0,r0,r0', 'neg     r3,r0'], (x, y) => u(x) < u(y)],
    ['2.3.3 a >=u b', 'icmp_uge', ['subfc   r0,r4,r3', 'li      r0,-1', 'subfze  r3,r0'], (x, y) => u(x) >= u(y)],
    [
      '2.3.3 a <s b',
      'icmp_slt',
      ['eqv     r0,r4,r3', 'subfc   r3,r4,r3', 'srwi    r0,r0,31', 'addze   r3,r0', 'clrlwi  r3,r3,31'],
      (x, y) => s(x) < s(y),
    ],
    [
      '2.3.3 a >s b',
      'icmp_slt',
      ['eqv     r0,r3,r4', 'subfc   r3,r3,r4', 'srwi    r0,r0,31', 'addze   r3,r0', 'clrlwi  r3,r3,31'],
      (x, y) => s(x) > s(y),
    ],
    ['2.3.3 a != b', 'icmp_ne', ['subf    r3,r3,r4', 'addic   r0,r3,-1', 'subfe   r3,r0,r3'], (x, y) => u(x) !== u(y)],
    ['a == b', 'icmp_eq', ['subf    r0,r3,r4', 'cntlzw  r0,r0', 'srwi    r3,r0,5'], (x, y) => u(x) === u(y)],
  ];
  test.each(forms)('%s', (_, cmp, body, want) => {
    agrees(lifted(body, false), (x, y) => b(want(x, y)));
    const fn = lifted(body, true);
    agrees(fn, (x, y) => b(want(x, y)));
    expect(fn.blocks[0].ops.map((o) => o.opcode).filter((o) => o !== 'const')).toEqual([cmp, 'ret']);
  });

  test('2.3.3 tests `x != 0` on its negation, and the fold reads through it', () => {
    // `a != 0` (and `a > 0u`) is `neg; addic -1; subfe`: the `!= 0` is of `x` itself
    const ne0 = lifted(['neg     r3,r3', 'addic   r0,r3,-1', 'subfe   r3,r0,r3'], true);
    agrees(ne0, (x) => b(u(x) !== 0));
    expect(ne0.blocks[0].ops.map((o) => o.opcode).filter((o) => o !== 'const')).toEqual(['icmp_ne', 'ret']);
    // `(a - b) != 0` keeps its subtraction: 2.3.3's `a != b` is `subf; addic; subfe`, with no `neg`
    const diff = lifted(['subf    r0,r4,r3', 'neg     r3,r0', 'addic   r0,r3,-1', 'subfe   r3,r0,r3'], true);
    agrees(diff, (x, y) => b(u(x) !== u(y)));
    expect(diff.blocks[0].ops.map((o) => o.opcode).filter((o) => o !== 'const')).toEqual(['sub', 'icmp_ne', 'ret']);
  });

  test('-(a <u b) is `-(a < b)`, from 2.4.x `subfe rD,rY,rY` and 2.3.3 alike', () => {
    for (const body of [
      ['subfc   r0,r4,r3', 'subfe   r3,r0,r0'],
      ['subfc   r3,r4,r3', 'subfe   r0,r0,r0', 'neg     r0,r0', 'neg     r3,r0'],
    ]) {
      const fn = lifted(body, true);
      agrees(fn, (x, y) => -b(u(x) < u(y)));
      expect(fn.blocks[0].ops.map((o) => o.opcode)).toEqual(['icmp_ult', 'neg', 'ret']);
    }
  });

  test('a shape whose operands disagree computes something else and is left written', () => {
    // a sign word of the wrong operand; a sign test of the wrong pair
    for (const body of [
      ['srawi   r6,r3,31', 'srwi    r5,r3,31', 'subfc   r0,r4,r3', 'adde    r3,r6,r5'],
      ['eqv     r0,r5,r3', 'subfc   r3,r4,r3', 'srwi    r0,r0,31', 'addze   r3,r0', 'clrlwi  r3,r3,31'],
    ]) {
      const ops = lifted(body, true).blocks[0].ops.map((o) => o.opcode);
      expect(ops.filter((o) => ['icmp_slt', 'icmp_sge'].includes(o))).toEqual([]);
    }
  });
});

describe('a carry this frontend cannot name refuses at its reader, saying why', () => {
  const declines = (body: string[]) => () => decompile('f', fixture('f', body), PPC_MWCC);

  test('one no instruction of the block set', () => {
    expect(declines(['addze   r3,r3'])).toThrow(/'addze' at 0x0 reads the carry bit .* another block|block edge/);
    // set in the entry block, read past a branch target
    const asm =
      '0 <f>:\n   0:\tsubfc   r0,r4,r3\n   4:\tcmpwi   r5,0\n   8:\tbeq-    c <f+0xc>\n' +
      '   c:\tli      r0,-1\n  10:\tsubfze  r3,r0\n  14:\tblr\n';
    expect(() => decompile('f', asm, PPC_MWCC)).toThrow(/'subfze' at 0x10 reads the carry bit .*block edge/);
  });

  test('a shift set it (the signed /2^k round-up)', () => {
    expect(declines(['srawi   r0,r3,3', 'addze   r3,r0'])).toThrow(
      /the 'srawi' at 0x0 set it, a carry this frontend does not model/,
    );
  });

  test('a 64-bit add or subtract set it', () => {
    expect(declines(['addc    r4,r4,r6', 'adde    r3,r3,r5'])).toThrow(/the 'addc' at 0x0 set it/);
    // the high half of a 64-bit subtract stays an unmodelled instruction
    expect(declines(['subfc   r4,r6,r4', 'subfe   r3,r5,r3'])).toThrow(/unmodelled instruction 'subfe'/);
    // and its carry out is the high word's
    expect(declines(['subfc   r0,r6,r4', 'subfe   r3,r3,r5', 'subfe   r3,r5,r5'])).toThrow(
      /the 'subfe' at 0x4 set it as the carry out of an extended add or subtract/,
    );
  });

  test('a register `subfze` (a 64-bit negate) stays unmodelled', () => {
    expect(declines(['subfic  r4,r4,0', 'subfze  r3,r3'])).toThrow(/unmodelled instruction 'subfze'/);
  });
});

describe('a `subfze` constant mwcc hoisted out of the loop it sits in', () => {
  // 2.3.3's remainder loop of `x += p[i] >= x`: `li r6,-1` ahead of the loop, `subfze r0,r6` in it
  const loop = (pre: string[]) =>
    '0 <f>:\n' +
    [
      ...pre,
      'mtctr   r5',
      'lwz     r0,0(r3)',
      'addi    r3,r3,4',
      'subfc   r0,r4,r0',
      'subfze  r0,r6',
      'add     r4,r4,r0',
      `bdnz+   ${(4 * (pre.length + 1)).toString(16)} <f+0x${(4 * (pre.length + 1)).toString(16)}>`,
      'mr      r3,r4',
      'blr',
    ]
      .map((ins, i) => `   ${(4 * i).toString(16)}:\t${ins}\n`)
      .join('');

  test('is read as that constant where every path brings it', () => {
    const src = decompile('f', loop(['li      r6,-1']), PPC_MWCC).source;
    expect(src).toMatch(/v\d+ = v\d+ \+ \(\(u32\)\*v\d+ >= v\d+\);|>=/);
    expect(src).not.toMatch(/~/);
  });

  test('refuses where the paths bring different values', () => {
    // r6 is -1 on one path into the join and 5 on the other
    const asm =
      '0 <f>:\n   0:\tcmpwi   r5,0\n   4:\tli      r6,-1\n   8:\tbeq-    10 <f+0x10>\n' +
      '   c:\tli      r6,5\n  10:\tsubfc   r0,r4,r3\n  14:\tsubfze  r3,r6\n  18:\tblr\n';
    expect(() => decompile('f', asm, PPC_MWCC)).toThrow(
      /unmodelled instruction 'subfze' at 0x14 — it reads r6, which is not one constant/,
    );
    // the same constant on both is that constant
    const same = asm.replace('li      r6,5', 'li      r6,-1');
    expect(decompile('f', same, PPC_MWCC).source).toMatch(/a0 >= a1/);
  });
});

test('`subfe rD,rY,rY` reads no rY, so one over the return address mflr copied out still lifts', () => {
  // mwcc 2.3.3's `int t = a < b; g(t); g(t);`, whose `subfe r0,r0,r0` names r0 while it holds LR
  const asm =
    '0 <f>:\n   0:\tmflr    r0\n   4:\tsubfc   r3,r4,r3\n   8:\tstw     r0,4(r1)\n   c:\tsubfe   r0,r0,r0\n' +
    '  10:\tstwu    r1,-24(r1)\n  14:\tstw     r31,20(r1)\n  18:\tneg     r31,r0\n  1c:\taddi    r3,r31,0\n' +
    '  20:\tbl      20 <f+0x20>\n\t\t\t20: R_PPC_REL24\tg\n  24:\tmr      r3,r31\n' +
    '  28:\tbl      28 <f+0x28>\n\t\t\t28: R_PPC_REL24\tg\n  2c:\tlwz     r0,28(r1)\n  30:\tlwz     r31,20(r1)\n' +
    '  34:\taddi    r1,r1,24\n  38:\tmtlr    r0\n  3c:\tblr\n';
  const src = decompile('f', asm, PPC_MWCC, { prototypes: { g: { params: ['s32'], returnsVoid: true } } }).source;
  expect(src).toMatch(/g\(a0 < a1\);[\s\S]*g\(a0 < a1\)/);
});

test('a `bdnz` loop keeps its counter test: the `(b - a) != 0` fold leaves a live difference', () => {
  // mwcc 2.4.2's `for (i = 0; i < e; i++) r *= base;`, unrolled by 8 with a remainder loop: both
  // `bdnz`es test `ctr - 1 != 0` over the counter the next iteration reads
  const body = [
    ...['cmpwi   r4,0', 'li      r6,1', 'li      r7,0', 'ble-    70 <f+0x70>', 'cmpwi   r4,8', 'addi    r5,r4,-8'],
    ...[
      'ble-    58 <f+0x58>',
      'addi    r0,r5,7',
      'srwi    r0,r0,3',
      'mtctr   r0',
      'cmpwi   r5,0',
      'ble-    58 <f+0x58>',
    ],
    ...['mullw   r6,r6,r3', 'addi    r7,r7,8', ...Array<string>(7).fill('mullw   r6,r6,r3'), 'bdnz+   30 <f+0x30>'],
    ...[
      'subf    r0,r7,r4',
      'mtctr   r0',
      'cmpw    r7,r4',
      'bge-    70 <f+0x70>',
      'mullw   r6,r6,r3',
      'bdnz+   68 <f+0x68>',
    ],
    'mr      r3,r6',
  ];
  expect(decompile('f', fixture('f', body), PPC_MWCC).source).toMatch(/\} while \(v\d+ != 0\);/);
});
