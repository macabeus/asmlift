// The `/inlinebase` lever (l3/inlinebase.ts): a pointer local holding a CONSTANT address is
// deleted and each access through it re-spelled as the cast constant. The gate conditions are
// what these tests pin — one bare-`const` assignment at the body's top level that nothing
// mentions earlier, no address taken, every use an `index` base, 2+ of them — and nothing
// qualifying means DECLINE, never a duplicate candidate.
import { expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { materializeArgBases } from '../src/l3/argbase';
import { type Expr, type SFn, type Stmt, exprChildren, stmtExprs } from '../src/l3/ast';
import { hoistReusedGlobalBases } from '../src/l3/basecse';
import { inlinableConstBases, inlineConstBases } from '../src/l3/inlinebase';
import { nearBaseClusters } from '../src/l3/nearbase';
import { hoistScopedBases } from '../src/l3/scopebase';
import { volatilePtrLocals } from '../src/l3/volatileptr';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const PTR = T.ptr(T.u(16));
const fn = (locals: SFn['locals'], body: Stmt[]): SFn => ({
  name: 'f',
  params: [],
  locals,
  retType: T.void(),
  body,
});
/** `*p` — the one use shape the lever re-spells */
const deref = (name: string): Expr => ({
  k: 'index',
  base: { k: 'var', name },
  idx: { k: 'const', value: 0 },
  width: 2,
  signed: false,
});
const setup: Stmt = { k: 'assign', name: 'p', value: { k: 'const', value: 0x4000208 } };
/** the qualifying shape: one const assignment, then two derefs through it */
const twoUses = (): Stmt[] => [
  setup,
  { k: 'store', lval: deref('p'), value: { k: 'const', value: 0 } },
  { k: 'store', lval: deref('p'), value: { k: 'const', value: 1 } },
];

test('a constant-address pointer local is spelled at its uses instead', () => {
  const s = fn([{ name: 'p', type: PTR }], twoUses());
  const out = inlineConstBases(s)!;
  expect(out.locals).toEqual([]);
  expect(out.body).toHaveLength(2);
  const lval = (out.body[0] as Extract<Stmt, { k: 'store' }>).lval as Extract<Expr, { k: 'index' }>;
  expect(lval.base).toEqual({ k: 'cast', to: PTR, e: { k: 'const', value: 0x4000208 } });
  // a FRESH node per use — a shared tree would leak contracts.ts's identity-keyed exemptions
  expect(lval.base).not.toBe((out.body[1] as Extract<Stmt, { k: 'store' }>).lval);
  // read-only: the input tree is not mutated
  expect(s.locals).toHaveLength(1);
  expect(s.body).toHaveLength(3);
});

test('a single use is not the reused address this exists for', () => {
  const s = fn([{ name: 'p', type: PTR }], twoUses().slice(0, 2));
  expect(inlineConstBases(s)).toBeNull();
});

test('a CAST initializer is l3/basecse.ts’s reuse hoist, not a value home', () => {
  const s = fn(
    [{ name: 'p', type: PTR }],
    twoUses().map((st, i) =>
      i === 0 ? { k: 'assign', name: 'p', value: { k: 'cast', to: PTR, e: { k: 'const', value: 0x4000208 } } } : st,
    ),
  );
  expect(inlineConstBases(s)).toBeNull();
});

// The second assignment sits BELOW the top level and AFTER the uses, so every other gate still
// admits the local: this is the count alone.
test('a second assignment means the name is not one constant', () => {
  const s = fn(
    [{ name: 'p', type: PTR }],
    [
      ...twoUses(),
      {
        k: 'if',
        cond: { k: 'const', value: 1 },
        then: [{ k: 'assign', name: 'p', value: { k: 'const', value: 4 } }],
        else: [],
      },
    ],
  );
  expect(inlineConstBases(s)).toBeNull();
});

test('an assignment below the top level may not run on every path', () => {
  const [, ...uses] = twoUses();
  const s = fn(
    [{ name: 'p', type: PTR }],
    [{ k: 'if', cond: { k: 'const', value: 1 }, then: [setup], else: [] }, ...uses],
  );
  expect(inlineConstBases(s)).toBeNull();
});

test('a use in a loop ABOVE the assignment reads the local before it is set', () => {
  const s = fn(
    [{ name: 'p', type: PTR }],
    [
      {
        k: 'while',
        cond: { k: 'const', value: 1 },
        body: [{ k: 'store', lval: deref('p'), value: { k: 'const', value: 0 } }],
      },
      ...twoUses(),
    ],
  );
  expect(inlineConstBases(s)).toBeNull();
});

test('an address-taken local has an identity the constant cannot stand in for', () => {
  const s = fn(
    [{ name: 'p', type: PTR }],
    [...twoUses(), { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'p' }] } }],
  );
  expect(inlineConstBases(s)).toBeNull();
});

