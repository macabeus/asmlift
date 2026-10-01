// UNIT tests for the L2→L3 effect contract (contracts.ts assertEffectsPreserved): every call the
// asm makes is emitted, and none is emitted more times than the asm makes it ON ONE PATH.
//
// Hand-built IR + hand-built AST, the same way hazards.test.ts pins its predicates — the point is
// the rule itself, independent of whether today's structurer can produce the shape. The false-
// POSITIVE side matters as much as the true-positive one: structuring legitimately duplicates a
// region into exclusive arms, and a contract that declined those would cost matches.
import { describe, expect, test } from 'vitest';

import { assertEffectsPreserved } from '../src/contracts';
import { type Block, type Fn, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';

/** an IR fn whose (reachable) entry block calls each name in `calls`, plus an optional
 *  UNREACHABLE block calling `unreachable` */
const irWith = (calls: string[], unreachable: string[] = []): Fn => {
  const entry: Block = {
    params: [],
    ops: [...calls.map((t) => mkOp('call', { results: [mkValue(T.s(32))], attrs: { target: t } })), mkOp('ret', {})],
  };
  const dead: Block = {
    params: [],
    ops: [...unreachable.map((t) => mkOp('call', { results: [mkValue(T.s(32))], attrs: { target: t } })), mkOp('ret')],
  };
  return {
    name: 'F',
    blocks: unreachable.length ? [entry, dead] : [entry],
    writeOrder: undefined,
    slotHomes: undefined,
    paramEvidence: undefined,
    localObjects: undefined,
  };
};

const sfnWith = (body: Stmt[]): SFn => ({ name: 'F', params: [], locals: [], retType: T.void(), body });
const callExpr = (fn: string): Expr => ({ k: 'call', fn, args: [] });
const callStmt = (fn: string): Stmt => ({ k: 'exprstmt', value: callExpr(fn) });
const check = (calls: string[], body: Stmt[], unreachable: string[] = []) =>
  assertEffectsPreserved(irWith(calls, unreachable), sfnWith(body));

describe('assertEffectsPreserved — a dropped call', () => {
  test('a call with no counterpart in the tree fails at the structuring boundary', () => {
    expect(() => check(['f'], [])).toThrow(/dropped the call to 'f'/);
  });

  test('a call nested anywhere in the tree counts as emitted', () => {
    expect(() =>
      check(['f'], [{ k: 'if', cond: { k: 'const', value: 1 }, then: [callStmt('f')], else: [] }]),
    ).not.toThrow();
  });

  test('an UNREACHABLE block’s call is not required — structuring never emits it', () => {
    expect(() => check(['f'], [callStmt('f')], ['g'])).not.toThrow();
  });

  test('a function the asm never calls is not the contract’s business', () => {
    expect(() => check([], [callStmt('printf')])).not.toThrow();
  });
});

describe('assertEffectsPreserved — a call re-run on one path', () => {
  test('two renders in sequence of a single call fail', () => {
    expect(() => check(['f'], [callStmt('f'), callStmt('f')])).toThrow(/emitted 2 calls to 'f' on one path/);
  });

  test('a call inlined into two operands of one statement fails', () => {
    const both: Stmt = {
      k: 'exprstmt',
      value: { k: 'bin', op: '+', l: callExpr('f'), r: callExpr('f') },
    };
    expect(() => check(['f'], [both])).toThrow(/emitted 2 calls to 'f' on one path/);
  });

  test('TWO calls in the asm license two renders', () => {
    expect(() => check(['f', 'f'], [callStmt('f'), callStmt('f')])).not.toThrow();
  });
});

describe('assertEffectsPreserved — duplication that is legitimate', () => {
  test('the same call in both arms of an if is one execution per path', () => {
    const dup: Stmt = { k: 'if', cond: { k: 'const', value: 1 }, then: [callStmt('f')], else: [callStmt('f')] };
    expect(() => check(['f'], [dup])).not.toThrow();
  });

  test('exclusive switch arms sharing a body — the shape structuring duplicates', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: { k: 'var', name: 'x' },
      cases: [
        { values: [0], body: [callStmt('f')], fallsThrough: false },
        { values: [1], body: [callStmt('f')], fallsThrough: false },
      ],
      default: [callStmt('f')],
    };
    expect(() => check(['f'], [sw])).not.toThrow();
  });

  test('a loop body is counted ONCE — a trip count is not a syntactic occurrence', () => {
    const loop: Stmt = { k: 'while', cond: { k: 'const', value: 1 }, body: [callStmt('f')] };
    expect(() => check(['f'], [loop])).not.toThrow();
  });

  // A loop's exit tail copied into each of its two breaks: `if (a) { gA = f(); return x; } if (b) {
  // gA = f(); return x; }`. A path that takes the first return never reaches the second.
  const exitArm = (): Stmt => ({
    k: 'if',
    cond: { k: 'var', name: 'c' },
    then: [callStmt('f'), { k: 'return', value: { k: 'var', name: 'x' } }],
    else: [],
  });

  test('two sequenced arms that each return are one execution per path', () => {
    expect(() =>
      check(['f'], [{ k: 'while', cond: { k: 'const', value: 1 }, body: [exitArm(), exitArm()] }]),
    ).not.toThrow();
  });

  test('an arm that returns does not excuse a render on the path that falls past it', () => {
    const fallsPast: Stmt = { k: 'if', cond: { k: 'var', name: 'c' }, then: [callStmt('f')], else: [] };
    expect(() => check(['f'], [exitArm(), fallsPast, callStmt('f')])).toThrow(/emitted 2 calls to 'f' on one path/);
  });

  test('a break carries its calls to what follows the loop', () => {
    const brk: Stmt = { k: 'if', cond: { k: 'var', name: 'c' }, then: [callStmt('f'), { k: 'break' }], else: [] };
    const loop: Stmt = { k: 'while', cond: { k: 'const', value: 1 }, body: [brk] };
    expect(() => check(['f'], [loop, callStmt('f')])).toThrow(/emitted 2 calls to 'f' on one path/);
  });
});

