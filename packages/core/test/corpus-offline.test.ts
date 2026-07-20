// OFFLINE CORPUS — committed real disassembly so the FRONTEND + structurer + backend run with NO
// toolchain and NO Docker, on any machine and in CI.
//
// Every frontend/lift test compiles LIVE (agbcc / IDO / KMC-GCC-in-Docker), so where those
// toolchains are absent the decode path would have ZERO coverage — a green suite is an unreliable
// signal if the decode path is only ever exercised through the compiler that also produced the
// golden.
//
// Each `.asm` in test/corpus/ is REAL `objdump` output captured from an actual toolchain run (the
// same runs that score 0 byte-exact in the live matching suites, packages/cli/test/matching/),
// with only the volatile objdump header path normalized to `corpus.o`. This test lifts that fixed
// text end-to-end and pins the emitted C byte-for-byte — so a decode/structure/emit regression is
// caught deterministically, without a compiler in the loop. (Scoring still lives in the live suites;
// this guarantees the GENERATOR is reproducible offline.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '../src/target';

const read = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');

interface OfflineCase {
  file: string;
  sym: string;
  target: TargetDescription;
  expect: string;
  note: string;
  negative?: boolean;
}

const CASES: OfflineCase[] = [
  // ── Thumb / agbcc (GBA) — the founding frontend, its `.s` text captured verbatim ─────────
  {
    file: 'agbcc-clamp0.s',
    sym: 'clamp0',
    target: ARMV4T_AGBCC,
    note: "if-assign diamond join — agbcc's canonical form",
    expect: 's32 clamp0(s32 a0) {\n    if (a0 < 0) a0 = 0;\n    return a0;\n}\n',
  },
  {
    file: 'agbcc-deref.s',
    sym: 'deref',
    target: ARMV4T_AGBCC,
    note: 'pointer load (*p)',
    expect: 's32 deref(s32 * a0) {\n    return *a0;\n}\n',
  },

  // ── IDO (N64) ──────────────────────────────────────────────────────────────────────────
  {
    file: 'ido-add1.asm',
    sym: 'add1',
    target: MIPS_IDO,
    note: 'straight-line + delay-slot return',
    expect: 's32 add1(s32 a0) {\n    return a0 + 1;\n}\n',
  },
  {
    file: 'ido-clamp0.asm',
    sym: 'clamp0',
    target: MIPS_IDO,
    note: 'divergent-if — exercises preserveDivergentBranchSense (branch form)',
    expect: 's32 clamp0(s32 a0) {\n    if (a0 < 0) {\n        return 0;\n    } else {\n        return a0;\n    }\n}\n',
  },
  {
    file: 'ido-countdown.asm',
    sym: 'countdown',
    target: MIPS_IDO,
    note: 'rolled while-loop — loop recovery + coalesceLoopInit (induction var stays in a0)',
    expect:
      's32 countdown(s32 a0) {\n    s32 v0;\n    v0 = 0;\n    while (a0 != 0) {\n        a0 = a0 >> 1;\n        v0 = v0 + 1;\n    }\n    return v0;\n}\n',
  },

  // ── KMC GCC (N64) — the frontend with zero prior offline coverage ────────────────────────
  {
    file: 'gcc-add3.asm',
    sym: 'add3',
    target: MIPS_GCC,
    note: 'straight-line, GCC operand order',
    expect: 's32 add3(s32 a0, s32 a1, s32 a2) {\n    return a0 + a1 + a2;\n}\n',
  },
  {
    file: 'gcc-aget.asm',
    sym: 'aget',
    target: MIPS_GCC,
    note: 'variable-index array (recognizeArrays) — GCC scaled-operand-first order',
    expect: 's32 aget(s32 * a0, s32 a1) {\n    return a0[a1];\n}\n',
  },

  // ── Sibling pair: SAME C source, DIFFERENT compiler → different codegen (compiler-as-spec) ─
  // ido-clamp0 above lowered `if(x<0)…` to a real branch; KMC-GCC lowers the identical source
  // branchlessly (`nor`/shift). One offline pair pins that the frontend recovers BOTH shapes,
  // and that the divergence is the compiler axis, not a decode accident.
  {
    file: 'gcc-clamp0.asm',
    sym: 'clamp0',
    target: MIPS_GCC,
    note: "same source as ido-clamp0, GCC's branchless lowering — nor decode + `>>31` sign trick",
    expect: 's32 clamp0(s32 a0) {\n    return a0 & ~a0 >> 31;\n}\n',
  },

  // ── Sibling pair on a DIVERGENT-IF: byte-exact on IDO, LOUD-FAIL on GCC ───────────────────
  // `maxab` is `if (a < b) return b; return a;`. IDO lowers it to a plain `slt; beqz` diamond that
  // asmlift matches byte-exact. KMC-GCC lowers it with `beqzl` — a BRANCH-LIKELY whose delay slot
  // is annulled (only runs when taken). The frontend does not decode branch-likely; it LOUD-FAILS
  // (never a silent branch drop) — pinned in the dedicated test below. The IDO sibling stays a
  // positive fixture here.
  {
    file: 'ido-maxab.asm',
    sym: 'maxab',
    target: MIPS_IDO,
    note: 'divergent-if, two args — byte-exact on IDO',
    expect:
      's32 maxab(s32 a0, s32 a1) {\n    if (a0 < a1) {\n        return a1;\n    } else {\n        return a0;\n    }\n}\n',
  },

  // ── PowerPC / CodeWarrior (GameCube) — the third ISA, its objdump captured verbatim ──────
  {
    file: 'ppc-deref.asm',
    sym: 'deref',
    target: PPC_MWCC,
    note: 'pointer load (lwz)',
    expect: 's32 deref(s32 * a0) {\n    return *a0;\n}\n',
  },
  {
    file: 'ppc-shl3.asm',
    sym: 'shl3',
    target: PPC_MWCC,
    note: 'shift-left immediate (slwi ext-mnemonic)',
    expect: 's32 shl3(s32 a0) {\n    return a0 << 3;\n}\n',
  },
  {
    file: 'ppc-maxab.asm',
    sym: 'maxab',
    target: PPC_MWCC,
    note: 'CONDITIONAL RETURN (bgelr) — cmpw sets cr0, bgelr returns; modelled as a divergent-if',
    expect:
      's32 maxab(s32 a0, s32 a1) {\n    if (a0 < a1) {\n        return a1;\n    } else {\n        return a0;\n    }\n}\n',
  },
  {
    file: 'ppc-clamp0.asm',
    sym: 'clamp0',
    target: PPC_MWCC,
    note: 'cmpwi vs 0 + conditional return — divergent-if against an immediate (emit pinned; this is a live near-miss on recompile, ppc-mwcc.test)',
    expect: 's32 clamp0(s32 a0) {\n    if (a0 < 0) {\n        return 0;\n    } else {\n        return a0;\n    }\n}\n',
  },
];

