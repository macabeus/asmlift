// asmlift — the soft-float boundary (L1 recognition): where integer words become floats.
//
// Four things cross it. A runtime helper whose op computes on floats (`isFloatHelper`) — the peer of
// `raise/widehelpers.ts`, gated by the target's runtime table rather than a hardware capability.
// A parameter an ordinary callee declares `double` or `float` (the operands the frontend names on
// the call, `FLOATS_ATTR`). The
// result of an ordinary callee declared to return a floating type (its `floatReturn`). And a
// double literal, two constant words, where the target states their order
// (`TargetDescription.doubleArgWords`) and its compiler reads a literal back
// (`compilerBehaviors.roundTripsDoubleLiterals`). What sets all four apart from the integer
// helpers is the value's KIND: the words are bits in integer registers, and the pass re-types them
// as floats, which only data flow may justify — see the function below.
import { constWord } from '../ir/bits';
import { Fn, Op, Value, floatOperands, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';
import { doubleBits, doubleOf } from '../ir/float-bits';
import { type Opcode, fcmpOfTruth } from '../ir/opcodes';
import { T, intWidth } from '../ir/types';
import { type FnProto, declaredCallArgs, declaresAggregateReturn, floatingSpelling } from '../proto';
import { arrivesAsDeclared, floatSidesOf, helperOp, isFloatHelper, lookupHelper } from '../runtime-helpers';
import type { TargetDescription } from '../target';
import { RaiseUnsupportedError } from './errors';
import { isArgumentPair } from './pairparams';
import { foldUnsignedFloat, unsignedFloatDiamonds } from './unsigned-float';

/** Rewrite the float-arithmetic helper calls to the float ops, in place, each value at the width its
 *  helper's signature states, and hand a parameter the callee declares `double` or `float` (the
 *  operands the frontend names on the call, `FLOATS_ATTR`) a float of that width. Returns whether anything changed.
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
 *   - an argument the function also reads on its own, as a word or as one half of a pair — save a
 *     single the `ret` hands back whole where every `ret` hands back a float (`returnedArgument`);
 *   - a result read as a word or a half (`*(int *)&c` is a double's HIGH word, in r0), passed to
 *     any other call, or carried across an edge;
 *   - a result NOTHING reads. Folded, it would be a dead float op, and `dce` would delete the
 *     arithmetic. Optimising (-O1, -O2), agbcc deletes a helper call whose result is dead
 *     (`s = a * b; g(); return 0;` calls no `__mulsf3`), so the frontend hands a helper's result
 *     still in r0, and read by nothing but guessed calls, to the guessed call after it as its first argument
 *     (core target.ts `deletesDeadLibcalls`, frontend/call-plan.ts): `g1(a * b)` with `g1`
 *     undeclared reads `g1(__mulsf3(a, b))`, which refuses here as a result passed to another call
 *     — an undeclared callee is handed a `float` promoted to a `double`. Where the frontend does not
 *     hand it on, it reaches here unread. At -O0 the rule is not asked: agbcc stores the result to
 *     the frame, which reads it, and nothing folds there, its arguments being read from frame
 *     homes. A frontend that reads those homes must re-measure this. A result some other op ALSO
 *     reads is not refused: `s = a * b; g(s); return s;` and `s = a * b; g(); return s;` are the
 *     same bytes on agbcc, and a declaration of `g` closes the trim's `g()` reading
 *     (`trimClobberedCallArgs`).
 *  A call refused takes every call its result feeds or is fed by with it, so what folds is a closed
 *  set of floats and verify's float rule holds by construction.
 *
 *  A CONVERSION HAS AN INTEGER ON ONE SIDE (`floatSidesOf`), and only its float side is held to the
 *  rule above: `(float)i` converts whatever integer `i` is, a parameter, a load or a sum, and
 *  `(int)x` hands an integer to anything. Its result must still be read, by the dead-result rule,
 *  and a float the function also reads as a word is no float source for it either. */
export function recognizeFloatHelpers(fn: Fn, target: TargetDescription, self?: FnProto): boolean {
  const table = target.runtimeHelpers ?? {};
  let sites: Op[] = [];
  const consumers = new Map<Op, ReadonlyMap<number, number>>();
  const def = new Map<Value, Op>();
  const users = new Map<Value, Array<Op | null>>(); // null: an edge argument
  const returners = new Map<Op, string>(); // ordinary calls declared to return a floating type
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
      } else if (!helper && op.opcode === 'call' && floatOperands(op).size > 0) {
        consumers.set(op, floatOperands(op));
      }
      if (!helper && op.opcode === 'call' && typeof op.attrs.floatReturn === 'string') {
        returners.set(op, op.attrs.floatReturn);
      }
    }
  }
  if (!sites.length && !consumers.size && !returners.size) {
    return false;
  }
  // A projection nothing reads is not a read of a half: `dce` runs ahead of this pass only after a
  // fold that changed the IR, so the frontend's split of the result back into its registers may stand.
  const deadHalf = (u: Op | null) =>
    u !== null && (u.opcode === 'lo32' || u.opcode === 'hi32') && !users.has(u.results[0]);
  // A USE THAT TAKES THE VALUE AS A FLOAT: a helper the fold keeps, or a parameter the callee declares
  // floating (`FLOATS_ATTR`) — and only that parameter, so the same value handed to the
  // same call as a word is a word read.
  const floatUse = (u: Op | null, v: Value, calls: ReadonlySet<Op>): boolean =>
    u !== null &&
    ((calls.has(u) && sidesOf(u).operands) ||
      (consumers.has(u) && u.operands.every((o, i) => o !== v || consumers.get(u)!.has(i))));
  const floatsOnly = (v: Value, calls: ReadonlySet<Op>) => (users.get(v) ?? []).every((u) => floatUse(u, v, calls));
  const entry = fn.blocks[0].params;
  // THE FUNCTION'S OWN DECLARATION, where the caller states one, is the type the candidate prints
  // against it: an argument word it declares an integer is no float this function was handed
  // (`void q(int x){ pf(*(float *)&x); }` with `pf(float)` declared is `bl pf` alone, and lifted as
  // `void q(float x)` it conflicts with `void q(int x);`), and a return it declares no float takes
  // none (`int q(void){ float f = rf(); return *(int *)&f; }`).
  const integerWords = ownIntegerWords(self, target);
  const declaredWord = (v: Value) => integerWords.has(entry.indexOf(v));
  const returnsDeclaredWord =
    typeof self?.returns === 'string' && self.returns.trim() !== 'void' && floatingSpelling(self.returns) === undefined;
  // a `ret` hands back a float only where the function may be declared to return one
  const floatRet = (u: Op | null) => u?.opcode === 'ret' && !returnsDeclaredWord;
  const rets = fn.blocks.flatMap((b) => b.ops.filter((op) => op.opcode === 'ret' && op.operands.length > 0));
  // AN UNSIGNED WORD CONVERTED, as agbcc open-codes `(float)u` (raise/unsigned-float.ts): the join of
  // its diamond holds a float source as a helper's result is, kept where its readers all take a
  // float — a helper the fold keeps, or a return of a function returning only floats — and folded
  // to one `uitofp`. The diamond's own helper calls read across its edges, so this pass refuses
  // them; a diamond kept goes, a diamond not kept stays for the helpers' refusal.
  const diamonds = unsignedFloatDiamonds(fn, target);
  const converted = (v: Value, calls: ReadonlySet<Op>) =>
    diamonds.has(v) &&
    (users.get(v) ?? []).length > 0 &&
    (users.get(v) ?? []).every((u) => floatUse(u, v, calls) || floatRet(u));
  // A SINGLE ARGUMENT THE FUNCTION RETURNS is moved whole into r0, so the `ret` takes it as the float
  // it was handed — but only where every `ret` then hands back a float: an argument some fold reads
  // as a float, or a float this pass makes. A `return a;` beside `return 5;` is a function whose
  // other return C would convert to 5.0f, so there the `ret` stays a word read and the helper is
  // refused. A double's pair is two words the `ret` reads apart, and stays refused.
  const returnedArgument = (v: Value, calls: ReadonlySet<Op>) =>
    entry.includes(v) &&
    !declaredWord(v) &&
    (users.get(v) ?? []).some((u) => floatUse(u, v, calls)) &&
    (users.get(v) ?? []).every((u) => floatUse(u, v, calls) || floatRet(u));
  const returnsFloats = (calls: ReadonlySet<Op>) =>
    !returnsDeclaredWord &&
    rets.every((r) =>
      r.operands.every((o) => {
        const d = def.get(o);
        return d === undefined
          ? returnedArgument(o, calls) || converted(o, calls)
          : (calls.has(d) && sidesOf(d).result) || declaredSingle(d);
      }),
    );
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
      return (
        entry.includes(v) &&
        !declaredWord(v) &&
        (floatsOnly(v, calls) || (returnedArgument(v, calls) && returnsFloats(calls)))
      );
    }
    return (
      isArgumentPair(entry, d, (p) => users.get(p)!.filter((u) => !samePair(u, d)).length + 1) &&
      !declaredWord(d.operands[0]) &&
      !declaredWord(d.operands[1]) &&
      users.get(d.operands[0])!.every((u) => samePair(u, d) && floatsOnly(u.results[0], calls))
    );
  };
  // A SINGLE AN ORDINARY CALLEE IS DECLARED TO RETURN is one whole word in the return register, so
  // it is a float source as a helper's result is. A double is not: the frontend reads one word of
  // it (`declaredReturnWidth` sizes no floating type), and that word is not the value.
  const declaredSingle = (d: Op) => returners.get(d) === 'float' && intWidth(d.results[0].type) === 32;
  const fromCall = (v: Value, calls: ReadonlySet<Op>) => {
    const d = def.get(v);
    return d === undefined
      ? converted(v, calls) && (!(users.get(v) ?? []).some((u) => u?.opcode === 'ret') || returnsFloats(calls))
      : (calls.has(d) && sidesOf(d).result) || declaredSingle(d);
  };
  // A CONSTANT WORD, as a compiler may build one in two instructions: agbcc moves a word that is a
  // shifted byte as `mov`+`lsl` (thumb.md:66, `thumb_shiftable_const` at thumb.c:61) and one in
  // -255..-1 as `mov`+`neg` (thumb.md:88), so the high word of 2.0 reaches r3 as `0x80 << 23`. Its
  // value, or undefined where `v` is no constant — the shared word evaluator's answer (ir/bits.ts).
  const words = { defs: def };
  const wordOf = (v: Value): number | undefined => constWord(words, v) ?? undefined;
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
        (!sides.result || read.every((u) => floatUse(u, op.results[0], calls) || floatRet(u)))
      );
    });
    if (kept.length === sites.length) {
      break;
    }
    sites = kept;
  }
  const calls = new Set(sites);
  // A DECLARED FLOATING RETURN HAS NO FALLBACK EITHER. The candidate prints the call against its
  // declaration, so its result stored, compared, narrowed, carried across an edge in an integer
  // variable or handed to any other call is CONVERTED there — `u.f = f(); g = u.b[0];` lifted as
  // `g = f();` compiles to `bl f; bl __fixsfsi` — where the bytes moved the bits. So a single may
  // go only where a helper's result may (a helper the fold keeps, a `double` parameter, the
  // return), and is retyped a float; a double read off its one word goes nowhere. A result nothing
  // reads is a call statement, and stays one.
  const returned = new Map<Op, Value>();
  for (const [op, spelled] of returners) {
    const r = op.results[0];
    const read = (users.get(r) ?? []).filter((u) => !deadHalf(u));
    if (read.length === 0) {
      continue;
    }
    if (!declaredSingle(op) || !read.every((u) => floatUse(u, r, calls) || floatRet(u))) {
      throw new RaiseUnsupportedError(
        `cannot lift '${fn.name}': '${String(op.attrs.target)}' is declared to return ${spelled}, which this ` +
          'target hands back as bits in a general register, and its result is read here as something ' +
          'other than that float — a conversion the bytes do not make',
      );
    }
    returned.set(op, mkValue(T.f32()));
  }
  // A FLOAT RETURNED MAKES THE FUNCTION'S RETURN A FLOAT, so every other `ret` converts what it
  // hands back: `return 5;` beside `return fget();` compiles to the bits of 5.0f where the asm
  // hands back the word 5. Each value a `ret` reads must then be a float this pass makes — a kept
  // helper's result or a declared single's.
  const madeFloat = (v: Value) => {
    const d = def.get(v);
    return d === undefined
      ? (returnedArgument(v, calls) && argument(v, calls)) || fromCall(v, calls)
      : returned.has(d) || (calls.has(d) && sidesOf(d).result);
  };
  if (rets.some((r) => r.operands.some(madeFloat)) && !rets.every((r) => r.operands.every(madeFloat))) {
    throw new RaiseUnsupportedError(
      `cannot lift '${fn.name}': it returns a float on one path, and another return of this function hands ` +
        'back an integer word, which C would convert to that float',
    );
  }
  // A DECLARED DOUBLE OR FLOAT HAS NO FALLBACK. A helper the fold refuses stays a call for
  // `refuseUnmodelledHelpers` to gap, but an ordinary callee is no helper, and its words handed on
  // as integers are the wrong number, C converting them at the call — so a floating parameter
  // nothing here can hand a float of its width refuses the function. It counts arguments as the source does: an `sret` call's operand 0, the
  // hidden pointer, is not one.
  for (const [op, at] of consumers) {
    for (const [i, width] of at) {
      if (!source(op.operands[i], calls)) {
        const arg = i + (op.attrs.sret === true ? 0 : 1);
        const single = width === 32;
        throw new RaiseUnsupportedError(
          `cannot lift '${fn.name}': argument ${arg} of the call to '${String(op.attrs.target)}' ` +
            (single
              ? 'is a `float` its callee declares, and its word is not a float this function was handed or ' +
                'a runtime helper returned, moved whole'
              : 'is a `double` its callee declares, and its two words are not a double this function was ' +
                'handed, a runtime helper returned or a finite literal staged, moved whole'),
        );
      }
    }
  }
  const keptDiamonds = [...diamonds].filter(([v]) => fromCall(v, calls));
  if (!sites.length && !consumers.size && !returned.size && !keptDiamonds.length) {
    return false;
  }
  const floatOf = new Map<Value, Value>();
  const float = (bits: number) => mkValue(bits > 32 ? T.f64() : T.f32());
  for (const [v, d] of keptDiamonds) {
    const u = float(32);
    foldUnsignedFloat(fn, d, u);
    floatOf.set(v, u);
  }
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
  for (const [op, now] of returned) {
    floatOf.set(op.results[0], now);
  }
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
    at.forEach((width, i) => retype(op.operands[i], width));
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
      // the call stays, its result now the float it was declared
      if (returned.has(op)) {
        return [mkOp('call', { operands: op.operands, results: [returned.get(op)!], attrs: op.attrs })];
      }
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

/** The argument words a function's OWN declaration types as anything but a float, by entry slot (the
 *  frontends mint every slot below the highest one read, so slot k is word k: `isArgumentPair`) —
 *  empty where it states no typed list, or one this cannot lay out word for word (a by-value struct,
 *  an unsized spelling, a hidden struct-return pointer ahead of it). */
function ownIntegerWords(self: FnProto | undefined, target: TargetDescription): ReadonlySet<number> {
  const out = new Set<number>();
  const laid =
    Array.isArray(self?.params) && !declaresAggregateReturn(self) ? declaredCallArgs(self, target) : undefined;
  let word = 0;
  laid?.widths.forEach((w, i) => {
    const words = Math.max(1, Math.ceil(w / 32));
    if (!laid.floats.has(i)) {
      for (let k = 0; k < words; k++) {
        out.add(word + k);
      }
    }
    word += words;
  });
  return out;
}
