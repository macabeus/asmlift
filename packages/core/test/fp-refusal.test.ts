// A refusal that names the floating-point REGISTER FILE, on the two ISAs that have one.
//
// asmlift models no floating-point registers at all: no value kind holds a float, no ABI home
// receives one, no C spelling prints one. Every instruction that touches the file therefore
// declines — which was already true and is not what these tests are about. What they pin is WHICH
// capability the decline names, because before `fpReg` the same missing file surfaced under three
// different messages chosen by the SHAPE of the instruction rather than by the gap:
//
//   * `add.s $f0,$f12,$f14` and `fadds f1,f1,f2` -> "no register destination to degrade", because
//     `isMipsReg` and PPC's `isReg` both reject an FP token. The message is literally false: the
//     instruction has a destination, in a file this frontend cannot see.
//   * `swc1 $f0,144(v0)` and `stfs f1,0(r3)` -> "unmodelled store-class instruction", i.e. named by
//     the memory they move a float TO.
//   * `mfc1 v0,$f12` -> nothing here at all. Its destination IS a GPR, so an opaque was built whose
//     source list quietly dropped `$f12`, and the decline arrived a pass later as an unresolvable
//     value.
//
// Three spellings for one gap is how a reader counts three gaps, and the web report's decline table
// had to re-derive "is this floating point?" from a forty-mnemonic regex spanning two of the three
// message prefixes — a mechanism duplicated in another package because core never said it.
//
// Each test below is written so that the WRONG answer fails it: the predicate being too narrow
// (destination-only), too wide (catching an integer store), or consulted in the wrong order (after
// `storeClass`) each turns one of these red. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { MIPS_IDO, PPC_MWCC } from '../src/target';

/** MIPS input needs addresses; the trailing `jr ra` closes the block. */
const mips = (insn: string) => `0:\t${insn}\n4:\tjr\tra\n8:\tnop\n`;
const ppc = (insn: string) => `   0:\t${insn}\n   4:\tblr\n`;
const liftMips = (insn: string) => () => decompile('f', mips(insn), MIPS_IDO);
const liftPpc = (insn: string) => () => decompile('f', ppc(insn), PPC_MWCC);

describe('an instruction that touches the FPU is refused by the FILE it needs', () => {
  test.each([
    ['MIPS single-precision arithmetic', 'add.s\t$f0,$f12,$f14', '\\$f0, \\$f12, \\$f14', liftMips],
    ['MIPS double-precision arithmetic', 'add.d\t$f0,$f12,$f14', '\\$f0, \\$f12, \\$f14', liftMips],
    ['a MIPS format conversion', 'cvt.s.w\t$f6,$f4', '\\$f6, \\$f4', liftMips],
    // `ops[0]` is an FP register a destination-only test would also have caught — but the operand
    // this one must not lose is the SOURCE, and the two shapes below pin that.
    ['a MIPS FPU load', 'lwc1\t$f0,0(a1)', '\\$f0', liftMips],
    ['PowerPC single-precision arithmetic', 'fadds   f1,f1,f2', 'f1, f1, f2', liftPpc],
    ['a PowerPC FPU load', 'lfs     f1,0(r4)', 'f1', liftPpc],
    ['a PowerPC float move', 'fmr     f0,f2', 'f0, f2', liftPpc],
  ])('%s', (_label, insn, regs, lift) => {
    const run = lift(insn);
    expect(run).toThrow(/unmodelled floating-point instruction/);
    expect(run).toThrow(new RegExp(`floating-point register file \\(${regs}\\)`));
  });
});

describe('the predicate reads every operand, not the destination', () => {
  // THE TWO SHAPES THAT DECIDE IT, one on each side of `isReg`.
  //
  // `fcmpo cr0,f1,f2` writes a CONDITION register: `ops[0]` is not an FP register and a
  // destination-only test files it under "no register destination to degrade", the message about
  // the one operand that is not the problem.
  test('a PowerPC float compare, whose destination is a condition register', () => {
    const run = liftPpc('fcmpo   cr0,f1,f2');
    expect(run).toThrow(/unmodelled floating-point instruction 'fcmpo'/);
    expect(run).toThrow(/floating-point register file \(f1, f2\)/);
  });

  // `mfc1 v0,$f12` is the opposite: a destination `isMipsReg` ACCEPTS. A destination-only test
  // never fires, an opaque is built on `v0`, and `$f12` — the register the instruction actually
  // read — is dropped from its source list, so the decline arrives later and names a value rather
  // than the file.
  test('a MIPS move OUT of the FPU, whose destination is an ordinary GPR', () => {
    const run = liftMips('mfc1\tv0,$f12');
    expect(run).toThrow(/unmodelled floating-point instruction 'mfc1'/);
    expect(run).toThrow(/floating-point register file \(\$f12\)/);
  });
});

describe('it is consulted ahead of the store-class arm', () => {
  // An FPU store is BOTH: `mips.ts` lists `swc1|sdc1` in its `storeClass` and `ppc.ts`'s `^st`
  // covers `stfs`/`stfd`. Ordered after `storeClass` these two keep the memory-write message, which
  // is true and names the wrong capability — the store is unmodelled BECAUSE the file is. Both go
  // red if the arm moves below it.
  test.each([
    ['a MIPS FPU store', 'swc1\t$f0,144(v0)', '\\$f0', liftMips],
    ['a MIPS double FPU store', 'sdc1\t$f0,8(v0)', '\\$f0', liftMips],
    ['a PowerPC single store', 'stfs    f1,0(r3)', 'f1', liftPpc],
    ['a PowerPC double store', 'stfd    f31,48(r1)', 'f31', liftPpc],
  ])('%s', (_label, insn, reg, lift) => {
    const run = lift(insn);
    expect(run).toThrow(/unmodelled floating-point instruction/);
    expect(run).toThrow(new RegExp(`floating-point register file \\(${reg}\\)`));
    expect(run).not.toThrow(/store-class/);
  });
});

describe('and it takes nothing that is not floating point', () => {
  // The other half of the split. A predicate wide enough to catch these would make the new message
  // a second catch-all, which is the defect it exists to undo. Each of these is an unmodelled
  // instruction whose gap is something else entirely.
  test.each([
    ['a MIPS unaligned store', 'swl\tv0,0(a1)', /unmodelled store-class instruction 'swl'/, liftMips],
    ['a PowerPC byte-reversed store', 'stwbrx  r3,r4,r5', /unmodelled store-class instruction 'stwbrx'/, liftPpc],
    ['a MIPS system call', 'syscall', /unmodelled effect instruction 'syscall'/, liftMips],
    ['a PowerPC storage barrier', 'sync', /unmodelled effect instruction 'sync'/, liftPpc],
    // `$12` is a numeric GPR and `$f\d+` must not reach it — the `$` is not the tell, the `f` is.
    ['a MIPS CP0 write', 'mtc0\tzero,$12', /unmodelled effect instruction 'mtc0'/, liftMips],
  ])('%s keeps its own message', (_label, insn, want, lift) => {
    expect(lift(insn)).toThrow(want);
    expect(lift(insn)).not.toThrow(/floating-point register file/);
  });

  // The control the whole split rests on: an instruction this frontend DOES model still lifts. A
  // predicate applied before the decode switch, rather than inside the unmodelled path, would take
  // this one too.
  test('a modelled integer load is untouched', () => {
    expect(decompile('f', '0:\tlw\tv0,0(a0)\n4:\tjr\tra\n8:\tnop\n', MIPS_IDO).source).toContain('*a0');
  });
});
