// THE DRAFT KEY THE DUPLICATE COLLAPSE READS (rank.ts `DraftKeys`).
//
// `enumerateCandidates` collapses two candidates whose drafts are the same text, and it keeps a
// compact key per draft rather than the draft itself. The collapse is only the one it was before if
// the key is INJECTIVE: two keys equal exactly when the two drafts are equal. These pin that over the
// cases that could break it: a line that is a prefix of another, empty lines and a trailing newline,
// a draft that is another's lines in a different split, and line indices past the one-unit code.
import { expect, test } from 'vitest';

import { DraftKeys } from '../src/rank';

test('equal drafts share a key and different drafts do not', () => {
  const keys = new DraftKeys();
  const drafts = [
    'void f(void) {\n    x = 1;\n}',
    'void f(void) {\n    x = 1;\n}\n',
    'void f(void) {\n\n    x = 1;\n}',
    'void f(void) {\n    x = 1;\n',
    'void f(void) {\n    x = 1;}',
    'void f(void) {    x = 1;\n}',
    '',
    '\n',
    '\n\n',
  ];
  const first = drafts.map((d) => keys.key(d));
  expect(new Set(first).size).toBe(drafts.length);
  // asked again, after the table has grown, each draft gets its own key back
  expect(drafts.map((d) => keys.key(d))).toEqual(first);
});

test('a line index past the one-unit code stays prefix-free', () => {
  const keys = new DraftKeys();
  // 0x8000 distinct lines, so the next ones take the two-unit form
  for (let i = 0; i < 0x8000 + 4; i++) {
    keys.key(`line ${i}`);
  }
  const a = `line ${0x8000}`;
  const b = `line ${0x8001}`;
  const drafts = [a, b, `${a}\n${b}`, `${b}\n${a}`, `line 1\n${a}`, `${a}\nline 1`, 'line 1\nline 0', 'line 0\nline 1'];
  const first = drafts.map((d) => keys.key(d));
  expect(new Set(first).size).toBe(drafts.length);
  expect(drafts.map((d) => keys.key(d))).toEqual(first);
  expect(keys.key(a)).toHaveLength(2);
  expect(keys.key('line 1')).toHaveLength(1);
});
