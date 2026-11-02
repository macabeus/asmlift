// THE CASE-END GOTO (l3/ast.ts `goto` with `caseEnd`): a jump from anywhere inside a switch arm,
// loops and ifs included, to a labelled `break;` that ends that same arm (`for (j…) { if (hit)
// goto L; } k(i); L: break;`). On hand-built trees: its contract (`caseGotoViolation`, which
// contracts.ts `assertCaseGotosNarrow` and the C-family printer both ask) and every other placement
// it refuses, how the C family prints it and that Pascal refuses it, how the effect contract and
// dead-store elimination read a path that takes it, and what `reachesEnd` and `caseEndGotoLeaves`
// answer for it.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { ContractError, assertCaseGotosNarrow, assertEffectsPreserved } from '../src/contracts';
import { type Block, type Fn, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { type SFn, type Stmt, type SwitchCase, caseEndGotoLeaves, caseGotoViolation, reachesEnd } from '../src/l3/ast';
import { eliminateDeadStores } from '../src/l3/dce';

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
const goto = (label = 'case_end'): Stmt => ({ k: 'goto', label, caseEnd: true });
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
});
