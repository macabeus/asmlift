// AN UNDECLARED CALL THAT TAKES STACK ARGUMENTS, sized by its callee's body.
//
// agbcc stages arguments 5+ at [sp,#0] upward, and a call nothing declares declines there, because
// the code alone cannot say where its block ends (stack-args.test.ts). Where the callee's body is in
// the input, or handed in, its body says how many incoming stack words it loads, a lower bound:
// its lift where it lifts, its straight-line entry where it does not (frontend/callee-body.ts
// `CalleeStackWords`, frontend/thumb-entry.ts). A caller that stages exactly that many words on
// every path is then lifted at every argument register and those words (frontend/stackargs.ts,
// "THE CALLEE'S BODY"); O32 takes the same licence past a0..a3 at 16(sp) (frontend/mips.ts
// `lowerJal`). The shapes are the compilers' own output: corpus/agbcc-entry-stack.s and the
// `*-calleestack` O32 listings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { parseAsmData } from '../src/frontend/asmdata';
import type { CalleeBodies } from '../src/frontend/callee-body';
import { thumbEntryWordsFromText } from '../src/frontend/thumb-entry';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-entry-stack.s'), 'utf8');
/** One function of the probe, from its label to its `.size` line. */
const fn = (name: string): string => {
  const from = asm.indexOf(`\t.globl\t${name}\n`);
  const to = asm.indexOf(`.size\t ${name},`, from);
  return asm.slice(from, asm.indexOf('\n', to) + 1);
};
const src = (name: string, text: string, calleeBodies?: CalleeBodies, prototypes = {}) =>
  decompile(name, text, ARMV4T_AGBCC, { prototypes, calleeBodies }).source;
