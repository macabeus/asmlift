// SPILL-SLOT ORDER — the per-compiler default that declares slot-homed locals in the target's
// own frame order.
//
// The law it models: gcc 2.9 hands a spilled user local its frame slot by DECLARATION RANK —
// reload walks pseudos ascending handing each global-alloc loser a fresh slot, a user local's
// pseudo number is its `expand_decl` position, and the Thumb frame grows upward. So a source
// whose two spilled locals are declared in the other order compiles to the two `[sp,#k]`
// operands swapped, and nothing else moves.
//
// The fact travels L1 → L3 on containers that already exist: `Fn.slotHomes` (stamped by the
// SHARED SSA builder, so both frontends supply the coordinate and one rule applies it),
// `SFn.locals[i].slot` (the structurer's naming walk), and one pure ordering owned by
// `LanguageBackend.emit`. Each stage is pinned here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { cppBackend } from '../src/backend/cpp';
import { pascalBackend } from '../src/backend/pascal';
import { frontendFor } from '../src/frontend/registry';
import { makeSsaBuilder, stackSlotKey } from '../src/frontend/ssa';
import { type Block, type Fn, type Value, mkOp, mkValue, replaceAllUsesWith } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { ARM_DISJOINT_GATES, COALESCE_GATES, armDisjointUnder, coalesceUnder } from '../src/l3/coalesce';
import { orderSlotLocals } from '../src/l3/slotorder';
import { raiseRecovered, structureChecked } from '../src/pipeline';
import { type StructureOptions, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, structureOptionsFor } from '../src/target';

const val = () => mkValue(T.unk(32));
const read = (p: string) => readFileSync(join(import.meta.dirname, 'corpus', p), 'utf8');

// ── A1: the stamp, in the SHARED builder ──────────────────────────────────────────────────────

