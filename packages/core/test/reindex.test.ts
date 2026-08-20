// The walk→index re-spelling (l3/reindex.ts) — the third differ-ranked lever. Pins: the golden
// while-walk re-spells with the bound simplified; every out-of-scope shape DECLINES (returns
// null) rather than approximating; the transform never mutates its input.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { reindexWalks } from '../src/l3/reindex';
import { volatilePtrLocals } from '../src/l3/volatileptr';

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

// ── v2: the guarded countdown ────────────────────────────────────────────────────────────────

/** The agbcc shape for `for(i=0;i<n;i++) if(a[i]>0) c++;`:
 *  `if (0 >= a1) { v1 = 0; } else { v0 = a0; v1 = 0; v2 = a1;
 *   do { if (*v0 > 0) v1 = v1 + 1; v0 = v0 + 1; v2 = v2 - 1; } while (v2 != 0); } return v1;` */
function guardedCountdown(mut?: (body: Stmt[], fn: SFn) => void): SFn {
  const body: Stmt[] = [
    {
      k: 'if',
      cond: { k: 'bin', op: '>=', l: C(0), r: V('a1') },
      then: [{ k: 'assign', name: 'v1', value: C(0) }],
      else: [
        { k: 'assign', name: 'v0', value: V('a0') },
        { k: 'assign', name: 'v1', value: C(0) },
        { k: 'assign', name: 'v2', value: V('a1') },
        {
          k: 'dowhile',
          cond: { k: 'bin', op: '!=', l: V('v2'), r: C(0) },
          body: [
            {
              k: 'if',
              cond: { k: 'bin', op: '>', l: deref('v0'), r: C(0) },
              then: [{ k: 'assign', name: 'v1', value: { k: 'bin', op: '+', l: V('v1'), r: C(1) } }],
              else: [],
            },
            step('v0'),
            { k: 'assign', name: 'v2', value: { k: 'bin', op: '-', l: V('v2'), r: C(1) } },
          ],
        },
      ],
    },
    { k: 'return', value: V('v1') },
  ];
  const fn: SFn = {
    name: 'countpos',
    retType: T.s(32),
    params: [
      { name: 'a0', type: T.ptr(T.s(32)) },
      { name: 'a1', type: T.s(32) },
    ],
    locals: [
      { name: 'v0', type: T.ptr(T.s(32)) },
      { name: 'v1', type: T.s(32) },
      { name: 'v2', type: T.s(32) },
    ],
    body,
  };
  mut?.(body, fn);
  return fn;
}

