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

import { frontendFor } from '../src/frontend/registry';
import { makeSsaBuilder, stackSlotKey } from '../src/frontend/ssa';
import { type Block, type Fn, type Value, mkOp, mkValue, replaceAllUsesWith } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { T } from '../src/ir/types';
import { raiseRecovered } from '../src/pipeline';
import { type StructureOptions, structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, MIPS_IDO, structureOptionsFor } from '../src/target';

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
