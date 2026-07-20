// PPC frontend robustness — regressions pinning silent-miscompile classes in the PowerPC frontend.
// Toolchain-free: each case is hand-authored objdump text (the exact shapes CodeWarrior emits),
// lifted end-to-end. These pin that a decode gap fails LOUD or fuses correctly — never
// plausible-but-wrong C.
import { describe, expect, test } from 'vitest';

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
  test('an indirect branch (bctr) FAILS LOUD too', () => {
    expect(() => dis('jumptab', '0:\tbctr\n')).toThrow(/unmodelled control transfer 'bctr'/);
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

  // rlwinm right-shift extract `(x>>n)&m` (ME=31) — modelled as shift + mask.
  test('rlwinm right-shift extract decodes to a shift + mask', () => {
    expect(dis('ext', '0:\trlwinm  r3,r3,27,24,31\n4:\tblr\n')).toBe(
      's32 ext(s32 a0) {\n    return a0 >> 5 & 255;\n}\n',
    );
  });

  // Stack frames beyond callee-saved/lr save-restore, and SDA/global access, are unmodelled;
  // lifting them anyway silently miscompiles (a dropped local spill / a fabricated pointer param),
  // so each must fail LOUD.
  test('address-taken local (r1 used as data) FAILS LOUD, not a fabricated data param', () => {
    // `addi r3,r1,8` = `&local` — reading the stack pointer as data (silently `return a0 + 8;` otherwise).
    expect(() => dis('addrtaken', '0:\taddi    r3,r1,8\n4:\tblr\n')).toThrow(/stack pointer r1 used as data/);
  });
  test('spill of a LIVE (computed) value to the stack FAILS LOUD, not a dropped spill', () => {
    // `addi r0,r3,1` computes a value; `stw r0,8(r1)` spills it. A callee-saved SAVE stores an
    // unchanged entry value (no reaching def) and stays transparent — this stores a live value.
    expect(() => dis('livespill', '0:\taddi    r0,r3,1\n4:\tstw     r0,8(r1)\n8:\tblr\n')).toThrow(
      /spill of a live value/,
    );
  });
  test('SDA/global access (non-register memory base) FAILS LOUD, not a fabricated pointer param', () => {
    // `stw r0,0(0)` — the base field is a 0 placeholder an SDA relocation fills at link. Lifting it
    // as a store to a fabricated first pointer parameter loses the global write.
    expect(() => dis('glob', '0:\tstw     r0,0(0)\n4:\tblr\n')).toThrow(/SDA\/global-relative access not supported/);
  });
});