test('the SSA builder stamps a slot home on a slot write and on nothing else', () => {
  const ssa = makeSsaBuilder('s', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const spilled = val();
  const plain = val();
  ssa.writeVar(stackSlotKey(8), 0, spilled);
  ssa.writeVar('r4', 0, plain);
  b0.ops.push(mkOp('ret', { operands: [ssa.readVar(stackSlotKey(8), 0)] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.slotHomes!.get(spilled)).toBe(8);
  expect(ssa.fn.slotHomes!.has(plain)).toBe(false);
});

test('a value written to two slots takes the LOWER — the one merge policy, stated once', () => {
  const ssa = makeSsaBuilder('s', 1, [[]]);
  const [b0] = ssa.irBlocks;
  const v = val();
  ssa.writeVar(stackSlotKey(12), 0, v);
  ssa.writeVar(stackSlotKey(4), 0, v);
  b0.ops.push(mkOp('ret', { operands: [v] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.slotHomes!.get(v)).toBe(4);
});

test('a phi standing for a slot key carries that slot home', () => {
  // ^0 writes sp@4 and branches to ^1, which is its own successor: the header reads sp@4 through
  // a phi, and Braun's construction gives that phi the slot key as its `phiKey`.
  const ssa = makeSsaBuilder('p', 2, [[], [0, 1]]);
  const [b0, b1] = ssa.irBlocks;
  ssa.writeVar(stackSlotKey(4), 0, val());
  b0.ops.push(mkOp('br', { successors: [{ block: b1, args: [] }] }));
  ssa.markFilled(0);
  const cur = ssa.readVar(stackSlotKey(4), 1);
  const next = val();
  b1.ops.push(mkOp('add', { operands: [cur, cur], results: [next] }));
  ssa.writeVar(stackSlotKey(4), 1, next);
  b1.ops.push(
    mkOp('cond_br', {
      operands: [next],
      successors: [
        { block: b1, args: [] },
        { block: b1, args: [] },
      ],
    }),
  );
  ssa.markFilled(1);
  ssa.finish();
  expect(b1.params.length).toBe(1);
  expect(ssa.fn.slotHomes!.get(b1.params[0])).toBe(4);
});

test('Thumb: every value the asm spilled to [sp,#k] carries that k', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift(
    'spillorder',
    read('agbcc-spillorder.s'),
    ARMV4T_AGBCC,
    {},
    undefined,
    undefined,
  );
  expect(new Set(fn.slotHomes!.values())).toEqual(new Set([0, 4]));
});

test('MIPS: the same shared rule, from the other frontend', () => {
  const fn = frontendFor(MIPS_IDO).lift('spillslot', read('mips-spillslot.asm'), MIPS_IDO, {}, undefined, undefined);
  expect(new Set(fn.slotHomes!.values())).toEqual(new Set([0, 4]));
});

test('a function that spilled nothing carries an EMPTY record; parsed IR carries none at all', () => {
  // The same required-but-possibly-undefined discipline `Fn.writeOrder` takes: absent means
  // "nobody measured this function", never "this function spilled nothing".
  const ssa = makeSsaBuilder('e', 1, [[]]);
  ssa.irBlocks[0].ops.push(mkOp('ret', { operands: [] }));
  ssa.markFilled(0);
  ssa.finish();
  expect(ssa.fn.slotHomes).toBeDefined();
  expect(ssa.fn.slotHomes!.size).toBe(0);
  expect(parse(print(ssa.fn)).slotHomes).toBeUndefined();
});

// ── A2: propagation, with ONE merge policy ────────────────────────────────────────────────────

/** A one-block fn holding two values, `a` used by the `ret`. */
const twoValueFn = (): { fn: Fn; a: Value; b: Value } => {
  const a = val();
  const b = val();
  const entry: Block = { params: [], ops: [mkOp('ret', { operands: [a] })] };
  return { fn: { name: 'r', blocks: [entry], writeOrder: undefined, slotHomes: new Map() }, a, b };
};

test('replaceAllUsesWith carries the home onto the value that inherits the uses', () => {
  const { fn, a, b } = twoValueFn();
  fn.slotHomes!.set(a, 8);
  replaceAllUsesWith(fn, a, b);
  expect(fn.slotHomes!.get(b)).toBe(8);
});

test('…and when both carry one, the merge takes the LOWER — the same policy as the builder', () => {
  const { fn, a, b } = twoValueFn();
  fn.slotHomes!.set(a, 12);
  fn.slotHomes!.set(b, 4);
  replaceAllUsesWith(fn, a, b);
  expect(fn.slotHomes!.get(b)).toBe(4);
  const other = twoValueFn();
  other.fn.slotHomes!.set(other.a, 4);
  other.fn.slotHomes!.set(other.b, 12);
  replaceAllUsesWith(other.fn, other.a, other.b);
  expect(other.fn.slotHomes!.get(other.b)).toBe(4);
});

test('a replacement of an unhomed value invents no home', () => {
  const { fn, a, b } = twoValueFn();
  replaceAllUsesWith(fn, a, b);
  expect(fn.slotHomes!.has(b)).toBe(false);
});

test('hand-built IR with no record survives replaceAllUsesWith untouched', () => {
  const { fn, a, b } = twoValueFn();
  fn.slotHomes = undefined;
  expect(() => replaceAllUsesWith(fn, a, b)).not.toThrow();
  expect(fn.slotHomes).toBeUndefined();
});

// THE SPINE. Every `[sp,#k]` the asm wrote must still be carried by a value the graph reaches
// after the whole pre-recovery + type-recovery + return-sinking spine has run — `ir/simplify.ts`
// trivial-phi removal (which a slot's loop-header param goes through), the idiom folder, `gvn`,
// and `narrow`, the last pre-recovery pass and the one that rewrites an operand in place rather
// than through `replaceAllUsesWith`.
//
// The fixture is agbcc -O2 on a function with a `u8` loop-carried local and four spilled `int`
// locals: the `lsl/lsr` + `asr` triple in its loop is exactly `narrow`'s sext-over-zext domain, so
// the pass fires here rather than being asserted about in the abstract.
test('a slot home survives the whole raising spine, on a function with a u8 local', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('u8spill', read('agbcc-u8spill.s'), ARMV4T_AGBCC, {}, undefined, undefined);
  expect(new Set(fn.slotHomes!.values())).toEqual(new Set([0, 4, 8, 12]));
  raiseRecovered(fn, ARMV4T_AGBCC, {}, undefined);
  const reached = new Set<Value>();
  for (const b of fn.blocks) {
    b.params.forEach((p) => reached.add(p));
    for (const op of b.ops) {
      op.operands.forEach((v) => reached.add(v));
      op.results.forEach((v) => reached.add(v));
      op.successors.forEach((sc) => sc.args.forEach((v) => reached.add(v)));
    }
  }
  const live = [...fn.slotHomes!].filter(([v]) => reached.has(v)).map(([, off]) => off);
  expect(new Set(live)).toEqual(new Set([0, 4, 8, 12]));
});

// ── A3: the declaration attribute, from the structurer's naming walk ──────────────────────────

const structured = (file: string, sym: string, opts: StructureOptions = {}) => {
  const fn = frontendFor(ARMV4T_AGBCC).lift(sym, read(file), ARMV4T_AGBCC, {}, undefined, undefined);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, undefined);
  return structure(fn, { ...structureOptionsFor(ARMV4T_AGBCC, false), ...opts });
};

test('structure() stamps each local with the slot the naming walk found under it', () => {
  const sfn = structured('agbcc-spillorder.s', 'spillorder');
  const slotted = sfn.locals.filter((l) => l.slot !== undefined).map((l) => [l.name, l.slot]);
  // exactly the two spills the asm made, one local each
  expect(slotted.length).toBe(2);
  expect(new Set(slotted.map(([, off]) => off))).toEqual(new Set([0, 4]));
});

test('a local the asm never spilled carries no slot — absent, not zero', () => {
  const sfn = structured('agbcc-spillorder.s', 'spillorder');
  expect(sfn.locals.some((l) => l.slot === undefined)).toBe(true);
});

test('the direction rides StructureOptions onto the SFn, and `unknown` reaches it as absent', () => {
  const at = (spillSlotOrder: StructureOptions['spillSlotOrder']) =>
    structured('agbcc-spillorder.s', 'spillorder', { spillSlotOrder }).slotOrder;
  expect(at('ascending')).toBe('ascending');
  expect(at('descending')).toBe('descending');
  expect(at('unknown')).toBeUndefined();
  expect(at(undefined)).toBeUndefined();
});

// ── A4: the gate as data, and shipped only where a row can referee it ─────────────────────────

test('the frame-slot direction is a per-compiler datum: agbcc ascending, everything else unknown', () => {
  expect(ARMV4T_AGBCC.compilerBehaviors.spillSlotOrder).toBe('ascending');
  expect(MIPS_IDO.compilerBehaviors.spillSlotOrder).toBe('unknown');
  expect(MIPS_GCC.compilerBehaviors.spillSlotOrder).toBe('unknown');
  expect(PPC_MWCC.compilerBehaviors.spillSlotOrder).toBe('unknown');
});

test('the datum reaches the structurer through the compilerBehaviors spread, with no plumbing', () => {
  expect(structureOptionsFor(ARMV4T_AGBCC, false).spillSlotOrder).toBe('ascending');
  expect(structureOptionsFor(MIPS_IDO, false).spillSlotOrder).toBe('unknown');
});

// ── A5: one pure ordering, owned by `emit` ────────────────────────────────────────────────────

/** Two slot-carrying locals declared AGAINST an ascending frame, an unslotted one between them. */
const twoSlots = (over: Partial<SFn> = {}): SFn => ({
  name: 'f',
  params: [],
  locals: [
    { name: 'hi', type: T.int(32, true), slot: 4 },
    { name: 'mid', type: T.int(32, true) },
    { name: 'lo', type: T.int(32, true), slot: 0 },
  ],
  retType: T.void(),
  body: [],
  slotOrder: 'ascending',
  ...over,
});

const declOrder = (src: string): string[] => [...src.matchAll(/\b(hi|mid|lo|only)\b/g)].map((m) => m[1]);

test('C: the declaration list is refilled in the target frame order, in place', () => {
  expect(declOrder(cBackend.emit(orderSlotLocals(twoSlots())))).toEqual(['lo', 'mid', 'hi']);
});

test('C++: the same, through the other C-family backend', () => {
  const backend = cppBackend({ method: 'f', retType: { base: 'void', ptr: 0 }, params: [] });
  expect(declOrder(backend.emit(orderSlotLocals(twoSlots())))).toEqual(['lo', 'mid', 'hi']);
});

test('Pascal: the same, through a backend with its own spelling', () => {
  expect(declOrder(pascalBackend.emit(orderSlotLocals(twoSlots())))).toEqual(['lo', 'mid', 'hi']);
});

test('descending reverses it, and an unknown direction is the identity', () => {
  expect(orderSlotLocals(twoSlots({ slotOrder: 'descending' })).locals.map((l) => l.name)).toEqual(['hi', 'mid', 'lo']);
  expect(orderSlotLocals(twoSlots({ slotOrder: undefined })).locals.map((l) => l.name)).toEqual(['hi', 'mid', 'lo']);
});

test('fewer than two sortable locals is the identity', () => {
  const one = twoSlots({
    locals: [
      { name: 'mid', type: T.int(32, true) },
      { name: 'only', type: T.int(32, true), slot: 8 },
    ],
  });
  expect(orderSlotLocals(one).locals.map((l) => l.name)).toEqual(['mid', 'only']);
});

test('an unslotted local NEVER moves — only the sortable positions are refilled', () => {
  const sfn = orderSlotLocals(twoSlots());
  expect(sfn.locals[1].name).toBe('mid');
});

test("the ordering is pure: the structurer's own list is left alone", () => {
  const sfn = twoSlots();
  const before = sfn.locals.map((l) => l.name);
  orderSlotLocals(sfn);
  expect(sfn.locals.map((l) => l.name)).toEqual(before);
});

test('two locals sharing one slot keep their relative order', () => {
  const sfn = twoSlots({
    locals: [
      { name: 'hi', type: T.int(32, true), slot: 4 },
      { name: 'mid', type: T.int(32, true), slot: 4 },
      { name: 'lo', type: T.int(32, true), slot: 0 },
    ],
  });
  expect(orderSlotLocals(sfn).locals.map((l) => l.name)).toEqual(['lo', 'hi', 'mid']);
});

test('every backend orders: no `emit` may print an unordered declaration list', () => {
  // Owned by `emit` rather than by a call site because there are SEVEN `.emit(` call sites, and
  // the web Playground reaches two of them for one function (the headline source and the Pipeline
  // tab) while the score probe reaches a third. A call-site ordering would print an ordered
  // headline beside an unordered pipeline dump, and measure a scoreDelta on a source the ranked
  // path never compiles.
  const sfn = twoSlots();
  const backends = [
    cBackend,
    pascalBackend,
    cppBackend({ method: 'f', retType: { base: 'void', ptr: 0 }, params: [] }),
  ];
  for (const b of backends) {
    expect(declOrder(b.emit(sfn))).toEqual(['lo', 'mid', 'hi']);
  }
});

// ── A6: the guard — what depends on the order this does NOT change ────────────────────────────

const asg = (n: string, v: number): Stmt => ({ k: 'assign', name: n, value: { k: 'const', value: v } });
const use = (n: string): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn: 'f', args: [{ k: 'var', name: n }] } });
const armIf = (cond: Expr, thenS: Stmt[], elseS: Stmt[]): Stmt => ({ k: 'if', cond, then: thenS, else: elseS });
const cnd: Expr = { k: 'bin', op: '!=', l: { k: 'var', name: 'a' }, r: { k: 'const', value: 0 } };
const arm = (n: string): Stmt[] => [
  asg(n, 0),
  { k: 'dowhile', cond: { k: 'bin', op: '<', l: { k: 'var', name: n }, r: { k: 'const', value: 9 } }, body: [use(n)] },
];
/** `x` declared first but homed HIGH, `y` declared second and homed LOW: the two orders disagree. */
const disagreeing = (): SFn => ({
  name: 'f',
  params: [],
  locals: [
    { name: 'x', type: T.int(32, true), slot: 8 },
    { name: 'y', type: T.int(32, true), slot: 0 },
  ],
  retType: T.void(),
  body: [armIf(cnd, arm('x'), arm('y'))],
  slotOrder: 'ascending',
});

