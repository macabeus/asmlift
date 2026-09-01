// The un-merge lever (l3/unmerge.ts): a join statement pushed back into the arms agbcc
// cross-jumped it out of — the dual of tailmerge.test.ts's pass, and a lever where that one is
// unconditional.
//
// The refusals are the whole argument, because the rewrite DUPLICATES a statement and DELETES the
// definitions feeding it: each one is a place where the copy would read a different value than the
// merged spelling did, and nothing downstream would notice.
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { unmergeJoins } from '../src/l3/unmerge';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const asg = (name: string, value: Expr): Stmt => ({ k: 'assign', name, value });
const deref = (p: Expr): Expr => ({ k: 'index', base: p, idx: c(0), width: 2, signed: false });
const store = (p: Expr, value: Expr): Stmt => ({ k: 'store', lval: deref(p), value });
const call = (fn: string): Expr => ({ k: 'call', fn, args: [] });
const iff = (then: Stmt[], els: Stmt[]): Stmt => ({ k: 'if', cond: v('cond'), then, else: els });

const fn = (body: Stmt[], names = ['p', 'x']): SFn => ({
  name: 'f',
  params: [],
  locals: names.map((name) => ({ name, type: T.s(32) })),
  globals: [],
  retType: T.void(),
  body,
});

/** the canonical shape: both arms define the address and the value, the join stores through them */
const merged = (extraThen: Stmt[] = [], extraElse: Stmt[] = []): Stmt[] => [
  iff([...extraThen, asg('p', v('a')), asg('x', c(1))], [...extraElse, asg('p', v('b')), asg('x', c(2))]),
  store(v('p'), v('x')),
];

const armsOf = (s: SFn): [Stmt[], Stmt[]] => {
  const i = s.body[0] as Extract<Stmt, { k: 'if' }>;
  return [i.then, i.else];
};

describe('what un-merges', () => {
  test("the join statement is duplicated into both arms with each arm's own definitions", () => {
    const out = unmergeJoins(fn(merged()));
    expect(out).not.toBeNull();
    expect(out!.body).toHaveLength(1); // the join statement is gone from the outer list
    const [then, els] = armsOf(out!);
    expect(then).toEqual([store(v('a'), c(1))]);
    expect(els).toEqual([store(v('b'), c(2))]);
  });

  test('the merge temps are DROPPED from the declaration list', () => {
    expect(unmergeJoins(fn(merged()))!.locals).toEqual([]);
  });

  test('statements BEFORE the definitions stay in their own arm, in order', () => {
    const [then, els] = armsOf(unmergeJoins(fn(merged([store(v('g'), c(7))], [store(v('h'), c(8))])))!);
    expect(then).toEqual([store(v('g'), c(7)), store(v('a'), c(1))]);
    expect(els).toEqual([store(v('h'), c(8)), store(v('b'), c(2))]);
  });

  test('it fires inside a loop body, not only at the top level', () => {
    const out = unmergeJoins(fn([{ k: 'dowhile', cond: v('cond'), body: merged() }]));
    expect(out).not.toBeNull();
    const body = (out!.body[0] as Extract<Stmt, { k: 'dowhile' }>).body;
    expect(body).toHaveLength(1);
  });

  test('an unrelated assignment BETWEEN the definitions is kept, and the copy lands after it', () => {
    // the shape the corpus actually has: the structurer interleaves another merge variable's
    // write between the address and the value
    const body = [
      iff([asg('p', v('a')), asg('q', c(5)), asg('x', c(1))], [asg('p', v('b')), asg('q', c(6)), asg('x', c(2))]),
      store(v('p'), v('x')),
    ];
    const out = unmergeJoins(fn(body, ['p', 'x', 'q']));
    expect(out).not.toBeNull();
    expect(armsOf(out!)[0]).toEqual([asg('q', c(5)), store(v('a'), c(1))]);
    expect(out!.locals.map((l) => l.name)).toEqual(['q']); // only the substituted temps are dropped
  });

  test('a join reading ONE merge temp un-merges too — the rule is not about pairs', () => {
    const out = unmergeJoins(fn([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), v('x'))], ['x']));
    expect(out).not.toBeNull();
    expect(armsOf(out!)[0]).toEqual([store(v('g'), c(1))]);
  });
});

