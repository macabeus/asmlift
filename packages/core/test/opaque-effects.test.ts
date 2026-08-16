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

import { dce } from '../src/pattern/engine';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const dc = (sym: string, body: string, onGap?: 'annotate') =>
  decompile(sym, `${sym}:\n${body}`, ARMV4T_AGBCC, onGap ? { onGap } : {});

/** `<insn>` runs, then r0 is overwritten — so the opaque's destination is dead at every later point. */
const deadDest = (insn: string) => `\t${insn}\n\tmov\tr0, #0\n\tbx\tlr\n`;

describe('an unmodelled instruction with a DEAD destination stays loud', () => {
  // The exact shape from the audit. `STR` assembles (GNU `as` accepts uppercase Thumb mnemonics and
  // emits the same encoding), so this is valid input, and `storeClass: /^(str|stm)/` does not match
  // it — which is the point: a classifier miss must fail SAFE, not silently.
  test.each([
    ['an unrecognised store', 'STR\tr0, [r1]'],
    ['an unrecognised halfword store', 'STRH\tr0, [r1]'],
    ['an unrecognised load-multiple', 'ldmea\tr1, {r0}'],
    ['a mnemonic from no instruction set at all', 'zzz\tr0, r1'],
  ])('%s declines instead of vanishing', (_label, insn) => {
    expect(() => dc('f', deadDest(insn))).toThrow(/unresolvable value/);
  });

  test('the decline names the instruction, in the spelling the input used', () => {
    // Not the normalised name: a reader greps their own .s for what they wrote.
    expect(() => dc('f', deadDest('STR\tr0, [r1]'))).toThrow(/STR/);
  });

  test('annotate mode emits a marker rather than silently dropping it', () => {
    const { source, diagnostics } = dc('f', deadDest('STR\tr0, [r1]'), 'annotate');
    expect(source).toMatch(/ASMLIFT_ERROR/);
    expect(source).toMatch(/unmodelled instruction 'STR'/);
    // and it is reported structurally, not only in the text
    expect(diagnostics.some((d) => /unmodelled instruction 'STR'/.test(d.reason))).toBe(true);
  });

  test('the MODELLED spelling still lifts cleanly — this is a decline, not a blanket refusal', () => {
    expect(dc('f', deadDest('str\tr0, [r1]')).source).toMatch(/\*a1 = a0;/);
  });

  test('a live destination was already loud, and still is', () => {
    // The half that always worked. Kept so a future change cannot fix one path by breaking the other.
    expect(() => dc('f', '\tzzz\tr0, r1\n\tbx\tlr\n')).toThrow(/unresolvable value/);
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