test('coalesce picks its survivor from the STRUCTURER order, not the emitted one', () => {
  // `l3/coalesce.ts` chooses the arm-disjoint survivor by declIdx — the earlier declaration,
  // matching how a shared source local reads. It runs BEFORE emit, so it reads the unsorted list
  // and picks `x`. Sorting any earlier would silently make `y` the survivor of every such merge.
  const out = armDisjointUnder(ARM_DISJOINT_GATES, disagreeing()).candidates;
  expect(out.map((c) => c.merged)).toContain('y-x');
  expect(orderSlotLocals(disagreeing()).locals.map((l) => l.name)).toEqual(['y', 'x']);
});

test('a merge carries the LOWER of the two slots onto the survivor', () => {
  // A merged pair can reproduce at most one slot, and the lower is the earlier rank — the same
  // policy the map and `replaceAllUsesWith` state.
  const merged = armDisjointUnder(ARM_DISJOINT_GATES, disagreeing()).candidates.find((c) => c.merged === 'y-x')!.sfn;
  expect(merged.locals.map((l) => [l.name, l.slot])).toEqual([['x', 0]]);
});

test('…on the span path too, where the survivor is the second name', () => {
  const sfn: SFn = {
    name: 'f',
    params: [],
    locals: [
      { name: 'p', type: T.int(32, true), slot: 4 },
      { name: 'q', type: T.int(32, true), slot: 12 },
    ],
    retType: T.void(),
    body: [asg('p', 1), use('p'), asg('q', 2), use('q')],
  };
  const out = coalesceUnder(COALESCE_GATES, sfn).candidates;
  const pq = out.find((c) => c.merged === 'p-q')!.sfn;
  expect(pq.locals.map((l) => [l.name, l.slot])).toEqual([['q', 4]]);
});

