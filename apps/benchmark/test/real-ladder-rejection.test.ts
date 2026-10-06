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
import { CompilerRejection, attemptsOf, errorMessages } from '@asmlift/core/compiler-diagnostics';
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

type Compile = (c: string, sym: string) => Promise<string>;

/** What compiling `source` threw, or undefined when it compiled. */
const thrownBy = (compile: Compile, source: string): Promise<unknown> =>
  compile(source, 'f').then(
    () => undefined,
    (e: unknown) => e,
  );

/** Each candidate's compile, settled one at a time, so `rankBy` can replay them. */
async function settle(compile: Compile, sources: readonly string[]): Promise<Map<string, unknown>> {
  const thrown = new Map<string, unknown>();
  for (const source of sources) {
    thrown.set(source, await thrownBy(compile, source));
  }
  return thrown;
}

/** What the manifest rung — alive whichever richest rung the row has — refused `source` with. */
const manifestErrors = async (compile: Compile, source: string): Promise<string[]> => {
  const e = await thrownBy(compile, source);
  if (e === undefined) {
    throw new Error('compiled');
  }
  const rung = attemptsOf((e as CompilerRejection).diagnostic).find((a) => a.label === '+ manifest prependC (c)');
  return errorMessages(rung!.diagnostic);
};

test.each([
  ['dead', DEAD_CTX],
  ['alive', PREPEND_C],
])('with the richest rung %s, each probe cures one error in a live rung and the product is found', async (_, ctxI) => {
  const compiled: string[] = [];
  const compile = ladderCompile(fakeAgbcc(compiled), [], 'assembled', PREPEND_C, ctxI, 'c');
  const candidates = fan();
  const errors: string[][] = [];
  for (const c of candidates.slice(0, 3)) {
    errors.push(await manifestErrors(compile, c.source));
  }
  const [dflt, fixg, fixh] = errors;
  const G = "too many arguments to function `g'";
  const H = "too many arguments to function `h'";
  expect(dflt).toEqual([G, H]);
  expect(fixg).toEqual([H]);
  expect(fixh).toEqual([G]);

  const thrown = await settle(
    compile,
    candidates.map((c) => c.source),
  );
  const scored: string[] = [];
  const ranked = rankBy(candidates, 'f', (source) => {
    scored.push(source);
    if (thrown.get(source) !== undefined) {
      throw thrown.get(source);
    }
    return { score: 0 };
  });
  expect(ranked.winner.variations).toEqual(['unsigned', 'fixg', 'fixh']);
  expect(scored).toHaveLength(candidates.length);
});

test('the published message stays the richest rung’s: the world the candidate had to compile in', async () => {
  const compile = ladderCompile(fakeAgbcc([]), [], 'assembled', PREPEND_C, DEAD_CTX, 'c');
  const thrown = await thrownBy(compile, fan()[0].source);
  expect(thrown).toBeInstanceOf(CompilerRejection);
  const e = thrown as CompilerRejection;
  expect(e.message).toBe('cpp failed: c.c:3:10: fatal error: global.h: No such file or directory');
  // and the diagnostic names every rung the ladder tried, poorest first
  expect(e.diagnostic).toContain('--- bare typedefs (c) ---');
  expect(e.diagnostic).toContain('--- + manifest prependC (c) ---');
  expect(e.diagnostic).toContain('--- vendored ctx (c) ---');
  expect(e.diagnostic).toContain("too many arguments to function `g'");
});

test('a C++ row’s rejection splits back into its six attempts, in the order the ladder tried them', async () => {
  const compile = ladderCompile(fakeAgbcc([]), [], 'assembled', PREPEND_C, DEAD_CTX, 'c++');
  const thrown = await thrownBy(compile, fan()[0].source);
  expect(thrown).toBeInstanceOf(CompilerRejection);
  const attempts = attemptsOf((thrown as CompilerRejection).diagnostic);
  expect(attempts.map((a) => a.label)).toEqual([
    'bare typedefs (c++)',
    '+ manifest prependC (c++)',
    'vendored ctx (c++)',
    'bare typedefs (c)',
    '+ manifest prependC (c)',
    'vendored ctx (c)',
  ]);
  // each attempt holds what ITS rung said, and nothing another rung said
  expect(attempts.map((a) => errorMessages(a.diagnostic))).toEqual(
    [0, 1].flatMap(() => [
      ['dereferencing pointer to incomplete type'],
      ["too many arguments to function `g'", "too many arguments to function `h'"],
      ['global.h: No such file or directory'],
    ]),
  );
});

test('a fan whose every rung is dead for one reason is still stillborn', async () => {
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
  const thrown = await settle(
    compile,
    candidates.map((c) => c.source),
  );
  const scored: string[] = [];
  expect(() =>
    rankBy(candidates, 'f', (source) => {
      scored.push(source);
      if (thrown.get(source) !== undefined) {
        throw thrown.get(source);
      }
      return { score: 0 };
    }),
  ).toThrow(NoScorableCandidateError);
  expect(scored).toHaveLength(3);
});

test('one rung that did not run to completion leaves the candidate undecided: a plain Error', async () => {
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
  const thrown = await thrownBy(compile, fan()[0].source);
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(CompilerRejection);
});
