// What counts as an ERROR in a compiler's output.
import { expect, test } from 'vitest';

import { errorsFirst } from '../src/compiler-diagnostics';

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
