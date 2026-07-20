// PowerPC + Metrowerks CodeWarrior — the THIRD ISA and FOURTH compiler, run end-to-end through the
// SAME pipeline as Thumb/MIPS. Each case: reference C → CodeWarrior `mwcceppc` (a 32-bit Win32 PE
// run through a 32-bit `wibo` in a linux/386 Docker container, exactly as decomp.me runs it) →
// PowerPC object (scoring target) + `powerpc-eabi-objdump` disassembly (asmlift input) → decompile
// → recompile with the SAME CodeWarrior → REAL objdiff score. Byte-exact (0) means asmlift
// reproduced CodeWarrior's exact Gekko codegen.
//
// The image (packages/toolchains/ppc-docker) bundles a from-source 32-bit wibo 0.6.16 + a PowerPC objdump; the
// PROPRIETARY CodeWarrior binaries are bind-mounted from decomp.me's vendored dir, never committed
// (see MWCC_PPC_TOOLCHAIN / compilePpcTarget). Version = the spec: mwcc_242_81 (CodeWarrior 2.4.2).
//
// Docker-gated: skips cleanly where no daemon (or the image) is reachable. What this proves on the
// shared seam: PowerPC needed NO IR change — the condition-register compare→branch FUSES into
// `cond_br` (the seam-spike finding, on real codegen), the conditional-return idiom (`bgelr`)
// structures as a divergent-if, and CodeWarrior's extended mnemonics (mr/subf/slwi/clrlwi) decode
// into the existing neutral vocabulary. The `flags` capability stays a documented hardware fact.
//
// HONEST SCOPE: these fixtures are a representative SAMPLE of the straight-line + simple-`if` leaf
// class, not an exhaustive sweep of it. Sibling leaf shapes exist that this frontend does NOT yet
// match — boolean-producing compares (`return a<b;` via `subf/cntlzw/srwi`) and `&&`/`||`. Those
// hit unmodelled ops and FAIL LOUD (@asmlift/core test/ppc-frontend.test.ts) rather than emit
// plausible-but-wrong C, as does a genuine rotate/insert `rlwinm` (mask not ending at bit 31) —
// the right-shift EXTRACT form is decoded (PPC-WIDEN below). Widening coverage is follow-on work.
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import { PPC_MWCC } from '@asmlift/core/target';
import { compilePpcTarget, scoreCPpc } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

const HAVE = ppcDockerGate('ppc-mwcc');

// CodeWarrior codegen asmlift reproduces byte-exact — the flow works AND the PPC-specific shapes
// (extended mnemonics, cr0 fusion, conditional-return) are handled.
const MATCH_CASES: { sym: string; c: string; expect: string }[] = [
  { sym: 'deref', c: 'int deref(int *p){ return *p; }', expect: 's32 deref(s32 * a0) {\n    return *a0;\n}\n' },
  {
    sym: 'sub',
    c: 'int sub(int a,int b){ return a-b; }', // `subf rD,rA,rB` = rB-rA (reversed operands)
    expect: 's32 sub(s32 a0, s32 a1) {\n    return a0 - a1;\n}\n',
  },
  {
    sym: 'shl3',
    c: 'int shl3(int a){ return a<<3; }', // `slwi` extended mnemonic (rlwinm rotate)
    expect: 's32 shl3(s32 a0) {\n    return a0 << 3;\n}\n',
  },
  {
    sym: 'lowbyte',
    c: 'unsigned lowbyte(unsigned x){ return x & 0xff; }', // `clrlwi` = masked AND
    expect: 's32 lowbyte(s32 a0) {\n    return a0 & 255;\n}\n',
  },
  {
    sym: 'addmul',
    c: 'int addmul(int a,int b){ int t=a+b; return t*t; }', // reused temp inlines twice
    expect: 's32 addmul(s32 a0, s32 a1) {\n    return (a0 + a1) * (a0 + a1);\n}\n',
  },
  // The flagship control-flow case: `cmpw r3,r4; bgelr; mr r3,r4; blr` — a CONDITIONAL RETURN. The
  // cr0 compare fuses into the branch; the `bgelr` becomes a divergent-if via a synthetic return.
  {
    sym: 'maxab',
    c: 'int maxab(int a,int b){ if(a<b) return b; return a; }',
    expect:
      's32 maxab(s32 a0, s32 a1) {\n    if (a0 < a1) {\n        return a1;\n    } else {\n        return a0;\n    }\n}\n',
  },
];

