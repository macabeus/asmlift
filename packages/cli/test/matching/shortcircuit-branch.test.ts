// Control-flow short-circuit orientation. `if (a && b) X else Y` and `if (!a || !b) Y else X` are
// the same branch graph, so the fold in raise/shortcircuit.ts can only emit whichever orientation
// the asm's branch senses spell — and only ONE of the two is the bytes agbcc produced.
//
// This is the executable half of what synthetic:ifand_near:agbcc publishes. Both orientations are
// enumerated — `/flip-branch` where the arms diverge, `/flip-join` where they reconverge — so the
// differ referees the orientation instead of the fold committing to one.
import { type Gate, firstRejection, without } from '@asmlift/core/l3/gates';
import { decompile } from '@asmlift/core/pipeline';
import { PRE_RECOVERY_PASSES } from '@asmlift/core/raise/pre-recovery';
import { ARM_REREAD_GATES, type ArmRereadSite } from '@asmlift/core/raise/shortcircuit';
import { ARMV4T_AGBCC, PPC_MWCC } from '@asmlift/core/target';
import {
  assembleTarget,
  compileMipsGcc272Target,
  compileMipsGccTarget,
  compileMipsTarget,
  compilePpcTarget,
  compileTargetAsm,
  gcc272Available,
  idoAvailable,
  scoreC,
  scoreCPpc,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileRanked } from '../../src/rank';
import { dockerGate, ppcDockerGate } from './docker-gate';

const ARM = 'p[0] = 1; q[0] = 2; p[1] = 3; q[1] = 4;';
const src = (op: string) =>
  `int f(int a, int b, int *p, int *q){ if (a ${op} b) { ${ARM} } else { p[0] = -1; } return p[1]; }`;

const ranked = (c: string) => {
  const asm = compileTargetAsm(c);
  return { rk: decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm)), target: assembleTarget(asm) };
};

describe('the emitted orientation decides the match, and only one orientation is reachable', () => {
  test('a reconverging `&&` reaches the source orientation at the default sense and matches', () => {
    const { rk, target } = ranked(src('&&'));
    // the `&&`'s tests all branch to the ELSE arm, so the fall-through IS the then-arm and the
    // default joined sense spells the source's own orientation — which is the bytes
    expect(rk.best.source).toContain('&&');
    expect(rk.best.score.match).toBe(true);
    // the dual spelling is byte-identical evidence of the same fact, stated directly
    const dual = `int f(int a, int b, int *p, int *q){ if (a != 0 && b != 0) { ${ARM} } else { p[0] = -1; } return p[1]; }`;
    expect(scoreC(dual, 'f', target).match).toBe(true);
  });

  test('the same shape written `||` matches, so the fold itself is not the defect', () => {
    // The control that keeps the claim honest, and the axis's own reason to exist: an `||`'s first
    // test branches INTO the then-arm, so the fall-through reading is inverted here and the source
    // orientation is /flip-join's.
    const { rk } = ranked(src('||'));
    expect(rk.best.source).toContain('||');
    expect(rk.best.score.match).toBe(true);
  });

  test('a far arm recovers the source `&&` through its long-branch trampolines', () => {
    // Past Thumb's ±256-byte reach agbcc inverts the branch and emits `bne ^g / b shared`, so the
    // shared block arrives behind a forwarding block on EACH edge. The fold looks through them, and
    // this orientation lands on the source's own spelling rather than the dual.
    //
    // The bytes cannot police this on their own: the un-folded spelling tail-duplicates the else
    // arm, and agbcc cross-jumps the copies back together, so the row scored 0 either way. What is
    // asserted is the `&&`.
    const far = Array.from({ length: 32 }, (_, i) => `p[${i}] = ${i * 2 + 1}; q[${i}] = ${i * 2 + 2};`).join(' ');
    const c = `int f(int a, int b, int *p, int *q){ if (a && b) { ${far} } else { p[0] = -1; } return p[1]; }`;
    const { rk } = ranked(c);
    expect(rk.best.source).toContain('&&');
    expect(rk.best.source).not.toContain('||');
    expect(rk.best.score.match).toBe(true);
    // and the else arm is emitted ONCE — the tail duplication the fold exists to remove
    expect(rk.best.source.split('-1').length - 1).toBe(1);
  });

  test('each if class carries its own orientation axis: /flip-branch divergent, /flip-join joined', () => {
    // Asserted on the CANDIDATE LIST, not on the winner: the default sense already spells `&&`
    // for the divergent shape, so a winner assertion would pass with the axis deleted.
    const divergent = compileTargetAsm(
      `int f(int a, int b, int *p, int *q){ if (a && b) { ${ARM} return 2; } return 3; }`,
    );
    const dv = decompileRanked('f', divergent, ARMV4T_AGBCC, assembleTarget(divergent));
    expect(dv.candidates.some((c) => c.label.includes('flip-branch'))).toBe(true);
    expect(dv.best.score.match).toBe(true);
    // the reconverging sibling, which differs only in that its arms rejoin, is /flip-join's:
    // its flipped spelling is a distinct candidate where the divergent axis never fires
    const reconverging = compileTargetAsm(src('&&'));
    const rc = decompileRanked('f', reconverging, ARMV4T_AGBCC, assembleTarget(reconverging));
    expect(rc.candidates.some((c) => c.label.includes('flip-branch'))).toBe(false);
    expect(rc.candidates.some((c) => c.label.includes('flip-join'))).toBe(true);
  });
});

