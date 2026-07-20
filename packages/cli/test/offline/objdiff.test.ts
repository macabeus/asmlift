// The scoring seam itself, OFFLINE — protect the referee. Every other suite
// exercises the scorer through a live toolchain, so none of them can run on a hosted CI runner —
// this one scores two COMMITTED fixture objects (trivial `x+1`/`x+2` Thumb functions built once
// with agbcc; regenerate with the snippet below, run from packages/cli/) and therefore needs
// nothing but node_modules.
// It pins the engine's observable behavior: what a match is, what a non-match is, and that
// failure paths THROW instead of reporting anything — a false byte-exact match is the one
// defect this project can never emit.
//
//   npx tsx -e 'const { compileTargetAsm, assembleTarget } = await import("@asmlift/toolchains");
//     const { copyFileSync } = await import("node:fs");
//     copyFileSync(assembleTarget(compileTargetAsm("int add_one(int x) { return x + 1; }\n")), "test/offline/fixtures/objdiff/target.o");
//     copyFileSync(assembleTarget(compileTargetAsm("int add_one(int x) { return x + 2; }\n")), "test/offline/fixtures/objdiff/candidate-diff.o");'
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { scoreObjects } from '../../src/objdiff';

const FIX = join(import.meta.dirname, 'fixtures', 'objdiff');
const TARGET = join(FIX, 'target.o');
const DIFF = join(FIX, 'candidate-diff.o');

test('identical object scores 0 and matches', () => {
  const s = scoreObjects(TARGET, TARGET, 'add_one');
  expect(s.match).toBe(true);
  expect(s.score).toBe(0);
  expect(s.rows).toBeGreaterThan(0);
  expect(s.matching).toBe(s.rows);
});

test('differing candidate scores > 0 and does not match', () => {
  const s = scoreObjects(TARGET, DIFF, 'add_one');
  expect(s.match).toBe(false);
  expect(s.score).toBeGreaterThan(0);
  const tallied =
    s.breakdown.insert + s.breakdown.delete + s.breakdown.replace + s.breakdown.opMismatch + s.breakdown.argMismatch;
  expect(tallied).toBe(s.score);
});

test('missing symbol THROWS — never reports a score', () => {
  expect(() => scoreObjects(TARGET, DIFF, 'no_such_symbol')).toThrow(/not found/);
});

test('unparseable object THROWS — never reports a score', () => {
  // the test file itself is not an object file
  expect(() => scoreObjects(TARGET, import.meta.filename, 'add_one')).toThrow();
});

test('missing file THROWS', () => {
  expect(() => scoreObjects(TARGET, join(FIX, 'does-not-exist.o'), 'add_one')).toThrow();
});
