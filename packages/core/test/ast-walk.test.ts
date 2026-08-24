// `walkExprs` is the ONE whole-tree expression walk every L3 pass composes out of
// stmtExprs/stmtChildren/exprChildren, so its ORDER is a contract: a consumer that counts, or that
// stops at the first hit, reads a different answer if the order moves. It is written as an explicit
// stack rather than the obvious `yield*` recursion, so these tests keep the recursion itself as the
// reference the stack is checked against.
import { expect, test } from 'vitest';

import { type Expr, type Stmt, exprChildren, stmtChildren, stmtExprs, walkExprs } from '../src/l3/ast';

const I32 = { kind: 'int', width: 4, signed: true } as const;

/** The straightforward recursion — what `walkExprs` was, and what it must still agree with. */
function* reference(body: Stmt[]): Generator<Expr> {
  const expr = function* (e: Expr): Generator<Expr> {
    yield e;
    for (const c of exprChildren(e)) {
      yield* expr(c);
    }
  };
  for (const s of body) {
    for (const e of stmtExprs(s)) {
      yield* expr(e);
    }
    yield* reference(stmtChildren(s));
  }
}

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });

// Every statement kind and every expression kind in one body — a `for` (whose init/inc are
// CHILDREN while its cond is an expr, the documented quirk), a `switch` with its default spliced
// between arms, and a nested `if` under a `dowhile`.
const BODY: Stmt[] = [
  { k: 'assign', name: 'a', value: { k: 'bin', op: '+', l: v('p'), r: { k: 'un', op: '-', e: c(1) } } },
  {
    k: 'store',
    lval: { k: 'index', base: v('q'), idx: c(2), width: 4, signed: true },
    value: { k: 'addr', name: 'g' },
  },
  { k: 'exprstmt', value: { k: 'call', fn: 'h', args: [v('a'), { k: 'cast', to: I32, e: c(3) }] } },
  {
    k: 'for',
    init: { k: 'assign', name: 'i', value: c(0) },
    cond: { k: 'bin', op: '<', l: v('i'), r: c(8) },
    inc: { k: 'assign', name: 'i', value: { k: 'bin', op: '+', l: v('i'), r: c(1) } },
    body: [
      {
        k: 'dowhile',
        cond: { k: 'field', base: v('s'), name: 'field_4' },
        body: [
          { k: 'if', cond: v('t'), then: [{ k: 'break' }], else: [{ k: 'continue' }] },
          { k: 'while', cond: { k: 'marker', reason: 'r', args: [v('u')] }, body: [] },
        ],
      },
    ],
  },
  {
    k: 'switch',
    scrutinee: v('sw'),
    cases: [
      { values: [1], body: [{ k: 'assign', name: 'a', value: c(11) }], fallsThrough: false },
      { values: [2], body: [{ k: 'assign', name: 'a', value: c(22) }], fallsThrough: false },
    ],
    default: [{ k: 'assign', name: 'a', value: c(33) }],
    defaultAt: 1,
  },
  { k: 'return', value: v('a') },
];

const spell = (e: Expr): string =>
  e.k === 'var' || e.k === 'addr'
    ? `${e.k}:${e.name}`
    : e.k === 'const'
      ? `const:${e.value}`
      : e.k === 'bin' || e.k === 'un'
        ? `${e.k}:${e.op}`
        : e.k === 'call'
          ? `call:${e.fn}`
          : e.k === 'field'
            ? `field:${e.name}`
            : e.k;

test('the walk is document order, parents before children', () => {
  expect([...walkExprs(BODY)].map(spell)).toEqual([
    // assign
    'bin:+',
    'var:p',
    'un:-',
    'const:1',
    // store: lvalue then value
    'index',
    'var:q',
    'const:2',
    'addr:g',
    // exprstmt
    'call:h',
    'var:a',
    'cast',
    'const:3',
    // for: cond is an EXPR, init/inc are CHILDREN — so the cond comes first
    'bin:<',
    'var:i',
    'const:8',
    'const:0',
    'bin:+',
    'var:i',
    'const:1',
    'field:field_4',
    'var:s',
    'var:t',
    'marker',
    'var:u',
    // switch: scrutinee, then the arms with the default spliced in at defaultAt
    'var:sw',
    'const:11',
    'const:33',
    'const:22',
    // return
    'var:a',
  ]);
});

test('the walk agrees with the recursion on a body 40 levels deep', () => {
  // The stack form exists because `yield*` charges a frame per level to every value it forwards.
  // Depth is therefore exactly where the two could diverge, so it is where they are compared.
  let body: Stmt[] = [{ k: 'return', value: v('leaf') }];
  for (let d = 0; d < 40; d++) {
    body = [
      { k: 'assign', name: `d${d}`, value: { k: 'bin', op: '+', l: v(`x${d}`), r: c(d) } },
      { k: 'while', cond: { k: 'un', op: '!', e: v(`c${d}`) }, body },
    ];
  }
  const walked = [...walkExprs(body)];
  expect(walked.map(spell)).toEqual([...reference(body)].map(spell));
  expect(walked.length).toBe(40 * 5 + 1);
});

test('the walk agrees with the recursion on 200 random bodies', () => {
  // A deterministic LCG, not Math.random: a differential that fails only sometimes is a
  // differential nobody can bisect.
  let seed = 0x5eed;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 8) % n;
  };
  const mkExpr = (depth: number): Expr => {
    if (depth <= 0 || rnd(3) === 0) {
      return rnd(2) === 0 ? v(`v${rnd(5)}`) : c(rnd(100));
    }
    switch (rnd(5)) {
      case 0:
        return { k: 'bin', op: '+', l: mkExpr(depth - 1), r: mkExpr(depth - 1) };
      case 1:
        return { k: 'un', op: '~', e: mkExpr(depth - 1) };
      case 2:
        return { k: 'call', fn: `f${rnd(3)}`, args: Array.from({ length: rnd(4) }, () => mkExpr(depth - 1)) };
      case 3:
        return { k: 'index', base: mkExpr(depth - 1), idx: mkExpr(depth - 1), width: 4, signed: true };
      default:
        return { k: 'cast', to: I32, e: mkExpr(depth - 1) };
    }
  };
  const mkBody = (depth: number): Stmt[] =>
    Array.from({ length: rnd(4) }, (): Stmt => {
      switch (depth <= 0 ? 0 : rnd(6)) {
        case 0:
          return { k: 'assign', name: `a${rnd(4)}`, value: mkExpr(3) };
        case 1:
          return { k: 'store', lval: mkExpr(2), value: mkExpr(2) };
        case 2:
          return { k: 'if', cond: mkExpr(2), then: mkBody(depth - 1), else: mkBody(depth - 1) };
        case 3:
          return { k: 'while', cond: mkExpr(2), body: mkBody(depth - 1) };
        case 4:
          return {
            k: 'for',
            init: { k: 'assign', name: 'i', value: mkExpr(1) },
            cond: mkExpr(2),
            inc: { k: 'assign', name: 'i', value: mkExpr(1) },
            body: mkBody(depth - 1),
          };
        default:
          return {
            k: 'switch',
            scrutinee: mkExpr(2),
            cases: Array.from({ length: 1 + rnd(3) }, (_, i) => ({
              values: [i],
              body: mkBody(depth - 1),
              fallsThrough: false,
            })),
            default: mkBody(depth - 1),
            defaultAt: rnd(2),
          };
      }
    });
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const body = mkBody(4);
    const walked = [...walkExprs(body)];
    expect(walked).toEqual([...reference(body)]);
    total += walked.length;
  }
  expect(total).toBeGreaterThan(2000); // the corpus actually exercised something
});
