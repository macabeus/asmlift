// What counts as an ERROR in a compiler's output, and when two failed compiles failed the same way.
import { expect, test } from 'vitest';

import { attemptsOf, errorMessages, errorsFirst, joinAttempts, verdictMessages } from '../src/compiler-diagnostics';

const AGBCC = [
  "c.c: In function `PauseMenuScreenHandler':",
  'c.c:1181: warning: assignment from incompatible pointer type',
  "c.c:1190: warning: passing arg 1 of `thunk_HeapFree' makes pointer from integer without a cast",
  "c.c:1190: too many arguments to function `thunk_HeapFree'",
  "c.c:1204: too many arguments to function `thunk_HeapFree'",
].join('\n');

test('errors come ahead of warnings, each class in the order the compiler wrote it', () => {
  expect(errorsFirst(['a.c:1: warning: w1', 'a.c:2: e1', 'a.c:3: note: n1', 'a.c:4: error: e2'])).toEqual([
    'a.c:2: e1',
    'a.c:4: error: e2',
    'a.c:1: warning: w1',
    'a.c:3: note: n1',
  ]);
});

test('an mwcc message line travels with its caret line', () => {
  expect(errorsFirst(['#   Warning:    ^', '#   unused variable', '#   Error:   ^', '#   type mismatch'])).toEqual([
    '#   Error:   ^',
    '#   type mismatch',
    '#   Warning:    ^',
    '#   unused variable',
  ]);
});

test('the error messages of a pre-3.0 gcc diagnostic: no banner, no warning, no position', () => {
  expect(errorMessages(AGBCC)).toEqual([
    "too many arguments to function `thunk_HeapFree'",
    "too many arguments to function `thunk_HeapFree'",
  ]);
});

test('every copy of an error is read: repairing one of two identical errors changes the verdict', () => {
  const one = "c.c:9: too many arguments to function `thunk_HeapFree'";
  expect(verdictMessages(AGBCC)).not.toEqual(verdictMessages(one));
});

test('the verdict ignores where the error sits, which a respelled body moves', () => {
  expect(verdictMessages('c.c:12: invalid operands to binary &')).toEqual(
    verdictMessages('agbcc failed: c.c:40: warning: x\n/tmp/q/c.c:31: invalid operands to binary &'),
  );
});

test('a column and an `error:` tag are read as position and label', () => {
  expect(verdictMessages("in.c:7:3: error: too many arguments to function 'g'")).toEqual(
    verdictMessages("in.c:19:11: error: too many arguments to function 'g'"),
  );
  expect(errorMessages("in.c:7:3: error: too many arguments to function 'g'")).toEqual([
    "too many arguments to function 'g'",
  ]);
});

test('a `previous declaration` line and the undeclared footnote are not errors', () => {
  const text = [
    "c.c:5: conflicting types for `f'",
    "c.c:2: previous declaration of `f'",
    "c.c:9: `x' undeclared (first use in this function)",
    'c.c:9: (Each undeclared identifier is reported only once',
    'c.c:9: for each function it appears in.)',
  ].join('\n');
  expect(errorMessages(text)).toEqual(["conflicting types for `f'", "`x' undeclared (first use in this function)"]);
});

test('an mwcc error is the line under its caret; an mwcc warning is not an error', () => {
  const mwcc = [
    '#      12:     *arg0 = (s32) (*arg0 + 1);',
    '#   Error:             ^',
    '#   illegal use of incomplete struct/union/class',
    '#   Warning:    ^',
    '#   variable is not used',
  ].join('\n');
  expect(errorMessages(mwcc)).toEqual(['illegal use of incomplete struct/union/class']);
});

test('an IDO error drops its own position', () => {
  expect(verdictMessages('cfe: Error: /tmp/bench-cand-a1/c.c, line 12: Syntax Error')).toEqual(
    verdictMessages('cfe: Error: /tmp/bench-cand-b2/c.c, line 40: Syntax Error'),
  );
});

