// The shape readings: respell variations that print a tree a reader would write, each one program
// with the tree as recovered, and each a different tree to some compiler (the modules carry the
// compiled pairs). Each fires where its shape is, declines everywhere else, and never changes what
// the function does.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { splitReturnedMerges } from '../src/l3/retsplit';
import { breakFinalSwitchReturns } from '../src/l3/switchbreak';

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
});
