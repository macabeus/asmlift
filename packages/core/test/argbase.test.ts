// The `/argbase` lever (l3/argbase.ts): name a call's argument bases before the call.
//
// A compiler loading two fixed addresses for one call emits BOTH pool loads before either deref;
// the inline argument spelling makes it finish argument 0 first. Same instructions, different
// order, and a nonmatch. These pin the GATE and the semantics-preservation rules — the lever is
// emitted as an extra candidate, so its risk is spelling quality, not correctness of the winner.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { materializeArgBases } from '../src/l3/argbase';
import type { Expr, SFn } from '../src/l3/ast';

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
