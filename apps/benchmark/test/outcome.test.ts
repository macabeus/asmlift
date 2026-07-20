// Pin tests for the symmetric outcome classifier — the semantics the whole taxonomy rides on:
// each marker family, the positional `?`-placeholder rules (a legal ternary must NEVER
// false-positive), hard-failure detection, and the deterministic compiler-error extraction.
import { describe, expect, test } from 'vitest';

import { compilerErrorLines, declineMarkersIn, isHardFailure } from '../src/eval/outcome';

describe('declineMarkersIn (pinned)', () => {
  test('names each marker family once', () => {
    expect(declineMarkersIn('void f(void) {\n    ASMLIFT_ERROR("gap");\n}')).toEqual(['ASMLIFT_ERROR']);
    expect(declineMarkersIn('s32 f(void) { return M2C_ERROR(/* rotlw */); }')).toEqual(['M2C_ERROR']);
    expect(declineMarkersIn('x = a + M2C_CARRY(b); y = M2C_UNK;')).toEqual(['M2C_UNK', 'M2C_CARRY']);
    expect(declineMarkersIn('return (bitwise f32) __addsf3();')).toEqual(['M2C bitwise cast']);
  });

  test('`?` placeholders in declaration positions are declines', () => {
    expect(declineMarkersIn('extern ? IconDisplayList;\n\ns32 f(void) { return 1; }')).toEqual(['? placeholder']);
    expect(declineMarkersIn('? func_80031C50(s32);')).toEqual(['? placeholder']); // m2c extern fn decl
    expect(declineMarkersIn('void g(? *arg0) {}')).toEqual(['? placeholder']);
    expect(declineMarkersIn('static ? sCrc16Table;')).toEqual(['? placeholder']); // m2c static decl
  });

  test('legal single-line ternaries never false-positive, including at the anchors', () => {
    expect(declineMarkersIn('s32 f(s32 *p, s32 x) {\n    return x ? *p : 0;\n}')).toEqual([]);
    expect(declineMarkersIn('s32 g(s32 a, s32 b) {\n    return a > b ? a : b;\n}')).toEqual([]);
    // the positional anchors themselves: ternary after a comma / inside parens / after a brace
    expect(declineMarkersIn('h(a, b ? c : d);')).toEqual([]);
    expect(declineMarkersIn('x = (a ? *b : c);')).toEqual([]);
    expect(declineMarkersIn('if (x) { y = p ? *p : 0; }')).toEqual([]);
  });

  test('clean output carries no markers', () => {
    expect(declineMarkersIn('int add(int a, int b) {\n    return a + b;\n}')).toEqual([]);
  });
});

describe('isHardFailure (pinned)', () => {
  test('m2c crash blocks and missing-function reports are hard failures', () => {
    expect(isHardFailure('/*\nDecompilation failure in function f:\n\nCannot find branch target\n*/')).toBe(true);
    expect(isHardFailure('Function foo not found.')).toBe(true);
  });

  test('ordinary output is not', () => {
    expect(isHardFailure('s32 f(void) { return 1; }')).toBe(false);
  });
});

describe('compilerErrorLines (pinned)', () => {
  test('extracts diagnostics and scrubs scratch paths deterministically', () => {
    const msg = [
      "no scorable candidate for 'f': agbcc failed:",
      "/var/folders/xx/T/asmlift-score-AbC123/cand.pp.c: In function `f':",
      "/var/folders/xx/T/asmlift-score-AbC123/cand.pp.c:3: invalid type argument of `unary *'",
    ].join('\n');
    // only true diagnostics survive (`:N:` or the word "error") — the `In function` banner does not
    expect(compilerErrorLines(msg)).toEqual(["<tmp>/cand.pp.c:3: invalid type argument of `unary *'"]);
  });

  test('falls back to the first line so the marker is never empty', () => {
    expect(compilerErrorLines('something opaque went wrong\nmore text')).toEqual(['something opaque went wrong']);
  });
});
