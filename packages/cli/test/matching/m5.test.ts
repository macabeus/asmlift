// M5 — the DecompileReport. Asserts the report captures the
// process (stage trace), the pattern events with a REAL objdiff score delta, ranked
// candidates, and the final score — the machine-readable surface the self-improve agent
// and the webapp both consume.
import { SDIV_POW2_2 } from '@asmlift/core/pattern/engine';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

import { decompileWithReport } from '../../src/report';

test('M5: report captures stages, a scored pattern event, candidates, and the score', () => {
  const asm = compileTargetAsm('int half(int x){ return x / 2; }');
  const obj = assembleTarget(asm);
  const { report } = decompileWithReport('half', asm, ARMV4T_AGBCC, { patterns: [SDIV_POW2_2], targetObj: obj });

  expect(report.version).toBe(1);
  expect(report.symbol).toBe('half');

  // the original input assembly is carried in the report
  expect(report.asm).toContain('half:');
  expect(report.asm).toContain('lsr\tr1, r0, #0x1f');

  // every pipeline stage is traced by a STABLE id (the AI loop's localization anchor — pinned
  // so a relabel can't silently drop one), and each stage verified.
  const ids = report.trace.map((t) => t.id);
  expect(ids).toEqual(['stage:lift', 'stage:idiom', 'stage:recover', 'stage:structure', 'stage:emit']);
  expect(report.trace.every((t) => t.verified)).toBe(true);

  // the idiom pattern fired and its objdiff score delta is recorded (moved toward match)
  expect(report.patternEvents).toHaveLength(1);
  const ev = report.patternEvents[0];
  expect(ev.hits).toBe(1);
  expect(ev.scoreBefore).toBe(1);
  expect(ev.scoreAfter).toBe(0);
  expect(ev.scoreDelta).toBe(-1);

  // ranked candidates + a byte-exact final score
  expect(report.candidates?.length).toBe(2);
  expect(report.outcome).toBe('match');
  expect(report.score?.match).toBe(true);
});

test('M5: report is JSON-serializable (consumable by agent + webapp)', () => {
  const asm = compileTargetAsm('int half(int x){ return x / 2; }');
  const { report } = decompileWithReport('half', asm, ARMV4T_AGBCC, { patterns: [SDIV_POW2_2] });
  const round = JSON.parse(JSON.stringify(report));
  expect(round.symbol).toBe('half');
  expect(round.trace.length).toBe(5);
});
