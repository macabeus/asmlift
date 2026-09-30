// asmlift — 64-bit runtime-helper lowering (L1 recognition).
//
// The peer of `raise/softdiv.ts`, one width up, and NOT gated on a hardware capability. A soft
// division is a division the ISA has no instruction for, so a target with a divider never emits
// one; no ISA this repo targets has 64-bit integer arithmetic at all, so `bl __muldi3` is software
// on every one of them whatever `hwDivide` says.
//
// By the time this runs the frontend has already read the call's arguments as 64-bit values and
// split its result back into the register pair (`frontend/thumb.ts`, at the `bl`), so the rewrite
// itself is the same one-line splice `softdiv` does: the helper's op over the same operands,
// reusing the SAME result value so every existing use already points at it.
//
// The signedness of the OPERATION comes from the helper name where the name splits it
// (`__divdi3`/`__udivdi3`) and from the operands where it does not — agbcc's `__muldi3` serves
// both spellings, so nothing here may read a signedness off it. See the table's own note.
import { Fn, Op, Value, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';
import { T } from '../ir/types';
import {
  type RuntimeHelper,
  arrivesAsDeclared,
  helperOp,
  isFloatHelper,
  isWideHelper,
  lookupHelper,
} from '../runtime-helpers';
import type { TargetDescription } from '../target';
import { isArgumentPair } from './pairparams';

/** Rewrite each recognised 64-bit helper call to the op it computes, in place. Returns whether
 *  anything changed. Runs BEFORE type recovery, so the operands get their signedness there. */
export function recognizeWideHelpers(fn: Fn, target: TargetDescription): boolean {
  const table = target.runtimeHelpers ?? {};
  let changed = foldFloatHelpers(fn, table);
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      if (op.opcode !== 'call') {
        continue;
      }
      const helper = lookupHelper(table, String(op.attrs.target));
      if (!helper?.op || !isWideHelper(helper) || isFloatHelper(helper)) {
        continue;
      }
      // ITS C PARAMETERS AT THEIR STATED WIDTHS, not its argument registers and not their count:
      // the frontend has paired the registers up, so a `__ashrdi3` that occupied three of them
      // arrives here as a 64-bit value and a word. That pair construction is the evidence the fold
      // rests on, and `arrivesAsDeclared` is the precondition for reading it — an operand count
      // says nothing about what the operands hold, and a call carrying the right count of the
      // wrong things folds into an operation over one half of each value.
      //
      // WHAT DECLINES HERE DOES NOT PASS THROUGH: `refuseUnmodelledHelpers` below gaps every
      // surviving call to a name this table carries, so a shape this cannot fold gets the loud
      // answer rather than a plausible one.
      if (
        !arrivesAsDeclared(
          helper,
          op.operands.map((o) => o.type),
          op.results.map((r) => r.type),
        )
      ) {
        continue;
      }
      b.ops.splice(i, 1, helperOp(helper.op, op, String(op.attrs.target)));
      changed = true;
    }
  }
  return changed;
}

/** Rewrite the float-arithmetic helper calls to the float ops, in place, each value at the width its
 *  helper's signature states. Returns whether anything changed.
 *
 *  A SOFT-FLOAT VALUE IS BITS IN INTEGER REGISTERS, AND ONLY DATA FLOW MAY READ THEM AS A FLOAT. A
 *  single travels in one register; a double in the pair a long long travels in, which the frontend
 *  builds the way it builds a long long's, `concat(lo = r0, hi = r1)` — but agbcc stores a double
 *  high word first (thumb.h:335 `FLOAT_WORDS_BIG_ENDIAN`): r0 holds the sign and exponent. Moving
 *  the value whole keeps it right, so a float may come only from where the ABI hands one over
 *  whole — this function's argument slot, or two consecutive ones for a double, or another of these
 *  helpers' results — and may go only into another of them or the return. Anything else refuses,
 *  and the call stays for `refuseUnmodelledHelpers` to gap:
 *   - an operand built from a literal, a load, or two unrelated words, whose halves the int64
 *     naming would put in the wrong order (`a + 1.5` stages `0x3ff80000` in r2);
 *   - an argument the function also reads on its own, as a word or as one half of a pair;
 *   - a result read as a word or a half (`*(int *)&c` is a double's HIGH word, in r0), passed to
 *     any other call, or carried across an edge.
 *  A call refused takes every call its result feeds or is fed by with it, so what folds is a closed
 *  set of floats and verify's float rule holds by construction. */
