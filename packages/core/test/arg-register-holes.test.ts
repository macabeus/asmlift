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
