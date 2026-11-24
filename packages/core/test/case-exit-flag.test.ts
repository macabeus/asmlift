// A CASE BODY THAT LEAVES ITS LOOP PAST THE SWITCH'S END, spelled with a flag.
//
// `for (…) { do { switch (t) { case 1: b(); goto out; … } k(); } while (1); out: h(i); }` leaves the
// inner loop from a case body, for the loop's exit, where `k()` runs after the switch. C binds a
// `break;` in the arm to the switch, so structure writes `f = 1; break;` there, `f = 0;` ahead of
// the switch and `if (f != 0) break;` right after it (structure.ts `caseExitBreak`). Every fixture
// is judged against its own IR by the trace oracle (`irAgreement`), as `structure()` returns it and
// as it ships after `readabilityRewrites`. The flag is asked only once every run without it declined
// (structure.ts `CaseExitRanking`), so the controls keep the spelling they had: an exit the other
// readings spell, one whose code ends in a `return` with no enclosing loop to re-enter (copied into
// the arm), and a tested exit out of an arm of a switch nested in another switch of the loop, which
// declines, since the test after the inner switch would leave only the outer one. Each dispatch
// reads the inner counter less the outer one, so the seeds run every arm the exit is taken from.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement, irTraceOf } from './helpers';

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

const judged = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, {});
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

/** `least` is the share of seeds the oracle must run: a loop that never ends unless a call says so
 *  runs out of steps on the rest */
const alike = (r: { judged: number; disagree: number }, least = 1 / 2): void => {
  expect(r.disagree).toBe(0);
  expect(r.judged).toBeGreaterThan(SEEDS.length * least);
};

/** How many seeds run a call to `callee` in the IR's own trace: what the oracle has judged. */
const ran = (ir: string, callee: string): number =>
  SEEDS.filter((seed) => {
    try {
      return irTraceOf(parse(ir), seed).some((e) => e.fn === callee);
    } catch {
      return false;
    }
  }).length;

/** An outer counted loop around a `while (1)` over `j` whose jump table on `j - i` runs `a` in
 *  case 0, and in case 1 calls `b` and leaves the inner loop (`leave`: unconditionally, or on `b`'s
 *  result), past `k(j)` after the switch, for the inner loop's exit `h(i)`, which runs on to the
 *  outer latch. */
const nested = (leave: 'always' | 'tested') => `fn cx {
^bb0(%n: s32):
  %z: s32 = const {value=0}
  %one: s32 = const {value=1}
  br ^bb1(%z)
^bb1(%i: s32):
  %c: u32 = icmp_slt %i, %n
  cond_br %c, ^bb2(%z), ^bb9()
^bb2(%j: s32):
  %t: s32 = sub %j, %i
  switch_br %t, ^bb3(), ^bb4(), ^bb5(), ^bb7() {cases=[0;1;2]}
^bb3():
  %a: s32 = call %j {target="a"}
  br ^bb7()
^bb4():
  %b: s32 = call %j {target="b"}
${leave === 'always' ? '  br ^bb8()' : '  cond_br %b, ^bb8(), ^bb7()'}
^bb5():
  %d: s32 = call %j {target="d"}
  br ^bb7()
^bb7():
  %k: s32 = call %j {target="k"}
  %j2: s32 = add %j, %one
  br ^bb2(%j2)
^bb8():
  %h: s32 = call %i {target="h"}
  %i2: s32 = add %i, %one
  br ^bb1(%i2)
^bb9():
  ret
}`;

/** `while (1) { switch (j) { case 0: a(); break; case 1: b(); return; case 2: d(); break; } k(); j++; }` */
const RETURNS = `fn cr {
^bb0(%n: s32):
  %z: s32 = const {value=0}
  %one: s32 = const {value=1}
  br ^bb2(%z)
^bb2(%j: s32):
  switch_br %j, ^bb3(), ^bb4(), ^bb5(), ^bb7() {cases=[0;1;2]}
^bb3():
  %a: s32 = call %n {target="a"}
  br ^bb7()
^bb4():
  %b: s32 = call %n {target="b"}
  br ^bb8()
^bb5():
  %d: s32 = call %n {target="d"}
  br ^bb7()
^bb7():
  %k: s32 = call %n {target="k"}
  %j2: s32 = add %j, %one
  br ^bb2(%j2)
^bb8():
  ret
}`;

/** The nested loop with a bottom-tested inner loop (three trips), whose dispatch on `j - i` opens a
 *  second switch on `i` in case 0, and that switch's case 0 leaves for the inner loop's exit
 *  (`tested`: on `i < 1`, beside a path to the code after both switches). */