// A three-clause chain needs the SECOND fold, and the second fold needs De Morgan: the pass is
// iterative, so ^g's condition is by then the connective the first fold built, and negating one is
// a distribution, not an opcode swap (raise/shortcircuit.ts `negateCondOps`). Without it the chain
// folds one level, the shared arm is tail-duplicated, and the row misses.
//
// This lives in the MATCHING suite deliberately: it is in no CI gate and in no `bench` command, so
// a regression here would otherwise ride main for weeks. Each score in a test name below is what the
// shape scores with `negateCondOps`' connective case ablated.
describe('a three-clause short-circuit chain folds flat', () => {
  const best = (c: string) => {
    const asm = compileTargetAsm(c);
    return decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm)).best;
  };

  test('`a || (b && c)` guarding two arms — 5 without the second fold, THEN arm duplicated', () => {
    const b = best(
      'int f(int a,int b,int c,int *p){ if (a > 0 || (b > 0 && c > 0)) { p[0]=1; } else { p[0]=2; } return p[1]; }',
    );
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('||');
    expect(b.source).toContain('&&');
    // ONE then-arm: the tail duplication the second fold removes. It is `*a3 = 1` that gets
    // duplicated, not the else arm — ablated, the winner nests `if (a0 > 0) v0 = 1; else { … v0 = 2;
    // … v0 = 1; }`, so `= 2` reads 1 either way and would gate nothing.
    expect(b.source.split('= 1').length - 1).toBe(1);
  });

  test('`a || (b && c)` over an accumulator — 7 without the second fold', () => {
    const b = best('int f(int a,int b,int c){ int r = 0; if (a > 0 || (b > 0 && c > 0)) r = 1; return r; }');
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('a0 > 0 || a1 > 0 && a2 > 0');
  });

  test('the `llcmp` shape — a 64-bit `<`, mixed compare signedness, 11 without the second fold', () => {
    // synthetic:llcmp:agbcc's own body. The unsigned half is spelled as a per-SITE cast by the
    // existing `/uns-cmp` axis, NOT as a parameter type: the winner is `signed/defsite/uns-cmp` with
    // four `s32` params, so the fan reaches the bytes with no per-parameter signedness candidate.
    const b = best(
      'int f(unsigned a,int b,unsigned c,int d){ int r=0; if (d > b || (d == b && c > a)) r=1; return r; }',
    );
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('(u32)');
  });

  test('the CONTROL: `a && (b || c)`, whose orientation never asks for the negation, still matches', () => {
    // Ablated it matches too, so it pins that the connective case takes nothing away.
    const b = best(
      'int f(int a,int b,int c,int *p){ if (a > 0 && (b > 0 || c > 0)) { p[0]=1; } else { p[0]=2; } return p[1]; }',
    );
    expect(b.score.match).toBe(true);
  });
});

