// asmlift — soft-float runtime-helper lowering (L1 recognition).
//
// The peer of `raise/widehelpers.ts` for the helpers whose op is a float op (`isFloatHelper`), and
// NOT gated on a hardware capability either: the target's runtime table is the gate, and a table
// that names no float helper folds nothing. What sets it apart from the integer helpers is the
// value's KIND: the call's operands and result are bits in integer registers, and the fold re-types
// them as floats, which only data flow may justify — see the function below.
import { Fn, Op, Value, mkValue, replaceAllUsesWith } from '../ir/core';
import { T } from '../ir/types';
import { arrivesAsDeclared, helperOp, isFloatHelper, lookupHelper } from '../runtime-helpers';
import type { TargetDescription } from '../target';
import { RaiseUnsupportedError } from './errors';
import { isArgumentPair } from './pairparams';

/** Rewrite the float-arithmetic helper calls to the float ops, in place, each value at the width its
 *  helper's signature states, and hand a parameter the callee declares `double` (the frontend's
 *  `doubles` on the call) a double. Returns whether anything changed.
 *
 *  A SOFT-FLOAT VALUE IS BITS IN INTEGER REGISTERS, AND ONLY DATA FLOW MAY READ THEM AS A FLOAT. A
 *  single travels in one register; a double in the pair a long long travels in, which the frontend
 *  builds the way it builds a long long's, `concat(lo = r0, hi = r1)` — but agbcc stores a double
 *  high word first (thumb.h:335 `FLOAT_WORDS_BIG_ENDIAN`): r0 holds the sign and exponent. Moving
 *  the value whole keeps it right, so a float may come only from where the ABI hands one over
 *  whole — this function's argument slot, or two consecutive ones for a double, or another of these
 *  helpers' results — and may go only into another of them, the return, or a parameter a callee
 *  declares `double`. Anything else refuses, and the call stays for `refuseUnmodelledHelpers` to
 *  gap:
 *   - an operand built from a literal, a load, or two unrelated words, whose halves the int64
 *     naming would put in the wrong order (`a + 1.5` stages `0x3ff80000` in r2);
 *   - an argument the function also reads on its own, as a word or as one half of a pair;
 *   - a result read as a word or a half (`*(int *)&c` is a double's HIGH word, in r0), passed to
 *     any other call, or carried across an edge.
 *  A call refused takes every call its result feeds or is fed by with it, so what folds is a closed
 *  set of floats and verify's float rule holds by construction. */
