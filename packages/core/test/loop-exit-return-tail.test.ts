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
import { EXIT_TAIL_GATES, type StructureHooks, structure } from '../src/structure/structure';
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
    expect(() => judged(bypass)).toThrow(/unrecovered back-edge/);
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
    expect(() => judged(cyclic)).toThrow(/unrecovered back-edge/);
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
