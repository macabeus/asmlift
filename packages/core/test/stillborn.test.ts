// THE STILLBORN STOP (src/stillborn.ts): a fan whose default holds an error every per-variation
// probe is rejected with too, in every attempt, is not compiled to the end — and every other fan is
// ranked whole, exactly as if the rule did not exist.
import { expect, test } from 'vitest';

import { CompilerRejection, joinAttempts } from '../src/compiler-diagnostics';
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

test('a probe is the smallest carrier of each variation name IN ITS HALF, enumeration order breaking a tie', () => {
  const candidates = fan(['a', 'b']);
  // unsigned, unsigned/a, unsigned/b, unsigned/a/b | signed, signed/a, signed/b, signed/a/b
  expect(probeIndices(candidates)).toEqual([1, 2, 4, 5, 6]);
  expect(probeIndices(candidates.slice(0, 4))).toEqual([1, 2]);
  expect(probeIndices(candidates.slice(0, 1))).toEqual([]);
  // a half is found by the registry's kind, so a fan whose names hold no signedness is one half
  const unsigned = candidates.map((c) => ({ ...c, variations: c.variations.slice(1) }));
  expect(probeIndices(unsigned)).toEqual([1, 2]);
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
  expect(compiled).toEqual([
    'unsigned',
    'unsigned/a',
    'unsigned/b',
    'unsigned/c',
    'signed',
    'signed/a',
    'signed/b',
    'signed/c',
  ]);
  expect(e.dropped.map((d) => d.variations.join('/'))).toEqual(compiled);
  expect(e.withheld).toEqual([]);
  expect(e.notCompiled).toHaveLength(candidates.length - compiled.length);
  expect(e.dropped.length + e.notCompiled.length).toBe(candidates.length);
  // the verdict first, then the default candidate's own diagnostic: a printer that bounds the
  // text keeps the sentence that says the fan was not compiled to the end
  expect(e.message.startsWith("no scorable candidate for 'f': 8 of 16 candidates were NOT COMPILED")).toBe(true);
  expect(e.message).toContain("too many arguments to function `HeapFree'");
  expect(e.message.split('\n').at(-1)).toMatch(/^The default candidate's compile: agbcc failed: c\.c:11: /);
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

// THE RESIDUALS (stillborn.ts header): one error MESSAGE that only the product of two variations
// cures — both needed at once, or one that reaches the statement only on the other's tree. Each
// probe leaves the multiset as it found it, so the rule stops, and the product is never compiled. Pinned so that the day a variation can re-type an operand, this is the test that
// has to be argued with.
test('RESIDUAL: a single error that needs two variations jointly is declared stillborn', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('a') && c.variations.includes('b') ? { score: 0 } : reject(OPERANDS),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).not.toContain('unsigned/a/b');
});

// The same residual with no re-typing in it: a compiler that prints ONE message for a statement
// holding TWO defects (mwcc and IDO on `y = g(1, 2) + h(3, 4)`), each defect cured by its own
// variation. The multiset cannot tell one defect from two, so the rule stops here as well.
test('RESIDUAL: two defects the compiler reports as one message are declared stillborn', () => {
  const candidates = fan(['a', 'b']);
  const MISMATCH = "#   Error:    ^\n#   function call 'g(int, int)' does not match\n#   'g(int)'";
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('a') && c.variations.includes('b') ? { score: 0 } : reject(MISMATCH),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).not.toContain('unsigned/a/b');
});

// SURVIVAL (stillborn.ts header): a probe may cure SOME of the default's errors — the fan is still
// stillborn when one error is left in every probe, exactly as often as in the default.
test('one probe cures one of two errors and the other survives: stopped after the default and its probes', () => {
  const candidates = fan(['setup-args', 'b', 'c']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('setup-args') ? reject(OPERANDS) : reject(ARITY, OPERANDS),
  );
  let thrown: unknown;
  try {
    run();
  } catch (e) {
    thrown = e;
  }
  const e = thrown as NoScorableCandidateError;
  expect(compiled).toEqual([
    'unsigned',
    'unsigned/setup-args',
    'unsigned/b',
    'unsigned/c',
    'signed',
    'signed/setup-args',
    'signed/b',
    'signed/c',
  ]);
  expect(e.notCompiled).toHaveLength(candidates.length - compiled.length);
  // the note names the error that survived, not the one a probe cured
  const note = e.message.slice(0, e.message.indexOf("The default candidate's compile"));
  expect(note).toContain('invalid operands to binary &');
  expect(note).not.toContain('HeapFree');
});

