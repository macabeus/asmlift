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
import { enumerateCandidates } from '../src/rank';
import { MIPS_GCC, MIPS_IDO } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

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
    's32 f(s32 *a0, s32 a1) {\n    if (a1 == 0) {\n        return 1;\n    } else {\n        *a0 = a1;\n        return 2;\n    }\n}\n',
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
    's32 f(s32 a0, s32 *a1) {\n    if (a0 != 0) {\n        return 7;\n    } else {\n        return *a1;\n    }\n}\n',
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
  // branch conditioning it and then jump to that branch's target. No compiler emits a case arm into
  // a delay slot, so that refusal costs nothing. KMC does write a likely bounds branch, but with the
  // default's first word in its slot, which `normaliseBranchLikely` retargets (the stolen-slot tests
  // below); the slots here are no word's copy, so both still refuse.
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
      ['jt', { section: '.rodata', value: 0, size: 8, index: 1 }],
      ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
    ]),
    symbolCount: 2,
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

// THE STOLEN SLOT. IDO, KMC and GCC 2.7.2 fill a likely slot by copying the target's first word
// into it, so the slot is also the word at T-4: `bnezl r,T; S` with S at T-4. `normaliseBranchLikely`
// then retargets the branch to T-4 with an empty slot. Taken runs S then T either way, not taken
// annuls S either way, so the rewrite is exact whatever else reaches T-4 — and it keeps the join at
// T-4 that the copy's own taken-edge block would have skipped.
test('a slot that is the target-4 word, stolen, retargets the branch to target-4 with an empty slot', () => {
  // Taken: a1 + 1. Not taken: 5 + 1. One `return a1 + 1` after the `if`, not the copy on each arm.
  expect(
    src(
      '0:\tbnezl\ta0,10 <f+0x10>',
      '4:\taddiu\ta1,a1,1',
      '8:\tli\ta1,5',
      'c:\taddiu\ta1,a1,1',
      '10:\tjr\tra',
      '14:\tmove\tv0,a1',
    ),
  ).toBe('s32 f(s32 a0, s32 a1) {\n    if (a0 == 0) a1 = 5;\n    return a1 + 1;\n}\n');
  // A slot that writes the register the branch tests is still exact: the branch reads its operand
  // before the slot either way, and the taken edge runs the same word at T-4.
  expect(
    src(
      '0:\tbnezl\ta0,10 <f+0x10>',
      '4:\taddiu\ta0,a0,1',
      '8:\tli\ta0,5',
      'c:\taddiu\ta0,a0,1',
      '10:\tjr\tra',
      '14:\tmove\tv0,a0',
    ),
  ).toBe('s32 f(s32 a0) {\n    if (a0 == 0) a0 = 5;\n    return a0 + 1;\n}\n');
});

