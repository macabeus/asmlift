// STRUCT-HARDEN: the structurer's two compiler-canonicalization heuristics — the divergent-if
// branch sense and the arg-copy emission order — are per-compiler choices, not universals, so
// they live as `compilerBehaviors` levers (target.ts) threaded through StructureOptions. These
// tests prove the two BRANCH/ARG-COPY levers are LOAD-BEARING — flipping each visibly changes the
// emitted structure — so they are real data, not decorative scaffolding.
// (The third lever, `coalesceLoopInit`, is exercised behaviorally by the `countdown` loop fixture
// in packages/cli/test/matching/mips-controlflow.test.ts, where IDO's true keeps the induction var in its arg register;
// here it is only checked for correct target→StructureOptions projection.) Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, structureOptionsFor } from '../src/target';

function emit(ir: string, opts: Parameters<typeof structure>[1]): string {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, opts));
}

// A divergent if: both arms terminate (return), no reconvergence → ipdom null.
const DIVERGE = `fn diverge {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_slt %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: s32 = const {value=7}
  ret %3
^bb2():
  ret %0
}
`;

// A merge whose two block-args are COMPUTED in the opposite order to their param positions,
// so sorting the parallel copies by computation order flips the two assignment statements.
const ARGORD = `fn argord {
^bb0(%0: s32, %1: s32):
  %2: s32 = add %1, %0
  %3: s32 = add %0, %1
  br ^bb1(%3, %2)
^bb1(%4: s32, %5: s32):
  %6: s32 = mul %4, %5
  ret %6
}
`;

describe('STRUCT-HARDEN: the compiler-behavior levers are load-bearing', () => {
  test('preserveDivergentBranchSense flips branch direction on a divergent if', () => {
    // true (IDO/MIPS behavior, and the safe default): reproduce the source forward-branch by
    // negating the condition and putting the taken arm as the `else`.
    expect(emit(DIVERGE, { preserveDivergentBranchSense: true })).toBe(
      's32 diverge(s32 a0) {\n    if (a0 >= 0) {\n        return a0;\n    } else {\n        return 7;\n    }\n}\n',
    );
    // false: emit the positive form (a compiler that canonicalizes branches the other way).
    expect(emit(DIVERGE, { preserveDivergentBranchSense: false })).toBe(
      's32 diverge(s32 a0) {\n    if (a0 < 0) {\n        return 7;\n    } else {\n        return a0;\n    }\n}\n',
    );
  });

  test('orderArgCopiesByComputation flips the order of independent edge assignments', () => {
    // true (the default): the copy whose value is computed FIRST in the predecessor is emitted
    // first — here v1 (= a1 + a0, the first add) precedes v0 (= a0 + a1, the second add).
    expect(emit(ARGORD, { orderArgCopiesByComputation: true })).toContain('v1 = a1 + a0;\n    v0 = a0 + a1;');
    // false: emit in source/param order — v0 (param 0) before v1 (param 1).
    expect(emit(ARGORD, { orderArgCopiesByComputation: false })).toContain('v0 = a0 + a1;\n    v1 = a1 + a0;');
  });

  test('absent levers default to true', () => {
    // A caller passing no lever must get exactly the lever-true behavior.
    expect(emit(DIVERGE, {})).toBe(emit(DIVERGE, { preserveDivergentBranchSense: true }));
    expect(emit(ARGORD, {})).toBe(emit(ARGORD, { orderArgCopiesByComputation: true }));
  });
});

describe("STRUCT-HARDEN: structureOptionsFor projects a target's compilerBehaviors", () => {
  test('every compilerBehaviors lever flows into StructureOptions (no field dropped)', () => {
    for (const t of [ARMV4T_AGBCC, MIPS_IDO, MIPS_GCC]) {
      const opts = structureOptionsFor(t, false);
      expect(opts.returnsVoid).toBe(false);
      // The projection carries each behavior verbatim — this is the ONE seam target→structurer.
      expect(opts.coalesceLoopInit).toBe(t.compilerBehaviors.coalesceLoopInit);
      expect(opts.preserveDivergentBranchSense).toBe(t.compilerBehaviors.preserveDivergentBranchSense);
      expect(opts.orderArgCopiesByComputation).toBe(t.compilerBehaviors.orderArgCopiesByComputation);
    }
  });

  test("coalesceLoopInit is the bag's REAL distinguishing inhabitant (differs across compilers)", () => {
    // The compilerBehaviors bag is earned only if at least one lever actually differs between real
    // targets (else it is uniform scaffolding). The BEHAVIORAL proof that this value changes
    // codegen is the `countdown` fixture (mips-controlflow.test.ts), byte-exact only because IDO's
    // true keeps the induction var in a0. The two branch/arg levers are, by contrast, uniform-true
    // today.
    expect(MIPS_IDO.compilerBehaviors.coalesceLoopInit).toBe(true);
    expect(ARMV4T_AGBCC.compilerBehaviors.coalesceLoopInit).toBe(false);
    expect(MIPS_GCC.compilerBehaviors.coalesceLoopInit).toBe(false);
    // …and the two branch/arg levers are genuinely uniform across every real compiler (the honest
    // scaffolding claim — no target sets either false today):
    for (const t of [ARMV4T_AGBCC, MIPS_IDO, MIPS_GCC, PPC_MWCC]) {
      expect(t.compilerBehaviors.preserveDivergentBranchSense).toBe(true);
      expect(t.compilerBehaviors.orderArgCopiesByComputation).toBe(true);
    }
  });
});
