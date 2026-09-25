// A test whose two arms say the same thing decides nothing (structure/redundant-test.ts).
// Printed, it reaches the C as a bare statement (`a0[14] >= 1;`): a second read of a value the
// machine loaded once, which no source spells.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { PPC_MWCC } from '../src/target';

// mwcc_242_81 at canonical flags, compiled through `compilePpcTarget`:
//   int g(void);
//   int one0(int *p) { switch (p[14]) { case 1: return g(); case 0: default: return 3; } }
// CodeWarrior folds `case 0:` into `default:` and keeps its test: `bge- 28; b 28`.
const ONE0 = `00000000 <one0>:
   0:\tstwu    r1,-16(r1)
   4:\tmflr    r0
   8:\tstw     r0,20(r1)
   c:\tlwz     r0,56(r3)
  10:\tcmpwi   r0,1
  14:\tbeq-    20 <one0+0x20>
  18:\tbge-    28 <one0+0x28>
  1c:\tb       28 <one0+0x28>
  20:\tbl      20 <one0+0x20>
\t\t\t20: R_PPC_REL24\tg
  24:\tb       2c <one0+0x2c>
  28:\tli      r3,3
  2c:\tlwz     r0,20(r1)
  30:\tmtlr    r0
  34:\taddi    r1,r1,16
  38:\tblr
`;

test('a case folded into the default leaves no bare compare behind', () => {
  const out = decompile('one0', ONE0, PPC_MWCC).source;
  expect(out).not.toMatch(/>= 1;/);
  expect(out).toContain('a0[14] != 1');
});

// The same empty test over a load NOTHING else reads (marioparty4 fn_1_68's shape): that load is
// the machine's one access there, so the statement that performs it stays.
const SOLE = `00000000 <sole>:
   0:\tlwz     r0,76(r3)
   4:\tcmpwi   r0,0
   8:\tbeq-    10 <sole+0x10>
   c:\tb       10 <sole+0x10>
  10:\tli      r3,0
  14:\tblr
`;

test('a test over a load only it reads keeps its read', () => {
  expect(decompile('sole', SOLE, PPC_MWCC).source).toMatch(/a0\[19\] == 0;|a0\[19\] != 0;/);
});

// The two edges carry the same value into a join (ac-decomp aSNMgr_set_appear_info_guest's shape),
// so both arms spell the same copy: still no decision, and the copy is written once.
const SAME_COPY = `00000000 <copy>:
   0:\tli      r5,0
   4:\tlwz     r0,20(r4)
   8:\tcmpwi   r0,1
   c:\tbeq-    18 <copy+0x18>
  10:\tblt-    1c <copy+0x1c>
  14:\tb       1c <copy+0x1c>
  18:\tli      r5,1
  1c:\tmr      r3,r5
  20:\tblr
`;

test('arms that write the same copy leave no bare compare behind', () => {
  const out = decompile('copy', SAME_COPY, PPC_MWCC).source;
  expect(out).not.toMatch(/a1\[5\] [<>]=? 1;/);
  expect(out).toContain('a1[5] != 1');
});

// `*a0` has a second reader, but on the OTHER side of `a1 != 0`: on the `a1 == 0` path the test is
// the machine's only access to it, so the test stays.
const SIBLING = `00000000 <sib>:
   0:\tlwz     r0,0(r3)
   4:\tcmpwi   r4,0
   8:\tbeq-    14 <sib+0x14>
   c:\tstw     r0,0(r5)
  10:\tb       1c <sib+0x1c>
  14:\tcmpwi   r0,0
  18:\tblt-    1c <sib+0x1c>
  1c:\tli      r3,0
  20:\tblr
`;

test('a reader on the sibling path does not stand in for the test', () => {
  const out = decompile('sib', SIBLING, PPC_MWCC).source;
  expect(out).toMatch(/\*a0 [<>]=? 0;/);
  expect(out).toContain('*a2 = *a0;');
});

// The test and its volatile load run on every iteration; the store after the loop reads the last
// value once. That reader post-dominates the test but does not run as often, so it does not stand
// in for the test's read: without the test, the loop would read the register zero times.
const LOOP_EXIT_READER = `fn vd {
^bb0(%0: s32, %1: s32*):
  %2: s32* = gaddr {sym="gVolReg"}
  %4: s32 = const {value=0}
  %9: s32 = const {value=1}
  br ^bb1(%0)
^bb1(%5: s32):
  %3: s32 = load %2 {off=0, signed=true, width=4}
  %6: u32 = icmp_slt %3, %4
  cond_br %6, ^bb2(), ^bb2()
^bb2():
  %7: s32 = sub %5, %9
  %8: u32 = icmp_ne %7, %4
  cond_br %8, ^bb1(%7), ^bb3()
^bb3():
  store %1, %3 {off=0, width=4}
  ret
}
`;

test('a reader after the loop does not stand in for a test inside it', () => {
  const fn = parse(LOOP_EXIT_READER);
  verify(fn);
  recoverTypes(fn);
  const symbols = new Map([
    [
      'gVolReg',
      { name: 'gVolReg', kind: 'data', shape: 'scalar', size: 4, signed: true, declared: true, volatile: true },
    ],
  ]);
  const out = cBackend.emit(structure(fn, { returnsVoid: true, symbols } as Parameters<typeof structure>[1]));
  const loop = out.slice(out.indexOf('do {'), out.indexOf('} while'));
  expect(loop).toContain('gVolReg');
});
