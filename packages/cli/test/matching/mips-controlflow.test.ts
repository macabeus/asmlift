// MIPS control flow — the second ISA grown from straight-line (the "MIPS slice" fixtures) to real CFGs,
// mirroring Thumb's M2→M6. Each case: reference C → IDO 7.1 compile → MIPS object (scoring
// target) + objdump disassembly (asmlift input) → decompile → IDO recompile → REAL objdiff
// score. Byte-exact (0) means asmlift reproduced IDO's exact codegen — branch sense, delay
// slots, and loop register allocation included.
//
// What this proves on the shared Frontend + SSA seam:
//  • DELAY SLOTS — the instruction after a branch/`jr` executes before the transfer; a
//    conditional branch's compare operands are captured before the delay slot runs.
//  • FUSED COMPARE-BRANCHES — `bltz/bgez/blez/bgtz` (vs 0), `beq/bne`, `beqz/bnez`, and the
//    `slt …; beqz` "branch when false" fold — all lower to a single `cond_br` icmp.
//  • MATERIALISED COMPARES — `slt v0,a1,a0` for `a > b` stays an icmp value (`b < a`).
//  • DIVERGENT-IF branch sense — IDO preserves source branch direction, so the structurer
//    emits the taken arm as the `else` to reproduce the forward-branch-on-negated-condition.
//  • ROLLED SELF-LOOPS — a guard + do-while un-rotates to `while`, and (coalesceLoopInit) the
//    induction variable stays in its argument register, matching IDO's allocation exactly.
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget, scoreCMips } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';

const CASES: { sym: string; c: string; expect: string }[] = [
  // if / else diamonds (both arms return — divergent, no join)
  {
    sym: 'clamp0',
    c: 'int clamp0(int x){ if (x < 0) return 0; return x; }',
    expect: 's32 clamp0(s32 a0) {\n    if (a0 < 0) {\n        return 0;\n    } else {\n        return a0;\n    }\n}\n',
  },
  {
    sym: 'maxab',
    c: 'int maxab(int a, int b){ if (a < b) return b; return a; }',
    expect:
      's32 maxab(s32 a0, s32 a1) {\n    if (a0 < a1) {\n        return a1;\n    } else {\n        return a0;\n    }\n}\n',
  },
  {
    sym: 'absx',
    c: 'int absx(int x){ if (x < 0) return -x; return x; }',
    expect: 's32 absx(s32 a0) {\n    if (a0 < 0) {\n        return -a0;\n    } else {\n        return a0;\n    }\n}\n',
  },
  {
    sym: 'eqz',
    c: 'int eqz(int x){ if (x == 0) return 5; return 7; }',
    expect: 's32 eqz(s32 a0) {\n    if (a0 == 0) {\n        return 5;\n    } else {\n        return 7;\n    }\n}\n',
  },
  {
    sym: 'eqab',
    c: 'int eqab(int a, int b){ if (a == b) return 1; return 0; }', // two-register beq
    expect:
      's32 eqab(s32 a0, s32 a1) {\n    if (a0 == a1) {\n        return 1;\n    } else {\n        return 0;\n    }\n}\n',
  },
  // materialised comparisons (no branch — `slt` result returned directly)
  {
    sym: 'cmpgt',
    c: 'int cmpgt(int a, int b){ return a > b; }',
    expect: 'u32 cmpgt(s32 a0, s32 a1) {\n    return a1 < a0;\n}\n',
  },
  {
    sym: 'cmplt',
    c: 'int cmplt(int a, int b){ return a < b; }',
    expect: 'u32 cmplt(s32 a0, s32 a1) {\n    return a0 < a1;\n}\n',
  },
  // unsigned materialised compare — `sltu` → icmp_ult; recover types the operands u32 (so the
  // recompile re-emits `sltu`, not `slt`). Same construct as the GCC `ucmp` fixture, on IDO.
  {
    sym: 'ucmplt',
    c: 'int ucmplt(unsigned a, unsigned b){ return a < b; }',
    expect: 'u32 ucmplt(u32 a0, u32 a1) {\n    return a0 < a1;\n}\n',
  },
  // rolled self-loops (guard + do-while → while; induction var stays in the arg register)
  {
    sym: 'countdown',
    c: 'int countdown(int n){ int c=0; while(n!=0){ n=n>>1; c++; } return c; }',
    expect:
      's32 countdown(s32 a0) {\n    s32 v0;\n    v0 = 0;\n    while (a0 != 0) {\n        a0 = a0 >> 1;\n        v0 = v0 + 1;\n    }\n    return v0;\n}\n',
  },
  {
    sym: 'shifts',
    c: 'int shifts(int n){ int c=0; while(n>0){ n=n>>1; c++; } return c; }',
    expect:
      's32 shifts(s32 a0) {\n    s32 v0;\n    v0 = 0;\n    while (a0 > 0) {\n        a0 = a0 >> 1;\n        v0 = v0 + 1;\n    }\n    return v0;\n}\n',
  },
];

describe('MIPS (IDO) control flow: compile → disasm → decompile → recompile → objdiff', () => {
  for (const { sym, c, expect: golden } of CASES) {
    test(`${sym}`, () => {
      const { obj, asm } = compileMipsTarget(c, sym);
      const r = decompile(sym, asm, MIPS_IDO);
      expect(r.source).toBe(golden);
      const s = scoreCMips(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('L1 IR:\n' + r.ir.raw);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// The differ-ranked-lever mechanism must work for a NON-agbcc target: routing all candidate
// scoring through `scoreC` (agbcc/ARM-only) compiles MIPS candidates with the wrong compiler and
// mis-scores them. `scoreSource` dispatches by target.compiler, so the ranked path genuinely
// selects the matching type on MIPS.
describe('MIPS (IDO) ranked candidates — scoring dispatches to the right compiler (F1)', () => {
  test('the differ picks the unsigned candidate for `x >> 1` on MIPS/IDO', () => {
    const { obj, asm } = compileMipsTarget('unsigned ushr(unsigned x){ return x >> 1; }', 'ushr');
    const ranked = decompileRanked('ushr', asm, MIPS_IDO, obj);
    expect(ranked.best.label).toBe('unsigned'); // srl ⇒ unsigned wins; agbcc-scoring couldn't tell
    expect(ranked.best.score.match).toBe(true); // byte-exact via the IDO scorer, not agbcc
    const signed = ranked.candidates.find((c) => c.label === 'signed')!;
    expect(signed.score.score).toBeGreaterThan(0); // the wrong candidate is genuinely worse
  });
});
