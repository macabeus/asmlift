// Pin tests for the symmetric outcome classifier — the semantics the whole taxonomy rides on:
// each marker family, the positional `?`-placeholder rules (a legal ternary must NEVER
// false-positive), hard-failure detection, and the deterministic compiler-error extraction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // an INDENTED declaration: a local at the top of a body, and a field of a struct m2c inferred
    expect(declineMarkersIn('void *f(s8 arg0) {\n    ? *var_v1;\n    return var_v1;\n}')).toEqual(['? placeholder']);
    expect(
      declineMarkersIn(
        'typedef struct RefCountable {\n    /* 0x0 */ ? *unk0;                              /* inferred */\n} RefCountable;',
      ),
    ).toEqual(['? placeholder']);
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

  test('a row whose error sits below six warnings publishes the error', () => {
    const msg = [
      "no scorable candidate for 'f': compile command failed (exit 1): cc -c in.c",
      ...Array.from({ length: 6 }, (_, i) => `in.c:${i + 1}: warning: assignment from incompatible pointer type`),
      "in.c:9: too many arguments to function `g'",
    ].join('\n');
    const markers = compilerErrorLines(msg);
    expect(markers).toHaveLength(5);
    expect(markers[0]).toBe("in.c:9: too many arguments to function `g'");
  });

  test('falls back to the first line so the marker is never empty', () => {
    expect(compilerErrorLines('something opaque went wrong\nmore text')).toEqual(['something opaque went wrong']);
  });
});

// THE CLASSIFIER AND THE ARTIFACT THAT SHIPS BESIDE IT MUST AGREE, and nothing checked that they
// did. The rule is `outcome.ts`'s own: a source bearing a decline marker is `declined`, never
// compiled and never scored. A published cell that carries a marker AND a score is one of two
// things and both are defects — a marker added without its cache key (the `SECOND_REG` incident:
// four rows flipped, `synthetic:llpass:agbcc` replayed a v20 entry and shipped as `nonmatch` with
// `score: 8`), or a regex that stopped meaning what the artifact was built under.
//
// IT COSTS 12 ms AND NO BENCH, which is the whole argument for it: the incident it catches was
// found by a reader of the pull request, after a 1,068 s run had already published the row.
describe('the committed artifact obeys the committed classifier', () => {
  const artifact = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'results', 'results.json'), 'utf8')) as {
    results: {
      id: string;
      m2c?: { source?: string; outcome: string };
      asmlift?: { source?: string; outcome: string };
    }[];
  };

  test('the harvest reads the artifact, so a null result here would be the probe failing', () => {
    expect(artifact.results.length).toBeGreaterThan(1000);
    expect(artifact.results.some((r) => declineMarkersIn(r.m2c?.source ?? '').length > 0)).toBe(true);
  });

  test('no published cell bears a decline marker and an outcome other than `declined`', () => {
    const inconsistent: string[] = [];
    for (const row of artifact.results) {
      for (const tool of ['m2c', 'asmlift'] as const) {
        const cell = row[tool];
        if (typeof cell?.source !== 'string') {
          continue;
        }
        const markers = declineMarkersIn(cell.source);
        if (markers.length > 0 && cell.outcome !== 'declined') {
          inconsistent.push(`${row.id} [${tool}] outcome=${cell.outcome} markers=${markers.join(',')}`);
        }
      }
    }
    expect(inconsistent).toEqual([]);
  });
});
