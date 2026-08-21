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

test('refused: a non-const init never moves across the condition', () => {
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
  expect(r).toBeNull();
});
