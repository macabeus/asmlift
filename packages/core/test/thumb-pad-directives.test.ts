// Alignment fill in the Thumb code stream, whichever way a splitter spells it.
//
// The same two bytes of literal-pool padding reach this frontend under three spellings:
//
//   (a) `lsls r0, r0, #0x00`   — the instruction whose encoding IS 0x0000
//   (b) `.2byte 0x0000`        — the same halfword, spelled as data
//   (c) `.align 2, 0`          — the directive that emits it
//
// (a) has always worked: it parses as an instruction, the layout walk gives it 2 bytes, and
// `isPadInstr` + the pruning pass decide padding-versus-real-instruction by REACHABILITY. These
// tests pin that (b) and (c) reach that same decision through the same representation, and that
// none of the loud refusals guarding it were traded away.
//
// Hand-written fixtures, NOT copied from any game.
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { PAD_ENCODINGS, isPadInstr } from '../src/frontend/thumb';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const d = (name: string, asm: string) => decompile(name, asm, ARMV4T_AGBCC);

describe('pad spelling (b): a raw halfword that encodes alignment fill', () => {
  // The corpus shape: an unconditional `b` over a two-byte pad into a labelled literal pool.
  const withPad = (pad: string) => `	thumb_func_start p
p:
	ldr r0, _08000010
	b _end
${pad}
_08000010: .4byte 0x030052A4
_end:
	bx lr
`;

  test('`.2byte 0x0000` is the instruction it encodes — same C as the `lsls` spelling', () => {
    const asInstr = d('p', withPad('	lsls r0, r0, #0x00')).source;
    expect(asInstr).toBe('s32 p(void) {\n    return 50352804;\n}\n');
    expect(d('p', withPad('	.2byte 0x0000')).source).toBe(asInstr);
  });

  test('`.2byte 0x46C0` (the canonical Thumb nop) reads the same way', () => {
    expect(d('p', withPad('	.2byte 0x46C0')).source).toBe(d('p', withPad('	nop')).source);
  });

  test('a REACHABLE `.2byte 0x46C0` is a NOP, never a live read of r8', () => {
    // 0x46C0 is what `nop` assembles to on ARM7TDMI, and objdump disassembles it as
    // `nop @ (mov r8, r8)`. The `mov r8, r8` spelling of it is modelled as a READ of a
    // callee-saved register, which invents a parameter — so decoding the halfword that way gives
    // the same two bytes a signature the object does not have. Decode it as the nop it is.
    const reachable = (pad: string) => `	thumb_func_start np
np:
	movs r0, #0x05
${pad}
	bx lr
`;
    expect(d('np', reachable('	.2byte 0x46C0')).source).toBe(d('np', reachable('	nop')).source);
    expect(d('np', reachable('	.2byte 0x46C0')).source).toBe('s32 np(void) {\n    return 5;\n}\n');
  });

  test('a REACHABLE pad halfword is KEPT as its degenerate instruction, never dropped', () => {
    // The pad is not padding here — control reaches it. Deleting it would silently delete an
    // instruction; the frontend keeps it, exactly as it keeps the `lsls` spelling of the same
    // two bytes (`isPadInstr` prunes only UNREACHABLE all-pad blocks).
    const reachable = (pad: string) => `	thumb_func_start rp
rp:
	movs r1, #0x05
${pad}
	bx lr
`;
    const asInstr = d('rp', reachable('	lsls r0, r0, #0x00')).source;
    expect(asInstr).toContain('a0 << 0');
    expect(d('rp', reachable('	.2byte 0x0000')).source).toBe(asInstr);
  });

  test('a raw halfword that is neither a branch nor pad STILL declines loud', () => {
    const asm = `	thumb_func_start f
f:
	cmp r0, #0x15
	.2byte 0x4680 @ mov r8, r0
	movs r0, #0x00
	bx lr
`;
    expect(() => d('f', asm)).toThrow(FrontendUnsupportedError);
    expect(() => d('f', asm)).toThrow(/raw halfword '0x4680'.*not a decodable branch/);
  });

  test('a `.2byte` whose value only STARTS like pad is not pad — it declines loud', () => {
    // `parseInt` stops at the first character it cannot use, so `0x0000+2` read as 0x0000 and
    // `0x46C0+1` as 0x46C0. The assembler emits 0x0002 (`lsls r2, r0, #0`) and 0x46C1
    // (`mov r9, r8`) — different instructions, silently substituted. Only a complete 16-bit hex
    // literal is an encoding this pass may read.
    const withVal = (v: string) => `	thumb_func_start pv
pv:
	movs r0, #0x03
	b _e
	.2byte ${v}
_e:
	bx lr
`;
    expect(d('pv', withVal('0x0000')).source).toBe('s32 pv(void) {\n    return 3;\n}\n');
    for (const v of ['0x0000+2', '0x46C0+1', '0x0000 + 2', 'PAD', '18112']) {
      expect(() => d('pv', withVal(v))).toThrow(FrontendUnsupportedError);
      expect(() => d('pv', withVal(v))).toThrow(/not a decodable branch/);
    }
  });

  test('the same rule guards the raw BRANCH decode — an expression is not an encoding', () => {
    // The branch decoder read its value with the same prefix-tolerant parse, so `0xD001+2` would
    // have been decoded as the branch 0xD001 encodes and the `+2` silently dropped.
    const withVal = (v: string) => `	thumb_func_start bv
bv:
	cmp r0, #0x00
	.2byte ${v}
	movs r0, #0x01
	bx lr
_t:
	movs r0, #0x02
	bx lr
`;
    expect(d('bv', withVal('0xD001')).source).toContain('return 2;');
    expect(() => d('bv', withVal('0xD001+2'))).toThrow(/raw halfword '0xD001\+2'.*not a decodable branch/);
  });

  test('a pad halfword under a LABEL is still a sub-word data table, not code', () => {
    // `inCode` means "no label since the last instruction". A labelled `.2byte` is a data table
    // and keeps declining for the function that reads it — this pass must not swallow one.
    const asm = `	thumb_func_start uses
uses:
	ldr r0, _p
	bx lr
_p: .4byte sTable
	thumb_func_end uses

sTable:
	.2byte 0x0000
`;
    expect(() => d('uses', asm)).toThrow(/sub-word data table 'sTable'/);
  });

  test('byte layout is unchanged: a pc-relative load across a pad resolves identically', () => {
    // The highest-risk property in this file. `[pc, #N]` resolves through the running byte
    // offset, so a pad that is sized differently from the instruction it replaces silently
    // retargets the load. All three spellings must land on the SAME pool word.
    const across = (pad: string) => `	thumb_func_start pc
pc:
	ldr r0, [pc, #0x008]
	b _end
${pad}
	.4byte 0x11111111
	.4byte 0x22222222
_end:
	bx lr
`;
    const asInstr = d('pc', across('	lsls r0, r0, #0x00')).source;
    expect(asInstr).toBe('s32 pc(void) {\n    return 572662306;\n}\n'); // the SECOND word, 0x22222222
    expect(d('pc', across('	.2byte 0x0000')).source).toBe(asInstr);
  });
});