describe('what refuses — each one would read a different value', () => {
  const declines = (body: Stmt[], names?: string[]) => expect(unmergeJoins(fn(body, names))).toBeNull();

  test('an EMPTY arm: nothing there defines the join`s operands', () => {
    declines([iff([asg('p', v('a')), asg('x', c(1))], []), store(v('p'), v('x'))]);
  });

  test('a join statement that is CONTROL FLOW is never duplicated into an arm', () => {
    declines([iff([asg('x', c(1))], [asg('x', c(2))]), { k: 'return', value: v('x') }], ['x']);
  });

  test('a join reading no local at all — there is no merge to undo', () => {
    declines([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), c(0))], ['x']);
  });

  test('a merge temp READ AGAIN after the join keeps its name', () => {
    declines([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), v('x')), store(v('h'), v('x'))], ['x']);
  });

  test('a merge temp assigned in only ONE arm (or three times) refuses', () => {
    declines([iff([asg('x', c(1))], [store(v('g'), c(0))]), store(v('h'), v('x'))], ['x']);
    declines([iff([asg('x', c(1)), asg('x', c(3))], [asg('x', c(2))]), store(v('h'), v('x'))], ['x']);
  });

  test('a definition that is NOT in the arm`s trailing run refuses', () => {
    // `g[0] = 0` sits between the definition and the join, and it may write what `a` reads
    declines([
      iff([asg('p', v('a')), asg('x', c(1)), store(v('g'), c(0))], [asg('p', v('b')), asg('x', c(2))]),
      store(v('p'), v('x')),
    ]);
  });

  test('an intervening assignment that CLOBBERS what a definition reads refuses', () => {
    // `p = a` is evaluated where the copy lands, and `a = 9` runs before that point
    declines(
      [
        iff([asg('p', v('a')), asg('a', c(9)), asg('x', c(1))], [asg('p', v('b')), asg('a', c(9)), asg('x', c(2))]),
        store(v('p'), v('x')),
      ],
      ['p', 'x', 'a'],
    );
  });

  test('a join reading a local the arms WRITE but this cannot substitute refuses', () => {
    // `q` is assigned three times, so it is no merge temp — and its value at the arm's end is not
    // the value the join read
    declines(
      [iff([asg('q', c(1)), asg('x', c(1))], [asg('q', c(2)), asg('q', c(3)), asg('x', c(2))]), store(v('q'), v('x'))],
      ['x', 'q'],
    );
  });

  test('a definition whose value reads ANOTHER merge temp refuses — the order is not fixed', () => {
    declines([iff([asg('p', v('a')), asg('x', v('p'))], [asg('p', v('b')), asg('x', v('p'))]), store(v('p'), v('x'))]);
  });

  test('a definition carrying an EFFECT refuses — C fixes no order between one statement`s operands', () => {
    declines([
      iff([asg('p', v('a')), asg('x', call('side'))], [asg('p', v('b')), asg('x', call('side'))]),
      store(v('p'), v('x')),
    ]);
  });

  // The KIND test that used to stand alone here is not the refusal the header states: an `assign`
  // whose VALUE is a call IS an intervening call. Without the effect test on the kept statements,
  // `p = *g` was substituted into a join that landed AFTER `q = Foo();`, so a load the lifted tree
  // performed before the call was performed after it — a candidate that reads memory at a
  // different point than the asm does, with no contract downstream that models evaluation order
  // (`assertEffectsPreserved` does not run on lever trees).
  test('an intervening assignment whose VALUE is a CALL refuses — the kind test is not the effect test', () => {
    declines(
      [
        iff(
          [asg('p', deref(v('g'))), asg('q', call('Foo')), asg('x', c(1))],
          [asg('p', deref(v('h'))), asg('q', call('Foo')), asg('x', c(2))],
        ),
        store(v('p'), v('x')),
      ],
      ['p', 'x', 'q'],
    );
  });

  test('a tree with no eligible site DECLINES rather than returning a copy of itself', () => {
    expect(unmergeJoins(fn([store(v('g'), c(0))], []))).toBeNull();
  });
});

