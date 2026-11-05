// DENSE SWITCHES WHOSE JUMP TABLE THE COMPILER SCHEDULES AROUND, compiled and recompiled on the
// toolchains the synthetic tier does not cover (mwcc 2.3.3, mwcc 2.4.7, gcc 2.7.2) and on mwcc 2.4.2
// beside them: reference C → target → lift (frontend/ppc.ts `recoverPpcJumpTables`, frontend/mips.ts
// `recoverMipsJumpTables`) → candidate → scored.
//
// - `sched`: every arm calls, so the function saves LR, and all three mwcc builds schedule that
//   store between the bound and its branch (`cmplwi r3,7 ; stw r0,20(r1) ; bgt-`; 2.3.3 saves before
//   the push and schedules both, `stw r0,4(r1) ; stwu r1,-8(r1)`).
// - `fall`: the default falls straight out of a leaf, and all three bound the table with a
//   conditional return (`bgtlr-`), so the default edge is the return.
// - `reta`: the same bound, the default returning the first argument, which arrived in r3 and that
//   edge never touches — it must still return it, not fall off the end.
// - `retg`: the same with a global scrutinee and no declaration, so r3 is the only argument and the
//   body never reads it; the cases' `li r3,N ; blr` show the function returns a word.
// - `loop`: a switch inside a loop. mwcc 2.3.3 alone hoists the table base out of the loop
//   (`lis r5 ; addi r5,r5` at entry); 2.4.2 and 2.4.7 form it in the dispatch. KMC and gcc 2.7.2
//   hoist it into the preheader (`lui ; addiu`). Each shape asserts where its compiler put the base,
//   so a compiler that stopped hoisting would fail here rather than pass without exercising it.
// - `two`, `dcall`, `dpost`: two loop switches in one function, a call inside the loop, a call after
//   it. A hoisted base sits wherever the allocator put it — a callee-saved register across the call
//   (2.3.3's `lis r5 ; addi r31,r5,0`), a temporary in a function that calls after it is dead, an
//   argument register once its argument is (2.3.3's second base in r4) — and the lift asks only
//   that it reach the dispatch on every path (frontend/jump-table.ts). The two tables' arms store
//   different values, so a dispatch read through the other table's base would not recompile.
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
/** A `bgtlr` default returning the first argument, which arrived in r3 and that path never touches. */
const RETA = {
  sym: 'reta',
  head: '',
  c: 'int reta(int a,unsigned x,int *p){ switch(x){case 0:p[0]=1;return 3;case 1:p[1]=5;return 4;case 2:p[2]=6;return 7;case 3:p[3]=7;return 1;case 4:p[4]=3;return 9;case 5:p[5]=2;return 2;case 6:p[6]=9;return 0;case 7:p[7]=4;return 8;} return a; }',
};
/** RETA with the scrutinee a global and no declaration: r3 is the only argument and the body never
 *  reads it, so only the cases' `li r3,N ; blr` show the function takes it. */