describe('pad spelling (c): `.align 2, 0` in the code stream', () => {
  // `.align N, fill` emits (-(absolute address)) mod 2^N bytes, so sizing it needs the function's
  // address mod 4 — which the frontend recovers only AFTER the layout walk, from literal-pool
  // positions the align itself may move. It is solved instead: a Thumb function starts on a
  // 2-byte boundary, so its base is 0 or 2 mod 4; both are tried and the structural invariants
  // the frontend already enforces (pool words are 4-aligned, raw branches land on instruction
  // boundaries, pc-relative loads land on a pool word) eliminate the wrong one.

  test('a sized `.align 2, 0` lifts and agrees with the instruction spelling', () => {
    // Only base=2 survives: at base=0 the align emits nothing and the load falls off the pool.
    const across = (pad: string) => `	thumb_func_start pc
pc:
	ldr r0, [pc, #0x008]
	b _end
${pad}
	.4byte 0x11111111
	.4byte 0x22222222
_end:
	bx lr
`;
    const asInstr = d('pc', across('	lsls r0, r0, #0x00')).source;
    expect(asInstr).toBe('s32 pc(void) {\n    return 572662306;\n}\n');
    expect(d('pc', across('	.align 2, 0')).source).toBe(asInstr);
  });

  test('an `.align 2, 0` that emits ZERO bytes is not a refusal', () => {
    const asm = `	thumb_func_start z
z:
	ldr r0, [pc, #0x000]
	bx lr
	.align 2, 0
	.4byte 0x030052A4
`;
    expect(d('z', asm).source).toBe('s32 z(void) {\n    return 50352804;\n}\n');
  });

  test('a pool word BEFORE the align pins the base on its own', () => {
    const asm = `	thumb_func_start q
q:
	ldr r0, [pc, #0x004]
	b _e
	.4byte 0x11111111
	.align 2, 0
	.4byte 0x22222222
_e:
	bx lr
`;
    expect(d('q', asm).source).toBe('s32 q(void) {\n    return 572662306;\n}\n');
  });

  test('an align whose size the input does not determine STILL declines loud', () => {
    // Both base parities are self-consistent here AND both resolve the load — to DIFFERENT pool
    // words (0x22222222 at base 0, 0x33333333 at base 2). Guessing either would be the silent
    // wrong answer this frontend exists to refuse.
    const asm = `	thumb_func_start am
am:
	movs r1, #0x00
	ldr r0, [pc, #0x008]
	b _e
	.align 2, 0
	.4byte 0x11111111
	.4byte 0x22222222
	.4byte 0x33333333
_e:
	bx lr
`;
    expect(() => d('am', asm)).toThrow(FrontendUnsupportedError);
    expect(() => d('am', asm)).toThrow(/base 0 and base 2 both decode consistently but disagree/);
    // The message names the difference it actually found, rather than asserting one.
    expect(() => d('am', asm)).toThrow(/pc-relative load at item 2 → 0x22222222/);
  });

  test('an UNMODELLED fill still declines loud — those bytes are real instructions', () => {
    // The fill VALUE, not the size: `-(base + at) mod 4` is the same arithmetic whatever the fill
    // is. 0xFFFF is not padding, so there is no pad instruction to put in the stream and the
    // directive stays out of the layout entirely — which is what the message says.
    const asm = (dir: string) => `	thumb_func_start nf
nf:
	ldr r0, [pc, #0x000]
	b _e
${dir}
	.4byte 0x030052A4
_e:
	bx lr
`;
    expect(() => d('nf', asm('	.align 2, 0xFF'))).toThrow(FrontendUnsupportedError);
    expect(() => d('nf', asm('	.align 2, 0xFF'))).toThrow(/'\.align' fills with bytes this frontend does not model/);
    // …and with no fill operand the assembler's own code fill IS a pad encoding, so it lifts.
    expect(d('nf', asm('	.align 2')).source).toBe('s32 nf(void) {\n    return 50352804;\n}\n');
  });

  test('`.align 3, 0` STILL declines loud — the base is only knowable mod 4', () => {
    // An 8-byte alignment needs the function's address mod 8; the pool words that pin the base
    // pin it mod 4 only, so there is no fill count to compute and no honest guess to make.
    const asm = `	thumb_func_start a3
a3:
	ldr r0, [pc, #0x004]
	b _e
	.align 3, 0
	.4byte 0x11111111
_e:
	bx lr
`;
    expect(() => d('a3', asm)).toThrow(/'\.align' makes item sizes unknowable/);
  });

  test('a max-skip `.align 2, 0, 4` STILL declines loud (a form that may emit nothing)', () => {
    const asm = `	thumb_func_start ms
ms:
	ldr r0, [pc, #0x000]
	b _e
	.align 2, 0, 4
	.4byte 0x030052A4
_e:
	bx lr
`;
    expect(() => d('ms', asm)).toThrow(/'\.align' makes item sizes unknowable/);
  });

  test('a nonzero fill STILL declines loud — those bytes are not pad', () => {
    const asm = `	thumb_func_start nz
nz:
	ldr r0, [pc, #0x008]
	b _e
	.align 2, 0xFF
	.4byte 0x11111111
	.4byte 0x22222222
_e:
	bx lr
`;
    expect(() => d('nz', asm)).toThrow(/'\.align' fills with bytes this frontend does not model/);
  });

  test('`.balign` and `.p2align` are the same directive and are sized the same way', () => {
    // `.p2align N` is `.align N` spelled explicitly; `.balign N` says the same thing in BYTES.
    // GNU as emits identical fill for all three, so a frontend that recognises only one of them
    // attributes ZERO bytes to the others and silently shifts everything after them.
    const across = (pad: string) => `	thumb_func_start pc
pc:
	ldr r0, [pc, #0x008]
	b _end
${pad}
	.4byte 0x11111111
	.4byte 0x22222222
_end:
	bx lr
`;
    const asInstr = d('pc', across('	lsls r0, r0, #0x00')).source;
    expect(asInstr).toBe('s32 pc(void) {\n    return 572662306;\n}\n');
    expect(d('pc', across('	.balign 4, 0')).source).toBe(asInstr);
    expect(d('pc', across('	.p2align 2, 0')).source).toBe(asInstr);
  });

  test('a raw branch across a `.balign` / `.p2align` no longer retargets silently', () => {
    // The fill sits between the branch and its target, so dropping it moves the target by two
    // bytes: `arm-none-eabi-as` + objdump put 0xD004 on `movs r0, #0x0A` (the function returns 10
    // when a0 == 0), while attributing zero bytes to the directive lands it on the other arm.
    // All three spellings of the alignment now reach the SAME answer — here, a loud refusal,
    // because the two candidate base alignments genuinely disagree about this branch.
    const withDir = (dir: string) => `	thumb_func_start k
k:
	cmp r0, #0x00
	.2byte 0xD004
	movs r0, #0x01
	movs r1, #0x02
	b _e
${dir}
	movs r0, #0x09
	movs r0, #0x0A
_e:
	bx lr
`;
    expect(d('k', withDir('	lsls r0, r0, #0x00')).source).toContain('return 10;');
    for (const dir of ['	.align 2, 0', '	.balign 4, 0', '	.p2align 2, 0']) {
      expect(() => d('k', withDir(dir))).toThrow(FrontendUnsupportedError);
      expect(() => d('k', withDir(dir))).toThrow(/base alignment/);
    }
  });

  test('an unsizable `.balign` / `.p2align` is a hazard, exactly like `.align`', () => {
    const withDir = (dir: string) => `	thumb_func_start nf
nf:
	ldr r0, [pc, #0x000]
	b _e
${dir}
	.4byte 0x030052A4
_e:
	bx lr
`;
    for (const dir of ['	.balign 8, 0', '	.p2align 3, 0', '	.balign 3, 0', '	.balign 4, 0, 2']) {
      expect(() => d('nf', withDir(dir))).toThrow(/makes item sizes unknowable/);
    }
    // …and the sizable ones read as the same 4-byte alignment `.align 2, 0` spells.
    for (const dir of ['	.balign 4', '	.p2align 2', '	.align 2, 0']) {
      expect(d('nf', withDir(dir)).source).toBe('s32 nf(void) {\n    return 50352804;\n}\n');
    }
  });

  test('a single pool an align moves gets its OWN refusal, not the multi-pool one', () => {
    // One `.4byte`, and neither base puts it on a 4-byte boundary once the align's own fill is
    // counted. Nothing is inconsistent with anything here — the pre-existing message would send a
    // reader hunting for a second pool that does not exist.
    const asm = `	thumb_func_start r
r:
	ldr r0, [pc, #0x00]
	.align 2, 0
	bx lr
	.4byte 0x030052A4
`;
    expect(() => d('r', asm)).toThrow(/no base alignment \(0 or 2 mod 4\) puts every literal pool word/);
  });

  test('when NEITHER base fits, the refusal names the search and both hypotheses', () => {
    // Reporting candidate 0's message alone states one hypothesis as fact, byte offsets included —
    // and `onGap: 'annotate'` writes those strings into the emitted artifact.
    const asm = `	thumb_func_start b
b:
	ldr r0, [pc, #0x020]
	b _e
	.align 2, 0
	.4byte 0x11111111
	.4byte 0x22222222
_e:
	bx lr
`;
    expect(() => d('b', asm)).toThrow(/neither base alignment fits/);
    expect(() => d('b', asm)).toThrow(/base 0: .*0x24.*base 2: .*0x22/);
  });

  test('inconsistent literal pools keep their own refusal', () => {
    const asm = `	thumb_func_start ic
ic:
	ldr r0, [pc, #0x000]
	b _e
	.4byte 0x11111111
	adds r1, #0x01
	.4byte 0x22222222
_e:
	bx lr
`;
    expect(() => d('ic', asm)).toThrow(/literal pools at inconsistent alignments/);
  });

  test('a function whose align is sealed off by a branch needs no layout at all', () => {
    // The common shape: labelled pool, no pc-relative load, no raw halfword — and the align sits
    // behind an unconditional `b`, so nothing can execute its fill. Those bytes cannot move any
    // answer, so no base is solved and the item is dropped, exactly as before this pass existed.
    // What makes that safe is the SEAL, not the absence of other layout work: see the next test.
    const asm = `	thumb_func_start nl
nl:
	ldr r0, _p
	b _e
	.align 2, 0
_p: .4byte 0x030052A4
_e:
	bx lr
`;
    expect(d('nl', asm).source).toBe('s32 nl(void) {\n    return 50352804;\n}\n');
  });

  test('a REACHABLE fill is code: all three spellings lift to the SAME C', () => {
    // Nothing here needs byte offsets for its own sake — no pc-relative load, no raw branch — so
    // this is the path that used to DELETE the align unsized. Its fill is reachable (control
    // falls straight into it) and the in-code pool word pins the base at 2, which makes the fill
    // exactly one pad instruction: the same two bytes the other two spellings write out.
    const f = (pad: string) => `	thumb_func_start rf
rf:
	b _c
	.4byte 0x11111111
_c:
	movs r1, #0x05
${pad}
	bx lr
`;
    const asInstr = d('rf', f('	lsls r0, r0, #0x00')).source;
    expect(asInstr).toBe('s32 rf(s32 a0) {\n    return a0 << 0;\n}\n');
    expect(d('rf', f('	.2byte 0x0000')).source).toBe(asInstr);
    expect(d('rf', f('	.align 2, 0')).source).toBe(asInstr);
    // …and the pad is not free: without it the function is the identity.
    expect(d('rf', f('')).source).toBe('s32 rf(s32 a0) {\n    return a0;\n}\n');
  });

  test('a reachable fill the input cannot size declines — it never silently vanishes', () => {
    // Same reachable position, but no pool pins the base, so the input genuinely does not say
    // whether those two bytes are there. The two instruction spellings say they are and lift; the
    // directive cannot, and refuses rather than dropping bytes the other spellings execute.
    const f = (pad: string) => `	thumb_func_start rp
rp:
	movs r1, #0x05
${pad}
	bx lr
`;
    expect(d('rp', f('	lsls r0, r0, #0x00')).source).toContain('a0 << 0');
    expect(d('rp', f('	.2byte 0x0000')).source).toContain('a0 << 0');
    expect(() => d('rp', f('	.align 2, 0'))).toThrow(FrontendUnsupportedError);
    expect(() => d('rp', f('	.align 2, 0'))).toThrow(/alignment fill at item 2 is 2 bytes/);
  });

  test('two bases that decide every question the same way are NOT a refusal', () => {
    // Both 0 and 2 mod 4 survive every invariant here: the align emits a pad at one and nothing at
    // the other, and that pad is unreachable padding the prune deletes either way. The load
    // resolves to the same word under both. Refusing this would cost a lift for no disagreement —
    // the survivors are COMPARED, not counted.
    const f = (pad: string) => `	thumb_func_start q
q:
	ldr r0, [pc, #0x04]
	movs r1, #0x01
	b _end
${pad}
	.4byte 0xDEADBEEF
	.4byte 0x030052A4
_end:
	bx lr
`;
    const asInstr = d('q', f('	lsls r0, r0, #0x00')).source;
    expect(asInstr).toBe('s32 q(void) {\n    return 3735928559;\n}\n');
    expect(d('q', f('')).source).toBe(asInstr);
    expect(d('q', f('	.align 2, 0')).source).toBe(asInstr);
  });

  test('an alignment this pass cannot READ over reachable bytes declines, whatever the slice needs', () => {
    // These forms emit bytes into the instruction stream at a point control reaches, and leave one
    // of the two questions open. The check used to live inside the byte-layout branch, so a
    // function with a labelled pool and no pc-relative load skipped it entirely and lifted with
    // the directive's bytes missing — and decoding the `.2byte 0x0000` pad at parse time took the
    // last shape that forced that branch away with it.
    //
    // The two questions are separate, and the refusal says which one it tested. `.align 2, 0, 4`
    // and `.align 3, 0` leave the byte COUNT open (a max-skip threshold; a base known only mod 4).
    // `.align 2, 0xFF` is perfectly sizable — the count is `-(base + at) mod 4` and does not
    // depend on the fill — but 0xFFFF is a real undefined instruction, not padding.
    const hz = (dir: string) => `	thumb_func_start hz
hz:
	ldr r0, _p
	movs r1, #0x07
${dir}
	bx lr
_p: .4byte 0x030052A4
`;
    expect(d('hz', hz('')).source).toBe('s32 hz(void) {\n    return 50352804;\n}\n');
    for (const dir of ['	.align 2, 0, 4', '	.align 3, 0', '	.balign 8', '	.p2align 3, 0']) {
      expect(() => d('hz', hz(dir))).toThrow(FrontendUnsupportedError);
      expect(() => d('hz', hz(dir))).toThrow(/makes item sizes unknowable/);
    }
    for (const dir of ['	.align 2, 0xFF', '	.balign 4, 0x20']) {
      expect(() => d('hz', hz(dir))).toThrow(FrontendUnsupportedError);
      expect(() => d('hz', hz(dir))).toThrow(/fill bytes are not a pad encoding/);
    }
  });

  test('an alignment with NO fill operand is the assembler nop, not an unsizable form', () => {
    // Ground truth, `arm-none-eabi-as` + objdump: `movs r0, #1` then `.align 2` in a `.thumb`
    // `.text` assembles to `0120 c046` — gas fills a code section with 0x46C0, the ARM7TDMI nop
    // that is already PAD_ENCODINGS[1]. So the size is plain arithmetic and the fill is a pad
    // encoding this frontend models; refusing it as "unsizable" described neither the code nor the
    // assembler. The `, 0` spelling of the SAME directive fills with 0x0000 — `lsls r0, r0, #0`,
    // which sets the flags — so the two must NOT lift to the same C, and they do not.
    const f = (pad: string) => `	thumb_func_start rf
rf:
	b _c
	.4byte 0x11111111
_c:
	movs r1, #0x05
${pad}
	bx lr
`;
    const asNop = d('rf', f('	nop')).source;
    expect(asNop).toBe('s32 rf(s32 a0) {\n    return a0;\n}\n');
    for (const dir of ['	.align 2', '	.balign 4', '	.p2align 2']) {
      expect(d('rf', f(dir)).source).toBe(asNop);
    }
    expect(d('rf', f('	.align 2, 0')).source).toBe('s32 rf(s32 a0) {\n    return a0 << 0;\n}\n');
  });

  test('an unsizable alignment SEALED off by a branch is still not a refusal', () => {
    // The mirror of the test above, and the reason the check asks about reachability rather than
    // declining on sight: behind an unconditional `b` those bytes are pool padding no instruction
    // executes, nothing in the slice needs their offset, and this lifted before the round.
    const asm = `	thumb_func_start sz
sz:
	ldr r0, _p
	b _e
	.align 2
_p: .4byte 0x030052A4
_e:
	bx lr
`;
    expect(d('sz', asm).source).toBe('s32 sz(void) {\n    return 50352804;\n}\n');
  });

  test('a labelled data table stays a LAYOUT hazard, and reads the same under every spelling', () => {
    // `.byte` under a label is a data table: its bytes are not in the instruction stream, so its
    // unknown size can only shift offsets — which matters only when the slice needs them. Both pad
    // spellings must therefore reach the same answer here; the `lsls` one always lifted, and the
    // data spelling used to decline only because it dragged the slice onto the layout path.
    const t = (pad: string) => `	thumb_func_start h
h:
	movs r0, #0x07
	b _end
${pad}
tbl:
	.byte 0x01, 0x02, 0x03
_end:
	bx lr
`;
    expect(d('h', t('	lsls r0, r0, #0x00')).source).toBe('s32 h(void) {\n    return 7;\n}\n');
    expect(d('h', t('	.2byte 0x0000')).source).toBe(d('h', t('	lsls r0, r0, #0x00')).source);
  });

  test("agbcc's dead pool label does not re-open a sealed fill", () => {
    // agbcc writes `.L10:` in front of every literal-pool alignment and never branches there. A
    // label is only a way into the fill if something in the slice NAMES it — reading every label
    // as one would send every agbcc function through the base solver for bytes nothing executes.
    const asm = `	thumb_func_start fb
fb:
	ldr r0, .L9
	bx lr
.L10:
	.align 2, 0
.L9:
	.word 0x3001000
`;
    expect(d('fb', asm).source).toBe('s32 fb(void) {\n    return 50335744;\n}\n');
  });
});