function foldFloatHelpers(fn: Fn, table: Readonly<Record<string, RuntimeHelper>>): boolean {
  let sites: Op[] = [];
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
      }
    }
  }
  if (!sites.length) {
    return false;
  }
  // A projection nothing reads is not a read of a half: without an idiom fold ahead of this pass
  // nothing has run `dce` since the frontend split the result back into its registers.
  const deadHalf = (u: Op | null) =>
    u !== null && (u.opcode === 'lo32' || u.opcode === 'hi32') && !users.has(u.results[0]);
  const entry = fn.blocks[0].params;
  // The argument slot itself, or the pair of them `isArgumentPair` names; `arrivesAsDeclared` has
  // already held each operand to its parameter's width.
  const argument = (v: Value, calls: ReadonlySet<Op>): boolean => {
    const d = def.get(v);
    return (
      (d === undefined ? entry.includes(v) : isArgumentPair(entry, d, (p) => users.get(p)?.length ?? 0)) &&
      users.get(v)!.every((u) => u !== null && calls.has(u))
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
          (u) => deadHalf(u) || (u !== null && (calls.has(u) || u.opcode === 'ret')),
        ),
    );
    if (kept.length === sites.length) {
      break;
    }
    sites = kept;
  }
  if (!sites.length) {
    return false;
  }
  const calls = new Set(sites);
  const floatOf = new Map<Value, Value>();
  const float = (bits: number) => mkValue(bits > 32 ? T.f64() : T.f32());
  for (const op of sites) {
    const helper = helperOf(op)!;
    op.operands.forEach((o, i) => {
      if (floatOf.has(o) || fromCall(o, calls)) {
        return;
      }
      // One parameter in its first slot's place, which is where the ABI put the value.
      const d = def.get(o);
      const slots = d === undefined ? [o] : d.operands;
      const whole = float(helper.params[i]);
      entry.splice(entry.indexOf(slots[0]), slots.length, whole);
      floatOf.set(o, whole);
    });
    floatOf.set(op.results[0], float(helper.returns));
  }
  for (const block of fn.blocks) {
    block.ops = block.ops.flatMap((op) => {
      if (calls.has(op)) {
        return [
          mkOp(helperOf(op)!.op!, {
            operands: op.operands.map((o) => floatOf.get(o)!),
            results: [floatOf.get(op.results[0])!],
          }),
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

/** Turn every surviving call to one of the target's runtime helpers into a gap. Returns whether
 *  anything changed. Runs after the two recognisers, so what it sees is what they declined.
 *
 *  RE-EMITTING A COMPILER'S OWN RUNTIME CALL IS NOT A RECOVERY, and it is worse than a plain
 *  miss: it MATCHES. Hand `mwcceppc` the source `return __div2i(a, b);` and it emits the `bl
 *  __div2i` the row was lifted from, byte for byte — so the differ scores asmlift's failure to
 *  model 64-bit division exactly as it would score modelling it. A row that cannot tell the two
 *  apart is measuring nothing, and four cells of the synthetic 64-bit family were banking that.
 *
 *  ONLY THE NAMES THE TARGET CARRIES, and a name outside the table stays an ordinary callee —
 *  which is right, because a project's own `__`-prefixed function is not this compiler's runtime
 *  and asmlift cannot tell them apart by spelling. A target with NO table therefore refuses
 *  nothing and spells every helper call it makes, which is the configuration this refusal exists
 *  to remove; `target.ts` says at the field which targets are still in it and what bounds them.
 *
 *  An `opaque` rather than a throw, so the gap behaves like every other one: strict mode declines
 *  naming it, annotate mode marks it and leaves the rest of the function standing. */
export function refuseUnmodelledHelpers(fn: Fn, target: TargetDescription): boolean {
  const table = target.runtimeHelpers;
  if (!table) {
    return false;
  }
  let changed = false;
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      // Membership, through the table's one reader: `in` would also answer for `toString` and every
      // other name on `Object.prototype`, and this is the refusal, so the fabricated reason would be
      // the whole of what a caller saw.
      if (op.opcode !== 'call' || lookupHelper(table, String(op.attrs.target)) === undefined) {
        continue;
      }
      b.ops.splice(
        i,
        1,
        mkOp('opaque', {
          operands: [...op.operands],
          results: [...op.results],
          attrs: { helper: op.attrs.target },
        }),
      );
      changed = true;
    }
  }
  return changed;
}
