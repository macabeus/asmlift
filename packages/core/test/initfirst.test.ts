// The /initfirst lever (l3/initfirst.ts): a loop init moves above its guard and the guard reads
// the initialized variable. Both source forms lift to the same IR — a const has no position — so
// the differ referees between them.
import { expect, test } from 'vitest';

import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { initFirstGuards } from '../src/l3/initfirst';

const s32 = { kind: 'int', width: 32, signed: true } as const;
const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const assign = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const bin = (op: '<' | '>=' | '!=', l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const fn = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: s32 }],
  locals: [{ name: 'v0', type: s32 }],
  retType: s32,
  body,
});
const dowhile = (cond: Expr, body: Stmt[]): Stmt => ({ k: 'dowhile', cond, body });

test('the guard re-spells through the hoisted init: if (0 < n) { v = 0; … } → v = 0; if (v < n)', () => {
  const r = initFirstGuards(
    fn([
      {
        k: 'if',
        cond: bin('<', c(0), v('a0')),
        then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
        else: [],
      },
    ]),
  );
  expect(r).not.toBeNull();
  expect(r!.body[0]).toEqual(assign('v0', c(0)));
  const g = r!.body[1] as Extract<Stmt, { k: 'if' }>;
  expect(g.cond).toEqual(bin('<', v('v0'), v('a0')));
  expect(g.then[0].k).toBe('dowhile');
});

test('a common leading assign hoists out of both arms, the emptied then flips, and the cond reads it', () => {
  const r = initFirstGuards(
    fn([
      {
        k: 'if',
        cond: bin('>=', c(0), v('a0')),
        then: [assign('v0', c(0))],
        else: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
      },
    ]),
  );
  expect(r).not.toBeNull();
  expect(r!.body[0]).toEqual(assign('v0', c(0)));
  const g = r!.body[1] as Extract<Stmt, { k: 'if' }>;
  expect(g.cond).toEqual(bin('<', v('v0'), v('a0'))); // flipped AND reading the hoisted var
  expect(g.else).toEqual([]);
});

test('refused: the variable appears after the if (the skip path would now hold K)', () => {
  const r = initFirstGuards(
    fn([
      {
        k: 'if',
        cond: bin('<', c(0), v('a0')),
        then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
        else: [],
      },
      { k: 'return', value: v('v0') },
    ]),
  );
  expect(r).toBeNull();
});

test('a plain-read init moves too, replacing its own expression in the cond', () => {
  // if (0 < a0) { v0 = a0; … } → v0 = a0; if (0 < v0): guard and init read the same value back
  // to back; the local-spelling source reads it once.
  const r = initFirstGuards(
    fn([
      {
        k: 'if',
        cond: bin('<', c(0), v('a0')),
        then: [assign('v0', v('a0')), dowhile(bin('!=', v('v0'), c(0)), [])],
        else: [],
      },
    ]),
  );
  expect(r).not.toBeNull();
  expect(r!.body[0]).toEqual(assign('v0', v('a0')));
  expect((r!.body[1] as Extract<Stmt, { k: 'if' }>).cond).toEqual(bin('<', c(0), v('v0')));
});

// A deref init through the function's own plain pointer: the everyday `for (j = *p; j < size;…)`
// shape. The identical deref side becomes the variable.
const deref = (base: Expr): Expr => ({ k: 'index', base, idx: c(0), width: 2, signed: false });
const fnWith = (locals: SFn['locals'], body: Stmt[]): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: s32 }],
  locals,
  retType: s32,
  body,
});
const u32t = { kind: 'int', width: 32, signed: false } as const;
const ptrLocal = { name: 'p0', type: { kind: 'ptr', to: { kind: 'int', width: 16, signed: false } } as const };

test('a non-volatile deref init moves and the guard reads the variable', () => {
  const r = initFirstGuards(
    fnWith(
      [{ name: 'v0', type: s32 }, ptrLocal],
      [
        {
          k: 'if',
          cond: bin('<', deref(v('p0')), v('a0')),
          then: [assign('v0', deref(v('p0'))), dowhile(bin('<', v('v0'), v('a0')), [])],
          else: [],
        },
      ],
    ),
  );
  expect(r).not.toBeNull();
  expect(r!.body[0]).toEqual(assign('v0', deref(v('p0'))));
  expect((r!.body[1] as Extract<Stmt, { k: 'if' }>).cond).toEqual(bin('<', v('v0'), v('a0')));
});

test('refused: a deref through a VOLATILE pointer never moves (two observable reads)', () => {
  const r = initFirstGuards(
    fnWith(
      [
        { name: 'v0', type: u32t },
        { ...ptrLocal, pointeeVolatile: true },
      ],
      [
        {
          k: 'if',
          cond: bin('<', deref(v('p0')), v('a0')),
          then: [assign('v0', deref(v('p0'))), dowhile(bin('<', v('v0'), v('a0')), [])],
          else: [],
        },
      ],
    ),
  );
  expect(r).toBeNull();
});

test('refused: an X mentioning a name the function does not own (a global could be volatile)', () => {
  const r = initFirstGuards(
    fn([
      {
        k: 'if',
        cond: bin('<', v('gCount'), v('a0')),
        then: [assign('v0', v('gCount')), dowhile(bin('<', v('v0'), v('a0')), [])],
        else: [],
      },
    ]),
  );
  expect(r).toBeNull();
});

test('refused: the swap would flip the compare signedness (u32 variable into a signed compare)', () => {
  // a0 < a0 spelled over s32 sides compares signed; v0 is u32-declared, so v0 < a0 compares
  // unsigned — a different result whenever a0 is negative.
  const r = initFirstGuards(
    fnWith(
      [{ name: 'v0', type: u32t }],
      [
        {
          k: 'if',
          cond: bin('<', v('a0'), c(-5)),
          then: [assign('v0', v('a0')), dowhile(bin('!=', v('v0'), c(0)), [])],
          else: [],
        },
      ],
    ),
  );
  expect(r).toBeNull();
});

