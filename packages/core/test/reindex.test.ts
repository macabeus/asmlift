// The walk→index re-spelling (l3/reindex.ts) — the third differ-ranked lever. Pins: the golden
// while-walk re-spells with the bound simplified; every out-of-scope shape DECLINES (returns
// null) rather than approximating; the transform never mutates its input.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { reindexWalks } from '../src/l3/reindex';

const V = (name: string): Expr => ({ k: 'var', name });
const C = (value: number): Expr => ({ k: 'const', value });
const deref = (name: string): Expr => ({ k: 'index', base: V(name), idx: C(0), width: 4, signed: true });
const step = (name: string): Stmt => ({
  k: 'assign',
  name,
  value: { k: 'bin', op: '+', l: V(name), r: C(1) },
});

/** `v0 = 0; v1 = a0; while (v1 < a0 + a1) { v0 = v0 + *v1; v1 = v1 + 1; } return v0;` */
function walkSum(cond?: Expr, tail?: Stmt[]): SFn {
  return {
    name: 'sum',
    retType: T.s(32),
    params: [
      { name: 'a0', type: T.ptr(T.s(32)) },
      { name: 'a1', type: T.s(32) },
    ],
    locals: [
      { name: 'v0', type: T.s(32) },
      { name: 'v1', type: T.ptr(T.s(32)) },
    ],
    body: [
      { k: 'assign', name: 'v0', value: C(0) },
      { k: 'assign', name: 'v1', value: V('a0') },
      {
        k: 'while',
        cond: cond ?? { k: 'bin', op: '<', l: V('v1'), r: { k: 'bin', op: '+', l: V('a0'), r: V('a1') } },
        body: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('v0'), r: deref('v1') } }, step('v1')],
      },
      { k: 'return', value: V('v0') },
      ...(tail ?? []),
    ],
  };
}

describe('reindexWalks — the golden shape', () => {
  test('a unit-step walk with an inlined bound re-spells indexed, bound simplified to the count', () => {
    const src = cBackend.emit(reindexWalks(walkSum())!);
    expect(src).toContain('i0 = 0;');
    expect(src).toContain('while (i0 < a1) {');
    expect(src).toContain('a0[i0]');
    expect(src).toContain('i0 = i0 + 1;');
    expect(src).not.toContain('v1 <'); // the walk bound is gone
  });

  test('the input SFn is never mutated', () => {
    const sfn = walkSum();
    const before = JSON.stringify(sfn);
    reindexWalks(sfn);
    expect(JSON.stringify(sfn)).toBe(before);
  });
});

describe('reindexWalks — out-of-scope shapes decline (null), never approximate', () => {
  test('a bound that is not base + N', () => {
    expect(reindexWalks(walkSum({ k: 'bin', op: '<', l: V('v1'), r: V('a1') }))).toBeNull();
  });

  test('the pointer read AFTER the loop (its final value would be base + iterations)', () => {
    expect(
      reindexWalks(walkSum(undefined, [{ k: 'exprstmt', value: { k: 'call', fn: 'g', args: [V('v1')] } }])),
    ).toBeNull();
  });

  test('a bare (non-deref) use of the pointer inside the loop', () => {
    const sfn = walkSum();
    const loop = sfn.body[2] as Extract<Stmt, { k: 'while' }>;
    loop.body.unshift({ k: 'exprstmt', value: { k: 'call', fn: 'g', args: [V('v1')] } });
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('a non-unit step', () => {
    const sfn = walkSum();
    const loop = sfn.body[2] as Extract<Stmt, { k: 'while' }>;
    loop.body[loop.body.length - 1] = {
      k: 'assign',
      name: 'v1',
      value: { k: 'bin', op: '+', l: V('v1'), r: C(2) },
    };
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('a function with no pointer locals at all', () => {
    expect(
      reindexWalks({
        name: 'f',
        retType: T.s(32),
        params: [{ name: 'a0', type: T.s(32) }],
        locals: [],
        body: [{ k: 'return', value: V('a0') }],
      }),
    ).toBeNull();
  });
});

describe('reindexWalks — adversarial-round soundness gate', () => {
  test('a deref width disagreeing with the walk stride declines (different addresses)', () => {
    // *(u8 *)p over an s32* walk strides 4; ((u8 *)base)[i] would stride 1 — wrong bytes.
    const sfn = walkSum();
    const loop = sfn.body[2] as Extract<Stmt, { k: 'while' }>;
    (loop.body[0] as Extract<Stmt, { k: 'assign' }>).value = {
      k: 'bin',
      op: '+',
      l: V('v0'),
      r: { k: 'index', base: V('v1'), idx: C(0), width: 1, signed: false },
    };
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('base and p with DIFFERENT pointee sizes decline (trip counts diverge)', () => {
    const sfn = walkSum();
    sfn.params[0] = { name: 'a0', type: T.ptr(T.s(16)) }; // base strides 2, p strides 4
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('a post-loop read BEYOND the enclosing construct declines (global mention count)', () => {
    // the walk sits under an if; p is read after the if — the suffix-only check missed this,
    // deleting the init and leaving the later read uninitialized.
    const inner = walkSum();
    const sfn: SFn = {
      ...inner,
      body: [
        inner.body[0],
        { k: 'if', cond: V('a1'), then: [inner.body[1], inner.body[2]], else: [] },
        { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [V('v1')] } },
        inner.body[3],
      ],
    };
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('p === base declines (the walk bound would chase the stepped var)', () => {
    const sfn = walkSum();
    (sfn.body[1] as Extract<Stmt, { k: 'assign' }>).value = V('v1'); // p = p
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('the fresh index var never collides with an existing name', () => {
    const sfn = walkSum();
    sfn.locals.push({ name: 'i0', type: T.s(32) }); // an unrelated pre-existing i0
    const ix = reindexWalks(sfn);
    expect(ix).not.toBeNull();
    const names = ix!.locals.map((l) => l.name);
    expect(names.filter((n) => n === 'i0')).toHaveLength(1); // no duplicate declaration
    expect(cBackend.emit(ix!)).toContain('i1'); // the walk got the next free name
  });
});
