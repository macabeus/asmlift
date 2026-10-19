// asmlift — the soft-float boundary (L1 recognition): where integer words become floats.
//
// Three things cross it. A runtime helper whose op computes on floats (`isFloatHelper`) — the peer of
// `raise/widehelpers.ts`, gated by the target's runtime table rather than a hardware capability.
// A parameter an ordinary callee declares `double` (the frontend's `doubles` on the call). And a
// double literal, two constant words, where the target states their order
// (`TargetDescription.doubleArgWords`) and its compiler reads a literal back
// (`compilerBehaviors.roundTripsDoubleLiterals`). What sets all three apart from the integer
// helpers is the value's KIND: the words are bits in integer registers, and the pass re-types them
// as floats, which only data flow may justify — see the function below.
import { Fn, Op, Value, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';
import { doubleBits, doubleOf } from '../ir/float-bits';
import { type Opcode, fcmpOfTruth } from '../ir/opcodes';
import { T } from '../ir/types';
import { arrivesAsDeclared, floatSidesOf, helperOp, isFloatHelper, lookupHelper } from '../runtime-helpers';
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
 *   - an operand built from a load or two unrelated words, whose halves the int64 naming would put
 *     in the wrong order. Two CONSTANT words are the exception: they are a literal, read in the
 *     target's word order into an `fconst` (`a + 1.5` stages `0x3ff80000` in r2, its high word);
 *   - an argument the function also reads on its own, as a word or as one half of a pair;
 *   - a result read as a word or a half (`*(int *)&c` is a double's HIGH word, in r0), passed to
 *     any other call, or carried across an edge;
 *   - a result NOTHING reads. Folded, it would be a dead float op, and `dce` would delete the
 *     arithmetic. Optimising (-O1, -O2), agbcc deletes a helper call whose result is dead
 *     (`s = a * b; g(); return 0;` calls no `__mulsf3`), so the result's one reader was a later call
 *     that took it in r0, and a guessed arity does not count a register a call wrote (frontend/ssa.ts
 *     `fallbackArgc`, `trimClobberedCallArgs`): `g1(a * b)` with `g1` undeclared reads as
 *     `__mulsf3(); return g1();`, and folded would print `return g1();`. A double's pair refuses
 *     that shape at the frontend, naming the half the next call reads; a single is one word, so it
 *     reaches here. At -O0 the rule is not asked: agbcc stores the result to the frame, which reads
 *     it, and nothing folds there, its arguments being read from frame homes. A frontend that reads
 *     those homes must re-measure this. A result some other op ALSO reads is not refused:
 *     `s = a * b; g(s); return s;` and `s = a * b; g(); return s;` are the same bytes on agbcc, and
 *     a declaration of `g` closes the trim's `g()` reading (`trimClobberedCallArgs`).
 *  A call refused takes every call its result feeds or is fed by with it, so what folds is a closed
 *  set of floats and verify's float rule holds by construction.
 *
 *  A CONVERSION HAS AN INTEGER ON ONE SIDE (`floatSidesOf`), and only its float side is held to the
 *  rule above: `(float)i` converts whatever integer `i` is, a parameter, a load or a sum, and
 *  `(int)x` hands an integer to anything. Its result must still be read, by the dead-result rule,
 *  and a float the function also reads as a word is no float source for it either. */
export function recognizeFloatHelpers(fn: Fn, target: TargetDescription): boolean {
  const table = target.runtimeHelpers ?? {};
  let sites: Op[] = [];
  const consumers = new Map<Op, readonly number[]>();
  const def = new Map<Value, Op>();
  const users = new Map<Value, Array<Op | null>>(); // null: an edge argument
  const use = (v: Value, by: Op | null) => users.set(v, [...(users.get(v) ?? []), by]);
  const helperOf = (op: Op) => (op.opcode === 'call' ? lookupHelper(table, String(op.attrs.target)) : undefined);
  const sidesOf = (op: Op) => floatSidesOf(helperOf(op)!);
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
    ((calls.has(u) && sidesOf(u).operands) ||
      (consumers.has(u) && u.operands.every((o, i) => o !== v || consumers.get(u)!.includes(i))));
  const floatsOnly = (v: Value, calls: ReadonlySet<Op>) => (users.get(v) ?? []).every((u) => floatUse(u, v, calls));
  const entry = fn.blocks[0].params;
  // A `concat` of the same two slots in the same order as `d`: the frontend builds one afresh at each
  // call it hands the pair to, so `g(x); g(x)` reads one parameter through two of them.
  const samePair = (u: Op | null, d: Op): u is Op =>
    u?.opcode === 'concat' && u.operands[0] === d.operands[0] && u.operands[1] === d.operands[1];
  // The argument slot itself, or the pair of them `isArgumentPair` names, read by nothing but
  // `concat`s of that pair, each taken as a float; `arrivesAsDeclared` has already held each operand
  // to its parameter's width.
  const argument = (v: Value, calls: ReadonlySet<Op>): boolean => {
    const d = def.get(v);
    if (d === undefined) {
      return entry.includes(v) && floatsOnly(v, calls);
    }
    return (
      isArgumentPair(entry, d, (p) => users.get(p)!.filter((u) => !samePair(u, d)).length + 1) &&
      users.get(d.operands[0])!.every((u) => samePair(u, d) && floatsOnly(u.results[0], calls))
    );
  };
  const fromCall = (v: Value, calls: ReadonlySet<Op>) => {
    const d = def.get(v);
    return d !== undefined && calls.has(d) && sidesOf(d).result;
  };
  // A CONSTANT WORD, as a compiler may build one in two instructions: agbcc moves a word that is a
  // shifted byte as `mov`+`lsl` (thumb.md:66, `thumb_shiftable_const` at thumb.c:61) and one in
  // -255..-1 as `mov`+`neg` (thumb.md:88), so the high word of 2.0 reaches r3 as `0x80 << 23`. Its
  // value, or undefined where `v` is no constant.
  const wordOf = (v: Value): number | undefined => {
    const d = def.get(v);
    if (d?.opcode === 'const') {
      return Number(d.attrs.value);
    }
    const shift = d?.opcode === 'shl' ? d.attrs.imm : undefined;
    const w =
      d?.operands.length === 1 && (d.opcode === 'neg' || typeof shift === 'number') ? wordOf(d.operands[0]) : undefined;
    return w === undefined ? undefined : d!.opcode === 'neg' ? -w | 0 : (w << (shift as number)) | 0;
  };
  // A LITERAL IS TWO CONSTANT WORDS, HIGH WORD FIRST on a target whose double crosses a call in
  // general words (`TargetDescription.doubleArgWords`) — the order that makes the long long naming
  // of the same pair another number. Its bits, or undefined where the pair is no literal, the target
  // states no such double, its compiler is not known to read the literal back
  // (`compilerBehaviors.roundTripsDoubleLiterals`), or the double is not finite — which no C literal
  // spells.
  const literalBits = (v: Value): string | undefined => {
    const d = def.get(v);
    const [first, second] = (d?.opcode === 'concat' ? d.operands : []).map(wordOf);
    if (
      target.doubleArgWords === undefined ||
      target.compilerBehaviors.roundTripsDoubleLiterals !== true ||
      first === undefined ||
      second === undefined
    ) {
      return undefined;
    }
    const bits = doubleBits(first, second);
    return Number.isFinite(doubleOf(bits)) ? bits : undefined;
  };
  const literal = (v: Value, calls: ReadonlySet<Op>) => literalBits(v) !== undefined && floatsOnly(v, calls);
  const source = (v: Value, calls: ReadonlySet<Op>) => argument(v, calls) || fromCall(v, calls) || literal(v, calls);
  // A COMPARE FOLDS THROUGH THE TESTS OF ITS RESULT, which is libgcc's three-way answer: each reader
  // must be a test of that integer against 0, and the compare the test then computes is read off
  // the helper's contract — the sign that orders the operands, and its value on a NaN (`unordered`)
  // — against `FCMP_TRUTH`. A test whose answer is no compare of the operands (always true, or true
  // on both orders but not on equality), or a reader that is no test, refuses the helper.
  const tests = new Map<Op, CompareTest[]>();
  sites = sites.filter((op) => {
    const unordered = helperOf(op)!.unordered;
    if (unordered === undefined) {
      return true;
    }
    const found = compareTests(op.results[0], users, def, wordOf, unordered);
    if (found !== null) {
      tests.set(op, found);
    }
    return found !== null;
  });
  for (;;) {
    const calls = new Set(sites);
    const kept = sites.filter((op) => {
      const sides = sidesOf(op);
      const read = (users.get(op.results[0]) ?? []).filter((u) => !deadHalf(u));
      return (
        (!sides.operands || op.operands.every((o) => source(o, calls))) &&
        read.length > 0 &&
        (!sides.result || read.every((u) => floatUse(u, op.results[0], calls) || u?.opcode === 'ret'))
      );
    });
    if (kept.length === sites.length) {
      break;
    }
    sites = kept;
  }
  const calls = new Set(sites);
  // A DECLARED DOUBLE HAS NO FALLBACK. A helper the fold refuses stays a call for
  // `refuseUnmodelledHelpers` to gap, but an ordinary callee is no helper, and its two words handed
  // on as integers are the wrong number — so a double parameter nothing here can hand a double
  // refuses the function. It counts arguments as the source does: an `sret` call's operand 0, the
  // hidden pointer, is not one.
  for (const [op, at] of consumers) {
    for (const i of at) {
      if (!source(op.operands[i], calls)) {
        const arg = i + (op.attrs.sret === true ? 0 : 1);
        throw new RaiseUnsupportedError(
          `cannot lift '${fn.name}': argument ${arg} of the call to '${String(op.attrs.target)}' ` +
            'is a `double` its callee declares, and its two words are not a double this function was ' +
            'handed, a runtime helper returned or a finite literal staged, moved whole',
        );
      }
    }
  }
  if (!sites.length && !consumers.size) {
    return false;
  }
  const floatOf = new Map<Value, Value>();
  const float = (bits: number) => mkValue(bits > 32 ? T.f64() : T.f32());
  // the `fconst` each literal's `concat` becomes, and the ops computing the constant words only it read
  const literals = new Map<Op, Op>();
  const spent = new Set<Op>();
  const spend = (w: Value, by: Op) => {
    const d = def.get(w)!;
    if (users.get(w)!.every((u) => u === by)) {
      spent.add(d);
      d.operands.forEach((o) => spend(o, d));
    }
  };
  // One parameter in its first slot's place, which is where the ABI put the value.
  const retype = (o: Value, bits: number) => {
    if (floatOf.has(o) || fromCall(o, calls)) {
      return;
    }
    const d = def.get(o);
    const pattern = literalBits(o);
    if (pattern !== undefined) {
      const whole = float(64);
      literals.set(d!, mkOp('fconst', { results: [whole], attrs: { bits: pattern } }));
      d!.operands.forEach((w) => spend(w, d!));
      floatOf.set(o, whole);
      return;
    }
    const slots = d === undefined ? [o] : d.operands;
    const whole = float(bits);
    entry.splice(entry.indexOf(slots[0]), slots.length, whole);
    for (const u of d === undefined ? [] : users.get(slots[0])!) {
      if (samePair(u, d!)) {
        floatOf.set(u.results[0], whole);
      }
    }
    floatOf.set(o, whole);
  };
  for (const op of sites) {
    const helper = helperOf(op)!;
    const sides = floatSidesOf(helper);
    if (sides.operands) {
      op.operands.forEach((o, i) => retype(o, helper.params[i]));
    }
    if (sides.result) {
      floatOf.set(op.results[0], float(helper.returns));
    }
  }
  for (const [op, at] of consumers) {
    at.forEach((i) => retype(op.operands[i], 64));
  }
  const folded = new Map<Op, Op>();
  for (const [op, found] of tests) {
    if (calls.has(op)) {
      for (const t of found) {
        const operands = op.operands.map((o) => floatOf.get(o)!);
        const fcmp = helperOp(t.opcode, String(op.attrs.target), operands, t.at.results[0]);
        // The relation the source spelled, where the test leaves it open: `__eqsf2` and `__nesf2`
        // each fold to `fcmp_oeq` or to `fcmp_une`, by the sense of the branch that tests them
        // (runtime-helpers.ts `RuntimeHelper.relation`).
        const relation = helperOf(op)!.relation;
        if (relation !== undefined) {
          fcmp.attrs.relation = relation;
        }
        folded.set(t.at, fcmp);
        t.spent.forEach((x) => spent.add(x));
      }
    }
  }
  for (const block of fn.blocks) {
    block.ops = block.ops.flatMap((op) => {
      if (folded.has(op)) {
        return [folded.get(op)!];
      }
      if (calls.has(op) && tests.has(op)) {
        return [];
      }
      if (calls.has(op)) {
        const sides = sidesOf(op);
        return [
          helperOp(
            helperOf(op)!.op!,
            String(op.attrs.target),
            op.operands.map((o) => (sides.operands ? floatOf.get(o)! : o)),
            sides.result ? floatOf.get(op.results[0])! : op.results[0],
          ),
        ];
      }
      if (literals.has(op)) {
        return [literals.get(op)!];
      }
      const retired = op.results.length === 1 && floatOf.has(op.results[0]);
      return retired || spent.has(op) || (deadHalf(op) && floatOf.has(op.operands[0])) ? [] : [op];
    });
  }
  for (const [was, now] of floatOf) {
    replaceAllUsesWith(fn, was, now);
  }
  return true;
}

/** One test of a compare helper's result: the op whose 0/1 value is the test, the float compare
 *  it computes, and the ops between the result and it, which only it reads. */
interface CompareTest {
  at: Op;
  opcode: Opcode;
  spent: Op[];
}

/** The integer compares a test may apply to the helper's result, each against the constant 0. */
const INT_TEST: Readonly<Record<string, (x: number, y: number) => boolean>> = {
  icmp_eq: (x, y) => x === y,
  icmp_ne: (x, y) => x !== y,
  icmp_slt: (x, y) => x < y,
  icmp_sle: (x, y) => x <= y,
  icmp_sgt: (x, y) => x > y,
  icmp_sge: (x, y) => x >= y,
  icmp_ult: (x, y) => x >>> 0 < y >>> 0,
  icmp_ule: (x, y) => x >>> 0 <= y >>> 0,
  icmp_ugt: (x, y) => x >>> 0 > y >>> 0,
  icmp_uge: (x, y) => x >>> 0 >= y >>> 0,
};

/** Every test of `r`, a compare helper's result, or null where some reader of it is none. The tests
 *  are the spellings agbcc gives a result's relation to 0: an integer compare with the constant 0
 *  on either side (`cmp r0, #0` before a branch or a 0/1 select), and the three sign-bit forms of a
 *  value — `r >> 31` (`< 0`), `~r >> 31` (`>= 0`) and `(-r | r) >> 31` (`!= 0`), each a logical
 *  shift by 31. Each answers by the SIGN of `r` alone, so the helper's three-way result is read at
 *  -1, 0 and 1 and at its NaN value, and the four answers name the compare in `FCMP_TRUTH`. */
function compareTests(
  r: Value,
  users: ReadonlyMap<Value, ReadonlyArray<Op | null>>,
  def: ReadonlyMap<Value, Op>,
  wordOf: (v: Value) => number | undefined,
  unordered: 1 | -1,
): CompareTest[] | null {
  const readers = (v: Value) => users.get(v) ?? [];
  const only = (v: Value): Op | null => (readers(v).length === 1 ? readers(v)[0] : null);
  const signBit = (u: Op | null, of: Value): boolean =>
    u?.opcode === 'shr_u' && u.operands.length === 1 && u.operands[0] === of && u.attrs.imm === 31;
  const found: CompareTest[] = [];
  const answer = (at: Op, spent: Op[], test: (x: number) => boolean): boolean => {
    const truth = [test(-1), test(0), test(1), test(unordered)];
    const opcode = fcmpOfTruth(truth);
    if (opcode === undefined) {
      return false;
    }
    found.push({ at, opcode, spent });
    return true;
  };
  for (const u of readers(r)) {
    if (u === null) {
      return null;
    }
    const cmp = INT_TEST[u.opcode];
    if (cmp !== undefined && u.operands.length === 2) {
      const [x, y] = u.operands;
      const ok =
        x === r && y !== r && wordOf(y) === 0
          ? answer(u, [], (v) => cmp(v, 0))
          : y === r && x !== r && wordOf(x) === 0 && answer(u, [], (v) => cmp(0, v));
      if (!ok) {
        return null;
      }
      continue;
    }
    if (signBit(u, r)) {
      if (!answer(u, [], (v) => v < 0)) {
        return null;
      }
      continue;
    }
    if (u.opcode === 'not' && u.operands.length === 1) {
      const shift = only(u.results[0]);
      if (!signBit(shift, u.results[0]) || !answer(shift!, [u], (v) => v >= 0)) {
        return null;
      }
      continue;
    }
    // `(-r | r) >> 31`: `r` has two readers, the `neg` and the `or`, and the test is taken at the
    // `neg`; the `or` is that same test, read when it is reached.
    if (u.opcode === 'neg' && u.operands.length === 1) {
      const or = only(u.results[0]);
      const shift = or ? only(or.results[0]) : null;
      const pairs =
        or?.opcode === 'or' &&
        or.operands.length === 2 &&
        or.operands.includes(r) &&
        or.operands.includes(u.results[0]) &&
        readers(r).includes(or);
      if (!pairs || !signBit(shift, or!.results[0]) || !answer(shift!, [u, or!], (v) => v !== 0)) {
        return null;
      }
      continue;
    }
    if (
      u.opcode === 'or' &&
      u.operands.some((o) => o !== r && def.get(o)?.opcode === 'neg' && def.get(o)!.operands[0] === r)
    ) {
      continue;
    }
    return null;
  }
  return found.length > 0 ? found : null;
}
