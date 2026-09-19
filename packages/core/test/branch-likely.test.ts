// MIPS branch-likely (`beql`/`bnel`/`b*zl`): the delay slot is NULLIFIED when the branch is not
// taken, so it is CONDITIONAL code, not the ordinary always-executed slot. It is modelled where the
// CFG is built — the slot gets its own block on the taken edge — so every later pass sees ordinary
// conditional execution and nothing downstream carries a special case.
//
// Reading such a slot as an ordinary one emits C that compiles and is wrong (`absi` would return
// `-x` for every `x >= 0`; a store would be performed on a path that never performs it), so every
// shape the placement cannot model refuses loudly and by name instead.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

/** Wrap objdump-shaped body lines (`addr:\tmnemonic\tops`) in a one-function listing. */
const obj = (...lines: string[]) =>
  '\ncorpus.o:     file format elf32-tradbigmips\n\n\nDisassembly of section .text:\n\n00000000 <f>:\n' +
  lines.map((l) => `   ${l}\n`).join('');

const src = (...lines: string[]) => decompile('f', obj(...lines), MIPS_IDO).source;
const lift =
  (...lines: string[]) =>
  () =>
    src(...lines);

test('each unmodelled MIPS control transfer names ITS OWN gap, not a shared catch-all', () => {
  // A branch-likely and an FP condition-code branch are different gaps: the first needs the
  // nullified-slot model, the second needs `fcc`. One message for both misattributes whichever is
  // not being worked on.
  expect(lift('0:\tbc1t\t8 <f+0x8>', '4:\tnop', '8:\tjr\tra', 'c:\tnop')).toThrow(
    /floating-point condition-code branch 'bc1t' at 0x0 — the FP condition code is not modelled/,
  );
  expect(lift('0:\tbc1fl\t8 <f+0x8>', '4:\tnop', '8:\tjr\tra', 'c:\tnop')).toThrow(
    /floating-point condition-code branch 'bc1fl' at 0x0 — the FP condition code is not modelled/,
  );
  // `bltzall` is branch-likely AND link: it is a call, and calls have their own refusal.
  expect(lift('0:\tbltzall\ta0,8 <f+0x8>', '4:\tnop', '8:\tjr\tra', 'c:\tnop')).toThrow(
    /unmodelled control transfer 'bltzall' at 0x0/,
  );
});

test('the nullified slot IS the conditional — `absi` on KMC is one `if`, not an unconditional negate', () => {
  // `int absi(int x){ return x<0?-x:x; }` at KMC GCC 2.7.2. The `negu` in the slot runs only when
  // the branch is taken; executing it unconditionally returns `-x` for every `x >= 0`.
  const absi = decompile(
    'absi',
    '\n00000000 <absi>:\n   0:\tmove\tv0,a0\n   4:\tbltzl\tv0,c <absi+0xc>\n   8:\tnegu\tv0,v0\n   c:\tjr\tra\n  10:\tnop\n',
    MIPS_GCC,
  ).source;
  expect(absi).toBe('s32 absi(s32 a0) {\n    if (a0 < 0) a0 = -a0;\n    return a0;\n}\n');
});

test('a STORE in a nullified slot is performed on the taken path ALONE', () => {
  // The line that makes "read it as an ordinary slot" a silent miscompile rather than a cosmetic
  // one: an unconditional `*a0 = a1` writes memory the function never writes when a1 is zero.
  expect(
    src(
      '0:\tbnezl\ta1,14 <f+0x14>',
      '4:\tsw\ta1,0(a0)',
      '8:\tli\tv0,1',
      'c:\tjr\tra',
      '10:\tnop',
      '14:\tli\tv0,2',
      '18:\tjr\tra',
      '1c:\tnop',
    ),
  ).toBe(
    's32 f(s32 * a0, s32 a1) {\n    if (a1 == 0) {\n        return 1;\n    } else {\n        *a0 = a1;\n        return 2;\n    }\n}\n',
  );
});

test('a LOAD in a nullified slot does not happen on the not-taken path', () => {
  expect(
    src(
      '0:\tbeqzl\ta0,14 <f+0x14>',
      '4:\tlw\tv0,0(a1)',
      '8:\tli\tv0,7',
      'c:\tjr\tra',
      '10:\tnop',
      '14:\tjr\tra',
      '18:\tnop',
    ),
  ).toBe(
    's32 f(s32 a0, s32 * a1) {\n    if (a0 != 0) {\n        return 7;\n    } else {\n        return *a1;\n    }\n}\n',
  );
});

