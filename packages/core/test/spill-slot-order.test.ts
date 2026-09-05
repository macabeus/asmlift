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

// A frame partition is what makes a slot key MEAN "storage this function owns", so every builder
// test that expects a stamp declares one. Thumb supplies `[0, localArea)`; a builder handed no
// model claims nothing and stamps nothing (the test below).
const owns = (to: number) => () => ({ ownedLocals: { from: 0, to } });

test('the SSA builder stamps a slot home on a slot write and on nothing else', () => {
  const ssa = makeSsaBuilder('s', 1, [[]], owns(16));
  const [b0] = ssa.irBlocks;
  const spilled = val();
  const plain = val();
  ssa.writeVar(stackSlotKey(8), 0, spilled);
  ssa.writeVar('r4', 0, plain);
  b0.ops.push(mkOp('ret', { operands: [ssa.readVar(stackSlotKey(8), 0)] }));
  ssa.markFilled(0);
  ssa.finish();
  expect([...ssa.fn.slotHomes!.get(spilled)!]).toEqual([8]);
  expect(ssa.fn.slotHomes!.has(plain)).toBe(false);
});

test('a value written to two slots carries BOTH: the builder holds no target and chooses nothing', () => {
  const ssa = makeSsaBuilder('s', 1, [[]], owns(16));
  const [b0] = ssa.irBlocks;
  const v = val();
  ssa.writeVar(stackSlotKey(12), 0, v);
  ssa.writeVar(stackSlotKey(4), 0, v);
  b0.ops.push(mkOp('ret', { operands: [v] }));
  ssa.markFilled(0);
  ssa.finish();
  expect([...ssa.fn.slotHomes!.get(v)!].sort((x, y) => x - y)).toEqual([4, 12]);
});

test('a phi standing for a slot key carries that slot home', () => {
  // ^0 writes sp@4 and branches to ^1, which is its own successor: the header reads sp@4 through
  // a phi, and Braun's construction gives that phi the slot key as its `phiKey`.
  const ssa = makeSsaBuilder('p', 2, [[], [0, 1]], owns(16));
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
  expect([...ssa.fn.slotHomes!.get(b1.params[0])!]).toEqual([4]);
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
  expect(new Set([...fn.slotHomes!.values()].flatMap((o) => [...o]))).toEqual(new Set([0, 4]));
});

// THE STAMP ASKS THE FRAME PARTITION, NOT THE KEY SPELLING. `sp@k` is a local on one ABI and the
// caller's storage on another, so a key alone is not evidence of a declaration rank — which is the
// same thing `readRecursive` refuses to guess about a def-less read.
test('a slot outside the declared local area is NOT stamped', () => {
  const ssa = makeSsaBuilder('s', 1, [[]], owns(8));
  const [b0] = ssa.irBlocks;
  const inside = val();
  const outside = val();
  ssa.writeVar(stackSlotKey(4), 0, inside);
  ssa.writeVar(stackSlotKey(8), 0, outside);
  b0.ops.push(mkOp('ret', { operands: [inside, outside] }));
  ssa.markFilled(0);
  ssa.finish();
  expect([...ssa.fn.slotHomes!.get(inside)!]).toEqual([4]);
  expect(ssa.fn.slotHomes!.has(outside)).toBe(false);
});