test('refused inside a loop: the skip-path write would re-execute where an enclosing scope watches', () => {
  // do { if (0 < a0) { v0 = 0; … } } while (v0 != 5) — re-spelled, a guard-false iteration
  // writes v0 = 0 and the outer condition observes it: the original terminates, that C spins.
  const inner: Stmt = {
    k: 'if',
    cond: bin('<', c(0), v('a0')),
    then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
    else: [],
  };
  const r = initFirstGuards(fn([{ k: 'dowhile', cond: bin('!=', v('v0'), c(5)), body: [inner] }]));
  expect(r).toBeNull();
});

test('refused for a global: a bare-global assign is a store other code observes', () => {
  const g: SFn = {
    ...fn([
      {
        k: 'if',
        cond: bin('<', c(0), v('a0')),
        then: [assign('gState', c(0)), dowhile(bin('<', v('gState'), v('a0')), [])],
        else: [],
      },
    ]),
    locals: [],
  };
  expect(initFirstGuards(g)).toBeNull();
});

test('refused for a VOLATILE local: its store is itself observable (escaped DMA scratch)', () => {
  const g: SFn = {
    ...fn([
      {
        k: 'if',
        cond: bin('<', c(0), v('a0')),
        then: [assign('sp0', c(0)), dowhile(bin('<', v('sp0'), v('a0')), [])],
        else: [],
      },
    ]),
    locals: [{ name: 'sp0', type: s32, volatile: true }],
  };
  expect(initFirstGuards(g)).toBeNull();
});

test('refused for an address-taken local: a captured pointer reads it with no name in sight', () => {
  const takeAddr: Stmt = { k: 'assign', name: 'p1', value: { k: 'addr', name: 'v0' } };
  const g: SFn = {
    ...fn([
      takeAddr,
      {
        k: 'if',
        cond: bin('<', c(0), v('a0')),
        then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
        else: [],
      },
    ]),
  };
  expect(initFirstGuards(g)).toBeNull();
});

test('the guard re-spells NESTED under an if when the variable is dead after it', () => {
  // if (a0 != 0) { if (0 < a0) { v0 = 0; do … } }  →  the init hoists within the outer arm
  const r = initFirstGuards(
    fn([
      {
        k: 'if',
        cond: bin('!=', v('a0'), c(0)),
        then: [
          {
            k: 'if',
            cond: bin('<', c(0), v('a0')),
            then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
            else: [],
          },
        ],
        else: [],
      },
    ]),
  );
  expect(r).not.toBeNull();
  const outer = r!.body[0] as Extract<Stmt, { k: 'if' }>;
  expect(outer.then[0]).toEqual(assign('v0', c(0)));
  expect((outer.then[1] as Extract<Stmt, { k: 'if' }>).cond).toEqual(bin('<', v('v0'), v('a0')));
});

test('refused nested: an ancestor tail reads the variable (the skip path would now hold K)', () => {
  const r = initFirstGuards(
    fn([
      {
        k: 'if',
        cond: bin('!=', v('a0'), c(0)),
        then: [
          {
            k: 'if',
            cond: bin('<', c(0), v('a0')),
            then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
            else: [],
          },
        ],
        else: [],
      },
      assign('a0', v('v0')),
    ]),
  );
  expect(r).toBeNull();
});

test('both arms of one if re-spell their own guard over a SHARED counter (never live across arms)', () => {
  const arm = (base: number): Stmt => ({
    k: 'if',
    cond: bin('<', c(0), v('a0')),
    then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [assign('v0', bin('<', v('v0'), c(base)))])],
    else: [],
  });
  const r = initFirstGuards(fn([{ k: 'if', cond: bin('!=', v('a0'), c(0)), then: [arm(1)], else: [arm(2)] }]));
  expect(r).not.toBeNull();
  for (const armOut of [
    (r!.body[0] as Extract<Stmt, { k: 'if' }>).then,
    (r!.body[0] as Extract<Stmt, { k: 'if' }>).else,
  ]) {
    expect(armOut[0]).toEqual(assign('v0', c(0)));
    expect((armOut[1] as Extract<Stmt, { k: 'if' }>).cond).toEqual(bin('<', v('v0'), v('a0')));
  }
});

test('under a loop ancestor the re-spell fires only when the variable appears nowhere outside its if', () => {
  const inner: Stmt = {
    k: 'if',
    cond: bin('<', c(0), v('a0')),
    then: [assign('v0', c(0)), dowhile(bin('<', v('v0'), v('a0')), [])],
    else: [],
  };
  // confined to the if: fires even under the loop
  const ok = initFirstGuards(fn([{ k: 'dowhile', cond: bin('!=', v('a0'), c(5)), body: [inner] }]));
  expect(ok).not.toBeNull();
  const loop = ok!.body[0] as Extract<Stmt, { k: 'dowhile' }>;
  expect(loop.body[0]).toEqual(assign('v0', c(0)));
  // a sibling arm touching it counts as "outside" once a loop ancestor exists: the next
  // iteration can run that arm and read what the skip-path write left behind
  const armB: Stmt = { k: 'if', cond: bin('<', v('v0'), c(9)), then: [assign('a0', c(1))], else: [] };
  const shared = initFirstGuards(
    fn([
      {
        k: 'dowhile',
        cond: bin('!=', v('a0'), c(5)),
        body: [{ k: 'if', cond: bin('!=', v('a0'), c(0)), then: [inner], else: [armB] }],
      },
    ]),
  );
  expect(shared).toBeNull();
});