describe('offline corpus: committed disassembly → decompile → golden C (no toolchain)', () => {
  for (const c of CASES) {
    test(`${c.file} — ${c.note}`, () => {
      const r = decompile(c.sym, read(c.file), c.target);
      expect(r.source).toBe(c.expect);
    });
  }

  test('the IDO and GCC clamp0 siblings genuinely diverge (compiler-as-spec, not noise)', () => {
    const ido = decompile('clamp0', read('ido-clamp0.asm'), MIPS_IDO).source;
    const gcc = decompile('clamp0', read('gcc-clamp0.asm'), MIPS_GCC).source;
    expect(ido).not.toBe(gcc); // same source C, two compilers, two recovered shapes
    expect(ido).toContain('if (a0 < 0)');
    expect(gcc).toContain('& ~a0 >> 31');
  });

  test('maxab pins the GCC branch-likely gap offline (IDO matches; GCC loud-fails)', () => {
    // IDO matches byte-exact; GCC lowers with `beqzl` (branch-likely). The frontend does not
    // decode branch-likely — it must LOUD-FAIL, never silently drop the branch (which would emit a
    // bogus `return a0;`). When branch-likely decode lands, the throw flips to a recovered
    // diamond. Visible without Docker.
    const ido = decompile('maxab', read('ido-maxab.asm'), MIPS_IDO).source;
    expect(ido).toContain('if (a0 < a1)'); // real diamond recovered
    expect(() => decompile('maxab', read('gcc-maxab.asm'), MIPS_GCC)).toThrow(
      /branch-likely|unmodelled control transfer/,
    ); // loud-fail, not a silent branch drop
  });
});
