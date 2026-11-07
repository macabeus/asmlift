// A RETURN TAIL agbcc CROSS-JUMPED, re-spelled the way the source wrote it, byte-scored.
//
// The two probe pairs `packages/core/test/corpus/probe-rettail-{pa,pb}-{copies,join}.c` each write
// one function twice: the return tail in every arm, and once after the construct. agbcc compiles
// the four into four different objects (target.ts `crossJumpsReturnTails`), and the CFG of each
// copies object holds the tail once. So the join is the shorter reading of every one of them, and
// the size bound alone publishes it. On the copies objects the layout shows the cross-jump
// (core structure/cross-jumped-tail.ts), and the marks' chooser publishes the copies. This file pins
// that each of the chooser's readings recompiles to its own object, and that the join does not, on
// the copies objects. agbcc's description itself defaults to the copies outright (it leaves out
// target.ts `joinPastReturnsByDefault`, measured over held-out real functions), so the chooser is
// read on the description with the join declared the default, and the copies default's own price is
// pinned below: the join-written probes then match only as the fan's `/ret-join` reading.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS, type TargetDescription } from '@asmlift/core/target';
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

const AGBCC_JOIN_DEFAULT: TargetDescription = {
  ...ARMV4T_AGBCC,
  compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, joinPastReturnsByDefault: true },
};

const score = (probe: string, o: object, target: TargetDescription = AGBCC_JOIN_DEFAULT) => {
  const asm = compileTargetAsm(readFileSync(join(CORPUS, `probe-rettail-${probe}.c`), 'utf8'), FLAGS);
  const r = decompile('f', asm, target, { prototypes: PROTOS[probe.startsWith('pa') ? 'pa' : 'pb'], ...o });
  return scoreC(r.source, 'f', assembleTarget(asm), FLAGS);
};

describe('agbcc: the default reading of a cross-jumped return tail recompiles byte-exact', () => {
  test.each(['pa-copies', 'pb-copies', 'pa-join', 'pb-join'])("%s: the marks' default matches", (probe) => {
    expect(score(probe, {}).match).toBe(true);
  });

  // the measured default publishes the copies on the join-written probes too, which do not match
  test.each(['pa-copies', 'pb-copies'])("%s: agbcc's own default matches", (probe) => {
    expect(score(probe, {}, ARMV4T_AGBCC).match).toBe(true);
  });
  test.each(['pa-join', 'pb-join'])("%s: agbcc's own default is the copies, and does not match", (probe) => {
    expect(score(probe, {}, ARMV4T_AGBCC).match).toBe(false);
  });

  test.each(['pa-copies', 'pb-copies'])('%s: the join, shorter, does not', (probe) => {
    expect(score(probe, { joinPastReturns: true }).match).toBe(false);
  });
});
