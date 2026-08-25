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

test('keptWalks collects the v1 while-walk base (here a param — harmless to the volatile lever)', () => {
  const kept = new Set<string>();
  expect(reindexWalks(walkSum(), kept)).not.toBeNull();
  expect(kept).toEqual(new Set(['a0']));
});

// ── v3: the up-counting byte walk with an expression base ─────────────────────────────────────
describe('v3 — expression-base byte walk', () => {
  const u8p = { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } } as const;
  const s32t = { kind: 'int', width: 32, signed: true } as const;
  const v = (name: string): Expr => ({ k: 'var', name });
  const cn = (value: number): Expr => ({ k: 'const', value });
  const inc = (name: string): Stmt => ({ k: 'assign', name, value: { k: 'bin', op: '+', l: v(name), r: cn(1) } });
  const derefP: Expr = { k: 'index', base: v('p'), idx: cn(0), width: 1, signed: false };
  const mkFn = (init: Expr, body: Stmt[], tail: Stmt[] = []): SFn => ({
    name: 'f',
    params: [
      { name: 'a0', type: s32t },
      { name: 'a1', type: s32t },
      { name: 'a2', type: s32t },
    ],
    locals: [
      { name: 'p', type: u8p as never },
      { name: 'i', type: s32t },
    ],
    retType: s32t,
    body: [
      { k: 'assign', name: 'i', value: cn(0) },
      { k: 'assign', name: 'p', value: init },
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '<', l: v('i'), r: v('a2') },
        body,
      },
      ...tail,
    ],
  });
  const walkBody = (): Stmt[] => [
    { k: 'store', lval: { k: 'index', base: v('a1'), idx: v('i'), width: 1, signed: false }, value: derefP },
    inc('p'),
    inc('i'),
  ];
  const init: Expr = {
    k: 'cast',
    to: u8p as never,
    e: { k: 'bin', op: '+', l: { k: 'bin', op: '*', l: v('a2'), r: v('a1') }, r: v('a0') },
  };

  test('the walk deletes into BASE[i + REST], counter first in the index sum', () => {
    const r = reindexWalks(mkFn(init, walkBody()));
    expect(r).not.toBeNull();
    const src = JSON.stringify(r!.body);
    expect(src).not.toContain('"name":"p"');
    // idx = i + a2*a1, base = a0 — the sole bare-var addend
    expect(src).toContain(
      '{"k":"index","base":{"k":"var","name":"a0"},"idx":{"k":"bin","op":"+","l":{"k":"var","name":"i"},"r":{"k":"bin","op":"*","l":{"k":"var","name":"a2"},"r":{"k":"var","name":"a1"}}},"width":1,"signed":false}',
    );
  });

  test('refused: a counter starting anywhere but 0 (the index counts completed steps)', () => {
    const f = mkFn(init, walkBody());
    (f.body[0] as Extract<Stmt, { k: 'assign' }>).value = cn(5);
    expect(reindexWalks(f)).toBeNull();
  });

  test('refused: a step ahead of a deref (the *++p walk reads the NEXT element)', () => {
    const preStep: Stmt[] = [
      inc('p'),
      { k: 'store', lval: { k: 'index', base: v('a1'), idx: v('i'), width: 1, signed: false }, value: derefP },
      inc('i'),
    ];
    expect(reindexWalks(mkFn(init, preStep))).toBeNull();
  });

  test('refused: derefs straddling the step collapse two addresses onto one index', () => {
    const straddle: Stmt[] = [
      { k: 'store', lval: { k: 'index', base: v('a1'), idx: v('i'), width: 1, signed: false }, value: derefP },
      inc('p'),
      { k: 'store', lval: { k: 'index', base: v('a2'), idx: v('i'), width: 1, signed: false }, value: derefP },
      inc('i'),
    ];
    expect(reindexWalks(mkFn(init, straddle))).toBeNull();
  });

  test('refused: a second write to the counter hiding in a nested arm', () => {
    const reset: Stmt = {
      k: 'if',
      cond: { k: 'bin', op: '==', l: v('i'), r: cn(3) },
      then: [{ k: 'assign', name: 'i', value: cn(1) }],
      else: [],
    };
    const body: Stmt[] = [
      { k: 'store', lval: { k: 'index', base: v('a1'), idx: v('i'), width: 1, signed: false }, value: derefP },
      reset,
      inc('p'),
      inc('i'),
    ];
    expect(reindexWalks(mkFn(init, body))).toBeNull();
  });

  test('refused: a GLOBAL wide-pointer base strides its element, and an undeclared base is unknowable', () => {
    const gInit: Expr = {
      k: 'cast',
      to: u8p as never,
      e: { k: 'bin', op: '+', l: { k: 'bin', op: '*', l: v('a2'), r: v('a1') }, r: v('gW') },
    };
    const wide = mkFn(gInit, walkBody());
    wide.globals = [{ name: 'gW', type: { kind: 'ptr', to: { kind: 'int', width: 32, signed: true } } as never }];
    expect(reindexWalks(wide)).toBeNull();
    const undeclared = mkFn(gInit, walkBody()); // gW declared nowhere
    expect(reindexWalks(undeclared)).toBeNull();
  });

  test('refused: two bare-var addends leave the base ambiguous', () => {
    const twoVars: Expr = {
      k: 'cast',
      to: u8p as never,
      e: { k: 'bin', op: '+', l: v('a1'), r: v('a0') },
    };
    expect(reindexWalks(mkFn(twoVars, walkBody()))).toBeNull();
  });

  test('refused: the pointer is read after the loop', () => {
    const r = reindexWalks(
      mkFn(init, walkBody(), [{ k: 'return', value: { k: 'cast', to: s32t as never, e: v('p') } }]),
    );
    expect(r).toBeNull();
  });

  test('refused: a wider deref would stride differently', () => {
    const wide: Stmt[] = [
      {
        k: 'store',
        lval: { k: 'index', base: v('a1'), idx: v('i'), width: 1, signed: false },
        value: { k: 'index', base: v('p'), idx: cn(0), width: 4, signed: false },
      },
      inc('p'),
      inc('i'),
    ];
    expect(reindexWalks(mkFn(init, wide))).toBeNull();
  });
});

