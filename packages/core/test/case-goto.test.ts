// THE CASE-LABEL GOTO (l3/ast.ts `goto`): the one goto L3 holds, a jump from the end of a switch arm to
// a case label of THAT switch. The first half pins its contract (`caseGotoViolation`, which
// contracts.ts `assertCaseGotosNarrow` and the C-family printer both ask), how the C family prints it
// and that Pascal refuses it, and how the effect contract counts a path that takes it, on hand-built
// trees. The second half is its producer (switch-recover.ts `jumpSharedFallTargets`, structure.ts THE
// JUMPS): jump tables where two arms enter one case's body and the copies refuse, each judged
// against its own IR by the trace oracle (`irAgreement`), and the shapes that must stay declined.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { ContractError, assertCaseGotosNarrow, assertEffectsPreserved } from '../src/contracts';
import { type Block, type Fn, mkOp, mkValue } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import { verify } from '../src/ir/verify';
import { type SFn, type Stmt, type SwitchCase, caseGotoViolation } from '../src/l3/ast';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement } from './helpers';

const call = (fn: string): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn, args: [] } });
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
const sfnWith = (body: Stmt[]): SFn => ({
  name: 'F',
  params: [{ name: 'x', type: T.s(32) }],
  locals: [],
  retType: T.void(),
  body,
});

/** `case 1: f(); goto L; case 2: g(); case 3: L: h(); break;` — case 2 falls, case 1 jumps */
const narrow = (): Stmt =>
  sw([
    arm([1], [call('f'), { k: 'goto', label: 'case_3' }]),
    arm([2], [call('g')], { fallsThrough: true }),
    arm([3], [call('h')], { label: 'case_3' }),
  ]);

describe('caseGotoViolation — the one form a goto may take', () => {
  test('the last statement of an arm, naming a case of that switch, is legal', () => {
    expect(caseGotoViolation([narrow()])).toBeNull();
    expect(() => assertCaseGotosNarrow(sfnWith([narrow()]))).not.toThrow();
  });

  test('a default arm may end in one too', () => {
    const s = sw([arm([3], [call('h')], { label: 'L3' })], [call('d'), { k: 'goto', label: 'L3' }]);
    expect(caseGotoViolation([s])).toBeNull();
  });

  test('a goto from a NESTED switch to an outer switch case is refused', () => {
    const inner = sw([arm([9], [{ k: 'goto', label: 'L3' }])]);
    const outer = sw([arm([1], [inner]), arm([3], [call('h')], { label: 'L3' })]);
    expect(caseGotoViolation([outer])).toMatch(/names no case label of the switch it sits in/);
    expect(() => assertCaseGotosNarrow(sfnWith([outer]))).toThrow(ContractError);
  });

  test('a goto into a case of an INNER switch is refused', () => {
    const inner = sw([arm([3], [call('h')], { label: 'L3' })]);
    const outer = sw([arm([1], [{ k: 'goto', label: 'L3' }]), arm([2], [inner])]);
    expect(caseGotoViolation([outer])).toMatch(/names no case label/);
  });

  test('a goto under an `if`, in a loop, outside a switch or before another statement is refused', () => {
    const lab = arm([3], [call('h')], { label: 'L3' });
    const g: Stmt = { k: 'goto', label: 'L3' };
    const underIf = sw([arm([1], [{ k: 'if', cond: v('x'), then: [g], else: [] }]), lab]);
    const inLoop = sw([arm([1], [{ k: 'while', cond: v('x'), body: [g] }]), lab]);
    const notLast = sw([arm([1], [g, call('f')]), lab]);
    for (const s of [underIf, inLoop, notLast]) {
      expect(caseGotoViolation([s])).toMatch(/not the last statement of a switch arm/);
    }
    expect(caseGotoViolation([g])).toMatch(/not the last statement/);
  });

  test('a label two arms carry is refused, in one switch or across two', () => {
    const one = sw([arm([1], [call('f')], { label: 'L' }), arm([2], [call('g')], { label: 'L' })]);
    expect(caseGotoViolation([one])).toMatch(/carried by two switch arms/);
    const two = [sw([arm([1], [call('f')], { label: 'L' })]), sw([arm([2], [call('g')], { label: 'L' })])];
    expect(caseGotoViolation(two)).toMatch(/carried by two switch arms/);
  });
});

describe('the printers', () => {
  test('C prints `goto L;` and the label after the target arm’s case labels, with no dead break', () => {
    const src = cBackend.emit(sfnWith([narrow()]));
    expect(src).toContain('goto case_3;');
    expect(src).toMatch(/case 3:\n\s*case_3:\n\s*h\(\);\n\s*break;/);
    expect(src).not.toMatch(/goto case_3;\n\s*break;/);
  });

  test('C refuses to print a goto outside the narrow form', () => {
    const inner = sw([arm([9], [{ k: 'goto', label: 'L3' }])]);
    const outer = sw([arm([1], [inner]), arm([3], [call('h')], { label: 'L3' })]);
    expect(() => cBackend.emit(sfnWith([outer]))).toThrow(/c backend: .*names no case label/);
  });

  test('Pascal declines it loud', () => {
    const s = sw([arm([1], [call('f'), { k: 'goto', label: 'L3' }]), arm([3], [call('h')], { label: 'L3' })]);
    expect(() => pascalBackend.emit(sfnWith([s]))).toThrow(/goto.*no IDO Pascal spelling/);
  });
});

