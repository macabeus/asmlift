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
    expect(d('p', withPad('	.2byte 0x46C0')).source).toBe(d('p', withPad('	mov r8, r8')).source);
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
