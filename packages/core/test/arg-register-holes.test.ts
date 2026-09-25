// An argument register the body never reads still has a slot in the signature. Naming is positional,
// so without it every later argument binds one ABI slot low and the C compiles to a function that
// reads the wrong register. One case per frontend: `int gap(int a, int b, int c) { return a + c; }`
// as each compiler emits it (mwcc_242_81 and agbcc objects, compiled; MIPS hand-written).
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO, PPC_MWCC } from '../src/target';

test.each([
  ['PowerPC', '0 <gap>:\n0:\tadd     r3,r3,r5\n4:\tblr\n', PPC_MWCC],
  ['Thumb', 'gap:\n\tadd\tr0, r0, r2\n\tbx\tlr\n', ARMV4T_AGBCC],
  ['MIPS', '00000000 <gap>:\n   0:\tjr\tra\n   4:\taddu\tv0,a0,a2\n', MIPS_IDO],
])('%s: an unread middle argument keeps its slot', (_isa, asm, target) => {
  const out = decompile('gap', asm, target).source;
  expect(out).toContain('gap(s32 a0, s32 a1, s32 a2)');
  expect(out).toContain('return a0 + a2;');
});

test('nothing is minted above the highest argument register read', () => {
  expect(decompile('two', '0 <two>:\n0:\tadd     r3,r3,r4\n4:\tblr\n', PPC_MWCC).source).toContain(
    'two(s32 a0, s32 a1) {',
  );
});

// mwcc_242_81 at canonical flags, compiled: `int gh(int a, int b, int n) { do b = b * b; while (--n);
// return b; }`. The loop starts at the function's first instruction, so the entry is a loop header;
// its parameters are still the function's, in ABI order, with the unread `a` in slot 0.
test('PowerPC: a loop at the entry still binds each argument to its own slot', () => {
  const gh =
    '00000000 <gh>:\n0:\tmullw   r4,r4,r4\n4:\taddic.  r5,r5,-1\n8:\tbne     0 <gh>\nc:\tmr      r3,r4\n10:\tblr\n';
  const out = decompile('gh', gh, PPC_MWCC).source;
  expect(out).toContain('gh(s32 a0, s32 a1, s32 a2)');
  expect(out).toMatch(/= a1;[\s\S]*= a2;/);
});

// The same shape by hand for MIPS: a loop at the first instruction, reading a1 and a2 only.
test('MIPS: a loop at the entry still binds each argument to its own slot', () => {
  const gh =
    '00000000 <gh>:\n   0:\tmult\ta1,a1\n   4:\tmflo\ta1\n   8:\taddiu\ta2,a2,-1\n' +
    '   c:\tbnez\ta2,0 <gh>\n  10:\tnop\n  14:\tjr\tra\n  18:\tmove\tv0,a1\n';
  const out = decompile('gh', gh, MIPS_IDO).source;
  expect(out).toContain('gh(s32 a0, s32 a1, s32 a2)');
  expect(out).toContain('a1 = a1 * a1;');
  expect(out).toContain('return a1;');
});

// mwcc_242_81 at canonical flags, compiled: `int lp2(int *p, int n) { int i; int v; for (i = 0;
// i < n; i++) { v = p[i]; if (v <= 0) break; } return v == 0 ? 7 : 9; }`. `v` is read uninitialised
// when `n <= 0`, so r0 is a live-in no argument arrives in. It goes after the arguments: ranked
// first, it took `a0` and bound `p` to `a1` and `n` to `a2`.
test('a live-in no argument arrives in ranks after every argument', () => {
  const lp2 =
    '00000000 <lp2>:\n0:\tmtctr   r4\n4:\tcmpwi   r4,0\n8:\tble     20 <lp2+0x20>\nc:\tlwz     r0,0(r3)\n' +
    '10:\tcmpwi   r0,0\n14:\tble     20 <lp2+0x20>\n18:\taddi    r3,r3,4\n1c:\tbdnz    c <lp2+0xc>\n' +
    '20:\tcmpwi   r0,0\n24:\tli      r3,9\n28:\tbnelr\n2c:\tli      r3,7\n30:\tblr\n';
  expect(decompile('lp2', lp2, PPC_MWCC).source).toContain('lp2(s32 *a0, s32 a1, s32 a2)');
});
