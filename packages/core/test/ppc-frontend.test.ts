// PPC frontend robustness — regressions pinning silent-miscompile classes in the PowerPC frontend.
// Toolchain-free: each case is hand-authored objdump text (the exact shapes CodeWarrior emits),
// lifted end-to-end. These pin that a decode gap fails LOUD or fuses correctly — never
// plausible-but-wrong C.
import { describe, expect, test } from 'vitest';

import type { AsmData } from '../src/frontend/asmdata';
import { PpcUnsupportedError, lift } from '../src/frontend/ppc';
import { decompile } from '../src/pipeline';
import { PPC_MWCC, PPC_MWCC_233, targetFor } from '../src/target';

const dis = (sym: string, lines: string) => decompile(sym, `0 <${sym}>:\n${lines}`, PPC_MWCC).source;
/** `dis` on a target that claims no start offset past which it never loads its outgoing area. */
const disUnclaimed = (sym: string, lines: string) =>
  decompile(sym, `0 <${sym}>:\n${lines}`, {
    ...PPC_MWCC,
    compilerBehaviors: { ...PPC_MWCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
  }).source;

/** A fixture that makes a call, wrapped in mwcc's link-register save (`stwu`/`mflr`/`stw` …
 *  `lwz`/`mtlr`/`addi`): a `bl` whose `blr` puts no saved return address back declines
 *  (`linkRegisterProof` in frontend/ppc.ts). Every address shifts by the 12-byte prologue, and the
 *  LAST `blr` becomes the epilogue. A `0 <name>:` header line stays first. */
const framed = (text: string): string => {
  const shift = (a: string) => (parseInt(a, 16) + 12).toString(16);
  const header = /^\d+ <[^>]+>:\n/.exec(text)?.[0] ?? '';
  const body = text
    .slice(header.length)
    .replace(/^( *)([0-9a-f]+):\t/gm, (_, sp: string, a: string) => `${sp}${shift(a)}:\t`)
    .replace(/^(\t\t\t)([0-9a-f]+): R_/gm, (_, t: string, a: string) => `${t}${shift(a)}: R_`);
  const last = /( *)([0-9a-f]+):\tblr\n$/.exec(body)!;
  const at = (k: number) => (parseInt(last[2], 16) + 4 * k).toString(16);
  return (
    header +
    '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\n' +
    body.slice(0, last.index) +
    `${at(0)}:\tlwz     r0,20(r1)\n${at(1)}:\tmtlr    r0\n${at(2)}:\taddi    r1,r1,16\n${at(3)}:\tblr\n`
  );
};

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

  test('a body that runs off its end with no terminator declines, rather than inventing a return', () => {
    // A whole-object dump split on symbol lines ends a function early at a foreign label
    // (ac-decomp's famicom.o has five `.text` sections), and what follows the last instruction is
    // unknown. Lifted as a return, `mr r31,r4; addi r3,r31,1` would read as `return a1 + 1;`.
    expect(() => dis('cut', '0:\tmr      r31,r4\n4:\taddi    r3,r31,1\n')).toThrow(
      /control falls off the end \(the block at 0x0 has no terminator and no successor; its last instruction is at 0x4\)/,
    );
    // A last block reached by a branch, too: the loop exit at 0xc falls off.
    const tail = '0:\tcmpwi   r3,0\n4:\tbeq-    c <tl+0xc>\n8:\tblr\nc:\tli      r3,1\n';
    expect(() => dis('tl', tail)).toThrow(/control falls off the end \(the block at 0xc/);
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
      '10:\tbl      10 <cc+0x10>\n\t\t\t10: R_PPC_REL24\tg\n14:\tbeq-    24 <cc+0x24>\n18:\tli      r3,1\n1c:\tb       28 <cc+0x28>\n' +
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

  test('a genuine rotate/insert rlwinm (mask over both halves of the rotate) still FAILS LOUD (not `return;`)', () => {
    // `rlwinm r3,r3,4,24,31` keeps bits from both the shifted-up word and the 4 bits the rotate
    // brings round from the top — a real rotate-and-mask, which this frontend does not model. It
    // routes through the opaque guard: reaching the output trips the boundary contract rather than
    // decoding to `s32 f(void){ return; }`. (A field wholly in either half, `(x>>n)&m` or
    // `(x&m)<<n`, IS modelled — see the PPC-WIDEN tests below.)
    expect(() => dis('rot', '0:\trlwinm  r3,r3,4,24,31\n4:\tblr\n')).toThrow();
    // a whole-word rotate, and a mask that wraps round bit 0
    expect(() => dis('rot', '0:\trlwinm  r3,r3,4,0,31\n4:\tblr\n')).toThrow();
    expect(() => dis('rot', '0:\trlwinm  r3,r3,0x1c,28,3\n4:\tblr\n')).toThrow();
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
          '10:\tbl      40 <foo>\n\t\t\t10: R_PPC_REL24\tfoo\n14:\tadd     r31,r31,r3\n18:\taddi    r3,r3,4\n1c:\tbdnz    10 <callloop+0x10>\n' +
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
      framed(
        '0:\tli      r3,0\n4:\tli      r4,7\n8:\tbl      40 <foo>\n\t\t\t8: R_PPC_REL24\tfoo\n' +
          'c:\tli      r3,1\n10:\tbl      50 <bar>\n\t\t\t10: R_PPC_REL24\tbar\n14:\tblr\n',
      ),
    );
    expect(src).toContain('bar(1)');
    expect(src).not.toContain('bar(1, 7)');
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
    expect(() => dis('gap', '0:\tli      r5,3\n4:\tbl      40 <foo>\n\t\t\t4: R_PPC_REL24\tfoo\n8:\tblr\n')).toThrow(
      /r5 holds a value and r3 holds none — an argument register left at its incoming value/,
    );
  });
  test('control: no gap, so the contiguous count stands', () => {
    expect(
      dis(
        'nogap',
        framed('0:\tli      r3,1\n4:\tli      r4,3\n8:\tbl      40 <foo>\n\t\t\t8: R_PPC_REL24\tfoo\nc:\tblr\n'),
      ),
    ).toContain('foo(1, 3)');
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
    const asm = framed('0 <c>:\n0:\tbl      c <c+0xc>\n\t\t\t0: R_PPC_REL24\tg\n4:\tblr\n');
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
  // (`proto.ts` `declaredCallArgs`). A spelling `declaredWidth` cannot read is a parameter that
  // occupies one argument register or two, and nothing a declaration holds says which — so the
  // list states no layout, and this call is lifted at the arg-register guess, exactly as a callee
  // the project never declared is. DECLARING MORE MAY NOT DO LESS.
  //
  // THE MACHINE IS NOT A WITNESS FOR THE MISSING WIDTH, which is what the equality below pins.
  // Weighing the declaration against the contiguous scan refused this very shape — `void
  // g(Direction)` against two registers held — while the same frontend lifted it when told
  // nothing, and it accepted the narrow reading wherever the scan happened to miscount a pair.
  test('a spelling the width reader cannot size leaves the guess standing', () => {
    const asm = framed(
      '0 <c>:\n0:\tli      r3,1\n4:\tli      r4,3\n8:\tbl      c <c+0xc>\n\t\t\t8: R_PPC_REL24\tg\nc:\tblr\n',
    );
    const guessed = decompile('c', asm, PPC_MWCC).source;
    expect(guessed).toContain('g(1, 3)');
    expect(decompile('c', asm, PPC_MWCC, { prototypes: { g: { params: ['Direction'] } } }).source).toBe(guessed);
    // …and the assertion is not vacuous, because a declaration that DOES state a layout moves the
    // answer: a COUNT speaks argument registers directly and is taken at its word.
    expect(decompile('c', asm, PPC_MWCC, { prototypes: { g: { params: 1 } } }).source).toContain('g(1)');
  });

  test('and a prototype answers the question the gap cannot', () => {
    // `declaredCallArgs` is consulted before the guess, so a declared callee is unaffected by the gap.
    const asm = framed('0:\tli      r5,3\n4:\tbl      8 <proto+0x8>\n\t\t\t4: R_PPC_REL24\tg\n8:\tblr\n');
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
    // The bl's encoded target is a 0 placeholder; the name `g` lives only in the relocation.
    const src = dis('callsym', framed('0:\tbl      4 <callsym+0x4>\n\t\t\t0: R_PPC_REL24\tg\n4:\tblr\n'));
    expect(src).toContain('g(');
  });

  // A `bl` with no relocation is one the assembler resolved inside this section: in these hand-written
  // asm functions, into the function's own body. Lowered as a call, each would name an invented `func`
  // on all three mwcc builds (`q_localfall` as `func(); return 7;`, `q_local` as `return func();`).
  test.each(['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as const)(
    'on %s, a `bl` no relocation names declines',
    (tc) => {
      const { target } = targetFor(tc, ['-O4,p']);
      const NO_CALLEE = /the 'bl' at 0x4 has no callee symbol — no R_PPC_REL24 relocation names it/;
      const lift = (name: string, body: string) => () => decompile(name, `0 <${name}>:\n${body}`, target);
      expect(
        lift(
          'q_localfall',
          '0:\tmflr    r31\n4:\tbl      8 <q_localfall+0x8>\n8:\tmtlr    r31\nc:\tli      r3,7\n10:\tblr\n',
        ),
      ).toThrow(NO_CALLEE);
      expect(
        lift(
          'q_local',
          '0:\tmflr    r31\n4:\tbl      10 <q_local+0x10>\n8:\tmtlr    r31\nc:\tblr\n10:\tli      r3,7\n14:\tblr\n',
        ),
      ).toThrow(NO_CALLEE);
    },
  );

  // rlwinm right-shift extract `(x>>n)&m` (ME=31) — modelled as shift + mask. The rotate makes
  // the shift LOGICAL, which is what the lift records (`shr_u`); over the `s32`-declared `a0` a
  // bare `>>` would be C's arithmetic one, so the operand is spelled unsigned.
  test('rlwinm right-shift extract decodes to a shift + mask', () => {
    expect(dis('ext', '0:\trlwinm  r3,r3,27,24,31\n4:\tblr\n')).toBe(
      's32 ext(s32 a0) {\n    return (u32)a0 >> 5 & 255;\n}\n',
    );
    // a field that stops short of bit 31, still wholly in the bits the rotate brings round
    expect(dis('ext', '0:\trlwinm  r3,r3,12,24,27\n4:\tblr\n')).toBe(
      's32 ext(s32 a0) {\n    return (u32)a0 >> 20 & 240;\n}\n',
    );
    // the one bit the sign bit lands on: the sign moved up (mwcc's `(x >> 31) << 3`)
    expect(dis('ext', '0:\trlwinm  r3,r3,4,28,28\n4:\tblr\n')).toBe(
      's32 ext(s32 a0) {\n    return (u32)a0 >> 31 << 3;\n}\n',
    );
  });

  // The other half of the rotate: a field wholly in the bits the shift fills is a masked value
  // moved up, `(x & m) << n` — `slwi` itself where the mask keeps every such bit.
  test('rlwinm left-shift insert decodes to a mask + shift', () => {
    expect(dis('ins', '0:\trlwinm  r3,r3,4,24,27\n4:\tblr\n')).toBe(
      's32 ins(s32 a0) {\n    return (a0 & 15) << 4;\n}\n',
    );
    expect(dis('ins', '0:\trlwinm  r3,r3,5,26,26\n4:\tblr\n')).toBe(
      's32 ins(s32 a0) {\n    return (a0 & 1) << 5;\n}\n',
    );
  });

  // Stack frames beyond callee-saved/lr save-restore, and SDA/global access, are unmodelled;
  // lifting them anyway silently miscompiles (a dropped local spill / a fabricated pointer param),
  // so each must fail LOUD.
  test('address-taken local (r1 used as data) FAILS LOUD, not a fabricated data param', () => {
    // `addi r3,r1,8` = `&local` — reading the stack pointer as data (silently `return a0 + 8;` otherwise).
    expect(() => dis('addrtaken', '0:\taddi    r3,r1,8\n4:\tblr\n')).toThrow(/stack pointer r1 used as data/);
  });
  test('the frame address `addi r11,r1,N` forms is no value: any use of it still refuses', () => {
    // r11 is deferred for mwcc's register save routines, which take it there. Read directly, as a
    // memory base, or through a join, it is the frame read as data.
    const asData = /stack pointer r1 used as data/;
    expect(() => dis('fa', '0:\taddi    r11,r1,8\n4:\tmr      r3,r11\n8:\tblr\n')).toThrow(asData);
    expect(() => dis('fabase', '0:\taddi    r11,r1,8\n4:\tlwz     r3,0(r11)\n8:\tblr\n')).toThrow(asData);
    const join =
      '0:\taddi    r11,r1,8\n4:\tcmpwi   r4,0\n8:\tbeq-    10 <faj+0x10>\nc:\tmr      r11,r3\n' +
      '10:\tlwz     r3,0(r11)\n14:\tblr\n';
    expect(() => dis('faj', join)).toThrow(asData);
    // Nothing takes it: only a save routine may, so a dead one refuses too.
    expect(() => dis('fadead', '0:\taddi    r11,r1,8\n4:\tli      r3,0\n8:\tblr\n')).toThrow(asData);
  });
  // mwcc 2.4.x's out-of-line register saves: `addi r11,r1,N; bl _savegpr_NN` stores rNN..r31 into
  // the words just below r11, and `_restgpr_NN` reloads them. The `addi` need not sit next to the `bl`.
  describe('register save routines', () => {
    // `@` in a line stands for its own address, which the call's relocation names.
    const lines = (...ls: string[]) =>
      ls.map((l, i) => `${(i * 4).toString(16)}:\t${l.replaceAll('@', (i * 4).toString(16))}\n`).join('');
    const bl = (sym: string) => `bl      @ <x+0x@>\n\t\t\t@: R_PPC_REL24\t${sym}`;
    const PRO = ['stwu    r1,-32(r1)', 'mflr    r0', 'stw     r0,36(r1)', 'addi    r11,r1,32', bl('_savegpr_30')];
    const EPI = ['lwz     r0,36(r1)', 'mtlr    r0', 'addi    r1,r1,32', 'blr'];
    const fn = (sym: string, ...body: string[]) => dis(sym, lines(...PRO, ...body, ...EPI));
    test("the routine family is the target's data: a target that names none keeps the r1 refusal", () => {
      // `registerSaveRoutines` absent: the `bl` is an ordinary call, and `addi r11,r1,N` is the stack
      // pointer read as data where it stands — a capture of the frame top, which no local starts at.
      const none = { ...PPC_MWCC, registerSaveRoutines: undefined };
      const asm = lines(...PRO, 'add     r31,r3,r4', 'addi    r11,r1,32', 'mr      r3,r31', bl('_restgpr_30'), ...EPI);
      expect(() => decompile('nr', `0 <nr>:\n${asm}`, none)).toThrow(/cannot lift 'nr'/);
      const noLayout = { ...none, compilerBehaviors: { ...none.compilerBehaviors, linkageLocalArea: undefined } };
      expect(() => decompile('nr', `0 <nr>:\n${asm}`, noLayout)).toThrow(/stack pointer r1 used as data/);
    });
    test('a save and its restore are frame bookkeeping, not calls', () => {
      expect(fn('gs', 'add     r31,r3,r4', 'addi    r11,r1,32', 'mr      r3,r31', bl('_restgpr_30'))).toBe(
        's32 gs(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
      );
    });
    test('a routine call with no relocation is no routine, and refuses', () => {
      // A linked image, or objdump without `-r`: `bl <_savegpr_NN>` names its target only in the
      // text. Lowered as an ordinary call, the routine's "return value" would stand for the argument
      // it preserves; a `bl` no relocation names is no call either.
      const bare = (sym: string) => `bl      200 <${sym}>`;
      const asm = lines(
        'stwu    r1,-32(r1)',
        'mflr    r0',
        'stw     r0,36(r1)',
        'addi    r11,r1,32',
        bare('_savegpr_30'),
        'mr      r31,r3',
        'mr      r3,r31',
        'addi    r11,r1,32',
        bare('_restgpr_30'),
        ...EPI,
      );
      expect(() => dis('bare', asm)).toThrow(/the 'bl' at 0x10 has no callee symbol/);
    });
    test('the routine preserves r0: the return address `mflr` left there is still read as one', () => {
      // synthetic uninit_spill: a path that reads r0 with nothing else written reads the return
      // address. As a call the bytes would read as destroyed, or as the callee's.
      expect(() => fn('ra', 'add     r3,r3,r0', 'addi    r11,r1,32', bl('_restgpr_30'))).toThrow(
        /the return address the 'mflr' at 0x4 copies out is used as a value/,
      );
    });
    test('a call between the frame address and the routine destroys r11, and the routine refuses it', () => {
      // The routine takes its frame address in r11 outside any op, so the builder is told it was
      // used; a callee leaves whatever it likes in r11, and the save would store through that.
      const asm = lines(
        'stwu    r1,-32(r1)',
        'mflr    r0',
        'stw     r0,36(r1)',
        'addi    r11,r1,32',
        bl('foo'),
        bl('_savegpr_30'),
        'mr      r31,r3',
        'addi    r11,r1,32',
        'mr      r3,r31',
        bl('_restgpr_30'),
        ...EPI,
      );
      expect(() => decompile('cl', `0 <cl>:\n${asm}`, PPC_MWCC, { prototypes: { foo: { params: 0 } } })).toThrow(
        /r11 is read on a path where a call has destroyed it/,
      );
    });
    test('the routine overwrites the link register, so it must come after the return address is copied out', () => {
      // `mflr` after the routine copies out the address after its `bl`.
      const late = lines(
        'stwu    r1,-32(r1)',
        'addi    r11,r1,32',
        bl('_savegpr_30'),
        'mflr    r0',
        'stw     r0,36(r1)',
        'add     r3,r3,r4',
        'addi    r11,r1,32',
        bl('_restgpr_30'),
        ...EPI,
      );
      expect(() => dis('lt', late)).toThrow(/the 'mflr' at 0xc reads the link register the 'bl' at 0x8 overwrote/);
      // No `mflr` at all: the `blr` jumps through what the routine left there.
      const none = lines(
        'stwu    r1,-32(r1)',
        'addi    r11,r1,32',
        bl('_savegpr_30'),
        'add     r3,r3,r4',
        'addi    r11,r1,32',
        bl('_restgpr_30'),
        'addi    r1,r1,32',
        'blr',
      );
      expect(() => dis('nm', none)).toThrow(
        /the 'blr' at 0x1c may not return through the caller's link register — the 'bl' at 0x14 overwrote it/,
      );
      // An ordinary call before the `mflr` overwrote it the same way.
      const call = lines('stwu    r1,-32(r1)', bl('foo'), 'mflr    r0', 'stw     r0,36(r1)', ...EPI);
      expect(() => dis('oc', call)).toThrow(/the 'mflr' at 0x8 reads the link register the 'bl' at 0x4 overwrote/);
    });
    test('the FPR routines are named and refused: no lift reaches them yet', () => {
      // mwcc 2.4.x -O4,s: `addi r11,r1,64; bl _savefpr_28` then `addi r11,r1,32; bl _savegpr_28`.
      // Every compiled caller declines on its float code first, so the 8-byte slots stay unmodelled.
      const asm = lines(
        'stwu    r1,-48(r1)',
        'mflr    r0',
        'stw     r0,52(r1)',
        'addi    r11,r1,48',
        bl('_savefpr_30'),
        'addi    r11,r1,32',
        bl('_savegpr_30'),
        'add     r3,r3,r4',
        'addi    r11,r1,48',
        bl('_restfpr_30'),
        'addi    r11,r1,32',
        bl('_restgpr_30'),
        'lwz     r0,52(r1)',
        'mtlr    r0',
        'addi    r1,r1,48',
        'blr',
      );
      expect(() => dis('fg', asm)).toThrow(/'_savefpr_30' at 0x10 saves or restores floating-point registers/);
    });
    test('`stmw`, a single `stw` and the routine keep one save rule and one restore rule', () => {
      // A restore puts the caller's register back, whichever instruction does it: reading it after
      // is no C value (the hardware returns the caller's r31, not a0).
      const after = /r31 is read after the restore at 0x8 put the caller's r31 back/;
      expect(() =>
        dis('stmA', lines('stmw    r31,28(r1)', 'mr      r31,r3', 'lmw     r31,28(r1)', 'mr      r3,r31', 'blr')),
      ).toThrow(after);
      expect(() =>
        dis('stwA', lines('stw     r31,28(r1)', 'mr      r31,r3', 'lwz     r31,28(r1)', 'mr      r3,r31', 'blr')),
      ).toThrow(after);
      // A `stmw` of a register already written saves a value, which no compiler's prologue does (the
      // hardware returns 5 here, not 7).
      expect(() =>
        dis(
          'stm5',
          lines('li      r31,5', 'stmw    r31,28(r1)', 'li      r31,7', 'lmw     r31,28(r1)', 'mr      r3,r31', 'blr'),
        ),
      ).toThrow(/the 'stmw' at 0x4 saves r31 after this function wrote it/);
    });
    test('each way the routine is not the bookkeeping it looks like refuses', () => {
      // A restore over other words, or another register range, than the save filled.
      expect(() => fn('skew', 'addi    r11,r1,36', bl('_restgpr_30'))).toThrow(
        /reload of '-8\(r11\)' into r30, a slot r31 was saved/,
      );
      expect(() => fn('wide', 'addi    r11,r1,32', bl('_restgpr_29'))).toThrow(
        /reload of '-12\(r11\)' into r29, a word nothing saved/,
      );
      // r11 is not a frame address, or is one on only one path.
      expect(() => dis('nofa', lines('mr      r11,r3', bl('_savegpr_30'), 'blr'))).toThrow(
        /one frame address \('addi r11,r1,N'\) in r11/,
      );
      const mixed = lines(
        'addi    r11,r1,0',
        'cmpwi   r4,0',
        'beq-    10 <x+0x10>',
        'mr      r11,r3',
        bl('_savegpr_30'),
        'blr',
      );
      expect(() => dis('mixfa', mixed)).toThrow(/one frame address \('addi r11,r1,N'\) in r11/);
      // A register written before it is saved: the word holds a value.
      expect(() => dis('late', lines('li      r31,0', 'addi    r11,r1,0', bl('_savegpr_30'), 'blr'))).toThrow(
        /saves r31 after this function wrote it/,
      );
      // A register READ before it is saved: the save keeps a value the function was handed, and the
      // refusal says read, not wrote. The read is no uninitialised local either — the prologue had
      // not saved the register yet, so `prologueSavedRegs` does not count that save.
      expect(() => dis('early', lines('add     r3,r3,r31', 'addi    r11,r1,0', bl('_savegpr_31'), 'blr'))).toThrow(
        /saves r31 after this function read it/,
      );
      expect(() => dis('earlym', lines('add     r3,r3,r30', 'stmw    r30,8(r1)', 'lmw     r30,8(r1)', 'blr'))).toThrow(
        /the 'stmw' at 0x4 saves r30 after this function read it/,
      );
      // A word the function also stores a value to.
      expect(() => dis('both', lines('stw     r3,-8(r1)', 'addi    r11,r1,0', bl('_savegpr_30'), 'blr'))).toThrow(
        /both saves a register in and stores a value to/,
      );
      // No runtime routine saves r5.
      expect(() => dis('r5', lines('addi    r11,r1,0', bl('_savegpr_5'), 'blr'))).toThrow(
        /names no register save routine/,
      );
      // A restored register holds the caller's value again.
      expect(() => fn('after', 'addi    r11,r1,32', bl('_restgpr_30'), 'mr      r3,r31')).toThrow(
        /r31 is read after the restore at 0x\w+ put the caller's r31 back/,
      );
    });
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
  test('a small-data base read as data refuses instead of becoming a parameter', () => {
    // mwcc 2.4.7 indexes `playerOrderNew[j - 1]` with `lbzx r0,r3,r13` (MP4 `OrderPlayers`). r13 has
    // no definition here, so the builder would read it as an invented argument: `s32 f(s32 a0, s32 a1)`.
    expect(() => dis('sdaidx', '0:\tlbzx    r3,r3,r13\n4:\tblr\n')).toThrow(/r13 \(the small-data base\) used as data/);
    expect(() => dis('sda2base', '0:\tlwz     r3,8(r2)\n4:\tblr\n')).toThrow(/r2 \(the small-data base\) used as data/);
  });
  // A word stored to the frame with a VALUE is a stack-slot variable, as on MIPS and Thumb: a
  // reload into any register reads it back, whichever register stored it.
  test('a live value spilled to the frame is read back by its reload', () => {
    expect(
      dis('ls', '0:\taddi    r0,r3,1\n4:\tstw     r0,8(r1)\n8:\tli      r0,0\nc:\tlwz     r3,8(r1)\n10:\tblr\n'),
    ).toBe('s32 ls(s32 a0) {\n    return a0 + 1;\n}\n');
  });
  test('an argument read back into another register is the argument', () => {
    // `pikmin:__ct__7ActFreeFP4Piki` reads `this` back into r4 this way.
    expect(dis('crossreload', '0:\tstw     r3,8(r1)\n4:\tlwz     r4,8(r1)\n8:\tmr      r3,r4\nc:\tblr\n')).toBe(
      's32 crossreload(s32 a0) {\n    return a0;\n}\n',
    );
  });
  test('and it keeps every later argument of the call it sets up', () => {
    // Dropped, the reload would leave r4 undefined, and the contiguous arity guess would take the
    // recovered `&gObj` in r5 with it: `callee(1)`.
    const asm =
      '0:\tstw     r3,8(r1)\n4:\tli      r3,1\n8:\tlwz     r4,8(r1)\n' +
      'c:\tlis     r5,0\n\t\t\te: R_PPC_ADDR16_HA\tgObj\n' +
      '10:\taddi    r5,r5,0\n\t\t\t12: R_PPC_ADDR16_LO\tgObj\n' +
      '14:\tbl      18 <argdrop+0x18>\n\t\t\t14: R_PPC_REL24\tcallee\n18:\tblr\n';
    expect(dis('argdrop', framed(asm))).toBe('s32 argdrop(s32 a0) {\n    return callee(1, a0, &gObj);\n}\n');
  });
  test('a slot stored on one path and reloaded at the join refuses: the other path reads nothing', () => {
    // The reload at 0x14 reads uninitialised stack when r3 (or r4) is 0.
    const join = (reg: string) =>
      `0:\tstwu    r1,-24(r1)\n4:\tcmpwi   ${reg},0\n8:\tbeq-    10 <join+0x10>\nc:\tstw     r3,16(r1)\n` +
      '10:\tli      r3,5\n14:\tlwz     r3,16(r1)\n18:\taddi    r3,r3,1\n1c:\taddi    r1,r1,24\n20:\tblr\n';
    expect(() => dis('join', join('r3'))).toThrow(/sp@-8 is read on a path that never stores it/);
    expect(() => dis('join', join('r4'))).toThrow(/sp@-8 is read on a path that never stores it/);
  });
  test('a word both saved and stored with a value refuses', () => {
    expect(() =>
      dis('mixed', '0:\tstw     r31,12(r1)\n4:\tstw     r3,12(r1)\n8:\tlwz     r31,12(r1)\nc:\tblr\n'),
    ).toThrow(/'12\(r1\)' at 0x4 is a word this function both saves a register in and stores a value to/);
  });
  test('control: a save and restore of the SAME register stays transparent', () => {
    expect(dis('saverestore', '0:\tstw     r31,12(r1)\n4:\tadd     r3,r3,r4\n8:\tlwz     r31,12(r1)\nc:\tblr\n')).toBe(
      's32 saverestore(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
    );
  });
  test('a register the prologue saved and the body reads first is an uninitialised local, not a parameter', () => {
    // mwcc homes `int x; if (s) x = k(a); return k(...) + x;` in a callee-saved register, and on the
    // path that skips the assignment reads what the caller left there. Each save form names the
    // register: a `stw`, a `stmw`, and the save routine.
    const uninit = (sym: string) => `s32 ${sym}(s32 a0) {\n    s32 uninit_r31;\n    return a0 + uninit_r31;\n}\n`;
    expect(dis('us', '0:\tstw     r31,12(r1)\n4:\tadd     r3,r3,r31\n8:\tlwz     r31,12(r1)\nc:\tblr\n')).toBe(
      uninit('us'),
    );
    expect(dis('um', '0:\tstmw    r30,8(r1)\n4:\tadd     r3,r3,r31\n8:\tlmw     r30,8(r1)\nc:\tblr\n')).toBe(
      uninit('um'),
    );
    const routine =
      '0:\tmflr    r0\n4:\taddi    r11,r1,0\n8:\tbl      8 <ur+0x8>\n\t\t\t8: R_PPC_REL24\t_savegpr_31\n' +
      'c:\tadd     r3,r3,r31\n10:\tmtlr    r0\n14:\tblr\n';
    expect(dis('ur', routine)).toBe(uninit('ur'));
    // Saved nowhere, or saved only after the function wrote it (a spill): no compiler homed a local
    // there, and no caller passes an argument in r31 either, so the read refuses.
    const unsaved = /it reads callee-saved r31 before writing it and never saved it/;
    expect(() => dis('un', '0:\tadd     r3,r3,r31\n4:\tblr\n')).toThrow(unsaved);
    expect(() =>
      dis('uw', '0:\tadd     r3,r3,r31\n4:\tmr      r31,r3\n8:\tstw     r31,12(r1)\nc:\tlwz     r3,12(r1)\n10:\tblr\n'),
    ).toThrow(unsaved);
    // Saved only after the function READ it: a value handed over, which the save preserves. Counting
    // that save would mint `uninit_r31` for the read before it.
    expect(() =>
      dis(
        'ur1',
        '0:\tstwu    r1,-16(r1)\n4:\tadd     r3,r3,r31\n8:\tstw     r31,12(r1)\nc:\tlwz     r31,12(r1)\n' +
          '10:\taddi    r1,r1,16\n14:\tblr\n',
      ),
    ).toThrow(unsaved);
    // r14..r28 are where 2.4.2 and 2.4.7 declare a global register variable (`register int g
    // __asm__("r14"); return g;` is `mr r3,r14`), so an unsaved one is that global; 2.3.3 has no
    // such declaration
    expect(dis('ug', '0:\tadd     r3,r3,r14\n4:\tblr\n')).toBe('s32 ug(s32 a0) {\n    return a0 + greg_r14;\n}\n');
    expect(() => decompile('ug', '0 <ug>:\n0:\tadd     r3,r3,r14\n4:\tblr\n', PPC_MWCC_233)).toThrow(
      /it reads callee-saved r14 before writing it and never saved it/,
    );
  });
  // mwcc 2.3.3 homes `uninitfirst(s32 k, s32 *p)`'s locals in r5..r10, which no caller of a
  // two-parameter function fills; without its own declaration each read is a made-up parameter
  // (a0..a7). A float takes no general word on this ABI (`fpu.slots: 'separate'`).
  test('an argument register past the own declaration is an uninitialised local (ownArgumentWords)', () => {
    const body = '0 <f>:\n0:\tadd     r3,r3,r5\n4:\tblr\n';
    const lifted = (f: object) => decompile('f', body, PPC_MWCC, { prototypes: { f } }).source;
    const local = 's32 f(s32 a0) {\n    s32 uninit_r5;\n    return a0 + uninit_r5;\n}\n';
    const param = 's32 f(s32 a0, s32 a1, s32 a2) {\n    return a0 + a2;\n}\n';
    expect(lifted({ params: ['s32', 's32'], returns: 's32' })).toBe(local);
    expect(lifted({ params: ['s32', 'float', 's32 *'], returns: 's32' })).toBe(local);
    expect(lifted({ params: ['s32', 's32', 's32'], returns: 's32' })).toBe(param);
    // a list whose return is not shown to be a scalar may follow a struct's hidden pointer, in r3;
    // a bare count bounds nothing: `{params: 2}` may be `(s32, s64)`, r3 and r5:r6
    expect(lifted({ params: ['s32', 's32'] })).toBe(param);
    expect(lifted({ params: 2, returns: 's32' })).toBe(param);
    // a 64-bit value starts at an even word: `(s32, s64)` fills r3 and r5:r6 (measured, 2.4.2/2.3.3),
    // so r5 stays a parameter, which the split-pair refusal then names (raise/pairparams.ts)
    expect(() => lifted({ params: ['s32', 'long long'], returns: 's32' })).toThrow(
      /reads the two halves of a 64-bit value/,
    );
    expect(lifted({ variadicParams: ['s32'], returns: 's32' })).toBe(param);
  });
  // The declaration context's OWN entry bounds the same registers SOFTLY (pipeline.ts
  // `liftWithinContextBound`). mwcc 2.4.2's `int oc_ph(short a, int b){ if (gX) k4(a, b, 2, 0);
  // while (zq(a) != 5) sl(); return gX; }`: r5/r6 reach only the guessed calls `zq` and `sl`.
  test("the context's own entry drops a register past it nothing reads, and keeps one it reads", () => {
    const OC_PH =
      '00000000 <oc_ph>:\n0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\nc:\tstw     r31,12(r1)\n' +
      '10:\tmr      r31,r3\n14:\tlwz     r0,0(0)\n\t\t\t14: R_PPC_EMB_SDA21\tgX\n18:\tcmpwi   r0,0\n' +
      '1c:\tbeq-    54 <oc_ph+0x54>\n20:\textsh   r3,r31\n24:\tli      r5,2\n28:\tli      r6,0\n' +
      '2c:\tbl      2c <oc_ph+0x2c>\n\t\t\t2c: R_PPC_REL24\tk4\n30:\tb       54 <oc_ph+0x54>\n34:\tb       3c <oc_ph+0x3c>\n' +
      '38:\tbl      38 <oc_ph+0x38>\n\t\t\t38: R_PPC_REL24\tsl\n3c:\tmr      r3,r31\n40:\tbl      40 <oc_ph+0x40>\n' +
      '\t\t\t40: R_PPC_REL24\tzq\n44:\tcmpwi   r3,5\n48:\tbne+    38 <oc_ph+0x38>\n4c:\tlwz     r3,0(0)\n' +
      '\t\t\t4c: R_PPC_EMB_SDA21\tgX\n50:\tb       5c <oc_ph+0x5c>\n54:\textsh   r31,r31\n58:\tb       3c <oc_ph+0x3c>\n' +
      '5c:\tlwz     r0,20(r1)\n60:\tlwz     r31,12(r1)\n64:\tmtlr    r0\n68:\taddi    r1,r1,16\n6c:\tblr\n';
    const k4 = { k4: { params: ['int', 'int', 'int', 'int'], returnsVoid: true } };
    const own = { params: ['short', 'int'], returns: 'int' };
    expect(decompile('oc_ph', OC_PH, PPC_MWCC, { prototypes: k4 }).source).toMatch(
      /^s32 oc_ph\(s32 a0, s32 a1, s32 a2, s32 a3\) \{/m,
    );
    const r = decompile('oc_ph', OC_PH, PPC_MWCC, { prototypes: k4, ownContextProto: own });
    expect(r.source).toMatch(/^s32 oc_ph\(s32 a0, s32 a1\) \{/m);
    expect(r.source).not.toMatch(/uninit_/);
    expect(r.ownArityNotes).toEqual([]);
    expect(r.source).toBe(decompile('oc_ph', OC_PH, PPC_MWCC, { prototypes: { ...k4, oc_ph: own } }).source);

    const body = '0 <f>:\n0:\tadd     r3,r3,r5\n4:\tblr\n';
    const read = decompile('f', body, PPC_MWCC, { ownContextProto: { params: ['s32', 's32'], returns: 's32' } });
    expect(read.source).toBe('s32 f(s32 a0, s32 a1, s32 a2) {\n    return a0 + a2;\n}\n');
    expect(read.ownArityNotes).toEqual([
      'f: its context declaration `s32 f(s32, s32)` fills 2 argument words, and the body reads r5 past them — ' +
        'kept as a parameter, which the header contradicts',
    ]);
    // a hand-written body handed r31 refuses, declared or not
    const hand = '0 <h>:\n0:\tstw     r7,5612(r31)\n4:\tblr\n';
    expect(() => decompile('h', hand, PPC_MWCC, { ownContextProto: { params: [], returnsVoid: true } })).toThrow(
      /it reads callee-saved r31 before writing it and never saved it/,
    );
  });
  // ac-decomp's ks_nes_core.cpp `asm` entry points: `ksNesInit03__Fv` is `stw r7,5612(r31); blr`,
  // its inputs r7 and r31 set by the emulator core that branches to it. Its C++ type `void ()` is
  // no register interface, and read as one it would turn r7 into `uninit_r7`; and r31 is no argument
  // register, so no C signature hands it over. The body refuses, declared or not.
  test('a body naming an unsaved callee-saved register is not bounded by its declaration', () => {
    const asm = '0 <ksNesInit03__Fv>:\n0:\tstw     r7,5612(r31)\n4:\tblr\n';
    const refused = /it reads callee-saved r31 before writing it and never saved it/;
    expect(() => decompile('ksNesInit03__Fv', asm, PPC_MWCC)).toThrow(refused);
    expect(() =>
      decompile('ksNesInit03__Fv', asm, PPC_MWCC, { prototypes: { ksNesInit03__Fv: { params: 0 } } }),
    ).toThrow(refused);
    // compiled code saves r31 before it touches it, and keeps the bound
    const saved =
      '0 <f>:\n0:\tstw     r31,-4(r1)\n4:\tmr      r31,r5\n8:\tadd     r3,r3,r31\nc:\tlwz     r31,-4(r1)\n10:\tblr\n';
    expect(
      decompile('f', saved, PPC_MWCC, { prototypes: { f: { params: ['s32', 's32'], returns: 's32' } } }).source,
    ).toContain('uninit_r5');
  });
  // `int Foo::pick(int k, int *p){ return base + k + p[1]; }` (-lang=c++): `this` takes r3, which
  // the declared parameters leave out, so p is in r5.
  test('a member function is handed `this` ahead of its declared parameters (ownArgumentWords)', () => {
    const body =
      '0 <pick__3FooFiPi>:\n0:\tlwz     r0,0(r3)\n4:\tlwz     r5,4(r5)\n8:\tadd     r0,r0,r4\nc:\tadd     r3,r0,r5\n10:\tblr\n';
    const pick = { params: ['int', 'int *'], returns: 'int' };
    expect(decompile('pick__3FooFiPi', body, PPC_MWCC, { prototypes: { pick__3FooFiPi: pick } }).source).not.toMatch(
      /uninit/,
    );
    expect(
      decompile('pick__FiPi', body.replace(/pick__3FooFiPi/g, 'pick__FiPi'), PPC_MWCC, {
        prototypes: { pick__FiPi: pick },
      }).source,
    ).toMatch(/uninit_r5/);
  });
  test('a scratch register a leaf reads first is an uninitialised local, with no save (PPC_MWCC.scratchRegs)', () => {
    // mwcc 2.4.2 and 2.3.3 home a leaf's `int x; if (s) x = a*3; return x + a;` in r0, unsaved, and
    // in r11 and r12 when every argument register is live. Each is volatile and passes no argument,
    // so no caller hands a value over there.
    expect(dis('sc', '0:\tadd     r3,r3,r0\n4:\tblr\n')).toBe(
      's32 sc(s32 a0) {\n    s32 uninit_r0;\n    return a0 + uninit_r0;\n}\n',
    );
    // r11 and r12 carry the runtime's hidden inputs (PPC_MWCC.hiddenInputRegs), so their entry
    // value may reach the body only through a join, beside a path that assigned the local — the
    // shape mwcc gives `uninit_r12`. Read directly, it is the input, and the lift refuses.
    for (const r of ['r11', 'r12']) {
      expect(
        dis(
          'sj',
          `0:\tcmpwi   r3,0\n4:\tbeq     c <sj+0xc>\n8:\tmulli   ${r},r4,3\nc:\tadd     r3,${r},r4\n10:\tblr\n`,
        ),
      ).toBe('s32 sj(s32 a0, s32 a1) {\n    s32 v0;\n    if (a0 != 0) v0 = a1 * 3;\n    return v0 + a1;\n}\n');
      expect(() => dis('sc', `0:\tadd     r3,r3,${r}\n4:\tblr\n`)).toThrow(
        new RegExp(`${r} is read before anything writes it, and no join meets it with a definition of its own`),
      );
    }
    // The runtime's own `_savegpr_31` stores through its frame address, r11; `__ptmf_scall` loads
    // through r12 before overwriting it. Neither is an uninitialised local.
    expect(() => dis('_savegpr_31', '0:\tstw     r31,-4(r11)\n4:\tblr\n')).toThrow(
      /r11 is read before anything writes it/,
    );
    expect(() => dis('ps', '0:\tlwz     r0,0(r12)\n4:\tlwz     r12,8(r12)\n8:\tadd     r3,r0,r12\nc:\tblr\n')).toThrow(
      /r12 is read before anything writes it/,
    );
    const hiddenOutside = { ...PPC_MWCC, hiddenInputRegs: ['r13'] };
    expect(() => decompile('sh', '0 <sh>:\n0:\tadd     r3,r3,r0\n4:\tblr\n', hiddenOutside)).toThrow(
      /hidden-input register r13 is not among the scratch registers/,
    );
    // A target stating no scratch registers claims r0 is preserved and refuses the read, one
    // stating no partition at all keeps the parameter, and one that lists a scratch register outside
    // its non-argument registers is a target bug, refused before any lift.
    const none = { ...PPC_MWCC, scratchRegs: undefined, hiddenInputRegs: undefined };
    expect(() => decompile('sn', '0 <sn>:\n0:\tadd     r3,r3,r0\n4:\tblr\n', none)).toThrow(
      /it reads callee-saved r0 before writing it/,
    );
    const noPartition = { ...none, nonArgRegs: undefined };
    expect(decompile('sn', '0 <sn>:\n0:\tadd     r3,r3,r0\n4:\tblr\n', noPartition).source).toBe(
      's32 sn(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
    );
    const bad = { ...PPC_MWCC, scratchRegs: ['r3'] };
    expect(() => decompile('sb', '0 <sb>:\n0:\tadd     r3,r3,r0\n4:\tblr\n', bad)).toThrow(
      /scratch register r3 is not among the non-argument registers/,
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
  test('an argument stored to its home is not set up for the call before its reload', () => {
    // mwcc 2.3.3 -O0, `int q1(int a) { e0(); return a; }`. Counted as setup, the store would make it
    // `e0(a0)`.
    const asm =
      pro(16) +
      'c:\tstw     r3,8(r1)\n10:\tbl      10 <q1+0x10>\n\t\t\t10: R_PPC_REL24\te0\n14:\tlwz     r3,8(r1)\n' +
      epi(0x18, 16);
    expect(dis('q1', asm)).toBe('s32 q1(s32 a0) {\n    e0();\n    return a0;\n}\n');
  });
  test('an argument saved to two slots is saved twice, not spilled, and either reload is the argument', () => {
    const asm =
      '0:\tstw     r3,8(r1)\n4:\tstw     r3,12(r1)\n8:\tli      r3,0\nc:\tlwz     r3,12(r1)\n10:\tlwz     r3,8(r1)\n14:\tblr\n';
    expect(dis('twice', asm)).toBe('s32 twice(s32 a0) {\n    return a0;\n}\n');
  });
  test('a value stored to the frame and never read back refuses', () => {
    // The class phrase leads, because the benchmark publishes a reason cut at 200 characters and a
    // long C++ name alone can push a later phrase past the cut (apps/web declines.ts).
    // With a call after it: in a function that makes none it is a dead local (ppc-frame-objects.test.ts).
    const asm =
      pro(16) +
      'c:\taddi    r0,r3,1\n10:\tstw     r0,8(r1)\n14:\tbl      14 <livespill+0x14>\n\t\t\t14: R_PPC_REL24\te0\n' +
      epi(0x18, 16);
    expect(() => dis('livespill', asm)).toThrow(
      /^cannot lift 'livespill': local stack frames not supported — '8\(r1\)' is stored at 0x10 and never read back/,
    );
  });
  test('…save one above a frame word the function loads, which is a dead local', () => {
    // `bigdead` at mwcc_242_81 -O4,p, cut to one spill: `12(r1)` is stored and never read back, and
    // `8(r1)` is loaded before the call. mwcc loads no word of its parameter area
    // (`compilerBehaviors.outgoingAreaNeverLoadedFrom`), so 8 and every word above it is a local.
    const dead = (load: string) =>
      pro(16) +
      'c:\tstw     r3,8(r1)\n10:\taddi    r0,r3,1\n14:\tstw     r0,12(r1)\n' +
      `18:\t${load}\n1c:\tbl      1c <deadspill+0x1c>\n\t\t\t1c: R_PPC_REL24\te1\n` +
      epi(0x20, 16);
    const e1 = { prototypes: { e1: { params: 1 } } };
    expect(decompile('deadspill', `0 <deadspill>:\n${dead('lwz     r3,8(r1)')}`, PPC_MWCC, e1).source).toBe(
      's32 deadspill(s32 a0) {\n    return e1(a0);\n}\n',
    );
    // …but not one BENEATH the lowest word loaded: a call's stack argument would sit there
    const below = dead('lwz     r3,8(r1)')
      .replace('stw     r3,8(r1)', 'stw     r3,12(r1)')
      .replace('stw     r0,12(r1)', 'stw     r0,8(r1)');
    expect(() =>
      decompile('deadspill', `0 <deadspill>:\n${below.replace('lwz     r3,8(r1)', 'lwz     r3,12(r1)')}`, PPC_MWCC, e1),
    ).toThrow(/'8\(r1\)' is stored at 0x\w+ and never read back/);
  });
  // mwcc 2.3.3 -O4, `int s9(int a) { return g9(1, 2, 3, 4, 5, 6, 7, 8, a); }`: `stw r3,8(r1)` is the
  // ninth argument, in g9's parameter area 8 bytes above the pushed r1. `tail` follows the eight
  // `li`s; `head` goes between the store and them.
  const s9 = (sym: string, head: string, tail: (at: number) => string) => {
    let asm = pro(24) + 'c:\tstw     r3,8(r1)\n' + head;
    let at = 0x10 + 4 * head.split('\n').filter(Boolean).length;
    for (let k = 1; k <= 8; k++, at += 4) {
      asm += `${at.toString(16)}:\tli      r${k + 2},${k}\n`;
    }
    const bl = at.toString(16);
    return asm + `${bl}:\tbl      ${bl} <${sym}+0x${bl}>\n\t\t\t${bl}: R_PPC_REL24\tg9\n` + tail(at + 4);
  };
  test('a store in the parameter area of a call that fills every argument register refuses, read back or not', () => {
    const ninth =
      /^cannot lift '\w+': outgoing stack arguments not modelled — the undeclared call to 'g9' at 0x\w+ fills 8 argument registers/;
    expect(() =>
      dis(
        's9',
        s9('s9', '', (at) => epi(at, 24)),
      ),
    ).toThrow(ninth);
    // Reading the word back, after the call or before it, does not make it any less the ninth
    // argument on a compiler that may load its outgoing area…
    const after = s9('s9a', '', (at) => `${at.toString(16)}:\tlwz     r3,8(r1)\n` + epi(at + 4, 24));
    expect(() => disUnclaimed('s9a', after)).toThrow(ninth);
    const before = s9(
      's9b',
      '10:\tstw     r31,20(r1)\n14:\tlwz     r31,8(r1)\n',
      (at) => `${at.toString(16)}:\tmr      r3,r31\n${(at + 4).toString(16)}:\tlwz     r31,20(r1)\n` + epi(at + 8, 24),
    );
    expect(() => disUnclaimed('s9b', before)).toThrow(ninth);
    // …but mwcc loads no word of its parameter area (`compilerBehaviors.outgoingAreaNeverLoadedFrom`),
    // so a word it loads there is a local's and the call takes no stack word. Both read-backs are
    // hand-written: compiled, `int s9b(int a) { int r = g9(1, …, 8, a); return r + a; }` keeps `a` in
    // a saved register on all three builds — the premise's residue, as on agbcc.
    expect(dis('s9a', after)).toBe('s32 s9a(s32 a0) {\n    g9(1, 2, 3, 4, 5, 6, 7, 8);\n    return a0;\n}\n');
    expect(dis('s9b', before)).toBe('s32 s9b(s32 a0) {\n    g9(1, 2, 3, 4, 5, 6, 7, 8);\n    return a0;\n}\n');
    // A load beneath the parameter area does not count: 4(r1) is the callee's link-register word,
    // so a slot kept there does not make the ninth argument's word a local.
    const low = s9(
      's9c',
      '10:\tstw     r4,4(r1)\n',
      (at) => `${at.toString(16)}:\tlwz     r3,4(r1)\n` + epi(at + 4, 24),
    );
    expect(() => dis('s9c', low)).toThrow(ninth);
    // A declaration says where the list ends: eight parameters, and the word is a local.
    expect(
      decompile('s9a', `0 <s9a>:\n${after}`, PPC_MWCC, { prototypes: { g9: { params: Array(8).fill('int') } } }).source,
    ).toBe('s32 s9a(s32 a0) {\n    g9(1, 2, 3, 4, 5, 6, 7, 8);\n    return a0;\n}\n');
    // Nine parameters are more than the argument registers carry, and refuse by name.
    expect(() =>
      decompile('s9', `0 <s9>:\n${s9('s9', '', (at) => epi(at, 24))}`, PPC_MWCC, {
        prototypes: { g9: { params: Array(9).fill('int') } },
      }),
    ).toThrow(
      "outgoing stack arguments not modelled — 'g9' is declared with 9 parameters and the argument registers carry 8",
    );
  });
  test('a 64-bit argument after seven words is in the parameter area of a call that fills seven', () => {
    // mwcc 2.3.3 -O4,p, `int ll1(long long x) { return g7l(1, 2, 3, 4, 5, 6, 7, x); }`: the pair skips
    // r10 and goes to 8(r1)/12(r1). Reading it back after the call must not make it a local.
    const asm =
      '0:\tmflr    r0\n4:\tli      r5,3\n8:\tstw     r0,4(r1)\nc:\tli      r6,4\n10:\tli      r7,5\n' +
      '14:\tstwu    r1,-24(r1)\n18:\tli      r8,6\n1c:\tli      r9,7\n20:\tstw     r4,12(r1)\n24:\tli      r4,2\n' +
      '28:\tstw     r3,8(r1)\n2c:\tli      r3,1\n30:\tbl      30 <ll1r+0x30>\n\t\t\t30: R_PPC_REL24\tg7l\n' +
      '34:\tlwz     r4,8(r1)\n38:\tlwz     r5,12(r1)\n3c:\tadd     r3,r3,r4\n40:\tadd     r3,r3,r5\n' +
      epi(0x44, 24);
    expect(() => disUnclaimed('ll1r', asm)).toThrow(
      /^cannot lift 'll1r': outgoing stack arguments not modelled — the undeclared call to 'g7l' at 0x30 fills 7 argument registers/,
    );
    // On mwcc a word loaded there is a local's, so the pair is no argument (the reload is
    // hand-written: compiled, `x` is kept in saved registers across the call on all three builds).
    expect(dis('ll1r', asm)).toContain('g7l(1, 2, 3, 4, 5, 6, 7)');
  });
  test('control: a call that leaves an argument register free has no ninth argument to hide', () => {
    let asm = pro(24) + 'c:\tstw     r3,8(r1)\n';
    for (let k = 1; k <= 7; k++) {
      asm += `${(0xc + 4 * k).toString(16)}:\tli      r${k + 2},${k}\n`;
    }
    asm += '2c:\tbl      2c <s7+0x2c>\n\t\t\t2c: R_PPC_REL24\tg7\n30:\tlwz     r3,8(r1)\n' + epi(0x34, 24);
    expect(dis('s7', asm)).toBe('s32 s7(s32 a0) {\n    g7(1, 2, 3, 4, 5, 6, 7);\n    return a0;\n}\n');
  });
  test('the frame push stores the back chain: its word holds the caller r1, not a value stored there before', () => {
    expect(() =>
      dis(
        'bchain',
        '0:\tstw     r3,-16(r1)\n4:\tstwu    r1,-16(r1)\n8:\tlwz     r3,0(r1)\nc:\taddi    r1,r1,16\n10:\tblr\n',
      ),
    ).toThrow(/'-16\(r1\)' at 0x4 is a word this function both saves a register in and stores a value to/);
    expect(() =>
      dis('bchain2', '0:\tstwu    r1,-16(r1)\n4:\tlwz     r3,0(r1)\n8:\taddi    r1,r1,16\nc:\tblr\n'),
    ).toThrow(/reload of '0\(r1\)' into r3, a slot r1 was saved into/);
  });
  test('a return address read as a value refuses, whichever register `mflr` put it in', () => {
    // MP4 `HuMemDirectMalloc` reads it with `asm { mflr retaddr }` and passes it on.
    const used = /the return address the 'mflr' at 0x\w+ copies out is used as a value/;
    expect(() => dis('getpc', '0:\tmflr    r3\n4:\tblr\n')).toThrow(used);
    const passed =
      '0:\tstwu    r1,-16(r1)\n4:\tmflr    r0\n8:\tstw     r0,20(r1)\nc:\tstw     r31,12(r1)\n10:\tmflr    r31\n' +
      '14:\tmr      r3,r31\n18:\tbl      18 <passed+0x18>\n\t\t\t18: R_PPC_REL24\tHuMemMemoryFree\n' +
      '1c:\tlwz     r31,12(r1)\n20:\tlwz     r0,20(r1)\n24:\tmtlr    r0\n28:\taddi    r1,r1,16\n2c:\tblr\n';
    expect(() => dis('passed', passed)).toThrow(used);
  });
  test('the return address is saved only in the link register save word, and only where no other value reaches it', () => {
    const eightArgs = (at: number) =>
      Array.from({ length: 8 }, (_, k) => `${(at + 4 * k).toString(16)}:\tli      r${k + 3},${k + 1}\n`).join('');
    const call = (sym: string, at: number) =>
      `${at.toString(16)}:\tbl      ${at.toString(16)} <${sym}+0x${at.toString(16)}>\n\t\t\t${at.toString(16)}: R_PPC_REL24\tg9\n`;
    // mwcc 2.3.3 -O4,p, `register unsigned ra; asm { mflr ra } return g9(1, 2, 3, 4, 5, 6, 7, 8, ra);`:
    // the copy stored 8 bytes above the pushed r1 is g9's ninth argument, not a second LR save.
    const ninth =
      pro(16) + 'c:\tmflr    r0\n10:\tstw     r0,8(r1)\n' + eightArgs(0x14) + call('ra9', 0x34) + epi(0x38, 16);
    expect(() => dis('ra9', ninth)).toThrow(
      /the store to '8\(r1\)' at 0x10 is not the link register's save — the return address an 'mflr' copies out lands -8 bytes/,
    );
    // mwcc 2.3.3 -O2, `register unsigned ra = a; if (c) { asm { mflr ra } } return g9(1, …, 8, ra);`:
    // on the fall-through path r3 still holds the argument, and the word is the ninth argument either way.
    const onePath =
      pro(24) +
      'c:\tcmpwi   r4,0\n10:\tbeq-    18 <rap+0x18>\n14:\tmflr    r3\n18:\tstw     r3,8(r1)\n' +
      eightArgs(0x1c) +
      call('rap', 0x3c) +
      epi(0x40, 24);
    expect(() => dis('rap', onePath)).toThrow(
      /the store to '8\(r1\)' at 0x18 is not the link register's save — the return address an 'mflr' copies out lands -16 bytes/,
    );
    // Into the save word itself, a register the return address reaches on one path and another value
    // on the other is no save: the restore would hand that value to `blr`.
    const mixed =
      '0:\tli      r0,0\n4:\tcmpwi   r3,0\n8:\tbeq-    10 <mixed+0x10>\nc:\tmflr    r0\n10:\tstw     r0,4(r1)\n' +
      '14:\tstwu    r1,-8(r1)\n18:\tbl      18 <mixed+0x18>\n\t\t\t18: R_PPC_REL24\tf\n' +
      epi(0x1c, 8);
    expect(() => dis('mixed', mixed)).toThrow(
      /the store to '4\(r1\)' at 0x10 is not the link register's save — r0 holds the return address an 'mflr' copies out on some paths and another value on others/,
    );
  });
  test('control: the return address saved after a join is still the save', () => {
    const joined =
      '0:\tmflr    r0\n4:\tcmpwi   r3,0\n8:\tbeq-    10 <joined+0x10>\nc:\taddi    r3,r3,1\n10:\tstw     r0,4(r1)\n' +
      '14:\tstwu    r1,-8(r1)\n18:\tbl      18 <joined+0x18>\n\t\t\t18: R_PPC_REL24\tf\n' +
      epi(0x1c, 8);
    expect(dis('joined', joined)).toBe('s32 joined(s32 a0) {\n    if (a0 != 0) a0 = a0 + 1;\n    return f(a0);\n}\n');
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
    // nothing saved.
    const asm =
      '0:\tmflr    r0\n4:\tstw     r0,4(r1)\n8:\tstwu    r1,-16(r1)\nc:\tlwz     r0,4(r1)\n' +
      '10:\taddi    r1,r1,16\n14:\tmtlr    r0\n18:\tblr\n';
    expect(() => dis('twowords', asm)).toThrow(/reload of a stack local \('4\(r1\)'\)/);
  });
  test('a local nobody saved refuses, and an argument the caller passed on the stack is a parameter', () => {
    expect(() =>
      dis('unsaved', '0:\tstwu    r1,-16(r1)\n4:\tlwz     r3,8(r1)\n8:\taddi    r1,r1,16\nc:\tblr\n'),
    ).toThrow(/reload of a stack local \('8\(r1\)'\)/);
    expect(dis('stkarg', '0:\tstwu    r1,-16(r1)\n4:\tlwz     r3,24(r1)\n8:\taddi    r1,r1,16\nc:\tblr\n')).toContain(
      'return a8;',
    );
  });
  test('an argument stored before the push is read back after it from the same word', () => {
    const asm =
      '0:\tstw     r3,8(r1)\n4:\tstwu    r1,-16(r1)\n8:\tlwz     r4,24(r1)\nc:\tmr      r3,r4\n' +
      '10:\taddi    r1,r1,16\n14:\tblr\n';
    expect(dis('spillback', asm)).toBe('s32 spillback(s32 a0) {\n    return a0;\n}\n');
  });
  test('where r1 is not at a known depth, a frame access refuses instead of naming a slot', () => {
    expect(() =>
      dis('twopush', '0:\tstwu    r1,-16(r1)\n4:\tstwu    r1,-16(r1)\n8:\taddi    r1,r1,32\nc:\tblr\n'),
    ).toThrow(/at 0x4 is not the one frame push from the entry stack pointer — r1 had already moved \(-16\)/);
    expect(() => dis('notchain', '0:\tstwu    r31,-16(r1)\n4:\taddi    r1,r1,16\n8:\tblr\n')).toThrow(
      /it stores r31, not the back chain/,
    );
    // the write itself refuses, before the frame access after it is reached
    expect(() =>
      dis(
        'mrr1',
        '0:\tstw     r31,-4(r1)\n4:\tstwu    r1,-16(r1)\n8:\tmr      r1,r11\nc:\tlwz     r31,-4(r1)\n10:\tblr\n',
      ),
    ).toThrow(/'mr r1,r11' at 0x8 writes the stack pointer r1/);
    // Two paths meet at 0x10, one through the push and one around it.
    const depths =
      '0:\tstw     r31,-4(r1)\n4:\tcmpwi   r3,0\n8:\tbeq-    10 <depths+0x10>\nc:\tstwu    r1,-16(r1)\n' +
      '10:\tlwz     r31,-4(r1)\n14:\tblr\n';
    expect(() => dis('depths', depths)).toThrow(/arrive with r1 at two depths \(0 and -16 bytes/);
  });
  // mwcc 2.3.3 moves a register with `addi rD,rS,0` where 2.4.x prints `mr`.
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
      ['jtbl', { section: '.data', value: 0, size: 16, index: 1 }],
      ['swt', { section: '.text', value: 0, size: 0x48, index: 2 }],
    ]),
    symbolCount: 2,
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
      ['jtbl', { section: '.data', value: 0, size: 16, index: 1 }],
      ['swf', { section: '.text', value: 0, size: 0x48, index: 2 }],
    ]),
    symbolCount: 2,
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
  // The high half in another register, so the pair reaches the guard rather than the refusal of
  // `lis r1` itself (`write`).
  const pair =
    '0:\tlis     r3,0\n\t\t\t2: R_PPC_ADDR16_HA gFrame\n' +
    '4:\taddi    r1,r3,0\n\t\t\t6: R_PPC_ADDR16_LO gFrame\n8:\tblr\n';
  expect(() => dis('fradjpair', pair)).toThrow(
    /'addi' at 0x4 carries a relocation \('gFrame'\) on a stack-pointer adjust/,
  );
  const pairR1 =
    '0:\tlis     r1,0\n\t\t\t2: R_PPC_ADDR16_HA gFrame\n' +
    '4:\taddi    r1,r1,0\n\t\t\t6: R_PPC_ADDR16_LO gFrame\n8:\tblr\n';
  expect(() => dis('fradjpairr1', pairR1)).toThrow(/'lis r1,0' at 0x0 writes the stack pointer r1/);
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

// A `bl` asks its callee's declaration the questions every frontend asks (frontend/call-plan.ts):
// the project's prototype, then the compiler's runtime table, then the signatures the C standard
// fixes.
describe('a PowerPC call reads the shared call declarations', () => {
  // r3..r6 all hold a value at the call
  const callTo = (callee: string) =>
    framed(
      '0 <c>:\n0:\tli      r3,1\n4:\tli      r4,2\n8:\tli      r5,3\nc:\tli      r6,4\n' +
        `10:\tbl      14 <c+0x14>\n\t\t\t10: R_PPC_REL24\t${callee}\n14:\tblr\n`,
    );

  test('an undeclared `memcpy` takes the three parameters the C standard fixes', () => {
    expect(decompile('c', callTo('memcpy'), PPC_MWCC).source).toBe('s32 c(void) {\n    return memcpy(1, 2, 3);\n}\n');
  });

  test('a 64-bit return a project declares on a runtime helper name declines at raise, naming the helper', () => {
    const prototypes = { __div2i: { params: ['s32', 's32'], returns: 'long long' } };
    expect(() => decompile('c', callTo('__div2i'), PPC_MWCC, { prototypes })).toThrow(
      /no model for the runtime helper '__div2i'/,
    );
  });

  test('a 64-bit runtime helper the project leaves undeclared lowers at the guessed arity', () => {
    const calls = lift('c', callTo('__div2i'), PPC_MWCC)
      .blocks.flatMap((b) => b.ops)
      .filter((op) => op.opcode === 'call');
    expect(calls.map((op) => [op.attrs.target, op.operands.length])).toEqual([['__div2i', 4]]);
    expect(() => decompile('c', callTo('__div2i'), PPC_MWCC)).toThrow(/no model for the runtime helper '__div2i'/);
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

// mwcc_242_81 at canonical flags, compiled: `int r1(int a) { return a; }` is a bare `blr` — no path
// writes r3, so nothing in the body says the function returns a word. A stated `int` return says
// it: the bare return hands back r3's entry value, the argument. A context's own entry is not read
// for it, and with nothing declared it stays the `void` function the body shows.
describe('a bare return under a stated word return', () => {
  const r1 = '00000000 <r1>:\n0:\tblr\n';
  test('hands back the argument r3 holds', () => {
    const prototypes = { r1: { params: ['int'], returns: 'int' } };
    expect(decompile('r1', r1, PPC_MWCC, { prototypes }).source).toMatch(/s32 r1\(s32 a0\) \{\n\s+return a0;\n\}/);
  });

  test('stays bare with nothing stated, a context entry, a void return or no argument', () => {
    expect(decompile('r1', r1, PPC_MWCC, {}).source).toMatch(/void r1\(void\)/);
    expect(decompile('r1', r1, PPC_MWCC, { ownContextProto: { params: ['int'], returns: 'int' } }).source).toMatch(
      /void r1\(void\)/,
    );
    for (const r of [
      { params: ['int'], returnsVoid: true },
      { params: [], returns: 'int' },
    ]) {
      expect(decompile('r1', r1, PPC_MWCC, { prototypes: { r1: r } }).source).toMatch(/void r1\(void\) \{\n\s+return;/);
    }
  });
});

// WHAT AN ELIDED mwcc DISPATCH LEAVES IN ITS REGISTERS. The `lis; slwi; addi; lwzx; mtctr; bctr` block
// is pruned, so each case target is entered with what it wrote (jump-table.ts `enterCaseTarget`).
// mwcc 2.4.2 at -O4,p scales the index IN PLACE and reuses it in a case: `case 3: return i * 4;` is
// a bare `blr` with r3 = i << 2, and `p[i] = 7` is `stwx r0,r4,r5` with r5 the dispatch's own `slwi`.
// The table base and the code address are no value C spells, and a case reading either declines.
describe('an elided mwcc dispatch writes its registers at each case target', () => {
  const asmData: AsmData = {
    sections: new Map([['.data', new Uint8Array(16)]]),
    relocs: [0x20, 0x28, 0x30, 0x38].map((off, i) => ({
      section: '.data',
      offset: i * 4,
      type: 'R_PPC_ADDR32',
      sym: 'swi',
      addend: off,
    })),
    symbols: new Map([
      ['jtbl', { section: '.data', value: 0, size: 16, index: 1 }],
      ['swi', { section: '.text', value: 0, size: 0x48, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  };
  const asm = (c0: string) =>
    [
      '00000000 <swi>:',
      '   0:\tcmplwi  r3,3',
      '   4:\tbgt     40 <swi+0x40>',
      '   8:\tlis     r4,0',
      '\t\t\t8: R_PPC_ADDR16_HA jtbl',
      '   c:\tslwi    r3,r3,2',
      '  10:\taddi    r4,r4,0',
      '\t\t\t10: R_PPC_ADDR16_LO jtbl',
      '  14:\tlwzx    r0,r4,r3',
      '  18:\tmtctr   r0',
      '  1c:\tbctr',
      `  20:\t${c0}`,
      '  24:\tblr',
      '  28:\tli      r3,20',
      '  2c:\tblr',
      '  30:\tli      r3,30',
      '  34:\tblr',
      '  38:\tli      r3,40',
      '  3c:\tblr',
      '  40:\tli      r3,-1',
      '  44:\tblr',
    ].join('\n');
  const lift = (c0: string) => decompile('swi', asm(c0), PPC_MWCC, { asmData }).source;

  test('the scaled index is the scrutinee shifted by two', () => {
    expect(lift('addi    r3,r3,1')).toMatch(/case 0:\s*\n\s*return \(a0 << 2\) \+ 1;/);
  });

  test('the table base and the code address decline', () => {
    const stale = /a case of the elided jump table reads (r4|r0), which the unlifted dispatch idiom wrote/;
    expect(() => lift('mr      r3,r4')).toThrow(stale);
    expect(() => lift('mr      r3,r0')).toThrow(stale);
    // the refusal the shared model makes is this frontend's own (frontend/errors.ts `FrontendRefusal`)
    expect(() => lift('mr      r3,r4')).toThrow(PpcUnsupportedError);
  });

  test('…but not on the default path, which never ran the idiom', () => {
    const def = asm('li      r3,10').replace('  40:\tli      r3,-1', '  40:\tmr      r3,r4');
    expect(decompile('swi', def, PPC_MWCC, { asmData }).source).toMatch(/default:\s*\n\s*return a1;/);
  });
});

// AN UNDECLARED CALL IN A CASE OF AN ELIDED mwcc DISPATCH, as mwcc 2.4.2 -O4,p lays it out: the
// dispatch's `addi r3,r5,0` leaves the table base in r3, and its `slwi` the scaled index in r0 or r4.
describe('a guessed arity in a case of an elided mwcc dispatch', () => {
  const asmData = (cases: number[]): AsmData => ({
    sections: new Map([['.data', new Uint8Array(16)]]),
    relocs: cases.map((off, i) => ({ section: '.data', offset: i * 4, type: 'R_PPC_ADDR32', sym: 'swc', addend: off })),
    symbols: new Map([
      ['jtbl', { section: '.data', value: 0, size: 16, index: 1 }],
      ['swc', { section: '.text', value: 0, size: 0x5c, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  });
  // the cases fill 0x2c up to the epilogue at 0x48
  const asm = (index: string, cases: string[]) =>
    [
      '00000000 <swc>:',
      '   0:\tstwu    r1,-16(r1)',
      '   4:\tmflr    r0',
      '   8:\tcmplwi  r3,3',
      '   c:\tstw     r0,20(r1)',
      '  10:\tbgt-    48 <swc+0x48>',
      '  14:\tlis     r5,0',
      '\t\t\t16: R_PPC_ADDR16_HA\tjtbl',
      `  18:\tslwi    ${index},r3,2`,
      '  1c:\taddi    r3,r5,0',
      '\t\t\t1e: R_PPC_ADDR16_LO\tjtbl',
      `  20:\tlwzx    r0,r3,${index}`,
      '  24:\tmtctr   r0',
      '  28:\tbctr',
      ...cases,
      '  48:\tlwz     r0,20(r1)',
      '  4c:\tmtlr    r0',
      '  50:\taddi    r1,r1,16',
      '  54:\tmr      r3,r4',
      '  58:\tblr',
    ].join('\n');
  const callG = (at: string) => [`  ${at}:\tbl      ${at} <swc+0x${at}>`, `\t\t\t${at}: R_PPC_REL24\tg`];
  const toEnd = (at: string) => `  ${at}:\tb       48 <swc+0x48>`;

  // `int swc(int i, int a) { switch (i) { case 0: a = g(); break; case 1: a += 3; break; case 2:
  // a = 7; break; } return a; }`: at the call r3 holds the table base and r4 still holds `a`. The
  // base is no argument, so none above it is.
  test('the table base the dispatch left in r3 is no argument, and none past it is', () => {
    const cases = ['  2c:\taddi    r4,r4,3', toEnd('30'), ...callG('34'), '  38:\tmr      r4,r3', toEnd('3c')];
    const body = [...cases, '  40:\tli      r4,7', toEnd('44')];
    const out = decompile('swc', asm('r0', body), PPC_MWCC, { asmData: asmData([0x34, 0x2c, 0x40, 0x48]) }).source;
    expect(out).toMatch(/case 0:\s*\n\s*a1 = g\(\);/);
  });

  // `void swc(int i) { switch (i) { case 0: g(1); break; case 1: g(2); break; } }` leaves the
  // dispatch's `slwi r4,r3,2` in r4 at `li r3,1; bl g`, and `g(1)` and `g(1, i * 4)` compile to these
  // bytes alike.
  test('a guess that would count the scaled index the dispatch left in r4 DECLINES', () => {
    const body = [
      '  2c:\tli      r3,1',
      ...callG('30'),
      toEnd('34'),
      '  38:\tli      r3,2',
      ...callG('3c'),
      toEnd('40'),
    ];
    expect(() =>
      decompile('swc', asm('r4', [...body, '  44:\tnop']), PPC_MWCC, {
        asmData: asmData([0x2c, 0x38, 0x44, 0x48]),
        prototypes: { swc: { returnsVoid: true } },
      }),
    ).toThrow(/r4, which the arity guessed without one counts, still holds the index the jump table's dispatch scaled/);
  });
});

// A SCALED INDEX AT A TARGET OTHER EDGES ENTER TOO. mwcc 2.4.2 -O4,p keeps the dispatch's `slwi` live
// into a case another case falls into (`case 2: ...; case 3: ... p[i] ...`, r31) and into a case
// whose body is a do-while, re-entered by its back edge (`lwzx r0,r4,r3`). Every path into such a
// target brings `i << 2` in that register, so it is the scaled index there too. A path that brings
// anything else in it declines: the default's, a case that rewrote it, a loop that advanced it.
describe('the scaled index at a case target other edges also enter', () => {
  const asmData = (cases: number[]): AsmData => ({
    sections: new Map([['.data', new Uint8Array(16)]]),
    relocs: cases.map((off, i) => ({ section: '.data', offset: i * 4, type: 'R_PPC_ADDR32', sym: 'swm', addend: off })),
    symbols: new Map([
      ['jtbl', { section: '.data', value: 0, size: 16, index: 1 }],
      ['swm', { section: '.text', value: 0, size: 0x48, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  });
  const asm = (deflt: string, body: string[]) =>
    [
      '00000000 <swm>:',
      '   0:\tcmplwi  r3,3',
      `   4:\tbgt     ${deflt} <swm+0x${deflt}>`,
      '   8:\tlis     r4,0',
      '\t\t\t8: R_PPC_ADDR16_HA jtbl',
      '   c:\tslwi    r5,r3,2',
      '  10:\taddi    r4,r4,0',
      '\t\t\t10: R_PPC_ADDR16_LO jtbl',
      '  14:\tlwzx    r0,r4,r5',
      '  18:\tmtctr   r0',
      '  1c:\tbctr',
      ...body,
    ].join('\n');
  const rest = [
    '  30:\tli      r3,30',
    '  34:\tblr',
    '  38:\tli      r3,40',
    '  3c:\tblr',
    '  40:\tli      r3,-1',
    '  44:\tblr',
  ];
  // case 0 falls into case 1, which returns `p[i]` with r5 the dispatch's `slwi r5,r3,2`
  const fall = (c0: string) =>
    asm('40', [`  20:\tli      r7,1`, `  24:\t${c0}`, '  28:\tlwzx    r3,r6,r5', '  2c:\tblr', ...rest]);
  const lift = (a: string, cases = [0x20, 0x28, 0x30, 0x38]) =>
    decompile('swm', a, PPC_MWCC, { asmData: asmData(cases) }).source;
  const stale = /a case of the elided jump table reads r5, which the unlifted dispatch idiom wrote/;

  test('a case fallen into reads the scaled index the falling case kept', () => {
    expect(lift(fall('stw     r7,0(r6)'))).toMatch(/case 0:\s*\n\s*\*a3 = 1;\s*\n\s*case 1:\s*\n\s*return a3\[a0\];/);
  });

  test('…and the shift is of the scrutinee the switch read, not the one the falling case left', () => {
    const out = lift(
      asm('40', [
        '  20:\taddi    r3,r3,1',
        '  24:\tstw     r3,0(r6)',
        '  28:\tlwzx    r3,r6,r5',
        '  2c:\tblr',
        ...rest,
      ]),
    );
    expect(out).toMatch(/\*a3 = a0 \+ 1;\s*\n\s*case 1:\s*\n\s*return a3\[a0\];/);
  });

  test('a do-while case re-entered by its back edge reads it on every iteration', () => {
    const loop = [
      '  28:\tlwzx    r3,r6,r5',
      '  2c:\taddi    r6,r6,4',
      '  30:\tcmpwi   r3,0',
      '  34:\tbne     28 <swm+0x28>',
    ];
    const out = lift(
      asm('40', ['  20:\tli      r3,1', '  24:\tblr', ...loop, '  38:\tblr', '  3c:\tli      r3,7', '  40:\tblr']),
      [0x20, 0x28, 0x3c, 0x3c],
    );
    expect(out).toMatch(/do \{\s*\n\s*v0 = v1\[a0\];\s*\n\s*v1 = v1 \+ 1;\s*\n\s*\} while \(v0 != 0\);/);
  });

  test('a path that brings anything else in the register DECLINES', () => {
    // the falling case rewrote it
    expect(() => lift(fall('li      r5,8'))).toThrow(stale);
    // the default enters the target too, and never ran the idiom
    expect(() =>
      lift(
        asm('28', ['  20:\tli      r7,1', '  24:\tstw     r7,0(r6)', '  28:\tlwzx    r3,r6,r5', '  2c:\tblr', ...rest]),
      ),
    ).toThrow(stale);
    // the loop advances it
    const loop = [
      '  28:\tlwzx    r3,r6,r5',
      '  2c:\taddi    r5,r5,4',
      '  30:\tcmpwi   r3,0',
      '  34:\tbne     28 <swm+0x28>',
    ];
    expect(() =>
      lift(
        asm('40', ['  20:\tli      r3,1', '  24:\tblr', ...loop, '  38:\tblr', '  3c:\tli      r3,7', '  40:\tblr']),
        [0x20, 0x28, 0x3c, 0x3c],
      ),
    ).toThrow(stale);
  });
});

// A FUNCTION THAT LIFTS ONLY THROUGH A CASE'S READ OF THE SCALED INDEX DOES NOT TAKE THE #351
// TRAILING PASS-THROUGH. mwcc 2.4.2 -O4,p, `int swp(int a){ switch (a){ case 0: return a * 4; case
// 1: return g(); } return 0; }` with g undeclared: case 0 returns the dispatch's `slwi r0,r3,2`,
// which read as `mflr`'s r0 declined the function before the dispatch's registers were modelled.
// Once it lifts, `bl g` counts r3, which still holds a and its block never wrote: `return g(a0);`,
// the bytes `return g();` compiles to as well.
describe('a guessed arity in a function that reads the scaled index', () => {
  const asmData: AsmData = {
    sections: new Map([['.data', new Uint8Array(8)]]),
    relocs: [0x2c, 0x34].map((off, i) => ({
      section: '.data',
      offset: i * 4,
      type: 'R_PPC_ADDR32',
      sym: 'swp',
      addend: off,
    })),
    symbols: new Map([
      ['jtbl', { section: '.data', value: 0, size: 8, index: 1 }],
      ['swp', { section: '.text', value: 0, size: 0x54, index: 2 }],
    ]),
    symbolCount: 2,
    bigEndian: true,
  };
  const asm = (c1: string) =>
    [
      '00000000 <swp>:',
      '   0:\tstwu    r1,-16(r1)',
      '   4:\tmflr    r0',
      '   8:\tcmplwi  r3,1',
      '   c:\tstw     r0,20(r1)',
      '  10:\tbgt-    40 <swp+0x40>',
      '  14:\tlis     r4,0',
      '\t\t\t16: R_PPC_ADDR16_HA\tjtbl',
      '  18:\tslwi    r0,r3,2',
      '  1c:\taddi    r4,r4,0',
      '\t\t\t1e: R_PPC_ADDR16_LO\tjtbl',
      '  20:\tlwzx    r4,r4,r0',
      '  24:\tmtctr   r4',
      '  28:\tbctr',
      '  2c:\tmr      r3,r0',
      '  30:\tb       44 <swp+0x44>',
      `  34:\t${c1}`,
      '  38:\tbl      38 <swp+0x38>',
      '\t\t\t38: R_PPC_REL24\tg',
      '  3c:\tb       44 <swp+0x44>',
      '  40:\tli      r3,0',
      '  44:\tlwz     r0,20(r1)',
      '  48:\tmtlr    r0',
      '  4c:\taddi    r1,r1,16',
      '  50:\tblr',
    ].join('\n');

  test('a call passing on the incoming r3 DECLINES', () => {
    const lift = () => decompile('swp', asm('nop'), PPC_MWCC, { asmData });
    expect(lift).toThrow(
      /the call at 0x38 has no prototype, and r3, the last register the count takes, holds a value some path since the dispatch did not write/,
    );
    expect(lift).toThrow(PpcUnsupportedError);
  });

  test('…while one that writes what it passes lifts', () => {
    const out = decompile('swp', asm('li      r3,5'), PPC_MWCC, { asmData }).source;
    expect(out).toMatch(/case 0:\s*\n\s*v0 = a0 << 2;/);
    expect(out).toMatch(/case 1:\s*\n\s*v0 = g\(5\);/);
  });

  // `void swq(int a, int i){ switch (i){ case 0: g(a); break; case 1: ... } }`: the table base is
  // parked in r4, and r3 still holds a. Left out below it, a is as likely passed on as not (the
  // bytes `g()` gives too); the pre-dispatch r4 made that a gap refusal before.
  test('a call leaving out an incoming register below the parked base DECLINES', () => {
    const swq = asm('nop')
      .replace('cmplwi  r3,1', 'cmplwi  r4,1')
      .replace('lis     r4,0', 'lis     r5,0')
      .replace('slwi    r0,r3,2', 'slwi    r0,r4,2')
      .replace('addi    r4,r4,0', 'addi    r4,r5,0')
      .replace('  2c:\tmr      r3,r0', '  2c:\tnop');
    expect(() => decompile('swp', swq, PPC_MWCC, { asmData, prototypes: { swp: { returnsVoid: true } } })).toThrow(
      /r3, which the count leaves out below a dispatch.s register, holds its incoming value/,
    );
  });
});
