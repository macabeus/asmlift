// A RETURN TAIL agbcc CROSS-JUMPED, re-spelled the way the source wrote it, byte-scored.
//
// The two probe pairs `packages/core/test/corpus/probe-rettail-{pa,pb}-{copies,join}.c` each write
// one function twice: the return tail in every arm, and once after the construct. agbcc compiles
// the four into four different objects (target.ts `crossJumpsReturnTails`), and the CFG of each
// copies object holds the tail once. So the join is the shorter reading of every one of them, and
// the size bound alone publishes it. On the copies objects the layout shows the cross-jump
// (core structure/cross-jumped-tail.ts), and the default publishes the copies. This file pins that
// each default recompiles to its own object, and that the join does not, on the copies objects.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const CORPUS = join(import.meta.dirname, '..', '..', '..', 'core', 'test', 'corpus');
const FLAGS = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
const PROTOS = {
  pa: { f: { params: 1, returnsVoid: true }, h: { params: 2, returnsVoid: true } },
  pb: { f: { params: 2, returnsVoid: true } },
} as const;

const score = (probe: string, o: object) => {
  const asm = compileTargetAsm(readFileSync(join(CORPUS, `probe-rettail-${probe}.c`), 'utf8'), FLAGS);
  const r = decompile('f', asm, ARMV4T_AGBCC, { prototypes: PROTOS[probe.startsWith('pa') ? 'pa' : 'pb'], ...o });
  return scoreC(r.source, 'f', assembleTarget(asm), FLAGS);
};

describe('agbcc: the default reading of a cross-jumped return tail recompiles byte-exact', () => {
  test.each(['pa-copies', 'pb-copies', 'pa-join', 'pb-join'])('%s: the default matches', (probe) => {
    expect(score(probe, {}).match).toBe(true);
  });

  test.each(['pa-copies', 'pb-copies'])('%s: the join, shorter, does not', (probe) => {
    expect(score(probe, { joinPastReturns: true }).match).toBe(false);
  });
});
