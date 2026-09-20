// THE STILLBORN STOP (src/stillborn.ts): a fan whose default and every per-variation probe are
// rejected for the same reason is not compiled to the end — and every other fan is ranked whole,
// exactly as if the rule did not exist.
import { expect, test } from 'vitest';

import { CompilerRejection } from '../src/compiler-diagnostics';
import { type Candidate, NoScorableCandidateError, rankBy } from '../src/rank';
import { probeIndices } from '../src/stillborn';

/** The full product of `unsigned`/`signed` with every subset of `names`, in a fixed order — the
 *  shape enumeration produces, without lifting anything. */
const fan = (names: readonly string[]): Candidate[] => {
  const subsets = names.reduce<string[][]>((acc, n) => [...acc, ...acc.map((s) => [...s, n])], [[]]);
  return ['unsigned', 'signed'].flatMap((sign) =>
    subsets.map((s) => ({ variations: [sign, ...s], source: [sign, ...s].join('/'), preference: 0 })),
  );
};

const ARITY = "c.c:12: too many arguments to function `HeapFree'";
const OPERANDS = 'c.c:30: invalid operands to binary &';
const reject = (...errors: string[]): never => {
  const diagnostic = ['c.c:3: warning: assignment from incompatible pointer type', ...errors].join('\n');
  throw new CompilerRejection(`agbcc failed: ${errors[0]}`, diagnostic);
};

const rank = (candidates: Candidate[], scoreFn: (c: Candidate) => { score: number }) => {
  const compiled: string[] = [];
  const run = () =>
    rankBy(candidates, 'f', (_source, _symbol, c) => {
      compiled.push(c.source);
      return scoreFn(c);
    });
  return { run, compiled };
};

test('a probe is the smallest carrier of each variation name, enumeration order breaking a tie', () => {
  const candidates = fan(['a', 'b']);
  // unsigned, unsigned/a, unsigned/b, unsigned/a/b, signed, signed/a, signed/b, signed/a/b
  expect(probeIndices(candidates)).toEqual([1, 2, 4]);
  expect(probeIndices(candidates.slice(0, 1))).toEqual([]);
});

test('default and every probe rejected for ONE reason: the rest is not compiled, and says so', () => {
  const candidates = fan(['a', 'b', 'c']);
  // the line moves with the spelling; the reason does not
  const { run, compiled } = rank(candidates, (c) => reject(`c.c:${10 + c.variations.length}: ${ARITY.slice(8)}`));
  let thrown: unknown;
  try {
    run();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(NoScorableCandidateError);
  const e = thrown as NoScorableCandidateError;
  expect(compiled).toEqual(['unsigned', 'unsigned/a', 'unsigned/b', 'unsigned/c', 'signed']);
  expect(e.dropped.map((d) => d.variations.join('/'))).toEqual(compiled);
  expect(e.withheld).toEqual([]);
  expect(e.notCompiled).toHaveLength(candidates.length - compiled.length);
  expect(e.dropped.length + e.notCompiled.length).toBe(candidates.length);
  expect(e.message.startsWith("no scorable candidate for 'f': agbcc failed: ")).toBe(true);
  expect(e.message).toContain('11 of 16 candidates were NOT COMPILED');
  expect(e.message).toContain("too many arguments to function `HeapFree'");
  expect((e.cause as Error).message).toContain('agbcc failed');
});

test('one probe compiles: the whole fan is ranked, each candidate scored exactly once', () => {
  const candidates = fan(['setup-args', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('setup-args') ? { score: c.variations.length } : reject(ARITY),
  );
  const ranked = run();
  expect(ranked.winner.source).toBe('unsigned/setup-args');
  expect([...compiled].sort()).toEqual(candidates.map((c) => c.source).sort());
  expect(ranked.dropped.map((d) => d.variations.join('/'))).toEqual(['unsigned', 'unsigned/b', 'signed', 'signed/b']);
});

test('a probe rejected for a DIFFERENT reason: its variation reaches the statement, so rank everything', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) => (c.variations.includes('a') ? reject(OPERANDS) : reject(ARITY)));
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});

test('two DIFFERENT errors, each cured by its own variation: only the product compiles, and it is found', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) => {
    const left = [...(c.variations.includes('a') ? [] : [ARITY]), ...(c.variations.includes('b') ? [] : [OPERANDS])];
    return left.length === 0 ? { score: 0 } : reject(...left);
  });
  const ranked = run();
  expect(ranked.winner.source).toBe('unsigned/a/b');
  expect(ranked.dropped).toHaveLength(6);
  expect(compiled).toHaveLength(candidates.length);
});

test('a rejection whose diagnostic holds no readable error has no key, so nothing is skipped', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, () => {
    throw new CompilerRejection('cc failed: exit 1', 'Segmentation fault');
  });
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});

test('a throw that is not a CompilerRejection is a transient, whatever its text says', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, () => {
    throw new Error(`'agbcc' timed out\n${ARITY}`);
  });
  let thrown: unknown;
  try {
    run();
  } catch (e) {
    thrown = e;
  }
  expect(compiled).toHaveLength(candidates.length);
  expect((thrown as NoScorableCandidateError).notCompiled).toEqual([]);
});

test('ONE transient probe among identical rejections is enough to rank everything', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) => {
    if (c.source === 'unsigned/b') {
      throw new Error("'agbcc' timed out");
    }
    return reject(ARITY);
  });
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});

test('a probe that compiles and is WITHHELD still proves the fan alive', () => {
  const candidates = fan(['a', 'unreduce']).map((c) =>
    c.variations.includes('unreduce') ? { ...c, matchOnly: true as const } : c,
  );
  const { run, compiled } = rank(candidates, (c) => (c.matchOnly ? { score: 4 } : reject(ARITY)));
  let thrown: unknown;
  try {
    run();
  } catch (e) {
    thrown = e;
  }
  const e = thrown as NoScorableCandidateError;
  expect(compiled).toHaveLength(candidates.length);
  expect(e.withheld).toHaveLength(4);
  expect(e.notCompiled).toEqual([]);
});

test('a fan whose default compiles is never probed: enumeration order is the compile order', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) => (c.variations.includes('b') ? reject(ARITY) : { score: 3 }));
  run();
  expect(compiled).toEqual(candidates.map((c) => c.source));
});

// THE NAMED RESIDUAL (stillborn.ts header): one error INSTANCE that two variations cure only
// jointly. Each probe leaves the multiset as it found it, so the rule stops, and the product is
// never compiled. Pinned so that the day a variation can re-type an operand, this is the test that
// has to be argued with.
test('RESIDUAL: a single error that needs two variations jointly is declared stillborn', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('a') && c.variations.includes('b') ? { score: 0 } : reject(OPERANDS),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).not.toContain('unsigned/a/b');
});
