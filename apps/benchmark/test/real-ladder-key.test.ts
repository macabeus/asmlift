// THE LADDER'S REJECTION, AS THE STILLBORN RULE READS IT (compile/real.ts `ladderCompile`). A
// real-tier candidate is compiled up a ladder of contexts, and the rejection it throws is what
// core's stillborn rule compares across the fan. The MESSAGE is the richest rung's, because that
// is the world the candidate had to compile in and what the row publishes; the DIAGNOSTIC is every
// rung's, because a richest rung that dies for a reason no candidate controls — cpp cannot find a
// project header — would otherwise hand every candidate the same one sentence, and a fan whose
// product compiles would be declared stillborn with the product never compiled.
//
// Over a fake compile module: the corpus's nine dead-prelude rows all have their richest rung
// alive, so no committed row can referee this, and a synthetic row has no ladder at all.
import { CompilerRejection, errorKey } from '@asmlift/core/compiler-diagnostics';
import { NoScorableCandidateError, rankBy } from '@asmlift/core/rank';
import { expect, test } from 'vitest';

import { ladderCompile } from '../src/compile/real';
import type { RealCompile } from '../src/compile/types';

const PREPEND_C = 'struct S { s32 x; s32 y; };\nvoid g(s32);\nvoid h(s32);\n';
const DEAD_CTX = '#include "global.h"\n';

/** agbcc's verdicts on the three rungs, read off the text: the bare rung knows no `struct S`,
 *  the vendored rung is dead when it is the corpus's `#include` shape, and the manifest rung
 *  refuses each call the candidate spells with two arguments. */
const fakeAgbcc = (compiled: string[]): RealCompile => ({
  compileCandidate(tu) {
    compiled.push(tu);
    if (tu.includes(DEAD_CTX)) {
      throw new CompilerRejection(
        'cpp failed: c.c:3:10: fatal error: global.h: No such file or directory',
        'c.c:3:10: fatal error: global.h: No such file or directory',
      );
    }
    if (!tu.includes('struct S {')) {
      throw new CompilerRejection(
        'agbcc failed: c.c:2: dereferencing pointer to incomplete type',
        ["c.c: In function `f':", 'c.c:2: dereferencing pointer to incomplete type'].join('\n'),
      );
    }
    const errors = ['g', 'h'].filter((fn) => new RegExp(`${fn}\\(\\d+, \\d+\\)`).test(tu));
    if (errors.length > 0) {
      const lines = errors.map((fn) => `c.c:4: too many arguments to function \`${fn}'`);
      throw new CompilerRejection(`agbcc failed: ${lines[0]}`, ["c.c: In function `f':", ...lines].join('\n'));
    }
    return '/fake/cand.o';
  },
  buildTarget: () => {
    throw new Error('not under test');
  },
  preprocess: () => {
    throw new Error('not under test');
  },
  vendoredContext: (p) => p,
  undeclaredCallees: () => [],
});

const body = (ga: string, ha: string) => `void f(struct S *s){ g(${ga}); h(${ha}); s->x = 1; }\n`;
/** the fan: an arity error on `g` that only `fixg` cures, one on `h` that only `fixh` cures */
const fan = () => [
  { variations: ['unsigned'], source: body('1, 2', '3, 4'), preference: 0 },
  { variations: ['unsigned', 'fixg'], source: body('1', '3, 4'), preference: 0 },
  { variations: ['unsigned', 'fixh'], source: body('1, 2', '3'), preference: 0 },
  { variations: ['unsigned', 'fixg', 'fixh'], source: body('1', '3'), preference: 0 },
];

const keyOf = (compile: (c: string, sym: string) => string, source: string): string | null => {
  try {
    compile(source, 'f');
  } catch (e) {
    return e instanceof CompilerRejection ? errorKey(e.diagnostic) : null;
  }
  return null;
};

test.each([
  ['dead', DEAD_CTX],
  ['alive', PREPEND_C],
])('with the richest rung %s, a probe that cures one error changes the key and the product is found', (_, ctxI) => {
  const compiled: string[] = [];
  const compile = ladderCompile(fakeAgbcc(compiled), [], 'assembled', PREPEND_C, ctxI, 'c');
  const candidates = fan();
  const [dflt, fixg, fixh] = candidates.map((c) => keyOf(compile, c.source));
  expect(dflt).not.toBeNull();
  expect(fixg).not.toBe(dflt);
  expect(fixh).not.toBe(dflt);
  expect(fixg).not.toBe(fixh);

  const scored: string[] = [];
  const ranked = rankBy(candidates, 'f', (source) => {
    scored.push(source);
    compile(source, 'f');
    return { score: 0 };
  });
  expect(ranked.winner.variations).toEqual(['unsigned', 'fixg', 'fixh']);
  expect(scored).toHaveLength(candidates.length);
});

test('the published message stays the richest rung’s: the world the candidate had to compile in', () => {
  const compile = ladderCompile(fakeAgbcc([]), [], 'assembled', PREPEND_C, DEAD_CTX, 'c');
  let thrown: unknown;
  try {
    compile(fan()[0].source, 'f');
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(CompilerRejection);
  const e = thrown as CompilerRejection;
  expect(e.message).toBe('cpp failed: c.c:3:10: fatal error: global.h: No such file or directory');
  // and the diagnostic names every rung the ladder tried, poorest first
  expect(e.diagnostic).toContain('--- bare typedefs (c) ---');
  expect(e.diagnostic).toContain('--- + manifest prependC (c) ---');
  expect(e.diagnostic).toContain('--- vendored ctx (c) ---');
  expect(e.diagnostic).toContain("too many arguments to function `g'");
});

test('a fan whose every rung is dead for one reason is still stillborn', () => {
  const rc = fakeAgbcc([]);
  const compile = ladderCompile(
    {
      ...rc,
      compileCandidate: (tu, sym, cflags, language) => rc.compileCandidate(DEAD_CTX + tu, sym, cflags, language),
    },
    [],
    'assembled',
    PREPEND_C,
    DEAD_CTX,
    'c',
  );
  const candidates = fan();
  const scored: string[] = [];
  expect(() =>
    rankBy(candidates, 'f', (source) => {
      scored.push(source);
      compile(source, 'f');
      return { score: 0 };
    }),
  ).toThrow(NoScorableCandidateError);
  expect(scored).toHaveLength(3);
});

test('one rung that did not run to completion leaves the candidate undecided: a plain Error', () => {
  const rc = fakeAgbcc([]);
  let calls = 0;
  const flaky: RealCompile = {
    ...rc,
    compileCandidate: (tu, sym, cflags, language) => {
      if (calls++ === 1) {
        throw new Error('agbcc did not run to completion (killed by SIGKILL) — transient, not a rejection');
      }
      return rc.compileCandidate(tu, sym, cflags, language);
    },
  };
  const compile = ladderCompile(flaky, [], 'assembled', PREPEND_C, DEAD_CTX, 'c');
  let thrown: unknown;
  try {
    compile(fan()[0].source, 'f');
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(CompilerRejection);
});
