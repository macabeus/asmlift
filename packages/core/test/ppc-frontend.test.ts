// PPC frontend robustness — regressions pinning silent-miscompile classes in the PowerPC frontend.
// Toolchain-free: each case is hand-authored objdump text (the exact shapes CodeWarrior emits),
// lifted end-to-end. These pin that a decode gap fails LOUD or fuses correctly — never
// plausible-but-wrong C.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';

const dis = (sym: string, lines: string) => decompile(sym, `0 <${sym}>:\n${lines}`, PPC_MWCC).source;

describe('PPC frontend robustness', () => {
  test('a conditional branch whose compare sits in a PREVIOUS block declines loud', () => {
    // The `cmpw` lands in the entry block; `40 <cross+0x40>` is branched to from below, making it a
    // block boundary, so the `blt` at 0x40 has no reaching compare in ITS block. Silently emitting
    // `constVal(0)` there is an always-false condition — it must decline loud instead.
    const asm =
      '0:\tcmpw    r3,r4\n4:\tb       40 <cross+0x40>\n' +
      '40:\tblt     50 <cross+0x50>\n44:\tli      r3,1\n48:\tblr\n' +
      '50:\tli      r3,2\n54:\tblr\n';
    expect(() => dis('cross', asm)).toThrow(/no reaching compare/);
  });

  test('record-form andi. feeds cr0 — the mask test survives, not `if (!0)`', () => {
    // `andi. r0,r3,1; beq L` sets cr0 from (r3&1) vs 0; beq reads it. A branch that sees no
    // compare emits a constant-true `if (!0)`, dropping the mask entirely.
    const src = dis(
      'maskif',
      '0:\tandi.   r0,r3,0x1\n4:\tbeq     10 <maskif+0x10>\n8:\tli      r3,1\nc:\tblr\n10:\tli      r3,0\n14:\tblr\n',
    );
    expect(src).toContain('a0 & 1'); // the mask test is present…
    expect(src).not.toContain('!0'); // …and not the constant-true stub
  });

  test('an unmodelled op that reaches the output FAILS LOUD (no silent wrong C)', () => {
    // `mulhw` is not modelled here. If dropped, the function would return the value from BEFORE
    // the hole (`return a0 + 1;`); instead it emits an opaque value that the boundary contract
    // rejects — a loud error beats a confident wrong answer.
    expect(() => dis('mulused', '0:\taddi    r3,r3,1\n4:\tmulhw   r3,r3,r4\n8:\tblr\n')).toThrow();
  });

  test('a genuine rotate/insert rlwinm (mask not ending at bit 31) still FAILS LOUD (not `return;`)', () => {
    // `rlwinm r3,r3,4,0,27` is a real rotate-and-mask (ME≠31 ⇒ not a right-shift extract), which
    // this frontend does not model. It routes through the opaque guard: reaching the output trips
    // the boundary contract rather than decoding to `s32 f(void){ return; }`. (The right-shift
    // EXTRACT shape `(x>>n)&m`, ME=31, IS modelled — see the PPC-WIDEN test below.)
    expect(() => dis('rot', '0:\trlwinm  r3,r3,4,0,27\n4:\tblr\n')).toThrow();
  });

  test('branch-prediction hint suffixes (blt+/bltlr-) do not drop the branch', () => {
    // objdump glues the `at` hint bit onto the mnemonic. An unstripped `blt+` misses the cond
    // table and `blt-`/`bltlr-`'s stray `-` contaminates the operand, silently dropping the branch.
    const a = dis('hintret', '0:\tcmpwi   r3,0\n4:\tbltlr-\n8:\tli      r3,5\nc:\tblr\n');
    expect(a).toContain('if ('); // the conditional return survived as a real branch
    const b = dis(
      'hintbr',
      '0:\tcmpwi   r3,0xa\n4:\tblt+    10 <hintbr+0x10>\n8:\tli      r3,2\nc:\tblr\n10:\tli      r3,1\n14:\tblr\n',
    );
    expect(b).toContain('a0 >= 10'); // the compare+branch fused, hint ignored
  });

  test('a DEAD unmodelled op is harmless (does not fail loud)', () => {
    // The guard only bites when the unknown value reaches output: here `mulhw` writes r5, which is
    // never read, so the opaque is dead and the real return is unaffected.
    expect(dis('deadunk', '0:\tmulhw   r5,r3,r4\n4:\tadd     r3,r3,r4\n8:\tblr\n')).toBe(
      's32 deadunk(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
    );
  });
});

