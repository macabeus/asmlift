// The `/inlinebase` lever (l3/inlinebase.ts): a pointer local holding a CONSTANT address is
// deleted and each access through it re-spelled as the cast constant. The gate conditions are
// what these tests pin — one bare-`const` assignment at the body's top level that nothing
// mentions earlier, no address taken, every use an `index` base, 2+ of them — and nothing
// qualifying means DECLINE, never a duplicate candidate.
import { expect, test } from 'vitest';

import { T } from '../src/ir/types';
import { type Expr, type SFn, type Stmt } from '../src/l3/ast';
import { inlineConstBases } from '../src/l3/inlinebase';
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

test('a second assignment means the name is not one constant', () => {
  const s = fn([{ name: 'p', type: PTR }], [...twoUses(), { k: 'assign', name: 'p', value: { k: 'const', value: 4 } }]);
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

test('a volatile or frame local declines — both are asm facts, not spellings', () => {
  for (const extra of [
    { volatile: true as const },
    { pointeeVolatile: true as const },
    { frame: { loads: 1, stores: 1 } },
  ]) {
    expect(inlineConstBases(fn([{ name: 'p', type: PTR, ...extra }], twoUses()))).toBeNull();
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
