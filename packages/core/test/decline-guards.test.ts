// Loud-decline guards — regression net for proven silent-miscompile classes: wrong-symbol emit
// (function selection), dropped side-effect instructions, the falls-off-the-end TypeError,
// demangle length-prefix overruns, and the traced tower's unknown-pass crash. Each case must
// decline loud or produce the RIGHT output — never confident wrong output or a crash.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { sliceSymbol } from '../src/frontend/disasm';
import { FrontendUnsupportedError } from '../src/frontend/errors';
import { demangle } from '../src/mangle';
import { decompile } from '../src/pipeline';
import { PRE_RECOVERY_PASSES } from '../src/raise/pre-recovery';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';
import { decompileTraced } from '../src/trace';

const THUMB_TWO =
  '\t.code\t16\n\t.globl\tone\n\t.thumb_func\none:\n\tmov\tr0, #1\n\tbx\tlr\n' +
  '\t.globl\ttwo\n\t.thumb_func\ntwo:\n\tmov\tr0, #2\n\tbx\tlr\n';
const THUMB_DATA_FIRST =
  '\t.globl\tgTable\ngTable:\n\t.word\t1\n' +
  '\t.globl\thalf\n\t.thumb_func\nhalf:\n\tlsr\tr1, r0, #31\n\tadd\tr0, r0, r1\n\tasr\tr0, r0, #1\n\tbx\tlr\n';
const MIPS_TWO =
  '00000000 <add1>:\n   0:\tjr\tra\n   4:\taddiu\tv0,a0,1\n\n' +
  '00000008 <add2>:\n   8:\tjr\tra\n   c:\taddiu\tv0,a0,2\n';

test('thumb: the requested name selects ITS function, never the first one', () => {
  expect(decompile('one', THUMB_TWO, ARMV4T_AGBCC).source).toBe('s32 one(void) {\n    return 1;\n}\n');
  expect(decompile('two', THUMB_TWO, ARMV4T_AGBCC).source).toBe('s32 two(void) {\n    return 2;\n}\n');
});

test('thumb: a name that is no function label declines loud (multi-function + data-label cases)', () => {
  expect(() => decompile('absent', THUMB_TWO, ARMV4T_AGBCC)).toThrow(FrontendUnsupportedError);
  expect(() => decompile('absent', THUMB_TWO, ARMV4T_AGBCC)).toThrow(/functions present: one, two/);
  // a DATA label must never be decompiled as if it named the function's code
  expect(() => decompile('gTable', THUMB_DATA_FIRST, ARMV4T_AGBCC)).toThrow(/label here but not a function/);
  expect(decompile('half', THUMB_DATA_FIRST, ARMV4T_AGBCC).source).toBe('s32 half(s32 a0) {\n    return a0 / 2;\n}\n');
});

test('objdump: sliceSymbol cuts one function (delay slots intact), declines on an absent symbol', () => {
  expect(decompile('add1', MIPS_TWO, MIPS_IDO).source).toBe('s32 add1(s32 a0) {\n    return a0 + 1;\n}\n');
  expect(decompile('add2', MIPS_TWO, MIPS_IDO).source).toBe('s32 add2(s32 a0) {\n    return a0 + 2;\n}\n');
  expect(() => decompile('ghost', MIPS_TWO, MIPS_IDO)).toThrow(/symbol 'ghost' not found .* add1, add2/);
  // headerless fragments pass through unchanged (the raw-fragment contract)
  const frag = '   0:\tjr\tra\n   4:\taddiu\tv0,a0,7\n';
  expect(sliceSymbol(frag, 'anything')).toBe(frag);
});

test('a side-effect-only unmodelled instruction declines loud, never silently vanishes', () => {
  const swi = '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tswi\t5\n\tbx\tlr\n';
  expect(() => decompile('f', swi, ARMV4T_AGBCC)).toThrow(/unmodelled effect instruction 'swi'/);
  const annotated = decompile('f', swi, ARMV4T_AGBCC, { onGap: 'annotate' });
  expect(annotated.source).toContain('ASMLIFT_ERROR');
  expect(annotated.diagnostics.some((d) => d.reason.includes('swi'))).toBe(true);
});