// ── v4: the unguarded constant-trip countdown ────────────────────────────────────────────────

/** The agbcc shape for `for(i=0;i<8;i++) s += p[i];` — a literal bound needs no zero-trip guard:
 *  `v1 = a0; v0 = 0; v2 = 7; do { v0 = v0 + *v1; v1 = v1 + 1; v2 = v2 - 1; } while (v2 >= 0);` */
function constCountdown(mut?: (fn: SFn) => void): SFn {
  const fn: SFn = {
    name: 'sum8',
    retType: T.s(32),
    params: [{ name: 'a0', type: T.ptr(T.s(32)) }],
    locals: [
      { name: 'v0', type: T.s(32) },
      { name: 'v1', type: T.ptr(T.s(32)) },
      { name: 'v2', type: T.s(32) },
    ],
    body: [
      { k: 'assign', name: 'v1', value: V('a0') },
      { k: 'assign', name: 'v0', value: C(0) },
      { k: 'assign', name: 'v2', value: C(7) },
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '>=', l: V('v2'), r: C(0) },
        body: [
          { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: V('v0'), r: deref('v1') } },
          step('v1'),
          { k: 'assign', name: 'v2', value: { k: 'bin', op: '-', l: V('v2'), r: C(1) } },
        ],
      },
      { k: 'return', value: V('v0') },
    ],
  };
  mut?.(fn);
  return fn;
}

/** The loop statement of a `constCountdown` fixture, for mutators. */
const cdLoop = (fn: SFn): Stmt & { k: 'dowhile' } => fn.body[3] as Stmt & { k: 'dowhile' };

