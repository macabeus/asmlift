// The premise under the `read-once` tag's PowerPC lane (`readptr`, apps/benchmark/dataset/synthetic.ts).
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

/** What the synthetic tier compiles this row at (`canonicalCodegen`). */
const CANONICAL = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
/** And the optimise-for-size mode the tag's first real carrier builds at, which no synthetic row
 *  can select: `SynthSpec` carries no per-row flags. A premise that held only at `-O4,p` would be a
 *  floor under the row rather than under the rows the row is there to back. */
const FOR_SIZE = CANONICAL.map((f) => (f === '-O4,p' ? '-O4,s' : f));

const lines = (asm: string) => asm.split('\n');
const indexOf = (asm: string, insn: RegExp) => lines(asm).findIndex((l) => insn.test(l));
const count = (asm: string, insn: RegExp) => lines(asm).filter((l) => insn.test(l)).length;
const sameObject = (a: { obj: string }, b: { obj: string }) => readFileSync(a.obj).equals(readFileSync(b.obj));

const LWZ = /\tlwz\s/;
const BEQ = /\tbeq-?\s/;

const READ_ABOVE =
  'void readptr(u32 *p, u32 *a, u32 *b, u32 c){ u32 s = *p; if (c & 1){ *a = s << 3; } else { *b = s << 4; } }';
const READ_PER_ARM =
  'void readptr(u32 *p, u32 *a, u32 *b, u32 c){ if (c & 1){ *a = *p << 3; } else { *b = *p << 4; } }';

describe.runIf(ppcDockerGate('ppc-tag-lanes'))('the PowerPC lanes of the floorless tags', () => {
  it('read-once: the read is emitted in the block that spelled it, at both optimisation modes', () => {
    for (const flags of [CANONICAL, FOR_SIZE]) {
      const above = compilePpcTarget(READ_ABOVE, 'readptr', flags);
      const perArm = compilePpcTarget(READ_PER_ARM, 'readptr', flags);

      // The placement itself: one load, BEFORE the conditional branch, into a register that stays
      // live across it — against one load inside each arm, which is AFTER it. Counting alone would
      // stay green on a compiler that hoisted both loads above the branch, and that is the one
      // outcome which would refute the row.
      expect(count(above.asm, LWZ)).toBe(1);
      expect(indexOf(above.asm, LWZ)).toBeLessThan(indexOf(above.asm, BEQ));
      expect(count(perArm.asm, LWZ)).toBe(2);
      expect(indexOf(perArm.asm, BEQ)).toBeLessThan(indexOf(perArm.asm, LWZ));

      // And the consequence the row is scored on: the two spellings are not the same object, so a
      // candidate that reads per arm cannot match a target that read once.
      expect(sameObject(above, perArm)).toBe(false);
    }
  });
});