test('a use that is not an `index` base is outside what the lever re-spells', () => {
  const s = fn(
    [{ name: 'p', type: PTR }],
    [...twoUses(), { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'var', name: 'p' }] } }],
  );
  expect(inlineConstBases(s)).toBeNull();
});

test('an object-volatile or frame local declines — both are asm facts, not spellings', () => {
  for (const extra of [{ volatile: true as const }, { frame: { loads: 1, stores: 1 } }]) {
    expect(inlineConstBases(fn([{ name: 'p', type: PTR, ...extra }], twoUses()))).toBeNull();
  }
});

test('a volatile POINTEE travels onto every cast the substitution mints', () => {
  const out = inlineConstBases(fn([{ name: 'p', type: PTR, pointeeVolatile: true }], twoUses()))!;
  for (const st of out.body) {
    const lval = (st as Extract<Stmt, { k: 'store' }>).lval as Extract<Expr, { k: 'index' }>;
    expect(lval.base).toEqual({ k: 'cast', to: PTR, volatile: true, e: { k: 'const', value: 0x4000208 } });
  }
});

test('a local fed a bare `0` is NULL, not an address', () => {
  const zero: Stmt = { k: 'assign', name: 'q', value: { k: 'const', value: 0 } };
  const s = fn(
    [
      { name: 'p', type: PTR },
      { name: 'q', type: PTR },
    ],
    [
      ...twoUses(),
      zero,
      { k: 'store', lval: deref('q'), value: { k: 'const', value: 2 } },
      { k: 'store', lval: deref('q'), value: { k: 'const', value: 3 } },
    ],
  );
  expect(inlinableConstBases(s)).toEqual(['p']);
});

// rank.ts's `/inlinebase/volatile` output narrows the qualifier lever to the locals this one
// deletes, so the two gates have to agree about what an address is — a local either lever admits
// alone would put an unqualified access under a label that says every one is qualified.
test('every local the qualified output inlines is one the qualifier reached', () => {
  const s = fn([{ name: 'p', type: PTR }], twoUses());
  const only = new Set(inlinableConstBases(s));
  const out = inlineConstBases(volatilePtrLocals(s, only)!)!;
  const casts: Extract<Expr, { k: 'cast' }>[] = [];
  const walk = (e: Expr): void => {
    if (e.k === 'cast') {
      casts.push(e);
    }
    for (const c of exprChildren(e)) {
      walk(c);
    }
  };
  for (const st of out.body) {
    for (const e of stmtExprs(st)) {
      walk(e);
    }
  }
  expect(casts.length).toBe(2);
  expect(casts.every((c) => c.volatile === true)).toBe(true);
});

test('`inlinableConstBases` names exactly the locals the gate admits', () => {
  expect(inlinableConstBases(fn([{ name: 'p', type: PTR }], twoUses()))).toEqual(['p']);
  expect(inlinableConstBases(fn([{ name: 'p', type: PTR }], twoUses().slice(0, 2)))).toEqual([]);
});

// THE CROSS-MODULE PROMISE: no base-hoist lever may produce a local this one would eat. Pinned
// behaviourally, on each lever's own smallest firing shape, because it is a constraint neither
// side's own tests state. Only `basecse` rests on the CAST — patching it to hoist the bare base
// fails this test, so the separation from that one lever really is a spelling agreement. The
// other three are separated structurally and would survive the same edit: `scopebase` hoists
// `(T *)&gSym`, whose initializer is an `addr` and not a const at all; `nearbase` spells every
// member but the lowest as `(p0 + k)[0]`, an `otherUses`; `argbase` names one base per call
// argument, so a hoist has one use where this lever wants two.
test('no base-hoist lever produces a local this one would eat', () => {
  const cidx = (value: number, i: number, width = 4): Expr => ({
    k: 'index',
    base: { k: 'const', value },
    idx: { k: 'const', value: i },
    width,
    signed: true,
  });
  const bare = (body: Stmt[], globals?: SFn['globals']): SFn => ({
    name: 'f',
    params: [],
    locals: [],
    ...(globals ? { globals } : {}),
    retType: T.void(),
    body,
  });
  const basecse = hoistReusedGlobalBases(
    bare([0, 1, 2].map((i) => ({ k: 'store', lval: cidx(0x40000d4, i), value: { k: 'const', value: 0 } }))),
  );
  const gx = (i: number): Expr => ({
    k: 'index',
    base: { k: 'var', name: 'g' },
    idx: { k: 'const', value: i },
    width: 2,
    signed: false,
  });
  const scoped = hoistScopedBases(
    bare(
      [
        {
          k: 'dowhile',
          cond: { k: 'const', value: 1 },
          body: [0, 1, 2].map((i) => ({ k: 'store', lval: gx(i), value: { k: 'const', value: 0 } })),
        },
      ],
      [{ name: 'g', type: T.ptr(T.u(16)) }],
    ),
  );
  const argb = materializeArgBases({
    name: 'f',
    params: [],
    locals: [{ name: 'v0', type: T.s(32) }],
    retType: T.void(),
    body: [
      {
        k: 'assign',
        name: 'v0',
        value: {
          k: 'call',
          fn: 'callee',
          args: [
            cidx(0x4000006, 0, 1),
            { k: 'index', base: { k: 'addr', name: 'g' }, idx: { k: 'const', value: 8 }, width: 1, signed: false },
          ],
        },
      },
    ],
  });
  const near = nearBaseClusters(
    bare([
      { k: 'exprstmt', value: cidx(0x03001048, 0, 2) },
      { k: 'exprstmt', value: cidx(0x0300104a, 0, 2) },
    ]),
    255,
  );
  for (const [name, out] of [
    ['basecse', basecse],
    ['scopebase', scoped],
    ['argbase', argb],
    ['nearbase', near],
  ] as const) {
    expect(out, `${name} fired`).not.toBeNull();
    expect(inlinableConstBases(out!), `${name}'s hoist is not an /inlinebase inhabitant`).toEqual([]);
  }
});