/** The decline a lift of `name` throws, or `lifted` where it lifts. */
const decline = (name: string, text: string, calleeBodies?: CalleeBodies, prototypes = {}): string => {
  try {
    src(name, text, calleeBodies, prototypes);
    return 'lifted';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('the callee in the input sizes the call', () => {
  test('five words staged for a callee that loads five: a nine-argument call', () => {
    expect(src('call9', fn('nine') + fn('call9'))).toBe(
      'void call9(s32 *a0) {\n    nine(*a0, a0[1], a0[2], a0[3], a0[4], a0[5], a0[6], a0[7], a0[8]);\n}\n',
    );
  });

  test('…staged anew before the call on every iteration of a loop', () => {
    expect(src('loop9', fn('nine') + fn('loop9'))).toMatch(
      /while \(v0 > 0\) \{\n {8}nine\(\*v1, v1\[1\], v1\[2\], v1\[3\], v1\[4\], v1\[5\], v1\[6\], v1\[7\], v1\[8\]\);/,
    );
  });

  test('a call beside another the body bounds lifts too', () => {
    expect(src('calls5', fn('fifth') + fn('calls5'))).toMatch(/v0 = fifth\(1, 2, 3, a0, a1\);/);
  });

  test('a callee that loads its stack word only on one branch is sized by its lift, not its entry', () => {
    // br5 loads [sp,#4] after `bne`, past the straight-line entry, and lifts with five parameters
    expect(thumbEntryWordsFromText('br5', fn('br5'))).toBeUndefined();
    expect(src('call_br', fn('br5') + fn('call_br'))).toBe(
      'void call_br(s32 *a0) {\n    br5(*a0, a0[1], a0[2], a0[3], a0[4]);\n}\n',
    );
  });

  test('the result names the callee it sized, with the stack words it took (`calleeStackSized`)', () => {
    expect(decompile('call9', fn('nine') + fn('call9'), ARMV4T_AGBCC).calleeStackSized).toEqual({ nine: 5 });
    expect(decompile('krfewer', fn('kr') + fn('krfewer'), ARMV4T_AGBCC).calleeStackSized).toEqual({});
  });

  test('the whole probe as one input: the same answer', () => {
    expect(src('call9', asm)).toBe(src('call9', fn('nine') + fn('call9')));
  });
});

describe('where the body does not size the call, it keeps its decline', () => {
  test('without the callee in the input, nothing sizes the block', () => {
    expect(decline('call9', fn('call9'))).toMatch(/never reloaded and its lower slots are supplied/);
  });

  test('a caller staging more words than the callee loads (K&R) declines, naming both witnesses', () => {
    expect(decline('krmore', fn('kr') + fn('krmore'))).toMatch(
      /reaches `bl kr` unread with its lower slots supplied — it may be that call's outgoing stack argument \(its body loads 1 incoming stack word, \[sp,#0\], but the words staged for it are \[sp,#0\], \[sp,#4\]/,
    );
  });

  test('a caller staging nothing is lifted as before, at the registers it set', () => {
    expect(src('krfewer', fn('kr') + fn('krfewer'))).toBe('s32 krfewer(s32 a0) {\n    return kr(a0, 2, 3, 4);\n}\n');
  });

  test('a callee the input marks `.weak` is one another definition may replace', () => {
    expect(decline('call9', `\t.weak\tnine\n${fn('nine')}${fn('call9')}`)).toMatch(/lower slots are supplied/);
  });

  test('a declaration wins over the body: a stated arity is laid out as stated', () => {
    expect(decline('call9', fn('nine') + fn('call9'), undefined, { nine: { params: 4 } })).toMatch(
      /lower slots are supplied/,
    );
  });

  test('a callee declared to return a struct through memory takes a hidden word the entry cannot see', () => {
    expect(
      decline('call9', fn('nine') + fn('call9'), undefined, {
        nine: {
          returns: 'struct S',
          returnLayout: { kind: 'struct', members: ['a', 'b', 'c'].map((name) => ({ name, type: 'u32' })) },
        },
      }),
    ).toMatch(/returns struct S through a hidden pointer in r0/);
  });
});

describe('a body handed in from outside the input', () => {
  // nine's first halfwords, assembled (thumb-entry.test.ts)
  const NINE = [0xb5f0, 0x9d05, 0x9e06, 0x9f07, 0x4c07, 0x1940, 0x6020, 0x1989, 0x6061, 0x19d2, 0x60a2, 0x9808];
  const NINE_ALL = [...NINE, 0x181b, 0x60e3, 0x9809, 0x6120, 0xbcf0, 0xbc01, 0x4700];

  test('a Thumb body’s halfwords size the call as its text does', () => {
    expect(src('call9', fn('call9'), { nine: { kind: 'thumb', halfwords: NINE_ALL } })).toBe(
      src('call9', fn('nine') + fn('call9')),
    );
  });

  test('…and a prefix that stops short of the last load is a smaller bound, so it declines', () => {
    expect(decline('call9', fn('call9'), { nine: { kind: 'thumb', halfwords: NINE } })).toMatch(
      /its body loads 4 incoming stack words/,
    );
  });

  test('a listing body in the input format is read as the input is', () => {
    expect(src('call9', fn('call9'), { nine: { kind: 'listing', text: fn('nine') } })).toBe(
      src('call9', fn('nine') + fn('call9')),
    );
  });
});

describe('O32: the same licence, past a0..a3 at 16(sp)', () => {
  // corpus/probe-o32-callee-stack.c on each O32 compiler (scripts/regen-o32-callee-stack-probes.ts)
  const corpus = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');
  const o32 =
    (slug: string, t: 'ido7.1' | 'gcc2.7.2kmc' | 'gcc2.7.2') =>
    (sym: string, prototypes = {}) => {
      const dump = corpus(`${slug}-calleestack.txt`);
      try {
        return decompile(sym, corpus(`${slug}-calleestack.asm`), TOOLCHAIN_TARGETS[t].description, {
          prototypes,
          asmData: parseAsmData(dump, dump, dump, true),
        }).source;
      } catch (e) {
        return (e as Error).message;
      }
    };
  describe.each([
    ['ido71', 'ido7.1'],
    ['gcc272kmc', 'gcc2.7.2kmc'],
    ['gcc272', 'gcc2.7.2'],
  ] as const)('%s', (slug, t) => {
    const lift = o32(slug, t);
    test('five words staged at 16(sp) for a callee that loads five: a nine-argument call', () => {
      expect(lift('call9')).toBe(
        's32 call9(s32 *a0) {\n    return nine(*a0, a0[1], a0[2], a0[3], a0[4], a0[5], a0[6], a0[7], a0[8]);\n}\n',
      );
    });

    // `br6` reads a2 and a3 only as `sink`'s, a call nothing declares and its lift takes at every
    // register: no read, so a2/a3 could be words an 8-aligned argument skipped (`callllc` below)
    test('a callee that reads a register only as an undeclared call’s licenses no block', () => {
      expect(lift('call_br')).toMatch(/the undeclared call to 'br6' at 0x[0-9a-f]+ fills a0..a3/);
    });

    test('a caller staging a word more than the callee loads (K&R) keeps its decline', () => {
      expect(lift('krmore')).toMatch(
        /the undeclared call to 'kr' at 0x[0-9a-f]+ fills a0..a3, and the word stored to 16\(sp\)/,
      );
    });

    test('a declaration wins over the body: a stated arity is laid out as stated', () => {
      expect(lift('call9', { nine: { params: 4 } })).toBe(
        's32 call9(s32 *a0) {\n    return nine(*a0, a0[1], a0[2], a0[3]);\n}\n',
      );
    });

    // `nine`'s words at 24..32(sp) are still in the area at `six`: the call that took them ends
    // them, as frontend/stackargs.ts's dataflow does on Thumb (`bodyBlockAgrees`)
    test('a wider call before a narrower one: each takes its own block', () => {
      expect(lift('wide_then_narrow')).toBe(
        's32 wide_then_narrow(s32 *a0, s32 *a1) {\n' +
          '    nine(*a0, a0[1], a0[2], a0[3], a0[4], a0[5], a0[6], a0[7], a0[8]);\n' +
          '    return six(*a1, a1[1], a1[2], a1[3], a1[4], a1[5]);\n}\n',
      );
    });

    test('…and where the wider call is made on one branch only', () => {
      expect(lift('wide_on_a_branch')).toBe(
        's32 wide_on_a_branch(s32 *a0, s32 a1) {\n' +
          '    if (a1 != 0) nine(*a0, a0[1], a0[2], a0[3], a0[4], a0[5], a0[6], a0[7], a0[8]);\n' +
          '    return six(*a0, a0[1], a0[2], a0[3], a0[4], a0[5]);\n}\n',
      );
    });

    // A call ends the words it took per STORE, not per value: a value `f5`/`f6` took and that is
    // stored again for the next call is staged for that call. Ended by value, the store of `x` to
    // 20(sp) for `g6` (which loads only 16(sp)) would be hidden, licensing `g6` one word short.
    test('a value one call took, stored again for the next, is staged for it', () => {
      for (const sym of ['restaged_higher', 'restaged_same_word']) {
        expect(lift(sym)).toMatch(/the undeclared call to 'g6' at 0x[0-9a-f]+ fills a0..a3/);
      }
      expect(lift('restaged_higher', { f5: { params: 5 } })).toMatch(
        /the undeclared call to 'g6' at 0x[0-9a-f]+ fills a0..a3/,
      );
      expect(lift('restaged')).toBe(
        's32 restaged(s32 a0) {\n    f5(1, 2, 3, 4, a0);\n    return f5(5, 6, 7, 8, a0);\n}\n',
      );
    });

    // O32 skips a3 (a1) for an 8-aligned argument and passes it at 16(sp): the callee's lift mints
    // the skipped register a parameter it never reads, and the caller never writes it (or parks a
    // temp there, on IDO). Licensed, the call would take that register as an argument.
    test('a callee whose 8-aligned argument skips a register licenses no block', () => {
      for (const sym of ['callts', 'callt1']) {
        expect(lift(sym)).toMatch(/has no prototype, a1 holds a value and a0 holds none/);
      }
      // KNOWN GAP, as on main: gcc reads `ll4(*a0, a0[1], a0[2])` there, dropping the stack words
      // (the guess cannot see past a3 where a3 is unwritten); never the skipped a3 or a parked temp
      for (const [sym, callee] of [
        ['callll', 'll4'],
        ['callllc', 'll4c'],
      ]) {
        expect(lift(sym)).not.toMatch(new RegExp(`${callee}\\([^)]*(a0\\[4\\]|\\ba3\\b)`));
      }
    });
  });
});

// A WORD STAGED ONCE BEFORE A LOOP is staged for its first iteration's call only: the call takes it,
// and nothing stores it again round the back edge. Hand-written (no compiler restages this way
// that the probes found), as is `f5w`, a callee that loads its stack word and writes it back. While
// the call is lowered, its own block met round the back edge holds no state yet, so the licence is
// judged again on the finished state (frontend/mips.ts `bodyLicences`), as frontend/stackargs.ts's
// fixpoint judges it on Thumb.
describe('O32: a stack word staged once before a loop', () => {
  const text = `
00000000 <f5w>:
   0:	addiu	sp,sp,-8
   4:	lw	v0,24(sp)
   8:	addiu	v1,v0,1
   c:	sw	v1,24(sp)
  10:	addu	a0,a0,a1
  14:	addu	a0,a0,a2
  18:	addu	a0,a0,a3
  1c:	addu	v0,a0,v0
  20:	jr	ra
  24:	addiu	sp,sp,8

00000028 <loopstalew>:
  28:	addiu	sp,sp,-32
  2c:	sw	ra,24(sp)
  30:	sw	s1,20(sp)
  34:	move	s1,a1
  38:	sw	a0,16(sp)
  3c:	li	a0,1
  40:	li	a1,2
  44:	li	a2,3
  48:	jal	0 <f5w>
  4c:	li	a3,4
  50:	addiu	s1,s1,-1
  54:	bnez	s1,3c <loopstalew+0x14>
  58:	nop
  5c:	lw	ra,24(sp)
  60:	lw	s1,20(sp)
  64:	jr	ra
  68:	addiu	sp,sp,32

0000006c <loopfresh>:
  6c:	addiu	sp,sp,-32
  70:	sw	ra,24(sp)
  74:	sw	s1,20(sp)
  78:	sw	s0,28(sp)
  7c:	move	s0,a0
  80:	move	s1,a1
  84:	sw	s0,16(sp)
  88:	li	a0,1
  8c:	li	a1,2
  90:	li	a2,3
  94:	jal	0 <f5w>
  98:	li	a3,4
  9c:	addiu	s1,s1,-1
  a0:	bnez	s1,84 <loopfresh+0x18>
  a4:	nop
  a8:	lw	ra,24(sp)
  ac:	lw	s1,20(sp)
  b0:	lw	s0,28(sp)
  b4:	jr	ra
  b8:	addiu	sp,sp,32
000000bc <looprot>:
  bc:	addiu	sp,sp,-32
  c0:	sw	ra,24(sp)
  c4:	sw	s1,20(sp)
  c8:	sw	s0,28(sp)
  cc:	move	s0,a0
  d0:	move	s1,a1
  d4:	sw	s0,16(sp)
  d8:	li	a0,1
  dc:	li	a1,2
  e0:	li	a2,3
  e4:	jal	0 <f5w>
  e8:	li	a3,4
  ec:	addiu	s1,s1,-1
  f0:	beqz	s1,100 <looprot+0x44>
  f4:	nop
  f8:	b	d8 <looprot+0x1c>
  fc:	sw	s0,16(sp)
 100:	lw	ra,24(sp)
 104:	lw	s1,20(sp)
 108:	lw	s0,28(sp)
 10c:	jr	ra
 110:	addiu	sp,sp,32

00000114 <loopstale2>:
 114:	addiu	sp,sp,-32
 118:	sw	ra,24(sp)
 11c:	sw	s1,20(sp)
 120:	move	s1,a1
 124:	sw	a0,16(sp)
 128:	li	a0,1
 12c:	li	a1,2
 130:	li	a2,3
 134:	jal	0 <f5w>
 138:	li	a3,4
 13c:	addiu	s1,s1,-1
 140:	beqz	s1,150 <loopstale2+0x3c>
 144:	nop
 148:	b	128 <loopstale2+0x14>
 14c:	nop
 150:	lw	ra,24(sp)
 154:	lw	s1,20(sp)
 158:	jr	ra
 15c:	addiu	sp,sp,32
`;
  const dump = `\nprobe.o:     file format elf32-tradbigmips\n\nSYMBOL TABLE:\n00000000 g     F .text\t00000028 f5w\n00000028 g     F .text\t00000044 loopstalew\n0000006c g     F .text\t00000050 loopfresh\n000000bc g     F .text\t00000058 looprot\n00000114 g     F .text\t0000004c loopstale2\n\n\nRELOCATION RECORDS FOR [.text]:\nOFFSET   TYPE              VALUE\n00000048 R_MIPS_26         f5w\n00000094 R_MIPS_26         f5w\n000000e4 R_MIPS_26         f5w\n00000134 R_MIPS_26         f5w\n\n\n`;
  describe.each(['ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const)('%s', (t) => {
    const lift = (sym: string): string => {
      try {
        return decompile(sym, text, TOOLCHAIN_TARGETS[t].description, {
          asmData: parseAsmData(dump, dump, dump, true),
        }).source;
      } catch (e) {
        return (e as Error).message;
      }
    };
    test("is not every iteration's argument: the call keeps a decline", () => {
      expect(lift('loopstalew')).toMatch(
        /the call to 'f5w' at 0x48 takes the 1 stack word\(s\) its callee's body loads, but the word at 16\(sp\) reaches it on some path already taken/,
      );
      expect(lift('loopstale2')).toMatch(/the undeclared call to 'f5w' at 0x134 fills a0..a3/);
    });
    test('stored again in the loop, before the call or on the back edge, it is', () => {
      for (const sym of ['loopfresh', 'looprot']) {
        expect(lift(sym)).toMatch(/do \{\n {8}v0 = f5w\(1, 2, 3, 4, a0\);/);
      }
    });
  });
});
