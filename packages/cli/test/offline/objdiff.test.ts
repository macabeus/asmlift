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
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';

import { releaseTarget, scoreObjects } from '../../src/objdiff';

const FIX = join(import.meta.dirname, 'fixtures', 'objdiff');
const TARGET = join(FIX, 'target.o');
const DIFF = join(FIX, 'candidate-diff.o');
const ODD_SIZE = join(FIX, 'candidate-odd-size.o');

// ONE scratch dir for the whole file, removed after it: the tests below need a writable path to
// move bytes around under, and an unremoved mkdtemp is unbounded growth in $TMPDIR on every
// machine that runs the suite.
const SCRATCH = mkdtempSync(join(tmpdir(), 'asmlift-objdiff-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

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
  const moving = join(SCRATCH, 'target.o');

  copyFileSync(TARGET, moving);
  expect(scoreObjects(moving, DIFF, 'add_one').match).toBe(false);

  // same path, different bytes: the candidate is now its own target
  copyFileSync(DIFF, moving);
  const s = scoreObjects(moving, DIFF, 'add_one');
  expect(s.match).toBe(true);
  expect(s.score).toBe(0);
});

test('the same bytes under two paths score the same', () => {
  const copy = join(SCRATCH, 'copy.o');
  copyFileSync(TARGET, copy);
  expect(scoreObjects(copy, DIFF, 'add_one')).toEqual(scoreObjects(TARGET, DIFF, 'add_one'));
});

test('an unparseable target THROWS and leaves the previous one intact', () => {
  const broken = join(SCRATCH, 'broken.o');
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

// A row the engine cannot display THROWS — it is never absorbed into a score. `candidate-odd-size.o`
// is `candidate-diff.o` with `add_one`'s st_size cut to 3, so the symbol's last byte is half an
// instruction and objdiff refuses it with `Invalid instruction size 1`. The TARGET's row 0 already
// differs, so this is exactly the row a scorer that consulted the candidate only where the target
// said 'none' would skip: it would return score 2 for a symbol the engine rejected, and the ranked
// run would print `0 dropped` while ranking it.
//
//   node -e 'const {readFileSync,writeFileSync}=require("node:fs");const b=readFileSync("test/offline/fixtures/objdiff/candidate-diff.o");
//     const sh=b.readUInt32LE(0x20),es=b.readUInt16LE(0x2e),n=b.readUInt16LE(0x30);
//     for(let i=0;i<n;i++){const o=sh+i*es;if(b.readUInt32LE(o+4)!==2)continue;
//       const off=b.readUInt32LE(o+16),sz=b.readUInt32LE(o+20),str=b.readUInt32LE(sh+b.readUInt32LE(o+24)*es+16);
//       for(let s=0;s<sz;s+=16){let e=str+b.readUInt32LE(off+s);while(b[e])e++;
//         if(b.toString("latin1",str+b.readUInt32LE(off+s),e)==="add_one")b.writeUInt32LE(3,off+s+8);}}
//     writeFileSync("test/offline/fixtures/objdiff/candidate-odd-size.o",b)'
test('a candidate row the engine cannot display THROWS — never a score', () => {
  expect(() => scoreObjects(TARGET, ODD_SIZE, 'add_one')).toThrow();
});

test('the breakdown names the bucket, not just the total', () => {
  // `add r0, #1` against `add r0, #2` — same mnemonic, same register, differing immediate
  const s = scoreObjects(TARGET, DIFF, 'add_one');
  expect(s.breakdown).toEqual({ insert: 0, delete: 0, replace: 0, opMismatch: 0, argMismatch: s.score });
});

test('releaseTarget drops the memo and the next score re-parses', () => {
  const before = scoreObjects(TARGET, DIFF, 'add_one');
  releaseTarget();
  releaseTarget(); // idempotent: nothing is left to dispose twice
  expect(scoreObjects(TARGET, DIFF, 'add_one')).toEqual(before);
});

// THE SCORE MEMO (src/objdiff.ts `candidateKey`). A score already computed against the retained
// target is handed back rather than recomputed, so these pin what a hit is allowed to mean. Each
// fails against a plausible spelling of the key: on a path-keyed one, on a symbol-less one, and on
// a memo that outlives the target it was computed against.

test('a candidate rewritten in place is re-scored, never handed the previous one’s score', () => {
  // Every compile worker rewrites ONE scratch slot's `cand.o` (compile-command.ts), so this is the
  // shape a ranked run actually presents — a path-keyed memo answers for the previous candidate.
  const slot = join(SCRATCH, 'cand.o');

  copyFileSync(DIFF, slot);
  expect(scoreObjects(TARGET, slot, 'add_one').match).toBe(false);

  copyFileSync(TARGET, slot);
  expect(scoreObjects(TARGET, slot, 'add_one').match).toBe(true);
});

test('the symbol is part of the key — a second symbol is not answered from the first', () => {
  // A key that named only the candidate's bytes would hand `add_one`'s score back for a symbol the
  // object does not have: a throw turned into a plausible number, which is worse than either.
  expect(scoreObjects(TARGET, DIFF, 'add_one').score).toBeGreaterThan(0);
  expect(() => scoreObjects(TARGET, DIFF, 'no_such_symbol')).toThrow(/not found/);
});

test('the memo dies with the target — the same candidate is re-scored against a new one', () => {
  const against = (t: string) => scoreObjects(t, DIFF, 'add_one');
  expect(against(TARGET).match).toBe(false);
  // same candidate bytes, different target: it is now its own target, and matches
  expect(against(DIFF).match).toBe(true);
  expect(against(TARGET).match).toBe(false);
});

test('a candidate that THROWS is not remembered — it throws again', () => {
  expect(() => scoreObjects(TARGET, ODD_SIZE, 'add_one')).toThrow();
  expect(() => scoreObjects(TARGET, ODD_SIZE, 'add_one')).toThrow();
  expect(scoreObjects(TARGET, DIFF, 'add_one').match).toBe(false);
});

test('a returned score is FROZEN — one object serves every candidate with these bytes', () => {
  const s = scoreObjects(TARGET, DIFF, 'add_one');
  expect(Object.isFrozen(s)).toBe(true);
  expect(Object.isFrozen(s.breakdown)).toBe(true);
  // a caller mutating a shared score would rewrite every twin's; it throws instead
  expect(() => {
    (s as { score: number }).score = 99;
  }).toThrow(TypeError);
  expect(scoreObjects(TARGET, DIFF, 'add_one').score).toBe(s.score);
});