test('a function with no constant-address local declines', () => {
  const s = fn([{ name: 'v0', type: T.s(32) }], [{ k: 'assign', name: 'v0', value: { k: 'const', value: 3 } }]);
  expect(inlineConstBases(s)).toBeNull();
});

// pokeemerald:EReader_Reset — the demanding row. A halfword read from a constant MMIO address is
// parked in a stack slot across three calls and written back. Its callees take no arguments, so
// the prototypes are stated (an arity guess turns `sp` into an argument, which is a different
// function).
const EREADER = `EReader_Reset:
\tpush\t{r4, lr}
\tadd\tsp, sp, #-0x4
\tmov\tr1, sp
\tldr\tr4, .L3
\tldrh\tr0, [r4]
\tstrh\tr0, [r1]
\tmov\tr0, #0x0
\tstrh\tr0, [r4]
\tbl\tEReaderHelper_ClearSendRecvMgr
\tbl\tEReaderHelper_RestoreRegsState
\tbl\tRestoreSerialTimer3IntrHandlers
\tmov\tr0, sp
\tldrh\tr0, [r0]
\tstrh\tr0, [r4]
\tadd\tsp, sp, #0x4
\tpop\t{r4}
\tpop\t{r0}
\tbx\tr0
.L4:
\t.align\t2, 0
.L3:
\t.word\t0x4000208
`;
const VOID0 = { params: [], returnsVoid: true };
const ereaderCandidates = (): ReturnType<typeof enumerateCandidates> =>
  enumerateCandidates('EReader_Reset', EREADER, ARMV4T_AGBCC, {
    prototypes: {
      EReader_Reset: VOID0,
      EReaderHelper_ClearSendRecvMgr: VOID0,
      EReaderHelper_RestoreRegsState: VOID0,
      RestoreSerialTimer3IntrHandlers: VOID0,
    },
  });

test('the primary keeps the pointer local — the pool load is a fact, the name is not', () => {
  const plain = ereaderCandidates().find((c) => c.label === 'unsigned')!;
  expect(plain.source).toContain('u16 * v0;');
  expect(plain.source).toContain('v0 = (u16 *)67109384;');
});

test('/inlinebase spells the constant at each access and drops the local', () => {
  const c = ereaderCandidates().find((x) => x.label === 'unsigned/inlinebase')!;
  expect(c.source).not.toContain('v0');
  expect(c.source).toContain('*(u16 *)67109384 = 0;');
});

test('the /inlinebase × /vol-slot pair spells both, and neither lever reaches it alone', () => {
  const labels = ereaderCandidates().map((c) => c.label);
  expect(labels).toContain('unsigned/inlinebase');
  expect(labels).toContain('unsigned/vol-slot');
  const pair = ereaderCandidates().find((c) => c.label === 'unsigned/inlinebase/vol-slot')!;
  expect(pair.source).toContain('volatile u16 sp0;');
  expect(pair.source).toContain('*(u16 *)67109384 = sp0;');
  expect(pair.source).not.toContain('v0');
});

test('the qualified output is enumerated, and BEFORE its plain twin so a tie publishes it', () => {
  const labels = ereaderCandidates().map((c) => c.label);
  for (const [q, plain] of [
    ['unsigned/inlinebase/volatile', 'unsigned/inlinebase'],
    ['unsigned/inlinebase/volatile/vol-slot', 'unsigned/inlinebase/vol-slot'],
  ]) {
    expect(labels.indexOf(q)).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf(q)).toBeLessThan(labels.indexOf(plain));
  }
  const q = ereaderCandidates().find((c) => c.label === 'unsigned/inlinebase/volatile/vol-slot')!;
  expect(q.source).toContain('*(volatile u16 *)67109384 = sp0;');
  expect(q.source).toContain('volatile u16 sp0;');
});