describe('assertEffectsPreserved — a region no path reaches', () => {
  // The per-path count skips what follows a statement every path leaves, so a region the
  // structurer emitted there is refused rather than skipped: it holds statements the asm never ran,
  // and a duplicated compare chain hides in it (mwcc's DVDCancelStream shape: a `switch` whose arms
  // all `continue` or `return`, then the chain again with its calls).
  const allLeave: Stmt = {
    k: 'switch',
    scrutinee: { k: 'var', name: 's' },
    cases: [{ values: [1, 5], body: [callStmt('h'), { k: 'continue' }], fallsThrough: false }],
    default: [callStmt('h'), { k: 'return', value: { k: 'const', value: 0 } }],
  };

  test('statements after a switch whose arms all leave are refused', () => {
    const loop: Stmt = { k: 'while', cond: { k: 'const', value: 1 }, body: [allLeave, callStmt('h'), { k: 'break' }] };
    expect(() => check(['h', 'h'], [loop, callStmt('h')])).toThrow(/2 statement\(s\) no path reaches/);
  });

  test('the same switch with nothing after it is fine', () => {
    const loop: Stmt = { k: 'while', cond: { k: 'const', value: 1 }, body: [allLeave] };
    expect(() => check(['h', 'h'], [loop])).not.toThrow();
  });

  test('a statement after an if whose arms both return is refused', () => {
    const both: Stmt = {
      k: 'if',
      cond: { k: 'var', name: 'c' },
      then: [{ k: 'return', value: { k: 'const', value: 1 } }],
      else: [callStmt('f'), { k: 'return', value: { k: 'const', value: 0 } }],
    };
    expect(() => check(['f'], [both, callStmt('f')])).toThrow(/no path reaches/);
  });
});

describe('assertEffectsPreserved — fall-through chains', () => {
  // The switch round's CRITICAL: an arm that falls through RUNS the next arm's body too, so the
  // two counts add on that path even though each arm spells the call once.
  const chained = (fallsThrough: boolean): Stmt => ({
    k: 'switch',
    scrutinee: { k: 'var', name: 'x' },
    cases: [
      { values: [0], body: [callStmt('f')], fallsThrough },
      { values: [1], body: [callStmt('f')], fallsThrough: false },
    ],
  });

  test('a fall-through arm adds the next arm’s calls to its own path', () => {
    expect(() => check(['f'], [chained(true)])).toThrow(/emitted 2 calls to 'f' on one path/);
  });

  test('the same two arms with a break between them are exclusive', () => {
    expect(() => check(['f'], [chained(false)])).not.toThrow();
  });

  test('the LAST arm falls through into the default', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: { k: 'var', name: 'x' },
      cases: [{ values: [0], body: [callStmt('f')], fallsThrough: true }],
      default: [callStmt('f')],
    };
    expect(() => check(['f'], [sw])).toThrow(/emitted 2 calls to 'f' on one path/);
  });
});

// mwcc, `int e3(int *q){ int r = 0, e; e = f(); while (1) { int s = q[3]; if (s != 1 && s != 5)
// break; h(0); q[3] = g(s); } h(e); return r; }`. The structurer emits the compare chain twice, once
// as a `switch` whose arms all leave and once as a dead tail with its own read and calls after it.
const MWCC_DEAD_TAIL = `00000000 <e3>:
   0:\tstwu    r1,-32(r1)
   4:\tmflr    r0
   8:\tstw     r0,36(r1)
   c:\tstw     r31,28(r1)
  10:\tstw     r30,24(r1)
  14:\tstw     r29,20(r1)
  18:\tmr      r29,r3
  1c:\tbl      1c <e3+0x1c>
\t\t\t1c: R_PPC_REL24\tf
  20:\tmr      r31,r3
  24:\tlwz     r30,12(r29)
  28:\tcmpwi   r30,1
  2c:\tbeq-    38 <e3+0x38>
  30:\tcmpwi   r30,5
  34:\tbne-    50 <e3+0x50>
  38:\tli      r3,0
  3c:\tbl      3c <e3+0x3c>
\t\t\t3c: R_PPC_REL24\th
  40:\tmr      r3,r30
  44:\tbl      44 <e3+0x44>
\t\t\t44: R_PPC_REL24\tg
  48:\tstw     r3,12(r29)
  4c:\tb       24 <e3+0x24>
  50:\tmr      r3,r31
  54:\tbl      54 <e3+0x54>
\t\t\t54: R_PPC_REL24\th
  58:\tlwz     r0,36(r1)
  5c:\tli      r3,0
  60:\tlwz     r31,28(r1)
  64:\tlwz     r30,24(r1)
  68:\tlwz     r29,20(r1)
  6c:\tmtlr    r0
  70:\taddi    r1,r1,32
  74:\tblr
`;

