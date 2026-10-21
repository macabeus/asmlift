// A FILE-SCOPE GLOBAL REGISTER VARIABLE round-trips byte-exact on every compiler that accepts one.
//
// `register int g __asm__("r8");` is how compiled code reads a callee-saved register it never saved
// (`return g;` is `mov r0, r8`) and writes one it never restores (`g = a;` is `mov r8, r0`): gcc's
// `globalize_reg` makes the register fixed and call-used, so no prologue saves it. The lift reads
// and writes such a register as a global (`target.globalRegisterVariables`), and the candidate's
// declarations declare that global in the register. Each fixture compiles the C, lifts the asm,
// compiles the lift with its synthesized declarations, and scores the two objects. mwcc 2.4 takes
// them only as a run from r14, so its `r15` reader needs the filler for r14 the declarations add.
import { renderDeclarations } from '@asmlift/core/declare';
import { enumerateCandidates } from '@asmlift/core/rank';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  agbccAvailable,
  assembleTarget,
  compileCandAgbcc,
  compileCandKmc,
  compileCandPpc,
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compilePpcTarget,
  compileTargetAsm,
  gcc272Available,
  scoreObjects,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { kmcGate, ppcDockerGate } from './docker-gate';

/** `read`, `add` and `write` over a global register variable declared by `decl`. */
const bodies = (decl: string) => [
  ['read', `${decl}\nint read(void){ return g; }`],
  ['add', `${decl}\nint add(int a){ return a + g; }`],
  ['write', `${decl}\nvoid write(int a){ g = a; }`],
];

/** The lifted candidate with its declarations, as the scorer compiles it. */
const lifted = (sym: string, asm: string, toolchain: keyof typeof TOOLCHAIN_TARGETS): string => {
  const [c] = enumerateCandidates(sym, asm, TOOLCHAIN_TARGETS[toolchain].description, {});
  expect(c.source).toMatch(/greg_r\d+/);
  return renderDeclarations(c.symbolRefs ?? []) + c.source;
};

describe('a global register variable round-trips byte-exact', () => {
  test.runIf(agbccAvailable())('agbcc: r8 and sl', () => {
    const flags = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
    for (const decl of ['register int g __asm__("r8");', 'register int g __asm__("r10");']) {
      for (const [sym, src] of bodies(decl)) {
        const asm = compileTargetAsm(src, flags);
        const r = scoreObjects(assembleTarget(asm), compileCandAgbcc(lifted(sym, asm, 'agbcc'), flags), sym);
        expect([decl, sym, r.match]).toEqual([decl, sym, true]);
      }
    }
  });

  test.runIf(kmcGate('global-register-variables-kmc'))(
    'gcc2.7.2kmc: s0 and s8',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags;
      for (const decl of ['register int g __asm__("$16");', 'register int g __asm__("$30");']) {
        for (const [sym, src] of bodies(decl)) {
          const { obj, asm } = compileMipsGccTarget(src, sym, flags);
          const r = scoreObjects(obj, compileCandKmc(lifted(sym, asm, 'gcc2.7.2kmc'), flags), sym);
          expect([decl, sym, r.match]).toEqual([decl, sym, true]);
        }
      }
    },
    120_000,
  );

  test.runIf(gcc272Available())(
    'gcc2.7.2: s7',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
      for (const [sym, src] of bodies('register int g __asm__("$23");')) {
        const { obj, asm } = compileMipsGcc272Target(src, sym, flags);
        const cand = compileMipsGcc272Target(lifted(sym, asm, 'gcc2.7.2'), sym, flags).obj;
        expect([sym, scoreObjects(obj, cand, sym).match]).toEqual([sym, true]);
      }
    },
    120_000,
  );

  for (const mwcc of ['mwcc_242_81', 'mwcc_247_107'] as const) {
    test.runIf(ppcDockerGate(`global-register-variables-${mwcc}`, mwcc))(
      `${mwcc}: r14, and r15 beside the r14 it needs`,
      () => {
        const flags = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
        for (const decl of [
          'register int g __asm__("r14");',
          'register int g0 __asm__("r14"); register int g __asm__("r15");',
        ]) {
          for (const [sym, src] of bodies(decl)) {
            const { obj, asm } = compilePpcTarget(mwcc, src, sym, flags);
            const r = scoreObjects(obj, compileCandPpc(mwcc, lifted(sym, asm, mwcc), flags), sym);
            expect([decl, sym, r.match]).toEqual([decl, sym, true]);
          }
        }
      },
      240_000,
    );
  }
});