test('control falling off the end declines loud, never a TypeError', () => {
  const noRet = '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tmov\tr0, #1\n';
  expect(() => decompile('f', noRet, ARMV4T_AGBCC)).toThrow(/falls off the end/);
});

test('demangle: a length prefix that overruns the symbol is a plain C name, not a fabricated class', () => {
  expect(demangle('map__Fill16')).toBeNull(); // param `16` overruns → null, not base:""
  expect(demangle('x__99AbFv')).toBeNull(); // class qualifier overrun → null
  expect(demangle('dot__3VecFP3Vec')).toEqual({
    // real mangled names still parse
    name: 'dot',
    cls: 'Vec',
    params: [{ base: 'Vec', ptr: 1 }],
  });
});

test('decompileTraced survives a pre-recovery pass with no registered trace strings', () => {
  const HALF =
    '\t.code\t16\n\t.globl\thalf\n\t.thumb_func\nhalf:\n\tlsr\tr1, r0, #31\n\tadd\tr0, r0, r1\n\tasr\tr0, r0, #1\n\tbx\tlr\n';
  PRE_RECOVERY_PASSES.push({
    id: 'future-pass',
    dce: false,
    run: () => true,
  } as unknown as (typeof PRE_RECOVERY_PASSES)[number]);
  try {
    const { source, report } = decompileTraced('half', HALF, ARMV4T_AGBCC);
    expect(source).toBe(decompile('half', HALF, ARMV4T_AGBCC).source); // headline parity holds
    expect(report.trace.some((s) => s.id === 'stage:future-pass')).toBe(true);
  } finally {
    PRE_RECOVERY_PASSES.pop();
  }
});

test('the annotate stub carries a machine-readable declineReason', () => {
  const { report } = decompileTraced('mystery', 'not assembly\n', ARMV4T_AGBCC, { onGap: 'annotate' });
  expect(report.trace).toEqual([]);
  expect(report.declineReason).toBeTruthy();
});

