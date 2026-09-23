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
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { MIPS_IDO, PPC_MWCC } from '../src/target';

/** MIPS input needs addresses; the trailing `jr ra` closes the block. */
const mips = (insn: string) => `0:\t${insn}\n4:\tjr\tra\n8:\tnop\n`;
/** THE SECOND MIPS DIALECT, and the one that reads a project's own `asm/` tree. `frontend/splat.ts`
 *  normalises this into the same `DisasmInstr[]` the objdump parser yields, so every guard below it
 *  must hold on both — and a guard written against one spelling of a register holds on neither more
 *  than half the time. */
const splat = (insn: string) =>
  `glabel f\n/* 000000 80000000 460E6000 */  ${insn}\n/* 000004 80000004 03E00008 */  jr          $ra\n` +
  `/* 000008 80000008 00000000 */   nop\nendlabel f\n`;
const ppc = (insn: string) => `   0:\t${insn}\n   4:\tblr\n`;
const liftMips = (insn: string) => () => decompile('f', mips(insn), MIPS_IDO);
const liftSplat = (insn: string) => () => decompile('f', splat(insn), MIPS_IDO);
const liftPpc = (insn: string) => () => decompile('f', ppc(insn), PPC_MWCC);

describe('an instruction that touches the FPU is refused by the FILE it needs', () => {
  test.each([
    ['MIPS single-precision arithmetic', 'add.s\t$f0,$f12,$f14', '\\$f0, \\$f12, \\$f14', liftMips],
    ['MIPS double-precision arithmetic', 'add.d\t$f0,$f12,$f14', '\\$f0, \\$f12, \\$f14', liftMips],
    ['a MIPS format conversion', 'cvt.s.w\t$f6,$f4', '\\$f6, \\$f4', liftMips],
    // `ops[0]` is an FP register a destination-only test would also have caught — but the operand
    // this one must not lose is the SOURCE, and the two shapes below pin that.
    ['a MIPS FPU load', 'lwc1\t$f0,0(a1)', '\\$f0', liftMips],
    // …AND THE REGISTER LIST IS A SET. `fadds f1,f1,f2` reads two registers and writes one of
    // them; an undeduped filter published `(f1, f1, f2)` in five markers of the committed
    // artifact, which reads as three registers in a file the reader is being told does not exist.
    ['PowerPC single-precision arithmetic', 'fadds   f1,f1,f2', 'f1, f2', liftPpc],
    ['a PowerPC FPU load', 'lfs     f1,0(r4)', 'f1', liftPpc],
    ['a PowerPC float move', 'fmr     f0,f2', 'f0, f2', liftPpc],
  ])('%s', (_label, insn, regs, lift) => {
    const run = lift(insn);
    expect(run).toThrow(/unmodelled floating-point instruction/);
    expect(run).toThrow(new RegExp(`floating-point register file \\(${regs}\\)`));
  });
});

