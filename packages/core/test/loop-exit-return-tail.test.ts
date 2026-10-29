// AN EARLY `return` WHOSE TAIL THE LOOP'S OWN EXIT PATH ALSO RUNS (`earlyReturnArm`, `exitTail`).
//
// `for (i = 0; i < gCount; i++) { if (gTab[i] == x) { *out = r; return; } } gMiss = 1; *out = r;`
// (`synthetic:retpost_tail`). agbcc cross-jumps the `b` to the return label onto the identical
// `*out = r` before it (jump.c), and gcc2.7.2kmc / gcc2.7.2 put that one store in the `jr ra` delay
// slot: either way the arm and the post-loop path, after its `gMiss = 1`, end in ONE `store; ret`
// block. No `break` spells the arm — it would land on `gMiss = 1` — so the arm is an early return
// that writes the tail once more, and the exit path keeps the copy written after the loop. The paths
// are exclusive, so each runs the store once.
//
// The exit's own code need not have an effect: agbcc cross-jumps the arm's store onto a post-loop
// `r = 0; *out = r;` too, a register move falling into the one store (`a pure exit assignment ahead
// of the tail`). What stays refused is `EXIT_TAIL_GATES` (at `earlyReturnArm`), whose `guardedBy`
// names the test that fails without each rule — here or in `loop-break-exit.test.ts`; the IR tests
// here also drop their rule and watch the reading change. The arm writes the tail without owning it,
// so it stays code run after the loop for a `do-while`'s escape check, since the exit path runs it
// there. And a copy is the reading of last resort: where another exit lets every edge `break` to the tail, that reading wins
// (`a rotated loop whose two exits can both \`break\` to the tail copies nothing`), and so does a
// `while (1)` whose arms keep their own tails (`retarm2_tail`, below).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { AsmData } from '../src/frontend/asmdata';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { decompile, readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { BYPASS_TAIL_GATES, EXIT_TAIL_GATES, type StructureHooks, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, MIPS_GCC } from '../src/target';
import { irAgreement } from './helpers';

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

const judged = (ir: string, hooks: StructureHooks = {}) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, {}, hooks);
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

/** The row's agbcc listing (`-O2 -mthumb-interwork`): `beq .L9` from the body and the exit `.L4`
 *  (also the zero-trip guard's `bcs`) both reach `.L9`, the one `str r2,[r3]`. */
const AGBCC_RETPOST_TAIL = `retpost_tail:
	push	{r4, r5, r6, lr}
	add	r3, r1, #0
	lsl	r0, r0, #0x18
	lsr	r4, r0, #0x18
	ldr	r0, .L10
	ldr	r2, [r0]
	mov	r1, #0x0
	ldr	r0, .L10+0x4
	ldrb	r5, [r0]
	cmp	r1, r5
	bcs	.L4	@cond_branch
	ldr	r6, .L10+0x8
	add	r5, r0, #0
.L6:
	add	r0, r1, r6
	ldrb	r0, [r0]
	cmp	r0, r4
	beq	.L9	@cond_branch
	add	r0, r1, #0x1
	lsl	r0, r0, #0x18
	lsr	r1, r0, #0x18
	ldrb	r0, [r5]
	cmp	r1, r0
	bcc	.L6	@cond_branch
.L4:
	ldr	r1, .L10+0xc
	mov	r0, #0x1
	strb	r0, [r1]
.L9:
	str	r2, [r3]
	pop	{r4, r5, r6}
	pop	{r0}
	bx	r0
.L11:
	.align	2, 0
.L10:
	.word	gInit
	.word	gCount
	.word	gTab
	.word	gMiss
`;

/** The row's gcc2.7.2kmc listing: the arm's `beq` and the exit's fall-through meet at `jr ra`, whose
 *  delay slot holds the one `sw a3,0(a1)`. */
const KMC_RETPOST_TAIL = `00000000 <retpost_tail>:
   0:	lui	v0,0x0
   4:	lbu	v0,0(v0)
   8:	lui	a3,0x0
   c:	lw	a3,0(a3)
  10:	beqz	v0,50 <retpost_tail+0x50>
  14:	move	a2,zero
  18:	andi	a0,a0,0xff
  1c:	andi	v0,a2,0xff
  20:	lui	at,0x0
  24:	addu	at,at,v0
  28:	lbu	v0,0(at)
  2c:	beq	v0,a0,5c <retpost_tail+0x5c>
  30:	nop
  34:	lui	v1,0x0
  38:	lbu	v1,0(v1)
  3c:	addiu	a2,a2,1
  40:	andi	v0,a2,0xff
  44:	sltu	v0,v0,v1
  48:	bnez	v0,20 <retpost_tail+0x20>
  4c:	andi	v0,a2,0xff
  50:	li	v0,1
  54:	lui	at,0x0
  58:	sb	v0,0(at)
  5c:	jr	ra
  60:	sw	a3,0(a1)
`;
const KMC_RELOCS: [number, string, string][] = [
  [0x00, 'R_MIPS_HI16', 'gCount'],
  [0x04, 'R_MIPS_LO16', 'gCount'],
  [0x08, 'R_MIPS_HI16', 'gInit'],
  [0x0c, 'R_MIPS_LO16', 'gInit'],
  [0x20, 'R_MIPS_HI16', 'gTab'],
  [0x28, 'R_MIPS_LO16', 'gTab'],
  [0x34, 'R_MIPS_HI16', 'gCount'],
  [0x38, 'R_MIPS_LO16', 'gCount'],
  [0x54, 'R_MIPS_HI16', 'gMiss'],
  [0x58, 'R_MIPS_LO16', 'gMiss'],
];
const KMC_DATA: AsmData = {
  sections: new Map(),
  relocs: KMC_RELOCS.map(([offset, type, sym]) => ({ section: '.text', offset, type, sym, addend: 0 })),
  symbols: new Map(),
  symbolCount: 0,
  bigEndian: true,
};