test('the condition is read BEFORE the slot, so a slot that redefines it still tests the old value', () => {
  // 28 of the corpus's likely sites have a slot whose destination the condition reads. Decoding the
  // slot first would test `a0 + a1` instead of `a0`.
  expect(
    src(
      '0:\tbnezl\ta0,14 <f+0x14>',
      '4:\taddu\ta0,a0,a1',
      '8:\tli\tv0,1',
      'c:\tjr\tra',
      '10:\tnop',
      '14:\tmove\tv0,a0',
      '18:\tjr\tra',
      '1c:\tnop',
    ),
  ).toBe(
    's32 f(s32 a0, s32 a1) {\n    if (a0 == 0) {\n        return 1;\n    } else {\n        return a0 + a1;\n    }\n}\n',
  );
});

test('several likely branches in one function each condition their own slot', () => {
  expect(
    src(
      '0:\tbltzl\ta0,8 <f+0x8>',
      '4:\tnegu\ta0,a0',
      '8:\tbltzl\ta1,10 <f+0x10>',
      'c:\tnegu\ta1,a1',
      '10:\tjr\tra',
      '14:\taddu\tv0,a0,a1',
    ),
  ).toBe('s32 f(s32 a0, s32 a1) {\n    if (a0 < 0) a0 = -a0;\n    if (a1 < 0) a1 = -a1;\n    return a0 + a1;\n}\n');
});

test('a likely branch closing a loop keeps its back-edge (the slot block is on the taken edge)', () => {
  expect(
    src(
      '0:\tmove\tv0,zero',
      '4:\taddu\tv0,v0,a0',
      '8:\taddiu\ta0,a0,-1',
      'c:\tbgtzl\ta0,4 <f+0x4>',
      '10:\tnop',
      '14:\tjr\tra',
      '18:\tnop',
    ),
  ).toBe(
    's32 f(s32 a0) {\n    s32 v0;\n    v0 = 0;\n    do {\n        v0 = v0 + a0;\n        a0 = a0 + -1;\n    } while (a0 > 0);\n    return v0;\n}\n',
  );
});

test('every shape the taken-edge placement cannot model refuses loudly, naming what was seen', () => {
  // A transfer in the slot is architecturally undefined; a slot past the end of the function is
  // malformed input; a slot some OTHER branch targets would run without the branch conditioning it,
  // and then take that branch's target; a likely branch inside another branch's delay slot has no
  // block of its own to put a slot in. None of the four occurs in the corpus, so refusing costs
  // nothing and guessing would cost correctness.
  expect(
    lift('0:\tbnezl\ta0,10 <f+0x10>', '4:\tb\t10 <f+0x10>', '8:\tli\tv0,1', 'c:\tnop', '10:\tjr\tra', '14:\tnop'),
  ).toThrow(/branch-likely 'bnezl' at 0x0 — the delay slot is itself a control transfer \('b'\)/);
  expect(lift('0:\tli\tv0,1', '4:\tbnezl\ta0,0 <f>')).toThrow(
    /branch-likely 'bnezl' at 0x4 — the branch is the last instruction of the function/,
  );
  expect(
    lift(
      '0:\tbeqz\ta1,c <f+0xc>',
      '4:\tnop',
      '8:\tbnezl\ta0,18 <f+0x18>',
      'c:\tli\tv0,1',
      '10:\tli\tv0,2',
      '14:\tnop',
      '18:\tjr\tra',
      '1c:\tnop',
    ),
  ).toThrow(/branch-likely 'bnezl' at 0x8 — another branch targets the delay slot/);
  // a likely branch that jumps to its OWN slot is the same hazard
  expect(lift('0:\tbnezl\ta0,4 <f+0x4>', '4:\tli\tv0,1', '8:\tli\tv0,2', 'c:\tjr\tra', '10:\tnop')).toThrow(
    /branch-likely 'bnezl' at 0x0 — another branch targets the delay slot/,
  );
  expect(
    lift(
      '0:\tb\t14 <f+0x14>',
      '4:\tbnezl\ta0,14 <f+0x14>',
      '8:\tli\tv0,1',
      'c:\tnop',
      '10:\tnop',
      '14:\tjr\tra',
      '18:\tnop',
    ),
  ).toThrow(/branch-likely 'bnezl' at 0x4 — it sits in the delay slot of 'b'/);
});