describe('…on BOTH MIPS dialects, which spell the same register two ways', () => {
  // The objdump cases above all carry the `$` sigil, and a predicate that REQUIRES it is green on
  // every one of them while matching nothing in a Splat tree — where `isMipsReg` then ACCEPTS the
  // bare `f12`, builds an opaque on a register in a file nothing models, and reports the whole gap
  // one pass later as an unresolvable value. That is the exact defect this file is named after,
  // surviving on the dialect that reads the 24,327 functions `docs/floating-point.md` prices.
  //
  // The fix is in the READER, not in the predicate: objdump writes a GPR bare and an FPU register
  // with the sigil, so `frontend/splat.ts` keeps the sigil on an FPU register and strips it
  // everywhere else — which is what its own header promises ("normalises that dialect into the SAME
  // `DisasmInstr[]` the objdump parser yields"). Each case below is red if it strips it.
  test.each([
    ['numbered arithmetic', 'add.s       $f0, $f12, $f14', '\\$f0, \\$f12, \\$f14'],
    // THE ABI SPELLING, which objdump never prints and the `af`/`marioparty3` trees use throughout.
    ['ABI-named arithmetic', 'add.s       $ft2, $ft2, $ft3', '\\$ft2, \\$ft3'],
    ['an FPU load', 'lwc1        $fv0, 0($a1)', '\\$fv0'],
    ['an FPU store, ahead of the store-class arm', 'swc1        $fa0, 0($a1)', '\\$fa0'],
    ['a move out of the file', 'mfc1        $v0, $fs0', '\\$fs0'],
    // THE ODD HALF OF A DOUBLE-PRECISION PAIR, whose o32 ABI name takes a trailing `f` — so the
    // DIGIT IS NOT LAST, and a predicate anchored `\d+$` matches none of these while matching every
    // line above it. That is one spelling of one dialect, and missing it brings back all three of
    // the messages this file exists to remove, one per shape: the arithmetic and the moves report
    // an unresolvable value a pass later, the store reports the memory it writes.
    //
    // `mtc1 $at, $ft0f` is not a constructed input: it is the line at `af/asm/jp/boot/libc64/fp.s`
    // 164 and 190, and `$ft2f`/`$ft4f`/`$fa1f` are four more in `af/asm/jp/code/speed_meter.s`.
    // `grep -rnE '\$f[a-z]+[0-9]+f\b' apps/benchmark/checkouts/*/asm` finds all six and nothing
    // else; the corpus has none, so only these tests referee it.
    ['odd-half arithmetic', 'add.d       $ft0f, $ft0f, $ft2f', '\\$ft0f, \\$ft2f'],
    ['an odd-half FPU store, ahead of the store-class arm', 'swc1        $ft0f, 0($a1)', '\\$ft0f'],
    ['an odd-half move out of the file', 'mfc1        $v0, $fs0f', '\\$fs0f'],
  ])('%s', (_label, insn, regs) => {
    const run = liftSplat(insn);
    expect(run).toThrow(/unmodelled floating-point instruction/);
    expect(run).toThrow(new RegExp(`floating-point register file \\(${regs}\\)`));
  });

  // THE SHAPE THAT WRITES THE WRONG REGISTER, and the reason an odd-half miss is worse than a
  // mis-named decline. `mtc1 rt, fs` writes `fs`: `ops[0]` is the instruction's SOURCE, so an
  // unmodelled `mtc1` that slips past the FP arm fabricates an opaque destination on `$at` — a
  // register it only reads — and the gap surfaces as an unresolvable value with no FPU in it.
  test('a move INTO the file names the file, not the GPR it reads', () => {
    const run = liftSplat('mtc1        $at, $ft0f');
    expect(run).toThrow(/unmodelled floating-point instruction 'mtc1'/);
    expect(run).toThrow(/floating-point register file \(\$ft0f\)/);
    expect(run).not.toThrow(/unresolvable value/);
  });

  // ONE PREDICATE, NOT TWO THAT AGREE TODAY. The reader decides which tokens still carry a sigil
  // when the frontend's policy sees them, so the two are SEQUENCED: widen `mips.ts` alone and
  // nothing changes, because `splat.ts` has already stripped the token; widen `splat.ts` alone and
  // the token arrives with a sigil the frontend's own predicate rejects. Each half is green on its
  // own and the pair is the bug, which is why this counts copies in the source rather than
  // comparing behaviour.
  test('the reader and the frontend share one FP-register predicate', () => {
    const dir = new URL('../src/frontend/', import.meta.url);
    const withLiteral = readdirSync(dir).filter((f) => /\$f\[vats\]/.test(readFileSync(new URL(f, dir), 'utf8')));
    expect(withLiteral).toEqual(['splat.ts']);
    expect(readFileSync(new URL('mips.ts', dir), 'utf8')).toContain('fpReg: MIPS_FP_REG');
  });

  // THE OTHER HALF, and the reason the sigil is required rather than optional. Making it optional
  // covers the Splat dialect too — and an objdump BRANCH TARGET is bare lower-case hex, so `f0`,
  // `f4` and `fa0` are addresses a sigil-less pattern reads as FP registers. The committed
  // artifact carries three, on `bc1fl`, `bgez` and `beqzl`; the count moves with the corpus and
  // nothing gates it, so it is the SHAPE that is the argument and the command is here rather than
  // a figure to be trusted:
  //
  //   node -e "const R=require('./apps/benchmark/results/results.json').results;
  //   const MN=/^\s*[0-9a-f]+:\t([a-z][\w.]*)\s+(.*)$/; const ex=new Set();
  //   for(const r of R){if(!/:(gcc2\.7\.2kmc|ido7\.1)$/.test(r.id))continue;
  //   for(const l of (r.targetAsm||'').split('\n')){const m=MN.exec(l); if(!m)continue;
  //   for(const o of m[2].split(/[,()\s]+/)) if(/^f[vats]?[0-9]+f?$/i.test(o)) ex.add(m[1]+' '+o);}}
  //   console.log(ex.size,[...ex])"
  //
  // Every one sits on a control transfer that refuses a guard earlier, so the input below is the
  // shape rather than a listing anyone has: an unmodelled non-branch instruction with a bare `f4`
  // where the predicate can reach it.
  test('a bare lower-case hex token is an ADDRESS, not a register', () => {
    const run = liftMips('teqi\tv0,f4');
    expect(run).toThrow(/unmodelled instruction 'teqi'/);
    expect(run).not.toThrow(/floating-point/);
  });

  // `$fp` is the FRAME POINTER — the one GPR whose ABI name starts with `f`, and the whole reason
  // the predicate requires a digit after the optional file letter.
  test('the frame pointer is not a floating-point register', () => {
    const run = liftSplat('swl         $fp, 0($a1)');
    expect(run).toThrow(/unmodelled store-class instruction 'swl'/);
    expect(run).not.toThrow(/floating-point/);
  });
});