test('text with no recognisable error has NO verdict — never an empty one that equals another', () => {
  expect(verdictMessages('')).toBeNull();
  expect(verdictMessages("'agbcc' timed out")).toBeNull();
  expect(verdictMessages('c.c:3: warning: only a warning')).toBeNull();
  expect(verdictMessages('compile command exited 0 but produced no object at {{outputPath}}: cc -c in.c')).toBeNull();
});

// ── the shapes the five real compilers were measured to print ──────────────────────────────────

test('an mwcc message wrapped over several lines is ONE message, and its whole text is read', () => {
  const twoTargets = [
    '### mwcceppc.exe Compiler:',
    '#    File: ..\\host-tmp\\asmlift-ppc-score-uAUBsk\\cand.c',
    '# ----------------------------------------------------',
    '#       3: void f(struct A a, s32 *q){ s32 y; y = a; q = a; }',
    '#   Error:                                         ^',
    "#   illegal implicit conversion from 'struct A' to",
    "#   'int'",
    '### mwcceppc.exe Compiler:',
    '#       3: void f(struct A a, s32 *q){ s32 y; y = a; q = a; }',
    '#   Error:                                                ^',
    "#   illegal implicit conversion from 'struct A' to",
    "#   'int *'",
    '',
    'Errors caused tool to abort.',
  ].join('\n');
  expect(errorMessages(twoTargets)).toEqual([
    "illegal implicit conversion from 'struct A' to 'int'",
    "illegal implicit conversion from 'struct A' to 'int *'",
  ]);
  const threeLines = [
    '#   Error:        ^',
    "#   illegal implicit conversion from 'struct ",
    "#   VeryLongStructNameToWrapTheMessageOver *' to",
    "#   'int *'",
  ].join('\n');
  expect(errorMessages(threeLines)).toEqual([
    "illegal implicit conversion from 'struct VeryLongStructNameToWrapTheMessageOver *' to 'int *'",
  ]);
});

test('an mwcc warning’s wrapped message travels with the warning, ahead of nothing', () => {
  expect(
    errorsFirst(['#   Warning:    ^', '#   variable is not', '#   used', '#   Error:   ^', '#   type mismatch']),
  ).toEqual(['#   Error:   ^', '#   type mismatch', '#   Warning:    ^', '#   variable is not', '#   used']);
});

test('IDO’s numbered `Warning 712:` is a warning, so its errors still come first', () => {
  const warn = 'cfe: Warning 712: /tmp/x/cand.c, line 2: illegal combination of pointer and integer';
  const err = "cfe: Error: /tmp/x/cand.c, line 2: 'zz' undefined; reoccurrences will not be reported.";
  expect(errorsFirst([warn, ' s32 f(s32 a){ s32 *p = a; }', warn, err])).toEqual([
    ' s32 f(s32 a){ s32 *p = a; }',
    err,
    warn,
    warn,
  ]);
  expect(errorMessages([warn, err].join('\n'))).toEqual(["'zz' undefined; reoccurrences will not be reported."]);
});

test('an error whose message quotes a `note:` is still an error', () => {
  expect(errorMessages("c.c:3: error: expected ';' before 'note' token; note: foo")).toEqual([
    "expected ';' before 'note' token; note: foo",
  ]);
});

test('IDO spells the previous declaration’s position inside the message; the verdict drops it', () => {
  const at = (dir: string) =>
    `cfe: Error: ${dir}/cand.c, line 2: redeclaration of 'a'; previous declaration at line 2 in file '${dir}/cand.c'`;
  expect(verdictMessages(at('/tmp/a1'))).toEqual(verdictMessages(at('/tmp/b2')));
  expect(errorMessages(at('/tmp/a1'))).toEqual(["redeclaration of 'a'; previous declaration"]);
});

test('pre-3.0 gcc’s `previously declared here` is where the OTHER declaration was, not an error', () => {
  expect(errorMessages("c.c:5: redeclaration of `x'\nc.c:3: `x' previously declared here")).toEqual([
    "redeclaration of `x'",
  ]);
});