describe('v2 — the guarded countdown re-spells as a counted for', () => {
  test('the golden shape: guard and skip arm disappear, walk keeps its init, counter becomes the iv', () => {
    const out = reindexWalks(guardedCountdown());
    expect(out).not.toBeNull();
    const c = cBackend.emit(out!);
    expect(c).toContain('v0 = a0;');
    expect(c).toContain('v1 = 0;');
    expect(c).toContain('for (i0 = 0; i0 < a1; i0 = i0 + 1)');
    expect(c).toContain('v0[i0]');
    // the counter's uses are gone (its dead declaration survives, like every retired v1 walk var)
    expect(c).not.toContain('v2 =');
    expect(c).not.toContain('do {');
    expect(c).not.toContain('else');
  });

  test('a numeric walk base is kept as the local, not inlined', () => {
    const out = reindexWalks(
      guardedCountdown((body) => {
        const els = (body[0] as Stmt & { k: 'if' }).else;
        els[0] = { k: 'assign', name: 'v0', value: { k: 'cast', to: T.ptr(T.s(32)), e: C(0x3000010) } };
      }),
    );
    expect(cBackend.emit(out!)).toContain('v0 = (s32 *)50331664;');
  });

  test('the input SFn is never mutated', () => {
    const fn = guardedCountdown();
    const before = JSON.stringify(fn);
    reindexWalks(fn);
    expect(JSON.stringify(fn)).toBe(before);
  });

  describe('declines', () => {
    const declined = (mut: (body: Stmt[], fn: SFn) => void): void => {
      expect(reindexWalks(guardedCountdown(mut))).toBeNull();
    };

    test('the counter read after the loop (no single trip count owns its exit value)', () => {
      declined((body) => {
        body[1] = { k: 'return', value: V('v2') };
      });
    });

    test("a skip arm that is not the else arm's loop-preceding statements", () => {
      declined((body) => {
        (body[0] as Stmt & { k: 'if' }).then = [{ k: 'assign', name: 'v1', value: C(7) }];
      });
    });

    test('a guard testing a DIFFERENT var than the counter init', () => {
      declined((body) => {
        (body[0] as Stmt & { k: 'if' }).cond = { k: 'bin', op: '>=', l: C(0), r: V('v1') };
      });
    });

    test('a bound assigned inside the function (a moving trip count)', () => {
      declined((body) => {
        body.unshift({ k: 'assign', name: 'a1', value: C(4) });
      });
    });

    test('a break in the body: the original steps sit in the tail a continue/break skips', () => {
      declined((body) => {
        const dw = (body[0] as Stmt & { k: 'if' }).else[3] as Stmt & { k: 'dowhile' };
        ((dw.body[0] as Stmt & { k: 'if' }).then as Stmt[]).push({ k: 'break' });
      });
    });

    test('a deref width disagreeing with the walk stride', () => {
      declined((body) => {
        const dw = (body[0] as Stmt & { k: 'if' }).else[3] as Stmt & { k: 'dowhile' };
        const inner = dw.body[0] as Stmt & { k: 'if' };
        inner.cond = {
          k: 'bin',
          op: '>',
          l: { k: 'index', base: V('v0'), idx: C(0), width: 1, signed: false },
          r: C(0),
        };
      });
    });

    test('a do-while exit that is not `k != 0`', () => {
      declined((body) => {
        const dw = (body[0] as Stmt & { k: 'if' }).else[3] as Stmt & { k: 'dowhile' };
        dw.cond = { k: 'bin', op: '>', l: V('v2'), r: C(0) };
      });
    });
  });
});

describe('the counter is policed in EVERY role (each shape reproduced as a wrong-values rewrite before the gate)', () => {
  const declined = (mut: (body: Stmt[], fn: SFn) => void): void => {
    expect(reindexWalks(guardedCountdown(mut))).toBeNull();
  };
  const dw = (body: Stmt[]): Stmt & { k: 'dowhile' } =>
    (body[0] as Stmt & { k: 'if' }).else[3] as Stmt & { k: 'dowhile' };

  test('the body reads the counter (`*p = k` — a countdown store)', () => {
    declined((body) => {
      dw(body).body[0] = { k: 'store', lval: deref('v0'), value: V('v2') };
    });
  });

  test('a leftover reads the counter (its init is what the rewrite deletes)', () => {
    declined((body) => {
      const iff = body[0] as Stmt & { k: 'if' };
      const extra: Stmt = { k: 'assign', name: 'v1', value: { k: 'bin', op: '+', l: V('v2'), r: C(5) } };
      iff.then = [extra];
      iff.else = [iff.else[0], iff.else[2], extra, iff.else[3]];
    });
  });

  test('a second decrement in the body core', () => {
    declined((body) => {
      dw(body).body.splice(1, 0, { k: 'assign', name: 'v2', value: { k: 'bin', op: '-', l: V('v2'), r: C(1) } });
    });
  });

  test('a nested p-free loop reading the counter', () => {
    declined((body) => {
      dw(body).body[0] = {
        k: 'while',
        cond: { k: 'bin', op: '<', l: V('v1'), r: V('v2') },
        body: [{ k: 'assign', name: 'v1', value: { k: 'bin', op: '+', l: V('v1'), r: C(1) } }],
      };
    });
  });

  test('a pointer-typed counter declines on TYPE — its decrement strides elements, not iterations', () => {
    // the ordinary-decrement spelling, no self-step: only the type is wrong
    declined((_body, fn) => {
      fn.locals[2] = { name: 'v2', type: T.ptr(T.s(32)) };
    });
  });

  test('a pointer-typed counter stepping itself is not a walk of itself', () => {
    declined((body, fn) => {
      fn.locals[2] = { name: 'v2', type: T.ptr(T.s(32)) };
      dw(body).body.splice(1, 0, step('v2'));
    });
  });

  test('two steps of one pointer in the tail', () => {
    declined((body) => {
      dw(body).body.push(step('v0'));
    });
  });
});

