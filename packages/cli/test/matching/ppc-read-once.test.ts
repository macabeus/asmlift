// The premise under the `read-once` tag's PowerPC lane (`readppc`, apps/benchmark/dataset/synthetic.ts).
//
// The tag has NO machine-checked floor: it says the source read a value once above a branch where
// a decompiler would render the read at each use. That is only a meaningful thing to measure while
// the compiler EMITS the difference — if mwcc_242_81 folded the two spellings into one object, the
// row would be scoring a distinction the toolchain does not make, and the fan would have two
// spellings of one answer. agbcc's version of this premise is an argument from its pass list (no
// scheduler, hoisting gated behind -Os); CodeWarrior's pass list says nothing about it, so the
// premise is held here by compiling both spellings and comparing the objects byte for byte.
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { compilePpcTarget } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ppcDockerGate } from './docker-gate';

const FLAGS = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;

const ABOVE =
  'void readppc(u32 *p, u32 *a, u32 *b, u32 c){ u32 s = *p; if (c & 1){ *a = s << 3; } else { *b = s << 4; } }';
const PER_ARM = 'void readppc(u32 *p, u32 *a, u32 *b, u32 c){ if (c & 1){ *a = *p << 3; } else { *b = *p << 4; } }';

const loads = (asm: string) => asm.split('\n').filter((l) => /\tlwz\s/.test(l));

describe.runIf(ppcDockerGate('ppc-read-once'))('mwcc_242_81 emits a read where the source spelled it', () => {
  it('keeps one read above the branch, and two reads when the source reads per arm', () => {
    const above = compilePpcTarget(ABOVE, 'readppc', FLAGS);
    const perArm = compilePpcTarget(PER_ARM, 'readppc', FLAGS);

    // The placement itself: one load, before the conditional branch, into a register that stays
    // live across it — against one load inside each arm.
    const aboveLines = above.asm.split('\n');
    expect(loads(above.asm)).toHaveLength(1);
    expect(aboveLines.findIndex((l) => /\tlwz\s/.test(l))).toBeLessThan(
      aboveLines.findIndex((l) => /\tbeq-?\s/.test(l)),
    );
    expect(loads(perArm.asm)).toHaveLength(2);

    // And the consequence the row is scored on: the two spellings are not the same object, so a
    // candidate that reads per arm cannot match a target that read once.
    expect(readFileSync(above.obj).equals(readFileSync(perArm.obj))).toBe(false);
  });
});