const inSwitch = (leave: 'always' | 'tested') => `fn cn {
^bb0(%n: s32):
  %z: s32 = const {value=0}
  %one: s32 = const {value=1}
  %lim: s32 = const {value=3}
  br ^bb1(%z)
^bb1(%i: s32):
  %c: u32 = icmp_slt %i, %n
  cond_br %c, ^bb2(%z), ^bb9()
^bb2(%j: s32):
  %t: s32 = sub %j, %i
  switch_br %t, ^bb3(), ^bb5(), ^bb7() {cases=[0;1]}
^bb3():
  switch_br %i, ^bb4(), ^bb6(), ^bb7() {cases=[0;1]}
^bb4():
  %b: s32 = call %j {target="b"}
${leave === 'always' ? '  br ^bb8()' : '  %bc: u32 = icmp_slt %i, %one\n  cond_br %bc, ^bb8(), ^bb7()'}
^bb6():
  %e: s32 = call %j {target="e"}
  br ^bb7()
^bb5():
  %d: s32 = call %j {target="d"}
  br ^bb7()
^bb7():
  %k: s32 = call %j {target="k"}
  %j2: s32 = add %j, %one
  %more: u32 = icmp_slt %j2, %lim
  cond_br %more, ^bb2(%j2), ^bb8()
^bb8():
  %h: s32 = call %i {target="h"}
  %i2: s32 = add %i, %one
  br ^bb1(%i2)
^bb9():
  ret
}`;

/** A two-level exit out of a case body, two-level-exit.test.ts's `SECOND_EXIT_FROM_A_CASE_BODY`
 *  with its dispatch on `j - i` and its hit at `j == 1`: `for (i…) { if (m >= 0) { j = 0; do {
 *  switch (j - i) { case 0: a(j); if (j == 1) goto next; case 1: b(j); } } while (++j <= m); }
 *  k(i); next:; }`. */
