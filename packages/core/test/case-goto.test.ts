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
import { type SFn, type Stmt, type SwitchCase, caseGotoViolation, reachesEnd } from '../src/l3/ast';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { compareScored, gotoCount } from '../src/rank';
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

  test('CONTROL: a shared case the dispatch hands a value declines — the jump would re-run that copy', () => {
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

// Case 0's nested switch sends its case 1 into case 2's body, which runs on into case 3: the
// nested structuring writes that body into its own arm and leaves with `break;`, so the arm the
// outer reading spells as a jump to `case_2` already ends — and the jump after that `break;` is one
// no path takes. Case 5 is the entrant that does need it.
const nestedEntrant = `fn gn {
^bb0(%0: s32, %1: s32):
  switch_br %0, ^bb10(), ^bb1(), ^bbL(), ^bb3(), ^bb2(), ^bb7() {cases=[0;1;2;3;5]}
^bb10():
  %r0: s32 = call %0 {target="a"}
  switch_br %1, ^bb11(), ^bb12(), ^bb13() {cases=[0;1]}
^bb11():
  %r11: s32 = call %0 {target="p"}
  br ^bb14()
^bb12():
  %r12: s32 = call %0 {target="q"}
  br ^bbL()
^bb13():
  %r13: s32 = call %0 {target="r"}
  br ^bb14()
^bb14():
  %r14: s32 = call %0 {target="w"}
  br ^bb7()
^bb1():
  %r1: s32 = call %0 {target="b"}
  %z1: s32 = const {value=0}
  %c1: u32 = icmp_slt %1, %z1
  cond_br %c1, ^bb7(), ^bbL()
^bb2():
  %r2: s32 = call %0 {target="c"}
  br ^bbL()
^bbL():
  %rL: s32 = call %0 {target="s"}
  br ^bb3()
^bb3():
  %r3: s32 = call %0 {target="t"}
  br ^bb7()
^bb7():
  ret
}`;

describe('a jump no path reaches is not written', () => {
  test('an entrant whose own structuring already ends gets no `goto`; the one that runs on does', () => {
    const { src, agreement, shipped } = lifted(nestedEntrant);
    expect(src).not.toMatch(/break;\n\s*goto/);
    expect(src.match(/goto case_2;/g)?.length).toBe(1);
    expect(src).toMatch(/case 5:\n\s*c\(a0\);\n\s*goto case_2;/);
    judgedAlike(agreement);
    judgedAlike(shipped);
  });

  test('reachesEnd: left by every path only where each one provably leaves', () => {
    const brk: Stmt = { k: 'break', ofSwitch: true };
    expect(reachesEnd([call('f')])).toBe(true);
    expect(reachesEnd([call('f'), brk])).toBe(false);
    expect(reachesEnd([{ k: 'if', cond: v('c'), then: [brk], else: [] }])).toBe(true);
    expect(reachesEnd([{ k: 'if', cond: v('c'), then: [brk], else: [{ k: 'return' }] }])).toBe(false);
    // a nested switch ends where an arm breaks out of it, runs off its end, or no `default` exists
    expect(reachesEnd([sw([arm([1], [{ k: 'return' }])])])).toBe(true);
    expect(reachesEnd([sw([arm([1], [{ k: 'return' }])], [{ k: 'return' }])])).toBe(false);
    expect(reachesEnd([sw([arm([1], [call('f'), brk])], [{ k: 'return' }])])).toBe(true);
    expect(reachesEnd([sw([arm([1], [call('f')])], [{ k: 'return' }])])).toBe(true);
    // …but not where that arm falls or jumps on into one that leaves
    expect(reachesEnd([sw([arm([1], [call('f')], { fallsThrough: true })], [{ k: 'return' }])])).toBe(false);
    // a loop is read as reaching its end, the side a caller appending a jump can afford
    expect(reachesEnd([{ k: 'while', cond: { k: 'const', value: 1 }, body: [{ k: 'return' }] }])).toBe(true);
  });
});

// `/case-goto` (rank-variations.ts, `jumpToSharedCases`): where the copies fire — case 3 closed, so
// its body can be copied — the default copies it into case 1 and the option spells case 1's entry as
// the jump instead; the OFF structuring reports that it copied a case arm (`onCaseCopied`).
const closedShared = twoIntoOne().replace(
  '  %3: s32 = call %0 {target="s"}\n  br ^bb4()',
  '  %3: s32 = call %0 {target="s"}\n  br ^bb6()',
);

const withOption = (ir: string, jumpToSharedCases: boolean) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  let copied = 0;
  const sfn = structure(fn, { jumpToSharedCases }, { onCaseCopied: () => copied++ });
  return {
    src: cBackend.emit(sfn),
    copied,
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

describe('/case-goto', () => {
  test('spells the entrant the default gives a copy as a jump, and the OFF structuring witnesses it', () => {
    const off = withOption(closedShared, false);
    expect(off.src).not.toContain('goto');
    expect(off.src.match(/s\(a0\);/g)?.length).toBe(2);
    expect(off.copied).toBeGreaterThan(0);
    const on = withOption(closedShared, true);
    expect(on.src).toContain('goto case_3;');
    expect(on.src.match(/s\(a0\);/g)?.length).toBe(1);
    for (const r of [off, on]) {
      judgedAlike(r.agreement);
      judgedAlike(r.shipped);
    }
  });

  test('is not witnessed where no case arm is copied, and builds the same tree there', () => {
    // a plain table: every arm breaks to the code after it
    const plain = closedShared
      .replace('cond_br %c1, ^bb6(), ^bb3()', 'cond_br %c1, ^bb6(), ^bb6()')
      .replace('cond_br %c2, ^bb6(), ^bb3()', 'cond_br %c2, ^bb6(), ^bb6()');
    const off = withOption(plain, false);
    expect(off.copied).toBe(0);
    expect(withOption(plain, true).src).toBe(off.src);
    // the two-into-one shape the copies refuse: the default already jumps, and nothing was copied
    const falling = withOption(twoIntoOne(), false);
    expect(falling.copied).toBe(0);
    expect(withOption(twoIntoOne(), true).src).toBe(falling.src);
  });
});

describe('the ranking tie-break', () => {
  test('of two candidates that score alike, the one without a goto wins', () => {
    const base = { score: { score: 0 }, preference: 0, variations: [] };
    const withGoto = { ...base, order: 0, source: 'case 1: goto case_3;\ncase 3: case_3: f();' };
    const copies = { ...base, order: 1, source: 'case 1: f();\nbreak;\ncase 3: f();\nbreak;' };
    expect(gotoCount(withGoto.source)).toBe(1);
    expect(gotoCount(copies.source)).toBe(0);
    type C = Parameters<typeof compareScored>[0];
    expect(compareScored(withGoto as unknown as C, copies as unknown as C)).toBeGreaterThan(0);
  });
});