// MIPS reaches the SAME shared stamp — and gets nothing, which is the correct answer and not a
// gap in the plumbing. frontend/mips.ts claims no frame partition at all (`addiu sp,sp,±N` is
// transparent there), so its `sp@k` keys span O32's CALLER-owned register-parameter home area
// `[0,16)` and the incoming stack arguments above it. This fixture's `sw a0,0(sp) / sw a1,4(sp)`
// is squarely inside that home area: those offsets are the caller's, not this function's
// declaration ranks. Stamping them would have made a per-compiler ordering read the wrong storage
// the moment `MIPS_IDO.compilerBehaviors.spillSlotOrder` stopped being `'unknown'`.
test('MIPS reaches the same shared stamp and is refused: it claims no frame partition', () => {
  const fn = frontendFor(MIPS_IDO).lift('spillslot', read('mips-spillslot.asm'), MIPS_IDO, {}, undefined, undefined);
  expect(fn.slotHomes!.size).toBe(0);
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

// ── A2: propagation, which UNIONS and never chooses ───────────────────────────────────────────

/** A one-block fn holding two values, `a` used by the `ret`. */
const twoValueFn = (): { fn: Fn; a: Value; b: Value } => {
  const a = val();
  const b = val();
  const entry: Block = { params: [], ops: [mkOp('ret', { operands: [a] })] };
  return { fn: { name: 'r', blocks: [entry], writeOrder: undefined, slotHomes: new Map() }, a, b };
};

test('replaceAllUsesWith carries the home onto the value that inherits the uses', () => {
  const { fn, a, b } = twoValueFn();
  fn.slotHomes!.set(a, new Set([8]));
  replaceAllUsesWith(fn, a, b);
  expect([...fn.slotHomes!.get(b)!]).toEqual([8]);
});

test('…and when both carry one, the merge UNIONS: this helper holds no target, so it chooses nothing', () => {
  const { fn, a, b } = twoValueFn();
  fn.slotHomes!.set(a, new Set([12]));
  fn.slotHomes!.set(b, new Set([4]));
  replaceAllUsesWith(fn, a, b);
  expect([...fn.slotHomes!.get(b)!].sort((x, y) => x - y)).toEqual([4, 12]);
  // and the same either way round — a union has no order to get wrong
  const other = twoValueFn();
  other.fn.slotHomes!.set(other.a, new Set([4]));
  other.fn.slotHomes!.set(other.b, new Set([12]));
  replaceAllUsesWith(other.fn, other.a, other.b);
  expect([...other.fn.slotHomes!.get(other.b)!].sort((x, y) => x - y)).toEqual([4, 12]);
});

// THE REDUCTION IS DIRECTION-DEPENDENT, AND THAT IS WHY NO MERGE SITE MAKES IT. `min` is
// ascending's answer, not a neutral one: under a descending frame the EARLIER declaration rank is
// the HIGHER offset. A merge that had picked an end would have stamped the later rank on every
// target whose measured direction is `descending` (ido7.1 and mwcc, per target.ts) and inverted
// the emitted order for exactly the locals it touched.
test('a merged local carries both homes, and each direction elects the earlier rank from them', () => {
  const merged = (dir: 'ascending' | 'descending'): string[] =>
    orderSlotLocals(
      twoSlots({
        locals: [
          { name: 'hi', type: T.int(32, true), slots: [0, 8] },
          { name: 'lo', type: T.int(32, true), slots: [4] },
        ],
        slotOrder: dir,
      }),
    ).locals.map((l) => l.name);
  // ascending: the merged local's earliest rank is the LOWEST of its homes, 0, so it leads
  expect(merged('ascending')).toEqual(['hi', 'lo']);
  // descending: its earliest rank is the HIGHEST, 8, so it leads there too
  expect(merged('descending')).toEqual(['hi', 'lo']);
  // …and this is the counterfactual that makes the union load-bearing. A merge that had taken the
  // `min` would have handed the survivor `[0]` and thrown the 8 away; under descending that ranks
  // it BELOW the local at 4 and inverts the emitted order.
  const minMerged = orderSlotLocals(
    twoSlots({
      locals: [
        { name: 'hi', type: T.int(32, true), slots: [0] },
        { name: 'lo', type: T.int(32, true), slots: [4] },
      ],
      slotOrder: 'descending',
    }),
  ).locals.map((l) => l.name);
  expect(minMerged).toEqual(['lo', 'hi']);
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
  expect(new Set([...fn.slotHomes!.values()].flatMap((o) => [...o]))).toEqual(new Set([0, 4, 8, 12]));
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
  const live = [...fn.slotHomes!].filter(([v]) => reached.has(v)).flatMap(([, offs]) => [...offs]);
  expect(new Set(live)).toEqual(new Set([0, 4, 8, 12]));

  // AND THE PROPERTY THE CAPABILITY ACTUALLY CONSUMES, which reachability does not imply: after
  // the naming walk, is each offset still carried by a DECLARED local? On this fixture it is not
  // — four L1 offsets become three slot-carrying locals, because the walk INLINES the value homed
  // at 0 into an expression instead of declaring it. That attrition is the capability's real
  // blocker (see the REACH paragraph in l3/slotorder.ts) and is pinned as a NUMBER here, so a
  // future pass that turns three into two fails on this line instead of passing the weaker
  // reachability proxy above. Instrumented, not inferred: forcing `rerootNarrowReads` to return 0
  // gives the identical L3 result, so this is naming-walk attrition and not a stranded home.
  const sfn = structure(fn, structureOptionsFor(ARMV4T_AGBCC, false));
  const declared = sfn.locals.filter((l) => l.slots !== undefined);
  expect(declared.map((l) => `${l.name}@${l.slots!.join('/')}`)).toEqual(['v0@4', 'v10@8', 'v11@12']);
  expect(new Set(declared.flatMap((l) => l.slots!))).toEqual(new Set([4, 8, 12]));
});

// ── A3: the declaration attribute, from the structurer's naming walk ──────────────────────────

const structured = (file: string, sym: string, opts: StructureOptions = {}) => {
  const fn = frontendFor(ARMV4T_AGBCC).lift(sym, read(file), ARMV4T_AGBCC, {}, undefined, undefined);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, undefined);
  return structure(fn, { ...structureOptionsFor(ARMV4T_AGBCC, false), ...opts });
};

test('structure() stamps each local with the slots the naming walk found under it', () => {
  const sfn = structured('agbcc-spillorder.s', 'spillorder');
  const slotted = sfn.locals.filter((l) => l.slots !== undefined);
  // exactly the two spills the asm made, one local each and one offset each
  expect(slotted.length).toBe(2);
  expect(new Set(slotted.flatMap((l) => l.slots!))).toEqual(new Set([0, 4]));
});

test('a local the asm never spilled carries no slots — absent, not an empty list', () => {
  const sfn = structured('agbcc-spillorder.s', 'spillorder');
  expect(sfn.locals.some((l) => l.slots === undefined)).toBe(true);
});

test('the direction rides StructureOptions onto the SFn, and `unknown` reaches it as absent', () => {
  const at = (spillSlotOrder: StructureOptions['spillSlotOrder']) =>
    structured('agbcc-spillorder.s', 'spillorder', { spillSlotOrder }).slotOrder;
  expect(at('ascending')).toBe('ascending');
  expect(at('descending')).toBe('descending');
  expect(at('unknown')).toBeUndefined();
  expect(at(undefined)).toBeUndefined();
});

// THE `uninit` REFUSAL, pinned on BOTH trees, because the two disagree and only one of them is
// emitted. The structurer stamps no `slot` on an `undef` local, and the reason is undecidability:
// one frame slot then yields TWO declarations, the `undef` read of the storage and the value
// stored into it, and the asm does not say which took the declaration rank.
//
// The class is real in `structure()`'s tree — this fixture (`synthetic:uninit_spill`'s own object)
// has three slots whose stores sit on two arms of a dispatch that a third path skips entirely, so
// each of [sp,#0], [sp,#4] and [sp,#8] is BOTH stored and read def-lessly. It is UNREACHED in
// `structureChecked()`'s tree, which is the only tree `emit` — and therefore `orderSlotLocals` —
// ever sees: `eliminateDeadStores` keeps only locals the body still references, and no `undef`
// local here survives it. So the refusal is precautionary, and both halves are pinned: the first
// assertion fails if the class stops existing (the refusal would have lost its subject), the
// second fails if it starts REACHING the ordering (the refusal would have become load-bearing and
// the flip condition in structure.ts's comment would need re-reading).
test('a slot-keyed uninit local co-exists with a slotted local at the SAME offset, and takes no slot', () => {
  const sfn = structured('agbcc-uninit-spill.s', 'uninit_spill');
  const slotted = sfn.locals.filter((l) => l.slots !== undefined);
  expect(slotted.map((l) => `${l.name}@${l.slots!.join('/')}`)).toEqual(['v4@0', 'v5@4', 'v6@8']);
  const uninit = sfn.locals.filter((l) => l.uninit);
  // the refusal itself: no `undef` local is ever sortable
  expect(uninit.every((l) => l.slots === undefined)).toBe(true);
  // and it has a subject — the offsets the ordering sorts by are exactly the offsets an `undef`
  // local is keyed at on this row, so the two readings of one storage really do collide
  const uninitOffsets = uninit.map((l) => /^uninit_sp(\d+)$/.exec(l.name)).filter((m) => m !== null);
  expect(new Set(uninitOffsets.map((m) => Number(m![1])))).toEqual(new Set(slotted.flatMap((l) => l.slots!)));
});

test('and no `undef` local reaches the ordering: the emitted tree carries none, slots intact', () => {
  const fn = frontendFor(ARMV4T_AGBCC).lift('uninit_spill', read('agbcc-uninit-spill.s'), ARMV4T_AGBCC, {}, undefined, undefined);
  raiseRecovered(fn, ARMV4T_AGBCC, {}, undefined);
  const sfn = structureChecked(fn, structureOptionsFor(ARMV4T_AGBCC, false));
  // structure() had eight; the spine's dead-store elimination leaves none, so the co-existence the
  // test above pins does not exist where `orderSlotLocals` runs
  expect(sfn.locals.filter((l) => l.uninit).length).toBe(0);
  // and the same pass strands no slot: the three slot-carrying locals survive unchanged, which is
  // what makes this a fact about the `undef` half alone rather than about the whole declaration list
  expect(sfn.locals.filter((l) => l.slots !== undefined).map((l) => `${l.name}@${l.slots!.join('/')}`)).toEqual([
    'v4@0',
    'v5@4',
    'v6@8',
  ]);
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

// THE THREE `'unknown'`s, BACKED BY A COMMITTED PROBE RATHER THAN A NUMBER IN A COMMENT. Each
// target's comment records a direction that was measured and deliberately not shipped, and a
// direction nobody can re-run is a claim, not a measurement. The probe is `corpus/probe-declrank.c`
// — sixteen `int` locals, each assigned `n + 17*(rank+1)` so its immediate NAMES it in the object,
// all live across a call so the allocator must home the losers in the frame — plus
// `probe-declrank-rev.c`, the identical body with the DECLARATION LIST reversed. The reversal is
// what separates declaration rank from use order: the two files assign in the same textual order,
// so anything that follows use order is unchanged between them.
//
// Read `<imm> → [sp,#off]` by pairing each `addiu rX,a0,<imm>` with the next `sw rX,off(sp)` (the
// old allocators reuse a temp, so pairing is by nearest following store, not by register).
const declRank = (file: string, reversed: boolean): [number, number][] => {
  const pending = new Map<string, number>();
  const out: [number, number][] = [];
  for (const line of read(file).split('\n')) {
    const def = /addiu\s+(\S+),a0,(-?\d+)/.exec(line);
    if (def !== null) {
      pending.set(def[1], Number(def[2]));
      continue;
    }
    const st = /\bsw\s+(\S+),(\d+)\(sp\)/.exec(line);
    if (st !== null && pending.has(st[1])) {
      const k = pending.get(st[1])! / 17; // the k-th assignment, 1-based
      pending.delete(st[1]);
      out.push([reversed ? 16 - k : k - 1, Number(st[2])]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
};
const directionOf = (file: string, reversed: boolean): { n: number; dir: string } => {
  const rows = declRank(file, reversed);
  const asc = rows.every((r, i) => i === 0 || rows[i - 1][1] < r[1]);
  const desc = rows.every((r, i) => i === 0 || rows[i - 1][1] > r[1]);
  return { n: rows.length, dir: asc ? 'ascending' : desc ? 'descending' : 'mixed' };
};

test('ido7.1 hands frame slots out DESCENDING against declaration rank — measured, not shipped', () => {
  expect(directionOf('ido71-declrank.txt', false)).toEqual({ n: 16, dir: 'descending' });
  // the reversal moves which VARIABLE sits at each offset and leaves rank → offset alone, which is
  // what makes this a fact about declaration rank rather than about the order of the assignments
  expect(directionOf('ido71-declrank-rev.txt', true)).toEqual({ n: 16, dir: 'descending' });
  expect(MIPS_IDO.compilerBehaviors.spillSlotOrder).toBe('unknown');
});

test('both toolchains behind MIPS_GCC hand them out ASCENDING — and the field is per DESCRIPTION', () => {
  // gcc2.7.2kmc (Snowboard Kids 2's Kyoto build, -O2) and gcc2.7.2 (Mario Party 3's, -O1) share
  // ONE TargetDescription, so this pair is also the check that the two agree — a behavior that
  // differed between two toolchains mapping to one description would be mis-keyed by construction,
  // and `compilerBehaviors` has no way to spell the override.
  expect(directionOf('gcc272kmc-declrank.txt', false)).toEqual({ n: 7, dir: 'ascending' });
  expect(directionOf('gcc272kmc-declrank-rev.txt', true)).toEqual({ n: 7, dir: 'ascending' });
  expect(directionOf('gcc272-declrank.txt', false)).toEqual({ n: 7, dir: 'ascending' });
  expect(directionOf('gcc272-declrank-rev.txt', true)).toEqual({ n: 7, dir: 'ascending' });
  expect(MIPS_GCC.compilerBehaviors.spillSlotOrder).toBe('unknown');
});

// mwcc has NO probe here, and that is the finding rather than an omission: it spilled nothing on
// this probe at sixteen locals and nothing at forty either (it sinks the whole computation past
// the call, so no local is live across it). Its comment in target.ts is corrected to say the
// direction is UNMEASURED rather than "9 of 9".
test('mwcc ships unknown with no measured direction behind it', () => {
  expect(PPC_MWCC.compilerBehaviors.spillSlotOrder).toBe('unknown');
});

// ── A5: one pure ordering, owned by `emit` ────────────────────────────────────────────────────

/** Two slot-carrying locals declared AGAINST an ascending frame, an unslotted one between them. */
const twoSlots = (over: Partial<SFn> = {}): SFn => ({
  name: 'f',
  params: [],
  locals: [
    { name: 'hi', type: T.int(32, true), slots: [4] },
    { name: 'mid', type: T.int(32, true) },
    { name: 'lo', type: T.int(32, true), slots: [0] },
  ],
  retType: T.void(),
  body: [],
  slotOrder: 'ascending',
  ...over,
});

const declOrder = (src: string): string[] => [...src.matchAll(/\b(hi|mid|lo|only)\b/g)].map((m) => m[1]);

// EACH BACKEND'S OWN `emit` MUST DO THE ORDERING. The input here is the structurer's order —
// `hi, mid, lo` against an ascending frame — and is handed to `emit` UNSORTED on purpose: pre-
// sorting it with `orderSlotLocals` would make these pass whether or not `emit` called anything,
// since every backend prints its declaration list in list order.
test('C: the declaration list is refilled in the target frame order, in place', () => {
  expect(declOrder(cBackend.emit(twoSlots()))).toEqual(['lo', 'mid', 'hi']);
});

test('C++: the same, through the other C-family backend', () => {
  const backend = cppBackend({ method: 'f', retType: { base: 'void', ptr: 0 }, params: [] });
  expect(declOrder(backend.emit(twoSlots()))).toEqual(['lo', 'mid', 'hi']);
});

test('Pascal: the same, through a backend with its own spelling', () => {
  expect(declOrder(pascalBackend.emit(twoSlots()))).toEqual(['lo', 'mid', 'hi']);
});

test('descending reverses it, and an unknown direction is the identity', () => {
  expect(orderSlotLocals(twoSlots({ slotOrder: 'descending' })).locals.map((l) => l.name)).toEqual(['hi', 'mid', 'lo']);
  expect(orderSlotLocals(twoSlots({ slotOrder: undefined })).locals.map((l) => l.name)).toEqual(['hi', 'mid', 'lo']);
});

test('fewer than two sortable locals is the identity', () => {
  const one = twoSlots({
    locals: [
      { name: 'mid', type: T.int(32, true) },
      { name: 'only', type: T.int(32, true), slots: [8] },
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

// REFUSAL 6 — a non-injective slot -> local map refuses the WHOLE function, not just the pair.
// Reload hands each spilled pseudo a fresh slot, so two declared locals at one offset means the
// evidence did not come from reload, and the shared offset is then used to rank both sharers
// against every OTHER sortable local too. Leaving only the pair alone would still move `lo`.
test('two locals sharing one slot refuse the whole ordering, not just that pair', () => {
  const sfn = twoSlots({
    locals: [
      { name: 'hi', type: T.int(32, true), slots: [4] },
      { name: 'mid', type: T.int(32, true), slots: [4] },
      { name: 'lo', type: T.int(32, true), slots: [0] },
    ],
  });
  // identity — and NOT ['lo','hi','mid'], which is what ranking the two sharers against `lo`
  // by their shared offset would give
  expect(orderSlotLocals(sfn).locals.map((l) => l.name)).toEqual(['hi', 'mid', 'lo']);
});

// The wild shape this refusal was written for, from the only real agbcc function in a 2,463-
// function sweep that carries two slot-carrying locals: `sa3 enemies/hariisen_proj.s`
// `sub_80617E0` reaches L3 with `v8@12 v12@8 v13@12` — offset 12 under two names, because those
// slots are words of one declared stack array (`Vec2_32 sp00[2]`), not two reload spills. Without
// the refusal the whole declaration list permuted; with it the function is untouched.
test('the measured wild non-injective frame is the identity', () => {
  const sfn = twoSlots({
    locals: [
      { name: 'v8', type: T.int(32, true), slots: [12] },
      { name: 'v9', type: T.int(32, true) },
      { name: 'v12', type: T.int(32, true), slots: [8] },
      { name: 'v13', type: T.int(32, true), slots: [12] },
    ],
  });
  expect(orderSlotLocals(sfn).locals.map((l) => l.name)).toEqual(['v8', 'v9', 'v12', 'v13']);
  // and the refusal is what does it: drop the duplicate and the same frame DOES order
  const injective = twoSlots({
    locals: [
      { name: 'v8', type: T.int(32, true), slots: [12] },
      { name: 'v9', type: T.int(32, true) },
      { name: 'v12', type: T.int(32, true), slots: [8] },
    ],
  });
  expect(orderSlotLocals(injective).locals.map((l) => l.name)).toEqual(['v12', 'v9', 'v8']);
});

// A duplicate anywhere in the UNION refuses too, not just among the elected ranks: under
// ascending the ranks below are 0 and 4 and differ, but offset 4 is still homed under two names.
test('a duplicate among a local`s non-elected homes refuses as well', () => {
  const sfn = twoSlots({
    locals: [
      { name: 'hi', type: T.int(32, true), slots: [4] },
      { name: 'mid', type: T.int(32, true) },
      { name: 'lo', type: T.int(32, true), slots: [0, 4] },
    ],
  });
  expect(orderSlotLocals(sfn).locals.map((l) => l.name)).toEqual(['hi', 'mid', 'lo']);
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
    { name: 'x', type: T.int(32, true), slots: [8] },
    { name: 'y', type: T.int(32, true), slots: [0] },
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

test('a merge carries BOTH slots onto the survivor — the union, not an end of it', () => {
  // A merged pair can reproduce at most one slot, but WHICH one is the earlier rank depends on
  // the frame's direction, and `localsAfterMerge` is handed a locals list with no target in it.
  // So it unions, and `l3/slotorder.ts` elects.
  const merged = armDisjointUnder(ARM_DISJOINT_GATES, disagreeing()).candidates.find((c) => c.merged === 'y-x')!.sfn;
  expect(merged.locals.map((l) => [l.name, l.slots])).toEqual([['x', [0, 8]]]);
});

test('…on the span path too, where the survivor is the second name', () => {
  const sfn: SFn = {
    name: 'f',
    params: [],
    locals: [
      { name: 'p', type: T.int(32, true), slots: [4] },
      { name: 'q', type: T.int(32, true), slots: [12] },
    ],
    retType: T.void(),
    body: [asg('p', 1), use('p'), asg('q', 2), use('q')],
  };
  const out = coalesceUnder(COALESCE_GATES, sfn).candidates;
  const pq = out.find((c) => c.merged === 'p-q')!.sfn;
  expect(pq.locals.map((l) => [l.name, l.slots])).toEqual([['q', [4, 12]]]);
});

test("a survivor with no slot of its own inherits the absorbed local's", () => {
  const sfn: SFn = {
    name: 'f',
    params: [],
    locals: [
      { name: 'p', type: T.int(32, true), slots: [4] },
      { name: 'q', type: T.int(32, true) },
    ],
    retType: T.void(),
    body: [asg('p', 1), use('p'), asg('q', 2), use('q')],
  };
  const cands = coalesceUnder(COALESCE_GATES, sfn).candidates;
  expect(cands.find((c) => c.merged === 'p-q')!.sfn.locals.map((l) => [l.name, l.slots])).toEqual([['q', [4]]]);
  // …and a merge of two unslotted locals invents nothing
  const bare: SFn = { ...sfn, locals: sfn.locals.map((l) => ({ name: l.name, type: l.type })) };
  expect(
    coalesceUnder(COALESCE_GATES, bare).candidates.find((c) => c.merged === 'p-q')!.sfn.locals[0].slots,
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
