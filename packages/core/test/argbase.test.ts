// The `/argbase` lever (l3/argbase.ts): name a call's argument bases before the call.
//
// A compiler loading two fixed addresses for one call emits BOTH pool loads before either deref;
// the inline argument spelling makes it finish argument 0 first. Same instructions, different
// order, and a nonmatch. These pin the GATE and the semantics-preservation rules — the lever is
// emitted as an extra candidate, so its risk is spelling quality, not correctness of the winner.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { materializeArgBases } from '../src/l3/argbase';
import type { Expr, SFn, Stmt } from '../src/l3/ast';

const deref = (base: Expr, idx: number, width = 1): Expr => ({
  k: 'index',
  base,
  idx: { k: 'const', value: idx },
  width,
  signed: false,
});

const fnWith = (args: Expr[], globals: { name: string; type: ReturnType<typeof T.ptr> }[] = []): SFn => ({
  name: 'f',
  params: [],
  locals: [{ name: 'v0', type: T.s(32) }],
  ...(globals.length ? { globals } : {}),
  retType: T.void(),
  body: [{ k: 'assign', name: 'v0', value: { k: 'call', fn: 'callee', args } }],
});

describe('the gate', () => {
  test('TWO distinct eligible bases fire — the shape the compiler reorders', () => {
    const out = materializeArgBases(
      fnWith([deref({ k: 'const', value: 0x4000006 }, 0), deref({ k: 'addr', name: 'g' }, 8)]),
    );
    expect(out).not.toBeNull();
    expect(out!.locals.map((l) => l.name)).toEqual(['v0', 'p0', 'p1']);
    // the bases are named BEFORE the call, in first-appearance order
    expect(out!.body).toHaveLength(3);
    expect(out!.body[0]).toMatchObject({ k: 'assign', name: 'p0' });
    expect(out!.body[1]).toMatchObject({ k: 'assign', name: 'p1' });
  });

  test('ONE eligible base does NOT fire — a single hoist reproduces no reordering', () => {
    // measured: hoisting only the first base on kleod:UpdateFadeEffect left the diff at 2
    expect(
      materializeArgBases(fnWith([deref({ k: 'const', value: 0x4000006 }, 0), { k: 'const', value: 3 }])),
    ).toBeNull();
  });

  test('two derefs of the SAME base do not count twice', () => {
    const b: Expr = { k: 'addr', name: 'g' };
    expect(materializeArgBases(fnWith([deref(b, 0), deref(b, 4)]))).toBeNull();
  });

  test('a call with no argument derefs is untouched', () => {
    expect(
      materializeArgBases(
        fnWith([
          { k: 'const', value: 1 },
          { k: 'const', value: 2 },
        ]),
      ),
    ).toBeNull();
  });
});

describe('semantics preservation — only a base that cannot change under us is eligible', () => {
  test('a LOCAL base is refused: a store between the hoist point and the call would change it', () => {
    const out = materializeArgBases(fnWith([deref({ k: 'var', name: 'v0' }, 0), deref({ k: 'var', name: 'v0' }, 4)]));
    expect(out).toBeNull();
  });

  test('a declared GLOBAL base is eligible — taking its address is pure', () => {
    const g = [{ name: 'gTable', type: T.ptr(T.u(8)) }];
    const out = materializeArgBases(
      fnWith([deref({ k: 'var', name: 'gTable' }, 0), deref({ k: 'const', value: 0x4000006 }, 0)], g),
    );
    expect(out).not.toBeNull();
  });

  test('the hoisted local carries the ACCESS pointer type, so each use strides correctly', () => {
    const out = materializeArgBases(
      fnWith([deref({ k: 'const', value: 0x4000006 }, 0, 2), deref({ k: 'addr', name: 'g' }, 8, 2)]),
    )!;
    expect(out.locals.find((l) => l.name === 'p0')!.type).toEqual(T.ptr(T.u(16)));
  });
});

