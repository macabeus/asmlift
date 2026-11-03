// THE CASE-END GOTO (l3/ast.ts `caseEndGoto`): a jump from anywhere inside a switch arm,
// loops and ifs included, to a labelled `break;` that ends that same arm (`for (j…) { if (hit)
// goto L; } k(i); L: break;`). On hand-built trees: its contract (`caseGotoViolation`, which
// contracts.ts `assertCaseGotosNarrow` and the C-family printer both ask) and every other placement
// it refuses, how the C family prints it and that Pascal refuses it, how the effect contract and
// dead-store elimination read a path that takes it, and what `reachesEnd` and `caseEndGotoLeaves`
// answer for it. Then its producer (structure.ts `caseEndGoto`, `StructureOptions.jumpToCaseEnds`):
// a search loop's hit flag read where its target is the end of the switch arm the loop sits in,
// spelled as the goto, each judged against its own IR by the trace oracle (`irAgreement`); the
// witness the `/case-end-goto` variation is gated by; and the hit whose target is a join running
// code, which keeps its flag (`CASE_END_GOTO_GATES`).
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { ContractError, assertCaseGotosNarrow, assertEffectsPreserved } from '../src/contracts';
import { type Block, type Fn, mkOp, mkValue } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { type SFn, type Stmt, type SwitchCase, caseEndGotoLeaves, caseGotoViolation, reachesEnd } from '../src/l3/ast';
import { eliminateDeadStores } from '../src/l3/dce';
import { tallying, without } from '../src/l3/gates';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { CASE_END_GOTO_GATES, type StructureHooks, structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const call = (fn: string, ...args: string[]): Stmt => ({
  k: 'exprstmt',
  value: { k: 'call', fn, args: args.map((a) => ({ k: 'var', name: a })) },
});
const v = (name: string) => ({ k: 'var', name }) as const;
const sw = (cases: SwitchCase[], dflt?: Stmt[]): Stmt => ({
  k: 'switch',
  scrutinee: v('x'),
  cases,
  ...(dflt ? { default: dflt } : {}),
});
const arm = (values: number[], body: Stmt[], extra: Partial<SwitchCase> = {}): SwitchCase => ({
  values,
  body,
  fallsThrough: false,
  ...extra,
});
const sfnWith = (body: Stmt[], locals: string[] = []): SFn => ({
  name: 'F',
  params: [{ name: 'x', type: T.s(32) }],
  locals: locals.map((name) => ({ name, type: T.s(32) })),
  retType: T.void(),
  body,
});
const goto = (label = 'case_end'): Stmt => ({ k: 'caseEndGoto', label });
const end = (label = 'case_end'): Stmt => ({ k: 'break', ofSwitch: true, label });
const brk: Stmt = { k: 'break', ofSwitch: true };
const search = (hit: Stmt[]): Stmt => ({
  k: 'while',
  cond: { k: 'const', value: 1 },
  body: [
    { k: 'if', cond: v('h'), then: hit, else: [] },
    { k: 'if', cond: v('d'), then: [{ k: 'break' }], else: [] },
  ],
});

/** `case 1: if (c) { while (1) { if (h) { s(); goto L; } if (d) break; } k(); L: break; } t();
 *  break; case 2: g(); break;` — the hit leaves the loop past `k()`, to the `break;` ending the arm,
 *  which here sits under an `if` of the arm, as the structurer writes `sw_hitexit`'s case 1 */
const narrow = (hit: Stmt[] = [call('s'), goto()]): Stmt =>
  sw([
    arm([1], [{ k: 'if', cond: v('c'), then: [search(hit), call('k'), end()], else: [] }, call('t'), brk]),
    arm([2], [call('g')]),
  ]);

describe('caseGotoViolation — the case-end goto', () => {
  test('a jump out of a loop to a labelled `break;` later in a list enclosing it is legal', () => {
    expect(caseGotoViolation([narrow()])).toBeNull();
    expect(() => assertCaseGotosNarrow(sfnWith([narrow()]))).not.toThrow();
  });

  test('two gotos may name one end, from two loops', () => {
    const s = sw([arm([1], [search([goto()]), search([goto()]), call('k'), end()])]);
    expect(caseGotoViolation([s])).toBeNull();
  });

  test('a default arm may carry one too', () => {
    const s = sw([arm([1], [call('g')])], [search([goto()]), call('k'), end()]);
    expect(caseGotoViolation([s])).toBeNull();
  });

  test('a goto naming another arm’s end is refused', () => {
    const s = sw([arm([1], [search([goto()]), brk]), arm([2], [call('k'), end()])]);
    expect(caseGotoViolation([s])).toMatch(/names no labelled `break;` that ends the switch arm it sits in/);
    expect(() => assertCaseGotosNarrow(sfnWith([s]))).toThrow(ContractError);
  });

  test('a goto in a nested switch naming the outer arm’s end is refused', () => {
    const inner = sw([arm([9], [search([goto()])])]);
    const s = sw([arm([1], [inner, call('k'), end()])]);
    expect(caseGotoViolation([s])).toMatch(/names no labelled `break;`/);
  });

  test('a goto outside the switch, or after its label, is refused', () => {
    const outside = [search([goto()]), sw([arm([1], [call('k'), end()])])];
    expect(caseGotoViolation(outside)).toMatch(/names no labelled `break;`/);
    const after = sw([arm([1], [{ k: 'if', cond: v('c'), then: [end()], else: [] }, search([goto()]), brk])]);
    expect(caseGotoViolation([after])).toMatch(/names no labelled `break;`/);
  });

  test('a goto beside its label in one list, rather than inside a statement before it, is refused', () => {
    const s = sw([arm([1], [goto(), call('k'), end()])]);
    expect(caseGotoViolation([s])).toMatch(/names no labelled `break;`/);
  });

  test('a label inside a later sibling’s block is not one the goto may name', () => {
    const s = sw([arm([1], [search([goto()]), { k: 'if', cond: v('c'), then: [end()], else: [] }, brk])]);
    expect(caseGotoViolation([s])).toMatch(/names no labelled `break;`/);
  });

  test('a label on a loop’s `break`, on a `break` in a loop, or outside every arm is refused', () => {
    const loopBreak = sw([arm([1], [search([goto()]), { k: 'break', label: 'case_end' }])]);
    expect(caseGotoViolation([loopBreak])).toMatch(/is not on a `break;` that leaves a switch arm/);
    const inLoop = sw([arm([1], [{ k: 'while', cond: v('c'), body: [end()] }])]);
    expect(caseGotoViolation([inLoop])).toMatch(/is not on a `break;` that leaves a switch arm/);
    expect(caseGotoViolation([end()])).toMatch(/is not on a `break;` that leaves a switch arm/);
  });

  test('a label two arms carry, or one a case label also carries, is refused', () => {
    const two = sw([arm([1], [search([goto()]), end()]), arm([2], [search([goto()]), end()])]);
    expect(caseGotoViolation([two])).toMatch(/carried by two switch arms/);
    const shared = sw([arm([1], [search([goto()]), end()]), arm([2], [call('g')], { label: 'case_end' })]);
    expect(caseGotoViolation([shared])).toMatch(/carried by two switch arms/);
  });

  test('a case-label goto keeps its own form: a case-end flag does not license one under an `if`', () => {
    const s = sw([
      arm([1], [{ k: 'if', cond: v('c'), then: [{ k: 'goto', label: 'case_2' }], else: [] }]),
      arm([2], [call('g')], { label: 'case_2' }),
    ]);
    expect(caseGotoViolation([s])).toMatch(/not the last statement of a switch arm/);
  });
});

describe('the printers', () => {
  test('C prints the goto and the label on the `break;` that ends the arm', () => {
    const src = cBackend.emit(sfnWith([narrow()]));
    expect(src).toMatch(/s\(\);\n\s*goto case_end;\n/);
    expect(src).toMatch(/k\(\);\n\s*case_end:\n\s*break;\n/);
  });

  test('C refuses to print a case-end goto outside its form', () => {
    const s = sw([arm([1], [search([goto()]), brk]), arm([2], [call('k'), end()])]);
    expect(() => cBackend.emit(sfnWith([s]))).toThrow(/c backend: .*names no labelled `break;`/);
  });

  test('Pascal declines it loud', () => {
    expect(() => pascalBackend.emit(sfnWith([narrow()]))).toThrow(/goto.*end of a case arm.*no IDO Pascal spelling/);
  });
});

describe('the readers', () => {
  test('`reachesEnd` reads the goto as leaving the switch, as its labelled `break;` does', () => {
    // a switch whose every arm ends by a case-end goto still reaches its own end
    const only = sw([arm([1], [{ k: 'if', cond: v('c'), then: [goto()], else: [goto()] }, end()])], [{ k: 'return' }]);
    expect(reachesEnd([only])).toBe(true);
    expect(reachesEnd([goto()])).toBe(false);
  });

  test('`caseEndGotoLeaves` answers whether a list jumps to an end it does not hold', () => {
    expect(caseEndGotoLeaves([search([goto()])])).toBe(true);
    expect(caseEndGotoLeaves([narrow()])).toBe(false);
    expect(caseEndGotoLeaves([search([call('s')])])).toBe(false);
  });

  test('dead-store elimination keeps a value the goto carries to the arm’s end', () => {
    // `r` is written in the loop and read after the switch; only the goto's path carries it there
    // past `r = 0;`, and a later iteration may be the one that takes the goto
    const loop: Stmt = {
      k: 'while',
      cond: { k: 'const', value: 1 },
      body: [
        { k: 'if', cond: v('h'), then: [goto()], else: [] },
        { k: 'assign', name: 'r', value: { k: 'call', fn: 'p', args: [] } },
        { k: 'if', cond: v('d'), then: [{ k: 'break' }], else: [] },
      ],
    };
    const body: Stmt[] = [
      sw([arm([1], [loop, { k: 'assign', name: 'r', value: { k: 'const', value: 0 } }, end()])]),
      call('u', 'r'),
    ];
    const out = eliminateDeadStores(sfnWith(body, ['r']));
    expect(cBackend.emit(out)).toMatch(/v?r = p\(\);/);
  });
});

describe('assertEffectsPreserved over a case-end goto', () => {
  const irCalling = (calls: string[]): Fn => {
    const entry: Block = {
      params: [],
      ops: [...calls.map((t) => mkOp('call', { results: [mkValue(T.s(32))], attrs: { target: t } })), mkOp('ret', {})],
    };
    return {
      name: 'F',
      blocks: [entry],
      writeOrder: undefined,
      slotHomes: undefined,
      paramEvidence: undefined,
      localObjects: undefined,
    };
  };

  test('the goto skips the code between the loop and the end: `s` and `k` are never on one path', () => {
    // with the goto read as falling out of the loop, `s(); … k();` would count `k` after `s` — fine —
    // but a third call on both paths must count once
    const s = sw([arm([1], [search([call('k'), goto()]), call('k'), end()])]);
    expect(() => assertEffectsPreserved(irCalling(['k']), sfnWith([s]))).not.toThrow();
  });

  test('a call after the switch counts on the goto’s path', () => {
    const s = sw([arm([1], [search([call('k'), goto()]), end()])]);
    expect(() => assertEffectsPreserved(irCalling(['k']), sfnWith([s, call('k')]))).toThrow(
      /emitted 2 calls to 'k' on one path/,
    );
  });

  test('a labelled `break;` that only a goto reaches is reached, beside another or after a `continue`', () => {
    // two search loops into one case end, the second's label right after the first's (`for (j…) {
    // if (h) goto L2; } k(); for (j…) { if (h) goto L; } t(); L: break; L2: break;`, as the
    // structurer once spelled two sequential hits), and an arm whose code before its end leaves
    // by `continue`
    const twoEnds = sw([
      arm([1], [search([goto('case_end_2')]), call('k'), search([goto()]), call('t'), end(), end('case_end_2')]),
    ]);
    expect(caseGotoViolation([twoEnds])).toBeNull();
    expect(() => assertEffectsPreserved(irCalling(['k', 't']), sfnWith([twoEnds]))).not.toThrow();
    const loop: Stmt = {
      k: 'while',
      cond: v('c'),
      body: [sw([arm([1], [search([goto()]), { k: 'continue' }, end()])])],
    };
    expect(() => assertEffectsPreserved(irCalling([]), sfnWith([loop]))).not.toThrow();
    // code after a `break;`, labelled or not, is still unreached
    const dead = sw([arm([1], [search([goto()]), brk, end(), call('k')])]);
    expect(() => assertEffectsPreserved(irCalling(['k']), sfnWith([dead]))).toThrow(/no path reaches/);
  });
});

// ── the producer ──────────────────────────────────────────────────────────────────────────────────

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

/** two-level-exit.test.ts's fixture of the same name: `case 0: case 1: case 4: for (j…) { if
 *  (probe(j, i) == x) { hit(j); goto out; } } k(i); out: break;`, the arm's end the outer loop's
 *  latch (`synthetic:sw_hitexit_in`'s source shape) */
const HIT_CODE_TO_ARM_END = `fn hitcodearm {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7()
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb2(), ^bb2(), ^bb8(), ^bb2(), ^bb6() {cases=[0;1;2;4]}
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb9():
  %19: s32 = call %10 {target="hit"}
  br ^bb6()
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb6()
^bb8():
  %17: s32 = call %5 {target="h"}
  br ^bb6()
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7()
^bb7():
  ret
}`;

/** two-level-exit.test.ts's fixture of the same name: the same hit where the arm's merge is also
 *  the outer loop's exit, and the arm ends in an explicit `break;` (`synthetic:sw_hitexit`'s shape) */
const HIT_CODE_PAST_THE_LOOP = `fn hitcodepast {
^bb0(%0: s32, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  %30: s32 = const {value=1}
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb1(%3), ^bb7(%3, %30)
^bb1(%5: s32):
  %6: s32 = call %5 {target="mark"}
  %7: s32 = const {value=1}
  switch_br %5, ^bb12(), ^bb12(), ^bb8(), ^bb12(), ^bb6() {cases=[0;1;2;4]}
^bb12():
  %31: s32 = call %5 {target="skip"}
  %32: u32 = icmp_eq %31, %3
  cond_br %32, ^bb6(), ^bb2()
^bb2():
  %9: u32 = icmp_slt %1, %3
  cond_br %9, ^bb5(), ^bb3(%3)
^bb3(%10: s32):
  %11: s32 = call %10, %5 {target="probe"}
  %12: u32 = icmp_eq %11, %2
  cond_br %12, ^bb9(), ^bb4()
^bb9():
  %19: s32 = call %10 {target="hit"}
  br ^bb7(%7, %3)
^bb4():
  %13: s32 = add %10, %7
  %14: u32 = icmp_slt %1, %13
  cond_br %14, ^bb5(), ^bb3(%13)
^bb5():
  %15: s32 = call %5 {target="k"}
  br ^bb7(%3, %7)
^bb8():
  %17: s32 = call %5 {target="h"}
  %33: u32 = icmp_eq %17, %3
  cond_br %33, ^bb6(), ^bb7(%3, %7)
^bb6():
  %8: s32 = add %5, %7
  %16: u32 = icmp_slt %8, %0
  cond_br %16, ^bb1(%8), ^bb7(%3, %30)
^bb7(%20: s32, %21: s32):
  %22: s32 = call %20 {target="t"}
  %23: s32 = call %21 {target="t"}
  %24: u32 = icmp_slt %3, %1
  cond_br %24, ^bb10(%3), ^bb11()
^bb10(%25: s32):
  %26: s32 = call %25 {target="t"}
  %27: s32 = add %25, %30
  %28: u32 = icmp_slt %27, %1
  cond_br %28, ^bb10(%27), ^bb11()
^bb11():
  ret
}`;

/** `HIT_CODE_TO_ARM_END` with a join between the hit and the arm's end that runs `post(i)`: the hit's
 *  target is that join, which a `break;` does not reach */
const HIT_CODE_TO_A_JOIN = HIT_CODE_TO_ARM_END.replace('fn hitcodearm', 'fn hitcodejoin')
  .replace(/(%19: s32 = call %10 \{target="hit"\}\n  br )\^bb6\(\)/, '$1^bb10()')
  .replace(/(%15: s32 = call %5 \{target="k"\}\n  br )\^bb6\(\)/, '$1^bb10()')
  .replace('^bb6():', '^bb10():\n  %40: s32 = call %5 {target="post"}\n  br ^bb6()\n^bb6():');

const lifted = (ir: string, opts: Parameters<typeof structure>[1] = {}, hooks: StructureHooks = {}) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, opts, hooks);
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