describe('assertEffectsPreserved over a goto', () => {
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

  test('a path through the goto runs the target arm once', () => {
    expect(() => assertEffectsPreserved(irCalling(['f', 'g', 'h']), sfnWith([narrow()]))).not.toThrow();
  });

  test('a call the jumping arm and the target arm both run is two on that path', () => {
    const s = sw([arm([1], [call('h'), { k: 'goto', label: 'L3' }]), arm([3], [call('h')], { label: 'L3' })]);
    expect(() => assertEffectsPreserved(irCalling(['h']), sfnWith([s]))).toThrow(/emitted 2 calls to 'h' on one path/);
  });
});

// ── the producer ──────────────────────────────────────────────────────────────────────────────────

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

/** Cases 1 and 2 each call, then `break` on a test of the second parameter or else run on into case 3's body, which itself
 *  falls into case 4: `case 3: s(); case 4: t(); break;`. The copies refuse a sibling that falls on,
 *  so only the jump spells the two entrants. `into3` is the block both enter; `case3Edge` the
 *  dispatch's own edge into it. */
const twoIntoOne = ({ into3 = '^bb3()', into3b = '^bb3()', bb3 = '^bb3():', case3Edge = '^bb3()' } = {}) => `fn gj {
^bb0(%0: s32, %1: s32):
  %9: s32 = const {value=7}
  switch_br %0, ^bb1(), ^bb2(), ${case3Edge}, ^bb4(), ^bb5() {cases=[1;2;3;4]}
^bb1():
  %r1: s32 = call %0 {target="a"}
  %z1: s32 = const {value=0}
  %c1: u32 = icmp_slt %1, %z1
  cond_br %c1, ^bb6(), ${into3}
^bb2():
  %r2: s32 = call %0 {target="b"}
  %z2: s32 = const {value=2}
  %c2: u32 = icmp_slt %1, %z2
  cond_br %c2, ^bb6(), ${into3b}
${bb3}
  %3: s32 = call %0 {target="s"}
  br ^bb4()
^bb4():
  %4: s32 = call %0 {target="t"}
  br ^bb6()
^bb5():
  %5: s32 = call %0 {target="d"}
  br ^bb6()
^bb6():
  ret
}`;

/** No seed the oracle could run disagrees, and it could run most of them (a seed whose IR trace
 *  reads an undefined value is skipped on both sides). */
const judgedAlike = (r: { judged: number; disagree: number }): void => {
  expect(r.disagree).toBe(0);
  expect(r.judged).toBeGreaterThan(SEEDS.length / 2);
};

const lifted = (ir: string, opts: Parameters<typeof structure>[1] = {}) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, opts);
  const shipped = readabilityRewrites(sfn);
  return {
    src: cBackend.emit(shipped),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, shipped, SEEDS),
  };
};

describe('two arms entering one case: one falls, the other jumps', () => {
  test('the arm above the shared case falls, the other ends `goto`, and the program is the IR', () => {
    const { src, agreement, shipped } = lifted(twoIntoOne());
    expect(src).toMatch(/case 1:\n\s*a\(a0\);\n\s*if \(a1 < 0\) break;\n\s*goto case_3;\n\s*case 2:/);
    expect(src).toMatch(
      /case 2:\n\s*b\(a0\);\n\s*if \(a1 < 2\) break;\n\s*case 3:\n\s*case_3:\n\s*s\(a0\);\n\s*case 4:/,
    );
    judgedAlike(agreement);
    judgedAlike(shipped);
  });

  test('the oracle sees the jump: the label moved one arm down disagrees', () => {
    const fn = parse(twoIntoOne());
    verify(fn);
    recoverTypes(fn);
    const sfn = structure(fn, {});
    const sw = sfn.body.find((x) => x.k === 'switch');
    expect(sw?.k).toBe('switch');
    const cases = (sw as Extract<Stmt, { k: 'switch' }>).cases;
    const label = cases[2].label;
    expect(label).toBe('case_3');
    cases[3].label = label;
    delete cases[2].label;
    expect(irAgreement(twoIntoOne(), sfn, SEEDS).disagree).toBeGreaterThan(0);
  });

  test('under `/tail-copies` every entrant jumps, the same program', () => {
    const { src, agreement, shipped } = lifted(twoIntoOne(), { copyEveryTailEntrant: true });
    expect(src.match(/goto case_3;/g)?.length).toBe(2);
    judgedAlike(agreement);
    judgedAlike(shipped);
  });

  test('CONTROL: a shared case the dispatch hands a value declines — the jump would skip that copy', () => {
    const ir = twoIntoOne({
      into3: '^bb3(%r1)',
      into3b: '^bb3(%r2)',
      bb3: '^bb3(%p: s32):\n  %q: s32 = call %p {target="k"}',
      case3Edge: '^bb3(%9)',
    });
    expect(() => lifted(ir)).toThrow(/case arms do not linearize/);
  });

  test('CONTROL: a target language with no fall-through gets no jump, and declines as it did', () => {
    const fn = parse(twoIntoOne());
    verify(fn);
    recoverTypes(fn);
    expect(() => structure(fn, { spellSwitchFallthrough: false })).toThrow(/no fall-through in its case statement/);
  });
});