// THE ONE THING THIS PASS MOVES is a definition's VALUE, from its own statement down to the arm's
// end. A plain read may make that trip — nothing a kept statement does can answer it differently,
// which is what the effect gates above establish. A VOLATILE read may not: it is an access the
// machine performed at a stated point, and the copy performs it at a different one, after any
// observable access the kept statements hold.
//
// `exprHasEffect` is documented as "a call, or a marker" and does not model a qualifier, so the
// refusal is asked of the qualifier's own model (`exprReadsVolatile`), never of a node kind.
// A KEPT STATEMENT MAY NOT WRITE MEMORY EITHER, and `exprHasEffect` cannot say so: it answers "a
// call, or a marker" about a VALUE, and the thing that writes here is the assignment's TARGET.
// `structure.ts` spells a write to a scalar global as an `assign` — `gBlendValue = v;` — so the
// kind test and the value test both pass while the statement stores to memory a moved read could
// be answered by.
describe('a kept statement writes no memory — its target, not only its value', () => {
  test('an intervening assignment to a GLOBAL refuses — an `assign` is not always a local write', () => {
    // `gBlendValue` is named by no local and no param, exactly as structure.ts leaves it.
    const body = [
      iff(
        [asg('p', deref(v('s'))), asg('gBlendValue', c(5)), asg('x', c(1))],
        [asg('p', deref(v('s'))), asg('gBlendValue', c(6)), asg('x', c(2))],
      ),
      store(v('g'), v('p')),
    ];
    expect(unmergeJoins(fn(body, ['p', 'x', 's']))).toBeNull();
  });

  test('THE CONTROL: the identical shape writing a declared LOCAL still un-merges', () => {
    const body = [
      iff(
        [asg('p', deref(v('s'))), asg('q', c(5)), asg('x', c(1))],
        [asg('p', deref(v('s'))), asg('q', c(6)), asg('x', c(2))],
      ),
      store(v('g'), v('p')),
    ];
    expect(unmergeJoins(fn(body, ['p', 'x', 's', 'q']))).not.toBeNull();
  });

  test('…and a PARAM is a declared local for this purpose, not a global', () => {
    const base = fn(
      [
        iff(
          [asg('p', deref(v('s'))), asg('a0', c(5)), asg('x', c(1))],
          [asg('p', deref(v('s'))), asg('a0', c(6)), asg('x', c(2))],
        ),
        store(v('g'), v('p')),
      ],
      ['p', 'x', 's'],
    );
    expect(unmergeJoins({ ...base, params: [{ name: 'a0', type: T.s(32) }] })).not.toBeNull();
  });
});

