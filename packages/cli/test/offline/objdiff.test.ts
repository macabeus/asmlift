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
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// THE TARGET MEMO (src/objdiff.ts `targetObject`). The parse of the target object is reused across
// calls, keyed on the file's whole content — so these pin what a hit is allowed to mean. Three of
// them fail against the memo spelled the obvious wrong way: `rewritten in place` against a
// path-keyed one, and the two below it against disposing the outgoing entry before the incoming
// parse succeeds.

test('a target rewritten in place is re-parsed, never scored against stale bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-objdiff-'));
  const moving = join(dir, 'target.o');

  copyFileSync(TARGET, moving);
  expect(scoreObjects(moving, DIFF, 'add_one').match).toBe(false);

  // same path, different bytes: the candidate is now its own target
  copyFileSync(DIFF, moving);
  const s = scoreObjects(moving, DIFF, 'add_one');
  expect(s.match).toBe(true);
  expect(s.score).toBe(0);
});

test('the same bytes under two paths score the same', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-objdiff-'));
  const copy = join(dir, 'copy.o');
  copyFileSync(TARGET, copy);
  expect(scoreObjects(copy, DIFF, 'add_one')).toEqual(scoreObjects(TARGET, DIFF, 'add_one'));
});

test('an unparseable target THROWS and leaves the previous one intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asmlift-objdiff-'));
  const broken = join(dir, 'broken.o');
  writeFileSync(broken, 'not an object file');

  const before = scoreObjects(TARGET, DIFF, 'add_one');
  expect(() => scoreObjects(broken, DIFF, 'add_one')).toThrow();
  expect(scoreObjects(TARGET, DIFF, 'add_one')).toEqual(before);
});

test('scoring the same target repeatedly is stable', () => {
  // the memo hands the SAME engine handle to every diff; nothing may accumulate on it
  const first = scoreObjects(TARGET, DIFF, 'add_one');
  for (let i = 0; i < 5; i++) {
    expect(scoreObjects(TARGET, TARGET, 'add_one').match).toBe(true);
    expect(scoreObjects(TARGET, DIFF, 'add_one')).toEqual(first);
  }
});
