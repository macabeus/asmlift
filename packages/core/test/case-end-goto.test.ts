// THE CASE-END GOTO (l3/ast.ts `caseEndGoto`): a jump from anywhere inside a switch arm,
// loops and ifs included, to a labelled `break;` that ends that same arm (`for (j…) { if (hit)
// goto L; } k(i); L: break;`). On hand-built trees: its contract (`caseGotoViolation`, which
// contracts.ts `assertCaseGotosNarrow` and the C-family printer both ask) and every other placement
// it refuses, how the C family prints it and that Pascal refuses it, how the effect contract and
// dead-store elimination read a path that takes it, and what `reachesEnd` and `caseEndGotoLeaves`
// answer for it. Then its producer, the `/case-end-goto` respell (l3/caseendgoto.ts
// `jumpToCaseEnds`) over the structurer's tree: a search loop's hit flag read where its target is
// the end of the switch arm the loop sits in, spelled as the goto, each judged against its own IR
// by the trace oracle (`irAgreement`); the hit whose target is a join running code, which keeps its
// flag; and, on hand-built trees, each rule of `CASE_END_GOTO_GATES` and two sites sharing a label.
// Last, the fan: `enumerateCandidates` over a benchmark object yields the `/case-end-goto` candidates,
// with every contract rank.ts holds a pre-respell tree to passing them.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { ContractError, assertCaseGotosNarrow, assertEffectsPreserved, assertNoOrphanedLocals } from '../src/contracts';
import { parseAsmData } from '../src/frontend/asmdata';
import { type Block, type Fn, mkOp, mkValue } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { type SFn, type Stmt, type SwitchCase, caseEndGotoLeaves, caseGotoViolation, reachesEnd } from '../src/l3/ast';
import { CASE_END_GOTO_GATES, jumpToCaseEnds } from '../src/l3/caseendgoto';
import { eliminateDeadStores } from '../src/l3/dce';
import { tallying, without } from '../src/l3/gates';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { PRE_RESPELL_VARIATIONS } from '../src/rank-variations';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '../src/target';
import { hasVariation } from '../src/variation-tokens';
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

/** an IR function making `calls` in a line, the effect contract's side of each tree below */
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
    asmLayout: undefined,
  };
};