describe('a label naming DATA is not a way into an alignment fill', () => {
  test('an alignment between two words of a labelled pool is data, and lifts', () => {
    // `ldr r0, _pool` NAMES `_pool`, but it is a load, not a way for control to get there: the
    // label heads data, so nothing can execute the fill behind it. Reading every named label as a
    // branch target made an unsizable alignment inside a literal pool decline the function with a
    // message that said its bytes were in the code stream. They are in the data stream, and the
    // only thing they can do is shift the offsets of what follows.
    const q = (dir: string) => `	thumb_func_start q
q:
	ldr r0, _pool
	ldr r1, _pool2
	adds r0, r0, r1
	bx lr
_pool:
	.4byte 0x11111111
${dir}
_pool2:
	.4byte 0x22222222
`;
    const plain = d('q', q('')).source;
    expect(plain).toBe('s32 q(void) {\n    return 858993459;\n}\n');
    for (const dir of ['	.align 3, 0', '	.align 2', '	.align 2, 0', '	.align 2, 0, 4']) {
      expect(d('q', q(dir)).source).toBe(plain);
    }
  });

  test('a CODE label named by a branch still re-opens the fill behind it', () => {
    // The mirror, and the reason this is a data-label clause rather than a narrowing of `named`:
    // `_l` heads instructions, `b _l` puts control on it, and the fill it precedes is executed.
    const asm = `	thumb_func_start m
m:
	b _l
	movs r0, #0x09
	bx lr
_l:
	.align 2, 0, 4
	movs r0, #0x01
	bx lr
`;
    expect(() => d('m', asm)).toThrow(FrontendUnsupportedError);
    expect(() => d('m', asm)).toThrow(/emits fill into the code stream/);
  });
});

