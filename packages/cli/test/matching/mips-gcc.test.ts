// MIPS + KMC GCC — the SECOND compiler on the SAME ISA. Reference C → KMC GCC (in a linux/386
// Docker container; the binary is a Linux/i386 ELF) → MIPS object (scoring target) + host objdump
// disasm (asmlift input) → decompile → recompile with the SAME GCC → REAL objdiff score. The MIPS
// frontend is reused verbatim (`id:"mips"`); only `target.compiler` ("gcc") differs from MIPS_IDO
// — the controlled experiment for "the compiler is the spec".
//
// Docker-gated: skips cleanly where no daemon is reachable. The byte-exact cases cover the
// GCC-vs-IDO divergences: compiler-tagged + commutativity-aware idiom fold (half), the widened
// `nor` decode (clamp0), and unsigned compares (ucmp). The remaining frontier (GCC's `bnezl`
// branch-likely) is pinned as a documented, flip-on-fix gap.
import { RewritePattern, SDIV_POW2_2 } from '@asmlift/core/pattern/engine';
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import { MIPS_GCC } from '@asmlift/core/target';
import { compileMipsGccTarget, scoreCMipsGcc } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { dockerGate } from './docker-gate';

const HAVE_DOCKER = dockerGate('mips-gcc');

// KMC-GCC codegen that asmlift reproduces byte-exact — the flow works AND the compiler-specific
// idioms are handled. Each notes the GCC-vs-IDO divergence it exercises.
const MATCH_CASES: { sym: string; c: string; proto?: Prototypes; patterns?: RewritePattern[]; expect: string }[] = [
  {
    sym: 'add3',
    c: 'int add3(int a, int b, int c){ return a + b + c; }',
    expect: 's32 add3(s32 a0, s32 a1, s32 a2) {\n    return a0 + a1 + a2;\n}\n',
  },
  { sym: 'deref', c: 'int deref(int *p){ return *p; }', expect: 's32 deref(s32 * a0) {\n    return *a0;\n}\n' },
  // Variable-index array (raise/arrays.ts) — GCC reuses a1 and orders `addu a1,a1,a0` (scaled
  // operand FIRST) vs IDO's temps + `addu t7,a0,t6`; the recognizer is operand-order-agnostic.
  {
    sym: 'aget',
    c: 'int aget(int *a, int i){ return a[i]; }',
    expect: 's32 aget(s32 * a0, s32 a1) {\n    return a0[a1];\n}\n',
  },
  // Signed /2: GCC strength-reduces to the SAME shift idiom as agbcc (despite N64 hw-divide), but
  // emits `addu v0,v0,a0` (shifted operand FIRST) — folds via the compiler-tagged, commutativity-
  // aware pattern (compilers: ["agbcc","gcc"]).
  {
    sym: 'half',
    c: 'int half(int x){ return x / 2; }',
    patterns: [SDIV_POW2_2],
    expect: 's32 half(s32 a0) {\n    return a0 / 2;\n}\n',
  },
  // Branchless `x<0?0:x`: GCC uses `nor v0,zero,a0` (zero in the FIRST operand) — the widened
  // frontend `nor` decode recovers `~a0` rather than dropping the complement.
  {
    sym: 'clamp0',
    c: 'int clamp0(int x){ if (x < 0) x = 0; return x; }',
    expect: 's32 clamp0(s32 a0) {\n    return a0 & ~a0 >> 31;\n}\n',
  },
  // Unsigned compare: `sltu v0,a0,a1` → `icmp_ult`; recover types the operands u32 so the backend
  // re-emits `sltu` (operator is the same `<`; signedness lives in the operand types).
  {
    sym: 'ucmp',
    c: 'int ucmp(unsigned a, unsigned b){ return a < b; }',
    expect: 'u32 ucmp(u32 a0, u32 a1) {\n    return a0 < a1;\n}\n',
  },
];

describe.runIf(HAVE_DOCKER)('MIPS (KMC GCC) — first-class: compile → disasm → decompile → recompile → objdiff', () => {
  for (const { sym, c, proto, patterns, expect: golden } of MATCH_CASES) {
    test(`${sym} — byte-exact`, () => {
      const { obj, asm } = compileMipsGccTarget(c, sym);
      const r = decompile(sym, asm, MIPS_GCC, { prototypes: proto, patterns });
      expect(r.source).toBe(golden);
      const s = scoreCMipsGcc(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    }, 60_000);
  }
});

// The next GCC frontier (flow runs end-to-end, not yet matching) — pinned to flip on fix.
describe.runIf(HAVE_DOCKER)('MIPS (KMC GCC) — remaining frontier (documented gap)', () => {
  test('umax: GCC -O2 emits `bnezl` (branch-likely) — loud-fails, never a silent branch drop', () => {
    // `if (a < b) a = b;` compiles to `sltu; bnezl; move` — a branch-LIKELY that annuls its delay
    // slot when not taken. The frontend models only ordinary branches; silently dropping the
    // branch (the `if` lost) would be a soundness hole, so the MIPS catch-all loud-fails,
    // mirroring PPC. Delay-slot annulment is the missing frontend feature (flip to a match then).
    const { asm } = compileMipsGccTarget(
      'unsigned umax(unsigned a, unsigned b){ if (a < b) a = b; return a; }',
      'umax',
    );
    expect(() => decompile('umax', asm, MIPS_GCC)).toThrow(/branch-likely|unmodelled control transfer/);
  }, 60_000);
});
