// The premises under the four PowerPC lanes in `apps/benchmark/dataset/synthetic.ts` — `readptr`
// (`read-once`), `promzb` (`promotion`), `loadf` (`load`) and `retone`'s mwcc_242_81 lane
// (`baseline`).
//
// All four are judgement tags with NO machine-checked floor, and each lane exists so its tag is not
// claimed on CodeWarrior by a real row alone. A floorless tag claimed on a compiler nobody compiled
// for is worth nothing, so every premise here is held by compiling and reading the object rather
// than by transferring an argument from agbcc: agbcc's version of the `read-once` premise is an
// argument from its pass list (no scheduler, hoisting gated behind -Os), and CodeWarrior's pass
// list says nothing about it.
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { compilePpcTarget } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ppcDockerGate } from './docker-gate';

/** What the synthetic tier compiles these rows at (`canonicalCodegen`). */
const CANONICAL = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
/** And the optimise-for-size mode the tags' first real carriers build at, which no synthetic row
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

describe.runIf(ppcDockerGate('ppc-tag-lanes', 'mwcc_242_81'))('the PowerPC lanes of four floorless tags', () => {
  it('read-once: the read is emitted in the block that spelled it, at both optimisation modes', () => {
    for (const flags of [CANONICAL, FOR_SIZE]) {
      const above = compilePpcTarget('mwcc_242_81', READ_ABOVE, 'readptr', flags);
      const perArm = compilePpcTarget('mwcc_242_81', READ_PER_ARM, 'readptr', flags);

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

  it('promotion: the zero extension happens before the add, not after it', () => {
    // `a+b` on two `u8` parameters is an int add of two promoted operands (0..510); the same sum
    // re-narrowed is a different value, and CodeWarrior spells the difference in where the
    // `clrlwi` goes. A decompiler that recovered the parameters as `int` could not match.
    const promoted = compilePpcTarget('mwcc_242_81', 'int promzb(u8 a,u8 b){ return a+b; }', 'promzb', CANONICAL);
    const narrowed = compilePpcTarget('mwcc_242_81', 'int promzb(u8 a,u8 b){ return (u8)(a+b); }', 'promzb', CANONICAL);

    const CLRLWI = /\tclrlwi\s/;
    const ADD = /\tadd\s/;
    expect(count(promoted.asm, CLRLWI)).toBe(2);
    expect(indexOf(promoted.asm, CLRLWI)).toBeLessThan(indexOf(promoted.asm, ADD));
    expect(indexOf(narrowed.asm, ADD)).toBeLessThan(indexOf(narrowed.asm, CLRLWI));
    expect(sameObject(promoted, narrowed)).toBe(false);
  });

  it('load: a float load is the whole function, and it is not the integer one', () => {
    const loadf = compilePpcTarget('mwcc_242_81', 'float loadf(float *p){ return *p; }', 'loadf', CANONICAL);
    const deref = compilePpcTarget('mwcc_242_81', 'int deref(int *p){ return *p; }', 'deref', CANONICAL);

    expect(count(loadf.asm, /\tlfs\s+f1,0\(r3\)/)).toBe(1);
    expect(count(loadf.asm, LWZ)).toBe(0);
    expect(count(deref.asm, LWZ)).toBe(1);
  });

  it('baseline: the control is two instructions on PowerPC too', () => {
    const retone = compilePpcTarget('mwcc_242_81', 'int retone(void){ return 1; }', 'retone', CANONICAL);

    expect(count(retone.asm, /\tli\s+r3,1/)).toBe(1);
    expect(count(retone.asm, /\tblr\b/)).toBe(1);
    // No frame and no branch: a row a decompiler can fail only for a reason unrelated to a feature.
    expect(count(retone.asm, /\tstwu\s|\tmflr\s|\tb[a-z-]*\s/)).toBe(0);
  });
});