describe('an unsizable alignment is scoped to the function whose bytes it emits', () => {
  // The hazard is recorded by allFlat POSITION so that a directive between two functions cannot
  // poison a sibling — a property the parser comment states and nothing pinned, because every
  // other fixture in this file holds exactly one function.
  const two = (dir: string) => `	thumb_func_start Foo
Foo:
	movs r0, #0x01
	bx lr
${dir}
	thumb_func_start Bar
Bar:
	movs r0, #0x02
	bx lr
`;

  test('a directive in the PREVIOUS function tail leaves the next function alone', () => {
    // Its fill is emitted at addresses below `Bar`'s entry label, so no instruction of `Bar` can
    // execute it and none of `Bar`'s offsets move. The hazard sits at the item BEFORE the
    // directive, which for this shape is `Foo`'s last item — one slot below `Bar`'s slice.
    for (const dir of ['	.align 2', '	.align 4, 0', '	.balign 8', '	.align 2, 0, 4', '	.align 2, 0xFF']) {
      expect(d('Bar', two(dir)).source).toBe('s32 Bar(void) {\n    return 2;\n}\n');
      // …and `Foo` itself still lifts: the fill is sealed off by its `bx lr`.
      expect(d('Foo', two(dir)).source).toBe('s32 Foo(void) {\n    return 1;\n}\n');
    }
  });

  test('the same directive INSIDE the function still declines', () => {
    // The mirror: move the identical text one line down, past `Bar`'s entry label, and its fill is
    // in `Bar`'s own instruction stream at a point control reaches.
    const inside = (dir: string) => `	thumb_func_start Foo
Foo:
	movs r0, #0x01
	bx lr
	thumb_func_start Bar
Bar:
	movs r0, #0x02
${dir}
	bx lr
`;
    for (const dir of ['	.align 2, 0, 4', '	.align 2, 0xFF']) {
      expect(() => d('Bar', inside(dir))).toThrow(FrontendUnsupportedError);
      expect(() => d('Bar', inside(dir))).toThrow(/emits fill into the code stream/);
    }
  });
});

describe('the pad encodings are one table', () => {
  test('every instruction padHalfword can emit is one isPadInstr recognises', () => {
    // The knowledge "which bytes are alignment fill" is spelled twice — as encodings in
    // PAD_ENCODINGS and as instruction shapes in isPadInstr. A third encoding added to one and
    // forgotten in the other would produce a pad the prune never removes, silently.
    expect(PAD_ENCODINGS.length).toBeGreaterThan(1);
    for (const e of PAD_ENCODINGS) {
      expect(isPadInstr({ mnemonic: e.mnemonic, ops: [...e.ops] })).toBe(true);
    }
  });

  test('and the predicate does not accept just anything', () => {
    expect(isPadInstr({ mnemonic: 'mov', ops: ['r0', 'r1'] })).toBe(false);
    expect(isPadInstr({ mnemonic: 'lsls', ops: ['r0', 'r0', '#0x01'] })).toBe(false);
  });
});