describe('the remaining stated gates, pinned', () => {
  const declined = (mut: (body: Stmt[], fn: SFn) => void): void => {
    expect(reindexWalks(guardedCountdown(mut))).toBeNull();
  };

  test('a continue in the body (the original steps sit in a tail a continue skips)', () => {
    declined((body) => {
      const dw = (body[0] as Stmt & { k: 'if' }).else[3] as Stmt & { k: 'dowhile' };
      ((dw.body[0] as Stmt & { k: 'if' }).then as Stmt[]).push({ k: 'continue' });
    });
  });

  test('a guard in the ENTERING sense with the loop in the else arm', () => {
    declined((body) => {
      (body[0] as Stmt & { k: 'if' }).cond = { k: 'bin', op: '<', l: C(0), r: V('a1') };
    });
  });

  test('a walk pointer mentioned after the if', () => {
    declined((body) => {
      body.push({ k: 'return', value: deref('v0') });
    });
  });

  test('the loop in the THEN arm accepts with the entering guard sense', () => {
    const out = reindexWalks(
      guardedCountdown((body) => {
        const iff = body[0] as Stmt & { k: 'if' };
        iff.cond = { k: 'bin', op: '<', l: C(0), r: V('a1') };
        const loopArm = iff.else;
        iff.else = iff.then;
        iff.then = loopArm;
      }),
    );
    expect(out).not.toBeNull();
    expect(cBackend.emit(out!)).toContain('for (i0 = 0; i0 < a1; i0 = i0 + 1)');
  });

  test('two walk pointers share the one counter (the dotprod shape)', () => {
    const out = reindexWalks(
      guardedCountdown((body, fn) => {
        fn.params.push({ name: 'a2', type: T.ptr(T.s(32)) });
        fn.locals.push({ name: 'v3', type: T.ptr(T.s(32)) });
        const iff = body[0] as Stmt & { k: 'if' };
        const dw = iff.else[3] as Stmt & { k: 'dowhile' };
        iff.else.splice(1, 0, { k: 'assign', name: 'v3', value: V('a2') });
        dw.body[0] = {
          k: 'assign',
          name: 'v1',
          value: { k: 'bin', op: '+', l: V('v1'), r: { k: 'bin', op: '*', l: deref('v0'), r: deref('v3') } },
        };
        dw.body.splice(1, 0, step('v3'));
      }),
    );
    expect(out).not.toBeNull();
    const c = cBackend.emit(out!);
    expect(c).toContain('v0[i0]');
    expect(c).toContain('v3[i0]');
  });
});

test('the /indexed/volatile product: the kept numeric base qualifies for the volatile lever', () => {
  const indexed = reindexWalks(
    guardedCountdown((body) => {
      const els = (body[0] as Stmt & { k: 'if' }).else;
      els[0] = { k: 'assign', name: 'v0', value: { k: 'cast', to: T.ptr(T.s(32)), e: C(0x3000010) } };
    }),
  );
  expect(indexed).not.toBeNull();
  const vol = volatilePtrLocals(indexed!);
  expect(vol?.locals.find((l) => l.name === 'v0')?.pointeeVolatile).toBe(true);
});

test('keptWalks collects the walk-pointer names a fired loop kept as its base', () => {
  const kept = new Set<string>();
  expect(reindexWalks(guardedCountdown(), kept)).not.toBeNull();
  expect(kept).toEqual(new Set(['v0']));
});
