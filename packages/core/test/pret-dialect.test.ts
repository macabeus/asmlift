// The pret asm dialect — the format real GBA decomp projects keep under `asm/nonmatchings/`
// (luvdis-extracted: `thumb_func_start` macros, `_08xxxxxx` local labels, `LABEL: .4byte`
// literal pools, s-suffixed ALU spellings). Hand-written fixtures, NOT copied from any game.
import { describe, expect, test } from 'vitest';

import { FrontendUnsupportedError } from '../src/frontend/errors';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const d = (name: string, asm: string) => decompile(name, asm, ARMV4T_AGBCC);

const CLAMP0 = `	thumb_func_start clamp0
clamp0: @ 08012340
	cmp r0, #0x00
	bge _08012348
	movs r0, #0x00
_08012348:
	bx lr
	thumb_func_end clamp0
`;

describe('pret dialect: function macros, labels, pools', () => {
  test('thumb_func_start marks the function; body decompiles like agbcc output', () => {
    expect(d('clamp0', CLAMP0).source).toBe('s32 clamp0(s32 a0) {\n    if (a0 < 0) a0 = 0;\n    return a0;\n}\n');
  });

  test('non_word_aligned_thumb_func_start + s-suffixed shifts (lsrs/adds/asrs) lift and fold', () => {
    const asm = `	non_word_aligned_thumb_func_start half2
half2:
	lsrs r1, r0, #0x1F
	adds r0, r0, r1
	asrs r0, r0, #0x01
	bx lr
	thumb_func_end half2
`;
    expect(d('half2', asm).source).toBe('s32 half2(s32 a0) {\n    return a0 / 2;\n}\n');
  });

  test('same-line literal pool (`_08x: .4byte N`) resolves to a constant, not a phantom pointer', () => {
    const asm = `	thumb_func_start retbig
retbig:
	ldr r0, _08012358 @ =0x12345678
	bx lr
_08012358: .4byte 0x12345678
	thumb_func_end retbig
`;
    expect(d('retbig', asm).source).toBe('s32 retbig(void) {\n    return 305419896;\n}\n');
  });

  test('multi-function input: the requested function is sliced out, others listed when absent', () => {
    const two = CLAMP0 + '\n	thumb_func_start other\nother:\n	movs r0, #0x01\n	bx lr\n	thumb_func_end other\n';
    expect(d('other', two).source).toBe('s32 other(void) {\n    return 1;\n}\n');
    expect(() => d('nope', two)).toThrow(/functions present: clamp0, other/);
  });

  test('a raw halfword that is not a branch fails loud (undecoded instruction, not skippable)', () => {
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

  test('a raw .byte run in the code stream fails loud (size-unknown data)', () => {
    const asm = '	thumb_func_start f\nf:\n	movs r0, #0x00\n	.byte 0x12\n	bx lr\n';
    expect(() => d('f', asm)).toThrow(/raw data directive '\.byte'/);
  });

  test('an ARM-mode function (arm_func_start) declines loud; a Thumb sibling still lifts', () => {
    const mixed = `	arm_func_start ArmThing
ArmThing:
	mov r0, #0
	bx lr
	arm_func_end ArmThing

${CLAMP0}`;
    expect(() => d('ArmThing', mixed)).toThrow(/ARM-mode function/);
    expect(d('clamp0', mixed).source).toContain('if (a0 < 0)');
  });

  test('a truncated fragment (no return) still declines loud with the macro handled', () => {
    const frag = '	thumb_func_start frag\nfrag:\n	movs r0, #0x00\n	adds r0, r0, r1\n';
    expect(() => d('frag', frag)).toThrow(/falls off the end/);
  });

  test('a branch to a data label (not a code block) declines loud, not a crash', () => {
    const asm = `	thumb_func_start f
f:
	cmp r0, #0x00
	bge _08000010
	bx lr
_08000010: .4byte 0x12345678
`;
    expect(() => d('f', asm)).toThrow(/branch target '_08000010' is not a code block/);
  });

  test('a raw branch halfword decodes against byte layout (.2byte 0xD000 = beq +0)', () => {
    const asm = `	thumb_func_start rawbr
rawbr:
	cmp r0, #0x00
	.2byte 0xD000 @ beq
	movs r0, #0x01
	bx lr
`;
    expect(d('rawbr', asm).source).toBe('s32 rawbr(s32 a0) {\n    if (a0 != 0) a0 = 1;\n    return a0;\n}\n');
  });

  test('raw branch over an unlabelled pool: padding pruned, pc-relative load resolves by pool alignment', () => {
    // The luvdis full-raw shape (distilled from a real pause-menu function): a raw beq jumps
    // over a mid-function literal pool; the `lsls r0, r0, #0` is luvdis's alignment padding
    // (unreachable — pruned); `[pc, #4]` resolves into the pool via derived base parity.
    const asm = `	non_word_aligned_thumb_func_start jo
jo:
	cmp r0, #0x00
	.2byte 0xD004 @ beq _past
	ldr r0, [pc, #0x004] @ =0x12345678
	bx lr
	lsls r0, r0, #0x00
	.4byte 0x12345678
	movs r0, #0x00
	bx lr
`;
    expect(d('jo', asm).source).toBe(
      's32 jo(s32 a0) {\n    if (a0 != 0) {\n        return 305419896;\n    } else {\n        return 0;\n    }\n}\n',
    );
  });

  test('a raw branch to a non-instruction boundary declines loud', () => {
    const asm = '	thumb_func_start f\nf:\n	cmp r0, #0x00\n	.2byte 0xD001\n	movs r0, #0x01\n	bx lr\n';
    expect(() => d('f', asm)).toThrow(/targets byte offset 0x8, which is not an instruction boundary/);
  });

  test('reachable code falling through into data bytes declines loud', () => {
    const asm = '	thumb_func_start fd\nfd:\n	movs r0, #0x01\n	.4byte 0x00000000\n	bx lr\n';
    expect(() => d('fd', asm)).toThrow(/falls through into data bytes/);
  });

  test('a sub-word data table declines only the function that references it', () => {
    // `uses` loads the table address from its literal pool; `clean` never touches it.
    const tu = `	.section .rodata
sTable:
	.short 0x0
	.short 0x1189

	.text
	thumb_func_start uses
uses:
	ldr r0, _08000020
	bx lr
_08000020: .4byte sTable
	thumb_func_end uses

	thumb_func_start clean
clean:
	movs r0, #0x02
	bx lr
	thumb_func_end clean
`;
    expect(() => d('uses', tu)).toThrow(/sub-word data table 'sTable' \(\.short\)/);
    expect(d('clean', tu).source).toBe('s32 clean(void) {\n    return 2;\n}\n');
  });

  // Trailing alignment pad after the final return must be pruned, not declined on. A splitter
  // (luvdis) emits a `lsls r0, r0, #0` (0x0000) pad before a literal pool; it is unreachable
  // dead padding. Guard rails pinned here: a REACHABLE pad is kept (never dropped), and trailing
  // REAL code after the return still declines "falls off the end".
  test('trailing NOP pad after the return is pruned (the 25%-of-declines bug)', () => {
    const asm = '	thumb_func_start Add1\nAdd1:\n	adds r0, #0x01\n	bx lr\n	lsls r0, r0, #0x00\n';
    expect(d('Add1', asm).source).toBe('s32 Add1(s32 a0) {\n    return a0 + 1;\n}\n');
  });

  test('trailing pad before a labelled literal pool is pruned; the pool still resolves', () => {
    const asm = `	thumb_func_start pooled
pooled:
	ldr r0, _08000008
	bx lr
	lsls r0, r0, #0x00
_08000008: .4byte 0x030052A4
`;
    expect(d('pooled', asm).source).toBe('s32 pooled(void) {\n    return 50352804;\n}\n');
  });

  test('a REACHABLE pad instruction is kept, never silently dropped', () => {
    const asm = `	thumb_func_start rp
rp:
	cmp r0, #0x00
	beq _08000006
	movs r0, #0x05
_08000006:
	lsls r0, r0, #0x00
	bx lr
`;
    expect(d('rp', asm).source).toBe('s32 rp(s32 a0) {\n    if (a0 != 0) a0 = 5;\n    return a0 << 0;\n}\n');
  });

  test('trailing REAL code (not pad) after the return still declines falls-off-the-end', () => {
    const asm = '	thumb_func_start tr\ntr:\n	adds r0, #0x01\n	bx lr\n	adds r0, #0x02\n';
    expect(() => d('tr', asm)).toThrow(/falls off the end/);
  });
  test('fall-through into a shared-tail .thumb_func extends the slice (both entries lift)', () => {
    const asm = `	thumb_func_start outer
outer:
	movs r0, #0x01
	.thumb_func
tail:
	adds r0, #0x02
	bx lr
`;
    expect(d('outer', asm).source).toBe('s32 outer(void) {\n    return 3;\n}\n');
    expect(d('tail', asm).source).toBe('s32 tail(s32 a0) {\n    return a0 + 2;\n}\n');
  });
});

// Regressions from the three-agent frontend audit (2026-07-20). Every case below was a CONFIRMED
// silent miscompile or crash; each is pinned to its correct behavior (right answer or loud decline).
describe('audit regressions: pool symbols, register ranges, layout, crashes', () => {
  // A literal-pool word holding a global SYMBOL must become its address (gaddr) or decline —
  // never fall through to a phantom pointer PARAMETER on a function that takes none.
  test('a bare-symbol pool word returns the symbol address, not a phantom pointer param', () => {
    const asm = '	thumb_func_start pb\npb:\n	ldr r0, _q\n	bx lr\n_q: .4byte gData\n';
    expect(d('pb', asm).source).toBe('s32 pb(void) {\n    return &gData;\n}\n');
  });
  test('a load THROUGH a symbol pool word lowers to the global, not a phantom deref', () => {
    const asm = '	thumb_func_start gl\ngl:\n	ldr r1, _r\n	ldr r0, [r1]\n	bx lr\n_r: .4byte gGlobal\n';
    expect(d('gl', asm).source).toBe('s32 gl(void) {\n    return gGlobal;\n}\n');
  });
  test('a `sym+N` pool word (unmodelled) declines loud, never fabricates a param', () => {
    const asm = '	thumb_func_start po\npo:\n	ldr r0, _p\n	ldr r0, [r0]\n	bx lr\n_p: .4byte gData+4\n';
    expect(() => d('po', asm)).toThrow(/literal-pool load of pool word 'gData\+4'/);
  });

  // A fused register-range in a pop/ldmia must be expanded — an unexpanded `{r4-pc}` silently
  // DELETED the return; `{r1-r3}` fabricated a 3-arg signature.
  test('pop {r4-pc} is a return (not silently skipped, deleting it)', () => {
    const asm = '	thumb_func_start rr\nrr:\n	push {r4, lr}\n	movs r0, #0x3\n	pop {r4-pc}\n	movs r0, #0x63\n	bx lr\n';
    expect(d('rr', asm).source).toBe('s32 rr(void) {\n    return 3;\n}\n');
  });
  test('ldmia {r1-r3} expands to three loads, not one phantom register', () => {
    const asm = '	thumb_func_start lm\nlm:\n	ldmia r0!, {r1-r3}\n	adds r1, r1, r2\n	adds r1, r1, r3\n	mov r0, r1\n	bx lr\n';
    expect(d('lm', asm).source).toBe('s32 lm(s32 * a0) {\n    return *a0 + a0[1] + a0[2];\n}\n');
  });

  // pc/r15 as a data base (a pc-relative load that escapes the layout rewrite) declines, never
  // fabricates a pointer param.
  test('`ldr [pc]` with no #imm declines loud (no phantom param)', () => {
    const asm = '	thumb_func_start p0\np0:\n	ldr r0, [pc]\n	bx lr\n	.4byte 0x11223344\n';
    expect(() => d('p0', asm)).toThrow(/program counter used as a data base/);
  });

  // An unknown-size data directive corrupts byte layout — it must loud-fail in the code stream,
  // not silently skip (which shifted a pc-relative load onto the wrong pool word).
  test('a .quad in the code stream fails loud', () => {
    const asm = '	thumb_func_start lq\nlq:\n	ldr r0, [pc, #0x0]\n	bx lr\n_x: .quad 0x1122334455667788\n	.4byte 0xFF\n';
    expect(() => d('lq', asm)).toThrow(/raw data directive '\.quad'|makes item sizes unknowable/);
  });

  // Labelled in-stream data that control REACHES (fall-through / into a labelled table) must
  // decline — the empty labelled block used to hide the real predecessor, deleting a branch.
  test('a conditional branch that falls into a labelled .2byte declines, not miscompiles', () => {
    const asm = '	thumb_func_start ra\nra:\n	cmp r0, #0x00\nLAB:\n	.2byte 0xD001\n	movs r0, #0x01\n	bx lr\n';
    expect(() => d('ra', asm)).toThrow(/falls through into data bytes/);
  });

  // layoutHazard is per-slice: a `.align` between two functions must not decline a sibling that
  // needs byte-accurate layout.
  test('.align between functions does not poison a sibling that needs layout', () => {
    const asm =
      '	thumb_func_start f1\nf1:\n	movs r0, #0x01\n	bx lr\n	.align 2, 0\n' +
      '	thumb_func_start f2\nf2:\n	ldr r0, [pc, #0x000]\n	bx lr\n	.4byte 0x12345678\n';
    expect(d('f2', asm).source).toBe('s32 f2(void) {\n    return 305419896;\n}\n');
  });

  // Missing operands degrade to a loud decline, never a raw TypeError crash.
  test('a malformed `cmp r0` (missing operand) declines, not crashes', () => {
    const asm = '	thumb_func_start mc\nmc:\n	cmp r0\n	bge skip\n	movs r0, #0x01\nskip:\n	bx lr\n';
    expect(() => d('mc', asm)).toThrow(FrontendUnsupportedError);
  });
});
