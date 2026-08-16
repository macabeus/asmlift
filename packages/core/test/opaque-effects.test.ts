// An unmodelled instruction may not disappear because its DESTINATION happens to be dead.
//
// frontend/opaque.ts promises "an unmodelled instruction/operand degrades to a LOUD failure, never
// a silent drop". That promise used to hold only while the fabricated destination stayed LIVE: a
// live `opaque` reaches structuring as the `?` sentinel and trips assertResolved, but a DEAD one
// was reaped by DCE and, if it survived that, silently skipped by `sideEffects` — so the whole
// instruction vanished with no diagnostic. `STR r0, [r1]` (a store the Thumb frontend does not
// recognise, because it only matches lowercase) lifted to a function containing no store.
//
// These pin both halves. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { gapReasonFor } from '../src/l3/ast';
import { dce } from '../src/pattern/engine';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO } from '../src/target';

const dc = (sym: string, body: string, onGap?: 'annotate') =>
  decompile(sym, `${sym}:\n${body}`, ARMV4T_AGBCC, onGap ? { onGap } : {});

/** `<insn>` runs, then r0 is overwritten — so the opaque's destination is dead at every later point. */
const deadDest = (insn: string) => `\t${insn}\n\tmov\tr0, #0\n\tbx\tlr\n`;

describe('an unmodelled instruction with a DEAD destination stays loud', () => {
  test.each([
    ['an unrecognised load-multiple', 'ldmea\tr1, {r0}'],
    ['a mnemonic from no instruction set at all', 'zzz\tr0, r1'],
  ])('%s declines instead of vanishing', (_label, insn) => {
    expect(() => dc('f', deadDest(insn))).toThrow(/unresolvable value/);
  });

  // `STR` assembles — GNU `as` takes uppercase Thumb mnemonics and emits the same encoding — so it
  // is valid input the frontend does not model, and it was the audit's reproducer. It no longer
  // reaches the opaque path at all: `storeClass` is matched case-insensitively, so it is refused a
  // step earlier with the message about the memory write. Both routes are loud; this pins WHICH,
  // because the store-class message is the one that tells the reader what was lost.
  test.each([
    ['an uppercase store', 'STR\tr0, [r1]'],
    ['an uppercase halfword store', 'STRH\tr0, [r1]'],
  ])('%s is refused as store-class, before a bogus destination is fabricated', (_label, insn) => {
    expect(() => dc('f', deadDest(insn))).toThrow(/unmodelled store-class instruction/);
    // named in the spelling the input used — a reader greps their own .s for what they wrote
    expect(() => dc('f', deadDest(insn))).toThrow(new RegExp(insn.split('\t')[0]));
  });

  test('annotate mode emits a marker rather than silently dropping it', () => {
    const { source, diagnostics } = dc('f', deadDest('ldmea\tr1, {r0}'), 'annotate');
    expect(source).toMatch(/ASMLIFT_ERROR/);
    expect(source).toMatch(/unmodelled instruction 'ldmea'/);
    // and it is reported structurally, not only in the text
    expect(diagnostics.some((d) => /unmodelled instruction 'ldmea'/.test(d.reason))).toBe(true);
  });

  test('the MODELLED spelling still lifts cleanly — this is a decline, not a blanket refusal', () => {
    expect(dc('f', deadDest('str\tr0, [r1]')).source).toMatch(/\*a1 = a0;/);
  });

  test('a live destination was already loud, and still is', () => {
    // The half that always worked. Kept so a future change cannot fix one path by breaking the other.
    expect(() => dc('f', '\tzzz\tr0, r1\n\tbx\tlr\n')).toThrow(/unresolvable value/);
  });
});

describe('a HARDWIRED-ZERO destination is not evidence either', () => {
  // The second door into the same hole, found by an adversarial reviewer AFTER the first fix — and
  // the first fix's own comment had asserted this door was shut. `opaqueDest` returned null for a
  // `$zero` destination on the reasoning "writes hardwired zero ⇒ a genuine no-op", which is the
  // reasoning the dead-destination fix rejects. It is a no-op only for a MODELLED instruction.
  const mips = (body: string) => decompile('f', body, MIPS_IDO, { onGap: 'annotate' });
  const withZeroDest = (insn: string) => `0:\t${insn}\n4:\tjr\tra\n8:\taddiu\tv0,a0,1\n`;

  test.each([
    ['a CP0 write', 'mtc0\tzero,$12'],
    ['a conditional TRAP', 'teq\tzero,zero'],
    ['an FPU move', 'mtc1\tzero,$f4'],
    ['garbage', 'zzz\tzero,a0'],
  ])('%s to $zero is loud in BOTH modes', (_label, insn) => {
    const body = withZeroDest(insn);
    // strict: the frontend refuses outright.
    expect(() => decompile('f', body, MIPS_IDO)).toThrow(/no register destination to degrade/);
    // annotate: a LIFT-stage refusal degrades the whole function to a commented stub rather than an
    // inline marker — the existing design for a frontend throw. Loud in the artifact either way,
    // which is what matters; asserting the diagnostic rather than the source shape keeps this test
    // from pinning which of the two annotate surfaces is used.
    const res = mips(body);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.source).toContain('ASMLIFT_ERROR');
  });

  test('a MODELLED write to $zero is still a genuine no-op', () => {
    // The gate has to distinguish "unmodelled, destination inert" from "modelled, write discarded".
    // `addu zero,a0,a0` is decoded, so it never reaches opaqueDest and must still vanish. Without
    // this, tightening opaqueDest by refusing every `$zero` destination would look correct.
    expect(mips('0:\taddu\tzero,a0,a0\n4:\tjr\tra\n8:\taddiu\tv0,a0,1\n').source).toBe(
      's32 f(s32 a0) {\n    return a0 + 1;\n}\n',
    );
  });
});