test("a survivor with no slot of its own inherits the absorbed local's", () => {
  const sfn: SFn = {
    name: 'f',
    params: [],
    locals: [
      { name: 'p', type: T.int(32, true), slot: 4 },
      { name: 'q', type: T.int(32, true) },
    ],
    retType: T.void(),
    body: [asg('p', 1), use('p'), asg('q', 2), use('q')],
  };
  const cands = coalesceUnder(COALESCE_GATES, sfn).candidates;
  expect(cands.find((c) => c.merged === 'p-q')!.sfn.locals.map((l) => [l.name, l.slot])).toEqual([['q', 4]]);
  // …and a merge of two unslotted locals invents nothing
  const bare: SFn = { ...sfn, locals: sfn.locals.map((l) => ({ name: l.name, type: l.type })) };
  expect(
    coalesceUnder(COALESCE_GATES, bare).candidates.find((c) => c.merged === 'p-q')!.sfn.locals[0].slot,
  ).toBeUndefined();
});

test('the relative order of slot-carrying locals survives the whole L3 spine', () => {
  // `structureChecked` runs tail-merge -> DSE -> base-CSE over the structurer's tree before any
  // backend sees it. The ordering is applied at emit, AFTER all of that, so what this pins is the
  // other direction: nothing in the spine reorders the declaration list under it.
  const fn = frontendFor(ARMV4T_AGBCC).lift(
    'spillorder',
    read('agbcc-spillorder.s'),
    ARMV4T_AGBCC,
    {},
    undefined,
    undefined,
  );
  raiseRecovered(fn, ARMV4T_AGBCC, {}, undefined);
  const opts = structureOptionsFor(ARMV4T_AGBCC, false);
  const raw = structure(fn, opts).locals.map((l) => l.name);
  const spined = structureChecked(fn, opts).locals.map((l) => l.name);
  // the spine may DROP a local (dce) but never permutes what it keeps
  expect(spined).toEqual(raw.filter((n) => spined.includes(n)));
});