/** The arm writes the store and returns inside the loop; the post-loop code is `gMiss = 1;` and the
 *  store, written once, after it — never `gMiss = 1` inside the loop (the `while` reading that took
 *  the arm for the exit, which the zero-trip guard's entry into `gMiss = 1` keeps refused). */
const expectRetpostTail = (src: string) => {
  expect(src).toMatch(/\{\n\s+\*a1 = v0;\n\s+return;\n\s+\}/);
  expect(src.match(/\*a1 = v0;/g)).toHaveLength(2);
  expect(src.match(/gMiss = 1;/g)).toHaveLength(1);
  const loopEnd = src.lastIndexOf('break;');
  expect(loopEnd).toBeGreaterThan(-1);
  expect(src.indexOf('gMiss = 1;')).toBeGreaterThan(loopEnd);
  expect(src.slice(src.indexOf('gMiss = 1;'))).toMatch(/^gMiss = 1;\n\s+\*a1 = v0;\n/);
};

/** `synthetic:retarm2_tail`'s agbcc listing: `if (gTab[i] == 7) { Ping(i); Hit(a); return; } if
 *  (gTab[i] == 8) { Pong(i); Hit(a); return; }`, the two `Hit(a)` cross-jumped into `.L10`. The
 *  `while` reading would take the header's `Ping` edge for the loop's exit and copy `Hit(a)` into the
 *  `Pong` arm; `while (1)`, whose two arms each keep `Hit(a)` and need no copy, is read first. */
const AGBCC_RETARM2_TAIL = `retarm2_tail:
	push	{r4, lr}
	add	r4, r0, #0
	mov	r2, #0x0
	cmp	r2, r1
	bcs	.L2	@cond_branch
.L6:
	ldr	r0, .L11
	add	r0, r2, r0
	ldrb	r0, [r0]
	cmp	r0, #0x7
	bne	.L7	@cond_branch
	add	r0, r2, #0
	bl	Ping
	b	.L10
.L12:
	.align	2, 0
.L11:
	.word	gTab
.L7:
	cmp	r0, #0x8
	bne	.L5	@cond_branch
	add	r0, r2, #0
	bl	Pong
.L10:
	add	r0, r4, #0
	bl	Hit
	b	.L2
.L5:
	add	r2, r2, #0x1
	cmp	r2, r1
	bcc	.L6	@cond_branch
.L2:
	pop	{r4}
	pop	{r0}
	bx	r0
`;

/** `for (i = 0; i < gCount; i++) { if (gTab[i] == x) { *out = r; return; } } r = 0; *out = r;` at
 *  agbcc `-O2 -mthumb-interwork`: the exit `.L4` runs only `mov r3, #0` before the `.L9` store the
 *  arm's `beq` enters too. */
const AGBCC_RETPRE_PURE = `retpre_pure:
	push	{r4, r5, r6, lr}
	lsl	r0, r0, #24
	lsr	r4, r0, #24
	ldr	r0, .L10
	ldr	r3, [r0]
	mov	r2, #0
	ldr	r0, .L10+4
	ldrb	r5, [r0]
	cmp	r2, r5
	bcs	.L4	@cond_branch
	ldr	r6, .L10+8
	add	r5, r0, #0
.L6:
	add	r0, r2, r6
	ldrb	r0, [r0]
	cmp	r0, r4
	beq	.L9	@cond_branch
	add	r0, r2, #1
	lsl	r0, r0, #24
	lsr	r2, r0, #24
	ldrb	r0, [r5]
	cmp	r2, r0
	bcc	.L6	@cond_branch
.L4:
	mov	r3, #0
.L9:
	str	r3, [r1]
	pop	{r4, r5, r6}
	pop	{r0}
	bx	r0
.L11:
	.align	2, 0
.L10:
	.word	gInit
	.word	gCount
	.word	gTab
`;

describe('an early return whose tail the loop exit path also runs', () => {
  test('two cross-jumped arms are not read as an exit and an arm', () => {
    const src = decompile('retarm2_tail', AGBCC_RETARM2_TAIL, ARMV4T_AGBCC, {
      prototypes: {
        Hit: { params: 1, returnsVoid: true },
        Ping: { params: 1, returnsVoid: true },
        Pong: { params: 1, returnsVoid: true },
        retarm2_tail: { params: 2, returnsVoid: true },
      },
    }).source;
    expect(src).toContain('while (1) {');
    expect(src).toMatch(/Ping\(v0\);\n\s+Hit\(a0\);\n\s+return;/);
    expect(src).toMatch(/Pong\(v0\);\n\s+Hit\(a0\);\n\s+return;/);
    expect(src.match(/Hit\(/g)).toHaveLength(2);
  });

  test('agbcc: the cross-jumped store is written in the arm and after the loop', () => {
    const src = decompile('retpost_tail', AGBCC_RETPOST_TAIL, ARMV4T_AGBCC, {
      prototypes: { retpost_tail: { params: 2, returnsVoid: true } },
    }).source;
    expectRetpostTail(src);
  });

  test('agbcc: a store the exit reaches past a pure assignment is written in the arm too', () => {
    const src = decompile('retpre_pure', AGBCC_RETPRE_PURE, ARMV4T_AGBCC, {
      prototypes: { retpre_pure: { params: 2, returnsVoid: true } },
    }).source;
    expect(src).toMatch(/\{\n\s+v1 = gInit;\n\s+\*a1 = v1;\n\s+return;\n\s+\}/);
    expect(src).toMatch(/\}\n\s+v1 = 0;\n\s+\*a1 = v1;\n/);
    expect(src.match(/\*a1 = v1;/g)).toHaveLength(2);
  });

  test('gcc2.7.2kmc: the store in the `jr ra` delay slot is written in the arm and after the loop', () => {
    const src = decompile('retpost_tail', KMC_RETPOST_TAIL, MIPS_GCC, {
      asmData: KMC_DATA,
      prototypes: { retpost_tail: { params: 2, returnsVoid: true } },
    }).source;
    expectRetpostTail(src);
  });
});