describe('PowerPC (CodeWarrior) fixtures: compile → disasm → decompile → recompile → objdiff', () => {
  for (const { sym, c, expect: golden } of MATCH_CASES) {
    test.runIf(HAVE)(`${sym}`, () => {
      const { obj, asm } = compilePpcTarget(c, sym);
      const r = decompile(sym, asm, PPC_MWCC);
      expect(r.source).toBe(golden);
      const s = scoreCPpc(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// S5 — COMPLEMENTED-LOGIC + SIGN-EXTEND decodes. `andc`/`orc`/`eqv`/`nand` and `extsb`/`extsh`
// decode to the idiomatic C that recompiles byte-exact (left opaque, the whole function errors).
// The flagship is `clampand`: agbcc/mwcc lower the branchless clamp `x & ~(x>>31)` to
// `srawi r0,r3,31; andc r3,r3,r0` — the `andc` decode alone recovers the clamp0 idiom, so NO
// `select` IR node is needed (the faithful branchless C round-trips exactly).
const S5_CASES: { sym: string; c: string; expect: string }[] = [
  {
    sym: 'andc',
    c: 'int andc(int a,int b){ return a & ~b; }',
    expect: 's32 andc(s32 a0, s32 a1) {\n    return a0 & ~a1;\n}\n',
  },
  {
    sym: 'orc',
    c: 'int orc(int a,int b){ return a | ~b; }',
    expect: 's32 orc(s32 a0, s32 a1) {\n    return a0 | ~a1;\n}\n',
  },
  {
    sym: 'eqv',
    c: 'int eqv(int a,int b){ return ~(a ^ b); }',
    expect: 's32 eqv(s32 a0, s32 a1) {\n    return ~(a0 ^ a1);\n}\n',
  },
  {
    sym: 'nand',
    c: 'int nand(int a,int b){ return ~(a & b); }',
    expect: 's32 nand(s32 a0, s32 a1) {\n    return ~(a0 & a1);\n}\n',
  },
  {
    sym: 'extsb',
    c: 'int extsb(signed char x){ return (int)(signed char)x; }',
    expect: 's32 extsb(s32 a0) {\n    return (s8)a0;\n}\n',
  },
  {
    sym: 'extsh',
    c: 'int extsh(short x){ return (int)(short)x; }',
    expect: 's32 extsh(s32 a0) {\n    return (s16)a0;\n}\n',
  },
  {
    sym: 'clampand',
    c: 'int clampand(int x){ return x & ~(x >> 31); }', // srawi;andc — the clamp0 idiom
    expect: 's32 clampand(s32 a0) {\n    return a0 & ~(a0 >> 31);\n}\n',
  },
];

describe('PowerPC S5: complemented-logic (andc/orc/eqv/nand) + sign-extend (extsb/extsh) → objdiff', () => {
  for (const { sym, c, expect: golden } of S5_CASES) {
    test.runIf(HAVE)(`${sym}`, () => {
      const { obj, asm } = compilePpcTarget(c, sym);
      const r = decompile(sym, asm, PPC_MWCC);
      expect(r.source).toBe(golden);
      const s = scoreCPpc(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// PPC INDEXED-LOAD: mwcc addresses EVERY variable-index array access with register+register
// indexed loads/stores (`lwzx rD,rA,rB` = *(rA+rB)), NOT base+displacement — left opaque, PPC
// could match no `a[i]` at all (scalar or struct). The frontend decodes the indexed family into
// `add(rA,rB)` + a zero-offset load/store, the exact shape recognizeArrays consumes, so
// variable-index arrays recover + recompile byte-exact.
const INDEXED_CASES: { sym: string; c: string; proto?: Prototypes; expect: string }[] = [
  {
    sym: 'aget',
    c: 'int aget(int *a, int i){ return a[i]; }', // slwi + lwzx
    expect: 's32 aget(s32 * a0, s32 a1) {\n    return a0[a1];\n}\n',
  },
  {
    sym: 'aset',
    c: 'void aset(int *a, int i, int v){ a[i] = v; }',
    proto: { aset: { returnsVoid: true } }, // slwi + stwx
    expect: 'void aset(s32 * a0, s32 a1, s32 a2) {\n    a0[a1] = a2;\n    return;\n}\n',
  },
  {
    sym: 'asget',
    c: 'short asget(short *a, int i){ return a[i]; }', // slwi #1 + lhax (sign-extend)
    expect: 's32 asget(s16 * a0, s32 a1) {\n    return a0[a1];\n}\n',
  },
];

describe('PowerPC INDEXED-LOAD: variable-index arrays (lwzx/stwx/lhax) → recompile → objdiff', () => {
  for (const { sym, c, proto, expect: golden } of INDEXED_CASES) {
    test.runIf(HAVE)(`${sym}`, () => {
      const { obj, asm } = compilePpcTarget(c, sym);
      const r = decompile(sym, asm, PPC_MWCC, { prototypes: proto ?? {} });
      expect(r.source).toBe(golden);
      const s = scoreCPpc(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// PPC-WIDEN: `bl` calls (with the callee recovered from the R_PPC_REL24
// relocation, since an unresolved `bl` in a .o encodes a 0 placeholder), the member-call frame
// (stwu/mflr/mtlr + r1-relative spills are transparent), and the `rlwinm` right-shift bitfield
// EXTRACT `(x>>n)&m`. These are the prerequisites for evaluating a C++ backend on real, call-heavy
// C++ (a backend is worthless on functions the frontend cannot lift).
const WIDEN_CASES: { sym: string; c: string; proto?: Prototypes; expect: string }[] = [
  {
    sym: 'callone',
    c: 'int g(int); int callone(int x){ return g(x) + 1; }',
    proto: { g: { params: 1 } },
    expect: 's32 callone(s32 a0) {\n    return g(a0) + 1;\n}\n',
  },
  {
    sym: 'calltwo',
    c: 'int add3(int,int,int); int calltwo(int a,int b){ return add3(a,b,7); }',
    proto: { add3: { params: 3 } },
    expect: 's32 calltwo(s32 a0, s32 a1) {\n    return add3(a0, a1, 7);\n}\n',
  },
  // A parameter preserved across the call (mwcc keeps `y` in a callee-saved register): the spill to
  // and reload from the r1 frame are transparent, so `y` survives and `g` is recovered one-arg.
  {
    sym: 'callsurv',
    c: 'int g(int); int callsurv(int x,int y){ return g(x) + y; }',
    proto: { g: { params: 1 } },
    expect: 's32 callsurv(s32 a0, s32 a1) {\n    return a1 + g(a0);\n}\n',
  },
  // rlwinm right-shift extract: `(x>>5)&0xff` → `rlwinm r3,r3,27,24,31`. Recovered as shift+mask.
  {
    sym: 'extract',
    c: 'int extract(int x){ return (x >> 5) & 0xff; }',
    expect: 's32 extract(s32 a0) {\n    return a0 >> 5 & 255;\n}\n',
  },
  {
    sym: 'shr_and',
    c: 'unsigned shr_and(unsigned x){ return (x >> 8) & 0xf; }',
    expect: 's32 shr_and(s32 a0) {\n    return a0 >> 8 & 15;\n}\n',
  },
];

describe('PowerPC PPC-WIDEN: bl calls (reloc-recovered) + frame transparency + rlwinm extract', () => {
  for (const { sym, c, proto, expect: golden } of WIDEN_CASES) {
    test.runIf(HAVE)(`${sym}`, () => {
      const { obj, asm } = compilePpcTarget(c, sym);
      const r = decompile(sym, asm, PPC_MWCC, { prototypes: proto });
      expect(r.source).toBe(golden);
      const s = scoreCPpc(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// NEAR-MISS frontier — asmlift decompiles these correctly and they RECOMPILE to a few-byte-different
// object (documented, pinned; cf. `neset` in fixtures.ts). Each is a compiler-reassociation /
// speculative-execution shape, NOT a decode bug: the recovered C is semantically faithful but
// CodeWarrior canonicalizes it into a different-but-equivalent instruction sequence on the way back.
const NEARMISS_CASES: { sym: string; c: string; expect: string; note: string }[] = [
  {
    sym: 'add3',
    c: 'int add3(int a,int b,int c){return a+b+c;}',
    expect: 's32 add3(s32 a0, s32 a1, s32 a2) {\n    return a0 + (a1 + a2);\n}\n',
    note: 'CW computed a+(b+c) (saving a in r0); recompiling reassociates → 3-byte diff',
  },
  {
    sym: 'clamp0',
    c: 'int clamp0(int x){ if(x<0) x=0; return x; }',
    expect: 's32 clamp0(s32 a0) {\n    if (a0 < 0) {\n        return 0;\n    } else {\n        return a0;\n    }\n}\n',
    note: 'the if/else-return recompiles to a different branch layout than the original bgelr',
  },
  {
    sym: 'selret',
    c: 'int selret(int a,int b){ if(a<b) return a+1; return b+2; }',
    expect:
      's32 selret(s32 a0, s32 a1) {\n    s32 v0;\n    if (a0 >= a1) {\n        v0 = a1 + 2;\n    } else {\n        v0 = a0 + 1;\n    }\n    return v0;\n}\n',
    note: 'CW hoisted `b+2` before the branch (speculative); the recovered if/else does not',
  },
];

describe('PowerPC (CodeWarrior) near-miss frontier — decoded faithfully, recompiles non-exact', () => {
  for (const { sym, c, expect: golden, note } of NEARMISS_CASES) {
    test.runIf(HAVE)(`${sym} — ${note}`, () => {
      const { obj, asm } = compilePpcTarget(c, sym);
      const r = decompile(sym, asm, PPC_MWCC);
      expect(r.source).toBe(golden); // the decode/emit is pinned and correct…
      const s = scoreCPpc(r.source, sym, obj);
      expect(s.match).toBe(false); // …the recompile is a documented near-miss (flip when closed)
      expect(s.score).toBeGreaterThan(0);
    });
  }
});
