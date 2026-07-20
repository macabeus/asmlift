import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';
import { eliminateDeadStores } from '../src/l3/dce';

function fn(body: Stmt[], locals: string[] = ['v0']): SFn {
  return {
    name: 'f',
    params: [],
    locals: locals.map((name) => ({ name, type: T.s(32) })),
    retType: T.s(32),
    body,
  };
}

describe('dead-local-store elimination', () => {
  test('a pure assignment to a never-read local is dropped', () => {
    const out = eliminateDeadStores(fn([{ k: 'assign', name: 'v0', value: { k: 'const', value: 5 } }]));
    expect(out.body).toEqual([]);
    expect(out.locals).toEqual([]); // the now-unreferenced declaration is pruned too
  });

  test('an assignment whose local IS read later is kept', () => {
    const body: Stmt[] = [
      { k: 'assign', name: 'v0', value: { k: 'const', value: 5 } },
      { k: 'return', value: { k: 'var', name: 'v0' } },
    ];
    expect(eliminateDeadStores(fn(body)).body).toEqual(body);
  });

  test('a dead assignment whose VALUE has a side effect (call) is kept', () => {
    const body: Stmt[] = [{ k: 'assign', name: 'v0', value: { k: 'call', fn: 'sideEffect', args: [] } }];
    expect(eliminateDeadStores(fn(body)).body).toEqual(body);
  });

  test('a store to a GLOBAL is never removed (not a declared local)', () => {
    // gCounter is not in `locals`, so it is a global write — a side effect that must survive.
    const body: Stmt[] = [{ k: 'assign', name: 'gCounter', value: { k: 'const', value: 1 } }];
    expect(eliminateDeadStores(fn(body, ['v0'])).body).toEqual(body);
  });

  test('a dead assignment whose value is a memory LOAD is kept (no volatile model)', () => {
    // asmlift models no `volatile`, so a possibly-effectful read is never speculatively deleted.
    const body: Stmt[] = [
      {
        k: 'assign',
        name: 'v0',
        value: { k: 'index', base: { k: 'var', name: 'gPtr' }, idx: { k: 'const', value: 0 }, width: 4, signed: true },
      },
    ];
    expect(eliminateDeadStores(fn(body)).body).toEqual(body);
  });

  test('a dead assignment carrying the strict-mode `?` sentinel is kept (gap must not be hidden)', () => {
    const body: Stmt[] = [{ k: 'assign', name: 'v0', value: { k: 'var', name: '?' } }];
    expect(eliminateDeadStores(fn(body)).body).toEqual(body);
  });

  test('a memory store is never removed', () => {
    const body: Stmt[] = [
      {
        k: 'store',
        lval: { k: 'index', base: { k: 'var', name: 'v0' }, idx: { k: 'const', value: 0 }, width: 4, signed: true },
        value: { k: 'const', value: 7 },
      },
    ];
    expect(eliminateDeadStores(fn(body)).body).toEqual(body);
  });

  test('dead stores in both if-arms drop, and the empty then-arm flips the condition', () => {
    // if (c) { v0 = 1 } else { gFlag = 1; v0 = 2 }  →  if (!c) { gFlag = 1 }
    const cond: Stmt & { k: 'if' } = {
      k: 'if',
      cond: { k: 'bin', op: '!=', l: { k: 'var', name: 'v0' }, r: { k: 'const', value: 0 } },
      then: [{ k: 'assign', name: 'v0', value: { k: 'const', value: 1 } }],
      else: [
        { k: 'assign', name: 'gFlag', value: { k: 'const', value: 1 } },
        { k: 'assign', name: 'v0', value: { k: 'const', value: 2 } },
      ],
    };
    // v0 must be live at entry to reach the arms; make the whole thing preceded by a read-free use.
    const out = eliminateDeadStores(fn([cond]));
    expect(out.body).toEqual([
      {
        k: 'if',
        cond: { k: 'bin', op: '==', l: { k: 'var', name: 'v0' }, r: { k: 'const', value: 0 } },
        then: [{ k: 'assign', name: 'gFlag', value: { k: 'const', value: 1 } }],
        else: [],
      },
    ]);
  });

  test('a store read only on a later loop iteration is NOT removed (conservative loop liveness)', () => {
    // do { use(v0); v0 = v0 + 1 } while (c) — v0's update feeds the next iteration's use.
    const body: Stmt[] = [
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '!=', l: { k: 'var', name: 'v0' }, r: { k: 'const', value: 0 } },
        body: [
          { k: 'exprstmt', value: { k: 'call', fn: 'use', args: [{ k: 'var', name: 'v0' }] } },
          {
            k: 'assign',
            name: 'v0',
            value: { k: 'bin', op: '+', l: { k: 'var', name: 'v0' }, r: { k: 'const', value: 1 } },
          },
        ],
      },
    ];
    expect(eliminateDeadStores(fn(body)).body).toEqual(body);
  });
});
