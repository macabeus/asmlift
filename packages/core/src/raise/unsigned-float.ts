// asmlift — an unsigned integer converted to a single, in the open-coding a soft-float GCC emits.
//
// A runtime with a signed conversion and no unsigned one converts an unsigned word to a float of
// fewer significand bits than the word in two halves of a diamond (agbcc's gcc/optabs.c:3591-3622,
// `expand_float`, the SFmode case: 24 + 1 < 32 bits):
//
//	cmp   x, #0 ; blt neg
//	bl    __floatsisf            ; x fits a signed word: convert it
//	b     done
//   neg: t = (x & 1) | (x >> 1)       ; halve, keeping the low bit sticky (round to odd)
//	bl    __floatsisf            ; t < 2^31
//	f + f via __addsf3           ; double it back, rounded once
//   done:
//
// Which IS `(float)x` for an unsigned x: the halving loses only the low bit, kept as a sticky bit so
// the one rounding of the doubled value rounds as converting x would. So the diamond is read as one
// `uitofp`, the op the C cast `(float)(u32)x` compiles to. The double (53 + 1 >= 32) is the other
// path, optabs.c:3633-3655 (`__floatsidf`, then `__adddf3` of 2^32 when x is negative), which joins
// a 64-bit pair across the diamond; the frontend refuses that join ahead of this pass, so it has no
// reading here yet.
//
// IDENTITY-OR-DECLINE ABOUT THE SHAPE, as raise/divpow2.ts is about its own: the guard tests the
// converted value against 0 with its negative side on the halving arm; the halving is exactly
// `(x & 1) | (x >> 1)` of that same value; the doubling adds the arm's conversion to ITSELF; every
// value in an arm is read only where the shape reads it; and the join has these two arms as its only
// predecessors and one parameter. A diamond with another constant, another shift, or a value read
// inside an arm by anything else means something else, and stays for the helpers' own refusal.
//
// WHAT READS THE CONVERTED VALUE IS THE SOFT-FLOAT BOUNDARY'S QUESTION, not this file's. So the
// diamond is rewritten to one call of the conversion its runtime table names with the op `uitofp`
// (agbcc's `UNSIGNED_TO_SINGLE`, runtime-helpers.ts) — the call shape every other helper has — and
// raise/floathelpers.ts keeps it or refuses it by the rule it holds every helper to. A refused one
// is gapped under that entry's name, which no symbol in the asm spells. The rewrite is the
// identity, so it runs ahead of the fold and needs no reader of its own.
import { Block, Fn, Op, Value, defOpMap, mkOp, mkValue, predecessors, replaceAllUsesWith } from '../ir/core';
import type { Opcode } from '../ir/opcodes';
import type { RuntimeHelper } from '../runtime-helpers';
import type { TargetDescription } from '../target';

/** One open-coded `(float)x` of an unsigned word: the block that tests `x`, the join whose one
 *  parameter is the converted value, the two arms between them, the guard's compare, and the
 *  signed conversion the fitting arm calls (whose attrs the rewritten call keeps). */
interface UnsignedFloatDiamond {
  head: Block;
  x: Value;
  join: Block;
  arms: readonly Block[];
  guard: Op;
  conv: Op;
}

/** The name of the table's entry with this op and signature, or undefined. */
function entryFor(
  table: Readonly<Record<string, RuntimeHelper>>,
  op: Opcode,
  params: string,
  returns: number,
): string | undefined {
  return Object.entries(table).find(([, h]) => h.op === op && h.params.join() === params && h.returns === returns)?.[0];
}

/** Rewrite every unsigned-to-single diamond in `fn` to `u = call <uitofp entry>(x)` at the end of its
 *  head, which the join then continues (its parameter's uses now read `u`); the arms and the guard
 *  go. ONE BLOCK, because the call is where the asm ran the conversion and its readers follow it
 *  there: the fold stamps it a helper's (`helperOp`), which the structurer names at its def where it
 *  renders in another block. Nothing where the target's runtime table states no such conversion, or
 *  not the signed conversion and the single's sum the shape is written against. Returns whether
 *  anything changed. */
export function rewriteUnsignedFloatDiamonds(fn: Fn, target: TargetDescription): boolean {
  const table = target.runtimeHelpers ?? {};
  const unsigned = entryFor(table, 'uitofp', '32', 32);
  const toFloat = entryFor(table, 'sitofp', '32', 32);
  const add = entryFor(table, 'fadd', '32,32', 32);
  if (unsigned === undefined || toFloat === undefined || add === undefined) {
    return false;
  }
  // One at a time, searching again after each: a second conversion's head can be the first one's
  // join (`(float)a + (float)b`), which the merge moves into the first head, so a diamond found
  // before the merge would name a block that is gone.
  let changed = false;
  for (let d = findDiamonds(fn, toFloat, add)[0]; d !== undefined; d = findDiamonds(fn, toFloat, add)[0]) {
    const { head, x, join, arms, guard, conv } = d;
    const was = join.params[0];
    const u = mkValue(was.type);
    const call = mkOp('call', { operands: [x], results: [u], attrs: { ...conv.attrs, target: unsigned } });
    head.ops = [...head.ops.slice(0, -1).filter((op) => op !== guard), call, ...join.ops];
    fn.blocks = fn.blocks.filter((b) => !arms.includes(b) && b !== join);
    replaceAllUsesWith(fn, was, u);
    changed = true;
  }
  return changed;
}