const RETG = {
  sym: 'retg',
  head: 'extern unsigned gS;\n',
  c: 'int retg(int a){ switch(gS){case 0:return 3;case 1:return 4;case 2:return 7;case 3:return 1;case 4:return 9;case 5:return 2;case 6:return 0;case 7:return 8;} return a; }',
};
const DO = { sym: 'dloop', head: '', c: `void dloop(int n,int *p){ do { switch(*p){${ARMS}} p++; } while(--n); }` };
const ARMS2 = ARMS.replace(/=(\d);/g, (_, k: string) => `=${20 + Number(k)};`).replace(/\*p/g, '*q');
const TWO = {
  sym: 'two',
  head: '',
  c: `void two(int n,int *p,int *q){ int k=n; do { switch(*p){${ARMS}} p++; } while(--k); do { switch(*q){${ARMS2}} q++; } while(--n); }`,
};
const DCALL = {
  sym: 'dcall',
  head: 'void g(int);\n',
  c: `void dcall(int n,int *p){ do { switch(*p){${ARMS}} g(n); p++; } while(--n); }`,
};
const DPOST = {
  sym: 'dpost',
  head: 'void g(int);\n',
  c: `void dpost(int n,int *p){ int k=n; do { switch(*p){${ARMS}} p++; } while(--k); g(n); }`,
};

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
      return { asm, source };
    };
    const gated = ppcDockerGate('jump-table-window', id);

    test.runIf(gated)(
      'an LR save scheduled between the bound and its branch',
      () => {
        expect(run(SCHED).asm).toMatch(
          /cmplwi\s+r3,7\n(\s+[0-9a-f]+:\tstwu?\s+r[01],-?\d+\(r1\)\n)+\s+[0-9a-f]+:\tbgt/,
        );
      },
      BUDGET,
    );
    test.runIf(gated)('a bgtlr bound', () => expect(run(FALL).asm).toMatch(/\tbgtlr/), BUDGET);
    test.runIf(gated)(
      'with no declaration, a default returning the only argument, which the body never reads',
      () => {
        const { obj, asm } = compilePpcTarget(id, RETG.head + RETG.c, RETG.sym, PPC_FLAGS);
        const source = decompile(RETG.sym, asm, PPC_MWCC, { asmData: extractAsmData(obj, PPC_MWCC, RETG.sym) }).source;
        expect(source).toMatch(/^s32 retg\(s32 a0\)/m);
        expect(source).toMatch(/default:\s*\n\s*return a0;/);
        expect(scoreObjects(obj, compileCandPpc(id, RETG.head + source, PPC_FLAGS), RETG.sym).score, source).toBe(0);
      },
      BUDGET,
    );
    test.runIf(gated)(
      'a bgtlr default returning an argument it never touches',
      () => {
        // mwcc compiles a bare `return;` there to the same bytes, so the score alone cannot tell
        const { asm, source } = run(RETA);
        expect(asm).toMatch(/\tbgtlr/);
        expect(source).toMatch(/default:\s*\n\s*return a0;/);
      },
      BUDGET,
    );
    for (const [what, s] of [
      ['two loop switches', TWO],
      ['a call in the loop', DCALL],
    ] as const) {
      test.runIf(gated)(
        `${what}, the table bases hoisted by 2.3.3 alone`,
        () => {
          const block = dispatchBlock(run(s).asm, /\tbgt/, /\tbctr/);
          expect(/\tlis\s/.test(block), block).toBe(id !== 'mwcc_233_163n');
        },
        BUDGET,
      );
    }
    test.runIf(gated)(
      'a switch in a loop, its table base hoisted by 2.3.3 alone',
      () => {
        const block = dispatchBlock(run(LOOP).asm, /\tbgt/, /\tbctr/);
        expect(/\tlis\s/.test(block), block).toBe(id !== 'mwcc_233_163n');
      },
      BUDGET,
    );
  },
);

describe.each([DO, TWO, DPOST])('a MIPS jump table based in the loop preheader recompiles byte-exact: $sym', (s) => {
  const hoisted = (asm: string) => expect(dispatchBlock(asm, /\tbeqz\t/, /\tjr\tv0/)).not.toMatch(/\tlui\t/);
  const prototypes = prototypesFromContext(s.head + s.c.slice(0, s.c.indexOf('{')) + ';', 'c');

  test.runIf(kmcGate('jump-table-window-kmc'))(
    'gcc2.7.2kmc',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2kmc'].canonicalFlags;
      const { obj, asm } = compileMipsGccTarget(s.head + s.c, s.sym, flags);
      hoisted(asm);
      const source = decompile(s.sym, asm, MIPS_GCC, {
        asmData: extractAsmData(obj, MIPS_GCC, s.sym),
        prototypes,
      }).source;
      expect(source).toContain('switch (');
      expect(scoreCMipsGcc(s.head + source, s.sym, obj, flags).score, source).toBe(0);
    },
    60_000,
  );

  test.runIf(gcc272Available())(
    'gcc2.7.2',
    () => {
      const flags = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
      const { obj, asm } = compileMipsGcc272Target(s.head + s.c, s.sym, flags);
      hoisted(asm);
      const source = decompile(s.sym, asm, MIPS_GCC, {
        asmData: extractAsmData(obj, MIPS_GCC, s.sym),
        prototypes,
      }).source;
      expect(source).toContain('switch (');
      expect(scoreObjects(obj, compileMipsGcc272Target(s.head + source, s.sym, flags).obj, s.sym).score, source).toBe(
        0,
      );
    },
    60_000,
  );
});