/** `EXIT_TAIL_GATES` with one rule dropped, as `structure`'s hook takes it. */
const withoutRule = (id: string): StructureHooks => ({ exitTailGates: without(EXIT_TAIL_GATES, id) });

/** The same shape in IR, for the trace oracle: a zero-trip guard into the exit `^bb4` (`miss(i)`), a
 *  body arm into `^bb5` (`store; ret`), which the exit falls into. The header is a pure test, as the
 *  rows' `ldrb`/`lbu` is: the `while` reading then takes the arm for its exit and refuses the latch's
 *  edge, and `while (1)` is the reading left. */
const RETPOST_TAIL_IR = `fn retpost {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(%2), ^bb4(%2)
^bb1(%4: s32):
  %5: s32 = add %4, %4
  %6: u32 = icmp_eq %5, %0
  cond_br %6, ^bb5(%4), ^bb2()
^bb2():
  %7: s32 = const {value=1}
  %8: s32 = add %4, %7
  %9: u32 = icmp_slt %8, %1
  cond_br %9, ^bb1(%8), ^bb4(%8)
^bb4(%10: s32):
  %11: s32 = call %10 {target="miss"}
  br ^bb5(%10)
^bb5(%12: s32):
  store %0, %12 {off=0, width=4}
  ret %12
}`;