// ── sp-as-data: the WHOLE class declines, not one spelling at a time ──────────────────────
// asmlift's own silent-miscompile hazard, and the reason this belongs in this file: `sp` is never
// WRITTEN, so a frontend that let it be read as data would have Braun SSA materialize it as a
// fabricated PHANTOM PARAMETER — a function of the wrong arity returning the wrong argument
// (thumb.ts's readData and mips.ts's never-stored-slot check each say so at their guard). Every
// frontend therefore refuses the whole class up front rather than the shapes it happens to know.
//
// The sweep exists because "the whole class" is only worth anything if it stays true for every
// spelling: the register-indexed load and its store dual, a plain `[sp, #N]` slot, `&local`. It was
// prompted by m2c hitting the register-indexed case (`ldr rX, [sp, rY]` tripped an
// `assert isinstance(addend, AsmLiteral)` in its stack-frame model, upstream ef34aff) — a case
// asmlift refuses not by knowing about it but by never having entered the class.
//
// asmlift has no GENERAL stack-frame model, but two deliberately narrow partial ones, and both are
// covered below. MIPS models word `sp` SLOTS (a spill/reload pair is one SSA variable), so its
// contract is narrower: every access the word-slot model cannot honour must decline. PPC elides
// callee-saved save/restore slots, and is the one frontend with a register-indexed addressing mode
// (`lwzx`/`stwx`) — the exact structural analogue of m2c's case, and covered in ppc-frontend.test.ts
// beside its sibling r1 guards (its decline message names the register, so it does not share the
// regex below).
test('every sp-as-data spelling declines loud — including the register-indexed load', () => {
  const thumb = (body: string) => () =>
    decompile('f', `\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n${body}\tbx\tlr\n`, ARMV4T_AGBCC);
  const spAsData = /stack pointer used as data/;
  expect(thumb('\tldr\tr0, [sp, r1]\n')).toThrow(spAsData); // m2c's crash case
  expect(thumb('\tstr\tr0, [sp, r1]\n')).toThrow(spAsData); // its store dual
  expect(thumb('\tldr\tr0, [sp, #4]\n')).toThrow(spAsData); // the literal slot m2c handles
  expect(thumb('\tadd\tr0, sp, #8\n')).toThrow(spAsData); // &local
  // …and the ONE sp shape that is not a data use: `sp = sp ± IMMEDIATE`. Two producers spell it two
  // ways and asmlift reads both — disassemblers emit `add sp, #N` (klonoa's asm/: 203 of them, 0
  // three-operand), agbcc emits `add sp, sp, #N` (its own build/src/*.s: 98, 0 two-operand). Both
  // are push/pop-based bookkeeping carrying no dataflow, so both lift.
  expect(thumb('\tadd\tsp, sp, #-0x4\n\tmov\tr0, #1\n\tadd\tsp, sp, #0x4\n')).not.toThrow();
  expect(thumb('\tsub\tsp, sp, #0x8\n\tmov\tr0, #1\n\tadd\tsp, sp, #0x8\n')).not.toThrow();
  expect(thumb('\tadd\tsp, #-0x4\n\tmov\tr0, #1\n\tadd\tsp, #0x4\n')).not.toThrow();
  expect(thumb('\tadd\tsp, sp, #0\n')).not.toThrow(); // N=0: must not fall into the copy idiom
  expect(thumb('\tadd\tr13, r13, #-0x4\n\tadd\tr13, r13, #0x4\n')).not.toThrow(); // r13 spelling
  // a frame that is ADJUSTED and then USED still declines: the adjustment is transparent, the
  // access is not. This is the line that keeps the guard from becoming "ignore sp".
  //
  // …with ONE case carved out since: a WORD access wholly inside the function's own frame, when
  // that frame is provably private and does not move, is a local slot and is modelled in SSA
  // (`sp@<off>`, as on MIPS). The store below is a spill nothing reloads, so it is dead and drops.
  // The carve-out is the word-slot model and nothing more — every spelling it cannot vouch for is
  // still on this list.
  expect(thumb('\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n')).not.toThrow();
  // `mov r0, sp` is now the address-taken-local CAPTURE (laddr); with nothing ever dereferencing
  // or escaping the address usefully, the frame-object audit still declines — loud, with the
  // attributed reason, because a guessed object type is the plausible-but-wrong class.
  expect(thumb('\tadd\tsp, sp, #-0x4\n\tmov\tr0, sp\n\tadd\tsp, sp, #0x4\n')).toThrow(/address-taken stack local/);
  // a slot OUTSIDE the frame is not a local — above the top is the caller's, and a store there is
  // still a decline (recovering it is a separate capability from reading an incoming argument)
  expect(thumb('\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp, #0x8]\n\tadd\tsp, sp, #0x4\n')).toThrow(spAsData);
  // EVERY other write to sp declines. Each of these used to vanish silently, taking a real frame
  // change with it while the function still compiled:
  expect(thumb('\tadd\tsp, r4\n')).toThrow(spAsData); // register-sized adjust (4 real sites in sa3)
  expect(thumb('\tsub\tsp, r4\n')).toThrow(spAsData);
  expect(thumb('\tadd\tsp, sp, r0\n')).toThrow(spAsData); // its 3-operand twin (VLA-shaped)
  expect(thumb('\tadd\tsp, r0, #0x4\n')).toThrow(spAsData); // computed sp: the base is not sp
  expect(thumb('\tmov\tsp, r3\n')).toThrow(spAsData); // wholesale frame switch (1 real site in sa3)
  // a FLAG-SETTING spelling is not bookkeeping: ARMv4T's sp-adjust encoding sets no flags, so one
  // can only come from hand-written asm, where dropping it would leave a stale compare for a
  // following conditional branch to fold into a silently wrong direction.
  expect(thumb('\tadds\tsp, sp, #0x4\n')).toThrow(spAsData);
  // GNU as accepts uppercase register names; a case-sensitive sp test would let `&local` through
  // as confident arithmetic on a fabricated parameter.
  expect(thumb('\tadd\tr0, SP, #0x8\n')).toThrow(spAsData);
  // …and the shapes that made the guard belong on the WRITE rather than in a list of decode arms.
  // An enumeration of arms covers only the arms someone thought of: each of these wrote sp through
  // an arm nobody had enumerated, and lifted with the write silently dropped.
  expect(thumb('\tlsl\tsp, r4, #2\n')).toThrow(spAsData);
  expect(thumb('\tneg\tsp, r4\n')).toThrow(spAsData);
  expect(thumb('\tmvn\tsp, r4\n')).toThrow(spAsData);
  expect(thumb('\tldr\tsp, [r0, #4]\n')).toThrow(spAsData);
  expect(thumb('\tldmia\tr0!, {sp}\n')).toThrow(spAsData);
  // the low-register copy idiom must still fire — it is load-bearing for callee-saved liveness
  expect(
    decompile('f', '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tadd\tr0, r1, #0\n\tbx\tlr\n', ARMV4T_AGBCC).source,
  ).toBe('s32 f(s32 a0) {\n    return a0;\n}\n');

  // annotate mode degrades to a stub carrying the same reason — never a fabricated stack local
  const annotated = decompile(
    'f',
    '\t.code\t16\n\t.globl\tf\n\t.thumb_func\nf:\n\tldr\tr0, [sp, r1]\n\tbx\tlr\n',
    ARMV4T_AGBCC,
    { onGap: 'annotate' },
  );
  expect(annotated.diagnostics.some((d) => spAsData.test(d.reason))).toBe(true);
});

