// Live-range coalescing (l3/coalesce.ts): two locals whose ranges cannot overlap and that no loop
// re-runs together — constant-fed, or fed only by their own `for` induction step.
//
// SSA destruction names each merge independently, so two unrelated phis get two locals where the
// compiler held one register. WHICH pair it shared is not derivable from the tree — on the row this
// was built for, the two legal merges score 18 and 40 against a no-merge baseline of 21 — so the
// pass ENUMERATES every legal merge and the differ referees, the `/regcopy` idiom.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import {
  ARM_DISJOINT_GATES,
  COALESCE_GATES,
  armDisjointUnder,
  coalesceCandidates,
  coalesceUnder,
} from '../src/l3/coalesce';

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

  test('a mention inside the SAME loop blocks it — the sound-critical gate', () => {
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
    for (const qualifier of ['volatile', 'pointeeVolatile'] as const) {
      const locals = [
        { name: 'x', type: T.s(32), [qualifier]: true },
        { name: 'y', type: T.s(32), [qualifier]: true },
      ];
      const out = coalesceCandidates(fn([armIf(cnd, arm('x'), arm('y'))], locals));
      expect(out.map((c) => c.merged)).not.toContain('y-x');
    }
  });

  test('a local not const-initialized at its arm’s first mention never merges (the growth bound)', () => {
    // arm B first mentions y through a computed assign — the load-fed-temp shape of a big if
    const armB: Stmt[] = [
      { k: 'assign', name: 'y', value: { k: 'bin', op: '+', l: { k: 'var', name: 'y' }, r: { k: 'const', value: 1 } } },
      use('y'),
    ];
    const { candidates, refusals } = armDisjointUnder(
      ARM_DISJOINT_GATES,
      fn([armIf(cnd, arm('x'), armB)], L('x', 'y')),
    );
    expect(candidates.map((c) => c.merged)).not.toContain('y-x');
    expect(refusals.get('arm-init')).toBeGreaterThan(0); // the gate is reached, not decorative
  });

  test('the first-mention verdict is per NAME, not per arm', () => {
    // Two locals confined to the SAME arm, differing only in whether their first mention is a
    // const write: the answer for one is not the answer for the other. `firstMention` is memoised
    // on (arm, name) and this is the pair that tells a memo keyed on the arm alone from a correct
    // one — it would admit three merges the `arm-init` gate refuses.
    const computed = (n: string): Stmt => ({
      k: 'assign',
      name: n,
      value: { k: 'bin', op: '+', l: { k: 'var', name: n }, r: { k: 'const', value: 1 } },
    });
    const half = (init: string, comp: string): Stmt[] => [asg(init, 1), use(init), computed(comp), use(comp)];
    const { candidates, refusals } = armDisjointUnder(
      ARM_DISJOINT_GATES,
      fn([armIf(cnd, half('x1', 'x2'), half('y1', 'y2'))], L('x1', 'x2', 'y1', 'y2')),
    );
    expect(candidates.map((c) => c.merged)).toEqual(['y1-x1']);
    expect(refusals.get('arm-init')).toBe(3); // (x1,y2), (x2,y1), (x2,y2)
  });

  test('params never merge through the arm path either', () => {
    const f = fn([armIf(cnd, arm('x'), arm('y'))], L('x'));
    f.params = [{ name: 'y', type: T.s(32) }];
    expect(coalesceCandidates(f).map((c) => c.merged)).not.toContain('y-x');
  });
});

describe('volatile pairs (span path)', () => {
  test('a volatile pair never merges through the span path — object or pointee qualifier alike', () => {
    // typeToString spells neither qualifier, so without the gate the qualified local absorbs
    // into a plain one and every access loses (or gains) its volatility.
    const body = [asg('a', 1), use('a'), asg('b', 2), use('b')];
    const objectVolatile = [
      { name: 'a', type: T.s(32), volatile: true as const },
      { name: 'b', type: T.s(32) },
    ];
    expect(coalesceCandidates(fn(body, objectVolatile))).toEqual([]);
    const pointeeVolatile = [
      { name: 'a', type: T.s(32), pointeeVolatile: true as const },
      { name: 'b', type: T.s(32) },
    ];
    expect(coalesceCandidates(fn(body, pointeeVolatile))).toEqual([]);
  });
});

// ── the loop rule: what a back edge can actually reorder ────────────────────────────────────
// The gate refuses a pair only when some loop holds a mention of BOTH locals — there the
// survivor's write can be followed, on the next iteration, by the absorbed local's read. Two
// SIBLING loops share no back edge, so preorder is execution order and the merge is legal.
const forLoop = (n: string, init: Expr, body: Stmt[]): Extract<Stmt, { k: 'for' }> => ({
  k: 'for',
  init: { k: 'assign', name: n, value: init },
  cond: { k: 'bin', op: '<', l: { k: 'var', name: n }, r: { k: 'const', value: 10 } },
  inc: { k: 'assign', name: n, value: { k: 'bin', op: '+', l: { k: 'var', name: n }, r: { k: 'const', value: 1 } } },
  body,
});
const c0: Expr = { k: 'const', value: 0 };
const rd = (n: string): Expr => ({ k: 'var', name: n });

