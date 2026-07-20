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