describe('v4 — the unguarded constant-trip countdown re-spells as a counted for', () => {
  test('the golden shape: the counter init disappears, the walk keeps its init, C becomes C + 1', () => {
    const out = reindexWalks(constCountdown());
    expect(out).not.toBeNull();
    const c = cBackend.emit(out!);
    expect(c).toContain('v1 = a0;');
    expect(c).toContain('v0 = 0;');
    expect(c).toContain('for (i0 = 0; i0 < 8; i0 = i0 + 1)');
    expect(c).toContain('v1[i0]');
    expect(c).not.toContain('v2 =');
    expect(c).not.toContain('do {');
  });

  test('the input SFn is never mutated', () => {
    const sfn = constCountdown();
    const before = JSON.stringify(sfn);
    reindexWalks(sfn);
    expect(JSON.stringify(sfn)).toBe(before);
  });

  test('refused: an UNSIGNED counter — `k >= 0` would never end the loop', () => {
    expect(reindexWalks(constCountdown((fn) => (fn.locals[2].type = T.u(32))))).toBeNull();
  });

  test('refused: a negative constant — `k = -1` runs the body once, not C + 1 times', () => {
    expect(reindexWalks(constCountdown((fn) => ((fn.body[2] as Stmt & { k: 'assign' }).value = C(-1))))).toBeNull();
  });

  test('refused: a variable trip count (that shape carries a guard — v2 owns it)', () => {
    expect(
      reindexWalks(
        constCountdown((fn) => {
          fn.params.push({ name: 'a1', type: T.s(32) });
          (fn.body[2] as Stmt & { k: 'assign' }).value = V('a1');
        }),
      ),
    ).toBeNull();
  });

  test('refused: the `!= 0` exit — an unguarded loop with it counts one iteration fewer', () => {
    expect(reindexWalks(constCountdown((fn) => (cdLoop(fn).cond = { k: 'bin', op: '!=', l: V('v2'), r: C(0) })))).toBe(
      null,
    );
  });

  test('refused: a break in the body', () => {
    expect(reindexWalks(constCountdown((fn) => cdLoop(fn).body.unshift({ k: 'break' })))).toBeNull();
  });

  test('refused: the counter is read a fifth time (`*p = k`)', () => {
    expect(
      reindexWalks(constCountdown((fn) => cdLoop(fn).body.unshift({ k: 'store', lval: deref('v1'), value: V('v2') }))),
    ).toBeNull();
  });

  test('refused: the walk pointer is read after the loop', () => {
    expect(
      reindexWalks(constCountdown((fn) => fn.body.splice(4, 0, { k: 'store', lval: deref('v1'), value: C(0) }))),
    ).toBeNull();
  });

  test('refused: a wider deref would stride differently', () => {
    expect(
      reindexWalks(
        constCountdown((fn) => {
          (cdLoop(fn).body[0] as Stmt & { k: 'assign' }).value = {
            k: 'bin',
            op: '+',
            l: V('v0'),
            r: { k: 'index', base: V('v1'), idx: C(0), width: 1, signed: false },
          };
        }),
      ),
    ).toBeNull();
  });
});

test('v4 refused: C + 1 would not fit a positive s32 — the bound would wrap negative', () => {
  expect(reindexWalks(constCountdown((fn) => ((fn.body[2] as Stmt & { k: 'assign' }).value = C(0x7fffffff))))).toBe(
    null,
  );
  // one below the edge still re-spells
  expect(reindexWalks(constCountdown((fn) => ((fn.body[2] as Stmt & { k: 'assign' }).value = C(0x7ffffffe))))).not.toBe(
    null,
  );
});

// ── the shared countdown gate: what the counter may BE ────────────────────────────────────────

/** `v1 = a0; gCount = 7; do { *v1 = 0; v1 += 1; gCount -= 1; } while (gCount >= 0);`
 *  — a bare scalar GLOBAL in the counter's place. structure.ts spells a store to one as an
 *  `assign`, so it arrives here shaped exactly like a local counter. */
const globalCounter: SFn = {
  name: 'clr',
  retType: T.void(),
  params: [{ name: 'a0', type: T.ptr(T.s(32)) }],
  locals: [{ name: 'v1', type: T.ptr(T.s(32)) }],
  globals: [{ name: 'gCount', type: T.s(32) }],
  body: [
    { k: 'assign', name: 'v1', value: V('a0') },
    { k: 'assign', name: 'gCount', value: C(7) },
    {
      k: 'dowhile',
      cond: { k: 'bin', op: '>=', l: V('gCount'), r: C(0) },
      body: [
        { k: 'store', lval: deref('v1'), value: C(0) },
        step('v1'),
        { k: 'assign', name: 'gCount', value: { k: 'bin', op: '-', l: V('gCount'), r: C(1) } },
      ],
    },
  ],
};

test('the counter may not be a GLOBAL — the rewrite would stop writing a value other TUs observe', () => {
  expect(reindexWalks(globalCounter)).toBeNull();
});

test('v4 refused: C + 1 must fit the COUNTER, not just an s32 — 200 in an s8 is -56', () => {
  // the countdown runs the body ONCE (the s8 counter is negative at the first test); `i < 201`
  // would run it 201 times and walk 200 words past the buffer
  expect(
    reindexWalks(
      constCountdown((fn) => {
        fn.locals[2].type = T.s(8);
        (fn.body[2] as Stmt & { k: 'assign' }).value = C(200);
      }),
    ),
  ).toBeNull();
  // the same s8 counter within range still re-spells
  expect(
    reindexWalks(
      constCountdown((fn) => {
        fn.locals[2].type = T.s(8);
        (fn.body[2] as Stmt & { k: 'assign' }).value = C(100);
      }),
    ),
  ).not.toBeNull();
});

