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
import { tallying, without } from '../src/l3/gates';
import { UNMERGE_ARM_GATES, UNMERGE_RUNG_GATES, UNMERGE_SITE_GATES, unmergeJoins } from '../src/l3/unmerge';
import { c, v } from './helpers';

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

  // `rewrite` descends into `while`, `for` and BOTH lists of a `switch` as well as `dowhile`, and
  // the descent is where a nesting kind gets forgotten — a `switch`'s `default` is a second list,
  // and a `for`'s body is not its init or inc. So each arm of that switch statement gets a firing
  // rather than an argument.
  test('it fires inside a `while` body', () => {
    const out = unmergeJoins(fn([{ k: 'while', cond: v('cond'), body: merged() }]));
    expect(out).not.toBeNull();
    expect((out!.body[0] as Extract<Stmt, { k: 'while' }>).body).toHaveLength(1);
  });

  test('it fires inside a `for` body', () => {
    const out = unmergeJoins(
      fn([{ k: 'for', init: asg('i', c(0)), cond: v('cond'), inc: asg('i', c(1)), body: merged() }], ['p', 'x', 'i']),
    );
    expect(out).not.toBeNull();
    expect((out!.body[0] as Extract<Stmt, { k: 'for' }>).body).toHaveLength(1);
  });

  test('it fires inside a `switch` CASE body and inside its DEFAULT', () => {
    const sw = (body: Stmt[], dflt: Stmt[]): Stmt => ({
      k: 'switch',
      scrutinee: v('cond'),
      cases: [{ values: [1], fallsThrough: false, body }],
      default: dflt,
    });
    const inCase = unmergeJoins(fn([sw(merged(), [])]));
    expect(inCase).not.toBeNull();
    expect((inCase!.body[0] as Extract<Stmt, { k: 'switch' }>).cases[0].body).toHaveLength(1);
    const inDefault = unmergeJoins(fn([sw([], merged())]));
    expect(inDefault).not.toBeNull();
    expect((inDefault!.body[0] as Extract<Stmt, { k: 'switch' }>).default).toHaveLength(1);
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

  // THE CANDIDATE GATE'S TWO SIDES. `assigns >= 2` alone admits a ladder's merge temp AND a name
  // the arms NEVER WRITE — which `armDefs` then cannot define, so the whole site declines instead
  // of un-merging its real temps. `written.has(n)` is what keeps that name a bystander; `assigns`
  // is a FUNCTION-WIDE count and cannot do it by arithmetic at any arity. Ablate the conjunct and
  // this test and the next two go null.
  test('a local the join reads but the arms never write stays a BYSTANDER, not a candidate', () => {
    const body: Stmt[] = [
      asg('n', c(1)),
      asg('n', c(2)),
      asg('n', c(3)),
      iff([asg('x', c(1))], [asg('x', c(2))]),
      store(v('n'), v('x')),
    ];
    const out = unmergeJoins(fn(body, ['n', 'x']));
    expect(out).not.toBeNull(); // `x` un-merges; `n` is not the pass's business
    expect(out!.locals.map((l) => l.name)).toEqual(['n']);
    const site = out!.body[3] as Extract<Stmt, { k: 'if' }>;
    expect(site.then).toEqual([store(v('n'), c(1))]);
    expect(site.else).toEqual([store(v('n'), c(2))]);
  });

  // The same shape at exactly TWO outside assignments — the arity the conjunct cannot be mistaken
  // for, since a bystander assigned twice is exactly what a count alone admits as a candidate.
  test('a bystander with exactly TWO assignments does not sink the site', () => {
    const body: Stmt[] = [
      asg('n', c(1)),
      asg('n', c(2)),
      iff([asg('x', c(1))], [asg('x', c(2))]),
      store(v('n'), v('x')),
    ];
    const out = unmergeJoins(fn(body, ['n', 'x']));
    expect(out).not.toBeNull();
    expect(out!.locals.map((l) => l.name)).toEqual(['n']);
    const site = out!.body[2] as Extract<Stmt, { k: 'if' }>;
    expect(site.then).toEqual([store(v('n'), c(1))]);
    expect(site.else).toEqual([store(v('n'), c(2))]);
  });

  // And the bystander in the VALUE position rather than the address, which is the same admission
  // seen from the other side: the arms define `p`, the join also reads `y`, and `y` is carried
  // into both copies unchanged. The copy is always LAST in its arm, so nothing `y` reads moves.
  test('a bystander the join READS is carried into both copies, and its local is kept', () => {
    const body: Stmt[] = [
      asg('y', c(1)),
      asg('y', c(2)),
      iff([asg('p', v('a'))], [asg('p', v('b'))]),
      store(v('p'), v('y')),
    ];
    const out = unmergeJoins(fn(body, ['p', 'y']));
    expect(out).not.toBeNull();
    expect(out!.locals.map((l) => l.name)).toEqual(['y']);
    const site = out!.body[2] as Extract<Stmt, { k: 'if' }>;
    expect(site.then).toEqual([store(v('a'), v('y'))]);
    expect(site.else).toEqual([store(v('b'), v('y'))]);
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

  // A statement's KIND is not the refusal the header states: an `assign` whose VALUE is a call IS
  // an intervening call. Without the effect test on the kept statements, `p = *g` substitutes into
  // a join that lands AFTER `q = Foo();`, so a load the lifted tree performed before the call is
  // performed after it — a candidate that reads memory at a different point than the asm does,
  // with no contract downstream that models evaluation order (`assertEffectsPreserved` does not
  // run on lever trees).
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
// reads it. `index.lead` — a multidimensional global's leading subscripts — carries a real value
// and is one of the positions that walk enumerates by hand rather than getting from the shared
// vocabulary, which is why it is worth a test from this side too.
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

// THE LADDER. agbcc cross-jumps the shared tail of an else-if CHAIN the same way it cross-jumps a
// two-armed `if`'s: every arm stored the same slot, and one `str` came out. The lifted tree then
// carries the join after the OUTERMOST `if`, whose `else` is another `if` rather than a run of
// assignments — so the arm the copy belongs in is not the arm the pass is handed. Pushing the join
// down to every TERMINAL arm is the same rewrite, applied where the ladder bottoms out, and the
// soundness argument is the two-arm one read inductively: every path out of the ladder leaves
// through exactly one terminal arm, so one copy at the end of each runs exactly once per path.
//
// No arm count survives that: a five-arm ladder assigns its merge name five times. TOTALITY stands
// in — every definition in the whole function must be one of the terminal arms just rewritten —
// and because that count is read from a map built before the pass started rewriting, a FRESH
// re-read of the result is what actually carries it.
describe('an else-if LADDER un-merges into every terminal arm', () => {
  /** `if (cond) {a} else if (cond) {b} else …` — one terminal arm per entry, nested to the right. */
  const ladder = (arms: Stmt[][]): Stmt =>
    arms.length === 2 ? iff(arms[0], arms[1]) : iff(arms[0], [ladder(arms.slice(1))]);

  const defs = (p: string, x: number): Stmt[] => [asg('p', v(p)), asg('x', c(x))];

  test('a THREE-arm ladder puts the join in all three, with each arm`s own definitions', () => {
    const out = unmergeJoins(fn([ladder([defs('a', 1), defs('b', 2), defs('d', 3)]), store(v('p'), v('x'))]));
    expect(out).not.toBeNull();
    expect(out!.body).toHaveLength(1); // the join is gone from the outer list
    expect(out!.locals).toEqual([]); // both merge temps consumed
    const top = out!.body[0] as Extract<Stmt, { k: 'if' }>;
    expect(top.then).toEqual([store(v('a'), c(1))]);
    const inner = top.else[0] as Extract<Stmt, { k: 'if' }>;
    expect(inner.then).toEqual([store(v('b'), c(2))]);
    expect(inner.else).toEqual([store(v('d'), c(3))]);
  });

  test('a FIVE-arm ladder — `synthetic:armcb`s own shape — reaches the last arm too', () => {
    const arms = [defs('a', 1), defs('b', 2), defs('d', 3), defs('e', 4), defs('h', 5)];
    const out = unmergeJoins(fn([ladder(arms), store(v('p'), v('x'))]));
    expect(out).not.toBeNull();
    const stores: Stmt[] = [];
    const walk = (s: Stmt): void => {
      if (s.k === 'if') {
        [...s.then, ...s.else].forEach(walk);
      } else {
        stores.push(s);
      }
    };
    walk(out!.body[0]);
    expect(stores).toEqual([
      store(v('a'), c(1)),
      store(v('b'), c(2)),
      store(v('d'), c(3)),
      store(v('e'), c(4)),
      store(v('h'), c(5)),
    ]);
  });

  // THE ADMITTED SHAPE IS NOT AN ELSE-IF CHAIN, and calling it a ladder should not hide that. The
  // soundness argument is "every path out leaves through exactly one terminal arm", which a
  // BALANCED tree satisfies as fully as a chain. Pinned so the file's comment is a claim about the
  // code and not about the corpus: one copy per TERMINAL ARM, so the emitted source is linear in
  // the subtree walked, which is why the recursion needs no cap.
  test('a BALANCED nested `if` tree fires too — one copy per terminal arm, not one per rung', () => {
    const leaf = (p: string, x: number): Stmt[] => [asg('p', v(p)), asg('x', c(x))];
    const body = [iff([iff(leaf('a', 1), leaf('b', 2))], [iff(leaf('d', 3), leaf('e', 4))]), store(v('p'), v('x'))];
    const out = unmergeJoins(fn(body));
    expect(out).not.toBeNull();
    expect(out!.body).toHaveLength(1);
    expect(out!.locals).toEqual([]);
    const stores: Stmt[] = [];
    const walk = (st: Stmt): void => {
      if (st.k === 'if') {
        [...st.then, ...st.else].forEach(walk);
      } else {
        stores.push(st);
      }
    };
    walk(out!.body[0]);
    expect(stores).toEqual([store(v('a'), c(1)), store(v('b'), c(2)), store(v('d'), c(3)), store(v('e'), c(4))]);
  });

  test('a statement before the trailing `if` is kept where it is — no moved value crosses it', () => {
    const body = [
      iff(defs('a', 1), [store(v('g'), c(9)), ladder([defs('b', 2), defs('d', 3)])]),
      store(v('p'), v('x')),
    ];
    const out = unmergeJoins(fn(body));
    expect(out).not.toBeNull();
    const [, els] = armsOf(out!);
    expect(els[0]).toEqual(store(v('g'), c(9)));
  });
});

// The ladder's refusals. Each is a place the merged spelling has to survive, and the first two are
// what stands in for an arm count: without them this pass deletes a local the emitted tree still
// names, which compiles to nothing at all.
describe('what the ladder refuses', () => {
  const ladder = (arms: Stmt[][]): Stmt =>
    arms.length === 2 ? iff(arms[0], arms[1]) : iff(arms[0], [ladder(arms.slice(1))]);
  const declines = (body: Stmt[], names?: string[]) => expect(unmergeJoins(fn(body, names))).toBeNull();

  test('a definition OUTSIDE the terminal arms refuses — totality, not arity', () => {
    // `x = 0` before the `if` is a third definition with nothing left to read it once the temp is
    // deleted. The check that catches it is "every assignment in the function is one of the arms
    // we rewrote" — an arity count on its own does not say that.
    declines([asg('x', c(0)), iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), v('x'))], ['x']);
  });

  test('the tail of an arm is not a two-armed `if` — the ladder does not bottom out', () => {
    declines(
      [ladder([[asg('x', c(1))], [asg('x', c(2))], [asg('x', c(3)), store(v('g'), c(0))]]), store(v('h'), v('x'))],
      ['x'],
    );
  });

  test('an EMPTY terminal arm refuses — that path would get no copy of the join', () => {
    declines([iff([asg('x', c(1))], [iff([asg('x', c(2))], [])]), store(v('g'), v('x'))], ['x']);
  });

  test('a repeated definition inside ONE terminal arm refuses', () => {
    declines(
      [ladder([[asg('x', c(1))], [asg('x', c(2))], [asg('x', c(3)), asg('x', c(4))]]), store(v('g'), v('x'))],
      ['x'],
    );
  });
});

// THE COUNTS ARE STALE AND THE RECURSION IS WHAT MAKES THAT REACHABLE. `localMentions` is read once,
// before the pass rewrites anything, and this pass DUPLICATES statements — so an earlier site inside
// the same tree can turn one definition of a name into two while the map still says one. Totality
// does not catch it, because the stale count and the fresh arm count can agree by coincidence —
// which is exactly the tree below.
// The gate that holds is a FRESH re-read of the rewritten statement: if a merge name is still
// mentioned anywhere in it, the rewrite did not consume it and the local may not be deleted.
//
// AND THIS TEST IS THE ONLY THING IN THE REPO THAT SAYS THE GATE IS LIVE — do not delete it as
// redundant. Measured by ablating each gate: delete the TOTALITY check and 89 random trees break
// under `test/unmerge-fuzz.test.ts`'s oracle; delete the FRESH RE-READ and that oracle stays
// GREEN, across 120,000 trees in two families, the second generated specifically to nest an
// un-merge site whose own join assigns the outer merge name — the exact family the gate exists
// for. Under that same ablation the only red in the repo is the single test below.
//
// `contracts.ts`'s `assertNoOrphanedLocals` is a second net and not a substitute: it fires on this
// tree (verified under the ablation), but it lives at rank.ts's lever boundary, so it turns a
// wrong rewrite into a DROPPED CANDIDATE, not into the merged spelling this gate preserves.
describe('a stale mention count is caught by re-reading the result', () => {
  test('a definition an earlier rewrite duplicated leaves the count agreeing, and the tree still names `y`', () => {
    // Inner site: `if (c) p = a; else p = d;  y = *p;` un-merges to `if (c) y = *a; else y = *d;`,
    // turning ONE assignment to `y` into two. The map still says four; the ladder consumes four
    // terminal arms; the counts agree — and `y = 7` is still sitting there.
    const body: Stmt[] = [
      iff(
        [asg('y', c(7)), iff([iff([asg('p', v('a'))], [asg('p', v('d'))]), asg('y', deref(v('p')))], [asg('y', c(2))])],
        [asg('y', c(3))],
      ),
      store(v('g'), v('y')),
    ];
    const out = unmergeJoins(fn(body, ['p', 'y']));
    expect(out).not.toBeNull(); // the INNER site fired and consumed `p`
    expect(out!.locals.map((l) => l.name)).toEqual(['y']); // `y` survives — the outer site refused
    expect(out!.body).toHaveLength(2); // the outer join is still a join

    // and the invariant the refusal exists for: nothing the tree assigns is undeclared
    const declared = new Set([...out!.locals.map((l) => l.name), ...out!.params.map((p) => p.name)]);
    const walk = (s: Stmt): string[] => [
      ...(s.k === 'assign' && !declared.has(s.name) && !s.name.startsWith('g') ? [s.name] : []),
      ...(s.k === 'if' ? [...s.then, ...s.else].flatMap(walk) : []),
    ];
    expect(out!.body.flatMap(walk)).toEqual([]);
  });
});

// THE ACCEPTANCE TEST FOR THE TABLES: a caller outside this pass can learn WHICH rule refused, and
// can drop one, without editing `l3/unmerge.ts`. Before the conversion both took an instrumented
// patch and a revert — which is the episode recorded in the file's header (56 firings, 40 on a
// non-`if` tail and 16 on an empty arm) and the evidence the conversion was licensed on.
describe('the refusal tables are readable from outside', () => {
  test('a census names the rule that refused each site, and counts it', () => {
    const t = tallying(UNMERGE_SITE_GATES);
    const gates = { site: t.gates };
    // one empty arm, one join reading nothing the arms define, and one that fires
    unmergeJoins(fn([iff([asg('p', v('a')), asg('x', c(1))], []), store(v('p'), v('x'))]), gates);
    unmergeJoins(fn([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('g'), c(0))], ['x']), gates);
    unmergeJoins(fn([iff([asg('x', c(1))], [asg('x', c(2))]), store(v('h'), c(0))], ['x']), gates);
    expect(unmergeJoins(fn(merged()), gates)).not.toBeNull();
    expect(t.refusals()).toEqual([
      ['no-merge-name', 2],
      ['empty-arm', 1],
    ]);
  });

  test('the RUNG census reproduces the split the instrumented run measured, without the patch', () => {
    const t = tallying(UNMERGE_RUNG_GATES);
    // an arm whose tail is a `store` rather than an `if`, and — one level down a ladder, where the
    // site table's own `empty-arm` cannot reach it — an EMPTY terminal arm
    unmergeJoins(fn([iff([asg('x', c(1)), store(v('g'), c(0))], [asg('x', c(2))]), store(v('h'), v('x'))], ['x']), {
      rung: t.gates,
    });
    unmergeJoins(fn([iff([asg('x', c(1))], [iff([asg('x', c(2))], [])]), store(v('g'), v('x'))], ['x']), {
      rung: t.gates,
    });
    expect(t.refusals()).toEqual([
      ['empty-arm-has-no-tail', 1],
      ['tail-is-not-an-if', 1],
    ]);
  });

  test('a gate can be ABLATED from outside, and the pass then admits what it refused', () => {
    // the `an intervening assignment that CLOBBERS what a definition reads` fixture: `a = 9` runs
    // before the point `p = a` is evaluated at
    const body = [
      iff([asg('p', v('a')), asg('a', c(9)), asg('x', c(1))], [asg('p', v('b')), asg('a', c(9)), asg('x', c(2))]),
      store(v('p'), v('x')),
    ];
    const names = ['p', 'x', 'a'];
    expect(unmergeJoins(fn(body, names))).toBeNull();
    expect(
      unmergeJoins(fn(body, names), { arm: without(UNMERGE_ARM_GATES, 'intervening-write-to-a-moved-read') }),
    ).not.toBeNull();
  });
});