describe('assertEffectsPreserved over a case-end goto', () => {
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
    // if (h) goto L2; } k(); for (j…) { if (h) goto L; } t(); L: break; L2: break;`, two sequential
    // hits that each took a label of their own), and an arm whose code before its end leaves by
    // `continue`
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

const lifted = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const off = structure(fn);
  const on = jumpToCaseEnds(off);
  const judged = (sfn: SFn) => ({
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  });
  return { off: judged(off), on: on && judged(on), offTree: off };
};

describe('the producer (l3/caseendgoto.ts over the structured tree)', () => {
  test.each([
    ['ends in the arm’s own `break;`', HIT_CODE_PAST_THE_LOOP],
    ['ends where the arm does', HIT_CODE_TO_ARM_END],
  ])('a hit whose target %s is spelled as a goto to that end, and agrees', (_, ir) => {
    const { off, on } = lifted(ir);
    expect(off.src).not.toMatch(/\bgoto\b/);
    expect(off.src).toMatch(/if \(v\d+ == 0\)/);
    expect(on).not.toBeNull();
    // the hit's code, then the jump; the loop's own exit runs `k(i)` into the labelled `break;`
    expect(on!.src).toMatch(/hit\(v\d+\);\n(?:\s*v\d+ = v\d+;\n)?\s*goto case_end;/);
    expect(on!.src).toMatch(/k\(v\d+\);\n(?:\s*v\d+ = v\d+;\n)*\s*case_end:\n\s*break;/);
    // no flag: nothing is compared with 0 after the search loop, and its declaration is gone
    expect(on!.src).not.toMatch(/if \(v\d+ == 0\)/);
    for (const r of [off.agreement, off.shipped, on!.agreement, on!.shipped]) {
      expect(r.disagree).toBe(0);
      expect(r.judged).toBe(SEEDS.length);
    }
  });

  test('a hit whose target is a join running code keeps its flag', () => {
    const census = tallying(CASE_END_GOTO_GATES);
    const { offTree } = lifted(HIT_CODE_TO_A_JOIN);
    expect(cBackend.emit(offTree)).toMatch(/post\(/);
    expect(jumpToCaseEnds(offTree, census.gates)).toBeNull();
    expect(census.refusals().map(([id]) => id)).toContain('target-not-arm-end');
  });

  test('without target-not-arm-end the join is skipped by the goto: the rule is load-bearing', () => {
    const { offTree } = lifted(HIT_CODE_TO_A_JOIN);
    const on = jumpToCaseEnds(offTree, without(CASE_END_GOTO_GATES, 'target-not-arm-end'));
    expect(on).not.toBeNull();
    expect(cBackend.emit(on!)).toMatch(/\bgoto case_end;/);
    expect(irAgreement(HIT_CODE_TO_A_JOIN, on!, SEEDS).disagree).toBeGreaterThan(0);
  });
});

// ── the respell over hand-built trees ─────────────────────────────────────────────────────────────

const assign = (name: string, value: number): Stmt => ({ k: 'assign', name, value: { k: 'const', value } });
const isZero = (name: string): Extract<Stmt, { k: 'if' }>['cond'] => ({
  k: 'bin',
  op: '==',
  l: v(name),
  r: { k: 'const', value: 0 },
});
/** `f = 0; while (1) { if (h) { s(); f = 1; break; } if (d) break; } if (f == 0) { …x }` */
const flagged = (f: string, x: Stmt[], hit: Stmt[] = [call('s'), assign(f, 1), { k: 'break' }]): Stmt[] => [
  assign(f, 0),
  search(hit),
  { k: 'if', cond: isZero(f), then: x, else: [] },
];

describe('jumpToCaseEnds', () => {
  test('two search loops in sequence into one case end share one label', () => {
    const tree = sfnWith(
      [sw([arm([1], [...flagged('f', [call('k'), ...flagged('g', [call('t')])]), brk]), arm([2], [call('u')])])],
      ['f', 'g'],
    );
    const on = jumpToCaseEnds(tree);
    expect(on).not.toBeNull();
    const src = cBackend.emit(on!);
    expect(src.match(/goto case_end;/g)).toHaveLength(2);
    expect(src.match(/case_end:/g)).toHaveLength(1);
    expect(src).toMatch(/t\(\);\n\s*case_end:\n\s*break;/);
    expect(on!.locals).toEqual([]);
    expect(caseGotoViolation(on!.body)).toBeNull();
    expect(() => assertEffectsPreserved(irCalling(['s', 'k', 't', 'u']), on!)).not.toThrow();
  });

  test('a site under an `if` whose falling off leaves the arm takes a label of its own', () => {
    const tree = sfnWith(
      [sw([arm([1], [{ k: 'if', cond: v('c'), then: flagged('f', [call('k')]), else: [] }])])],
      ['f'],
    );
    const on = jumpToCaseEnds(tree);
    expect(on).not.toBeNull();
    expect(cBackend.emit(on!)).toMatch(/k\(\);\n\s*case_end:\n\s*break;/);
    expect(caseGotoViolation(on!.body)).toBeNull();
  });

  test('a flag read outside a switch arm, or in a loop inside one, keeps its flag', () => {
    const census = tallying(CASE_END_GOTO_GATES);
    const outside = sfnWith([...flagged('f', [call('k')])], ['f']);
    expect(jumpToCaseEnds(outside, census.gates)).toBeNull();
    const inLoop = sfnWith(
      [sw([arm([1], [{ k: 'while', cond: v('c'), body: [...flagged('f', [call('k')]), { k: 'break' }] }, brk])])],
      ['f'],
    );
    expect(jumpToCaseEnds(inLoop, census.gates)).toBeNull();
    expect(census.refusals()).toEqual([['target-not-arm-end', 2]]);
    // without the rule the label lands where no `break;` leaves a switch arm
    const ablated = jumpToCaseEnds(inLoop, without(CASE_END_GOTO_GATES, 'target-not-arm-end'));
    expect(caseGotoViolation(ablated!.body)).not.toBeNull();
  });

  test('a flag read or written anywhere else keeps its flag', () => {
    const census = tallying(CASE_END_GOTO_GATES);
    const site = (x: Stmt[], hit?: Stmt[]) => sw([arm([1], [...flagged('f', x, hit), brk])]);
    // read again after the switch
    const readAfter = sfnWith([site([call('k')]), call('u', 'f')], ['f']);
    expect(jumpToCaseEnds(readAfter, census.gates)).toBeNull();
    // a hit that writes zero, which the test after the loop cannot tell from no hit
    const zeroHit = sfnWith([site([call('k')], [call('s'), assign('f', 0), { k: 'break' }])], ['f']);
    expect(jumpToCaseEnds(zeroHit, census.gates)).toBeNull();
    // a write in a loop nested in the search loop, whose `break` is that loop's
    const nested: Stmt = { k: 'while', cond: v('c'), body: [assign('f', 1), { k: 'break' }] };
    const deep = sfnWith([site([call('k')], [nested, { k: 'break' }])], ['f']);
    expect(jumpToCaseEnds(deep, census.gates)).toBeNull();
    // a parameter is not the flag's to drop
    const param = { ...sfnWith([sw([arm([1], [...flagged('x', [call('k')]), brk])])]) };
    expect(jumpToCaseEnds(param, census.gates)).toBeNull();
    expect(census.refusals()).toEqual([['flag-elsewhere', 4]]);
    // without the rule, the read after the switch names a local the rewrite no longer declares
    const ablated = jumpToCaseEnds(readAfter, without(CASE_END_GOTO_GATES, 'flag-elsewhere'));
    expect(() => assertNoOrphanedLocals(readAfter, ablated!)).toThrow(ContractError);
  });

  test('a tree with no flag read after its loop is declined', () => {
    expect(jumpToCaseEnds(sfnWith([narrow()]))).toBeNull();
  });
});

// ── the effect count over a pre-respell tree in the fan ───────────────────────────────────────────

describe('rank.ts runs the effect count over every pre-respell tree', () => {
  // rank-backend-decline.test.ts's `/unmerge` fixture, `if (c) { *A = 1; } else { *B = 2; } g();`
  // as agbcc cross-jumps it: a function the pre-respell loop reaches, with a call to count
  const asm = [
    'f:',
    '\tpush\t{lr}',
    '\tcmp\tr0, #0x0',
    '\tbeq\t.L2',
    '\tldr\tr1, .L8',
    '\tmov\tr2, #0x1',
    '\tb\t.L3',
    '.L2:',
    '\tldr\tr1, .L9',
    '\tmov\tr2, #0x2',
    '.L3:',
    '\tstr\tr2, [r1]',
    '\tbl\tg',
    '\tpop\t{r0}',
    '\tbx\tr0',
    '.L8:',
    '\t.word\t0x03001000',
    '.L9:',
    '\t.word\t0x03002000',
  ].join('\n');

  test('a pre-respell rewrite that runs a call twice on one path is dropped and reported', () => {
    expect(enumerateCandidates('f', asm, ARMV4T_AGBCC).some((c) => hasVariation(c.variations, 'unmerge'))).toBe(true);
    // every pre-respell entry's output with a second `g()` in front: what a rewrite that copies code
    // onto a path the asm runs it once on looks like to the count
    const saved = PRE_RESPELL_VARIATIONS.map((p) => p.apply);
    PRE_RESPELL_VARIATIONS.forEach((p, i) => {
      p.apply = (sfn: SFn) => {
        const made = saved[i](sfn);
        return made && { ...made, body: [call('g'), ...made.body] };
      };
    });
    const seen: string[] = [];
    try {
      const kept = enumerateCandidates('f', asm, ARMV4T_AGBCC, {
        onEnumerationError: (variations, error) => seen.push(`${variations.join('/')}: ${error}`),
      });
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.some((c) => hasVariation(c.variations, 'unmerge'))).toBe(false);
      expect(seen.some((s) => s.startsWith('unmerge: ') && /2 calls to 'g' on one path/.test(s))).toBe(true);
    } finally {
      PRE_RESPELL_VARIATIONS.forEach((p, i) => (p.apply = saved[i]));
    }
  });
});

// ── the variation in the fan ──────────────────────────────────────────────────────────────────────

describe('enumerateCandidates yields /case-end-goto', () => {
  // `synthetic:brk2sw_one` on gcc 2.7.2, as `pnpm bench target` builds it and the bench's own
  // `objdump -d --no-show-raw-insn` / `objdump -s -r -t` read it: `case 1: case 2: gA[i] = 1;
  // for (j = 0; j <= m; j++) { if (gE[j].f <= 24) { if (gE[j].x == i) goto next; } } k(i); next:
  // break;`, whose winner the variation is. Every contract the fan holds a pre-respell tree to
  // (rank.ts) runs on these: a wiring or contract change that drops each goto tree fails here, not
  // only in the bench.
  const corpus = (f: string) => readFileSync(new URL(`corpus/${f}`, import.meta.url), 'utf8');
  const dump = corpus('gcc272-brk2swone.txt');

  test("a search loop leaving for its arm's end comes out of the fan as the goto, with nothing thrown", () => {
    const threw: string[] = [];
    const cands = enumerateCandidates(
      'brk2sw_one',
      corpus('gcc272-brk2swone.asm'),
      TOOLCHAIN_TARGETS['gcc2.7.2'].description,
      {
        prototypes: { brk2sw_one: { returnsVoid: true }, k: { params: 1, returnsVoid: true } },
        asmData: parseAsmData(dump, dump, dump, true),
        onEnumerationError: (variations, error) => threw.push(`${variations.join('/')}: ${error}`),
      },
    );
    expect(threw).toEqual([]);
    const gotos = cands.filter((c) => hasVariation(c.variations, 'case-end-goto'));
    expect(gotos.length).toBeGreaterThan(0);
    for (const c of gotos) {
      expect(c.source).toMatch(/\bgoto case_end;/);
      expect(c.source).toMatch(/k\(a0\);\n\s*case_end:\n\s*break;/);
    }
    // the flag reading stays in the fan beside it, for the differ to referee
    expect(cands.some((c) => !hasVariation(c.variations, 'case-end-goto') && !/\bgoto\b/.test(c.source))).toBe(true);
  });
});
