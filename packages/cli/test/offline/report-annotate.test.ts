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
import type { SymbolMap } from '@asmlift/core/symbols';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { join } from 'node:path';
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

// ── the score probe structures the program the report's headline actually is ──────────────────

test('the per-pattern score probe structures with the PROJECT MAP, not only the derived shapes', () => {
  // `scoreDelta` is a claim about the change one pattern made to the source asmlift emits. A
  // probe structured from a different symbol dictionary than the main path measures that delta on
  // a program asmlift does not emit — and once array shapes are derived from stride evidence
  // (raise/globalshape.ts) the divergence is not cosmetic: the probe would compile a bare
  // `gTbl[a0]`, whose meaning rests on `extern u16 gTbl[]`, while the map supplied on the very
  // same command line declares `const s16 gTbl[4][64]` and the headline source casts.
  //
  // The probe compiler here records what it is handed and throws, which is exactly how it
  // degrades on a real toolchain failure — so this asserts the SOURCE, not a score.
  const asm =
    '\t.code\t16\n.text\n\t.align\t2, 0\n\t.globl\tf\n\t.thumb_func\nf:\n' +
    '\tldr\tr1, .L3\n\tlsl\tr0, r0, #0x1\n\tadd\tr0, r0, r1\n\tldrh\tr0, [r0]\n\tbx\tlr\n' +
    '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgTbl\n';
  const symbols = new Map([
    [0x0800_0000, [{ name: 'gTbl', kind: 'data', shape: 'array', elemSize: 2, elemSigned: true, dims: [4, 64] }]],
  ]) as SymbolMap;

  const seen: string[] = [];
  const compile = (source: string): string => {
    seen.push(source);
    throw new Error('probe: no toolchain');
  };
  let headline = '';
  try {
    headline = decompileWithReport('f', asm, ARMV4T_AGBCC, {
      symbols,
      targetObj: '/nonexistent/never-reached.o',
      backend: cBackend,
      compile,
    }).source;
  } catch {
    headline = seen.pop() ?? ''; // the headline's own scoreSource is the LAST compile attempted
  }
  // the map wins the spelling: its element is SIGNED and the access zero-extends, so the bare
  // form is refused and the cast form — valid under any declaration — stands
  expect(headline).toContain('((u16 *)&gTbl)[a0]');
  expect(seen.length).toBeGreaterThan(0);
  for (const probed of seen) {
    expect(probed).toBe(headline);
  }
});

test('…and so does the candidate RANKING beside it, through decompileWithReport itself', () => {
  // The same asymmetry one call further out, and it has to be asserted THROUGH the wrapper: a
  // test that calls `decompileRanked` directly with a map passes whether or not the wrapper
  // forwards one, so only this shape pins the forwarding.
  //
  // `candidates` is a RANKING of the headline, so it must be enumerated from the same symbol
  // facts. Without the map every candidate was `gTbl[a0]` while the headline was
  // `((u16 *)&gTbl)[a0]` — a candidate list that cannot contain the source it ranks.
  //
  // Reaching the ranked branch needs the headline to SCORE, so the stub compiler returns the
  // target object itself: every compile is then a byte-exact match and the run proceeds, while
  // still recording the source it was handed.
  const target = join(import.meta.dirname, 'fixtures', 'objdiff', 'target.o');
  const asm =
    '\t.code\t16\n.text\n\t.align\t2, 0\n\t.globl\tadd_one\n\t.type\t add_one,function\n\t.thumb_func\nadd_one:\n' +
    '\tldr\tr1, .L3\n\tlsl\tr0, r0, #0x1\n\tadd\tr0, r0, r1\n\tldrh\tr0, [r0]\n\tbx\tlr\n' +
    '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgTbl\n.Lfe1:\n\t.size\t add_one,.Lfe1-add_one\n';
  const symbols = new Map([
    [0x0800_0000, [{ name: 'gTbl', kind: 'data', shape: 'array', elemSize: 2, elemSigned: true, dims: [4, 64] }]],
  ]) as SymbolMap;

  const seen: string[] = [];
  const { report } = decompileWithReport('add_one', asm, ARMV4T_AGBCC, {
    symbols,
    targetObj: target,
    backend: cBackend,
    compile: (source: string): string => {
      seen.push(source);
      return target;
    },
  });
  expect(report.candidates?.length).toBeGreaterThan(0);
  for (const c of report.candidates!) {
    expect(c.source).toContain('((u16 *)&gTbl)[a0]');
  }
  // …and nothing anywhere in the run — headline, probe or candidate — compiled the bare form
  expect(seen.filter((x) => /[^&]gTbl\[/.test(x))).toEqual([]);
});