test('MIPS: sp accesses outside the word-slot model decline, never a bogus slot', () => {
  const mips = (body: string) => () => decompile('f', `00000000 <f>:\n${body}   8:\tjr\tra\n   c:\tnop\n`, MIPS_IDO);
  // the model's own shape still works: a store then reload of the same word slot is one SSA value
  expect(
    decompile('f', '00000000 <f>:\n   0:\tsw\ta0,4(sp)\n   4:\tlw\tv0,4(sp)\n   8:\tjr\tra\n   c:\tnop\n', MIPS_IDO)
      .source,
  ).toBe('s32 f(s32 a0) {\n    return a0;\n}\n');
  expect(mips('   0:\tlb\tv0,4(sp)\n')).toThrow(/stack pointer used as data/); // sub-word: slot model unsafe
  // …and the ALIASING case the whole-function sub-word scan exists for: a word store routed to an
  // SSA slot while a sub-word reload of the SAME offset stays on the memory path would drop the
  // store outright. One sub-word sp access disables slot modelling for the entire function.
  expect(mips('   0:\tsw\ta0,4(sp)\n   4:\tlbu\tv0,4(sp)\n')).toThrow(/stack pointer used as data/);
  expect(mips('   0:\taddu\tv0,sp,a0\n')).toThrow(/stack pointer used as data/); // &local
  expect(mips('   0:\tlw\tv0,16(sp)\n')).toThrow(/never stored/); // a slot no store defined
  // …and the case that guard MISSES, found while porting the model to Thumb: `hasReachingDef` asks
  // whether a store reaches on SOME path, so a slot stored on one arm of a diamond and reloaded at
  // the join passes it. readVar then recurses into the unstored predecessor and mints an entry
  // parameter FOR THE SLOT — this one-argument function came out as `s32 f(s32 a0, s32 a1)` with
  // `a1` standing in for uninitialised stack. Both frontends assert the symptom at the same
  // boundary (frontend/ssa.ts `finish`), which is total where a per-read test cannot be.
  //
  // THUMB NOW RECOVERS THIS SHAPE as an uninitialised local (`undef`) and MIPS DELIBERATELY DOES
  // NOT, which is the interesting part. The recovery needs "nothing incoming can reach this key",
  // and only Thumb has proved it: it bounds a slot by `off < localArea` and keys incoming stack
  // arguments separately. MIPS applies no frame bound, so `sp@40` here could equally be O32's
  // caller-owned home slot for a FIFTH ARGUMENT — recovering it would emit a signature with three
  // parameters missing and the caller's argument replaced by an uninitialised local. Compilable,
  // plausible, wrong. Until the O32 home-area rule exists, the decline is the honest answer.
  const diamond = [
    '00000000 <f>:',
    '   0:\taddiu\tsp,sp,-24',
    '   4:\tbeqz\ta0,14 <f+0x14>',
    '   8:\tnop',
    '   c:\tsw\ta0,16(sp)',
    '  10:\tnop',
    '  14:\tlw\tv0,16(sp)',
    '  18:\taddiu\tv0,v0,1',
    '  1c:\tjr\tra',
    '  20:\taddiu\tsp,sp,24',
    '',
  ].join('\n');
  expect(() => decompile('f', diamond, MIPS_IDO)).toThrow(/stack slot sp@16 is read on a path that never stores it/);
  // the ARGUMENT-HOME case that makes the decline necessary rather than merely conservative: with a
  // 24-byte frame, `40(sp)` is ABOVE it — the caller's area, where a def-less read is argument 5.
  const homeSlot = [
    '00000000 <f>:',
    '   0:\taddiu\tsp,sp,-24',
    '   4:\tbeqz\ta0,14 <f+0x14>',
    '   8:\tnop',
    '   c:\tsw\ta1,40(sp)',
    '  10:\tnop',
    '  14:\tlw\tv0,40(sp)',
    '  18:\taddiu\tv0,v0,1',
    '  1c:\tjr\tra',
    '  20:\taddiu\tsp,sp,24',
    '',
  ].join('\n');
  expect(() => decompile('f', homeSlot, MIPS_IDO)).toThrow(/stack slot sp@40 is read on a path that never stores it/);
  // …and the same fabrication when the entry block is ITSELF the loop header, where the slot
  // arrives as a PHI rather than a live-in. `paramReg` only covers live-ins, so the escape check
  // was blind to it and the phantom parameter survived — on MIPS, which has no preheader to make
  // the entry predecessor-free. The check reads phi keys too.
  //
  // This one is NOT covered by the undef recovery above and still declines, on purpose: the undef
  // is minted at the predecessor-less live-in site, and here there is no such site — the entry has
  // the latch as a predecessor. The postcondition is what catches it, so it stays a postcondition
  // rather than becoming an assertion nothing can reach.
  const entryLoop = [
    '00000000 <f>:',
    '   0:\taddiu\tsp,sp,-24',
    '   4:\tbeqz\ta0,10 <f+0x10>',
    '   8:\tnop',
    '   c:\tsw\ta0,16(sp)',
    '  10:\tlw\tv0,16(sp)',
    '  14:\taddiu\ta0,a0,-1',
    '  18:\tbnez\ta0,0 <f>',
    '  1c:\tnop',
    '  20:\tjr\tra',
    '  24:\tnop',
    '',
  ].join('\n');
  expect(() => decompile('f', entryLoop, MIPS_IDO)).toThrow(/stack slot sp@16 is read on a path that never stores it/);
});

