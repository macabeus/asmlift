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
    expect(() => d('am', asm)).toThrow(/'\.align' padding depends on the function's base alignment/);
  });

  test('`.align 2` with no fill operand STILL declines loud (unknown fill bytes)', () => {
    const asm = `	thumb_func_start nf
nf:
	ldr r0, [pc, #0x000]
	b _e
	.align 2
	.4byte 0x030052A4
_e:
	bx lr
`;
    expect(() => d('nf', asm)).toThrow(/'\.align' makes item sizes unknowable/);
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
    expect(() => d('nz', asm)).toThrow(/'\.align' makes item sizes unknowable/);
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
    for (const dir of ['	.balign 4', '	.p2align 2', '	.balign 8, 0', '	.p2align 3, 0', '	.balign 3, 0', '	.balign 4, 0, 2']) {
      expect(() => d('nf', withDir(dir))).toThrow(/makes item sizes unknowable/);
    }
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

  test('a function that needs no byte-accurate layout is untouched by any of this', () => {
    // The common shape: labelled pool, no pc-relative load, no raw halfword. The align never
    // needed sizing here and still does not.
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
});