describe('statement placement — the rewrite must not MOVE or DUPLICATE statements', () => {
  // Both of these compiled and looked plausible; neither boundary contract checks placement.
  // They came from rebuilding a statement out of a flattened `stmtChildren` list, which cannot
  // work: inserting the naming statements shifts the boundary a rebuild would have to split at,
  // and `stmtChildren('for')` is `[init, inc, ...body]` — not a body.
  const CALL: Expr = {
    k: 'call',
    fn: 'callee',
    args: [deref({ k: 'const', value: 0x4000006 }, 0), deref({ k: 'addr', name: 'g' }, 8)],
  };

  test('a call in the THEN branch stays in the THEN branch', () => {
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      retType: T.void(),
      body: [
        {
          k: 'if',
          cond: { k: 'var', name: 'c' },
          then: [
            { k: 'assign', name: 'hit', value: CALL },
            { k: 'assign', name: 'alsoThen', value: { k: 'const', value: 1 } },
          ],
          else: [{ k: 'assign', name: 'onlyElse', value: { k: 'const', value: 2 } }],
        },
      ],
    };
    const s = materializeArgBases(fn)!.body[0] as Extract<Stmt, { k: 'if' }>;
    // naming first, then the call, then the rest of the branch — and the else untouched
    expect(s.then.map((x) => (x as { name?: string }).name)).toEqual(['p0', 'p1', 'hit', 'alsoThen']);
    expect(s.else.map((x) => (x as { name?: string }).name)).toEqual(['onlyElse']);
  });

  test('a `for` keeps its init and inc, and does not copy them into the body', () => {
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      retType: T.void(),
      body: [
        {
          k: 'for',
          init: { k: 'assign', name: 'i', value: { k: 'const', value: 0 } },
          cond: { k: 'var', name: 'c' },
          inc: { k: 'assign', name: 'i', value: { k: 'const', value: 1 } },
          body: [{ k: 'assign', name: 'hit', value: CALL }],
        },
      ],
    };
    const s = materializeArgBases(fn)!.body[0] as Extract<Stmt, { k: 'for' }>;
    expect(s.init).toMatchObject({ k: 'assign', name: 'i' });
    expect(s.inc).toMatchObject({ k: 'assign', name: 'i' });
    expect(s.body.map((x) => (x as { name?: string }).name)).toEqual(['p0', 'p1', 'hit']);
  });

  test('EVERY use of one base points at the same local, not just the first', () => {
    const g: Expr = { k: 'addr', name: 'g' };
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      retType: T.void(),
      body: [
        {
          k: 'exprstmt',
          value: {
            k: 'call',
            fn: 'callee',
            args: [deref(g, 0), deref(g, 4), deref({ k: 'const', value: 0x4000006 }, 0)],
          },
        },
      ],
    };
    const out = materializeArgBases(fn)!;
    const args = (out.body[out.body.length - 1] as Extract<Stmt, { k: 'exprstmt' }>).value as Extract<
      Expr,
      { k: 'call' }
    >;
    expect(args.args.map((a) => ((a as Extract<Expr, { k: 'index' }>).base as { name: string }).name)).toEqual([
      'p0',
      'p0',
      'p1',
    ]);
  });

  test('a hoist local never shadows a CALLED function name', () => {
    // basecse.ts added this guard in its own audit; re-implementing the name collector lost it.
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      retType: T.void(),
      body: [
        {
          k: 'exprstmt',
          value: {
            k: 'call',
            fn: 'p0',
            args: [deref({ k: 'const', value: 0x4000006 }, 0), deref({ k: 'addr', name: 'g' }, 8)],
          },
        },
      ],
    };
    expect(materializeArgBases(fn)!.locals.map((l) => l.name)).not.toContain('p0');
  });
});

describe('a LOOP condition is left alone — `pre` before the loop would be a loop-invariant hoist', () => {
  test('a call in a `while` condition does not name its bases outside the loop', () => {
    // `pre` lands BEFORE the statement, so naming a loop-condition's bases would hoist them out
    // of the loop entirely — a live range the original never had, which is the register-pressure
    // failure basecse.ts's `inLoop` gate exists to refuse, and a contradiction of this pass's own
    // placement rule.
    const CALL: Expr = {
      k: 'call',
      fn: 'callee',
      args: [deref({ k: 'const', value: 0x4000006 }, 0), deref({ k: 'addr', name: 'g' }, 8)],
    };
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      retType: T.void(),
      body: [{ k: 'while', cond: CALL, body: [{ k: 'assign', name: 'x', value: { k: 'const', value: 1 } }] }],
    };
    expect(materializeArgBases(fn)).toBeNull();
  });

  test('a call in a loop BODY still fires — only the condition is excluded', () => {
    const CALL: Expr = {
      k: 'call',
      fn: 'callee',
      args: [deref({ k: 'const', value: 0x4000006 }, 0), deref({ k: 'addr', name: 'g' }, 8)],
    };
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      retType: T.void(),
      body: [{ k: 'while', cond: { k: 'var', name: 'c' }, body: [{ k: 'assign', name: 'x', value: CALL }] }],
    };
    const out = materializeArgBases(fn)!;
    expect(out.body).toHaveLength(1); // nothing hoisted OUT of the loop
    expect((out.body[0] as Extract<Stmt, { k: 'while' }>).body.map((s) => (s as { name?: string }).name)).toEqual([
      'p0',
      'p1',
      'x',
    ]);
  });
});

describe("a multidimensional array global's access is not nameable through a plain `T *`", () => {
  test('an `index` carrying `lead` is refused', () => {
    // `gGrid[0][i]` is an `index` with `lead: [0]` on a `var` base, which eligibleBase admits.
    // Naming it produces `p0 = (u8 *)gGrid; p0[0][i]` — `p0[0]` is a `u8`, so subscripting it is
    // a C error. Neither boundary contract catches it (the base strides 1, so cfamily's guard
    // does not fire) and the candidate dies at the compiler. reindex.ts and cfamily.ts each
    // carry an explicit refusal for this shape; this is the third.
    const leadIdx: Expr = {
      k: 'index',
      base: { k: 'var', name: 'gGrid' },
      idx: { k: 'const', value: 3 },
      width: 1,
      signed: false,
      lead: [{ k: 'const', value: 0 }],
    };
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      globals: [{ name: 'gGrid', type: T.ptr(T.u(8)) }],
      retType: T.void(),
      body: [
        {
          k: 'exprstmt',
          value: { k: 'call', fn: 'callee', args: [leadIdx, deref({ k: 'const', value: 0x4000006 }, 0)] },
        },
      ],
    };
    expect(materializeArgBases(fn)).toBeNull();
  });
});

describe('one address, two spellings, one local', () => {
  test('`&g` and a bare `g` are the SAME address for the gate', () => {
    // A global reaches this pass as `addr g` or, when the map types it as an array of the access
    // width, as a bare `var g`. Counting them as two addresses would pass the gate on a shape
    // where nothing reorders — the churn the gate exists to reject, by another route.
    const fn: SFn = {
      name: 'f',
      params: [],
      locals: [],
      globals: [{ name: 'gA', type: T.ptr(T.u(8)) }],
      retType: T.void(),
      body: [
        {
          k: 'exprstmt',
          value: {
            k: 'call',
            fn: 'callee',
            args: [deref({ k: 'addr', name: 'gA' }, 0), deref({ k: 'var', name: 'gA' }, 4)],
          },
        },
      ],
    };
    expect(materializeArgBases(fn)).toBeNull();
  });
});