// The one LOUD→SILENT conversion this fold makes, pinned. Folding a loop-EXIT connective removes
// the back-edge loop recovery was refusing, so a function that DECLINED now decompiles — the one
// effect of the connective negation with no differ to referee it, since the two real functions it
// flips (`sub_80930B8`, `sub_80932E0`) are not benchmark rows.
//
// Ablated, this very shape throws `StructureError: cannot structure 'f': unrecovered back-edge into
// block #2`, so the test below cannot even reach an assertion there. It is not a match (best 24) and
// deliberately asserts no score: what it gates is that the fold SURVIVES into the loop condition,
// not the bytes it scores.
//
// Equivalence is executed, not argued: the decompilation and the original C, both built with the
// host `cc` and run over a 512-point grid of `p`/`q` contents and `n` (including `n < 0` and
// `n` past the array), print identical output.
describe('a loop-exit connective folds, and the loop it un-declines stays recovered', () => {
  test('`while (i < n && (p[i] || q[i]))` keeps ONE loop with the connective in its condition', () => {
    const c =
      'int f(int*p,int*q,int n,int*o){ int i=0; while (i<n && (p[i]!=0 || q[i]!=0)) i++; o[0]=i; o[2]=q[1]; return i; }';
    const asm = compileTargetAsm(c);
    const best = decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm)).best;
    expect(best.source).toMatch(/while \(v0 < a2 && \(a0\[v0\] != 0 \|\| a1\[v0\] != 0\)\)/);
    expect(best.source.split('do {').length - 1).toBe(1); // no tail-duplicated loop
    expect(best.source).not.toContain('ASMLIFT_ERROR');
  });
});

