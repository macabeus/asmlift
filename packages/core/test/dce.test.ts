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

  // A JUMP DOES NOT FALL THROUGH. The live set at a `break` is what the loop's exit reads, and at a
  // `continue` what the next test and iteration read — not what the statements after the enclosing
  // `if` read. Those overwrite `v0` below, so a fall-through walk judged the carried copy dead.
  const v0 = { k: 'var', name: 'v0' } as const;
  const v1 = { k: 'var', name: 'v1' } as const;
  const leave = (jump: 'break' | 'continue'): Stmt => ({
    k: 'if',
    cond: { k: 'call', fn: 'f', args: [v1] },
    then: [{ k: 'assign', name: 'v0', value: v1 }, { k: jump }],
    else: [],
  });
  const overwrite: Stmt = { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: v1, r: { k: 'const', value: 2 } } };

  test("a copy a mid-body `break` carries to the loop's exit is kept", () => {
    // while (v1 < 9) { if (f(v1)) { v0 = v1; break; } v0 = v1 + 2; v1 = g(v0); } return v0;
    const body: Stmt[] = [
      {
        k: 'while',
        cond: { k: 'bin', op: '<', l: v1, r: { k: 'const', value: 9 } },
        body: [leave('break'), overwrite, { k: 'assign', name: 'v1', value: { k: 'call', fn: 'g', args: [v0] } }],
      },
      { k: 'return', value: v0 },
    ];
    expect(eliminateDeadStores(fn(body, ['v0', 'v1'])).body).toEqual(body);
  });

  test('a copy a mid-body `continue` carries to the next test is kept', () => {
    // while (v0 != 0) { if (f(v1)) { v0 = v1; continue; } v0 = v1 + 2; }
    const body: Stmt[] = [
      {
        k: 'while',
        cond: { k: 'bin', op: '!=', l: v0, r: { k: 'const', value: 0 } },
        body: [leave('continue'), overwrite],
      },
    ];
    expect(eliminateDeadStores(fn(body, ['v0', 'v1'])).body).toEqual(body);
  });

  test('CONTROL: the same copy with no jump after it is dead', () => {
    // while (v1 < 9) { if (f(v1)) { v0 = v1; } v0 = v1 + 2; v1 = g(v0); } return v0;
    const out = eliminateDeadStores(
      fn(
        [
          {
            k: 'while',
            cond: { k: 'bin', op: '<', l: v1, r: { k: 'const', value: 9 } },
            body: [
              {
                k: 'if',
                cond: { k: 'call', fn: 'f', args: [v1] },
                then: [{ k: 'assign', name: 'v0', value: v1 }],
                else: [],
              },
              overwrite,
              { k: 'assign', name: 'v1', value: { k: 'call', fn: 'g', args: [v0] } },
            ],
          },
          { k: 'return', value: v0 },
        ],
        ['v0', 'v1'],
      ),
    );
    expect(JSON.stringify(out.body)).not.toContain('"then":[{"k":"assign"');
  });
});

// AN ADDRESS-TAKEN LOCAL is never a dead store, whatever its qualifiers. This walk is BACKWARD, so
// the `addr`-as-read pin only protects the stores UPSTREAM of an `&sp0`; publish-then-fill puts one
// downstream. The rule used to key on `volatile`, which the frontend stamps only where the address
// is published to memory (the DMA idiom) — an ordinary `&local` argument carries no qualifier in
// any source, and its store must survive here just the same.
describe('an address-taken local is never a dead store', () => {
  const publishThenFill: Stmt[] = [
    { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'sp0' }] } },
    { k: 'assign', name: 'sp0', value: { k: 'const', value: 5 } },
  ];

  test('a store AFTER the last `&sp0` survives without the volatile qualifier', () => {
    expect(eliminateDeadStores(fn(publishThenFill, ['sp0'])).body).toEqual(publishThenFill);
  });

  test('CONTROL: the same store to a local whose address is never taken is dead', () => {
    const body: Stmt[] = [
      { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [] } },
      { k: 'assign', name: 'sp0', value: { k: 'const', value: 5 } },
    ];
    expect(eliminateDeadStores(fn(body, ['sp0'])).body).toEqual([body[0]]);
  });
});
