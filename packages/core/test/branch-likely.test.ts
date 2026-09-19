// MIPS branch-likely (`beql`/`bnel`/`b*zl`): the delay slot is NULLIFIED when the branch is not
// taken, so it is CONDITIONAL code, not the ordinary always-executed slot. It is modelled where the
// CFG is built — the slot gets its own block on the taken edge — so every later pass sees ordinary
// conditional execution and nothing downstream carries a special case.
//
// Reading such a slot as an ordinary one emits C that compiles and is wrong (`absi` would return
// `-x` for every `x >= 0`; a store would be performed on a path that never performs it), so every
// shape the placement cannot model refuses loudly and by name instead.
import { expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
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

test('a likely branch has no register destination, so nothing else could catch it being dropped', () => {
  // The opaque-dest path catches an unmodelled instruction by the register it writes; a branch
  // writes none, so a dropped one leaves no trace at all — the `if` would simply not be in the
  // output. What this pins is that the conditional survives and the annulled slot is its taken arm.
  const guard = src('0:\tbnezl\ta0,10 <f+0x10>', '4:\tli\tv0,2', '8:\tli\tv0,1', 'c:\tnop', '10:\tjr\tra', '14:\tnop');
  expect(guard).toContain('if (a0 == 0)');
  expect(guard).toContain('v0 = 2;');
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
  // block of its own to put a slot in. None of these occurs in the corpus, so refusing costs
  // nothing and guessing would cost correctness.
  expect(
    lift('0:\tbnezl\ta0,10 <f+0x10>', '4:\tb\t10 <f+0x10>', '8:\tli\tv0,1', 'c:\tnop', '10:\tjr\tra', '14:\tnop'),
  ).toThrow(/branch-likely 'bnezl' at 0x0 — the delay slot is itself a control transfer \('b'\)/);
  expect(lift('0:\tli\tv0,1', '4:\tbnezl\ta0,0 <f>')).toThrow(
    /branch-likely 'bnezl' at 0x4 — the disassembly has no instruction at 0x8 to be its delay slot/,
  );
  // the not-taken edge needs somewhere to land too: a slot but no word after it
  expect(lift('0:\tbnezl\ta0,0 <f>', '4:\tli\tv0,1')).toThrow(
    /branch-likely 'bnezl' at 0x0 — the disassembly has no instruction at 0x8 for the not-taken edge to land on/,
  );
  // A BRANCH WHOSE TARGET IS NOT AN ADDRESS. Placement is defined by addresses, so there is nothing
  // to place; without this the taken successor would be read off `undefined`.
  expect(lift('0:\tbnezl\ta0,unresolved', '4:\tli\tv0,1', '8:\tjr\tra', 'c:\tnop')).toThrow(
    /branch-likely 'bnezl' at 0x0 — the branch target is not a resolved address/,
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

test('a slot is the word at branch+4, and the reader accounts for every word objdump printed', () => {
  // Taken by ARRAY POSITION, the instruction after a hole becomes the annulled slot: the arm the
  // function always runs is promoted onto the taken edge of a branch that never guarded it, the
  // other arm disappears, and nothing says so. That is the one failure this capability must never
  // have — C that compiles and is wrong, in place of a decline. Placement is therefore asked by
  // address, and `parseDisasm` keeps a word per address for it to ask about.

  // objdump prints a run of ZERO words as a bare `...` — GCC's `mflo` hazard pad, 53 sites across
  // 15 corpus rows — and on MIPS a zero word is `nop`. The pad comes back as the nops it stands
  // for, so the branch-likely at 0x10 has both its predecessor and its slot.
  expect(
    src(
      '0:\tmult\ta1,a0',
      '4:\tmflo\ta2',
      '\t...',
      '10:\tbnezl\ta0,18 <f+0x18>',
      '14:\taddiu\ta2,a2,1',
      '18:\tmove\tv0,a2',
      '1c:\tjr\tra',
      '20:\tnop',
    ),
  ).toBe(
    's32 f(s32 a0, s32 a1) {\n    s32 v0;\n    if (a0 == 0) {\n        v0 = a1 * a0;\n    } else {\n' +
      '        v0 = a1 * a0 + 1;\n    }\n    return v0;\n}\n',
  );

  // A line carrying an ADDRESS but no instruction the reader can name is refused, not skipped —
  // on BOTH branch paths, because the ordinary one reads its slot as the array neighbour too.
  const holed = (branch: string) => [
    `0:\t${branch}\ta0,18 <f+0x18>`,
    '4:\t0x4500ffff', // objdump's spelling of an encoding it cannot name
    '8:\tli\tv0,1',
    'c:\tjr\tra',
    '10:\tnop',
    '18:\tli\tv0,2',
    '1c:\tjr\tra',
    '20:\tnop',
  ];
  for (const branch of ['bnezl', 'bnez']) {
    expect(lift(...holed(branch))).toThrow(
      /objdump line '4:\t0x4500ffff' carries an address but no instruction this reader can decode/,
    );
  }

  // What is missing from the listing ENTIRELY is a different thing from a hole, and each placement
  // question says which word it wanted: the slot at branch+4, and the word the not-taken edge lands
  // on at branch+8. Both are asked of EVERY modelled transfer — an ordinary branch places the same
  // two words, and taking its slot from whatever came next is the same wrong answer — and the
  // branch-likely asks them in its own words, because for it they decide conditional execution.
  expect(lift('0:\tbnezl\ta0,18 <f+0x18>')).toThrow(
    /branch-likely 'bnezl' at 0x0 — the disassembly has no instruction at 0x4 to be its delay slot/,
  );
  expect(lift('0:\tbnezl\ta0,18 <f+0x18>', '4:\tli\tv0,1')).toThrow(
    /branch-likely 'bnezl' at 0x0 — the disassembly has no instruction at 0x8 for the not-taken edge/,
  );
  expect(lift('0:\tbnez\ta0,18 <f+0x18>')).toThrow(
    /cannot lift 'f': 'bnez' at 0x0 — the disassembly has no instruction at 0x4 to be its delay slot/,
  );
  expect(lift('0:\tbnez\ta0,18 <f+0x18>', '4:\tli\tv0,1')).toThrow(
    /cannot lift 'f': 'bnez' at 0x0 — the disassembly has no instruction at 0x8 for the not-taken edge/,
  );
  // A word whose LINE is simply absent is the remaining way to be short one — nothing marks it, so
  // nothing can recover it — and what precedes a likely branch decides whether it may be placed at
  // all. Asked by ADDRESS this refuses; asked by array position the `li` two words back would pass
  // for the predecessor.
  expect(
    lift(
      '0:\tmove\tv0,a0',
      '4:\tli\tv1,1', // the word at 0x8 has no line at all
      'c:\tbltzl\tv0,14 <f+0x14>',
      '10:\tnegu\tv0,v0',
      '14:\tjr\tra',
      '18:\tnop',
    ),
  ).toThrow(/branch-likely 'bltzl' at 0xc — the disassembly has no instruction at 0x8/);
  // and the same hole at the function's FIRST word is a hole too, which only the objdump HEADER can
  // say: the first line parsed would otherwise pass for the first word, and the missing one could
  // be the `jal` whose delay slot this branch sits in.
  expect(lift('4:\tbltzl\tv0,c <f+0xc>', '8:\tnegu\tv0,v0', 'c:\tjr\tra', '10:\tnop')).toThrow(
    /branch-likely 'bltzl' at 0x4 — the disassembly has no instruction at 0x0/,
  );
  // but the function's FIRST word has no predecessor by construction, and that is not a hole
  expect(src('0:\tbltzl\ta0,8 <f+0x8>', '4:\tnegu\ta0,a0', '8:\tmove\tv0,a0', 'c:\tjr\tra', '10:\tnop')).toBe(
    's32 f(s32 a0) {\n    if (a0 < 0) a0 = -a0;\n    return a0;\n}\n',
  );
});

test('a recovered jump table and a nullified slot refuse where they meet, both ways', () => {
  // `normaliseBranchLikely` runs BEFORE `recoverMipsJumpTables`, deliberately — one branch
  // vocabulary then reaches the table walk — so the table's arms are not among the branch targets
  // it checks. Both ways they can meet are therefore checked in `lift`, after recovery, and both
  // are silent wrong answers if they are not: the bounds branch emits a `switch_br`, which runs its
  // delay slot unconditionally, and an arm landing ON a nullified slot would run the slot with no
  // branch conditioning it and then jump to that branch's target. Neither occurs in the corpus —
  // no compiler emits a case arm into a delay slot — so refusing costs nothing.
  const dispatch = (bounds: string) =>
    obj(
      ' 0:\tsltiu\tat,a0,0x2',
      ` 4:\t${bounds}\tat,44 <f+0x44>`,
      ' 8:\tsll\tv0,a0,0x2',
      ' c:\tlui\tv1,0x0',
      '10:\taddu\tat,v1,v0',
      '14:\tlw\tat,0(at)',
      '18:\tjr\tat',
      '1c:\tnop',
      '20:\tnop',
      '24:\tbnezl\ta1,38 <f+0x38>',
      '28:\tli\tv0,7', // the nullified slot — and the `case 1` word below points AT it
      '2c:\tli\tv0,3',
      '30:\tjr\tra',
      '34:\tnop',
      '38:\tli\tv0,8',
      '3c:\tjr\tra',
      '40:\tnop',
      '44:\tli\tv0,9',
      '48:\tjr\tra',
      '4c:\tnop',
    );
  const asmData: AsmData = {
    sections: new Map([['.rodata', new Uint8Array([0, 0, 0, 0x24, 0, 0, 0, 0x28])]]),
    relocs: [
      { section: '.text', offset: 0xc, type: 'R_MIPS_HI16', sym: 'jt', addend: 0 },
      { section: '.rodata', offset: 0, type: 'R_MIPS_32', sym: '.text', addend: 0 },
      { section: '.rodata', offset: 4, type: 'R_MIPS_32', sym: '.text', addend: 0 },
    ],
    symbols: new Map([
      ['jt', { section: '.rodata', value: 0 }],
      ['.text', { section: '.text', value: 0 }],
    ]),
    bigEndian: true,
  };
  // Hardware entering 0x28 runs `li v0,7; li v0,3; jr ra` and returns 3. Read as an ordinary
  // successor, `case 1:` would return 8 — the taken arm's value.
  expect(() => decompile('f', dispatch('beqz'), MIPS_GCC, { asmData })).toThrow(
    /branch-likely at 0x24 — a recovered switch arm lands on its delay slot, which would run it unconditioned/,
  );
  expect(() => decompile('f', dispatch('beqzl'), MIPS_GCC, { asmData })).toThrow(
    /branch-likely at 0x4 — a recovered switch's bounds branch cannot annul its delay slot/,
  );
});
