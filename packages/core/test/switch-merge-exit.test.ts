// AN EXIT TO AN ENCLOSING SWITCH'S MERGE FROM A SWITCH NESTED IN ONE OF ITS ARMS.
//
// A `goto` out of an arm of a switch nested in a case body, for the code after the outer switch,
// reaches the outer switch's merge from inside the inner one, where C binds a `break;` to the inner
// switch. structure.ts `switchMergeExit` writes `f = 1; break;` there, `f = 0;` ahead of the inner
// switch and a SWITCH-scoped `if (f != 0) break;` right after it, so the rest of the outer arm is
// skipped; where nothing is left of the arm to skip, the test and the flag are dropped
// (`dropSpentFlagTests`). A merge that is a bare `ret` is `return;` instead, with no flag, from inside a loop nested
// in the arm as well; an exit from inside such a loop to a merge that runs code still declines,
// since a test after that loop would leave the loop and not the switch. Each fixture is judged
// against its own IR by the trace oracle (`irAgreement`), as `structure()` returns it and as it
// ships after `readabilityRewrites`. Both spellings are asked only once every run without them
// declined (structure.ts `CaseExitRanking`), and each fixture declines without them.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parseAsmData } from '../src/frontend/asmdata';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import type { Stmt } from '../src/l3/ast';
import { decompile, readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { dropSpentFlagTests } from '../src/structure/ast-rewrites';
import { structure } from '../src/structure/structure';
import { TOOLCHAIN_TARGETS } from '../src/target';
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

const alike = (r: { judged: number; disagree: number }, least = 1 / 2): void => {
  expect(r.disagree).toBe(0);
  expect(r.judged).toBeGreaterThan(SEEDS.length * least);
};

/** How many seeds run a call to `callee` in the IR's own trace. */
const ran = (ir: string, callee: string): number =>
  SEEDS.filter((seed) => {
    try {
      return irTraceOf(parse(ir), seed).some((e) => e.fn === callee);
    } catch {
      return false;
    }
  }).length;

/** agbcc -O2's synthetic:sw_gotocase_inner as the frontend hands it to structure, with each load a
 *  call the oracle can run: `for (i = lo; i <= hi; i++) { if (f(i) <= 26) { switch (id(i)) { case 1:
 *  switch (u(i)) { case 0: k(10); break; case 1: goto shared; … } continue; case 3: case 4: shared:
 *  if (x(i) > 20) continue; mark(1); k(i); break; … } break; } } for (j = 0; j < 3; j++) k(j);`. The inner switch's `goto shared;` runs the shared body (#8, #9), and #9 leaves for the
 *  outer switch's merge #15, the loop's exit, whose code holds a loop. */
const GOTOCASE_INNER = `fn gi {
^bb0(%0: s32, %1: s32):
  %4: u32 = icmp_slt %1, %0
  cond_br %4, ^bb15(), ^bb1(%0)
^bb1(%5: s32):
  %7: s32 = call %5 {target="f"}
  %8: s32 = const {value=26}
  %9: u32 = icmp_slt %8, %7
  cond_br %9, ^bb14(), ^bb2()
^bb2():
  %10: s32 = call %5 {target="id"}
  %11: s32 = const {value=1}
  %12: s32 = sub %10, %11
  switch_br %12, ^bb3(), ^bb10(), ^bb8(), ^bb8(), ^bb14(), ^bb14(), ^bb12(), ^bb14() {cases=[0;1;2;3;4;5;6]}
^bb3():
  %13: s32 = call %5 {target="u"}
  switch_br %13, ^bb4(), ^bb8(), ^bb5(), ^bb6(), ^bb7(), ^bb14() {cases=[0;1;2;3;4]}
^bb4():
  %14: s32 = const {value=10}
  %15: s32 = call %14 {target="k"}
  br ^bb14()
^bb5():
  %16: s32 = const {value=12}
  %17: s32 = call %16 {target="k"}
  br ^bb14()
^bb6():
  %18: s32 = const {value=13}
  %19: s32 = call %18 {target="k"}
  br ^bb14()
^bb7():
  %20: s32 = const {value=14}
  %21: s32 = call %20 {target="k"}
  br ^bb14()
^bb8():
  %22: s32 = call %5 {target="x"}
  %23: s32 = const {value=20}
  %24: u32 = icmp_slt %23, %22
  cond_br %24, ^bb14(), ^bb9()
^bb9():
  %25: s32 = const {value=1}
  %60: s32 = call %25 {target="mark"}
  %26: s32 = call %5 {target="k"}
  br ^bb15()
^bb10():
  %27: s32 = const {value=1}
  %28: s32 = add %5, %27
  %29: s32 = call %28 {target="v"}
  %30: s32 = const {value=0}
  %31: u32 = icmp_eq %29, %30
  cond_br %31, ^bb11(), ^bb14()
^bb11():
  %32: s32 = const {value=5}
  %33: s32 = call %32 {target="k"}
  br ^bb15()
^bb12():
  %34: s32 = call %5 {target="x"}
  %35: s32 = const {value=0}
  %36: u32 = icmp_slt %34, %35
  cond_br %36, ^bb14(), ^bb13()
^bb13():
  %37: s32 = call %5 {target="a"}
  %38: s32 = call %37 {target="k"}
  br ^bb15()
^bb14():
  %39: s32 = const {value=1}
  %40: s32 = add %5, %39
  %41: u32 = icmp_sge %1, %40
  cond_br %41, ^bb1(%40), ^bb15()
^bb15():
  %42: s32 = const {value=0}
  %43: s32 = call %42 {target="out"}
  %44: u32 = icmp_sge %42, %43
  cond_br %44, ^bb18(), ^bb17(%42)
^bb17(%46: s32):
  %50: s32 = call %46 {target="k"}
  %51: s32 = const {value=1}
  %52: s32 = add %46, %51
  %53: s32 = const {value=3}
  %54: u32 = icmp_slt %52, %53
  cond_br %54, ^bb17(%52), ^bb18()
^bb18():
  ret
}`;

/** `switch (p) { case 0: for (j = 0; j < 3; j++) { a(j); if (q < j) { fin(j); goto out; } } g(m); break;
 *  case 1: d(m); } out: ${tail}` — mwcc's sw_xjret_end shape: the merge is the epilogue, reached
 *  from inside the loop in the arm through a block of its own. */
const loopInArm = (tail: 'return' | 'k(m); return') =>
  `fn sr {
^bb0(%p: s32, %q: s32):
  %z: s32 = const {value=0}
  %one: s32 = const {value=1}
  %lim: s32 = const {value=3}
  %m: s32 = sub %p, %z
  switch_br %m, ^bb2(%z), ^bb5(), ^bb7() {cases=[0;1]}
^bb2(%j: s32):
  %a: s32 = call %j {target="a"}
  %hit: u32 = icmp_slt %q, %j
  cond_br %hit, ^bb6(), ^bb3()
^bb6():
  %fin: s32 = call %j {target="fin"}
  br ^bb7()
^bb3():
  %j2: s32 = add %j, %one
  %c: u32 = icmp_slt %j2, %lim
  cond_br %c, ^bb2(%j2), ^bb4()
^bb4():
  %g: s32 = call %m {target="g"}
  br ^bb7()
^bb5():
  %d: s32 = call %m {target="d"}
  br ^bb7()
^bb7():
${tail === 'return' ? '  ret' : '  %k: s32 = call %m {target="k"}\n  ret'}
}`;

test("an arm of a nested switch reaches the outer switch's merge, its flag dropped where the arm leaves anyway", () => {
  // the flag's test after the inner switch is followed by the outer arm's own `break;`, so both of
  // its paths leave the outer switch and the inner `break;` alone reaches the merge
  // (ast-rewrites.ts `dropSpentFlagTests`)
  const { src, agreement, shipped } = judged(GOTOCASE_INNER);
  expect(src).toMatch(/mark\(1\);\n\s*k\(v\d+\);\n\s*break;\n\s*}\n\s*continue;\n\s*case 2:/);
  expect(src).not.toMatch(/ = 1;\n\s*break;/);
  expect(src).not.toMatch(/!= 0\) break;/);
  expect(src).not.toContain('goto');
  alike(agreement);
  alike(shipped);
  expect(ran(GOTOCASE_INNER, 'out')).toBeGreaterThan(SEEDS.length / 4);
});

