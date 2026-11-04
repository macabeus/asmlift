// The skip half of scripts/gate-vitest.sh's verdict: every skip in a vitest JSON report must be one
// scripts/gate-skips.ts expects on this host.
//
//   pnpm exec tsx scripts/gate-skips-check.ts <vitest-json-report>
//
// Prints one line per finding and a summary, and exits 0 when the skips are exactly the expected
// ones, 1 when they are not, 2 when the report cannot be read. `skipVerdict` is the pure rule, so
// apps/benchmark/test/gate-skips.test.ts can price it without a vitest run or a probe.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_SKIPS, type ExpectedSkip } from './gate-skips';

const ROOT = join(import.meta.dirname, '..');

/** One test of a run, as the verdict reads it. */
export interface RanTest {
  /** relative to the repository root */
  file: string;
  /** describe titles and the test title, joined with ' > ' */
  name: string;
  status: string;
}

export interface SkipVerdict {
  pass: boolean;
  /** the skips an entry expected here */
  expected: number;
  /** every reason it failed, one per line */
  problems: string[];
}

/** THE RULE. A skip passes only when an entry lists it and that entry's condition holds here. It
 *  fails when no entry lists it, or when the listing entry's condition does not hold (it skipped for
 *  another reason). An entry whose condition holds, in a file the run collected, fails for each of
 *  its tests that did not skip — it ran, or no longer exists — because the list is then stale.
 *  `holds` is asked only of entries whose file the run collected. */
export function skipVerdict(tests: readonly RanTest[], expectedSkips: readonly ExpectedSkip[]): SkipVerdict {
  const collected = new Set(tests.map((t) => t.file));
  const problems: string[] = [];
  const holds = new Map<ExpectedSkip, boolean>();
  const asks = (e: ExpectedSkip): boolean => {
    if (!holds.has(e)) {
      holds.set(e, e.holds());
    }
    return holds.get(e)!;
  };
  const entryOf = (t: RanTest): ExpectedSkip | undefined =>
    expectedSkips.find((e) => e.file === t.file && e.tests.includes(t.name));
  let expected = 0;
  for (const t of tests) {
    if (t.status !== 'skipped') {
      continue;
    }
    const e = entryOf(t);
    if (!e) {
      problems.push(`unexpected skip, on no list: ${t.file} > ${t.name}`);
    } else if (!asks(e)) {
      problems.push(`listed skip whose condition does not hold here (${e.when}): ${t.file} > ${t.name}`);
    } else {
      expected++;
    }
  }
  const byName = new Map(tests.map((t) => [`${t.file}\0${t.name}`, t]));
  for (const e of expectedSkips) {
    if (!collected.has(e.file) || !asks(e)) {
      continue;
    }
    for (const name of e.tests) {
      const t = byName.get(`${e.file}\0${name}`);
      if (!t) {
        problems.push(
          `stale entry: its condition holds here (${e.when}) but the run has no such test: ${e.file} > ${name}`,
        );
      } else if (t.status !== 'skipped') {
        problems.push(
          `stale entry: its condition holds here (${e.when}) but the test ${t.status}: ${e.file} > ${name}`,
        );
      }
    }
  }
  return { pass: problems.length === 0, expected, problems };
}

interface JsonReport {
  testResults: { name: string; assertionResults: { ancestorTitles: string[]; title: string; status: string }[] }[];
}

/** The tests of a vitest `--reporter=json` report. */
export function ranTests(report: JsonReport, root = ROOT): RanTest[] {
  return report.testResults.flatMap((f) => {
    const file = relative(root, isAbsolute(f.name) ? f.name : join(root, f.name));
    return f.assertionResults.map((a) => ({
      file,
      name: [...a.ancestorTitles, a.title].join(' > '),
      status: a.status,
    }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let report: JsonReport;
  try {
    report = JSON.parse(readFileSync(process.argv[2], 'utf8')) as JsonReport;
  } catch (e) {
    console.error(`gate-skips: cannot read the vitest JSON report ${process.argv[2]}: ${(e as Error).message}`);
    process.exit(2);
  }
  const v = skipVerdict(ranTests(report), EXPECTED_SKIPS);
  for (const p of v.problems) {
    console.error(`gate-skips: ${p}`);
  }
  console.log(
    v.pass
      ? v.expected === 0
        ? 'gate-skips: no skips'
        : `gate-skips: ${v.expected} skip(s), every one expected on this host (scripts/gate-skips.ts)`
      : `gate-skips: ${v.problems.length} problem(s) above; ${v.expected} skip(s) expected on this host`,
  );
  process.exit(v.pass ? 0 : 1);
}
