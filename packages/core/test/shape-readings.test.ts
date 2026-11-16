// The shape readings: respell variations that print a tree a reader would write, each one program
// with the tree as recovered, and each a different tree to some compiler (the modules carry the
// compiled pairs). Each fires where its shape is, declines everywhere else, and never changes what
// the function does.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { compoundExpressionAssignments } from '../src/l3/compoundexpr';
import { readDoWhileAsFor } from '../src/l3/forread';
import { splitReturnedMerges } from '../src/l3/retsplit';
import { breakFinalSwitchReturns } from '../src/l3/switchbreak';
import { enumerateCandidates } from '../src/rank';
import { shapeHabitCount } from '../src/shape-habits';
import { recognizeForLoops } from '../src/structure/ast-rewrites';
import { ARMV4T_AGBCC } from '../src/target';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const bin = (op: '+' | '-' | '*' | '<' | '<=' | '!=' | '==', l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const call = (fn: string, ...args: Expr[]): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn, args } });
const set = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const ret = (value?: Expr): Stmt => (value === undefined ? { k: 'return' } : { k: 'return', value });
const s32 = T.int(32, true);

const fnOf = (body: Stmt[], opts: { retType?: SFn['retType']; locals?: SFn['locals'] } = {}): SFn => ({
  name: 'f',
  params: [
    { name: 'a0', type: s32 },
    { name: 'a1', type: s32 },
  ],
  locals: opts.locals ?? [{ name: 'v0', type: s32 }],
  retType: opts.retType ?? s32,
  body,
});

const print = (fn: SFn | null): string | null => (fn === null ? null : cBackend.emit(fn));

describe('/ret-split: return from each arm', () => {
  const merged = (then: Stmt[], els: Stmt[]): SFn =>
    fnOf([{ k: 'if', cond: bin('!=', v('a1'), c(0)), then, else: els }, ret(v('v0'))]);

  test('both arms set the returned local: each returns, the else follows the if, the local goes', () => {
    const out = print(splitReturnedMerges(merged([set('v0', bin('+', v('a0'), c(1)))], [set('v0', c(0))])));
    expect(out).toBe('s32 f(s32 a0, s32 a1) {\n    if (a1 != 0) return a0 + 1;\n    return 0;\n}\n');
  });

  test('a nested two-armed if and an arm that already returns count as ending the arm', () => {
    const inner: Stmt = { k: 'if', cond: v('a0'), then: [set('v0', c(1))], else: [set('v0', c(2))] };
    const out = print(splitReturnedMerges(merged([call('g'), inner], [ret(c(9))])));
    expect(out).toContain('return 1;');
    expect(out).toContain('return 2;');
    expect(out).not.toContain('v0');
  });

  test('a nested two-armed if is split too, so no else follows a return at any depth', () => {
    const inner: Stmt = { k: 'if', cond: v('a0'), then: [set('v0', c(1))], else: [set('v0', c(2))] };
    const out = print(splitReturnedMerges(merged([set('v0', c(9))], [call('g'), inner])));
    expect(out).toBe(
      's32 f(s32 a0, s32 a1) {\n    if (a1 != 0) return 9;\n    g();\n    if (a0) return 1;\n    return 2;\n}\n',
    );
    expect(shapeHabitCount(out ?? '')).toBe(0);
  });

  test('declines: an arm that ends otherwise, a local at another type, a void function', () => {
    expect(splitReturnedMerges(merged([set('v0', c(1))], [call('g')]))).toBeNull();
    const narrow = fnOf(merged([set('v0', c(1))], [set('v0', c(2))]).body, {
      locals: [{ name: 'v0', type: T.int(16, true) }],
    });
    expect(splitReturnedMerges(narrow)).toBeNull();
    expect(splitReturnedMerges({ ...merged([set('v0', c(1))], [set('v0', c(2))]), retType: T.void() })).toBeNull();
  });

  test('a local still read elsewhere keeps its declaration', () => {
    const fn = fnOf([
      set('v0', v('a0')),
      call('g', v('v0')),
      { k: 'if', cond: v('a1'), then: [set('v0', c(1))], else: [set('v0', c(2))] },
      ret(v('v0')),
    ]);
    expect(print(splitReturnedMerges(fn))).toMatch(/s32 v0;[\s\S]*g\(v0\)/);
  });
});

