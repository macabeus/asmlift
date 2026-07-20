// The report's failure taxonomy at the scoring seam, offline (no toolchain ever spawns):
//
//   • a SCORING-INFRASTRUCTURE failure (a registered compiler throwing — toolchain down,
//     corrupt object) must not escape decompileWithReport in annotate mode nor destroy a good
//     decompilation: keep source + trace, degrade to outcome "unscored". Strict propagates.
//   • a MISSING candidate compiler (nothing registered, no `compile` override) is a SETUP bug:
//     NoCandidateCompilerError propagates in BOTH modes — silently-unscored reports would hide
//     a misconfiguration on every run. The registry ships EMPTY in @asmlift/cli; the pinned
//     toolchains register only when @asmlift/toolchains is imported (never in offline suites).
import { cBackend } from '@asmlift/core/backend/c';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { expect, test } from 'vitest';

import { decompileWithReport } from '../../src/report';
import { NoCandidateCompilerError, registerCandidateCompiler, scoreSource } from '../../src/score';

const HALF =
  '\t.code\t16\n\t.globl\thalf\n\t.thumb_func\nhalf:\n\tlsr\tr1, r0, #31\n\tadd\tr0, r0, r1\n\tasr\tr0, r0, #1\n\tbx\tlr\n';

// A fake compiler id so registration here can't leak into other suites' targets.
const STUB_DOWN = { ...ARMV4T_AGBCC, compiler: 'stub-down' };
registerCandidateCompiler('stub-down', () => {
  throw new Error('toolchain down');
});

test('annotate: a scoring-infrastructure failure degrades to unscored, keeping source + trace', () => {
  const { source, report } = decompileWithReport('half', HALF, STUB_DOWN, {
    targetObj: '/nonexistent/never-reached.o',
    backend: cBackend,
    onGap: 'annotate',
  });
  expect(source).toContain('half'); // the decompilation survived
  expect(source).not.toContain('could not decompile');
  expect(report.trace.length).toBeGreaterThan(0);
  expect(report.outcome).toBe('unscored');
  expect(report.score).toBeUndefined();
  expect(report.candidates).toBeUndefined();
});

test('strict: the same scoring-infrastructure failure propagates', () => {
  expect(() =>
    decompileWithReport('half', HALF, STUB_DOWN, { targetObj: '/nonexistent/never-reached.o', backend: cBackend }),
  ).toThrow(/toolchain down/);
});

// An id nothing ever registers — the assertions hold whether this file runs alone (offline:
// registry truly empty) or inside the full suite (matching suites register the pinned four).
const UNREGISTERED = { ...ARMV4T_AGBCC, compiler: 'never-registered' };

test('an unregistered compiler: scoreSource throws the typed setup error', () => {
  expect(() => scoreSource('s32 f(void){return 0;}', 'f', '/never-read.o', UNREGISTERED, 'c')).toThrow(
    NoCandidateCompilerError,
  );
  expect(() => scoreSource('s32 f(void){return 0;}', 'f', '/never-read.o', UNREGISTERED, 'c')).toThrow(
    /no candidate compiler for 'never-registered'/,
  );
});

test('a missing compiler propagates EVEN in annotate mode (setup bug, not scoring flakiness)', () => {
  expect(() =>
    decompileWithReport('half', HALF, UNREGISTERED, {
      targetObj: '/nonexistent/never-reached.o',
      backend: cBackend,
      onGap: 'annotate',
    }),
  ).toThrow(NoCandidateCompilerError);
});
