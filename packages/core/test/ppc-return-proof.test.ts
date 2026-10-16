// EVERY PowerPC RETURN JUMPS THROUGH THE CALLER'S RETURN ADDRESS, or the lift declines
// (`linkRegisterProof`, frontend/ppc.ts). `blr` is a return by its name alone, so a function that
// put anything else in the link register first — hand-written asm; no compiler emits it — lifted
// as a C `return` that jumps somewhere else. Each shape below lifted wrong C on all three mwcc
// builds before the proof (`li r3,7; mtlr r4; blr` was `return 7;`).
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { type ToolchainId, targetFor } from '../src/target';

/** The three CodeWarrior builds, each at flags one of its rows compiles with. */
const BUILDS: Array<[ToolchainId, string[]]> = [
  ['mwcc_242_81', ['-O4,p']],
  ['mwcc_233_163n', ['-O4,p']],
  ['mwcc_247_107', ['-O0,p']],
];

/** Number `lines` from 0 in steps of 4; `@` in a line stands for its own address, which a call's
 *  relocation names. */
const listing = (name: string, ...lines: string[]) =>
  `0 <${name}>:\n` +
  lines.map((l, i) => `${(i * 4).toString(16)}:\t${l.replaceAll('@', (i * 4).toString(16))}\n`).join('');
const bl = (sym: string) => `bl      @ <x+0x@>\n\t\t\t@: R_PPC_REL24\t${sym}`;

const NOT_THROUGH_LR = /may not return through the caller's link register/;

describe.each(BUILDS)('on %s', (tc, flags) => {
  const { target } = targetFor(tc, flags);
  const lift = (name: string, ...lines: string[]) => decompile(name, listing(name, ...lines), target).source;

  test('a return through a register that is not the return address declines', () => {
    // `retmtlr`: an argument moved into the link register
    expect(() => lift('retmtlr', 'li      r3,7', 'mtlr    r4', 'blr')).toThrow(
      /the 'blr' at 0x8 may not return through the caller's link register — on some path the 'mtlr' at 0x4 put r4 there/,
    );
    // `p_argtail`: a jump through the first argument, lifted `void p_argtail(void) { return; }`
    expect(() => lift('p_argtail', 'mtlr    r3', 'blr')).toThrow(NOT_THROUGH_LR);
    // `p_loadlr`: a word loaded from memory
    expect(() => lift('p_loadlr', 'lwz     r0,0(r3)', 'mtlr    r0', 'li      r3,7', 'blr')).toThrow(NOT_THROUGH_LR);
    // `p_skipret`: the return address, moved on a word — returns past the caller's next instruction
    expect(() => lift('p_skipret', 'mflr    r0', 'addi    r0,r0,4', 'mtlr    r0', 'li      r3,7', 'blr')).toThrow(
      NOT_THROUGH_LR,
    );
  });

  test('an `mtlr` on one path only declines at the join', () => {
    expect(() =>
      decompile(
        'p_condlr',
        '0 <p_condlr>:\n0:\tcmpwi   r3,0\n4:\tbeq-    c <p_condlr+0xc>\n8:\tmtlr    r4\nc:\tli      r3,7\n10:\tblr\n',
        target,
      ),
    ).toThrow(/the 'blr' at 0x10 may not return through the caller's link register — on some path the 'mtlr' at 0x8/);
  });

  test('a call whose return address nothing put back declines', () => {
    // `p_leafbl`: lifted `ext(); return 7;`, a return to the instruction after the `bl`
    expect(() => lift('p_leafbl', bl('ext'), 'li      r3,7', 'blr')).toThrow(
      /the 'blr' at 0x8 may not return through the caller's link register — the 'bl' at 0x0 overwrote it/,
    );
    // a conditional return after a call is asked the same
    expect(() => lift('condret', bl('ext'), 'cmpwi   r3,0', 'beqlr-', 'li      r3,7', 'blr')).toThrow(
      /the 'beqlr' at 0x8 may not return through the caller's link register/,
    );
    // the address saved, but the frame pushed AFTER the call: the callee saves its own return address
    // in that very word, the caller's link-register save word
    expect(() =>
      lift('early', 'mflr    r0', 'stw     r0,4(r1)', bl('ext'), 'lwz     r0,4(r1)', 'mtlr    r0', 'blr'),
    ).toThrow(/the 'blr' at 0x14 may not return through the caller's link register — on some path the 'mtlr' at 0x10/);
    // a reload of a word that is not the save word, and the save word overwritten between the save
    // and the reload: the frame model refuses both before the proof is asked
    expect(() =>
      lift(
        'otherword',
        'stwu    r1,-16(r1)',
        'mflr    r0',
        'stw     r0,20(r1)',
        bl('ext'),
        'lwz     r0,8(r1)',
        'mtlr    r0',
        'addi    r1,r1,16',
        'blr',
      ),
    ).toThrow(/reload of a stack local \('8\(r1\)'\)/);
    expect(() =>
      lift(
        'clobbered',
        'stwu    r1,-16(r1)',
        'mflr    r0',
        'stw     r0,20(r1)',
        bl('ext'),
        'stw     r3,20(r1)',
        'lwz     r0,20(r1)',
        'mtlr    r0',
        'addi    r1,r1,16',
        'blr',
      ),
    ).toThrow(/'20\(r1\)' at 0x10 is a word this function both saves a register in and stores a value to/);
  });

  test("mwcc's own saves of the return address are returns", () => {
    // 2.4.x: the push, then the save at N+4(r1) (`p_good`)
    expect(
      lift(
        'p_good',
        'stwu    r1,-16(r1)',
        'mflr    r0',
        'stw     r0,20(r1)',
        bl('ext'),
        'addi    r3,r3,1',
        'lwz     r0,20(r1)',
        'mtlr    r0',
        'addi    r1,r1,16',
        'blr',
      ),
    ).toContain('return ext() + 1;');
    // 2.3.3: the save at 4(r1) BEFORE the push, the reload at N+4(r1) after it, with `stmw`/`lmw`
    expect(
      lift(
        'stmw',
        'mflr    r0',
        'stw     r0,4(r1)',
        'stwu    r1,-24(r1)',
        'stmw    r30,16(r1)',
        'mr      r30,r3',
        bl('ext'),
        'add     r3,r3,r30',
        'lmw     r30,16(r1)',
        'lwz     r0,28(r1)',
        'addi    r1,r1,24',
        'mtlr    r0',
        'blr',
      ),
    ).toMatch(/return ext\(a0\) \+ a0;/);
    // the register save routines write the link register too, after the address is copied out
    expect(
      lift(
        'routines',
        'stwu    r1,-32(r1)',
        'mflr    r0',
        'stw     r0,36(r1)',
        'addi    r11,r1,32',
        bl('_savegpr_30'),
        'mr      r30,r3',
        bl('ext'),
        'add     r3,r3,r30',
        'addi    r11,r1,32',
        bl('_restgpr_30'),
        'lwz     r0,36(r1)',
        'mtlr    r0',
        'addi    r1,r1,32',
        'blr',
      ),
    ).toMatch(/return ext\(a0\) \+ a0;/);
    // a leaf never names the link register, and a conditional return in it is one too
    expect(lift('leaf', 'cmpwi   r3,0', 'beqlr-', 'li      r3,7', 'blr')).toContain('return 7;');
  });
});