test('a switch-merge flag whose test is followed by other code is kept, with its stores', () => {
  const flag = 'v9';
  const test = (): Stmt => ({
    k: 'if',
    cond: { k: 'bin', op: '!=', l: { k: 'var', name: flag }, r: { k: 'const', value: 0 } },
    then: [{ k: 'break', ofSwitch: true }],
    else: [],
  });
  const call = (target: string): Stmt => ({
    k: 'exprstmt',
    value: { k: 'call', fn: target, args: [] },
  });
  const inner: Stmt = {
    k: 'switch',
    scrutinee: { k: 'var', name: 'a0' },
    cases: [{ values: [0], body: [{ k: 'assign', name: flag, value: { k: 'const', value: 1 } }], fallsThrough: false }],
  };
  const outer = (after: Stmt[]): Stmt[] => [
    {
      k: 'switch',
      scrutinee: { k: 'var', name: 'a1' },
      cases: [
        {
          values: [0],
          body: [{ k: 'assign', name: flag, value: { k: 'const', value: 0 } }, inner, test(), ...after],
          fallsThrough: false,
        },
      ],
    },
  ];
  const kept = outer([call('z')]);
  expect(dropSpentFlagTests(kept, new Set([flag]))).toEqual(kept);
  // spent at the closed arm's end and before the same `break;` alike: test and stores go
  for (const after of [[], [{ k: 'break', ofSwitch: true } as Stmt]]) {
    const out = JSON.stringify(dropSpentFlagTests(outer(after), new Set([flag])));
    expect(out).not.toContain(flag);
  }
});