// ── Input-format boundary (frontend/format.ts) ────────────────────────────────────────────
// Each frontend reads ONE text format; a positive mismatch declines AT THE BOUNDARY with a
// message naming both formats. Unclassifiable text still flows to the frontend (headerless
// fragments above keep working) but an empty/garbage parse declines instead of crashing.
const OBJDUMP_MIPS = readFileSync(join(import.meta.dirname, 'corpus', 'ido-add1.asm'), 'utf8');
const AGBCC_S = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-clamp0.s'), 'utf8');

test('objdump text into the ARM target declines naming both formats', () => {
  expect(() => decompile('add1', OBJDUMP_MIPS, ARMV4T_AGBCC)).toThrow(
    /looks like objdump disassembly.*'thumb' frontend reads GNU-as/s,
  );
});

test('agbcc .s text into the MIPS target declines (was a raw TypeError)', () => {
  expect(() => decompile('clamp0', AGBCC_S, MIPS_IDO)).toThrow(
    /looks like GNU-as assembly.*'mips' frontend reads objdump/s,
  );
});

test('unclassifiable garbage into MIPS declines on the empty parse, not a crash', () => {
  expect(() => decompile('f', 'hello world\nthis is not asm\n', MIPS_IDO)).toThrow(/no instructions found/);
});
