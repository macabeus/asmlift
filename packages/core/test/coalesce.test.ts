// Live-range coalescing (l3/coalesce.ts): two constant-fed locals whose ranges cannot overlap.
//
// SSA destruction names each merge independently, so two unrelated phis get two locals where the
// compiler held one register. WHICH pair it shared is not derivable from the tree — on the row this
// was built for, the two legal merges score 18 and 40 against a no-merge baseline of 21 — so the
// pass ENUMERATES every legal merge and the differ referees, the `/regcopy` idiom.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { coalesceCandidates } from '../src/l3/coalesce';

const asg = (n: string, v: number): Stmt => ({ k: 'assign', name: n, value: { k: 'const', value: v } });
const use = (n: string): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn: 'f', args: [{ k: 'var', name: n }] } });
const L = (...names: string[]) => names.map((n) => ({ name: n, type: T.s(32) }));
const fn = (body: Stmt[], locals = L('a', 'b')): SFn => ({
  name: 'f',
  params: [],
  locals,
  retType: T.void(),
  body,
});
const names = (s: SFn) => s.locals.map((l) => l.name);
const trees = (xs: { sfn: SFn }[]) => xs.map((x) => x.sfn);

describe('enumeration', () => {
  test('EVERY legal merge is offered, not one committed choice', () => {
    // a and b are disjoint both ways round only in one direction here, but c gives a second pair
    const out = coalesceCandidates(
      fn([asg('a', 1), use('a'), asg('b', 2), use('b'), asg('c', 3), use('c')], L('a', 'b', 'c')),
    );
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.every((c) => /^v?\w+-v?\w+$/.test(c.merged))).toBe(true);
    // each candidate drops exactly one local
    for (const alt of trees(out)) {
      expect(alt.locals).toHaveLength(2);
    }
  });

  test('the absorbed local is renamed everywhere and removed from the declarations', () => {
    const out = coalesceCandidates(fn([asg('a', 1), use('a'), asg('b', 2), use('b')]));
    expect(out).toHaveLength(1);
    expect(names(out[0].sfn)).toEqual(['b']);
    expect(JSON.stringify(out[0].sfn.body)).not.toContain('"a"');
  });
});

describe('gates', () => {
  test('OVERLAPPING ranges never merge', () => {
    expect(coalesceCandidates(fn([asg('a', 1), asg('b', 2), use('a'), use('b')]))).toEqual([]);
  });

  test('a mention inside a LOOP blocks it — the sound-critical gate', () => {
    // Without this, preorder order stops implying disjoint liveness: a back edge can run a later
    // statement before an earlier one. One shape, pinned; `coalesce-fuzz.test.ts` is what quantifies
    // over shapes, and it also checks that suppressing the gate really does clobber.
    const body: Stmt[] = [
      asg('a', 1),
      { k: 'while', cond: { k: 'const', value: 1 }, body: [use('a'), asg('b', 2), use('b')] },
    ];
    expect(coalesceCandidates(fn(body))).toEqual([]);
  });

  test('a NON-CONSTANT feed blocks it — a load-fed local is one the compiler kept deliberately', () => {
    const load: Expr = {
      k: 'index',
      base: { k: 'var', name: 'p' },
      idx: { k: 'const', value: 0 },
      width: 4,
      signed: true,
    };
    const body: Stmt[] = [{ k: 'assign', name: 'a', value: load }, use('a'), asg('b', 2), use('b')];
    expect(coalesceCandidates(fn(body))).toEqual([]);
  });

  test('the survivor must be WRITTEN at its first mention', () => {
    // otherwise the merge makes the survivor's first read see the absorbed value
    const body: Stmt[] = [asg('a', 1), use('a'), use('b'), asg('b', 2)];
    expect(coalesceCandidates(fn(body))).toEqual([]);
  });

  test('different declared TYPES never merge — the survivor keeps its own', () => {
    const locals = [
      { name: 'a', type: T.s(32) },
      { name: 'b', type: T.ptr(T.u(16)) },
    ];
    expect(coalesceCandidates(fn([asg('a', 1), use('a'), asg('b', 2), use('b')], locals))).toEqual([]);
  });

  test('PARAMS are never merged — they are the function’s own signature', () => {
    const s: SFn = { ...fn([asg('a', 1), use('a'), asg('b', 2), use('b')]), params: [{ name: 'b', type: T.s(32) }] };
    expect(coalesceCandidates(s)).toEqual([]);
  });
});