const TWO_LEVEL = `fn ct {
^bb0(%0: s32, %1: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = sub %10, %5
  switch_br %11, ^bb20(), ^bb21(), ^bb4() {cases=[0;1]}
^bb20():
  %30: s32 = call %10 {target="a"}
  %32: u32 = icmp_eq %10, %7
  cond_br %32, ^bb6(), ^bb21()
^bb21():
  %31: s32 = call %10 {target="b"}
  br ^bb4()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

test('an arm that leaves the loop for its exit past the code after the switch sets a flag the switch is followed by', () => {
  const ir = nested('always');
  const { src, agreement, shipped } = judged(ir);
  expect(src).toMatch(/(v\d+) = 0;\n\s*switch \(/);
  expect(src).toMatch(/case 1:\n\s*(v\d+) = 1;\n\s*break;/);
  expect(src).toMatch(/}\n\s*if \((v\d+) != 0\) break;\n\s*k\(v\d+\);/);
  // the arm's own block is the inner loop's only exit, so its call renders after the loop
  expect(src).toMatch(/}\n\s*b\(v\d+\);\n\s*h\(v\d+\);/);
  expect(src).not.toContain('goto');
  alike(agreement);
  alike(shipped);
  expect(ran(ir, 'b')).toBeGreaterThan(SEEDS.length / 4);
  expect(ran(ir, 'a')).toBeGreaterThan(SEEDS.length / 4);
});

test('an arm of a switch nested in a case body reaches the exit as the end of its own switch, then sets the flag', () => {
  // the inner switch's merge is the loop's exit, so its arms `break;` to it and the flag is set
  // after the inner switch, in the outer arm, where the one switch opened in the loop is the outer
  const ir = inSwitch('always');
  const { src, agreement, shipped } = judged(ir);
  expect(src).toMatch(/switch \(v\d+\) \{[\s\S]*\}\n\s*(v\d+) = 1;\n\s*break;/);
  alike(agreement);
  alike(shipped);
  expect(ran(ir, 'b')).toBeGreaterThan(SEEDS.length / 4);
  expect(ran(ir, 'e')).toBeGreaterThan(0);
});

test('a two-level exit out of a case body sets its one flag, read after the switch and after the loop', () => {
  // the two-level flag is 0 before the loop and set only on the exit path, so it is the flag the
  // switch is followed by too: no second, case-body flag beside it
  const { src, agreement, shipped } = judged(TWO_LEVEL);
  const hit = /\{\n\s*(v\d+) = 1;\n\s*break;\n\s*\}/.exec(src);
  expect(hit).not.toBeNull();
  const flag = hit![1];
  expect(src.match(/ = 1;\n\s*break;/g)).toHaveLength(1);
  expect(src).toMatch(new RegExp(`}\\n\\s*if \\(${flag} != 0\\) break;`));
  expect(src).toMatch(new RegExp(`if \\(${flag} == 0\\) k\\(v\\d+\\);`));
  alike(agreement);
  alike(shipped);
  // outer iterations (from one `mark` to the next) that take the hit, `a(1)` and no `k`, and that do not
  const its = SEEDS.flatMap((seed) =>
    irTraceOf(parse(TWO_LEVEL), seed)
      .reduce<{ fn: string; args: readonly unknown[] }[][]>((acc, e) => {
        if (e.fn === 'mark') {
          acc.push([]);
        } else {
          acc.at(-1)?.push(e);
        }
        return acc;
      }, [])
      .map((it) => ({ hit: it.some((e) => e.fn === 'a' && e.args[0] === 1), k: it.some((e) => e.fn === 'k') })),
  );
  expect(its.filter((it) => it.hit && !it.k).length).toBeGreaterThan(0);
  expect(its.filter((it) => !it.hit && it.k).length).toBeGreaterThan(0);
});

test('CONTROL: a tested exit the other readings spell keeps that spelling, with no flag', () => {
  // the arm's own test is the inner loop's exit, which the copies of `k()` reach as `continue;`, so
  // a run that asks no exit flag lifts it already (`CaseExitRanking`)
  const { src, agreement, shipped } = judged(nested('tested'));
  expect(src).not.toMatch(/= 1;\n\s*break;/);
  alike(agreement);
  alike(shipped);
});

test('CONTROL: an exit whose code returns, with no enclosing loop, is copied into the arm, with no flag', () => {
  const { src, agreement, shipped } = judged(RETURNS);
  expect(src).not.toMatch(/= 1;\n\s*break;/);
  expect(src).toMatch(/b\(a0\);\n\s*return;/);
  alike(agreement);
  alike(shipped);
});

test('CONTROL: a tested exit out of an arm of a switch nested in another switch of the loop declines', () => {
  const fn = parse(inSwitch('tested'));
  verify(fn);
  recoverTypes(fn);
  expect(() => structure(fn, {})).toThrow(/a case body leaves its switch for a loop exit past the switch's end/);
});

test('CONTROL: a decline whose case bodies reach no loop exit is not structured again with the flag', () => {
  // `do { switch (j) { case 0: if (a(j)) e(j); break; case 1: b(j); break; case 2: d(j); } k(j); }
  // while (++j < n);`, then a loop-free switch whose case 0 reaches two sibling cases, which no
  // structuring spells. No branch in the loop's case bodies leaves the loop, so nothing asks for the
  // rerun with the flag: the `caseExitFlags` hook is read only where one was asked
  // (`CaseExitRanking`).
  const fn = parse(`fn cd {
^bb0(%n: s32):
  %z: s32 = const {value=0}
  %one: s32 = const {value=1}
  br ^bb2(%z)
^bb2(%j: s32):
  switch_br %j, ^bb3(), ^bb4(), ^bb5(), ^bb7() {cases=[0;1;2]}
^bb3():
  %a: s32 = call %j {target="a"}
  cond_br %a, ^bb6(), ^bb7()
^bb6():
  %e: s32 = call %j {target="e"}
  br ^bb7()
^bb4():
  %b: s32 = call %j {target="b"}
  br ^bb7()
^bb5():
  %d: s32 = call %j {target="d"}
  br ^bb7()
^bb7():
  %k: s32 = call %j {target="k"}
  %j2: s32 = add %j, %one
  %c: u32 = icmp_slt %j2, %n
  cond_br %c, ^bb2(%j2), ^bb9()
^bb9():
  switch_br %n, ^bb20(), ^bb21(), ^bb22(), ^bb23(), ^bb30() {cases=[0;1;2;3]}
^bb20():
  %p: s32 = call %n {target="p"}
  cond_br %p, ^bb21(), ^bb22()
^bb21():
  %q: s32 = call %n {target="q"}
  cond_br %q, ^bb23(), ^bb30()
^bb22():
  %r: s32 = call %n {target="r"}
  cond_br %r, ^bb21(), ^bb23()
^bb23():
  %s: s32 = call %n {target="s"}
  br ^bb30()
^bb30():
  ret
}`);
  verify(fn);
  recoverTypes(fn);
  // not enumerable, so the runs' copies of the hooks leave it out and only the rerun's question reads it
  let asked = 0;
  const hooks = Object.defineProperty({}, 'caseExitFlags', {
    get: (): undefined => {
      asked++;
      return undefined;
    },
  });
  expect(() => structure(fn, {}, hooks)).toThrow(/a case body reaches several sibling cases/);
  expect(asked).toBe(0);
});
