// Pin tests for stripPrototype: drop the target symbol's PROTOTYPE lines from preprocessed text
// while keeping its definition, so a decompiler's generic signature (`s32 f(s32)`) is judged on
// codegen, not on conflicting with the header's real prototype (`s8 f(u8)`).
import { describe, expect, test } from 'vitest';

import { stripPrototype } from '../src/compile/agbcc';

describe('stripPrototype (pinned)', () => {
  test('drops the prototype line, keeps the definition', () => {
    const src = 'u8 GetGold(void);\nint other(void);\nu8 GetGold(void) {\n    return 5;\n}\n';
    expect(stripPrototype(src, 'GetGold')).toBe('int other(void);\nu8 GetGold(void) {\n    return 5;\n}\n');
  });

  test('leaves other symbols prototypes alone', () => {
    const src = 's32 helper(s32);\ns32 f(void) { return helper(1); }';
    expect(stripPrototype(src, 'f')).toBe(src);
  });

  test('does not drop a one-line definition (has a brace)', () => {
    const src = 'int f(void) { return 1; }';
    expect(stripPrototype(src, 'f')).toBe(src);
  });

  test('drops multiple prototype declarations of the symbol', () => {
    const src = 'int f(int);\nextern int f(int);\nint f(int a) {\n    return a;\n}';
    expect(stripPrototype(src, 'f')).toBe('int f(int a) {\n    return a;\n}');
  });

  test('a call site ending in ; is not a prototype line... unless it looks like one', () => {
    // Pinned CURRENT behavior: the filter is line-based — a statement line that both mentions
    // `sym(` and ends in `;` without `{` IS dropped. Callers only feed it preprocessed TU text
    // where the symbol under test is the one being compiled, so this does not bite in practice.
    expect(stripPrototype('    f(1);', 'f')).toBe('');
  });
});