describe('the exit-path return tail, against its own IR', () => {
  test('lifts with the tail in the arm and after the loop, and agrees on every seed', () => {
    const { src, agreement, shipped } = judged(RETPOST_TAIL_IR);
    // the store in the arm and once after the `if` the zero-trip guard heads; `miss` on both of its
    // paths, never inside the loop
    expect(src.match(/\*\(s32 \*\)a0 = v0;/g)).toHaveLength(2);
    expect(src).toMatch(/\{\n\s+\*\(s32 \*\)a0 = v0;\n\s+return v0;\n\s+\}/);
    const loop = src.slice(src.indexOf('while (1) {'), src.indexOf('break;'));
    expect(loop).not.toContain('miss(');
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  });

  test('a tail also entered straight from before the loop, past the exit, stays refused', () => {
    // ^bb0 now enters the tail directly when a1 == 7: a path that ran neither the arm nor the exit
    const bypass = RETPOST_TAIL_IR.replace(
      '  cond_br %3, ^bb1(%2), ^bb4(%2)\n',
      '  cond_br %3, ^bb6(), ^bb4(%2)\n^bb6():\n  %20: s32 = const {value=7}\n  %21: u32 = icmp_eq %1, %20\n' +
        '  cond_br %21, ^bb5(%2), ^bb1(%2)\n',
    );
    // no arm copies the tail: the loop is left to the two-level exit (`two-level-exit.test.ts`), which
    // writes the store once, after the loop, and the exit's `miss` under its flag
    const flagged = judged(bypass);
    expect(flagged.src.match(/\*\(s32 \*\)a0 = /g)).toHaveLength(1);
    expect(flagged.src).toMatch(/if \(v\d == 0\) miss\(v\d\);/);
    expect(flagged.agreement).toEqual({ judged: 300, disagree: 0 });
    expect(flagged.shipped).toEqual({ judged: 300, disagree: 0 });
    // the refusal is the rule's: without it the arm copies the tail past the guard's own entry
    expect(judged(bypass, withoutRule('entry-bypasses-exit')).agreement).toEqual({ judged: 300, disagree: 0 });
  });

  test('a tail holding a loop of its own stays refused', () => {
    // past the store, `do { v = more(v); } while (v == a0);`: without the cycle refusal the arm writes
    // that loop a second time inside the first (300/300 agreement, but a loop the asm holds once)
    const cyclic = RETPOST_TAIL_IR.replace(
      '^bb5(%12: s32):\n  store %0, %12 {off=0, width=4}\n  ret %12',
      '^bb5(%12: s32):\n  store %0, %12 {off=0, width=4}\n  br ^bb6(%12)\n^bb6(%30: s32):\n' +
        '  %31: s32 = call %30 {target="more"}\n  %32: u32 = icmp_eq %31, %0\n  cond_br %32, ^bb6(%31), ^bb7()\n' +
        '^bb7():\n  ret %12',
    );
    // the two-level exit takes the loop instead, and writes the tail's loop once
    const flagged = judged(cyclic);
    expect(flagged.src.match(/more\(/g)).toHaveLength(1);
    expect(flagged.agreement).toEqual({ judged: 300, disagree: 0 });
    expect(flagged.shipped).toEqual({ judged: 300, disagree: 0 });
    expect(judged(cyclic, withoutRule('tail-holds-cycle')).src.match(/more\(/g)).toHaveLength(2);
    expect(judged(cyclic, withoutRule('tail-holds-cycle')).agreement).toEqual({ judged: 300, disagree: 0 });
  });

  test('a pure exit assignment ahead of the tail is code of its own', () => {
    // the exit hands the tail `0` where the arm hands it `i`: no `break` lands past that move
    const pure = RETPOST_TAIL_IR.replace(
      '  %11: s32 = call %10 {target="miss"}\n  br ^bb5(%10)',
      '  %11: s32 = const {value=0}\n  br ^bb5(%11)',
    );
    const { src, agreement, shipped } = judged(pure);
    expect(src).toMatch(/\{\n\s+\*\(s32 \*\)a0 = v0;\n\s+return v0;\n\s+\}/);
    expect(src.match(/\*\(s32 \*\)a0 = v0;/g)).toHaveLength(2);
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  });
});

/** `for (i = 0; i < n; i++) { v = t(i); if (v == a) { *a = i; return i; } if (v == 7) { hit(i);
 *  break; } } i = 0; *a = i; return i;` with the guard into the pure exit `^bb4`: the `hit` arm
 *  reaches the exit itself, so the exit path runs nothing the arm does not, and `hit(i); break;`
 *  spells it. Taking the tail into that arm too, the `do-while` reading copies `i = 0; *a = i;
 *  return i;` into it — the same program, but the exit written twice. */
const ARM_REACHES_EXIT = `fn retcode {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %20: u32 = icmp_slt %2, %1
  cond_br %20, ^bb1(%2), ^bb4(%2)
^bb1(%3: s32):
  %4: s32 = call %3 {target="t"}
  %5: u32 = icmp_eq %4, %0
  cond_br %5, ^bb5(%3), ^bb2()
^bb2():
  %6: s32 = const {value=7}
  %7: u32 = icmp_eq %4, %6
  cond_br %7, ^bb6(), ^bb3()
^bb3():
  %8: s32 = const {value=1}
  %9: s32 = add %3, %8
  %10: u32 = icmp_slt %9, %1
  cond_br %10, ^bb1(%9), ^bb4(%9)
^bb6():
  %11: s32 = call %3 {target="hit"}
  br ^bb4(%3)
^bb4(%12: s32):
  %13: s32 = const {value=0}
  br ^bb5(%13)
^bb5(%14: s32):
  store %0, %14 {off=0, width=4}
  ret %14
}`;

test('an arm that reaches the exit itself is a `break`, and copies no tail past it', () => {
  const { src, agreement, shipped } = judged(ARM_REACHES_EXIT);
  expect(src).toMatch(/hit\(v1\);\n\s+break;/);
  expect(src).toContain('while (1) {');
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
  // the rule is what refuses the copy: without it the `do-while` reading writes the tail in the arm
  const copied = judged(ARM_REACHES_EXIT, withoutRule('exit-runs-nothing-of-its-own'));
  expect(copied.src).toMatch(/hit\(v1\);\n\s+v1 = 0;\n\s+\*\(s32 \*\)a0 = v1;\n\s+return v1;/);
  expect(copied.agreement).toEqual({ judged: 300, disagree: 0 });
});

/** agbcc's rotated `for (i = 0; i < 8; i++) { if (bit(i)) { x = i; break; } } tail();`: the `break`
 *  arm's `bit` test is the latch, and the count test sits mid-body (`synthetic` shape of sa3's
 *  CreateEntity_Suction and pokeemerald's Cmd_jumpifarrayequal). Taking the `x = i` arm for the exit,
 *  the count test's edge could copy `tail` past it; the reading with `tail` for the exit spells both
 *  edges as `break` and needs no copy, and a copy is the reading of last resort. */
const ROTATED_BREAK_IR = `fn rotbreak {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = add %3, %4
  %6: s32 = const {value=7}
  %7: u32 = icmp_slt %6, %5
  cond_br %7, ^bb5(%1), ^bb2()
^bb2():
  %8: s32 = call %5 {target="bit"}
  %9: s32 = const {value=0}
  %10: u32 = icmp_eq %8, %9
  cond_br %10, ^bb1(%5), ^bb4()
^bb4():
  store %0, %5 {off=0, width=4}
  br ^bb5(%5)
^bb5(%11: s32):
  %12: s32 = call %11 {target="tail"}
  ret %12
}`;

test('a rotated loop whose two exits can both `break` to the tail copies nothing', () => {
  const { src, agreement, shipped } = judged(ROTATED_BREAK_IR);
  expect(src.match(/break;/g)).toHaveLength(2);
  expect(src.match(/tail\(/g)).toHaveLength(1);
  expect(src).toMatch(/\}\n\s+return tail\(a1\);\n\}/);
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

/** A `do-while` (the header calls, so no `while` reading) whose shared tail reads `i + i`, a value the
 *  body computed from the loop variable before the update. The arm's copy reads it ahead of the
 *  update; the exit path's copy runs after the loop, past it. The arm enters the tail through a pure
 *  trampoline (`^bb6`), so no reading lifts it but the `exitTail` copy: an arm straight into the
 *  `store; ret` block is a plain unowned `ret` target, which the `do-while` reading takes with no
 *  copy at all. */
const DOWHILE_TAIL_READS_BODY = `fn retbody {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = call %3 {target="t"}
  %5: s32 = add %3, %3
  %6: u32 = icmp_eq %4, %0
  cond_br %6, ^bb6(), ^bb2()
^bb2():
  %7: s32 = const {value=1}
  %8: s32 = add %3, %7
  %9: u32 = icmp_slt %8, %1
  cond_br %9, ^bb1(%8), ^bb4()
^bb4():
  %10: s32 = call %8 {target="miss"}
  br ^bb5()
^bb6():
  br ^bb5()
^bb5():
  store %0, %5 {off=0, width=4}
  ret %5
}`;

/** What the escape check is a witness for: the loop lifts to C that agrees with the IR, or the check
 *  declines it. The decline is not the outcome asked for — `while (1)` with the copy in the arm has a
 *  right reading of `DOWHILE_TAIL_READS_BODY`, which a `do-while` committed before its escape check
 *  throws has no way back to — so a later fallback that lifts it passes here too. */
const liftsRightOrEscapeDeclines = (ir: string) => {
  let lifted: ReturnType<typeof judged>;
  try {
    lifted = judged(ir);
  } catch (error) {
    expect(String(error)).toMatch(/post-loop value reads a pre-update loop variable/);
    return;
  }
  expect(lifted.agreement).toEqual({ judged: 300, disagree: 0 });
  expect(lifted.shipped).toEqual({ judged: 300, disagree: 0 });
};

test('a tail the exit path also runs stays post-loop for the escape check of a `do-while`', () => {
  // written in the arm (`exitTail`) but owned by none, the tail is code the exit path runs after the
  // update, where `i + i` would be re-derived from the updated name: owning what `exitTail` admits
  // lifts it, and 255 of 300 seeds disagree
  liftsRightOrEscapeDeclines(DOWHILE_TAIL_READS_BODY);
  // the same check holds the plain reading's unowned `ret` target, the arm straight into the tail
  const direct = DOWHILE_TAIL_READS_BODY.replace('cond_br %6, ^bb6(), ^bb2()', 'cond_br %6, ^bb5(), ^bb2()').replace(
    '^bb6():\n  br ^bb5()\n',
    '',
  );
  liftsRightOrEscapeDeclines(direct);
});

/** The same loop with a tail that reads nothing of the body: the plain `do-while` reading fails (the
 *  trampoline is no `ret` target, and the tail it enters the exit path also runs), and so does
 *  `while (1)` without a copy. The `do-while` reading that copies the tail into the arm is kept aside
 *  (`copyingReadings`) and wins over `while (1)` with the copy, which would spell the latch's test as
 *  `if (!(i < n)) break;`. */
const DOWHILE_COPIES_TAIL = DOWHILE_TAIL_READS_BODY.replace(
  'store %0, %5 {off=0, width=4}\n  ret %5',
  'store %0, %1 {off=0, width=4}\n  ret %1',
);

test("a `do-while` whose arm needs the exit path's tail keeps its bottom test", () => {
  const { src, agreement, shipped } = judged(DOWHILE_COPIES_TAIL);
  expect(src).toMatch(/do \{[\s\S]*\} while \(v\d+ < a1\);/);
  expect(src).not.toMatch(/while \(1\)/);
  expect(src.match(/\*\(s32 \*\)a0 = a1;/g)).toHaveLength(2);
  expect(agreement).toEqual({ judged: 300, disagree: 0 });
  expect(shipped).toEqual({ judged: 300, disagree: 0 });
});

// A RETURN TAIL A PATH THAT BYPASSES THE LOOP ALSO ENTERS (`BypassCounts`, at `earlyReturnArm`).
// agbcc cross-jumps an arm's `fin(..); return;` onto the identical tail of a branch before the loop
// (jump.c `find_cross_jump`; `synthetic:sw_xjret`), so the arm runs a block of its own (`^bb3`, the
// argument) and lands on a `call; ret` the branch ahead of the loop also enters. No other count
// admits that entrant, the two-level exit included (the exit's code never meets the arm's head). The
// arm writes the tail without owning it, and the path from before the loop keeps the copy written
// where the tail sits.

/** `if (a == 7) { if (n == 0) { fin(0); return; } i = 0; } else { for (i = 0; i < n; i++) { if (i +
 *  i == a) { fin(i + a); return; } } miss(i); } done(i);` with the two `fin(..); return;`
 *  cross-jumped into `^bb5`, which the loop's exit `^bb4` never reaches: off the exit path.
 *  The exit joins the branch before the loop at `done`, as the rows' post-loop code does, so it is no
 *  `ret` target of its own; the arm's own block `^bb3` sits inside the loop's span, where agbcc lays
 *  it out. */
const BYPASS_OFF_EXIT_IR = `fn bypassoff {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %20: s32 = const {value=7}
  %21: u32 = icmp_eq %0, %20
  cond_br %21, ^bb10(), ^bb6()
^bb10():
  %22: u32 = icmp_eq %1, %2
  cond_br %22, ^bb5(%2), ^bb9(%2)
^bb6():
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(%2), ^bb4(%2)
^bb1(%4: s32):
  %5: s32 = add %4, %4
  %6: u32 = icmp_eq %5, %0
  cond_br %6, ^bb3(), ^bb2()
^bb3():
  %13: s32 = add %4, %0
  br ^bb5(%13)
^bb2():
  %7: s32 = const {value=1}
  %8: s32 = add %4, %7
  %9: u32 = icmp_slt %8, %1
  cond_br %9, ^bb1(%8), ^bb4(%8)
^bb4(%10: s32):
  %11: s32 = call %10 {target="miss"}
  br ^bb9(%10)
^bb5(%12: s32):
  %14: s32 = call %12 {target="fin"}
  ret %12
^bb9(%15: s32):
  %16: s32 = call %15 {target="done"}
  ret %15
}`;

/** The same loop whose exit only returns and whose header calls: `for (..) { if (t(i) == a) {
 *  fin(i + a); return; } } return i;`, the shape of a loop at the end of a `case` (Klonoa's
 *  sub_08016EEC). The call leaves no `while` reading, and the arm's head `^bb3`, inside the loop's
 *  span, fits `while (1)` as an exit, the `ret` past the loop being a plain `ret` target. The exit
 *  laid out past the loop fits too once the arm copies the tail; the asm does not say which the
 *  source wrote, and the one read first stands where nothing declines with it (`PastExitRanking`). */
const BYPASS_RET_EXIT_IR = BYPASS_OFF_EXIT_IR.replace('fn bypassoff', 'fn bypassret')
  .replace('  %5: s32 = add %4, %4\n', '  %5: s32 = call %4 {target="t"}\n')
  .replace('  %11: s32 = call %10 {target="miss"}\n  br ^bb9(%10)\n', '  ret %10\n');

/** The same loop whose exit path also ends in the tail: `miss(i); fin(i); return;` after the loop,
 *  agbcc's three `fin` sites in one block (`synthetic:sw_xjret_post`). On the exit path: the
 *  `exitTail` count copies the tail past the exit's `miss`, and the last resort waives its
 *  `entry-bypasses-exit` rule for the guard's path, which ran neither the arm nor the exit. */
const BYPASS_ON_EXIT_IR = BYPASS_OFF_EXIT_IR.replace('fn bypassoff', 'fn bypasson').replace(
  '  %11: s32 = call %10 {target="miss"}\n  br ^bb9(%10)\n',
  '  %11: s32 = call %10 {target="miss"}\n  br ^bb5(%10)\n',
);

/** `for (i = 0; i < n; i++) { if (t(i) == a) goto hit; if (u(i) == a) goto hit; } return 0; hit:
 *  fin(i); if (i == 0) k(0); return i;`, with `hit` laid out inside the loop's span: two arms enter
 *  the tail and nothing from outside the loop does, so it is no bypassed tail, and the loop `break`s
 *  to it once. */
const ARMS_ONLY_TAIL_IR = `fn armsonly {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(%2), ^bb4()
^bb1(%4: s32):
  %5: s32 = call %4 {target="t"}
  %6: u32 = icmp_eq %5, %0
  cond_br %6, ^bb5(%4), ^bb6()
^bb6():
  %7: s32 = call %4 {target="u"}
  %8: u32 = icmp_eq %7, %0
  cond_br %8, ^bb5(%4), ^bb2()
^bb5(%12: s32):
  %14: s32 = call %12 {target="fin"}
  %15: u32 = icmp_eq %12, %2
  cond_br %15, ^bb7(), ^bb8()
^bb7():
  %16: s32 = call %2 {target="k"}
  br ^bb8()
^bb8():
  ret %12
^bb2():
  %9: s32 = const {value=1}
  %10: s32 = add %4, %9
  %11: u32 = icmp_slt %10, %1
  cond_br %11, ^bb1(%10), ^bb4()
^bb4():
  ret %2
}`;

/** `if (a == 7) { hit: fin(a); return a; } for (i = 0; i < n; i++) { if (t(i) == a) goto hit; }
 *  return 0;`: the tail a branch before the loop also enters is laid out AHEAD of the loop, a label
 *  the arm jumps back to. It is no early `return` inside the loop's span, so the loop `break`s to it
 *  rather than copying it into the arm. */
const PRE_LOOP_TAIL_IR = `fn preloop {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %20: s32 = const {value=7}
  %21: u32 = icmp_eq %0, %20
  cond_br %21, ^bb5(), ^bb6()
^bb5():
  %14: s32 = call %0 {target="fin"}
  ret %0
^bb6():
  %3: u32 = icmp_slt %2, %1
  cond_br %3, ^bb1(%2), ^bb4()
^bb1(%4: s32):
  %5: s32 = call %4 {target="t"}
  %6: u32 = icmp_eq %5, %0
  cond_br %6, ^bb5(), ^bb2()
^bb2():
  %9: s32 = const {value=1}
  %10: s32 = add %4, %9
  %11: u32 = icmp_slt %10, %1
  cond_br %11, ^bb1(%10), ^bb4()
^bb4():
  ret %2
}`;

/** `synthetic:sw_xjret_end`'s agbcc listing (`-O2 -mthumb-interwork`): `switch (c) { case 3: for (i =
 *  gLo; i <= gHi; i++) { switch (gE[i].id) { case 5: if (gE[i].x != a) { gOut = 1; break; } fin(gE[a].x,
 *  gE[a].y, 2, a); return; .. } } break; case 4: if (gOut == 9) { fin(gE[a].x, gE[a].y, 2, a); return; }
 *  k(4); break; }`. Case 5's `fin` is cross-jumped onto case 4's at `.L27`, and its head `.L11` is laid
 *  out inside the loop's span. */
const AGBCC_SW_XJRET_END =
  'sw_xjret_end:\n\tpush\t{r4, r5, lr}\n\tadd\tr5, r0, #0\n\tcmp\tr1, #0x3\n\tbeq\t.L4\t@cond_branch\n' +
  '\tcmp\tr1, #0x4\n\tbne\t.LCB11\n\tb\t.L23\t@long jump\n.LCB11:\n\tb\t.L2\n.L4:\n\tldr\tr0, .L28\n' +
  '\tldr\tr4, [r0]\n\tldr\tr0, .L28+0x4\n\tldr\tr0, [r0]\n\tcmp\tr4, r0\n\tble\t.LCB22\n' +
  '\tb\t.L2\t@long jump\n.LCB22:\n.L8:\n\tldr\tr1, .L28+0x8\n\tlsl\tr2, r4, #0x1\n\tadd\tr0, r2, r4\n' +
  '\tlsl\tr0, r0, #0x2\n\tadd\tr0, r0, r1\n\tldrb\tr0, [r0, #0x8]\n\tsub\tr0, r0, #0x5\n' +
  '\tadd\tr3, r1, #0\n\tcmp\tr0, #0x7\n\tbhi\t.L7\t@cond_branch\n\tlsl\tr0, r0, #0x2\n' +
  '\tldr\tr1, .L28+0xc\n\tadd\tr0, r0, r1\n\tldr\tr0, [r0]\n\tmov\tpc, r0\n.L29:\n\t.align\t2, 0\n' +
  '.L28:\n\t.word\tgLo\n\t.word\tgHi\n\t.word\tgE\n\t.word\t.L20\n\t.align\t2, 0\n\t.align\t2, 0\n' +
  '.L20:\n\t.word\t.L10\n\t.word\t.L12\n\t.word\t.L7\n\t.word\t.L14\n\t.word\t.L16\n\t.word\t.L7\n' +
  '\t.word\t.L17\n\t.word\t.L19\n.L10:\n\tadd\tr0, r2, r4\n\tlsl\tr0, r0, #0x2\n\tadd\tr0, r0, r3\n' +
  '\tldr\tr0, [r0]\n\tcmp\tr0, r5\n\tbeq\t.L11\t@cond_branch\n\tldr\tr1, .L30\n\tmov\tr0, #0x1\n' +
  '\tstr\tr0, [r1]\n\tb\t.L7\n.L31:\n\t.align\t2, 0\n.L30:\n\t.word\tgOut\n.L11:\n\tlsl\tr1, r5, #0x1\n' +
  '\tadd\tr1, r1, r5\n\tlsl\tr1, r1, #0x2\n\tadd\tr0, r1, r3\n\tldr\tr0, [r0]\n\tadd\tr2, r3, #0x4\n' +
  '\tb\t.L27\n.L12:\n\tadd\tr0, r2, r4\n\tlsl\tr0, r0, #0x2\n\tadd\tr0, r0, r3\n\tldr\tr0, [r0]\n' +
  '\tcmp\tr0, r5\n\tble\t.L7\t@cond_branch\n\tldr\tr1, .L32\n\tmov\tr0, #0x2\n\tstr\tr0, [r1]\n' +
  '\tb\t.L7\n.L33:\n\t.align\t2, 0\n.L32:\n\t.word\tgOut\n.L14:\n\tadd\tr0, r2, r4\n' +
  '\tlsl\tr0, r0, #0x2\n\tadd\tr0, r0, r3\n\tldr\tr0, [r0]\n\tcmp\tr0, r5\n\tbge\t.L7\t@cond_branch\n' +
  '\tldr\tr1, .L34\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n\tb\t.L7\n.L35:\n\t.align\t2, 0\n.L34:\n' +
  '\t.word\tgOut\n.L16:\n\tldr\tr1, .L36\n\tmov\tr0, #0x4\n\tstr\tr0, [r1]\n\tb\t.L7\n.L37:\n' +
  '\t.align\t2, 0\n.L36:\n\t.word\tgOut\n.L17:\n\tadd\tr0, r2, r4\n\tlsl\tr0, r0, #0x2\n' +
  '\tadd\tr0, r0, r3\n\tldr\tr0, [r0]\n\tcmp\tr0, r5\n\tbeq\t.L7\t@cond_branch\n\tldr\tr1, .L38\n' +
  '\tmov\tr0, #0x5\n\tstr\tr0, [r1]\n\tb\t.L7\n.L39:\n\t.align\t2, 0\n.L38:\n\t.word\tgOut\n.L19:\n' +
  '\tadd\tr0, r4, #0\n\tbl\tk\n.L7:\n\tadd\tr4, r4, #0x1\n\tldr\tr0, .L40\n\tldr\tr0, [r0]\n' +
  '\tcmp\tr4, r0\n\tble\t.L8\t@cond_branch\n\tb\t.L2\n.L41:\n\t.align\t2, 0\n.L40:\n\t.word\tgHi\n' +
  '.L23:\n\tldr\tr0, .L42\n\tldr\tr0, [r0]\n\tcmp\tr0, #0x9\n\tbne\t.L24\t@cond_branch\n' +
  '\tldr\tr2, .L42+0x4\n\tlsl\tr1, r5, #0x1\n\tadd\tr1, r1, r5\n\tlsl\tr1, r1, #0x2\n' +
  '\tadd\tr0, r1, r2\n\tldr\tr0, [r0]\n\tadd\tr2, r2, #0x4\n.L27:\n\tadd\tr1, r1, r2\n\tldr\tr1, [r1]\n' +
  '\tmov\tr2, #0x2\n\tadd\tr3, r5, #0\n\tbl\tfin\n\tb\t.L2\n.L43:\n\t.align\t2, 0\n.L42:\n' +
  '\t.word\tgOut\n\t.word\tgE\n.L24:\n\tmov\tr0, #0x4\n\tbl\tk\n.L2:\n\tpop\t{r4, r5}\n\tpop\t{r0}\n' +
  '\tbx\tr0\n';

describe('a return tail a path that bypasses the loop also enters', () => {
  /** the loop's text, from `while (1) {` to its closing brace at the same indentation */
  const loopOf = (src: string) => {
    const at = src.indexOf('while (1) {');
    const indent = src.slice(src.lastIndexOf('\n', at) + 1, at);
    return src.slice(at, src.indexOf(`\n${indent}}`, at));
  };

  test('off the exit path: the arm writes the tail, the branch before the loop keeps its own', () => {
    const { src, agreement, shipped } = judged(BYPASS_OFF_EXIT_IR);
    // the arm returns from inside the loop with its own copy; the latch's edge is the loop's `break`
    const loop = loopOf(src);
    expect(loop).toMatch(/v(\d+) = v\d+ \+ a0;\n\s+fin\(v\1\);\n\s+return v\1;/);
    expect(loop).toMatch(/if \(v\d+ >= a1\) break;/);
    expect(loop).not.toMatch(/miss\(|done\(/);
    // once in the arm, once where the branch before the loop reaches it
    expect(src.match(/fin\(/g)).toHaveLength(2);
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  });

  test("the arm's head inside the loop's span stays the exit where nothing declines with it", () => {
    const { src, agreement, shipped } = judged(BYPASS_RET_EXIT_IR);
    // the arm is the loop's `break` to the `fin` written after it; the exit past the loop returns
    const loop = loopOf(src);
    expect(loop).toMatch(/if \(t\(v\d+\) == a0\) break;/);
    expect(loop).toMatch(/if \(v\d+ >= a1\) return v\d+;/);
    expect(loop).not.toContain('fin(');
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  });

  test("agbcc: a loop ending a `case` reads its exit past the loop where the arm's head declines", () => {
    // with the arm's head for the exit, the switch inside the loop finds case 5's body leaving for an
    // exit past the switch's end; run again with the exit past the loop first, the arm copies the
    // cross-jumped `fin(..); return;` and `case 4:` keeps its own
    const out = decompile('sw_xjret_end', AGBCC_SW_XJRET_END, ARMV4T_AGBCC, {
      prototypes: {
        sw_xjret_end: { params: 2, returnsVoid: true },
        fin: { params: 4, returnsVoid: true },
        k: { params: 1, returnsVoid: true },
      },
    });
    expect(out.diagnostics).toEqual([]);
    const loop = loopOf(out.source);
    expect(loop).toMatch(/fin\([^;]*, 2, a0\);\n\s+return;\n\s+\}\n\s+gOut = 1;\n\s+break;/);
    expect(loop).toMatch(/if \(v\d+ > \(s32\)gHi\) break;/);
    expect(out.source.match(/fin\(/g)).toHaveLength(2);
  });

  test('on the exit path: the arm copies the tail past the bypassing entrant', () => {
    const { src, agreement, shipped } = judged(BYPASS_ON_EXIT_IR);
    const loop = loopOf(src);
    expect(loop).toMatch(/v(\d+) = v\d+ \+ a0;\n\s+fin\(v\1\);\n\s+return v\1;/);
    expect(loop).toMatch(/if \(v\d+ >= a1\) break;/);
    // the exit path runs `miss` after the loop and then the copy written there, never inside it
    expect(loop).not.toContain('miss(');
    expect(src).toMatch(/\n\s+miss\(v\d+\);\n\s+\}\n\s+fin\(v\d+\);\n\s+return v\d+;/);
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  });

  test('a bypassed tail holding a loop of its own is not written in the arm', () => {
    // past the call, `do { v = more(v); } while (v == a0);`: refused in the arm, so the last resort
    // takes the arm for the loop's exit instead and writes the tail's loop after it
    const cyclic = BYPASS_OFF_EXIT_IR.replace(
      '  %14: s32 = call %12 {target="fin"}\n  ret %12',
      '  %14: s32 = call %12 {target="fin"}\n  br ^bb7(%12)\n^bb7(%30: s32):\n' +
        '  %31: s32 = call %30 {target="more"}\n  %32: u32 = icmp_eq %31, %0\n  cond_br %32, ^bb7(%31), ^bb8()\n' +
        '^bb8():\n  ret %12',
    );
    const flagged = judged(cyclic);
    expect(loopOf(flagged.src)).not.toContain('more(');
    expect(flagged.agreement).toEqual({ judged: 300, disagree: 0 });
    // without the rule the arm writes that loop a second time inside the first
    const ablated = judged(cyclic, { bypassTailGates: without(BYPASS_TAIL_GATES, 'bypass-tail-holds-cycle') });
    expect(loopOf(ablated.src)).toContain('more(');
    expect(ablated.agreement).toEqual({ judged: 300, disagree: 0 });
  });

  test('a tail only arms of the loop enter is a `break` target, not a copy', () => {
    const { src, agreement, shipped } = judged(ARMS_ONLY_TAIL_IR);
    expect(loopOf(src)).not.toContain('fin(');
    expect(src.match(/fin\(/g)).toHaveLength(1);
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  });

  test('a tail laid out ahead of the loop is a `break` target, not a copy', () => {
    const { src, agreement, shipped } = judged(PRE_LOOP_TAIL_IR);
    expect(loopOf(src)).not.toContain('fin(');
    expect(agreement).toEqual({ judged: 300, disagree: 0 });
    expect(shipped).toEqual({ judged: 300, disagree: 0 });
  });
});