describe('/switch-break: leave a final switch by break', () => {
  const sw = (dflt: Stmt[] | undefined): Stmt => ({
    k: 'switch',
    scrutinee: v('a0'),
    cases: [
      {
        values: [0],
        body: [{ k: 'if', cond: v('a1'), then: [ret()], else: [] }, call('g'), ret()],
        fallsThrough: false,
      },
      { values: [1], body: [{ k: 'while', cond: v('a1'), body: [ret()] }, ret()], fallsThrough: false },
    ],
    ...(dflt === undefined ? {} : { default: dflt }),
  });

  test('every return in an arm breaks, except inside a loop; an empty default goes', () => {
    const out = print(breakFinalSwitchReturns(fnOf([sw([ret()])], { retType: T.void(), locals: [] })))!;
    expect(out).not.toContain('default');
    expect(out.match(/break;/g)).toHaveLength(3);
    expect(out).toMatch(/while \(a1\) \{\n {16}return;/);
  });

  test('a default with a body stays; a trailing return after the switch is allowed', () => {
    const out = print(breakFinalSwitchReturns(fnOf([sw([call('h')]), ret()], { retType: T.void(), locals: [] })))!;
    expect(out).toContain('default:');
  });

  test('declines: a switch that is not last, a non-void function', () => {
    expect(breakFinalSwitchReturns(fnOf([sw(undefined), call('k')], { retType: T.void(), locals: [] }))).toBeNull();
    expect(breakFinalSwitchReturns(fnOf([sw(undefined), ret(c(0))]))).toBeNull();
  });

  test('declines: no arm returns, even with an empty default to drop', () => {
    const plain: Stmt = {
      k: 'switch',
      scrutinee: v('a0'),
      cases: [
        { values: [0], body: [call('g'), { k: 'break', ofSwitch: true }], fallsThrough: false },
        { values: [1], body: [call('h'), { k: 'break', ofSwitch: true }], fallsThrough: false },
      ],
      default: [{ k: 'break', ofSwitch: true }],
    };
    expect(breakFinalSwitchReturns(fnOf([plain], { retType: T.void(), locals: [] }))).toBeNull();
    expect(breakFinalSwitchReturns(fnOf([{ ...plain, default: [] }], { retType: T.void(), locals: [] }))).toBeNull();
  });
});

describe('/compound-expr: x += e for a non-literal e', () => {
  test('marks a word local stepped by an expression, not one stepped by a literal', () => {
    const fn = fnOf([
      set('v0', bin('+', v('v0'), bin('*', v('a0'), v('a1')))),
      set('a0', bin('+', v('a0'), c(4))),
      ret(v('v0')),
    ]);
    const out = print(compoundExpressionAssignments(fn))!;
    expect(out).toContain('v0 += a0 * a1;');
    expect(out).toContain('a0 = a0 + 4;');
  });

  test('declines on a narrow local and where nothing qualifies', () => {
    const fn = fnOf([set('v0', bin('+', v('v0'), v('a0'))), ret(v('v0'))], {
      locals: [{ name: 'v0', type: T.int(8, false) }],
    });
    expect(compoundExpressionAssignments(fn)).toBeNull();
  });
});

describe('/for-read: a do/while whose first test passes, as a for', () => {
  const loop = (init: number, op: '<' | '<=' | '!=', bound: number, body: Stmt[]): SFn =>
    fnOf([set('v0', c(init)), { k: 'dowhile', cond: bin(op, v('v0'), c(bound)), body }, ret(v('v0'))]);
  const step = set('v0', bin('+', v('v0'), c(1)));

  test('reads as a for with the init and the last statement as its step', () => {
    expect(print(readDoWhileAsFor(loop(0, '<=', 6, [call('g', v('v0')), step])))).toContain(
      'for (v0 = 0; v0 <= 6; v0 = v0 + 1) {\n        g(v0);\n    }',
    );
  });

  test('declines: an init that fails the test, a continue, a step that is not last, a bound that is not literal', () => {
    expect(readDoWhileAsFor(loop(7, '<=', 6, [call('g'), step]))).toBeNull();
    expect(
      readDoWhileAsFor(loop(0, '<', 6, [{ k: 'if', cond: v('a0'), then: [{ k: 'continue' }], else: [] }, step])),
    ).toBeNull();
    expect(readDoWhileAsFor(loop(0, '<', 6, [step, call('g')]))).toBeNull();
    const fn = fnOf([set('v0', c(0)), { k: 'dowhile', cond: bin('<', v('v0'), v('a0')), body: [step] }, ret(v('v0'))]);
    expect(readDoWhileAsFor(fn)).toBeNull();
  });

  test('declines a last statement that does not update the counter from itself, as the while → for does', () => {
    const fresh = set('v0', { k: 'call', fn: 'h', args: [] });
    const body = [call('g', v('v0')), fresh];
    expect(readDoWhileAsFor(loop(0, '<', 10, body))).toBeNull();
    const asWhile: Stmt[] = [set('v0', c(0)), { k: 'while', cond: bin('<', v('v0'), c(10)), body }];
    expect(recognizeForLoops(asWhile).map((s) => s.k)).toEqual(['assign', 'while']);
    // with a self-update, both read the loop as a for
    expect(readDoWhileAsFor(loop(0, '<', 10, [call('g', v('v0')), step]))).not.toBeNull();
    expect(
      recognizeForLoops([set('v0', c(0)), { k: 'while', cond: bin('<', v('v0'), c(10)), body: [call('g'), step] }]).map(
        (s) => s.k,
      ),
    ).toEqual(['for']);
  });

  test('declines an init the counter type cannot hold', () => {
    const fn = { ...loop(200, '!=', 7, [step]), locals: [{ name: 'v0', type: T.int(8, true) }] };
    expect(readDoWhileAsFor(fn)).toBeNull();
  });
});

describe("the tie-break's habit count (shape-habits.ts)", () => {
  test('counts the habits the shape readings remove, and none in their own output', () => {
    const merged =
      's32 f(s32 a0) {\n    s32 v0;\n    if (a0 != 0) {\n        v0 = 1;\n    } else {\n        v0 = 0;\n    }\n    return v0;\n}\n';
    const elseAfter =
      's32 f(s32 a0) {\n    if (a0) {\n        return 1;\n    } else {\n        g();\n    }\n    return 0;\n}\n';
    expect(shapeHabitCount(merged)).toBe(1);
    expect(shapeHabitCount(elseAfter)).toBe(1);
    expect(shapeHabitCount('s32 f(s32 a0) {\n    if (a0 != 0) return 1;\n    return 0;\n}\n')).toBe(0);
    const loop = (body: string): string =>
      `void f(void) {\n    s32 i;\n    i = 0;\n    do {\n${body}        i = i + 1;\n    } while (i < 5);\n}\n`;
    expect(shapeHabitCount(loop('        h(i);\n'))).toBe(1);
    // the reading refuses a loop a `continue` leaves, so it is no habit a reading removes
    expect(
      shapeHabitCount(loop('        if (g(i) != 0) {\n            i = i + 2;\n            continue;\n        }\n')),
    ).toBe(0);
  });
});

// `synthetic:mixwalk`, agbcc -O2: `for (i = 0; i < 4; i++) TakeMove(m, s->moves[i], i);` beside
// constant-offset reads of the same base. agbcc strength-reduces the subscript, so only the
// `/unreduce` respell gives back the index, as a do/while; its `for` spelling compiles alike.
const MIXWALK =
  'mixwalk:\n\tpush\t{r4, r5, r6, r7, lr}\n\tmov\tr7, r8\n\tpush\t{r7}\n\tadd\tsp, sp, #-0x24\n' +
  '\tadd\tr6, r0, #0\n\tadd\tr4, r1, #0\n\tldrh\tr1, [r4]\n\tldrb\tr2, [r4, #0xc]\n' +
  '\tldr\tr3, [r4, #0x10]\n\tbl\tTakeBase\n\tmov\tr5, #0x0\n\tadd\tr7, sp, #0x20\n\tmov\tr0, #0x21\n' +
  '\tadd\tr0, r0, sp\n\tmov\tr8, r0\n\tadd\tr4, r4, #0x4\n.L6:\n\tldrh\tr1, [r4]\n' +
  '\tlsl\tr2, r5, #0x18\n\tlsr\tr2, r2, #0x18\n\tadd\tr0, r6, #0\n\tbl\tTakeMove\n\tadd\tr4, r4, #0x2\n' +
  '\tadd\tr5, r5, #0x1\n\tcmp\tr5, #0x3\n\tble\t.L6\t@cond_branch\n\tadd\tr0, r6, #0\n\tmov\tr1, #0x1\n' +
  '\tadd\tr2, r7, #0\n\tbl\tTakeData\n\tadd\tr0, r6, #0\n\tmov\tr1, #0x2\n\tmov\tr2, r8\n' +
  '\tbl\tTakeData\n\tadd\tr0, r6, #0\n\tmov\tr1, #0x3\n\tadd\tr2, r7, #0\n\tbl\tTakeData\n' +
  '\tadd\tr0, r6, #0\n\tmov\tr1, #0x4\n\tmov\tr2, r8\n\tbl\tTakeData\n\tadd\tsp, sp, #0x24\n' +
  '\tpop\t{r3}\n\tmov\tr8, r3\n\tpop\t{r4, r5, r6, r7}\n\tpop\t{r0}\n\tbx\tr0\n';

describe('the shape readings compose onto every respell variation', () => {
  test('a respell that builds the do/while gets its for reading as a candidate of its own', () => {
    const cands = enumerateCandidates('mixwalk', MIXWALK, ARMV4T_AGBCC, {
      prototypes: {
        mixwalk: { params: ['u32', 'u8 *'], returnsVoid: true },
        TakeBase: { params: ['u32', 'u16', 'u8', 's32'], returnsVoid: true },
        TakeMove: { params: ['u32', 'u16', 'u8'], returnsVoid: true },
        TakeData: { params: ['u32', 's32', 'void *'], returnsVoid: true },
      } as never,
    });
    const unreduced = cands.find((c) => c.variations.join('/') === 'unsigned/unreduce');
    const read = cands.find((c) => c.variations.join('/') === 'unsigned/unreduce/for-read');
    expect(unreduced?.source).toMatch(/do \{/);
    expect(read?.source).toMatch(/for \(v1 = 0; v1 <= 3; v1 = v1 \+ 1\)/);
    expect(read?.source).not.toMatch(/do \{/);
  });
});