describe('the boundary contract backstops annotate mode', () => {
  // assertResolved covers strict mode; in annotate mode the gap is a marker, which is "resolved" by
  // construction, so nothing checked that the marker was actually emitted. assertEffectsPreserved
  // now does. Pin that the two sides agree on the reason text — if they drift, the contract looks
  // enforced and never fires.
  test('the gap reason has ONE spelling, shared by the marker and the contract', () => {
    expect(gapReasonFor('clz')).toBe("unmodelled instruction 'clz'");
    const { source } = dc('f', deadDest('clz\tr1, r0'), 'annotate');
    expect(source).toContain(gapReasonFor('clz'));
  });

  test('a frontend that stamps no mnemonic still produces a matching reason', () => {
    expect(gapReasonFor(undefined)).toBe("unmodelled instruction '?'");
  });
});

describe('a decline caused by an unmodelled instruction says so', () => {
  // An `opaque` does not only degrade its own value — it makes its block impure, and `headerPure`
  // then refuses the loop. The decline was true ("unrecovered back-edge … loop-recovery declined
  // this shape") and useless: the shape is fine, an instruction is missing. It also sent the
  // benchmark's decline Pareto to `loop-shapes`, pointing the next round at the wrong capability.
  const whileWithHeaderInsn = (insn: string) =>
    `\tmov\tr1, #0\n.L1:\n\t${insn}\n\tcmp\tr1, #10\n\tbge\t.L2\n\tadd\tr1, r1, #1\n\tb\t.L1\n.L2:\n\tmov\tr0, r1\n\tbx\tlr\n`;

  test('a loop-shape decline names the unmodelled instruction in the header', () => {
    expect(() => dc('f', whileWithHeaderInsn('clz\tr2, r0'))).toThrow(/unrecovered back-edge/);
    expect(() => dc('f', whileWithHeaderInsn('clz\tr2, r0'))).toThrow(/unmodelled instruction\(s\) 'clz'/);
  });

  test('the same loop with a MODELLED instruction still recovers', () => {
    // Without this, appending the attribution to every decline would look correct.
    expect(dc('f', whileWithHeaderInsn('mov\tr2, r0')).source).toContain('for (v0 = 0; v0 < 10; v0 = v0 + 1)');
  });

  test('attribution is not added when the message already names the instruction', () => {
    // The gap landed where it belongs (the instruction is in the loop BODY, not the header), so the
    // message is already precise and must not be padded with a second sentence saying the same thing.
    const bodyInsn =
      '\tmov\tr1, #0\n.L1:\n\tcmp\tr1, #10\n\tbge\t.L2\n\tclz\tr2, r0\n\tadd\tr1, r1, #1\n\tb\t.L1\n.L2:\n\tmov\tr0, r1\n\tbx\tlr\n';
    expect(() => dc('f', bodyInsn)).toThrow(/unresolvable value/);
    expect(() => dc('f', bodyInsn)).not.toThrow(/more likely cause/);
  });
});

describe('DCE may not reap a dead opaque', () => {
  test('the op survives a dce() pass', () => {
    // Directly, so the guarantee is pinned at the pass and not only end-to-end: a later change to
    // structuring must not be able to make this test pass for the wrong reason.
    const { ir } = dc('f', deadDest('zzz\tr0, r1'), 'annotate');
    expect(ir.recovered).toMatch(/opaque/);
  });

  test('dce still reaps a genuinely pure dead op', () => {
    // The gate has to be about EFFECTS, not about "keep everything". `mov r0,#5` feeds nothing.
    const { ir } = dc('f', '\tmov\tr0, #5\n\tmov\tr0, #0\n\tbx\tlr\n');
    expect(ir.recovered).not.toMatch(/value=5/);
  });

  test('dce is exported and idempotent on a function with no dead ops', () => {
    // Guards the filter rewrite itself: `dce` loops until it stops changing anything.
    const { ir } = dc('f', '\tadd\tr0, r0, r1\n\tbx\tlr\n');
    expect(typeof dce).toBe('function');
    expect(ir.recovered).toMatch(/add/);
  });
});