test('a lift carrying a region no path reaches declines through the pipeline', () => {
  const prototypes = { e3: { params: 1 }, f: { params: 0 }, g: { params: 1 }, h: { params: 1, returnsVoid: true } };
  expect(() => decompile('e3', MWCC_DEAD_TAIL, PPC_MWCC, { prototypes })).toThrow(/no path reaches/);
});

// A memory access the lift pinned (`volatile`, the `device` placement) is an execution the way a
// call is: the qualified spelling makes the recompile perform it once per render.
describe('assertEffectsPreserved — a pinned device access', () => {
  const REG = 0x4000006;
  /** an IR fn whose entry block makes one pinned `load` of each address in `reads` (null: through a
   *  runtime-indexed base), and one plain load of each in `plain` */
  const irReading = (reads: (number | null)[], plain: number[] = []): Fn => {
    const ops = [];
    const load = (addr: number | null, volatile: boolean) => {
      const base = mkValue(T.ptr(T.u(16)));
      if (addr === null) {
        const idx = mkValue(T.s(32));
        ops.push(mkOp('add', { operands: [mkValue(T.ptr(T.u(16))), idx], results: [base] }));
      } else {
        ops.push(mkOp('const', { results: [base], attrs: { value: addr } }));
      }
      ops.push(
        mkOp('load', {
          operands: [base],
          results: [mkValue(T.u(16))],
          attrs: { off: 0, width: 2, signed: false, ...(volatile ? { volatile: true } : {}) },
        }),
      );
    };
    reads.forEach((a) => load(a, true));
    plain.forEach((a) => load(a, false));
    ops.push(mkOp('ret', {}));
    return {
      name: 'F',
      blocks: [{ params: [], ops }],
      writeOrder: undefined,
      slotHomes: undefined,
      paramEvidence: undefined,
      localObjects: undefined,
    };
  };
  const at = (addr: Expr, volatile: boolean): Expr => ({
    k: 'index',
    base: { k: 'cast', to: T.ptr(T.u(16)), e: addr, ...(volatile ? { volatile: true as const } : {}) },
    idx: { k: 'const', value: 0 },
    width: 2,
    signed: false,
  });
  const read = (addr: number, volatile = true): Stmt => ({
    k: 'exprstmt',
    value: at({ k: 'const', value: addr }, volatile),
  });
  const readThrough = (base: string): Stmt => ({ k: 'exprstmt', value: at({ k: 'var', name: base }, true) });
  const checkReads = (fn: Fn, body: Stmt[]) => assertEffectsPreserved(fn, sfnWith(body));

  test('one pinned read rendered twice in sequence fails', () => {
    expect(() => checkReads(irReading([REG]), [read(REG), read(REG)])).toThrow(
      /emitted 2 accesses to the device register at 0x4000006 on one path/,
    );
  });

  test('one pinned read rendered once in each of two exclusive arms passes', () => {
    const arms: Stmt = { k: 'if', cond: { k: 'var', name: 'c' }, then: [read(REG)], else: [read(REG)] };
    expect(() => checkReads(irReading([REG]), [arms])).not.toThrow();
  });

  test('two pinned reads of one register license two renders', () => {
    expect(() => checkReads(irReading([REG, REG]), [read(REG), read(REG)])).not.toThrow();
  });

  test('a pinned read with no qualified render fails as dropped', () => {
    expect(() => checkReads(irReading([REG]), [read(REG, false)])).toThrow(
      /dropped the access to the device register at 0x4000006/,
    );
  });

  test('a plain read is not counted, rendered however often', () => {
    expect(() => checkReads(irReading([], [REG]), [read(REG, false), read(REG, false)])).not.toThrow();
  });

  test('a render the contract cannot place may stand for a read at a known address', () => {
    expect(() => checkReads(irReading([REG]), [readThrough('p')])).not.toThrow();
  });

  test('a read at no constant address licenses one render on a path, wherever it lands', () => {
    expect(() => checkReads(irReading([null]), [readThrough('p')])).not.toThrow();
    expect(() => checkReads(irReading([null]), [readThrough('p'), readThrough('p')])).toThrow(
      /emitted 2 accesses to device registers on one path in 'F', where the asm makes 1/,
    );
  });
});