describe('the producer', () => {
  test.each([
    ['ends in the arm’s own `break;`', HIT_CODE_PAST_THE_LOOP],
    ['ends where the arm does', HIT_CODE_TO_ARM_END],
  ])('a hit whose target %s is spelled as a goto to that end, and agrees', (_, ir) => {
    let read = 0;
    const off = lifted(ir, {}, { onCaseEndRead: () => read++ });
    expect(read).toBe(1);
    expect(off.src).not.toMatch(/\bgoto\b/);
    const on = lifted(ir, { jumpToCaseEnds: true });
    // the hit's code, then the jump; the loop's own exit runs `k(i)` into the labelled `break;`
    expect(on.src).toMatch(/hit\(v\d+\);\n(?:\s*v\d+ = v\d+;\n)?\s*goto case_end;/);
    expect(on.src).toMatch(/k\(v\d+\);\n(?:\s*v\d+ = v\d+;\n)*\s*case_end:\n\s*break;/);
    // no flag: nothing is compared with 0 after the search loop
    expect(on.src).not.toMatch(/if \(v\d+ == 0\)/);
    for (const r of [off.agreement, off.shipped, on.agreement, on.shipped]) {
      expect(r.disagree).toBe(0);
      expect(r.judged).toBe(SEEDS.length);
    }
  });

  test('a hit whose target is a join running code keeps its flag, and the rule that keeps it is named', () => {
    let read = 0;
    const census = tallying(CASE_END_GOTO_GATES);
    const on = lifted(
      HIT_CODE_TO_A_JOIN,
      { jumpToCaseEnds: true },
      { caseEndGotoGates: census.gates, onCaseEndRead: () => read++ },
    );
    expect(on.src).toMatch(/post\(/);
    expect(on.src).not.toMatch(/\bgoto\b/);
    expect(read).toBe(0);
    expect(census.refusals().map(([id]) => id)).toContain('target-not-arm-end');
    expect(on.agreement.disagree).toBe(0);
    expect(on.shipped.disagree).toBe(0);
  });

  test('without target-not-arm-end the join is skipped by the goto: the rule is load-bearing', () => {
    const on = lifted(
      HIT_CODE_TO_A_JOIN,
      { jumpToCaseEnds: true },
      { caseEndGotoGates: without(CASE_END_GOTO_GATES, 'target-not-arm-end') },
    );
    expect(on.src).toMatch(/\bgoto case_end;/);
    expect(on.agreement.disagree).toBeGreaterThan(0);
  });
});