describe('the loop rule', () => {
  const run = (body: Stmt[]) => coalesceUnder(COALESCE_GATES, fn(body));

  test('counters in SIBLING loops merge — no back edge joins the two ranges', () => {
    const out = run([forLoop('a', c0, [use('a')]), forLoop('b', c0, [use('b')])]).candidates;
    expect(out).toHaveLength(1);
    expect(names(out[0].sfn)).toEqual(['b']);
  });

  test('two locals in the SAME loop never merge — the next iteration reads the absorbed value', () => {
    const r = run([{ k: 'while', cond: c0, body: [asg('a', 1), use('a'), asg('b', 2), use('b')] }]);
    expect(r.candidates).toHaveLength(0);
    expect(r.refusals.get('shared-loop')).toBeGreaterThan(0); // the rule that refused, not a neighbour
  });

  test('sibling INNER loops under a shared OUTER loop never merge — the outer back edge reorders them', () => {
    const nested: Stmt = { k: 'while', cond: c0, body: [forLoop('a', c0, [use('a')]), forLoop('b', c0, [use('b')])] };
    const r = run([nested]);
    expect(r.candidates).toHaveLength(0);
    expect(r.refusals.get('shared-loop')).toBeGreaterThan(0);
  });

  test('a local living BEFORE the loop another lives in merges — no loop holds both', () => {
    const out = run([asg('a', 1), use('a'), forLoop('b', c0, [use('b')])]).candidates;
    expect(out).toHaveLength(1);
    expect(names(out[0].sfn)).toEqual(['b']); // the later range survives, as `overlap` orders it
  });

  // A loop standing in a `for`'s INIT position: the init runs once, so the `for` does not re-run
  // it — but the loop re-runs its OWN condition and body, and a pair inside it must not read as
  // straight-line. (`c`, the outer counter, is deliberately undeclared: only declared locals pair.)
  test('a loop in a `for`s INIT encloses its own BODY', () => {
    const initLoop: Stmt = { k: 'while', cond: c0, body: [use('a'), asg('a', 11), asg('b', 22), use('b')] };
    const r = run([{ ...forLoop('c', c0, [use('c')]), init: initLoop }]);
    expect(r.candidates).toHaveLength(0);
    expect(r.refusals.get('shared-loop')).toBeGreaterThan(0);
  });

  test('a loop in a `for`s INIT encloses its own CONDITION', () => {
    // `a` is mentioned only in the init-loop's condition, `b` only in its body: the condition
    // re-runs with the body, so one loop holds both
    const initLoop: Stmt = { k: 'while', cond: rd('a'), body: [asg('b', 2), use('b')] };
    const r = run([asg('a', 7), { ...forLoop('c', c0, [use('c')]), init: initLoop }]);
    expect(r.candidates).toHaveLength(0);
    expect(r.refusals.get('shared-loop')).toBeGreaterThan(0);
  });
});

// ── the induction-variable model ───────────────────────────────────────────────────────────
// `const-fed` predicts that a local fed from memory is one the compiler had a reason to keep
// where it was. A `for`'s induction variable is fed by its own init and by a step that computes
// the next value ARITHMETICALLY from the current one — the init is the local's definition and the
// step is its own history. A step that reads memory every iteration (`p = p->next`) is not.
const load: Expr = { k: 'index', base: { k: 'const', value: 0x3001048 }, idx: c0, width: 2, signed: false };

describe('the induction-variable model', () => {
  test('a LOAD-fed induction variable merges — its init feed is its own definition', () => {
    const out = coalesceCandidates(fn([forLoop('a', c0, [use('a')]), forLoop('b', load, [use('b')])]));
    expect(out).toHaveLength(1);
    expect(names(out[0].sfn)).toEqual(['b']);
  });

  test('a load-fed local that is NOT an induction variable still refuses', () => {
    const r = coalesceUnder(
      COALESCE_GATES,
      fn([forLoop('a', c0, [use('a')]), { k: 'assign', name: 'b', value: load }, use('b')]),
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.refusals.get('const-fed')).toBeGreaterThan(0);
  });

  test('a `for` whose STEP reads memory THROUGH the variable is not one either', () => {
    // `p = p->next` — a self-read, but a memory read every iteration, which is what const-fed
    // exists to refuse. recognizeForLoops mints exactly this shape for a list walk.
    const walkStep: Stmt = {
      ...forLoop('b', c0, [use('b')]),
      inc: { k: 'assign', name: 'b', value: { k: 'field', base: rd('b'), name: 'field_4' } },
    };
    const r = coalesceUnder(COALESCE_GATES, fn([forLoop('a', c0, [use('a')]), walkStep]));
    expect(r.candidates).toHaveLength(0);
    expect(r.refusals.get('const-fed')).toBeGreaterThan(0);
  });

  test('a `for` whose STEP re-loads a fixed address is not one either', () => {
    const reloaded: Stmt = {
      ...forLoop('b', load, [use('b')]),
      inc: { k: 'assign', name: 'b', value: load },
    };
    const r = coalesceUnder(COALESCE_GATES, fn([forLoop('a', c0, [use('a')]), reloaded]));
    expect(r.candidates).toHaveLength(0);
    expect(r.refusals.get('const-fed')).toBeGreaterThan(0);
  });
});
