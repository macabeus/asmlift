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
// WHAT READS THE JOIN IS THE SOFT-FLOAT BOUNDARY'S QUESTION, not this file's: the converted value is
// a float, which may go only where a helper's float result may (a helper the fold keeps, or a return
// that hands back only floats), and whether a helper is kept depends on every other float around it.
// So raise/floathelpers.ts asks for the diamonds, treats each join as a float source in its closed
// set, and folds the ones it keeps with `foldUnsignedFloat`; a diamond it does not keep stays as the
// helper calls the bytes make, and the helpers' refusal gaps them.
import { Block, Fn, Op, Value, defOpMap, mkOp, predecessors } from '../ir/core';
import { lookupHelper } from '../runtime-helpers';
import type { TargetDescription } from '../target';

/** One open-coded `(float)x` of an unsigned word: the block that tests `x`, the join whose one
 *  parameter is the converted value, the two arms between them, and the guard's compare. */
export interface UnsignedFloatDiamond {
  head: Block;
  x: Value;
  join: Block;
  arms: readonly Block[];
  guard: Op;
}

/** Every unsigned-to-single diamond in `fn`, keyed by the join's parameter; none where the target's
 *  runtime is not the one the shape is written against (a signed word to a single, and a single's
 *  sum). */
export function unsignedFloatDiamonds(fn: Fn, target: TargetDescription): Map<Value, UnsignedFloatDiamond> {
  const table = target.runtimeHelpers ?? {};
  const toFloat = lookupHelper(table, '__floatsisf');
  const add = lookupHelper(table, '__addsf3');
  const found = new Map<Value, UnsignedFloatDiamond>();
  if (
    toFloat?.op !== 'sitofp' ||
    toFloat.params.join() !== '32' ||
    toFloat.returns !== 32 ||
    add?.op !== 'fadd' ||
    add.params.join() !== '32,32' ||
    add.returns !== 32
  ) {
    return found;
  }
  for (const d of findDiamonds(fn)) {
    found.set(d.join.params[0], d);
  }
  return found;
}

/** Rewrite a diamond to `u = uitofp x` in its head and a jump to the join, which loses its parameter
 *  (the caller replaces its uses with `u`); the arms and the guard go. */
export function foldUnsignedFloat(fn: Fn, d: UnsignedFloatDiamond, u: Value): void {
  const { head, x, join, arms, guard } = d;
  head.ops = head.ops.filter((op) => op !== guard);
  head.ops.splice(head.ops.length - 1, 1, mkOp('uitofp', { operands: [x], results: [u] }), br(join));
  join.params = [];
  fn.blocks = fn.blocks.filter((b) => !arms.includes(b));
}

const br = (to: Block): Op => mkOp('br', { successors: [{ block: to, args: [] }] });

function findDiamonds(fn: Fn): UnsignedFloatDiamond[] {
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
      join.params.length !== 1 ||
      (preds.get(join) ?? []).length !== 2
    ) {
      continue;
    }
    // the arm that fits a signed word: `__floatsisf(x)`, its result only the jump's argument
    const conv = posBlock.ops[0];
    if (
      posBlock.ops.length !== 2 ||
      !isCall(conv, '__floatsisf') ||
      conv.operands.length !== 1 ||
      conv.operands[0] !== x ||
      posOut.args[0] !== conv.results[0] ||
      !onlyBy(conv.results[0], posBlock)
    ) {
      continue;
    }
    if (!halvingArm(negBlock, negOut, x, defs, onlyBy, constOf, isCall)) {
      continue;
    }
    found.push({ head, x, join, arms: [negBlock, posBlock], guard: cond });
  }
  return found;
}

type Successor = Op['successors'][number];

/** The arm `(x & 1) | (x >> 1)` → `__floatsisf` → `f + f`, each value read only by the next. */
function halvingArm(
  b: Block,
  out: Successor,
  x: Value,
  defs: Map<Value, Op>,
  onlyBy: (v: Value, by: Op | Block) => boolean,
  constOf: (v: Value) => number | undefined,
  isCall: (op: Op | undefined, name: string) => boolean,
): boolean {
  const sum = defs.get(out.args[0]);
  if (!isCall(sum, '__addsf3') || sum!.operands.length !== 2 || !onlyBy(sum!.results[0], b)) {
    return false;
  }
  const [f, g] = sum!.operands;
  const conv = defs.get(f);
  if (f !== g || !isCall(conv, '__floatsisf') || conv!.operands.length !== 1 || !onlyBy(f, sum!)) {
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
