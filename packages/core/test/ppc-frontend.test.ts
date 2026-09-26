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
  test('a compare in the ONLY predecessor reaches the branch, across a `b` or a `bc` fall-through', () => {
    // `40 <cross+0x40>` is a block of its own, entered only from the `b` at 0x4, so the `blt` there
    // reads the `cmpw` its one predecessor left (`inheritFlags`, frontend/flags-edge.ts).
    const straight =
      '0:\tcmpw    r3,r4\n4:\tb       40 <cross+0x40>\n' +
      '40:\tblt     50 <cross+0x50>\n44:\tli      r3,1\n48:\tblr\n' +
      '50:\tli      r3,2\n54:\tblr\n';
    expect(dis('cross', straight)).toContain('a0 >= a1');
    // mwcc's switch dispatch: one `cmpwi` read by the `beq-` and then by the `bge-` on its
    // fall-through. A `bc` writes no CR field, so the edge it falls out of carries the compare too.
    const dispatch =
      '0:\tcmpwi   r3,1\n4:\tbeq-    18 <disp+0x18>\n8:\tbge-    20 <disp+0x20>\n' +
      'c:\tcmpwi   r3,0\n10:\tbge-    28 <disp+0x28>\n14:\tb       20 <disp+0x20>\n' +
      '18:\tli      r3,11\n1c:\tblr\n20:\tli      r3,99\n24:\tblr\n28:\tli      r3,10\n2c:\tblr\n';
    const src = dis('disp', dispatch);
    for (const k of [10, 11, 99]) {
      expect(src).toContain(`return ${k};`);
    }
  });

  test('a compare does not cross a JOIN: two predecessors decline loud', () => {
    // `10 <join+0x10>` is reached from the `beq-` (cr0 = r3 vs r4) and by falling out of 0x8
    // (cr0 = r3 vs r5). The flags need not agree, so picking either states a condition the machine
    // does not promise, and silently emitting `constVal(0)` would be an always-false one.
    const asm =
      '0:\tcmpw    r3,r4\n4:\tbeq-    10 <join+0x10>\n8:\tcmpw    r3,r5\nc:\tnop\n' +
      '10:\tblt-    20 <join+0x20>\n14:\tli      r3,1\n18:\tblr\n20:\tli      r3,2\n24:\tblr\n';
    expect(() => dis('join', asm)).toThrow(
      "has no reaching compare (cr0): no compare crosses the edges into 'join+0x10': 2 meet there",
    );
  });

  test('a call destroys the volatile cr fields: a compare before a `bl` does not reach a branch after it', () => {
    // The EABI preserves cr2–cr4 only. Fusing the pre-call `cmpwi` into the `beq-` would lift as
    // `if (a0 != 0)`, a test of flags the callee was free to overwrite.
    const asm =
      '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\nc:\tcmpwi   r3,0\n' +
      '10:\tbl      10 <cc+0x10>\n14:\tbeq-    24 <cc+0x24>\n18:\tli      r3,1\n1c:\tb       28 <cc+0x28>\n' +
      '24:\tli      r3,2\n28:\tlwz     r0,20(r1)\n2c:\tmtlr    r0\n30:\taddi    r1,r1,16\n34:\tblr\n';
    expect(() => dis('cc', asm)).toThrow('tests cr0, but the call at 0x10 destroyed it');
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
        // The count is seeded from r3 and the accumulator lives in a callee-saved register, so no
        // ARGUMENT register is left empty below one that holds a value — the arity guard below has
        // nothing to say here and the CTR clobber is what this case is about.
        '0:\tli      r31,0\n4:\tmtctr   r3\n8:\tcmpwi   r3,0\nc:\tble     20 <callloop+0x20>\n' +
          '10:\tbl      40 <foo>\n14:\tadd     r31,r31,r3\n18:\taddi    r3,r3,4\n1c:\tbdnz    10 <callloop+0x10>\n' +
          '20:\tmr      r3,r31\n24:\tblr\n',
      ),
    ).toThrow(/CTR loop body contains 'bl'.*clobbers CTR/);
  });
  // A guessed call arity reads the ARGUMENT REGISTERS, and r3.. are volatile under the EABI: a value
  // the first `bl` sits between cannot be an argument to the second one. Counting it invents an
  // argument — `func(1, 7)` for a call the caller set up with one — which is a wrong-code class, not
  // a formatting one. Same trim as the Thumb frontend (frontend/ssa.ts trimClobberedCallArgs).
  test('a guessed call arity drops the argument registers an earlier call clobbered', () => {
    // r3 is set before the first call too: a call whose r3 is empty while r4 holds a value is the
    // undecidable ARITY shape the guard below refuses, which is a different question from this one.
    const src = dis(
      'f',
      '0:\tli      r3,0\n4:\tli      r4,7\n8:\tbl      40 <foo>\nc:\tli      r3,1\n10:\tbl      50 <bar>\n14:\tblr\n',
    );
    expect(src).toContain('func(1)');
    expect(src).not.toContain('func(1, 7)');
  });

  // The other half of the same question. A guessed arity counts CONTIGUOUSLY from r3, so an empty
  // argument register ends the count — and an argument register is empty both when the call does not
  // pass it and when it still holds this function's own untouched incoming argument, which nothing
  // ever wrote and SSA therefore cannot see. Guessing the first reading drops that argument and
  // every later one: `ac-decomp:evw_anime_colreg_manual` passes seven registers to `evw_color_set`
  // and, with r4 left at its incoming value, lifted to `evw_color_set(a0);` — the divide, the
  // multiply and five arguments gone. The function's own arity is precisely what is missing here,
  // so the gap refuses.
  test('a guessed arity with a GAP in the argument registers refuses, rather than dropping the tail', () => {
    expect(() => dis('gap', '0:\tli      r5,3\n4:\tbl      40 <foo>\n8:\tblr\n')).toThrow(
      /r5 holds a value and r3 holds none — an argument register left at its incoming value/,
    );
  });
  test('control: no gap, so the contiguous count stands', () => {
    expect(dis('nogap', '0:\tli      r3,1\n4:\tli      r4,3\n8:\tbl      40 <foo>\nc:\tblr\n')).toContain('func(1, 3)');
  });
  // A DECLARATION THIS FRONTEND CANNOT HONOUR IS A REFUSAL, NOT AN ARITY. `void llsink(long long)`
  // spends two argument registers on one parameter, and this frontend turns every argument
  // register it reads into its own value — so obeying the declaration hands `llsink` r3 alone,
  // which on big-endian PowerPC is the HIGH half, and drops the low one. That is a compiling,
  // plausible, wrong program with no gap in it, which is the one output this frontend may not
  // produce. Measured before it was fixed: the call below lifted to `return llsink(1);`.
  test('a parameter declared wider than a register refuses, rather than passing one half of it', () => {
    const asm =
      '0 <c>:\n0:\tli      r3,1\n4:\tli      r4,3\n8:\tbl      c <c+0xc>\n\t\t\t8: R_PPC_REL24\tllsink\nc:\tblr\n';
    expect(() => decompile('c', asm, PPC_MWCC, { prototypes: { llsink: { params: ['long long'] } } })).toThrow(
      /one half of a 64-bit value would be handed to 'llsink' — its parameter 1 is declared wider than a register/,
    );
  });

  // THE SAME RULE ON THE WAY BACK, and it needs its own refusal because `FnProto.returns` is read
  // by ONE frontend and PRINTED on every target. `l3/symbol-refs.ts` puts `long long g(void);`
  // into the candidate's own translation unit wherever the prototype is spellable, and this
  // frontend reads the return register as the whole value — so honouring the declaration silently
  // lifted `return g();` off r3, the HIGH half on big-endian PowerPC, under a declaration that
  // makes `return g();` mean the LOW one. Same source, opposite value, compiles, no gap: the
  // outcome the parameter refusal above exists to prevent, arriving through the return.
  //
  // THE SIGNIFICANCE IS THE TWO TOGETHER: reading the OTHER half already declined (`r4 is read on
  // a path where a call has destroyed it`), so the field was inert where it would have helped and
  // harmful where it was emitted.
  test('a RETURN declared wider than a register refuses, rather than taking one half of it', () => {
    const asm = '0 <c>:\n0:\tbl      c <c+0xc>\n\t\t\t0: R_PPC_REL24\tg\n4:\tblr\n';
    const wide = { g: { params: [], returns: 'long long' } };
    expect(() => decompile('c', asm, PPC_MWCC, { prototypes: wide })).toThrow(
      /'g' would hand back one half of a 64-bit value — its return is declared wider than a register/,
    );
    // A register-width return states nothing this frontend cannot carry, so it is not refused —
    // the refusal is about the PAIR, not about the key.
    expect(decompile('c', asm, PPC_MWCC, { prototypes: { g: { params: [], returns: 'int' } } }).source).toContain(
      'return g();',
    );
  });

  // The other side of the same rule, and BOTH FRONTENDS CONVERT IT WITH THE SAME FUNCTION
  // (`proto.ts` `declaredArgWidths`). A spelling `declaredWidth` cannot read is a parameter that
  // occupies one argument register or two, and nothing a declaration holds says which — so the
  // list states no layout, and this call is lifted at the arg-register guess, exactly as a callee
  // the project never declared is. DECLARING MORE MAY NOT DO LESS.
  //
  // THE MACHINE IS NOT A WITNESS FOR THE MISSING WIDTH, which is what the equality below pins.
  // Weighing the declaration against the contiguous scan refused this very shape — `void
  // g(Direction)` against two registers held — while the same frontend lifted it when told
  // nothing, and it accepted the narrow reading wherever the scan happened to miscount a pair.
  test('a spelling the width reader cannot size leaves the guess standing', () => {
    const asm = '0 <c>:\n0:\tli      r3,1\n4:\tli      r4,3\n8:\tbl      c <c+0xc>\n\t\t\t8: R_PPC_REL24\tg\nc:\tblr\n';
    const guessed = decompile('c', asm, PPC_MWCC).source;
    expect(guessed).toContain('g(1, 3)');
    expect(decompile('c', asm, PPC_MWCC, { prototypes: { g: { params: ['Direction'] } } }).source).toBe(guessed);
    // …and the assertion is not vacuous, because a declaration that DOES state a layout moves the
    // answer: a COUNT speaks argument registers directly and is taken at its word.
    expect(decompile('c', asm, PPC_MWCC, { prototypes: { g: { params: 1 } } }).source).toContain('g(1)');
  });

  test('and a prototype answers the question the gap cannot', () => {
    // `declaredArgWidths` is consulted before the guess, so a declared callee is unaffected by the gap.
    const asm = '0:\tli      r5,3\n4:\tbl      8 <proto+0x8>\n\t\t\t4: R_PPC_REL24\tg\n8:\tblr\n';
    expect(decompile('proto', `0 <proto>:\n${asm}`, PPC_MWCC, { prototypes: { g: { params: 3 } } }).source).toContain(
      'g(a0, a1, 3)',
    );
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
  // on `pikmin:__ct__7ActFreeFP4Piki`, which reads `this` back into r4, and on 28 Mario Party 4
  // checkout functions that each lose an address the relocation fold recovered.
  test('a reload into a register the slot was NOT saved from FAILS LOUD, not a dropped value', () => {
    expect(() =>
      dis('crossreload', '0:\tstw     r3,8(r1)\n4:\tlwz     r4,8(r1)\n8:\tmr      r3,r4\nc:\tblr\n'),
    ).toThrow(/reload of '8\(r1\)' into r4, a slot r3 was saved into/);
  });
  test('and the call argument an offset-only record carries away is the reason', () => {
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
  // An argument register's saved entry value is a parameter, and its restore writes it back.
  const epi = (at: number, frame: number) =>
    `${at.toString(16)}:\tlwz     r0,${frame + 4}(r1)\n${(at + 4).toString(16)}:\taddi    r1,r1,${frame}\n` +
    `${(at + 8).toString(16)}:\tmtlr    r0\n${(at + 12).toString(16)}:\tblr\n`;
  const pro = (frame: number) => `0:\tmflr    r0\n4:\tstw     r0,4(r1)\n8:\tstwu    r1,-${frame}(r1)\n`;
  test('an argument reloaded after the body reused its register is the argument, not the reuse', () => {
    // mwcc 2.3.3 -O0, `int h(int a) { g[1] = 0; return e1(a); }`: r3 carries &g between the home
    // store and its reload.
    const asm =
      pro(16) +
      'c:\tstw     r3,8(r1)\n10:\tli      r0,0\n14:\tlis     r3,0\n\t\t\t16: R_PPC_ADDR16_HA\tg\n' +
      '18:\taddi    r3,r3,0\n\t\t\t1a: R_PPC_ADDR16_LO\tg\n1c:\tstw     r0,4(r3)\n20:\tlwz     r3,8(r1)\n' +
      '24:\tbl      24 <h+0x24>\n\t\t\t24: R_PPC_REL24\te1\n' +
      epi(0x28, 16);
    expect(dis('h', asm)).toBe('s32 h(s32 a0) {\n    ((s32 *)&g)[1] = 0;\n    return e1(a0);\n}\n');
  });
  test('a reload into a register nothing touched is still the argument a call is passed', () => {
    // pikmin `getCollPartPtr__9@unnamed@FR4TekiUl`: the reload is the only write of r4 before the
    // `bl`, and the prototype-less arity guess counts arguments by definition.
    const asm =
      pro(16) +
      'c:\tstw     r4,12(r1)\n10:\tlwz     r3,544(r3)\n14:\tlwz     r4,12(r1)\n' +
      '18:\tbl      18 <gcp+0x18>\n\t\t\t18: R_PPC_REL24\tgetSphere\n' +
      epi(0x1c, 16);
    expect(dis('gcp', asm)).toBe('s32 gcp(s32 *a0, s32 a1) {\n    return getSphere(a0[136], a1);\n}\n');
  });
  test('an argument saved to two slots is saved twice, not spilled, and either reload is the argument', () => {
    const asm =
      '0:\tstw     r3,8(r1)\n4:\tstw     r3,12(r1)\n8:\tli      r3,0\nc:\tlwz     r3,12(r1)\n10:\tlwz     r3,8(r1)\n14:\tblr\n';
    expect(dis('twice', asm)).toBe('s32 twice(s32 a0) {\n    return a0;\n}\n');
  });
  test('an argument stored to the frame and never read back refuses: it may be an outgoing stack argument', () => {
    // mwcc 2.3.3 -O4, `int s9(int a) { return g9(1, 2, 3, 4, 5, 6, 7, 8, a); }`: `stw r3,8(r1)` is the
    // ninth argument, in g9's parameter area.
    let asm = pro(24) + 'c:\tstw     r3,8(r1)\n';
    for (let k = 1; k <= 8; k++) {
      asm += `${(0xc + 4 * k).toString(16)}:\tli      r${k + 2},${k}\n`;
    }
    asm += '30:\tbl      30 <s9+0x30>\n\t\t\t30: R_PPC_REL24\tg9\n' + epi(0x34, 24);
    expect(() => dis('s9', asm)).toThrow(/argument register r3 is stored to '8\(r1\)' at 0xc and never read back/);
  });
  // A frame slot is named by its offset from the ENTRY r1. mwcc 2.3.3 (Pikmin) saves the link
  // register at 4(r1) BEFORE `stwu r1,-N(r1)` and restores it from N+4(r1) after; mwcc 2.4.x pushes
  // first and saves at N+4(r1). Named by the current r1, the 2.3.3 restore would find no slot.
  const frameBody = (sym: string) =>
    `10:\tmr      r31,r3\n14:\tbl      14 <${sym}+0x14>\n\t\t\t14: R_PPC_REL24\tcallee\n18:\tadd     r3,r3,r31\n`;
  test('the link register saved BEFORE the frame push is restored from the same slot after it', () => {
    const pre233 =
      '0:\tmflr    r0\n4:\tstw     r0,4(r1)\n8:\tstwu    r1,-16(r1)\nc:\tstw     r31,12(r1)\n' +
      frameBody('lr233') +
      '1c:\tlwz     r0,20(r1)\n20:\tlwz     r31,12(r1)\n24:\taddi    r1,r1,16\n28:\tmtlr    r0\n2c:\tblr\n';
    expect(dis('lr233', pre233)).toBe('s32 lr233(s32 a0) {\n    return callee(a0) + a0;\n}\n');
  });
  test('control: the push-first prologue lifts to the same function', () => {
    const post242 =
      '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\nc:\tstw     r31,12(r1)\n' +
      frameBody('lr242') +
      '1c:\tlwz     r0,20(r1)\n20:\tlwz     r31,12(r1)\n24:\tmtlr    r0\n28:\taddi    r1,r1,16\n2c:\tblr\n';
    expect(dis('lr242', post242)).toBe('s32 lr242(s32 a0) {\n    return callee(a0) + a0;\n}\n');
  });
  test('one printed offset on both sides of the push is two different words', () => {
    // `4(r1)` before the push is the caller's LR word; after it, it is a word of this frame that
    // nothing saved. Named by the current r1 the load looked like the restore and was dropped.
    const asm =
      '0:\tmflr    r0\n4:\tstw     r0,4(r1)\n8:\tstwu    r1,-16(r1)\nc:\tlwz     r0,4(r1)\n' +
      '10:\taddi    r1,r1,16\n14:\tmtlr    r0\n18:\tblr\n';
    expect(() => dis('twowords', asm)).toThrow(/reload of a stack local \('4\(r1\)'\)/);
  });
  test('a local nobody saved, and an argument the caller passed on the stack, still refuse', () => {
    expect(() =>
      dis('unsaved', '0:\tstwu    r1,-16(r1)\n4:\tlwz     r3,8(r1)\n8:\taddi    r1,r1,16\nc:\tblr\n'),
    ).toThrow(/reload of a stack local \('8\(r1\)'\)/);
    expect(() =>
      dis('stkarg', '0:\tstwu    r1,-16(r1)\n4:\tlwz     r3,24(r1)\n8:\taddi    r1,r1,16\nc:\tblr\n'),
    ).toThrow(/reload of a stack local \('24\(r1\)'\)/);
  });
  test('an argument spilled before the push and read back into another register after it still refuses', () => {
    const asm =
      '0:\tstw     r3,8(r1)\n4:\tstwu    r1,-16(r1)\n8:\tlwz     r4,24(r1)\nc:\tmr      r3,r4\n' +
      '10:\taddi    r1,r1,16\n14:\tblr\n';
    expect(() => dis('spillback', asm)).toThrow(/reload of '24\(r1\)' into r4, a slot r3 was saved into/);
  });
  test('where r1 is not at a known depth, a frame access refuses instead of naming a slot', () => {
    expect(() =>
      dis('twopush', '0:\tstwu    r1,-16(r1)\n4:\tstwu    r1,-16(r1)\n8:\taddi    r1,r1,32\nc:\tblr\n'),
    ).toThrow(/at 0x4 is not the one frame push from the entry stack pointer — r1 had already moved \(-16\)/);
    expect(() => dis('notchain', '0:\tstwu    r31,-16(r1)\n4:\taddi    r1,r1,16\n8:\tblr\n')).toThrow(
      /it stores r31, not the back chain/,
    );
    expect(() =>
      dis(
        'mrr1',
        '0:\tstw     r31,-4(r1)\n4:\tstwu    r1,-16(r1)\n8:\tmr      r1,r11\nc:\tlwz     r31,-4(r1)\n10:\tblr\n',
      ),
    ).toThrow(/'-4\(r1\)' at 0xc — .* 'mr r1,r11' at 0x8 sets r1 to a value this frontend does not track/);
    // Two paths meet at 0x10, one through the push and one around it.
    const depths =
      '0:\tstw     r31,-4(r1)\n4:\tcmpwi   r3,0\n8:\tbeq-    10 <depths+0x10>\nc:\tstwu    r1,-16(r1)\n' +
      '10:\tlwz     r31,-4(r1)\n14:\tblr\n';
    expect(() => dis('depths', depths)).toThrow(/arrive with r1 at two depths \(0 and -16 bytes/);
  });
  // mwcc 2.3.3 moves a register with `addi rD,rS,0` where 2.4.x prints `mr`. Lifted as an add, the
  // `+ 0` makes the table's address an integer sum, and mwcc's C++ refuses to pass
  // `(u32)&gTable + 0` to a `const char *` parameter.
  test('`addi rD,rS,0` with no relocation is a move: the address it carries keeps its type', () => {
    const asm =
      '0:\tlis     r4,0\n\t\t\t2: R_PPC_ADDR16_HA\tgTable\n4:\taddi    r4,r4,0\n\t\t\t6: R_PPC_ADDR16_LO\tgTable\n' +
      '8:\taddi    r3,r4,0\nc:\tb       10 <mv+0x10>\n10:\tblr\n';
    const src = decompile('mv', `0 <mv>:\n${asm}`, PPC_MWCC).source;
    expect(src).toContain('return &gTable;');
    expect(src).not.toContain('+ 0');
    expect(dis('mvp', '0:\taddi    r4,r3,0\n4:\tlwz     r3,4(r4)\n8:\tblr\n')).toBe(
      's32 mvp(s32 *a0) {\n    return a0[1];\n}\n',
    );
  });
  test('an rA field of 0 is the literal 0: `addi rD,r0,SIMM` is `li`, not a read of r0', () => {
    expect(dis('mvr0', '0:\tli      r0,7\n4:\taddi    r3,r0,0\n8:\tblr\n')).toBe(
      's32 mvr0(void) {\n    return 0;\n}\n',
    );
    expect(dis('adr0', '0:\tli      r0,7\n4:\taddis   r3,r0,1\n8:\tblr\n')).toBe(
      's32 adr0(void) {\n    return 65536;\n}\n',
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
