// The walk→index respell variation (l3/reindex.ts) — the third differ-ranked variation. Pins: the golden
// while-walk re-spells with the bound simplified; every out-of-scope shape DECLINES (returns
// null) rather than approximating; the transform never mutates its input.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { IrType } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { without } from '../src/l3/gates';
import { COUNTDOWN_GATES, reindexWalks } from '../src/l3/reindex';
import { volatilePtrLocals } from '../src/l3/volatileptr';
import { v } from './helpers';

const C = (value: number): Expr => ({ k: 'const', value });
const deref = (name: string): Expr => ({ k: 'index', base: v(name), idx: C(0), width: 4, signed: true });
const step = (name: string): Stmt => ({
  k: 'assign',
  name,
  value: { k: 'bin', op: '+', l: v(name), r: C(1) },
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
      { k: 'assign', name: 'v1', value: v('a0') },
      {
        k: 'while',
        cond: cond ?? { k: 'bin', op: '<', l: v('v1'), r: { k: 'bin', op: '+', l: v('a0'), r: v('a1') } },
        body: [{ k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: v('v0'), r: deref('v1') } }, step('v1')],
      },
      { k: 'return', value: v('v0') },
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
    expect(reindexWalks(walkSum({ k: 'bin', op: '<', l: v('v1'), r: v('a1') }))).toBeNull();
  });

  test('the pointer read AFTER the loop (its final value would be base + iterations)', () => {
    expect(
      reindexWalks(walkSum(undefined, [{ k: 'exprstmt', value: { k: 'call', fn: 'g', args: [v('v1')] } }])),
    ).toBeNull();
  });

  test('a bare (non-deref) use of the pointer inside the loop', () => {
    const sfn = walkSum();
    const loop = sfn.body[2] as Extract<Stmt, { k: 'while' }>;
    loop.body.unshift({ k: 'exprstmt', value: { k: 'call', fn: 'g', args: [v('v1')] } });
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('a non-unit step', () => {
    const sfn = walkSum();
    const loop = sfn.body[2] as Extract<Stmt, { k: 'while' }>;
    loop.body[loop.body.length - 1] = {
      k: 'assign',
      name: 'v1',
      value: { k: 'bin', op: '+', l: v('v1'), r: C(2) },
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
        body: [{ k: 'return', value: v('a0') }],
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
      l: v('v0'),
      r: { k: 'index', base: v('v1'), idx: C(0), width: 1, signed: false },
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
        { k: 'if', cond: v('a1'), then: [inner.body[1], inner.body[2]], else: [] },
        { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [v('v1')] } },
        inner.body[3],
      ],
    };
    expect(reindexWalks(sfn)).toBeNull();
  });

  test('p === base declines (the walk bound would chase the stepped var)', () => {
    const sfn = walkSum();
    (sfn.body[1] as Extract<Stmt, { k: 'assign' }>).value = v('v1'); // p = p
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
      cond: { k: 'bin', op: '>=', l: C(0), r: v('a1') },
      then: [{ k: 'assign', name: 'v1', value: C(0) }],
      else: [
        { k: 'assign', name: 'v0', value: v('a0') },
        { k: 'assign', name: 'v1', value: C(0) },
        { k: 'assign', name: 'v2', value: v('a1') },
        {
          k: 'dowhile',
          cond: { k: 'bin', op: '!=', l: v('v2'), r: C(0) },
          body: [
            {
              k: 'if',
              cond: { k: 'bin', op: '>', l: deref('v0'), r: C(0) },
              then: [{ k: 'assign', name: 'v1', value: { k: 'bin', op: '+', l: v('v1'), r: C(1) } }],
              else: [],
            },
            step('v0'),
            { k: 'assign', name: 'v2', value: { k: 'bin', op: '-', l: v('v2'), r: C(1) } },
          ],
        },
      ],
    },
    { k: 'return', value: v('v1') },
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
    expect(c).not.toContain('v2'); // the counter is gone, declaration included
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
        body[1] = { k: 'return', value: v('v2') };
      });
    });

    test("a skip arm that is not the else arm's loop-preceding statements", () => {
      declined((body) => {
        (body[0] as Stmt & { k: 'if' }).then = [{ k: 'assign', name: 'v1', value: C(7) }];
      });
    });

    test('a guard testing a DIFFERENT var than the counter init', () => {
      declined((body) => {
        (body[0] as Stmt & { k: 'if' }).cond = { k: 'bin', op: '>=', l: C(0), r: v('v1') };
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
          l: { k: 'index', base: v('v0'), idx: C(0), width: 1, signed: false },
          r: C(0),
        };
      });
    });

    test('a do-while exit that is not `k != 0`', () => {
      declined((body) => {
        const dw = (body[0] as Stmt & { k: 'if' }).else[3] as Stmt & { k: 'dowhile' };
        dw.cond = { k: 'bin', op: '>', l: v('v2'), r: C(0) };
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
      dw(body).body[0] = { k: 'store', lval: deref('v0'), value: v('v2') };
    });
  });

  test('a leftover reads the counter (its init is what the rewrite deletes)', () => {
    declined((body) => {
      const iff = body[0] as Stmt & { k: 'if' };
      const extra: Stmt = { k: 'assign', name: 'v1', value: { k: 'bin', op: '+', l: v('v2'), r: C(5) } };
      iff.then = [extra];
      iff.else = [iff.else[0], iff.else[2], extra, iff.else[3]];
    });
  });

  test('a second decrement in the body core', () => {
    declined((body) => {
      dw(body).body.splice(1, 0, { k: 'assign', name: 'v2', value: { k: 'bin', op: '-', l: v('v2'), r: C(1) } });
    });
  });

  test('a nested p-free loop reading the counter', () => {
    declined((body) => {
      dw(body).body[0] = {
        k: 'while',
        cond: { k: 'bin', op: '<', l: v('v1'), r: v('v2') },
        body: [{ k: 'assign', name: 'v1', value: { k: 'bin', op: '+', l: v('v1'), r: C(1) } }],
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
      (body[0] as Stmt & { k: 'if' }).cond = { k: 'bin', op: '<', l: C(0), r: v('a1') };
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
        iff.cond = { k: 'bin', op: '<', l: C(0), r: v('a1') };
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
        iff.else.splice(1, 0, { k: 'assign', name: 'v3', value: v('a2') });
        dw.body[0] = {
          k: 'assign',
          name: 'v1',
          value: { k: 'bin', op: '+', l: v('v1'), r: { k: 'bin', op: '*', l: deref('v0'), r: deref('v3') } },
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

test('the /indexed/volatile pairing: the kept numeric base qualifies for the volatile variation', () => {
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

test('keptWalks collects the v1 while-walk base (here a param — harmless to the volatile variation)', () => {
  const kept = new Set<string>();
  expect(reindexWalks(walkSum(), kept)).not.toBeNull();
  expect(kept).toEqual(new Set(['a0']));
});

// ── v3: the up-counting walk with an expression base ──────────────────────────────────────────
describe('v3 — expression-base walk', () => {
  const u8p = { kind: 'ptr', to: { kind: 'int', width: 8, signed: false } } as const;
  const s32t = { kind: 'int', width: 32, signed: true } as const;
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

  describe('a counter starting at a constant S indexes BASE[i - S + REST/W]', () => {
    const startAt = (f: SFn, start: Expr): SFn => {
      (f.body[0] as Extract<Stmt, { k: 'assign' }>).value = start;
      return f;
    };
    const idxJson = (r: SFn | null): string => JSON.stringify((r!.body[1] as Extract<Stmt, { k: 'dowhile' }>).body[0]);

    test('S = 5 over a bare base reads a0[i - 5]', () => {
      const r = reindexWalks(startAt(mkFn({ k: 'cast', to: u8p as never, e: v('a0') }, walkBody()), cn(5)));
      expect(r).not.toBeNull();
      expect(cBackend.emit(r!)).toContain('((u8 *)a1)[i] = ((u8 *)a0)[i - 5];');
    });

    test('S = 5 keeps a symbolic REST and subtracts S last', () => {
      const r = reindexWalks(startAt(mkFn(init, walkBody()), cn(5)));
      expect(r).not.toBeNull();
      expect(idxJson(r)).toContain(
        '"idx":{"k":"bin","op":"-","l":{"k":"bin","op":"+","l":{"k":"var","name":"i"},"r":{"k":"bin","op":"*","l":{"k":"var","name":"a2"},"r":{"k":"var","name":"a1"}}},"r":{"k":"const","value":5}}',
      );
    });

    test('S = 1 over the folded init &g + W reads g[i] (KMC: for (i = 1; …) g[i])', () => {
      const u16p = { kind: 'ptr', to: { kind: 'int', width: 16, signed: false } } as const;
      const f = mkFn(
        {
          k: 'cast',
          to: u16p as never,
          e: { k: 'bin', op: '+', l: { k: 'cast', to: T.u(32), e: { k: 'addr', name: 'gH' } }, r: cn(2) },
        },
        [
          { k: 'store', lval: { k: 'index', base: v('p'), idx: cn(0), width: 2, signed: false }, value: cn(0xffff) },
          inc('p'),
          inc('i'),
        ],
      );
      f.locals[0] = { name: 'p', type: u16p as never };
      const r = reindexWalks(startAt(f, cn(1)));
      expect(r).not.toBeNull();
      expect(JSON.stringify(r!.body)).not.toContain('"name":"p"');
      expect(cBackend.emit(r!)).toContain('((u16 *)&gH)[i] = 65535;');
    });

    test('refused: a symbolic start (no constant to subtract)', () => {
      expect(reindexWalks(startAt(mkFn(init, walkBody()), v('a1')))).toBeNull();
    });

    test('refused: a nonzero start on a narrow counter, which wraps where the walk does not', () => {
      const f = startAt(mkFn(init, walkBody()), cn(5));
      f.locals[1] = { name: 'i', type: T.u(8) };
      expect(reindexWalks(f)).toBeNull();
    });

    test('from S = 0 a narrow counter must be UNSIGNED: an s8 wraps 127 -> -128 while the walk goes on', () => {
      const narrow = (type: IrType | undefined): SFn => {
        const f = mkFn(init, walkBody());
        if (type) {
          f.locals[1] = { name: 'i', type };
        } else {
          f.locals.splice(1, 1); // the counter declared nowhere: no width to argue from
        }
        return f;
      };
      expect(reindexWalks(narrow(T.u(8)))).not.toBeNull();
      expect(reindexWalks(narrow(T.s(8)))).toBeNull();
      expect(reindexWalks(narrow(T.s(16)))).toBeNull();
      expect(reindexWalks(narrow(undefined))).toBeNull();
    });
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

  describe('a wider element (W bytes): the constant byte REST is rescaled to elements', () => {
    const u16p = { kind: 'ptr', to: { kind: 'int', width: 16, signed: false } } as const;
    const deref16: Expr = { k: 'index', base: v('p'), idx: cn(0), width: 2, signed: false };
    const halfBody = (val: Expr = deref16): Stmt[] => [
      { k: 'store', lval: { k: 'index', base: v('a1'), idx: v('i'), width: 2, signed: false }, value: val },
      inc('p'),
      inc('i'),
    ];
    const u16Fn = (init16: Expr, body: Stmt[] = halfBody()): SFn => {
      const f = mkFn(init16, body);
      f.locals[0] = { name: 'p', type: u16p as never };
      return f;
    };
    const at = (off: Expr): Expr => ({
      k: 'cast',
      to: u16p as never,
      e: { k: 'bin', op: '+', l: v('a0'), r: off },
    });

    test('a u16 walk from byte offset 2k reads BASE[i + k]', () => {
      const r = reindexWalks(u16Fn(at(cn(6))));
      expect(r).not.toBeNull();
      const src = JSON.stringify(r!.body);
      expect(src).not.toContain('"name":"p"');
      expect(src).toContain(
        '{"k":"index","base":{"k":"var","name":"a0"},"idx":{"k":"bin","op":"+","l":{"k":"var","name":"i"},"r":{"k":"const","value":3}},"width":2,"signed":false}',
      );
      expect(cBackend.emit(r!)).toContain('((u16 *)a0)[i + 3]');
    });

    test('refused: a byte offset that is not a multiple of the element (no element index names it)', () => {
      expect(reindexWalks(u16Fn(at(cn(3))))).toBeNull();
    });

    test('a symbolic byte offset stays in the byte sum the index base casts: ((u16 *)(a0 + a2 * 2))[i + 3]', () => {
      // KMC: `u16 *p = b + k; for (i = 3; …) p[i] = 7` lifts `p = (u16 *)(a0 + (a1 << 1) + 6)` from i = 3
      const off = { k: 'bin', op: '+', l: { k: 'bin', op: '*', l: v('a2'), r: cn(2) }, r: cn(6) } as const;
      const r = reindexWalks(u16Fn(at(off)));
      expect(r).not.toBeNull();
      expect(JSON.stringify(r!.body)).not.toContain('"name":"p"');
      expect(cBackend.emit(r!)).toContain('((u16 *)a1)[i] = ((u16 *)(a0 + a2 * 2))[i + 3];');
    });

    test('over a (u32)&g base the address keeps its cast inside the byte sum', () => {
      const f = u16Fn({
        k: 'cast',
        to: u16p as never,
        e: {
          k: 'bin',
          op: '+',
          l: { k: 'cast', to: T.u(32), e: { k: 'addr', name: 'gH' } },
          r: { k: 'bin', op: '<<', l: v('a2'), r: cn(1) },
        },
      });
      const r = reindexWalks(f);
      expect(r).not.toBeNull();
      expect(cBackend.emit(r!)).toContain('= ((u16 *)((u32)&gH + (a2 << 1)))[i];');
    });

    describe('a symbolic addend is re-read on every pass, so nothing in the loop may write it', () => {
      // KMC, `u16 *p = (u16 *)(b + gK * 2); for (i = 0; …) { p[i] = 7; g(); }`: the walk read gK
      // once; `((u16 *)(a0 + (gK << 1)))[i]` reads it after every g(), which may have changed it
      const gOff = { k: 'bin', op: '<<', l: v('gK'), r: cn(1) } as const;
      const call: Stmt = { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [] } };
      const withGlobal = (body: Stmt[]): SFn => {
        const f = u16Fn(at(gOff), body);
        f.globals = [{ name: 'gK', type: s32t }];
        return f;
      };
      test('refused: a global addend beside a call in the loop', () => {
        const body = halfBody();
        body.splice(1, 0, call);
        expect(reindexWalks(withGlobal(body))).toBeNull();
      });
      test('refused: a global addend beside a store, which may alias it', () => {
        expect(reindexWalks(withGlobal(halfBody()))).toBeNull();
      });
      test('a global addend in a loop that writes no memory re-spells', () => {
        const body: Stmt[] = [{ k: 'assign', name: 'a1', value: deref16 }, inc('p'), inc('i')];
        expect(cBackend.emit(reindexWalks(withGlobal(body))!)).toContain('a1 = ((u16 *)(a0 + (gK << 1)))[i];');
      });
      test('refused: a local addend whose address escapes, beside a call', () => {
        const body = halfBody();
        body.splice(1, 0, { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'k' }] } });
        const f = u16Fn(at({ k: 'bin', op: '<<', l: v('k'), r: cn(1) }), body);
        f.locals.push({ name: 'k', type: s32t });
        expect(reindexWalks(f)).toBeNull();
      });
      test('a param addend survives a call: no callee writes it', () => {
        const body = halfBody();
        body.splice(1, 0, call);
        const r = reindexWalks(u16Fn(at({ k: 'bin', op: '<<', l: v('a2'), r: cn(1) }), body));
        expect(cBackend.emit(r!)).toContain('= ((u16 *)(a0 + (a2 << 1)))[i];');
      });
    });

    test('refused: a symbolic byte offset beside constants W does not divide', () => {
      const off = { k: 'bin', op: '+', l: v('a2'), r: cn(3) } as const;
      expect(reindexWalks(u16Fn(at(off)))).toBeNull();
    });

    test('refused: a deref narrower than the walk element', () => {
      const narrow: Expr = { k: 'index', base: v('p'), idx: cn(0), width: 1, signed: false };
      expect(reindexWalks(u16Fn(at(cn(2)), halfBody(narrow)))).toBeNull();
    });
  });

  describe('a W-element pointer base: EXPR counts in elements, so REST stays verbatim', () => {
    const u16p = { kind: 'ptr', to: { kind: 'int', width: 16, signed: false } } as const;
    const deref16: Expr = { k: 'index', base: v('p'), idx: cn(0), width: 2, signed: false };
    const elemFn = (e: Expr, baseType: IrType, start = 0): SFn => {
      const f = mkFn(e, [{ k: 'store', lval: deref16, value: cn(7) }, inc('p'), inc('i')]);
      f.locals[0] = { name: 'p', type: u16p as never };
      f.params[0] = { name: 'a0', type: baseType };
      (f.body[0] as Extract<Stmt, { k: 'assign' }>).value = cn(start);
      return f;
    };
    const plus = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '+', l, r });

    test('KMC folds for (i = 3; …) a0[i] over a u16 *a0 to p = a0 + 3: it reads a0[i]', () => {
      const r = reindexWalks(elemFn(plus(v('a0'), cn(3)), u16p as never, 3));
      expect(r).not.toBeNull();
      expect(JSON.stringify(r!.body)).not.toContain('"name":"p"');
      expect(cBackend.emit(r!)).toContain('a0[i] = 7;');
    });

    test('a symbolic addend stays verbatim, the constants fold after it', () => {
      const r = reindexWalks(
        elemFn(
          plus(plus(v('a0'), cn(1)), plus({ k: 'bin', op: '*', l: v('a2'), r: v('a1') }, cn(2))),
          u16p as never,
          5,
        ),
      );
      expect(r).not.toBeNull();
      expect(cBackend.emit(r!)).toContain('a0[i + a2 * a1 - 2] = 7;');
    });

    test('a pointer to a signed element of the same width counts the same unit', () => {
      const s16p = { kind: 'ptr', to: { kind: 'int', width: 16, signed: true } } as const;
      expect(reindexWalks(elemFn(plus(v('a0'), cn(3)), s16p as never, 3))).not.toBeNull();
    });

    test('refused: a pointer base of another element width strides a unit no u16 index names', () => {
      const u32p = { kind: 'ptr', to: { kind: 'int', width: 32, signed: false } } as const;
      expect(reindexWalks(elemFn(plus(v('a0'), cn(3)), u32p as never, 3))).toBeNull();
      expect(reindexWalks(elemFn(plus(v('a0'), cn(3)), T.ptr(T.ptr(T.u(16))), 3))).toBeNull();
    });
  });

  describe('an address base: `(u32)&g` is the index base, declared or not', () => {
    const u16p = { kind: 'ptr', to: { kind: 'int', width: 16, signed: false } } as const;
    const deref16: Expr = { k: 'index', base: v('p'), idx: cn(0), width: 2, signed: false };
    const gAddr = (to: IrType = T.u(32)): Expr => ({ k: 'cast', to, e: { k: 'addr', name: 'gH' } });
    const addrFn = (e: Expr, globalType?: IrType): SFn => {
      const f = mkFn({ k: 'cast', to: u16p as never, e }, [
        { k: 'store', lval: deref16, value: cn(0xffff) },
        inc('p'),
        inc('i'),
      ]);
      f.locals[0] = { name: 'p', type: u16p as never };
      if (globalType) {
        f.globals = [{ name: 'gH', type: globalType }];
      }
      return f;
    };
    const plus = (l: Expr, r: Expr): Expr => ({ k: 'bin', op: '+', l, r });

    test('(u32)&g + 4 over a u16 walk reads ((u16 *)&g)[i + 2], undeclared g included', () => {
      const r = reindexWalks(addrFn(plus(gAddr(), cn(4))));
      expect(r).not.toBeNull();
      const src = JSON.stringify(r!.body);
      expect(src).not.toContain('"name":"p"');
      expect(src).toContain(
        '{"k":"index","base":{"k":"addr","name":"gH"},"idx":{"k":"bin","op":"+","l":{"k":"var","name":"i"},"r":{"k":"const","value":2}},"width":2,"signed":false}',
      );
      expect(cBackend.emit(r!)).toContain('((u16 *)&gH)[i + 2] = 65535;');
    });

    test('a g declared with another element still reads W-byte elements through the printed cast', () => {
      const r = reindexWalks(addrFn(plus(gAddr(), cn(4)), T.array(T.u(8), 64)));
      expect(r).not.toBeNull();
      expect(cBackend.emit(r!)).toContain('((u16 *)gH)[i + 2] = 65535;'); // the array's own address
    });

    test('refused: an uncast address (its `+` strides g, not bytes) or a narrowing cast on the addend', () => {
      expect(reindexWalks(addrFn(plus({ k: 'addr', name: 'gH' }, cn(4))))).toBeNull();
      expect(reindexWalks(addrFn(plus(gAddr(T.u(16)), cn(4))))).toBeNull();
    });

    test('refused: a narrowing cast over the WHOLE init truncates the address (KMC sll/sra 16)', () => {
      // `u16 *p = (u16 *)(s16)((u32)gH + 2)` lifts so: g[i] would drop the truncation
      expect(reindexWalks(addrFn({ k: 'cast', to: T.s(16), e: plus(gAddr(), cn(2)) }))).toBeNull();
      // a same-width integer cast keeps every bit, and is stripped like the pointer cast
      expect(reindexWalks(addrFn({ k: 'cast', to: T.s(32), e: plus(gAddr(), cn(2)) }))).not.toBeNull();
    });

    test('a LONE address needs no cast: (u16 *)&g from S = 5 reads ((u16 *)&g)[i - 5]', () => {
      // KMC: for (i = 5; i < 100; i++) gH[i - 5] = 7  lifts  v1 = 5; v0 = (u16 *)&gH; do …
      const f = addrFn({ k: 'addr', name: 'gH' });
      (f.body[0] as Extract<Stmt, { k: 'assign' }>).value = cn(5);
      const r = reindexWalks(f);
      expect(r).not.toBeNull();
      expect(JSON.stringify(r!.body)).not.toContain('"name":"p"');
      expect(cBackend.emit(r!)).toContain('((u16 *)&gH)[i - 5] = 65535;');
      // the same under a (u32) the strip removes, and a u16 array g still prints the cast
      expect(reindexWalks(addrFn(gAddr()))).not.toBeNull();
      expect(cBackend.emit(reindexWalks(addrFn({ k: 'addr', name: 'gH' }, T.array(T.u(16), 256)))!)).toContain(
        '((u16 *)gH)[i] = 65535;',
      );
    });

    test('refused: an address beside a bare var leaves the base ambiguous', () => {
      expect(reindexWalks(addrFn(plus(gAddr(), v('a0'))))).toBeNull();
    });
  });

  describe('one counter carrying SEVERAL walk pointers: each re-spells off its own base', () => {
    const u16p = T.ptr(T.u(16));
    const s32p = T.ptr(T.s(32));
    const castAddr = (to: IrType, g: string, off: number): Expr => ({
      k: 'cast',
      to,
      e: { k: 'bin', op: '+', l: { k: 'cast', to: T.u(32), e: { k: 'addr', name: g } }, r: cn(off) },
    });
    const at0 = (name: string, width: number): Expr => ({
      k: 'index',
      base: v(name),
      idx: cn(0),
      width,
      signed: false,
    });
    /** KMC, `for (i = 1; i < 64; i++) { gH[i] = 7; gW[i] = 8; }`:
     *  `i = 1; q = (s32 *)((u32)&gW + 4); p = (u16 *)((u32)&gH + 2);
     *   do { *p = 7; *q = 8; q = q + 1; i = i + 1; p = p + 1; } while (i < 64);` */
    const twoWalks = (mut?: (inits: Stmt[], body: Stmt[]) => void): SFn => {
      const inits: Stmt[] = [
        { k: 'assign', name: 'i', value: cn(1) },
        { k: 'assign', name: 'q', value: castAddr(s32p, 'gW', 4) },
        { k: 'assign', name: 'p', value: castAddr(u16p, 'gH', 2) },
      ];
      const body: Stmt[] = [
        { k: 'store', lval: at0('p', 2), value: cn(7) },
        { k: 'store', lval: at0('q', 4), value: cn(8) },
        inc('q'),
        inc('i'),
        inc('p'),
      ];
      mut?.(inits, body);
      return {
        name: 't1',
        params: [],
        locals: [
          { name: 'p', type: u16p },
          { name: 'q', type: s32p },
          { name: 'i', type: s32t },
        ],
        retType: s32t,
        body: [...inits, { k: 'dowhile', cond: { k: 'bin', op: '<', l: v('i'), r: cn(64) }, body }],
      };
    };

    test('two arrays of different widths, counter from 1: gH[i] and gW[i], both walks deleted', () => {
      const r = reindexWalks(twoWalks());
      expect(r).not.toBeNull();
      const src = cBackend.emit(r!);
      expect(src).toContain('((u16 *)&gH)[i] = 7;');
      expect(src).toContain('((s32 *)&gW)[i] = 8;');
      expect(src).toContain('i = 1;');
      expect(JSON.stringify(r!.body)).not.toMatch(/"name":"[pq]"/);
    });

    test('the counter init may sit anywhere in the run', () => {
      const r = reindexWalks(twoWalks((inits) => inits.splice(0, 2, inits[1], inits[0])));
      expect(r).not.toBeNull();
      expect(cBackend.emit(r!)).toContain('((s32 *)&gW)[i] = 8;');
    });

    test('one pointer out of scope keeps walking beside the one that re-spells', () => {
      // q read at offset 1: no `BASE[i + REST]` names it here, so q keeps its init and step
      const r = reindexWalks(
        twoWalks((_, body) => {
          body[1] = { k: 'store', lval: { ...at0('q', 4), idx: cn(1) } as Expr, value: cn(8) };
        }),
      );
      const src = cBackend.emit(r!);
      expect(src).toContain('((u16 *)&gH)[i] = 7;');
      expect(src).toContain('q[1] = 8;');
      expect(src).toContain('q = q + 1;');
      expect(src).toMatch(/q = \(s32 \*\)\(\(u32\)&gW \+ 4\);/);
      expect(JSON.stringify(r!.body)).not.toContain('"name":"p"');
    });

    test('which pointers re-spell does not depend on the order of the tail steps', () => {
      // q escapes (returned after the loop), so only p re-spells — in every tail order
      const escaped = (order: string[]): SFn => {
        const f = twoWalks((_, body) => body.splice(2, 3, ...order.map(inc)));
        f.body.push({ k: 'return', value: v('q') } as Stmt);
        return f;
      };
      const outs = [
        ['q', 'p', 'i'],
        ['p', 'q', 'i'],
        ['i', 'q', 'p'],
      ].map((o) => cBackend.emit(reindexWalks(escaped(o))!));
      for (const src of outs) {
        expect(src).toContain('((u16 *)&gH)[i] = 7;');
        expect(src).toContain('*q = 8;');
      }
    });

    test('refused: a walk pointer whose step sits outside the tail', () => {
      expect(reindexWalks(twoWalks((_, body) => body.splice(0, 0, body.splice(2, 1)[0])))).toBeNull();
    });
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
      { k: 'assign', name: 'v1', value: v('a0') },
      { k: 'assign', name: 'v0', value: C(0) },
      { k: 'assign', name: 'v2', value: C(7) },
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '>=', l: v('v2'), r: C(0) },
        body: [
          { k: 'assign', name: 'v0', value: { k: 'bin', op: '+', l: v('v0'), r: deref('v1') } },
          step('v1'),
          { k: 'assign', name: 'v2', value: { k: 'bin', op: '-', l: v('v2'), r: C(1) } },
        ],
      },
      { k: 'return', value: v('v0') },
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
          (fn.body[2] as Stmt & { k: 'assign' }).value = v('a1');
        }),
      ),
    ).toBeNull();
  });

  test('refused: the `!= 0` exit — an unguarded loop with it counts one iteration fewer', () => {
    expect(reindexWalks(constCountdown((fn) => (cdLoop(fn).cond = { k: 'bin', op: '!=', l: v('v2'), r: C(0) })))).toBe(
      null,
    );
  });

  test('refused: a break in the body', () => {
    expect(reindexWalks(constCountdown((fn) => cdLoop(fn).body.unshift({ k: 'break' })))).toBeNull();
  });

  test('refused: the counter is read a fifth time (`*p = k`)', () => {
    expect(
      reindexWalks(constCountdown((fn) => cdLoop(fn).body.unshift({ k: 'store', lval: deref('v1'), value: v('v2') }))),
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
            l: v('v0'),
            r: { k: 'index', base: v('v1'), idx: C(0), width: 1, signed: false },
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
    { k: 'assign', name: 'v1', value: v('a0') },
    { k: 'assign', name: 'gCount', value: C(7) },
    {
      k: 'dowhile',
      cond: { k: 'bin', op: '>=', l: v('gCount'), r: C(0) },
      body: [
        { k: 'store', lval: deref('v1'), value: C(0) },
        step('v1'),
        { k: 'assign', name: 'gCount', value: { k: 'bin', op: '-', l: v('gCount'), r: C(1) } },
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
    { k: 'assign', name: 'v3', value: v('a2') },
    {
      k: 'while',
      cond: { k: 'bin', op: '<', l: v('v3'), r: { k: 'bin', op: '+', l: v('a2'), r: v('a1') } },
      body: [{ k: 'assign', name: 'v4', value: { k: 'bin', op: '+', l: v('v4'), r: deref('v3') } }, step('v3')],
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
        cond: { k: 'bin', op: '<', l: v('v3'), r: C(4) },
        body: [
          ...inner.body.slice(0, 4),
          { k: 'assign', name: 'v3', value: { k: 'bin', op: '+', l: v('v3'), r: C(1) } },
        ],
      },
      { k: 'return', value: v('v0') },
    ],
  };
  const c = cBackend.emit(reindexWalks(fn)!);
  expect(c).toContain('while (v3 < 4) {');
  expect(c).toContain('v1 = a0;');
  expect(c).toContain('for (i0 = 0; i0 < 8; i0 = i0 + 1)');
  expect(c).toContain('v1[i0]');
  expect(c).not.toContain('v2 =');
});

// ── the shared countdown gate, as a table ─────────────────────────────────────────────────────

/** One fixture per COUNTDOWN_GATES entry: a function the full table refuses, and refuses ON THAT
 *  ENTRY — dropping it lets the same input through. `title` is what the entry's `guardedBy` names,
 *  so gate-contract.test.ts can find it in this file's text. */
const GATE_ABLATIONS: { id: string; title: string; fixture: () => SFn }[] = [
  {
    id: 'pointer-counter',
    title: 'a pointer-typed counter declines',
    // v2's counter carries no type rule of its own, so a pointer reaches the shared table
    fixture: () => guardedCountdown((_body, fn) => (fn.locals[2].type = T.ptr(T.s(32)))),
  },
  {
    id: 'global-counter',
    title: 'the counter may not be a GLOBAL',
    fixture: () => globalCounter,
  },
  {
    id: 'volatile-counter',
    title: 'a volatile counter declines',
    fixture: () => constCountdown((fn) => (fn.locals[2].volatile = true)),
  },
  {
    id: 'volatile-walk',
    title: 'a volatile walk pointer declines',
    // `pointeeVolatile`, the flag the `/volatile` variation mints — an object-volatile POINTER has no
    // inhabitant (cfamily.ts), and `/volatile/indexed` (rank.ts) is what reaches this gate.
    fixture: () => constCountdown((fn) => (fn.locals[1].pointeeVolatile = true)),
  },
  {
    id: 'two-steps-one-pointer',
    title: 'a pointer stepped twice in one body declines',
    fixture: () => constCountdown((fn) => cdLoop(fn).body.push(step('v1'))),
  },
  {
    id: 'body-exit',
    title: 'a `break` in the body declines',
    fixture: () => constCountdown((fn) => cdLoop(fn).body.unshift({ k: 'break' })),
  },
  {
    id: 'walk-base',
    title: 'a walk pointer with no init ahead of the loop declines',
    fixture: () => constCountdown((fn) => fn.body.splice(0, 1)),
  },
  {
    id: 'counter-roles',
    title: 'a fifth mention of the counter declines',
    fixture: () => constCountdown((fn) => cdLoop(fn).body.unshift({ k: 'store', lval: deref('v1'), value: v('v2') })),
  },
  {
    id: 'walk-confined',
    title: 'a walk pointer read after the loop declines',
    fixture: () => constCountdown((fn) => fn.body.splice(4, 0, { k: 'store', lval: deref('v1'), value: C(0) })),
  },
  {
    id: 'walk-stride',
    title: 'a byte deref of a word walk declines',
    fixture: () =>
      constCountdown((fn) => {
        (cdLoop(fn).body[0] as Stmt & { k: 'assign' }).value = {
          k: 'bin',
          op: '+',
          l: v('v0'),
          r: { k: 'index', base: v('v1'), idx: C(0), width: 1, signed: true },
        };
      }),
  },
  {
    id: 'leftover-walk',
    title: 'a leftover mentioning a walk pointer declines',
    // BOTH arms carry the leftover, so the skip-arm equality still holds and this entry is the
    // only thing standing between the rewrite and a skip path dereferencing an uninitialised `v0`
    fixture: () =>
      guardedCountdown((body) => {
        const s = body[0] as Stmt & { k: 'if' };
        const leftover: Stmt = { k: 'store', lval: deref('v0'), value: C(0) };
        s.then.push(leftover);
        s.else.splice(3, 0, leftover);
      }),
  },
];

describe('COUNTDOWN_GATES — each entry is load-bearing on its own input', () => {
  test('every entry has a fixture, and every fixture an entry', () => {
    expect(GATE_ABLATIONS.map((a) => a.id).sort()).toEqual(COUNTDOWN_GATES.map((g) => g.id).sort());
  });

  test.each(GATE_ABLATIONS)('$id — $title, and re-spells with the entry dropped', ({ id, fixture }) => {
    expect(reindexWalks(fixture())).toBeNull();
    expect(reindexWalks(fixture(), undefined, without(COUNTDOWN_GATES, id))).not.toBeNull();
  });
});

test('the counter’s DECLARATION is retired with its writes, not left standing unused', () => {
  const c = cBackend.emit(reindexWalks(constCountdown())!);
  expect(c).not.toContain('v2'); // neither `s32 v2;` nor any use
  expect(c).toContain('s32 v0;'); // the accumulator still is one
});

test('an ESCAPED counter address is a mention: `&k` published before the loop declines', () => {
  // the four-roles rule is the whole licence for deleting the counter's writes, and a var-only
  // count cannot see the escape — the DMA-published frame slot renders its address as `addr`
  expect(
    reindexWalks(
      constCountdown((fn) =>
        fn.body.splice(3, 0, {
          k: 'store',
          lval: {
            k: 'index',
            base: { k: 'cast', to: T.ptr(T.u(32)), e: C(0x40000d4) },
            idx: C(0),
            width: 4,
            signed: false,
          },
          value: { k: 'addr', name: 'v2' },
        }),
      ),
    ),
  ).toBeNull();
});

test('a walk pointer whose ADDRESS escapes declines too', () => {
  expect(
    reindexWalks(
      constCountdown((fn) =>
        fn.body.splice(3, 0, {
          k: 'store',
          lval: { k: 'index', base: v('a0'), idx: C(0), width: 4, signed: true },
          value: { k: 'addr', name: 'v1' },
        }),
      ),
    ),
  ).toBeNull();
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
        (fn.body[0] as Stmt & { k: 'assign' }).value = { k: 'bin', op: '+', l: v('a0'), r: C(4) };
      }),
    ),
  ).toBeNull();
});