// The second test LOADS a value the arm reads again (raise/shortcircuit.ts `ARM_REREAD_GATES`). The
// fold copies that read to the arm's head, and whether the copy compiles back to ONE load is a
// question about how analysis.ts spells it — inline, where agbcc merges it into the condition's
// register, or as a local, which agbcc loads a second time. The first test is the compiler fact;
// the rest are the two sides of the gate that rests on it. The positive ones fail with every
// escape refused (main, before the admission); each nest fails with its own rule ablated
// (`read-behind-effect` the call and double use, `moves-a-read` the moved read, `loop-exit` the
// search loop). The DIFFERENTIAL below is the property the rule exists for, run as a test.
describe('an arm that re-reads what its second test loaded', () => {
  const PROTOS = { fnB: { params: 0, returnsVoid: true }, sink: { params: 1, returnsVoid: true } };
  const X = 'extern void fnB(void); extern void sink(s32);\n';
  const best = (c: string, self: { params: number }) => {
    const asm = compileTargetAsm(X + c);
    return decompileRanked('f', asm, ARMV4T_AGBCC, assembleTarget(asm), {
      prototypes: { f: { ...self, returnsVoid: true }, ...PROTOS },
    }).best;
  };

  test('the compiler fact: an INLINE re-read is one load, a LOCAL is two', () => {
    const loads = (arm: string) =>
      compileTargetAsm(`void f(u8 *p, u8 *q, s32 a){ if (a && (p[1] & 0x7f) == 0x7f) { ${arm} } }`)
        .split('\n')
        .filter((l) => /ldrb\s+r\d+,\s*\[r\d+,\s*#0x1\]/.test(l)).length;
    expect(loads('p[1] &= 0x80;')).toBe(1);
    expect(loads('q[0] = 5; p[1] &= 0x80;')).toBe(1); // inline merges even past a store
    expect(loads('{ u8 v = p[1]; p[2] = v; }')).toBe(2);
    expect(loads('fnB(); p[2] = p[1];')).toBe(2);
  });

  test('re-derived inline, the ladder arm folds flat and matches — the nest scored 3', () => {
    const b = best(
      'void f(u8 *p, u8 *q, s32 a){ if (a && (p[1] & 0x7f) == 0x7f) { p[1] &= 0x80; q[0] = 5; return; } fnB(); }',
      { params: 3 },
    );
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('&&');
  });

  test('a read the arm holds across a CALL keeps the nest, which matches', () => {
    // Re-derived, the copy would be a local ahead of the call and a second load.
    const b = best('void f(u8 *p, s32 a){ u8 v; if (a) { v = p[3]; if ((v & 0x7f) == 0x7f) { fnB(); sink(v); } } }', {
      params: 2,
    });
    expect(b.score.match).toBe(true);
  });

  test('a read the arm uses TWICE keeps the nest, which matches', () => {
    const b = best('void f(u8 *p, s32 a){ u8 v; if (a && ((v = p[3]) & 0x7f) == 0x7f) { sink(v); sink(v); } }', {
      params: 2,
    });
    expect(b.score.match).toBe(true);
  });

  test('a read only the arm consumes is not moved under the second test, and matches', () => {
    // The target reads p[5] before `b == 3`, on both of its exits.
    const b = best('void f(u8 *p, s32 a, s32 b){ u8 v; if (a) { v = p[5]; if (b == 3) sink(v); } }', { params: 3 });
    expect(b.score.match).toBe(true);
  });

  test('a store to ANOTHER field of the same struct is no barrier, and the flat fold matches', () => {
    // analysis.ts inlines the copy past a provably disjoint store (`disjointConstSlots`), so agbcc
    // merges it into the test's load. Counting every effect kept the nest here: 8/22.
    const b = best(
      'struct R { s32 x; u16 h; u8 fl; u8 k; };\n' +
        'void f(struct R *r, s32 a){ if (a && (r->fl & 0x7f) == 0x7f) { r->x = 5; r->fl &= 0x80; return; } fnB(); }',
      { params: 2 },
    );
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('&&');
  });

  test('an INDEXED re-read folds like a constant-offset one — the address carries no read', () => {
    // The copy re-derives `p + i` beside the load. Treating that `add` as a read refused this where
    // `p[5]` folded (3/22).
    const b = best(
      'void f(u8 *p, s32 i, s32 a){ if (a && (p[i] & 0x7f) == 0x7f) { p[i] &= 0x80; fnB(); p[i] = 1; return; } fnB(); }',
      { params: 3 },
    );
    expect(b.score.match).toBe(true);
    expect(b.source).toContain('&&');
  });

  test('a search loop whose hit arm returns keeps its nest, which matches', () => {
    // `loop-exit`: fused whole, the condition becomes the loop header's exit. Ablated, 21/33.
    const b = best(
      'void f(u8 *p, u8 *q, u8 *r){ u8 v; s32 i; for (i = 0; i < 8; i++) { if (q[i] != 0 && (v = p[i]) > 5) { r[0] = v; return; } } fnB(); }',
      { params: 3 },
    );
    expect(b.score.match).toBe(true);
  });

  // THE DIFFERENTIAL. `read-behind-effect` predicts an L2 decision at L1: it refuses exactly where
  // analysis.ts would spell the arm's copy as a LOCAL. So for each spelling, take the fold with the
  // rule ABLATED — the copy is always made — and check that a local holding the read appears iff
  // the full table refuses. The two predicates drifting apart (the day `disjointConstSlots` widens,
  // or `emitPos` changes) fails here, which no single-probe test above would notice. The swap goes
  // through `PRE_RECOVERY_PASSES` — the seam `bench gates --pass arm-reread` uses — and every case
  // must actually reach the table, or it would pass vacuously.
  test('the rule refuses exactly where analysis.ts would spell the copy as a local', () => {
    const H = 'struct R { s32 x; u16 h; u8 fl; u8 k; }; struct G { u8 f[8]; }; extern struct G *gP; extern s32 gK;\n';
    const T = (arm: string) =>
      `void f(u8 *p, u8 *q, s32 a){ if (a && (p[1] & 0x7f) == 0x7f) { ${arm} return; } fnB(); }`;
    const V = (arm: string) =>
      `void f(u8 *p, u8 *q, s32 a){ u8 v; if (a && ((v = p[3]) & 0x7f) == 0x7f) { ${arm} return; } fnB(); }`;
    const cases = [
      T('p[1] &= 0x80;'),
      T('q[0] = 5; p[1] &= 0x80;'),
      T('p[3] = 5; p[1] &= 0x80;'),
      T('p[1] &= 0x80; p[3] = 5;'),
      T('p[3] = 5; p[2] = p[1]; p[4] = p[1];'),
      T('p[2] = p[1] & 0x80; p[3] = p[1] & 0x80;'),
      T('p[2] = p[1]; p[1] = 0;'),
      'void f(struct R *r, s32 a){ if (a && (r->fl & 0x7f) == 0x7f) { r->x = 5; r->fl &= 0x80; return; } fnB(); }',
      'void f(struct R *r, s32 a){ if (a && (r->fl & 0x7f) == 0x7f) { r->h = 0; r->k = r->fl; return; } fnB(); }',
      'void f(s32 a){ if (a && (gP->f[5] & 0x7f) == 0x7f) { gP->f[4] = 1; gP->f[5] &= 0x80; return; } fnB(); }',
      'void f(s32 a){ if (a && (gP->f[5] & 0x7f) == 0x7f) { gK = 1; gP->f[5] &= 0x80; return; } fnB(); }',
      'void f(u8 *p, s32 i, s32 a){ if (a && (p[i] & 0x7f) == 0x7f) { p[i] &= 0x80; fnB(); p[i] = 1; return; } fnB(); }',
      V('sink(v); sink(v);'),
      V('fnB(); sink(v);'),
      V('sink(v); fnB();'),
      V('p[5] = 0; sink(v);'),
      V('p[2] = v; p[4] = v;'),
      V('p[2] = v + 1;'),
      V('sink(v & 3);'),
    ];
    const entry = PRE_RECOVERY_PASSES.find((p) => p.id === 'branch-shortcircuit')!;
    const run = entry.run;
    const seen: { refused: boolean; local: boolean }[] = [];
    for (const c of cases) {
      const asm = compileTargetAsm(X + H + c);
      const verdicts: (string | null)[] = [];
      // First in the table and never refusing: it records the FULL table's verdict at each site.
      const probe: Gate<ArmRereadSite> = {
        id: 'probe',
        why: 'records the verdict',
        sound: false,
        guardedBy: 'this test',
        rejects: (site) => {
          verdicts.push(firstRejection(ARM_REREAD_GATES, site));
          return false;
        },
      };
      entry.run = (fn, self, opts, target, lifted) =>
        run(
          fn,
          self,
          {
            ...opts,
            shortCircuit: {
              ...opts.shortCircuit,
              armReread: [probe, ...without(ARM_REREAD_GATES, 'read-behind-effect')],
            },
          },
          target,
          lifted,
        );
      let source: string;
      try {
        const params = c.slice(c.indexOf('void f(') + 7, c.indexOf(')')).split(',').length;
        source = decompile('f', asm, ARMV4T_AGBCC, {
          prototypes: { f: { params, returnsVoid: true }, ...PROTOS },
        }).source;
      } finally {
        entry.run = run;
      }
      expect(verdicts.length, c).toBeGreaterThan(0);
      expect(
        verdicts.every((v) => v === null || v === 'read-behind-effect'),
        c,
      ).toBe(true);
      // a local assigned from a memory read: a subscript, a member, a deref, or a named global
      const local = /^\s+v\d+ = [^;]*(\[|->|\*|\bg[A-Z]\w*)[^;]*;$/m.test(source);
      seen.push({ refused: verdicts.includes('read-behind-effect'), local });
      expect({ case: c, local }).toEqual({ case: c, local: verdicts.includes('read-behind-effect') });
    }
    // both sides are inhabited, or the property is not being tested
    expect(seen.filter((x) => x.refused).length).toBeGreaterThan(3);
    expect(seen.filter((x) => !x.refused).length).toBeGreaterThan(3);
  });
});

// The same fact on the compilers that declare it the OTHER way (target.ts `reloadsLocalReread`):
// ido7.1, gcc2.7.2kmc, gcc2.7.2 and mwcc_242_81 hold a local's register instead of reloading it, so
// analysis.ts's local is their spelling and `read-behind-effect` stands down there.
describe('a local that re-reads the second test costs no load outside agbcc', () => {
  const pair = (arm: string) => `void f(u8 *p, u8 *q, s32 a){ if (a && (p[1] & 0x7f) == 0x7f) { ${arm} } }`;
  const LOCALS = [
    '{ u8 v = p[1]; p[2] = v; }',
    '{ u8 v = p[1]; q[0] = 5; p[2] = v; }',
    '{ u8 v = p[1]; fnB(); p[2] = v; }',
  ];
  const X = 'extern void fnB(void);\n';
  const cases: [string, boolean, (c: string) => string, RegExp][] = [
    ['ido7.1', idoAvailable(), (c) => compileMipsTarget(c, 'f').asm, /\blbu\s+\$?\w+,\s*(0x)?1\(\$?\w+\)/],
    [
      'gcc2.7.2kmc',
      dockerGate('reread-kmc'),
      (c) => compileMipsGccTarget(c, 'f').asm,
      /\blbu\s+\$?\w+,\s*(0x)?1\(\$?\w+\)/,
    ],
    ['gcc2.7.2', gcc272Available(), (c) => compileMipsGcc272Target(c, 'f').asm, /\blbu\s+\$?\w+,\s*(0x)?1\(\$?\w+\)/],
    [
      'mwcc_242_81',
      ppcDockerGate('reread-mwcc'),
      (c) => compilePpcTarget(c, 'f').asm,
      /\blbz\s+r\d+,\s*(0x)?1\(r\d+\)/,
    ],
  ];
  for (const [id, have, compile, load] of cases) {
    test.runIf(have)(`${id}: every local spelling loads p[1] once`, () => {
      for (const arm of LOCALS) {
        expect(
          compile(X + pair(arm))
            .split('\n')
            .filter((l) => load.test(l)).length,
          arm,
        ).toBe(1);
      }
    });
  }

  test.runIf(ppcDockerGate('reread-mwcc'))('mwcc: a read held across a call folds flat, and the local matches', () => {
    // On agbcc this is the nest `read-behind-effect` keeps; on mwcc the rule stands down and the
    // default lift spells `v0 = a0[3]; fnA(); a0[4] = v0;` — the target's own bytes (was 3/24).
    const c =
      'extern void fnA(void); extern void fnB(void);\n' +
      'void f(u8 *p, s32 a){ if (a) { u8 v = p[3]; if ((v & 0x7f) == 0x7f) { fnA(); p[4] = v; return; } } fnB(); }';
    const { asm, obj } = compilePpcTarget(c, 'f');
    const r = decompile('f', asm, PPC_MWCC, {
      prototypes: {
        f: { params: 2, returnsVoid: true },
        fnA: { params: 0, returnsVoid: true },
        fnB: { params: 0, returnsVoid: true },
      },
    });
    expect(r.source).toContain('&&');
    expect(scoreCPpc(r.source, 'f', obj).match).toBe(true);
  });
});
