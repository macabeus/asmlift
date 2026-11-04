// scripts/gate-vitest.sh's skip verdict (scripts/gate-skips-check.ts) over hand-built runs, and the
// expected-skip list it reads (scripts/gate-skips.ts). A skip is a gate that did not run: the list
// lets a skip through only where it names the test AND its condition holds here, and every other
// skip — unlisted, listed for a condition that does not hold, or a listed test that ran — fails.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { EXPECTED_SKIPS, type ExpectedSkip } from '../../../scripts/gate-skips';
import { type RanTest, ranTests, skipVerdict } from '../../../scripts/gate-skips-check';
import { REPO_ROOT } from '../src/config';

const A = 'apps/x/test/a.test.ts';
const B = 'apps/x/test/b.test.ts';

/** An entry over `tests` of `file`, whose condition is `holds`, counting how often it is asked. */
const entry = (file: string, tests: string[], holds: boolean): ExpectedSkip & { asked: number } => {
  const e = { file, when: `condition of ${tests.join(', ')}`, tests, asked: 0, holds: () => (e.asked++, holds) };
  return e;
};
const ran = (file: string, name: string, status = 'passed'): RanTest => ({ file, name, status });

describe('the skip verdict', () => {
  test('every skip listed, its condition holding here: PASS, and it says how many', () => {
    const list = [entry(A, ['s > one', 's > two'], true)];
    const v = skipVerdict([ran(A, 's > one', 'skipped'), ran(A, 's > two', 'skipped'), ran(A, 'other')], list);
    expect(v).toEqual({ pass: true, expected: 2, problems: [] });
  });

  test('one skip on no list: FAIL, naming it', () => {
    const list = [entry(A, ['s > one'], true)];
    const v = skipVerdict([ran(A, 's > one', 'skipped'), ran(B, 'new one', 'skipped')], list);
    expect(v.pass).toBe(false);
    expect(v.expected).toBe(1);
    expect(v.problems).toEqual([`unexpected skip, on no list: ${B} > new one`]);
  });

  test('a listed test of the same title in ANOTHER file is not listed', () => {
    const v = skipVerdict([ran(B, 's > one', 'skipped')], [entry(A, ['s > one'], true)]);
    expect(v.problems).toEqual([`unexpected skip, on no list: ${B} > s > one`]);
  });

  test('a listed skip whose condition does not hold here: FAIL — it skipped for some other reason', () => {
    const v = skipVerdict([ran(A, 's > one', 'skipped')], [entry(A, ['s > one'], false)]);
    expect(v.pass).toBe(false);
    expect(v.problems).toEqual([
      `listed skip whose condition does not hold here (condition of s > one): ${A} > s > one`,
    ]);
  });

  test('a stale entry — its condition holds, its test RAN: FAIL', () => {
    const v = skipVerdict([ran(A, 's > one', 'passed')], [entry(A, ['s > one'], true)]);
    expect(v.pass).toBe(false);
    expect(v.problems).toEqual([
      `stale entry: its condition holds here (condition of s > one) but the test passed: ${A} > s > one`,
    ]);
  });

  test('a stale entry — its condition holds, its test is GONE (renamed): FAIL', () => {
    const v = skipVerdict([ran(A, 's > renamed', 'skipped')], [entry(A, ['s > one'], true)]);
    expect(v.pass).toBe(false);
    expect(v.problems).toEqual([
      `unexpected skip, on no list: ${A} > s > renamed`,
      `stale entry: its condition holds here (condition of s > one) but the run has no such test: ${A} > s > one`,
    ]);
  });

  test('a condition that does not hold, its test running: nothing to say (the other host’s entry)', () => {
    expect(skipVerdict([ran(A, 's > one')], [entry(A, ['s > one'], false)])).toEqual({
      pass: true,
      expected: 0,
      problems: [],
    });
  });

  test('an entry for a file the run did not collect is never asked', () => {
    const e = entry(B, ['s > one'], true);
    expect(skipVerdict([ran(A, 'x')], [e])).toEqual({ pass: true, expected: 0, problems: [] });
    expect(e.asked).toBe(0);
  });

  test('a failed or todo test is not a skip this rule judges — the summary line fails those', () => {
    const v = skipVerdict([ran(A, 'f', 'failed'), ran(A, 't', 'todo')], []);
    expect(v).toEqual({ pass: true, expected: 0, problems: [] });
  });
});

describe('the JSON report', () => {
  test('names a test by its file under the root and its describe path joined with " > "', () => {
    const report = {
      testResults: [
        {
          name: '/repo/apps/x/test/a.test.ts',
          assertionResults: [{ ancestorTitles: ['outer', 'inner'], title: 'it: #embed', status: 'skipped' }],
        },
      ],
    };
    expect(ranTests(report, '/repo')).toEqual([{ file: A, name: 'outer > inner > it: #embed', status: 'skipped' }]);
  });
});

describe('the shipped list', () => {
  test('names files that exist, each test once, and says why', () => {
    const seen = new Set<string>();
    for (const e of EXPECTED_SKIPS) {
      expect(existsSync(join(REPO_ROOT, e.file)), e.file).toBe(true);
      expect(e.when.length, e.file).toBeGreaterThan(0);
      for (const name of e.tests) {
        expect(seen.has(`${e.file} > ${name}`), name).toBe(false);
        seen.add(`${e.file} > ${name}`);
        // the title's last segment is the test's own words, so it occurs in its file — or a
        // `test.each` formats it in, and one of the file's `%s` titles matches it
        const title = name.split(' > ').at(-1)!;
        const src = readFileSync(join(REPO_ROOT, e.file), 'utf8');
        const templates = [...src.matchAll(/(['"`])((?:(?!\1)[^\n])*%s(?:(?!\1)[^\n])*)\1/g)].map(
          (m) =>
            new RegExp(
              `^${m[2]
                .split('%s')
                .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('.+')}$`,
            ),
        );
        expect(src.includes(title) || templates.some((t) => t.test(title)), name).toBe(true);
      }
    }
  });

  test('is what scripts/gate-vitest.sh reads', () => {
    const gate = readFileSync(join(REPO_ROOT, 'scripts', 'gate-vitest.sh'), 'utf8');
    expect(gate).toContain('gate-skips-check.ts');
    expect(gate).toContain('--reporter=json --outputFile.json=');
  });
});
