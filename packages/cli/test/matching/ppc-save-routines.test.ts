// CODEWARRIOR'S OUT-OF-LINE REGISTER SAVE, ON THE TWO BUILDS THE SYNTHETIC TIER DOES NOT RUN.
//
// `addi r11,r1,N; bl _savegpr_NN` saves rNN..r31 below r11 and `_restgpr_NN` reloads them
// (frontend/ppc.ts `saveRoutineOf`). The synthetic tier carries it on mwcc_242_81 (`savechain`,
// `dotprod`); mwcc_247_107 and mwcc_233_163n have no synthetic rows, so each is compiled here,
// lifted, recompiled with the same build and scored.
//
// WHICH BUILD EMITS IT AT WHICH LEVEL is the reason each case carries its own flags. mwcc_247_107
// emits it at Mario Party 4's DOL flags, the ones its rows use. mwcc_233_163n NEVER emits it at
// Pikmin's `-O4,p`: it saves with `stmw`/`lmw` there, and no Pikmin row carries the routine. It does
// at `-O0,p`, a profile no mwcc_233_163n row compiles at, so that case pins the frontend on the
// build's own routine names rather than any row, and the `stmw` case says why no Pikmin row moves.
import { decompile } from '@asmlift/core/pipeline';
import { targetFor } from '@asmlift/core/target';
import { type MwccToolchainId, compilePpcTarget, scoreCPpc } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

/** A compile in the container costs seconds; a case is two of them. */
const BUDGET = 300_000;

const BASE = ['-proc', 'gekko', '-align', 'powerpc', '-enum', 'int', '-fp', 'hardware', '-Cpp_exceptions', 'off'];
/** Mario Party 4's DOL unit flags as its rows store them: `-O4,p` early and `-O0,p` late, and the
 *  later level is the one the compiler acts on. */
const MP4_DOL = [
  ...BASE,
  ...['-O4,p', '-inline', 'auto', '-pragma', 'cats off', '-RTTI', 'off', '-fp_contract', 'on', '-str', 'reuse'],
  ...['-O0,p', '-char', 'unsigned', '-fp_contract', 'off', '-lang=c'],
];
/** Pikmin's unit flags as its rows store them (`-O4,p`, C++). */
const PIKMIN = [
  ...BASE,
  ...['-O4,p', '-inline', 'auto', '-pragma', 'cats off', '-RTTI', 'off', '-fp_contract', 'off', '-str', 'reuse'],
  ...['-RTTI', 'on', '-char', 'unsigned', '-lang=c++'],
];
/** Pikmin's set at `-O0,p` and in C: the profile at which this build emits the routine. */
const PIKMIN_O0 = [...PIKMIN.filter((f) => f !== '-O4,p' && f !== '-lang=c++'), '-O0,p', '-lang=c'];

// At `-O0,p` every local gets a callee-saved register of its own, and each one here is read twice,
// so the lift keeps all five and the recompile allocates them the same way.
const PAIRS = {
  sym: 'pairs',
  c: 'int k(int,int); int pairs(int a,int b){ int x,y,z,w,u; x=k(a,b); y=k(x,a); z=k(y,x); w=k(z,y); u=k(w,z); return k(u,w) + u; }',
  proto: { k: { params: 2 } },
  expect:
    's32 pairs(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 v3;\n    s32 v4;\n' +
    '    v0 = k(a0, a1);\n    v1 = k(v0, a0);\n    v2 = k(v1, v0);\n    v3 = k(v2, v1);\n    v4 = k(v3, v2);\n' +
    '    return v4 + k(v4, v3);\n}\n',
};

const CASES: [MwccToolchainId, string, readonly string[]][] = [
  ['mwcc_247_107', 'Mario Party 4 DOL flags', MP4_DOL],
  ['mwcc_233_163n', '-O0,p (no row uses it)', PIKMIN_O0],
];

describe('the register save routine, lifted and recompiled on each build that emits it', () => {
  for (const [mwcc, label, flags] of CASES) {
    test.runIf(ppcDockerGate('ppc-save-routines', mwcc))(
      `${mwcc} at ${label}`,
      () => {
        const { obj, asm } = compilePpcTarget(mwcc, PAIRS.c, PAIRS.sym, flags);
        expect(asm).toMatch(/R_PPC_REL24\s+_savegpr_26\b/);
        expect(asm).toMatch(/R_PPC_REL24\s+_restgpr_26\b/);
        const r = decompile(PAIRS.sym, asm, targetFor(mwcc, flags).target, { prototypes: PAIRS.proto });
        expect(r.source).toBe(PAIRS.expect);
        const s = scoreCPpc(mwcc, r.source, PAIRS.sym, obj, flags);
        expect(s.score, JSON.stringify(s)).toBe(0);
        expect(s.match).toBe(true);
      },
      BUDGET,
    );
  }

  test.runIf(ppcDockerGate('ppc-save-routines', 'mwcc_233_163n'))(
    "mwcc_233_163n at Pikmin's own -O4,p saves with stmw, not the routine",
    () => {
      // Seven registers live across the calls; mwcc 2.4.x saves them with `_savegpr_25` here.
      const c =
        'int k(int); int chain8(int a,int b,int c,int d,int e,int f,int g,int h){ return k(k(k(k(k(k(k(a)+b)+c)+d)+e)+f)+g)+h; }';
      const { asm } = compilePpcTarget('mwcc_233_163n', c, 'chain8', PIKMIN);
      expect(asm).toMatch(/\bstmw\s+r25,/);
      expect(asm).not.toMatch(/_(save|rest)[gf]pr_/);
    },
    BUDGET,
  );
});