test('a v2 loop that declines on its skip arm mints nothing: no dead iv, no kept walk', () => {
  // the guarded countdown's skip arm does NOT equal the else arm's leftovers, so v2 declines —
  // while an ordinary v1 while-walk in the same function fires and takes the FIRST iv name
  const fn = guardedCountdown((body) => {
    (body[0] as Stmt & { k: 'if' }).then = [{ k: 'assign', name: 'v1', value: C(7) }];
  });
  fn.params.push({ name: 'a2', type: T.ptr(T.s(32)) });
  fn.locals.push({ name: 'v3', type: T.ptr(T.s(32)) }, { name: 'v4', type: T.s(32) });
  fn.body.splice(
    1,
    0,
    { k: 'assign', name: 'v4', value: C(0) },
    { k: 'assign', name: 'v3', value: V('a2') },
    {
      k: 'while',
      cond: { k: 'bin', op: '<', l: V('v3'), r: { k: 'bin', op: '+', l: V('a2'), r: V('a1') } },
      body: [{ k: 'assign', name: 'v4', value: { k: 'bin', op: '+', l: V('v4'), r: deref('v3') } }, step('v3')],
    },
  );
  const kept = new Set<string>();
  const out = reindexWalks(fn, kept)!;
  expect(out).not.toBeNull();
  const c = cBackend.emit(out);
  expect(c).toContain('while (i0 < a1)'); // the walk that FIRED took the first name
  expect(c).not.toContain('i1'); // …and nothing minted a second
  expect(kept).toEqual(new Set(['a2'])); // not `v0`, the declined countdown's walk pointer
});

test('v4 refused: a deref standing AFTER the step reads the next element', () => {
  expect(
    reindexWalks(constCountdown((fn) => cdLoop(fn).body.splice(2, 0, { k: 'store', lval: deref('v1'), value: C(0) }))),
  ).toBeNull();
});

test('v4 inside an outer loop: the counter re-inits per outer iteration, so the `for` does too', () => {
  const inner = constCountdown();
  const fn: SFn = {
    ...inner,
    locals: [...inner.locals, { name: 'v3', type: T.s(32) }],
    body: [
      { k: 'assign', name: 'v3', value: C(0) },
      {
        k: 'while',
        cond: { k: 'bin', op: '<', l: V('v3'), r: C(4) },
        body: [
          ...inner.body.slice(0, 4),
          { k: 'assign', name: 'v3', value: { k: 'bin', op: '+', l: V('v3'), r: C(1) } },
        ],
      },
      { k: 'return', value: V('v0') },
    ],
  };
  const c = cBackend.emit(reindexWalks(fn)!);
  expect(c).toContain('while (v3 < 4) {');
  expect(c).toContain('v1 = a0;');
  expect(c).toContain('for (i0 = 0; i0 < 8; i0 = i0 + 1)');
  expect(c).toContain('v1[i0]');
  expect(c).not.toContain('v2 =');
});

test('a walk base agbcc REMATERIALIZED as a shift is admitted like a pool word', () => {
  // `(s32 *)(128 << 18)` is 0x02000000 — agbcc emits `movs`+`lsls` for every shift-encodable GBA
  // region and a pool word for the rest, and which one it picked is not a property of the source
  const out = reindexWalks(
    constCountdown((fn) => {
      (fn.body[0] as Stmt & { k: 'assign' }).value = {
        k: 'cast',
        to: T.ptr(T.s(32)),
        e: { k: 'bin', op: '<<', l: C(128), r: C(18) },
      };
    }),
  );
  expect(cBackend.emit(out!)).toContain('v1 = (s32 *)(128 << 18);');
  expect(cBackend.emit(out!)).toContain('for (i0 = 0; i0 < 8; i0 = i0 + 1)');
});

test('a walk base holding a free VARIABLE is not a rematerializable address', () => {
  expect(
    reindexWalks(
      constCountdown((fn) => {
        (fn.body[0] as Stmt & { k: 'assign' }).value = { k: 'bin', op: '+', l: V('a0'), r: C(4) };
      }),
    ),
  ).toBeNull();
});