test('a probe that prints the surviving error MORE often reached it: the fan is ranked whole', () => {
  const candidates = fan(['reread-globals', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('reread-globals') ? reject(OPERANDS, OPERANDS) : reject(OPERANDS),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});

test('two copies of an error, one cured: the error did not survive, so the fan is ranked whole', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('a') ? reject(ARITY) : reject(ARITY, ARITY),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});

// PER ATTEMPT. A rejection of several compiles — the benchmark's ladder — compiles a candidate when
// ANY attempt compiles, so every attempt must keep a survivor.
const DEAD = 'c.c:1: fatal error: global.h: No such file or directory';
const attempts = (...perAttempt: string[][]): never => {
  throw new CompilerRejection(
    `agbcc failed: ${perAttempt.at(-1)![0]}`,
    joinAttempts(perAttempt.map((errors, k) => ({ label: `rung ${k}`, diagnostic: errors.join('\n') }))),
  );
};

test('a dead attempt’s constant errors never stop a fan whose live attempt has no survivor', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) => {
    const live = [...(c.variations.includes('a') ? [] : [ARITY]), ...(c.variations.includes('b') ? [] : [OPERANDS])];
    return live.length === 0 ? { score: 0 } : attempts([DEAD], live);
  });
  expect(run().winner.source).toBe('unsigned/a/b');
  expect(compiled).toHaveLength(candidates.length);
});

test('every attempt keeps a survivor: stopped, whatever the probes cured elsewhere', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    attempts([DEAD], c.variations.includes('a') ? [OPERANDS] : [ARITY, OPERANDS]),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toEqual(['unsigned', 'unsigned/a', 'unsigned/b', 'signed', 'signed/a', 'signed/b']);
});

test('a probe tried in other attempts than the default is not read against it: the fan is ranked whole', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('a') ? attempts([OPERANDS]) : attempts([DEAD], [OPERANDS]),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});

test('an attempt whose compiler stopped reporting is unread, so nothing is skipped', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, () =>
    attempts([OPERANDS], [ARITY, 'cfe: Fatal: Too many errors... goodbye.']),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});

// THE RESIDUAL again, in the shape survival lets through: a probe cured one error, and the error
// that survived is one only two variations together cure. Stopped — the same case as above.
test('RESIDUAL: the surviving error needs two variations jointly, whatever the probes cured besides', () => {
  const candidates = fan(['setup-args', 'a', 'b']);
  const { run, compiled } = rank(candidates, (c) => {
    const operands = c.variations.includes('a') && c.variations.includes('b') ? [] : [OPERANDS];
    const left = [...(c.variations.includes('setup-args') ? [] : [ARITY]), ...operands];
    return left.length === 0 ? { score: 0 } : reject(...left);
  });
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).not.toContain('unsigned/setup-args/a/b');
});

// HALF BY HALF (stillborn.ts header): a signedness re-types the whole body, so the error that
// survives is worded once per half. Each half is asked as a fan of its own.
test('the signedness re-words the surviving error: each half keeps its own, and the fan stops', () => {
  const candidates = fan(['setup-args', 'b']);
  const mismatch = (c: Candidate) =>
    `c.c:9: incompatible type for argument 1 of \`CARDGetSectorSize' (${c.variations[0]} long)`;
  const { run, compiled } = rank(candidates, (c) =>
    c.variations.includes('setup-args') ? reject(mismatch(c)) : reject(ARITY, mismatch(c)),
  );
  let thrown: unknown;
  try {
    run();
  } catch (e) {
    thrown = e;
  }
  const e = thrown as NoScorableCandidateError;
  expect(e).toBeInstanceOf(NoScorableCandidateError);
  expect(compiled).toEqual([
    'unsigned',
    'unsigned/setup-args',
    'unsigned/b',
    'signed',
    'signed/setup-args',
    'signed/b',
  ]);
  expect(e.notCompiled.map((n) => n.variations.join('/'))).toEqual(['unsigned/setup-args/b', 'signed/setup-args/b']);
  // the note names each half's survivor, as that half worded it
  const note = e.message.slice(0, e.message.indexOf("The default candidate's compile"));
  expect(note).toContain('in each signedness half');
  expect(note).toContain('(unsigned long)');
  expect(note).toContain('(signed long)');
});

test('one probe inside the signed half compiles: the whole fan is ranked', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations[0] === 'signed' && c.variations.includes('b') ? { score: 1 } : reject(OPERANDS),
  );
  expect(run().winner.source).toBe('signed/b');
  expect(compiled).toHaveLength(candidates.length);
});

test('the signed half without a survivor of its own ranks the whole fan, whatever the other half kept', () => {
  const candidates = fan(['a', 'b']);
  const { run, compiled } = rank(candidates, (c) =>
    c.variations[0] === 'signed' && c.variations.includes('a') ? reject(ARITY) : reject(OPERANDS),
  );
  expect(run).toThrow(NoScorableCandidateError);
  expect(compiled).toHaveLength(candidates.length);
});