// ── a report the compiler cut short ──────────────────────────────────────────────────────────────

test('a diagnostic the compiler stopped short has NO verdict: a prefix of a verdict is not the verdict', () => {
  const arity = (n: number, tail: string[]) =>
    [
      ...Array.from(
        { length: n },
        (_, i) =>
          `cfe: Error: /tmp/x/cand.c, line ${i + 3}: The number of arguments doesn't agree with the number in the declaration.`,
      ),
      ...tail,
    ].join('\n');
  const ido = arity(30, ['   g(29, 1);', ' ---^', 'cfe: Fatal: Too many errors... goodbye.']);
  expect(verdictMessages(ido)).toBeNull();
  expect(verdictMessages(arity(30, []))).not.toBeNull();
  expect(
    verdictMessages(
      'cap.c:3:5: error: too many arguments to function call, expected 1, have 2\nfatal error: too many errors emitted, stopping now [-ferror-limit=]\n20 errors generated.',
    ),
  ).toBeNull();
  expect(
    verdictMessages(
      "max.c:2:15: error: too many arguments to function 'g'\ncompilation terminated due to -fmax-errors=1.",
    ),
  ).toBeNull();
  expect(
    verdictMessages(
      "wf.c:2:15: error: too many arguments to function 'f'\ncompilation terminated due to -Wfatal-errors.",
    ),
  ).toBeNull();
  expect(
    verdictMessages(
      [
        '#      5: g(1, 1);',
        '#   Error:       ^',
        "#   function call 'g(int, int)' does not match",
        "#   'g(int)'",
        '',
        'User break, cancelled...',
      ].join('\n'),
    ),
  ).toBeNull();
});

test('IDO’s `Fatal:` is an error tag, so a fatal line is read as one and comes first', () => {
  expect(errorMessages('cfe: Fatal: Cannot open file foo.h')).toEqual(['Cannot open file foo.h']);
  expect(errorsFirst(['cfe: Warning 712: x', 'cfe: Fatal: Cannot open file foo.h'])).toEqual([
    'cfe: Fatal: Cannot open file foo.h',
    'cfe: Warning 712: x',
  ]);
});

// A REJECTION OF SEVERAL COMPILES (the benchmark's real-tier ladder): each attempt is kept apart,
// in the order it was tried, and the text still reads as every attempt's errors.
test('attempts joined under a header split back as they were, in order', () => {
  const attempts = [
    { label: 'bare typedefs (c++)', diagnostic: "c.c:2: `S' undeclared (first use in this function)" },
    { label: '+ manifest prependC (c++)', diagnostic: 'c.c:1: fatal error: global.h: No such file or directory\n' },
    { label: 'vendored ctx (c++)', diagnostic: '' },
    { label: 'vendored ctx (c)', diagnostic: AGBCC },
  ];
  expect(attemptsOf(joinAttempts(attempts))).toEqual(attempts);
});

test('a diagnostic with no header is ONE attempt: a single compile', () => {
  expect(attemptsOf(AGBCC)).toEqual([{ label: '', diagnostic: AGBCC }]);
  expect(attemptsOf('')).toEqual([{ label: '', diagnostic: '' }]);
  // what came ahead of the first header is kept, as an attempt of its own
  expect(attemptsOf(`cc1: error: x\n${joinAttempts([{ label: 'a', diagnostic: AGBCC }])}`)).toEqual([
    { label: '', diagnostic: 'cc1: error: x' },
    { label: 'a', diagnostic: AGBCC },
  ]);
});

test('the attempt header is never read as an error line', () => {
  const joined = joinAttempts([
    { label: "unit context, the candidate's signature (c)", diagnostic: AGBCC },
    { label: 'vendored ctx (c)', diagnostic: AGBCC },
  ]);
  expect(errorMessages(joined)).toEqual([...errorMessages(AGBCC), ...errorMessages(AGBCC)]);
});