export function recognizeFloatHelpers(fn: Fn, target: TargetDescription): boolean {
  const table = target.runtimeHelpers ?? {};
  let sites: Op[] = [];
  const consumers = new Map<Op, readonly number[]>();
  const def = new Map<Value, Op>();
  const users = new Map<Value, Array<Op | null>>(); // null: an edge argument
  const use = (v: Value, by: Op | null) => users.set(v, [...(users.get(v) ?? []), by]);
  const helperOf = (op: Op) => (op.opcode === 'call' ? lookupHelper(table, String(op.attrs.target)) : undefined);
  for (const block of fn.blocks) {
    for (const op of block.ops) {
      op.results.forEach((r) => def.set(r, op));
      op.operands.forEach((o) => use(o, op));
      op.successors.forEach((s) => s.args.forEach((a) => use(a, null)));
      const helper = helperOf(op);
      if (
        helper &&
        isFloatHelper(helper) &&
        arrivesAsDeclared(
          helper,
          op.operands.map((o) => o.type),
          op.results.map((r) => r.type),
        )
      ) {
        sites.push(op);
      } else if (!helper && op.opcode === 'call' && Array.isArray(op.attrs.doubles)) {
        consumers.set(op, op.attrs.doubles as number[]);
      }
    }
  }
  if (!sites.length && !consumers.size) {
    return false;
  }
  // A projection nothing reads is not a read of a half: `dce` runs ahead of this pass only after a
  // fold that changed the IR, so the frontend's split of the result back into its registers may stand.
  const deadHalf = (u: Op | null) =>
    u !== null && (u.opcode === 'lo32' || u.opcode === 'hi32') && !users.has(u.results[0]);
  // A USE THAT TAKES THE VALUE AS A FLOAT: a helper the fold keeps, or a parameter the callee declares
  // `double` (the frontend's `doubles`) — and only that parameter, so the same value handed to the
  // same call as a word is a word read.
  const floatUse = (u: Op | null, v: Value, calls: ReadonlySet<Op>): boolean =>
    u !== null &&
    (calls.has(u) || (consumers.has(u) && u.operands.every((o, i) => o !== v || consumers.get(u)!.includes(i))));
  const entry = fn.blocks[0].params;
  // The argument slot itself, or the pair of them `isArgumentPair` names; `arrivesAsDeclared` has
  // already held each operand to its parameter's width.
  const argument = (v: Value, calls: ReadonlySet<Op>): boolean => {
    const d = def.get(v);
    return (
      (d === undefined ? entry.includes(v) : isArgumentPair(entry, d, (p) => users.get(p)?.length ?? 0)) &&
      users.get(v)!.every((u) => floatUse(u, v, calls))
    );
  };
  const fromCall = (v: Value, calls: ReadonlySet<Op>) => {
    const d = def.get(v);
    return d !== undefined && calls.has(d);
  };
  for (;;) {
    const calls = new Set(sites);
    const kept = sites.filter(
      (op) =>
        op.operands.every((o) => argument(o, calls) || fromCall(o, calls)) &&
        (users.get(op.results[0]) ?? []).every(
          (u) => deadHalf(u) || floatUse(u, op.results[0], calls) || u?.opcode === 'ret',
        ),
    );
    if (kept.length === sites.length) {
      break;
    }
    sites = kept;
  }
  const calls = new Set(sites);
  // A DECLARED DOUBLE HAS NO FALLBACK. A helper the fold refuses stays a call for
  // `refuseUnmodelledHelpers` to gap, but an ordinary callee is no helper, and its two words handed
  // on as integers are the wrong number — so a double parameter nothing here can hand a double
  // refuses the function.
  for (const [op, at] of consumers) {
    for (const i of at) {
      if (!argument(op.operands[i], calls) && !fromCall(op.operands[i], calls)) {
        throw new RaiseUnsupportedError(
          `cannot lift '${fn.name}': argument ${i + 1} of the call to '${String(op.attrs.target)}' is a ` +
            'floating-point argument its callee declares `double`, and it is not a double this function ' +
            'was handed or a runtime helper returned, moved whole',
        );
      }
    }
  }
  if (!sites.length && !consumers.size) {
    return false;
  }
  const floatOf = new Map<Value, Value>();
  const float = (bits: number) => mkValue(bits > 32 ? T.f64() : T.f32());
  // One parameter in its first slot's place, which is where the ABI put the value.
  const retype = (o: Value, bits: number) => {
    if (floatOf.has(o) || fromCall(o, calls)) {
      return;
    }
    const d = def.get(o);
    const slots = d === undefined ? [o] : d.operands;
    const whole = float(bits);
    entry.splice(entry.indexOf(slots[0]), slots.length, whole);
    floatOf.set(o, whole);
  };
  for (const op of sites) {
    const helper = helperOf(op)!;
    op.operands.forEach((o, i) => retype(o, helper.params[i]));
    floatOf.set(op.results[0], float(helper.returns));
  }
  for (const [op, at] of consumers) {
    at.forEach((i) => retype(op.operands[i], 64));
  }
  for (const block of fn.blocks) {
    block.ops = block.ops.flatMap((op) => {
      if (calls.has(op)) {
        return [
          helperOp(
            helperOf(op)!.op!,
            String(op.attrs.target),
            op.operands.map((o) => floatOf.get(o)!),
            floatOf.get(op.results[0])!,
          ),
        ];
      }
      const retired = op.results.length === 1 && floatOf.has(op.results[0]);
      return retired || (deadHalf(op) && floatOf.has(op.operands[0])) ? [] : [op];
    });
  }
  for (const [was, now] of floatOf) {
    replaceAllUsesWith(fn, was, now);
  }
  return true;
}