test('a merge that is a bare return is `return;` from a loop nested in the arm, with no flag', () => {
  const ir = loopInArm('return');
  const { src, agreement, shipped } = judged(ir);
  expect(src).toMatch(/fin\(v\d+\);\n\s*return;/);
  expect(src).not.toMatch(/= 1;\n\s*break;/);
  alike(agreement);
  alike(shipped);
  expect(ran(ir, 'g')).toBeGreaterThan(SEEDS.length / 40);
  expect(ran(ir, 'fin')).toBeGreaterThan(SEEDS.length / 40);
});

test('CONTROL: an exit from a loop nested in the arm to a merge that runs code declines', () => {
  const fn = parse(loopInArm('k(m); return'));
  verify(fn);
  recoverTypes(fn);
  expect(() => structure(fn, {})).toThrow(/from inside a nested loop/);
});

/** A generated mwcc_242_81 (-O4,p) function, `corpus/mwcc242-swmergerank.*`, its objdump text and
 *  `-s -r -t` dump: `for (i = 0; i < c; i++) { switch ((a + i) & 7) { case 1: k(1); switch (b & 7)
 *  { … goto out; … } k(10); continue; case 19: k(11); if (c & 1) { switch (gA[b & 15]) { case 10:
 *  k(12); return gOut; … case 73: k(15); goto shared; default: k(16); goto out; } k(17); } k(18);
 *  goto out; case 46: shared: … default: k(25); goto shared; … case 64: k(33); break; default:
 *  k(34); break; } k(77); out: k(100); } return gOut + i;`. The runs asking the case-exit flags
 *  alone lift it, through a later rung than one that met a nested-switch merge exit, and that lift
 *  stays the published one: asked in the same runs, the merge exit let the earlier rung lift it as
 *  `while (i < c) { switch (a + i & 7) …`. */
test('the merge exits are asked only once the runs asking the case-exit flags alone declined', () => {
  const corpus = (f: string) => readFileSync(new URL(`corpus/${f}`, import.meta.url), 'utf8');
  const dump = corpus('mwcc242-swmergerank.txt');
  const { source } = decompile('f', corpus('mwcc242-swmergerank.asm'), TOOLCHAIN_TARGETS.mwcc_242_81.description, {
    prototypes: { f: { params: 3 }, k: { params: 1, returnsVoid: true } },
    asmData: parseAsmData(dump, dump, dump, true),
  });
  expect(source).toMatch(/while \(1\) \{\n\s*if \(v0 >= a2\) return gOut \+ v0;/);
  expect(source).not.toContain('switch (a0 + ');
}, 60_000);