describe('gates: the self-reading assign', () => {
  test('an assign that ALSO READS the survivor is not a pure write', () => {
    // `b = g(b)` writes and reads in one statement. Counting it as a pure write let the merge feed
    // `g` the ABSORBED value — the read the firstIsWrite gate claims to prevent.
    //
    // SCOPE: this does NOT isolate that gate. `constFed` rejects the pair first (the value is a
    // call, not a literal), so mutating the self-read check away leaves this green. The two gates
    // are not independent; pinned here as the observable behaviour only.
    const call = (n: string): Expr => ({ k: 'call', fn: 'g', args: [{ k: 'var', name: n }] });
    const body: Stmt[] = [asg('a', 1), use('a'), { k: 'assign', name: 'b', value: call('b') }, use('b')];
    expect(coalesceCandidates(fn(body))).toEqual([]);
  });

  test('a plain assign to the survivor still qualifies', () => {
    const out = coalesceCandidates(fn([asg('a', 1), use('a'), asg('b', 2), use('b')]));
    expect(out).toHaveLength(1);
    expect(out[0].merged).toBe('a-b');
  });
});

describe('arm-disjoint admission', () => {
  const armIf = (cond: Expr, thenS: Stmt[], elseS: Stmt[]): Stmt => ({ k: 'if', cond, then: thenS, else: elseS });
  const cnd: Expr = { k: 'bin', op: '!=', l: { k: 'var', name: 'a' }, r: { k: 'const', value: 0 } };
  // each arm: init, a loop mentioning the counter, a use — the shapes the span gates must refuse
  const arm = (n: string): Stmt[] => [
    asg(n, 0),
    {
      k: 'dowhile',
      cond: { k: 'bin', op: '<', l: { k: 'var', name: n }, r: { k: 'const', value: 9 } },
      body: [use(n)],
    },
  ];

  test('counters confined to opposite arms of one if merge, span gates notwithstanding', () => {
    const out = coalesceCandidates(fn([armIf(cnd, arm('x'), arm('y'))], L('x', 'y')));
    expect(out.map((c) => c.merged)).toContain('y-x'); // survivor = the earlier declaration
    const merged = out.find((c) => c.merged === 'y-x')!.sfn;
    expect(names(merged)).toEqual(['x']);
    expect(JSON.stringify(merged.body)).not.toContain('"y"');
  });

  test('a mention outside the arms (the if condition, a tail statement) breaks confinement', () => {
    const inCond = coalesceCandidates(
      fn(
        [armIf({ k: 'bin', op: '!=', l: { k: 'var', name: 'x' }, r: { k: 'const', value: 0 } }, arm('x'), arm('y'))],
        L('x', 'y'),
      ),
    );
    expect(inCond.map((c) => c.merged)).not.toContain('y-x');
    const inTail = coalesceCandidates(fn([armIf(cnd, arm('x'), arm('y')), use('y')], L('x', 'y')));
    expect(inTail.map((c) => c.merged)).not.toContain('y-x');
  });

  test('an in-loop if never admits its arm pair', () => {
    // the loop re-enters the if: a later entry can take the other arm and read what the first left
    const out = coalesceCandidates(
      fn([{ k: 'dowhile', cond: cnd, body: [armIf(cnd, arm('x'), arm('y'))] }], L('x', 'y')),
    );
    expect(out.map((c) => c.merged)).not.toContain('y-x');
  });

  test('a volatile pair never merges — slot identity is observable', () => {
    const locals = [
      { name: 'x', type: T.s(32), volatile: true as const },
      { name: 'y', type: T.s(32), volatile: true as const },
    ];
    const out = coalesceCandidates(fn([armIf(cnd, arm('x'), arm('y'))], locals));
    expect(out.map((c) => c.merged)).not.toContain('y-x');
  });

  test('params never merge through the arm path either', () => {
    const f = fn([armIf(cnd, arm('x'), arm('y'))], L('x'));
    f.params = [{ name: 'y', type: T.s(32) }];
    expect(coalesceCandidates(f).map((c) => c.merged)).not.toContain('y-x');
  });
});