describe('PPC-WIDEN frontend (calls, frame transparency, rlwinm extract, CTR loops)', () => {
  // A `bdnz` with a reaching `mtctr` is a recoverable CTR down-counter: `mtctr` seeds the count,
  // `bdnz` decrements it and branches while non-zero. This is the real `loopif` shape (a guarded
  // count-down accumulate) — it lifts to a structured loop whose induction variable counts the trip
  // count down to 0, exiting when it reaches zero. Sound control flow, not a dropped branch.
  test('a CTR loop (mtctr + bdnz) recovers as a structured down-counting loop', () => {
    const src = dis(
      'loopif',
      '0:\tli      r5,0\n4:\tmtctr   r4\n8:\tcmpwi   r4,0\nc:\tble     28 <loopif+0x28>\n' +
        '10:\tlwz     r0,0(r3)\n14:\tcmpwi   r0,0\n18:\tble     20 <loopif+0x20>\n1c:\tadd     r5,r5,r0\n' +
        '20:\taddi    r3,r3,4\n24:\tbdnz    10 <loopif+0x10>\n28:\tmr      r3,r5\n2c:\tblr\n',
    );
    expect(src).toMatch(/do|while/); // the back-edge became a real loop…
    expect(src).toContain('!= 0'); // …exiting when the CTR down-counter reaches zero
  });
  // A `bdnz` WITHOUT a reaching `mtctr` has no recoverable trip count, so there is no sound loop to
  // build. It must fail LOUD — a catchable out-of-scope signal, never a silent straight-line drop.
  test('a CTR-loop branch (bdnz) with no reaching mtctr FAILS LOUD', () => {
    expect(() =>
      dis('ctrloop', '0:\tli      r3,0\n4:\tadd     r3,r3,r4\n8:\tbdnz    4 <ctrloop+0x4>\nc:\tblr\n'),
    ).toThrow(/'bdnz'.*without a reaching 'mtctr'/);
  });
  // CTR is volatile across calls on PPC: a `bl` inside the loop body clobbers the hardware CTR, so the
  // modelled trip count is unrecoverable. A conforming compiler never emits this (it would use a GPR
  // counter), but we must DECLINE rather than emit a confident-but-wrong count for adversarial asm.
  test('a CTR loop whose body contains a call (bl) FAILS LOUD, not a wrong trip count', () => {
    expect(() =>
      dis(
        'callloop',
        '0:\tli      r5,0\n4:\tmtctr   r4\n8:\tcmpwi   r4,0\nc:\tble     20 <callloop+0x20>\n' +
          '10:\tbl      40 <foo>\n14:\tadd     r5,r5,r3\n18:\taddi    r3,r3,4\n1c:\tbdnz    10 <callloop+0x10>\n' +
          '20:\tmr      r3,r5\n24:\tblr\n',
      ),
    ).toThrow(/CTR loop body contains 'bl'.*clobbers CTR/);
  });
  // A guessed call arity reads the ARGUMENT REGISTERS, and r3.. are volatile under the EABI: a value
  // the first `bl` sits between cannot be an argument to the second one. Counting it invents an
  // argument — `func(1, 7)` for a call the caller set up with one — which is a wrong-code class, not
  // a formatting one. Same trim as the Thumb frontend (frontend/ssa.ts trimClobberedCallArgs).
  test('a guessed call arity drops the argument registers an earlier call clobbered', () => {
    const src = dis('f', '0:\tli      r4,7\n4:\tbl      40 <foo>\n8:\tli      r3,1\nc:\tbl      50 <bar>\n10:\tblr\n');
    expect(src).toContain('func(1)');
    expect(src).not.toContain('func(1, 7)');
  });

  test('an indirect branch (bctr) FAILS LOUD too', () => {
    expect(() => dis('jumptab', '0:\tbctr\n')).toThrow(/unmodelled control transfer 'bctr'/);
    expect(() => dis('jumptab', '0:\tbctr\n')).toThrow(/CTR-counted loop or indirect branch/);
  });

  // An indirect CALL is neither of those, and a decline that named a loop-unrolling gap sent every
  // reader of a C++ virtual dispatch looking for one.
  test('an indirect call says so', () => {
    expect(() => dis('virt', '0:\tblrl\n')).toThrow(/'blrl' at 0x0 \(an indirect call — a virtual dispatch/);
  });

  // `bl` with the callee recovered from the interleaved R_PPC_REL24 relocation (an unresolved bl in
  // a .o encodes a 0 offset placeholder; the name lives only in the relocation).
  test('bl recovers the callee symbol from the R_PPC_REL24 relocation line', () => {
    // The bl's encoded target is a 0 placeholder; the name `g` lives only in the relocation. It is
    // recovered as the call target (not the `func` fallback used when no relocation is present).
    const src = dis('callsym', '0:\tbl      4 <callsym+0x4>\n\t\t\t0: R_PPC_REL24\tg\n4:\tblr\n');
    expect(src).toContain('g(');
    expect(src).not.toContain('func');
  });

  // rlwinm right-shift extract `(x>>n)&m` (ME=31) — modelled as shift + mask. The rotate makes
  // the shift LOGICAL, which is what the lift records (`shr_u`); over the `s32`-declared `a0` a
  // bare `>>` would be C's arithmetic one, so the operand is spelled unsigned.
  test('rlwinm right-shift extract decodes to a shift + mask', () => {
    expect(dis('ext', '0:\trlwinm  r3,r3,27,24,31\n4:\tblr\n')).toBe(
      's32 ext(s32 a0) {\n    return (u32)a0 >> 5 & 255;\n}\n',
    );
  });

  // Stack frames beyond callee-saved/lr save-restore, and SDA/global access, are unmodelled;
  // lifting them anyway silently miscompiles (a dropped local spill / a fabricated pointer param),
  // so each must fail LOUD.
  test('address-taken local (r1 used as data) FAILS LOUD, not a fabricated data param', () => {
    // `addi r3,r1,8` = `&local` — reading the stack pointer as data (silently `return a0 + 8;` otherwise).
    expect(() => dis('addrtaken', '0:\taddi    r3,r1,8\n4:\tblr\n')).toThrow(/stack pointer r1 used as data/);
  });
  test('REGISTER-INDEXED frame access (`lwzx rD,r1,rB`) fails loud — r1 in either operand', () => {
    // PPC is asmlift's only frontend with a register-indexed addressing mode, so this is the exact
    // structural analogue of the case that broke m2c's stack-frame model (`ldr rX, [sp, rY]`,
    // upstream ef34aff): an sp-relative access whose addend is a REGISTER, not a literal. It
    // declines here for a reason worth pinning — `addrX` routes BOTH operands through `read`, so
    // the guard above covers it rather than there being a second check. A refactor of `addrX` to
    // `readVar` would silently reopen exactly that hole, and mwcc emits `lwzx` for every
    // variable-index array access, so the shape is not exotic.
    expect(() => dis('lwzxframe', '0:\tlwzx    r3,r1,r4\n4:\tblr\n')).toThrow(/stack pointer r1 used as data/);
    expect(() => dis('stwxframe', '0:\tstwx    r3,r1,r4\n4:\tblr\n')).toThrow(/stack pointer r1 used as data/);
    expect(() => dis('lwzxindex', '0:\tlwzx    r3,r4,r1\n4:\tblr\n')).toThrow(/stack pointer r1 used as data/);
  });
  test('spill of a LIVE (computed) value to the stack FAILS LOUD, not a dropped spill', () => {
    // `addi r0,r3,1` computes a value; `stw r0,8(r1)` spills it. A callee-saved SAVE stores an
    // unchanged entry value (no reaching def) and stays transparent — this stores a live value.
    expect(() => dis('livespill', '0:\taddi    r0,r3,1\n4:\tstw     r0,8(r1)\n8:\tblr\n')).toThrow(
      /spill of a live value/,
    );
  });
  // A save slot is a register AND an offset. `stw r3,8(r1)` / `lwz r4,8(r1)` is mwcc reading an
  // incoming argument back into a different register, not a callee-saved save/restore pair: an
  // offset-only record calls it transparent, drops the load, leaves r4 with no definition, and the
  // contiguous `fallbackArgc` scan then silently drops that argument AND every later one. Measured
  // on `marioparty4:fn_1_C4E4`, which lost the `&fn_1_C530` this frontend had just recovered.
  test('a reload into a register the slot was NOT saved from FAILS LOUD, not a dropped value', () => {
    expect(() => dis('crossreload', '0:\tstw     r3,8(r1)\n4:\tlwz     r4,8(r1)\n8:\tmr      r3,r4\nc:\tblr\n')).toThrow(
      /reload of '8\(r1\)' into r4, a slot r3 was saved into/,
    );
  });
  test('and the call argument it used to carry away is the reason', () => {
    // Without the register in the slot this lifts to `return callee(1);` — r4's reload dropped, so
    // the recovered `&gObj` in r5 goes with it.
    const asm =
      '0:\tstw     r3,8(r1)\n4:\tli      r3,1\n8:\tlwz     r4,8(r1)\n' +
      'c:\tlis     r5,0\n\t\t\te: R_PPC_ADDR16_HA\tgObj\n' +
      '10:\taddi    r5,r5,0\n\t\t\t12: R_PPC_ADDR16_LO\tgObj\n' +
      '14:\tbl      18 <argdrop+0x18>\n\t\t\t14: R_PPC_REL24\tcallee\n18:\tblr\n';
    expect(() => dis('argdrop', asm)).toThrow(/reload of '8\(r1\)' into r4/);
  });
  test('control: a save and restore of the SAME register stays transparent', () => {
    expect(dis('saverestore', '0:\tstw     r31,12(r1)\n4:\tadd     r3,r3,r4\n8:\tlwz     r31,12(r1)\nc:\tblr\n')).toBe(
      's32 saverestore(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
    );
  });
  test('`lmw` checks every word it restores, not just the offset the `stmw` recorded', () => {
    // `stmw r30,8(r1)` saves r30,r31 into 8(r1),12(r1); `lmw r29,8(r1)` would restore r29,r30,r31
    // from 8(r1),12(r1),16(r1) — a different register range over the same slots.
    expect(dis('mw', '0:\tstmw    r30,8(r1)\n4:\tadd     r3,r3,r4\n8:\tlmw     r30,8(r1)\nc:\tblr\n')).toBe(
      's32 mw(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
    );
    expect(() => dis('mwskew', '0:\tstmw    r30,8(r1)\n4:\tlmw     r29,8(r1)\n8:\tblr\n')).toThrow(
      /reload of '8\(r1\)' into r29, a slot r30 was saved into/,
    );
  });
  test('SDA/global access (non-register memory base) FAILS LOUD, not a fabricated pointer param', () => {
    // `stw r0,0(0)` — the base field is a 0 placeholder an SDA relocation fills at link. Lifting it
    // as a store to a fabricated first pointer parameter loses the global write.
    expect(() => dis('glob', '0:\tstw     r0,0(0)\n4:\tblr\n')).toThrow(/SDA\/global-relative access not supported/);
  });
});

describe('an operand-less `ret` is VOID, not an untyped s32', () => {
  // Every frontend already says "this function produces no return value" the same way — an
  // operand-less `ret`. PPC/MIPS emit one when the return register has no reaching definition;
  // Thumb when the epilogue branches THROUGH that register (`bx r0`). Typing it `s32` produced a
  // non-void signature over a body with no `return` value — C's implicit-int function that falls
  // off its end — so the fix is in the shared return-type derivation, not per ISA.
  test('a function that never writes the return register types void', () => {
    expect(dis('nothing', '0:\tblr\n')).toBe('void nothing(void) {\n    return;\n}\n');
  });

  test('control: a function that DOES write it keeps its value and its type', () => {
    expect(dis('five', '0:\tli      r3,5\n4:\tblr\n')).toBe('s32 five(void) {\n    return 5;\n}\n');
  });

  test('EVERY exit must agree — one valued `ret` keeps the function non-void', () => {
    // A frontend decides per BLOCK whether the return register holds anything, so an operand-less
    // `ret` beside a valued one is a real shape. Answering void off the first would declare void
    // over a body the structurer still emits `return expr;` in — ill-formed C, and a signature
    // that contradicts its own body.
    // The return register must NOT be a parameter: a parameter always has a reaching definition,
    // so both exits would carry a value and this would pass with the rule reverted. Branching on
    // r4 leaves r3 genuinely unwritten on one path.
    // Two conditions, both load-bearing: the return register must NOT be a parameter (a parameter
    // always has a reaching definition, so both exits would carry a value), and the value-LESS
    // exit must come FIRST in block order — that is the ordering the old first-ret rule read.
    const src = dis(
      'mixed',
      '0:\tcmpwi   r4,0\n4:\tbeq     10 <mixed+0x10>\n8:\tblr\nc:\tnop\n10:\tli      r3,5\n14:\tblr\n',
    );
    expect(src).not.toContain('void mixed');
    expect(src).toContain('return 5;');
  });
});

test('addis over a register is a plain add of the shifted immediate', () => {
  // `addis r4,r3,-32736` = r3 + 0x80200000 — mwcc's %ha anchor for an absolute base derived
  // from a scaled index. Unmodelled, this declined the whole function loud.
  const src = dis('anchor', '0:\taddis   r4,r3,-32736\n4:\tlwz     r3,0(r4)\n8:\tblr\n');
  // recovery types the base `s32 *`, so 0x80200000 bytes renders as its ELEMENT count
  expect(src).toContain('*(a0 + -536346624)');
});

test('a reloc-carrying addis is a link-time placeholder — declines loud, never `+ 0`', () => {
  // objdump -r interleaves the data reloc; the printed immediate is 0. Lifting it as the value
  // silently reads the wrong address (the classic `arr@ha` indexed-global shape). `addis` over a
  // REGISTER is not the `lis`/`addi` pair — it is a register-relative high half with no modelled
  // low half, so it stays a placeholder.
  const addis = '0:\taddis   r4,r3,0\n\t\t\t0: R_PPC_ADDR16_HA arr\n4:\tlwz     r3,0(r4)\n8:\tblr\n';
  expect(() => dis('anchor_reloc', addis)).toThrow(/data relocation/);
  // A `lis`'s high half used as a memory base WITHOUT its `@l`: the register holds half an address,
  // and reading it would load through whatever reached r4 before the `lis`.
  const lis = '0:\tlis     r4,0\n\t\t\t0: R_PPC_ADDR16_HA gVal\n4:\tlwz     r3,0(r4)\n8:\tblr\n';
  expect(() => dis('lis_reloc', lis)).toThrow(/r4 holds the high half of 'gVal'/);
});

test('a jump-table base pair must carry the @ha/@l relocation TYPES, not just a shared symbol', () => {
  // The dispatch recognizer pairs its own `lis`/`addi` — the same idea the `@ha`/`@l` fold
  // implements, at a different time and for a different consumer (it wants the table's NAME, not
  // its address). Keeping the two apart is only safe while both demand the same evidence, so the
  // recognizer checks the relocation types the fold checks. Here the `lis` carries a SMALL-DATA
  // relocation, which never forms a high half: the same symbol on both instructions is not a pair,
  // and the dispatch declines at its `bctr` rather than reading a table the code never addressed.
  const asmData: AsmData = {
    sections: new Map([['.data', new Uint8Array(16)]]),
    relocs: [0x20, 0x28, 0x30, 0x38].map((off, i) => ({
      section: '.data',
      offset: i * 4,
      type: 'R_PPC_ADDR32',
      sym: 'swt',
      addend: off,
    })),
    symbols: new Map([
      ['jtbl', { section: '.data', value: 0 }],
      ['swt', { section: '.text', value: 0 }],
    ]),
    bigEndian: true,
  };
  const asm = [
    '00000000 <swt>:',
    '   0:\tcmplwi  r3,3',
    '   4:\tbgt     40 <swt+0x40>',
    '   8:\tlis     r4,0',
    '\t\t\t8: R_PPC_EMB_SDA21 jtbl', // not an `@ha` half — a small-data base
    '   c:\tslwi    r0,r3,2',
    '  10:\taddi    r4,r4,0',
    '\t\t\t10: R_PPC_ADDR16_LO jtbl',
    '  14:\tlwzx    r0,r4,r0',
    '  18:\tmtctr   r0',
    '  1c:\tbctr',
    '  20:\tli      r3,10',
    '  24:\tblr',
    '  28:\tli      r3,20',
    '  2c:\tblr',
    '  30:\tli      r3,30',
    '  34:\tblr',
    '  38:\tli      r3,40',
    '  3c:\tblr',
    '  40:\tli      r3,0',
    '  44:\tblr',
  ].join('\n');
  expect(() => decompile('swt', asm, PPC_MWCC, { asmData })).toThrow(/unmodelled control transfer 'bctr'/);
});

test('a recovered jump table still lifts to a switch — its reloc lis/addi never reach the guards', () => {
  // The @tbl pair sits in the dispatch block, which a recovered JT prunes as unreachable before
  // decode (the bounds branch's successors are replaced by the cases). This pins that the
  // reloc-placeholder guards need no jump-table exemption.
  const asmData: AsmData = {
    sections: new Map([['.data', new Uint8Array(16)]]),
    relocs: [0x20, 0x28, 0x30, 0x38].map((off, i) => ({
      section: '.data',
      offset: i * 4,
      type: 'R_PPC_ADDR32',
      sym: 'swf',
      addend: off,
    })),
    symbols: new Map([
      ['jtbl', { section: '.data', value: 0 }],
      ['swf', { section: '.text', value: 0 }],
    ]),
    bigEndian: true,
  };
  const asm = [
    '00000000 <swf>:',
    '   0:\tcmplwi  r3,3',
    '   4:\tbgt     40 <swf+0x40>',
    '   8:\tlis     r4,0',
    '\t\t\t8: R_PPC_ADDR16_HA jtbl',
    '   c:\tslwi    r0,r3,2',
    '  10:\taddi    r4,r4,0',
    '\t\t\t10: R_PPC_ADDR16_LO jtbl',
    '  14:\tlwzx    r0,r4,r0',
    '  18:\tmtctr   r0',
    '  1c:\tbctr',
    '  20:\tli      r3,10',
    '  24:\tblr',
    '  28:\tli      r3,20',
    '  2c:\tblr',
    '  30:\tli      r3,30',
    '  34:\tblr',
    '  38:\tli      r3,40',
    '  3c:\tblr',
    '  40:\tli      r3,0',
    '  44:\tblr',
  ].join('\n');
  expect(decompile('swf', asm, PPC_MWCC, { asmData }).source).toContain('switch (');
  // GC/1.2.5n forms the table's low half BEFORE it scales the index — Pikmin's four jump tables
  // (Piki::doDoAI, TexImg::calcDataSize, P2DPrint::doCtrlCode, Light::setLightSpot) all read
  // `lis; addi; slwi; lwzx; mtctr; bctr`. The two instructions are independent.
  const addiFirst = asm.replace(
    '   c:\tslwi    r0,r3,2\n  10:\taddi    r4,r4,0\n\t\t\t10: R_PPC_ADDR16_LO jtbl',
    '   c:\taddi    r4,r4,0\n\t\t\tc: R_PPC_ADDR16_LO jtbl\n  10:\tslwi    r0,r3,2',
  );
  expect(addiFirst).not.toBe(asm);
  expect(decompile('swf', addiFirst, PPC_MWCC, { asmData }).source).toContain('switch (');
});

test('ori carrying a data reloc is a placeholder — decline loud', () => {
  // `ori rD,rA,SYM@l` is an `@l` half-former this frontend does not model. Lifting its printed 0
  // would build the address from the low half alone.
  const ori = '0:\tori     r4,r4,0\n\t\t\t0: R_PPC_ADDR16_LO gVal\n4:\tlwz     r3,0(r4)\n8:\tblr\n';
  expect(() => dis('orilo', ori)).toThrow(/data relocation/);
});

test('a reloc on a frame adjust (`addi r1`) is loud whether or not an `@ha` is pending', () => {
  // The stack-pointer guard runs BEFORE both the fold and the teardown skip. Without it, the lone
  // `@l` was caught only incidentally (r1 held no pending half), and a COMPLETE pair walked
  // straight through the fold into r1 and lifted as an ordinary teardown.
  const lone = '0:\taddi    r1,r1,0\n\t\t\t0: R_PPC_ADDR16_LO gFrame\n4:\tli      r3,5\n8:\tblr\n';
  expect(() => dis('fradj', lone)).toThrow(/on a stack-pointer adjust/);
  const pair =
    '0:\tlis     r1,0\n\t\t\t2: R_PPC_ADDR16_HA gFrame\n' +
    '4:\taddi    r1,r1,0\n\t\t\t6: R_PPC_ADDR16_LO gFrame\n8:\tblr\n';
  expect(() => dis('fradjpair', pair)).toThrow(/on a stack-pointer adjust/);
});

// r3 is BOTH argument 0 and the return register on this ABI, so what a guessed call arity reads
// there depends on telling the callee's own result from caller-side setup — the same rule the
// Thumb frontend runs (test/thumb-frontend.test.ts), on the second frontend that has the aliasing.
describe('a guessed call arity and the EABI return register', () => {
  const PRO = '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\n';
  const EPI = '24:\tlwz     r0,20(r1)\n28:\tmtlr    r0\n2c:\taddi    r1,r1,16\n30:\tblr\n';
  const rel = (at: string, sym: string) => `\t\t\t${at}: R_PPC_REL24\t${sym}\n`;

  test('back-to-back calls are two statements, not a nest', () => {
    const asm =
      PRO + 'c:\tbl      c <t+0xc>\n' + rel('c', 'foo') + '10:\tbl      10 <t+0x10>\n' + rel('10', 'bar') + EPI;
    expect(dis('t', asm)).toContain('foo();\n    return bar();');
  });

  test('…but a JOIN of a return with a caller-computed value stays an argument', () => {
    // r3 at `bar` merges `foo`'s return with the caller's own `add r3,r4,r5`. Reading the merge as
    // the callee's result drops the argument, and the addition dies with it.
    const asm =
      PRO +
      'c:\tcmpwi   r3,0\n10:\tbeq     1c <t+0x1c>\n14:\tadd     r3,r4,r5\n18:\tb       20 <t+0x20>\n' +
      '1c:\tbl      1c <t+0x1c>\n' +
      rel('1c', 'foo') +
      '20:\tbl      20 <t+0x20>\n' +
      rel('20', 'bar') +
      EPI;
    const src = dis('t', asm);
    expect(src).toContain('a1 + a2');
    expect(src).toMatch(/return bar\(v\d\);/);
  });
});

// ── a CROSS-LEVEL contract: the frontend preserves a commutative instruction's operand order ──
// The remainder idiom (pattern/engine.ts HWMOD_PATTERNS) declares its `mullw` node `ordered`, so
// the L1 fold now READS an operand order the frontend must not normalise. `mul` is in the engine's
// COMMUTATIVE set, so nothing else in the tower depends on it — before that pattern existed, a
// frontend or ir/simplify.ts canonicalisation of `mullw`'s operands would have been free and
// invisible. This pins the postcondition at the stage boundary rather than leaving it satisfied by
// accident of implementation, and it does so where CI runs it: the end-to-end proof lives in the
// matching suite, which needs a real mwcc, and asserting the IR shape alone would stay green
// through a frontend that swapped the operands. Failure mode is a LOST match, not wrong C.
describe('mullw operand order survives the frontend into the idiom layer', () => {
  const TRIPLE = (mul: string) => `0:\tdivw    r0,r3,r4\n4:\t${mul}\n8:\tsubf    r3,r0,r3\nc:\tblr\n`;

  test('quotient-first `mullw r0,r0,r4` folds back to the remainder operator', () => {
    expect(dis('modq', TRIPLE('mullw   r0,r0,r4'))).toContain('return a0 % a1;');
  });

  test('divisor-first `mullw r0,r4,r0` does NOT — it stays the decomposition it already matches', () => {
    const src = dis('modd', TRIPLE('mullw   r0,r4,r0'));
    expect(src).toContain('return a0 - a1 * (a0 / a1);');
    expect(src).not.toContain('%');
  });
});
