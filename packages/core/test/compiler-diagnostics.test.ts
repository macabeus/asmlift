// What counts as an ERROR in a compiler's output, and when two failed compiles failed the same way.
import { expect, test } from 'vitest';

import { errorKey, errorMessages, errorsFirst } from '../src/compiler-diagnostics';

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

test('the key is a MULTISET: repairing one of two identical errors changes it', () => {
  const one = "c.c:9: too many arguments to function `thunk_HeapFree'";
  expect(errorKey(AGBCC)).not.toBe(errorKey(one));
});

test('the key ignores where the error sits, which a respelled body moves', () => {
  expect(errorKey('c.c:12: invalid operands to binary &')).toBe(
    errorKey('agbcc failed: c.c:40: warning: x\n/tmp/q/c.c:31: invalid operands to binary &'),
  );
});

test('the key reads a column and an `error:` tag as position and label', () => {
  expect(errorKey("in.c:7:3: error: too many arguments to function 'g'")).toBe(
    errorKey("in.c:19:11: error: too many arguments to function 'g'"),
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
  expect(errorKey('cfe: Error: /tmp/bench-cand-a1/c.c, line 12: Syntax Error')).toBe(
    errorKey('cfe: Error: /tmp/bench-cand-b2/c.c, line 40: Syntax Error'),
  );
});

test('text with no recognisable error has NO key — never an empty one that equals another', () => {
  expect(errorKey('')).toBeNull();
  expect(errorKey("'agbcc' timed out")).toBeNull();
  expect(errorKey('c.c:3: warning: only a warning')).toBeNull();
  expect(errorKey('compile command exited 0 but produced no object at {{outputPath}}: cc -c in.c')).toBeNull();
});