describe('a PowerPC branch target is an ADDRESS, and the FP predicate has no sigil to tell it', () => {
  // The MIPS half requires a `$` because objdump writes a branch target as bare lower-case hex.
  // PowerPC prints an FPU register the same way (`fadds f1,f1,f2`), so `ppc.ts` cannot require one
  // — and `b f8` is an address that `/^f\d+$/` matches. Nothing in the predicate stops it; what
  // does is that no `b*` mnemonic reaches `opaqueDest` at all. Either it is an `isModeledBranch`
  // form, decoded as a transfer or a call, or the whole-function control-transfer pre-pass refuses
  // it before any block is filled. Each row below carries an operand the FP predicate matches and
  // must still be refused for its control flow; they go red if the FPU check is ever hoisted into a
  // pre-pass of its own ahead of that one.
  test.each([
    ['a conditional branch to a hex target', 'bge     f0'],
    ['an absolute branch', 'bca     f4'],
    ['a CTR-counted loop', 'bdnz    f8'],
    ['a branch to the link register', 'bclr    4,f4'],
  ])('%s', (_label, insn) => {
    const run = liftPpc(insn);
    expect(run).toThrow(/unmodelled control transfer/);
    expect(run).not.toThrow(/floating-point/);
  });

  // THE OTHER SIDE, so the four above are not passing because every PPC input throws that message:
  // a non-branch instruction with the same operand DOES reach the predicate and is named by the
  // file. No disassembler prints this line — a PowerPC immediate is decimal or `0x`-prefixed, and
  // bare hex is a branch target — which is exactly why the rows above are the argument and this one
  // is only the control.
  test('a non-branch instruction with an fN operand still names the file', () => {
    expect(liftPpc('tw      4,r3,f4')).toThrow(/floating-point register file \(f4\)/);
  });
});

describe('an FPU instruction that names no FP register is refused by the file too', () => {
  // A REGISTER-NAME PREDICATE CANNOT SEE THESE, and they are not a rounding error: the FPU control
  // moves are MIPS I/II's float→int rounding-mode dance, 593 sites in 61 functions across the
  // `marioparty3` and `af` trees (`grep -hoE '\*/[[:space:]]+(cfc1|ctc1)[[:space:]]'`). They spell
  // the control register `$31`, which is a GPR-shaped token, so before `fpControl` they fell to the
  // generic arms — and `docs/probes/fp-demand.awk` counted them as floating point while core did
  // not, one measurement disagreeing with the predicate it was measuring.
  //
  // `ctc1`'s FIRST operand is the instruction's SOURCE (objdump spells it `ctc1 rt, fs`), so the
  // generic path also fabricated an opaque destination on a register it only reads — the same
  // mis-modelling this file already fixed one mnemonic over, for `mtc1`.
  test.each([
    ['a MIPS read of the FPU control register', 'cfc1\tv0,$31', liftMips],
    ['a MIPS write to the FPU control register', 'ctc1\tv0,$31', liftMips],
    ['a PowerPC FPSCR field write', 'mtfsfi  7,0', liftPpc],
    ['a PowerPC FPSCR bit clear', 'mtfsb0  31', liftPpc],
    ['a PowerPC FPSCR bit set', 'mtfsb1  31', liftPpc],
    ['a PowerPC FPSCR move to cr', 'mcrfs   cr0,cr1', liftPpc],
  ])('%s', (_label, insn, lift) => {
    const run = lift(insn);
    expect(run).toThrow(/unmodelled floating-point instruction/);
    expect(run).toThrow(/floating-point control register, which this frontend does not model/);
    // The three messages it must not fall back to — one per arm it used to reach.
    expect(run).not.toThrow(/no register destination to degrade/);
    expect(run).not.toThrow(/unresolvable value/);
    expect(run).not.toThrow(/store-class/);
  });

  // The moves that DO name a data register stay `fpReg`'s, so a mnemonic list is not creeping back
  // in: this pair would be red if `fpControl` claimed them, because the message would stop naming
  // the registers.
  test.each([
    ['mfc1', 'mfc1\tv0,$f12', /register file \(\$f12\)/, liftMips],
    ['mffs', 'mffs    f0', /register file \(f0\)/, liftPpc],
  ])("'%s' names the file it reads, not the control register", (_label, insn, want, lift) => {
    expect(lift(insn)).toThrow(want);
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