test('the stolen-slot rewrite asks for the same relocation, not only the same text', () => {
  // `lw v0,0(v1)` at 0x8 reads A; the same text at 0x14 reads B when its relocation says so. The
  // taken path reads A whichever: a rewrite on text alone would return B there.
  const asm = obj(
    '0:\tlui\tv1,0x0',
    '4:\tbnezl\ta0,18 <f+0x18>',
    '8:\tlw\tv0,0(v1)',
    'c:\tjr\tra',
    '10:\tli\tv0,3',
    '14:\tlw\tv0,0(v1)',
    '18:\tjr\tra',
    '1c:\tnop',
  );
  const asmData = (atT4: string): AsmData => ({
    sections: new Map([['.data', new Uint8Array(8)]]),
    relocs: [
      { section: '.text', offset: 0x0, type: 'R_MIPS_HI16', sym: 'A', addend: 0 },
      { section: '.text', offset: 0x8, type: 'R_MIPS_LO16', sym: 'A', addend: 0 },
      { section: '.text', offset: 0x14, type: 'R_MIPS_LO16', sym: atT4, addend: 0 },
    ],
    symbols: new Map([
      ['A', { section: '.data', value: 0, size: 4, index: 1 }],
      ['B', { section: '.data', value: 4, size: 4, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  });
  const want = 's32 f(s32 a0) {\n    if (a0 == 0) {\n        return 3;\n    } else {\n        return A;\n    }\n}\n';
  // the same relocation: rewritten, and the emptied slot's own record is not attached to its `nop`
  expect(decompile('f', asm, MIPS_GCC, { asmData: asmData('A') }).source).toBe(want);
  // a different one: the slot stays the taken edge's own block, reading A
  expect(decompile('f', asm, MIPS_GCC, { asmData: asmData('B') }).source).toBe(want);
});

test('a stolen slot that completes a `%lo` keeps its slot, so each path pairs it with its own `%hi`', () => {
  // Each path loads v1's high half for itself (0x0 and 0xc for the likely branch; 0x8 and 0x14
  // for the `b`). Retargeted, the one copy at T-4 would read v1 at a join, where it is the block
  // parameter and not the half, and the fold would refuse a function that lifts.
  const asmData = (lo: number[], hi: number[]): AsmData => ({
    sections: new Map([['.data', new Uint8Array(8)]]),
    relocs: [
      ...hi.map((offset) => ({ section: '.text', offset, type: 'R_MIPS_HI16', sym: 'A', addend: 0 })),
      ...lo.map((offset) => ({ section: '.text', offset, type: 'R_MIPS_LO16', sym: 'A', addend: 0 })),
    ],
    symbols: new Map([['A', { section: '.data', value: 0, size: 4, index: 1 }]]),
    symbolCount: 1,
    bigEndian: true,
  });
  const likely = obj(
    '0:\tlui\tv1,0x0',
    '4:\tbnezl\ta0,18 <f+0x18>',
    '8:\tlw\tv0,0(v1)',
    'c:\tlui\tv1,0x0',
    '10:\tli\ta1,3',
    '14:\tlw\tv0,0(v1)',
    '18:\tjr\tra',
    '1c:\taddu\tv0,v0,a1',
  );
  expect(decompile('f', likely, MIPS_IDO, { asmData: asmData([0x8, 0x14], [0x0, 0xc]) }).source).toBe(
    's32 f(s32 a0, s32 a1) {\n    s32 v0;\n    if (a0 == 0) a1 = 3;\n    v0 = A;\n    return v0 + a1;\n}\n',
  );
  const jump = obj(
    '0:\tbeqz\ta0,14 <f+0x14>',
    '4:\tli\ta1,1',
    '8:\tlui\tv1,0x0',
    'c:\tb\t24 <f+0x24>',
    '10:\tlw\tv0,0(v1)',
    '14:\tlui\tv1,0x0',
    '18:\tli\ta1,3',
    '1c:\tsw\ta1,0(a2)',
    '20:\tlw\tv0,0(v1)',
    '24:\tjr\tra',
    '28:\taddu\tv0,v0,a1',
  );
  const out = decompile('f', jump, MIPS_IDO, { asmData: asmData([0x10, 0x20], [0x8, 0x14]) }).source;
  expect(out).toContain('v0 = A;');
  expect(out).toContain('*a2 = 3;');
});

test('the stolen-slot rewrite leaves alone a target-4 that is a delay slot or outside the function', () => {
  // 0x10 is `beqz`'s slot: it runs after that branch, and a branch landing on it is not modelled.
  // Not taken: a1 = 6, then 9 or 6 by a2; taken: a1 + 1.
  const out = src(
    '0:\tbnezl\ta0,14 <f+0x14>',
    '4:\taddiu\ta1,a1,1',
    '8:\tli\ta1,5',
    'c:\tbeqz\ta2,1c <f+0x1c>',
    '10:\taddiu\ta1,a1,1',
    '14:\tjr\tra',
    '18:\tmove\tv0,a1',
    '1c:\tjr\tra',
    '20:\tli\tv0,9',
  );
  expect(out).toContain('a1 + 1');
  expect(out).toContain('return 9;');
  // T-4 is the word before the function's first: there is no word there to share. The slot stays
  // the taken edge's own block, so each turn of the loop adds 2 and the exit adds the entry's 1.
  expect(src('0:\taddiu\ta0,a0,1', '4:\tbnezl\ta1,0 <f>', '8:\taddiu\ta0,a0,1', 'c:\tjr\tra', '10:\tmove\tv0,a0')).toBe(
    's32 f(s32 a0, s32 a1) {\n    while (a1 != 0) {\n        a0 = a0 + 1 + 1;\n    }\n    return a0 + 1;\n}\n',
  );
});

test('an unconditional `b`/`j` whose slot is the target-4 word, stolen, retargets the same way', () => {
  // `b T; S` runs S then T on its one edge, as `b T-4; nop` does, so the `if` joins at T-4 and the
  // `+ 1` is spelled once — not `v0 = a1 + 1` on one arm and `v0 = 6` on the other.
  const want = 's32 f(s32 a0, s32 a1) {\n    if (a0 == 0) a1 = 5;\n    return a1 + 1;\n}\n';
  for (const jump of ['b', 'j']) {
    expect(
      src(
        '0:\tbeqz\ta0,10 <f+0x10>',
        '4:\tnop',
        `8:\t${jump}\t18 <f+0x18>`,
        'c:\taddiu\ta1,a1,1',
        '10:\tli\ta1,5',
        '14:\taddiu\ta1,a1,1',
        '18:\tjr\tra',
        '1c:\tmove\tv0,a1',
      ),
    ).toBe(want);
  }
  // A branch landing on the `b`'s slot runs it and falls on to 0x10, not to T: the slot keeps its
  // word, and that landing refuses.
  expect(
    lift(
      '0:\tbeqz\ta0,c <f+0xc>',
      '4:\tnop',
      '8:\tb\t18 <f+0x18>',
      'c:\taddiu\ta1,a1,1',
      '10:\tli\ta2,5',
      '14:\taddiu\ta1,a1,1',
      '18:\tjr\tra',
      '1c:\tmove\tv0,a1',
    ),
  ).toThrow(/branch to 0xc is not a block boundary/);
});

test('a `b` whose slot ends a common tail of both arms retargets by default, and `/kept-slot` keeps it', () => {
  // ido `mergenarrow`: `sll; b T; sra` against `sll; sra; T:` — one `(s16)` per arm written out
  // twice, or a stolen `sra` past arms the source merged. One object either way, so the default lift
  // retargets and the kept slot is a lift variation the differ referees.
  const mergenarrow = obj(
    '0:\tbeqz\ta3,18 <f+0x18>',
    '4:\tsubu\tv0,a1,a2',
    '8:\taddu\tv0,a1,a2',
    'c:\tsll\tv0,v0,0x10',
    '10:\tb\t20 <f+0x20>',
    '14:\tsra\tv0,v0,0x10',
    '18:\tsll\tv0,v0,0x10',
    '1c:\tsra\tv0,v0,0x10',
    '20:\tjr\tra',
    '24:\tsw\tv0,0(a0)',
  );
  const merged = decompile('f', mergenarrow, MIPS_IDO).source;
  expect(merged).toContain('v0 = a1 + a2 << 16;');
  expect(merged).toContain('*a0 = v0 >> 16;');
  const cands = enumerateCandidates('f', mergenarrow, MIPS_IDO, {});
  const kept = cands.filter((c) => hasVariation(c.variations, 'kept-slot'));
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.some((c) => c.source.includes('v0 = (s16)(a1 + a2);'))).toBe(true);
  expect(cands.some((c) => !hasVariation(c.variations, 'kept-slot') && c.source.includes('a1 + a2 << 16'))).toBe(true);
  // A slot no common tail ends offers no `/kept-slot` at all: nothing for it to keep.
  const plain = obj(
    '0:\tbeqz\ta0,10 <f+0x10>',
    '4:\tnop',
    '8:\tb\t18 <f+0x18>',
    'c:\taddiu\ta1,a1,1',
    '10:\tli\ta1,5',
    '14:\taddiu\ta1,a1,1',
    '18:\tjr\tra',
    '1c:\tmove\tv0,a1',
  );
  expect(enumerateCandidates('f', plain, MIPS_IDO, {}).filter((c) => hasVariation(c.variations, 'kept-slot'))).toEqual(
    [],
  );
  // ido `mergeu16`: `b T; S; S; T:` jumps over exactly the one copy, so retargeted it would jump to
  // its own next word: nothing was stolen, and the slot is kept on every lift.
  expect(
    src(
      '0:\tbeqz\ta3,14 <f+0x14>',
      '4:\tsubu\tv0,a1,a2',
      '8:\taddu\tv0,a1,a2',
      'c:\tb\t18 <f+0x18>',
      '10:\tandi\tv0,v0,0xffff',
      '14:\tandi\tv0,v0,0xffff',
      '18:\tjr\tra',
      '1c:\tsw\tv0,0(a0)',
    ),
  ).toContain('v0 = a1 + a2 & 65535;');
});

/** A two-case dispatch on `a0` whose bounds branch is `bounds at,4c` with `slot` in its delay slot,
 *  and whose default at 0x48 starts with `li v0,9`. */
const boundsDispatch = (bounds: string, slot: string) =>
  obj(
    ' 0:\tsltiu\tat,a0,0x2',
    ` 4:\t${bounds}\tat,4c <f+0x4c>`,
    ` 8:\t${slot}`,
    ' c:\tsll\tv0,a0,0x2',
    '10:\tlui\tv1,0x0',
    '14:\taddu\tat,v1,v0',
    '18:\tlw\tat,0(at)',
    '1c:\tjr\tat',
    '20:\tnop',
    '24:\tli\tv0,3',
    '28:\tjr\tra',
    '2c:\tnop',
    '30:\tli\tv0,8',
    '34:\tjr\tra',
    '38:\tnop',
    '3c:\tnop',
    '40:\tnop',
    '44:\tnop',
    '48:\tli\tv0,9',
    '4c:\tjr\tra',
    '50:\tnop',
  );
const tableData = (arms: number[], hi: number): AsmData => ({
  sections: new Map([['.rodata', new Uint8Array(arms.flatMap((a) => [0, 0, 0, a]))]]),
  relocs: [
    { section: '.text', offset: hi, type: 'R_MIPS_HI16', sym: 'jt', addend: 0 },
    ...arms.map((_, k) => ({ section: '.rodata', offset: 4 * k, type: 'R_MIPS_32', sym: '.text', addend: 0 })),
  ],
  symbols: new Map([
    ['jt', { section: '.rodata', value: 0, size: 4 * arms.length, index: 1 }],
    ['.text', { section: '.text', value: 0, size: 0, index: 2 }],
  ]),
  symbolCount: 2,
  bigEndian: true,
});

test("KMC's likely bounds branch whose slot is the default's first word lifts as the switch", () => {
  // `beqzl at,DEF; S` with S = DEF-4's word is `beqz at,DEF-4; nop`: the bounds branch then runs an
  // empty slot, which is what the `switch_br` it emits runs, and the default starts one word early.
  const asmData = tableData([0x24, 0x30], 0x10);
  expect(decompile('f', boundsDispatch('beqzl', 'li\tv0,9'), MIPS_GCC, { asmData }).source).toBe(
    's32 f(s32 a0) {\n    switch (a0) {\n        case 0:\n            return 3;\n        case 1:\n            return 8;\n' +
      '        default:\n            return 9;\n    }\n}\n',
  );
  // a slot that is NOT the default's word keeps the nullified slot, and the refusal it meets
  expect(() => decompile('f', boundsDispatch('beqzl', 'li\tv0,7'), MIPS_GCC, { asmData })).toThrow(
    /branch-likely at 0x4 — a recovered switch's bounds branch cannot annul its delay slot/,
  );
});

test('a recovered switch arm landing on a slot the rewrite emptied refuses', () => {
  // Hardware entering 0x34 for `case 1` runs `li v0,9`, then returns 8 from the `jr`'s slot. The
  // emptied slot would run a `nop` there instead.
  const asm = obj(
    ' 0:\tsltiu\tat,a0,0x2',
    ' 4:\tbeqz\tat,4c <f+0x4c>',
    ' 8:\tsll\tv0,a0,0x2',
    ' c:\tlui\tv1,0x0',
    '10:\taddu\tat,v1,v0',
    '14:\tlw\tat,0(at)',
    '18:\tjr\tat',
    '1c:\tnop',
    '20:\tnop',
    '24:\tli\tv0,3',
    '28:\tjr\tra',
    '2c:\tnop',
    '30:\tbnezl\ta1,44 <f+0x44>',
    '34:\tli\tv0,9',
    '38:\tjr\tra',
    '3c:\tli\tv0,8',
    '40:\tli\tv0,9',
    '44:\tjr\tra',
    '48:\tnop',
    '4c:\tjr\tra',
    '50:\tli\tv0,1',
  );
  const want =
    /a recovered switch arm lands on the delay slot at 0x34, which the stolen-slot rewrite of a branch-likely or `b`\/`j` emptied/;
  expect(() => decompile('f', asm, MIPS_GCC, { asmData: tableData([0x24, 0x34], 0xc) })).toThrow(want);
  // the same arm on a `b`'s emptied slot: entered there, the hardware runs `li v0,9` and falls on
  expect(() =>
    decompile('f', asm.replace('bnezl\ta1,44', 'b\t44'), MIPS_GCC, { asmData: tableData([0x24, 0x34], 0xc) }),
  ).toThrow(want);
});

test('a latch retargeted onto its stolen word is a guarded self-loop the kept guard spells as `if` + `do-while`', () => {
  // `while (*s) { n++; s++; }` at IDO: the retarget turns `14:..1c: bnezl t7,14; lbu t7,1(a0)` into
  // one block, `t = s[1]; n++; s++; while (t)`, behind the `*s` guard. The guard is not the loop's
  // own test (`s[0]` against `s[1]`), so it stays an `if`; emitWhile, which would merge the guard's
  // exit edge into the loop's, cannot spell a test that reads `s` before its update.
  // The do-while emitter spells it with a `++` at the leaf.
  const strlen1 = src(
    ' 0:\tlbu\tt6,0(a0)',
    ' 4:\tmove\tv1,zero',
    ' 8:\tbeqz\tt6,24 <f+0x24>',
    ' c:\tnop',
    '10:\tlbu\tt7,1(a0)',
    '14:\taddiu\tv1,v1,1',
    '18:\taddiu\ta0,a0,1',
    '1c:\tbnezl\tt7,14 <f+0x14>',
    '20:\tlbu\tt7,1(a0)',
    '24:\tjr\tra',
    '28:\tmove\tv0,v1',
  );
  expect(strlen1).toMatch(
    /if \(\*a0 != 0\) \{\n\s+v0 = 0;\n\s+do \{\n\s+v0 = v0 \+ 1;\n\s+\} while \(a0\+\+\[1\] != 0\);/,
  );
  // `while (*++p == ' ') {}`: the guard's exit edge carries `p + 1` too, which the fused form's
  // post-loop copy cannot reproduce; the `if` recovery carries each exit edge's copy on that edge.
  const skipsp = src(
    ' 0:\tlbu\tt6,1(a0)',
    ' 4:\tli\tv0,32',
    ' 8:\taddiu\ta0,a0,1',
    ' c:\tbne\tv0,t6,24 <f+0x24>',
    '10:\tnop',
    '14:\tlbu\tt7,1(a0)',
    '18:\taddiu\ta0,a0,1',
    '1c:\tbeql\tv0,t7,18 <f+0x18>',
    '20:\tlbu\tt7,1(a0)',
    '24:\tjr\tra',
    '28:\tmove\tv0,a0',
  );
  expect(skipsp).toMatch(/do \{\n\s+\} while \(32 == \w+\+\+\[1\]\);/);
});
