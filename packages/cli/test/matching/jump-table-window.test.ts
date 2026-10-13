// DENSE SWITCHES WHOSE JUMP TABLE THE COMPILER SCHEDULES AROUND, compiled and recompiled on the
// toolchains the synthetic tier does not cover (mwcc 2.3.3, mwcc 2.4.7, gcc 2.7.2) and on mwcc 2.4.2
// beside them: reference C → target → lift (frontend/ppc.ts `recoverPpcJumpTables`, frontend/mips.ts
// `recoverMipsJumpTables`) → candidate → scored. Each shape declined at the indirect jump before.
//
// - `sched`: every arm calls, so the function saves LR, and all three mwcc builds schedule that
//   store between the bound and its branch (`cmplwi r3,7 ; stw r0,20(r1) ; bgt-`; 2.3.3 saves before
//   the push and schedules both, `stw r0,4(r1) ; stwu r1,-8(r1)`).
// - `fall`: the default falls straight out of a leaf, and all three bound the table with a
//   conditional return (`bgtlr-`), so the default edge is the return.
// - `loop`: a switch inside a loop. mwcc 2.3.3 alone hoists the table base out of the loop
//   (`lis r5 ; addi r5,r5` at entry); 2.4.2 and 2.4.7 form it in the dispatch. KMC and gcc 2.7.2
//   hoist it into the preheader (`lui ; addiu`). Each shape asserts where its compiler put the base,
//   so a compiler that stopped hoisting would fail here rather than pass without exercising it.
//
// mwcc 2.3.3 and 2.4.7 have no canonical flag set of their own; every build compiles at mwcc
// 2.4.2's, the set the shapes were measured at.
import { decompile } from '@asmlift/core/pipeline';
import { prototypesFromContext } from '@asmlift/core/proto-context';
import { MIPS_GCC, PPC_MWCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  type MwccToolchainId,
  compileCandPpc,
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compilePpcTarget,
  extractAsmData,
  gcc272Available,
  scoreCMipsGcc,
  scoreObjects,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { kmcGate, ppcDockerGate } from './docker-gate';

const ARMS =
  'case 0:*p=1;break;case 1:*p=5;break;case 2:*p=6;break;case 3:*p=7;break;case 4:*p=3;break;case 5:*p=2;break;case 6:*p=9;break;case 7:*p=4;break;';

const SCHED = {
  sym: 'sched',
  head: 'int jg(int);\nvoid jh(int);\n',
  c: 'int sched(int x,int *p){ switch(x){case 0:jh(1);break;case 1:jh(2);break;case 2:return jg(p[0]);case 3:jh(4);break;case 4:jh(5);break;case 5:jh(6);break;case 6:jh(7);break;case 7:jh(9);break;} return -1; }',
};
const FALL = {
  sym: 'fall',
  head: '',
  c: 'void fall(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p=2;break;case 2:*p+=3;case 3:*p+=4;break;case 4:*p=5;break;case 5:*p=6;break;case 6:*p=7;break;case 7:*p=8;break;} }',
};
/** A `for` loop on PowerPC; a `do … while` on MIPS, where gcc 2.7.2's `for` lifts an extra parameter
 *  out of the loop counter's delay-slot initialisation (unrelated to the table). */
const LOOP = {
  sym: 'loop',
  head: '',
  c: `void loop(int n,int *p){ int i; for(i=0;i<n;i++){ switch(p[i]){${ARMS.replace(/\*p/g, 'p[i]')}} } }`,
};
const DO = { sym: 'dloop', head: '', c: `void dloop(int n,int *p){ do { switch(*p){${ARMS}} p++; } while(--n); }` };

/** The instructions between the bounds branch and the indirect jump: the dispatch block. */
const dispatchBlock = (asm: string, bound: RegExp, jump: RegExp): string => {
  const lines = asm.split('\n').filter((l) => /^\s+[0-9a-f]+:\t/.test(l));
  const j = lines.findIndex((l) => jump.test(l));
  let b = j - 1;
  while (b >= 0 && !bound.test(lines[b])) {
    b--;
  }
  return lines.slice(b + 1, j).join('\n');
};

const PPC_FLAGS = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
const BUDGET = 300_000;

describe.each(['mwcc_242_81', 'mwcc_233_163n', 'mwcc_247_107'] as MwccToolchainId[])(
  'a scheduled-around PowerPC jump table recompiles byte-exact: %s',
  (id) => {
    const run = (s: { sym: string; head: string; c: string }) => {
      const { obj, asm } = compilePpcTarget(id, s.head + s.c, s.sym, PPC_FLAGS);
      const prototypes = prototypesFromContext(s.head + s.c.slice(0, s.c.indexOf('{')) + ';', 'c');
      const source = decompile(s.sym, asm, PPC_MWCC, {
        asmData: extractAsmData(obj, PPC_MWCC, s.sym),
        prototypes,
      }).source;
      expect(source).toContain('switch (');
      expect(scoreObjects(obj, compileCandPpc(id, s.head + source, PPC_FLAGS), s.sym).score, source).toBe(0);
      return asm;
    };
    const gated = ppcDockerGate('jump-table-window', id);

    test.runIf(gated)(
      'an LR save scheduled between the bound and its branch',
      () => {
        expect(run(SCHED)).toMatch(/cmplwi\s+r3,7\n(\s+[0-9a-f]+:\tstwu?\s+r[01],-?\d+\(r1\)\n)+\s+[0-9a-f]+:\tbgt/);
      },
      BUDGET,
    );
    test.runIf(gated)('a bgtlr bound', () => expect(run(FALL)).toMatch(/\tbgtlr/), BUDGET);
    test.runIf(gated)(
      'a switch in a loop, its table base hoisted by 2.3.3 alone',
      () => {
        const block = dispatchBlock(run(LOOP), /\tbgt/, /\tbctr/);
        expect(/\tlis\s/.test(block), block).toBe(id !== 'mwcc_233_163n');
      },
      BUDGET,
    );
  },
);

describe('a MIPS jump table based in the loop preheader recompiles byte-exact', () => {
  const hoisted = (asm: string) => expect(dispatchBlock(asm, /\tbeqz\t/, /\tjr\tv0/)).not.toMatch(/\tlui\t/);
  const VOID = prototypesFromContext(DO.c.slice(0, DO.c.indexOf('{')) + ';', 'c');

  test.runIf(kmcGate('jump-table-window-kmc'))(
    'gcc2.7.2kmc',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags;
      const { obj, asm } = compileMipsGccTarget(DO.c, DO.sym, flags);
      hoisted(asm);
      const source = decompile(DO.sym, asm, MIPS_GCC, {
        asmData: extractAsmData(obj, MIPS_GCC, DO.sym),
        prototypes: VOID,
      }).source;
      expect(source).toContain('switch (');
      expect(scoreCMipsGcc(source, DO.sym, obj, flags).score, source).toBe(0);
    },
    60_000,
  );

  test.runIf(gcc272Available())(
    'gcc2.7.2',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
      const { obj, asm } = compileMipsGcc272Target(DO.c, DO.sym, flags);
      hoisted(asm);
      const source = decompile(DO.sym, asm, MIPS_GCC, {
        asmData: extractAsmData(obj, MIPS_GCC, DO.sym),
        prototypes: VOID,
      }).source;
      expect(source).toContain('switch (');
      expect(scoreObjects(obj, compileMipsGcc272Target(source, DO.sym, flags).obj, DO.sym).score, source).toBe(0);
    },
    60_000,
  );
});
