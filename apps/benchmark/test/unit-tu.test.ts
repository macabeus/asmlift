// A manifest's `tu` says what a row's translation unit is. `unit` compiles a row in its own unit's text,
// through the lines its permalink cites — because the declarations in scope do not always decide a function's
// code: CodeWarrior GC/2.6 at -O0,p compiles Mario Party 4's `HuMemHeapDump` to other branch-prediction bits
// after its unit's declarations alone than after the unit's earlier definitions, and only the second is the
// game's function.
import { describe, expect, test } from 'vitest';

import { type RealManifest, validateManifest } from '../src/cases/manifests';
import { rowSources } from '../src/cases/vendor';
import type { RealProjectCfg } from '../src/compile/types';

const UNIT = [
  '#include "a.h"',
  'static int g(void) { return 1; }',
  '',
  'int f(void)',
  '{',
  '    return g();',
  '}',
  '',
].join('\n');
const cfg: RealProjectCfg = {
  project: 'p',
  toolchain: 'mwcc_247_107',
  root: '/nowhere',
  unit: 'src/f.c',
  cflags: ['-O0,p'],
  cppIncludes: [],
  headers: ['b.h'],
};
const row = {
  sym: 'f',
  funcC: 'int f(void)\n{\n    return g();\n}',
  sourceUrl: 'https://github.com/o/p/blob/0123456/src/f.c#L4-L7',
};

describe('rowSources', () => {
  test('a unit row is its unit through its function, and its context the unit before it — definitions and all', () => {
    expect(rowSources('unit', cfg, row, () => UNIT)).toEqual({
      tu: '#include "a.h"\nstatic int g(void) { return 1; }\n\nint f(void)\n{\n    return g();\n}\n',
      ctx: '#include "a.h"\nstatic int g(void) { return 1; }\n\n',
    });
  });

  test('a permalink citing lines that are not funcC is refused, not published', () => {
    expect(() =>
      rowSources('unit', cfg, { ...row, sourceUrl: row.sourceUrl.replace('#L4-L7', '#L3-L6') }, () => UNIT),
    ).toThrow('f: funcC is not lines 3-6 of src/f.c, which its sourceUrl cites');
    expect(() => rowSources('unit', cfg, { ...row, funcC: 'int f(void) { return g(); }' }, () => UNIT)).toThrow(
      /funcC is not lines 4-7/,
    );
  });

  test('an assembled row never reads its unit: headers, prependC, then funcC', () => {
    const sources = rowSources('assembled', cfg, { ...row, prependC: 'int g(void);' }, () => {
      throw new Error('read');
    });
    expect(sources).toEqual({
      tu: '#include "b.h"\nint g(void);\nint f(void)\n{\n    return g();\n}\n',
      ctx: '#include "b.h"\nint g(void);\n\n',
    });
  });
});

describe('validateManifest: tu', () => {
  const manifest = (over: Partial<RealManifest>, fn: Record<string, unknown> = {}): RealManifest =>
    ({
      project: 'p',
      repoDir: 'p',
      repo: 'o/p',
      branch: 'b',
      tu: 'unit',
      cppIncludes: [],
      headers: [],
      functions: [{ ...row, addr: '0x80000000', features: [], ...fn }],
      ...over,
    }) as RealManifest;
  const problems = (m: RealManifest) => validateManifest(m, 'x.json', { complete: false }).join('\n');

  test('a unit manifest with no headers and no prependC validates', () => {
    expect(problems(manifest({}))).toBe('');
  });

  test('the model is stated, and is one of the two', () => {
    expect(problems(manifest({ tu: undefined }))).toMatch(/"tu" must be "assembled" or "unit"/);
    expect(problems(manifest({ tu: 'whole' as RealManifest['tu'] }))).toMatch(/"tu" must be "assembled" or "unit"/);
  });

  test('a unit row reads neither headers nor prependC, so neither may be written', () => {
    expect(problems(manifest({ headers: ['a.h'] }))).toMatch(/"headers" must be empty/);
    expect(problems(manifest({}, { prependC: 'int g(void);' }))).toMatch(/"f" has a "prependC"/);
  });

  test('a unit row cites the span its funcC is', () => {
    expect(problems(manifest({}, { sourceUrl: 'https://github.com/o/p/blob/0123456/src/f.c' }))).toMatch(
      /must cite the line span funcC is/,
    );
  });
});
