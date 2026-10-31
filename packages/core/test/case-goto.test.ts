// THE CASE-LABEL GOTO (l3/ast.ts `goto`): the one goto L3 holds, a jump from the end of a switch arm to
// a case label of THAT switch. These pin its contract (`caseGotoViolation`, which contracts.ts
// `assertCaseGotosNarrow` and the C-family printer both ask), how the C family prints it and that
// Pascal refuses it, and how the effect contract counts a path that takes it. Hand-built trees: the
// point is the rule itself, whatever the structurer produces.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { ContractError, assertCaseGotosNarrow, assertEffectsPreserved } from '../src/contracts';
import { type Block, type Fn, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { type SFn, type Stmt, type SwitchCase, caseGotoViolation } from '../src/l3/ast';

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