describe('an observable access is never the thing that moves', () => {
  const volCast = (addr: number): Expr => ({
    k: 'index',
    base: { k: 'cast', to: T.ptr(T.u(16)), e: c(addr), volatile: true },
    idx: c(0),
    width: 2,
    signed: false,
  });
  const volFn = (body: Stmt[], names: string[], quals: Record<string, 'object' | 'pointee'> = {}): SFn => ({
    ...fn(body, names),
    locals: names.map((name) => ({
      name,
      type: T.s(32),
      ...(quals[name] === 'object' ? { volatile: true as const } : {}),
      ...(quals[name] === 'pointee' ? { pointeeVolatile: true as const } : {}),
    })),
  });

  test('a definition reading a DEVICE REGISTER refuses — the copy would touch it after the kept read', () => {
    // REG_DMA3SAD moved below a read of REG_DMA3CNT: the two device reads swap order, and the
    // published source performs them in an order the asm did not.
    const body = [
      iff(
        [asg('p', volCast(0x40000d4)), asg('q', volCast(0x40000d8)), asg('x', c(1))],
        [asg('p', volCast(0x40000d4)), asg('q', volCast(0x40000d8)), asg('x', c(2))],
      ),
      store(v('g'), v('p')),
    ];
    expect(unmergeJoins(volFn(body, ['p', 'x', 'q']))).toBeNull();
  });

  test('…and through a pointer local DECLARED to point at volatile data, not only through a cast', () => {
    const body = [
      iff([asg('p', deref(v('m'))), asg('x', c(1))], [asg('p', deref(v('m'))), asg('x', c(2))]),
      store(v('g'), v('p')),
    ];
    expect(unmergeJoins(volFn(body, ['p', 'x', 'm'], { m: 'pointee' }))).toBeNull();
  });

  test('…and a read of a VOLATILE local object', () => {
    const body = [iff([asg('p', v('m')), asg('x', c(1))], [asg('p', v('m')), asg('x', c(2))]), store(v('g'), v('p'))];
    expect(unmergeJoins(volFn(body, ['p', 'x', 'm'], { m: 'object' }))).toBeNull();
  });

  test('THE CONTROL: the same shape with PLAIN reads still un-merges — the gate is the qualifier', () => {
    // Identical statement kinds, identical positions; only the `volatile` is gone. If this
    // refused too, the rule would be "a definition may not read memory", which is not the rule
    // and would delete the corpus shape the lever exists for.
    const plain = (addr: number): Expr => ({
      k: 'index',
      base: { k: 'cast', to: T.ptr(T.u(16)), e: c(addr) },
      idx: c(0),
      width: 2,
      signed: false,
    });
    const body = [
      iff(
        [asg('p', plain(0x40000d4)), asg('q', plain(0x40000d8)), asg('x', c(1))],
        [asg('p', plain(0x40000d4)), asg('q', plain(0x40000d8)), asg('x', c(2))],
      ),
      store(v('g'), v('p')),
    ];
    expect(unmergeJoins(volFn(body, ['p', 'x', 'q']))).not.toBeNull();
  });

  test('THE SCOPE: a volatile read among the KEPT statements alone still un-merges — it does not move', () => {
    // The kept statements hold their positions and the join lands exactly where it already ran,
    // so the only access whose position changes is a definition's. A gate on the kept statements
    // would refuse a site with nothing wrong with it.
    const body = [
      iff(
        [asg('q', volCast(0x40000d8)), asg('p', v('a')), asg('x', c(1))],
        [asg('q', volCast(0x40000d8)), asg('p', v('b')), asg('x', c(2))],
      ),
      store(v('p'), v('x')),
    ];
    expect(unmergeJoins(volFn(body, ['p', 'x', 'q']))).not.toBeNull();
  });
});

// THE COUNTS THE MERGE-TEMP TEST RESTS ON. `readsOf(m) === 1` above is a FUNCTION-WIDE count from
// l3/mentions.ts, so a use that walk cannot see is a temp this pass deletes while the body still
// reads it. `index.lead` — a multidimensional global's leading subscripts — is a position that
// carries a real value, and it is the position mentions.ts's hand-rolled walk had to be taught.
describe('a merge temp read from a position the mention count must see', () => {
  const leadIx = (row: string): Expr => ({
    k: 'index',
    base: { k: 'addr', name: 'gRows' },
    idx: c(7),
    lead: [v(row)],
    width: 2,
    signed: false,
  });

  test('a second read as a LEADING SUBSCRIPT refuses, like a second read anywhere else', () => {
    // `p` is assigned once per arm and read by the join — and read again, elsewhere, as the row
    // subscript of `gRows[p][7]`. Substituting and deleting it would emit C naming an undeclared
    // `p`; the candidate is then lost at the compiler under whatever diagnostic sorts first.
    const body: Stmt[] = [...merged(), asg('q', leadIx('p'))];
    expect(unmergeJoins(fn(body, ['p', 'x', 'q']))).toBeNull();
  });

  test('the control: the same shape with the extra read in the ORDINARY index position refuses too', () => {
    const idxIx: Expr = { k: 'index', base: { k: 'addr', name: 'gRows' }, idx: v('p'), width: 2, signed: false };
    expect(unmergeJoins(fn([...merged(), asg('q', idxIx)], ['p', 'x', 'q']))).toBeNull();
  });
});