function findDiamonds(fn: Fn, toFloat: string, add: string): UnsignedFloatDiamond[] {
  const defs = defOpMap(fn);
  const preds = predecessors(fn);
  // every reader of a value: the op, or the block whose edge argument it is
  const readers = new Map<Value, Array<Op | Block>>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands.forEach((o) => readers.set(o, [...(readers.get(o) ?? []), op]));
      op.successors.forEach((s) => s.args.forEach((a) => readers.set(a, [...(readers.get(a) ?? []), b])));
    }
  }
  const readBy = (v: Value) => readers.get(v) ?? [];
  const onlyBy = (v: Value, by: Op | Block) => readBy(v).every((r) => r === by);
  const constOf = (v: Value): number | undefined => {
    const d = defs.get(v);
    return d?.opcode === 'const' && typeof d.attrs.value === 'number' ? d.attrs.value : undefined;
  };
  const isCall = (op: Op | undefined, name: string) => op?.opcode === 'call' && op.attrs.target === name;
  // An arm: one predecessor (the head), no parameters, ending in a jump to `join` with one argument.
  const armTo = (b: Block, head: Block): Successor | null => {
    const t = b.ops[b.ops.length - 1];
    return b.params.length === 0 &&
      (preds.get(b) ?? []).length === 1 &&
      preds.get(b)![0] === head &&
      t?.opcode === 'br' &&
      t.successors.length === 1 &&
      t.successors[0].args.length === 1
      ? t.successors[0]
      : null;
  };
  const found: UnsignedFloatDiamond[] = [];
  for (const head of fn.blocks) {
    const t = head.ops[head.ops.length - 1];
    if (t?.opcode !== 'cond_br' || t.successors.length !== 2 || t.successors.some((s) => s.args.length > 0)) {
      continue;
    }
    // `x < 0` (or `x >= 0`, its arms the other way round), with the constant on either side
    const cond = defs.get(t.operands[0]);
    if (cond === undefined || !head.ops.includes(cond) || cond.operands.length !== 2 || !onlyBy(cond.results[0], t)) {
      continue;
    }
    const [l, r] = cond.operands;
    const flipped: Record<string, string> = { icmp_sgt: 'icmp_slt', icmp_sle: 'icmp_sge' };
    const [rel, x] = constOf(r) === 0 ? [cond.opcode, l] : constOf(l) === 0 ? [flipped[cond.opcode] ?? '', r] : ['', l];
    if (rel !== 'icmp_slt' && rel !== 'icmp_sge') {
      continue;
    }
    const [negBlock, posBlock] = (rel === 'icmp_slt' ? [0, 1] : [1, 0]).map((i) => t.successors[i].block);
    const negOut = armTo(negBlock, head);
    const posOut = armTo(posBlock, head);
    const join = negOut?.block;
    if (
      negBlock === posBlock ||
      negOut === null ||
      posOut === null ||
      join !== posOut.block ||
      join === fn.blocks[0] ||
      join.params.length !== 1 ||
      (preds.get(join) ?? []).length !== 2
    ) {
      continue;
    }
    // the arm that fits a signed word: the signed conversion of `x`, its result only the jump's argument
    const conv = posBlock.ops[0];
    if (
      posBlock.ops.length !== 2 ||
      !isCall(conv, toFloat) ||
      conv.operands.length !== 1 ||
      conv.operands[0] !== x ||
      posOut.args[0] !== conv.results[0] ||
      !onlyBy(conv.results[0], posBlock)
    ) {
      continue;
    }
    if (
      !halvingArm(
        negBlock,
        negOut,
        x,
        defs,
        onlyBy,
        constOf,
        (op) => isCall(op, toFloat),
        (op) => isCall(op, add),
      )
    ) {
      continue;
    }
    found.push({ head, x, join, arms: [negBlock, posBlock], guard: cond, conv });
  }
  return found;
}

type Successor = Op['successors'][number];

/** The arm `(x & 1) | (x >> 1)` → the signed conversion → the sum `f + f`, each value read only by
 *  the next. */
function halvingArm(
  b: Block,
  out: Successor,
  x: Value,
  defs: Map<Value, Op>,
  onlyBy: (v: Value, by: Op | Block) => boolean,
  constOf: (v: Value) => number | undefined,
  isConv: (op: Op | undefined) => boolean,
  isSum: (op: Op | undefined) => boolean,
): boolean {
  const sum = defs.get(out.args[0]);
  if (!isSum(sum) || sum!.operands.length !== 2 || !onlyBy(sum!.results[0], b)) {
    return false;
  }
  const [f, g] = sum!.operands;
  const conv = defs.get(f);
  if (f !== g || !isConv(conv) || conv!.operands.length !== 1 || !onlyBy(f, sum!)) {
    return false;
  }
  const or = defs.get(conv!.operands[0]);
  if (or?.opcode !== 'or' || or.operands.length !== 2 || !onlyBy(or.results[0], conv!)) {
    return false;
  }
  const parts = or.operands.map((o) => defs.get(o));
  const bit = parts.find((d) => d?.opcode === 'and');
  const half = parts.find((d) => d?.opcode === 'shr_u');
  if (
    bit === undefined ||
    half === undefined ||
    bit.operands.length !== 2 ||
    !bit.operands.includes(x) ||
    constOf(bit.operands.find((o) => o !== x) ?? x) !== 1 ||
    !onlyBy(bit.results[0], or) ||
    half.operands.length !== 1 ||
    half.operands[0] !== x ||
    half.attrs.imm !== 1 ||
    !onlyBy(half.results[0], or)
  ) {
    return false;
  }
  // the five ops in the arm, and nothing else there but the jump and the constant 1 the mask reads
  const shape = [bit, half, or, conv!, sum!];
  const allowed = new Set<Op>([...shape, b.ops[b.ops.length - 1]]);
  return (
    shape.every((op) => b.ops.includes(op)) &&
    b.ops.every((op) => allowed.has(op) || (op.opcode === 'const' && op.results.every((v) => onlyBy(v, bit))))
  );
}
