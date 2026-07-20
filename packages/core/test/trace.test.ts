// decompileTraced — the browser-pure traced tower (trace.ts). Pins the stage sequence, the
// pattern event shape, headline-source parity with decompile(), and the annotate stub path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC } from '../src/target';
import { decompileTraced } from '../src/trace';

// agbcc's canonical Thumb x/2 — the SDIV_POW2_2 idiom shape (same asm as the playground example).
const HALF_ASM =
  '\t.code\t16\n\t.globl\thalf\n\t.thumb_func\nhalf:\n' +
  '\tlsr\tr1, r0, #31\n\tadd\tr0, r0, r1\n\tasr\tr0, r0, #1\n\tbx\tlr\n';

test('trace: stage sequence, pattern event, and source parity with decompile()', () => {
  const { source, report } = decompileTraced('half', HALF_ASM, ARMV4T_AGBCC);
  expect(source).toBe(decompile('half', HALF_ASM, ARMV4T_AGBCC).source);
  expect(report.trace.map((s) => s.id)).toEqual([
    'stage:lift',
    'stage:idiom',
    'stage:recover',
    'stage:structure',
    'stage:emit',
  ]);
  expect(report.trace.every((s) => s.verified)).toBe(true);

  expect(report.patternEvents).toHaveLength(1);
  const ev = report.patternEvents[0];
  expect(ev.patternId).toBe('sdiv-pow2/2');
  expect(ev.hits).toBe(1);
  expect(ev.beforeIr).not.toBe(ev.afterIr);
  expect(ev.afterIr).toContain('sdiv');
  // no probeScore hook ⇒ score fields stay unset (they belong to the cli's objdiff side)
  expect(ev.scoreBefore).toBeUndefined();
  expect(ev.scoreDelta).toBeUndefined();
});

test('trace: probeScore hook fills the per-boundary score fields', () => {
  const probed: number[] = [7, 3];
  let i = 0;
  const { report } = decompileTraced('half', HALF_ASM, ARMV4T_AGBCC, { probeScore: () => probed[i++] });
  expect(report.patternEvents[0]).toMatchObject({ scoreBefore: 7, scoreAfter: 3, scoreDelta: -4 });
});

test('trace: a firing pre-recovery pass traces its registered stage entry', () => {
  // gcc-aget's variable-index array triggers the `arrays` legalize pass — pins the
  // PRE_RECOVERY_TRACE table's registered stage entry.
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'gcc-aget.asm'), 'utf8');
  const { report } = decompileTraced('aget', asm, MIPS_GCC);
  expect(report.trace.some((s) => s.id === 'stage:legalize')).toBe(true);
  expect(report.trace.find((s) => s.id === 'stage:legalize')!.title).toContain('scaled access');
});

test('trace: annotate mode degrades a hard failure to the stub, never a throw', () => {
  const { source, report } = decompileTraced('mystery', 'not assembly at all\n', ARMV4T_AGBCC, { onGap: 'annotate' });
  expect(report.trace).toEqual([]);
  expect(report.patternEvents).toEqual([]);
  expect(source).toContain('ASMLIFT_ERROR');
  expect(source).toBe(report.source);
});
