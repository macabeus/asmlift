// M0 — the per-pattern golden test: input IR text → expected IR text. This is how
// "objdiff shows __divsi3 → add one pattern → re-score" becomes an individually
// testable, AI-addable datum.
import { expect, test } from 'vitest';

import {
  EFFECTFUL_OPS,
  HOIST_UNSAFE_OPS,
  NEGATED_ICMP,
  OPCODES,
  ORDER_SENSITIVE_OPS,
  REEVAL_UNSAFE_OPS,
  isDceSafe,
} from '../src/ir/opcodes';
import { parse } from '../src/ir/parse';
import { print } from '../src/ir/print';
import { verify } from '../src/ir/verify';
import {
  CNTLZW_EQ0,
  HWMOD_PATTERNS,
  NOT_CMP_PATTERNS,
  type RewritePattern,
  SDIV_POW2_2,
  applyPattern,
  dce,
  patternApplies,
} from '../src/pattern/engine';

// agbcc's signed /2 idiom, lifted to L1: shr_s(add(X, shr_u(X,31)), 1).
const BEFORE = `fn half {
^bb0(%0: s32):
  %1: u32 = shr_u %0 {imm=31}
  %2: s32 = add %0, %1
  %3: s32 = shr_s %2 {imm=1}
  ret %3
}
`;

// After folding to sdiv (asserting signed) + DCE of the now-dead feeders.
const AFTER = `fn half {
^bb0(%0: s32):
  %1: s32 = sdiv %0 {imm=2}
  ret %1
}
`;

test('golden: sdiv-pow2/2 folds the idiom and DCE cleans the feeders', () => {
  const fn = parse(BEFORE);
  const n = applyPattern(fn, SDIV_POW2_2);
  dce(fn);
  expect(n).toBe(1);
  expect(print(fn)).toBe(AFTER);
  verify(fn);
});

test('no spurious match on a non-idiom function', () => {
  const fn = parse(`fn keep {\n^bb0(%0: s32):\n  %1: s32 = shr_s %0 {imm=1}\n  ret %1\n}\n`);
  expect(applyPattern(fn, SDIV_POW2_2)).toBe(0);
});

test('patternApplies gates on the COMPILER (the /2 idiom fires for agbcc + gcc, not ido)', () => {
  // compiler is a LIVE axis: the same shift-sequence for `/2` is emitted by agbcc AND gcc (across
  // two ISAs), so the pattern is tagged by a compiler LIST — and excluded for a compiler (ido)
  // that isn't in it, even on a matching ISA. This is what distinguishes MIPS+IDO from MIPS+GCC.
  const caps = { hwDivide: false, hwFloat: false };
  const agbcc = { id: 'armv4t', compiler: 'agbcc', capabilities: caps };
  const gcc = { id: 'mips', compiler: 'gcc', capabilities: { hwDivide: true, hwFloat: true } };
  const ido = { id: 'mips', compiler: 'ido', capabilities: { hwDivide: true, hwFloat: true } };
  expect(patternApplies(SDIV_POW2_2, agbcc)).toBe(true);
  expect(patternApplies(SDIV_POW2_2, gcc)).toBe(true);
  expect(patternApplies(SDIV_POW2_2, ido)).toBe(false);
});

// ── `cmp ^ 1` → the negated comparison ────────────────────────────────────────────────────────
// MIPS's materialised `a0 >= a1`: there is no set-on-greater-equal, so the compiler emits the
// opposite compare plus a boolean flip (`slt v0,a0,a1; xori v0,v0,1`). IDO, both GCCs, PPC and ARM
// all spell a negated compare this way.
const XOR1_BEFORE = `fn ge {
^bb0(%0: s32, %1: s32):
  %2: u32 = icmp_slt %0, %1
  %3: u32 = const {value=1}
  %4: u32 = xor %2, %3
  ret %4
}
`;
const XOR1_AFTER = `fn ge {
^bb0(%0: s32, %1: s32):
  %2: u32 = icmp_sge %0, %1
  ret %2
}
`;

test('golden: `cmp ^ 1` folds to the negated comparison and DCE cleans the feeders', () => {
  const fn = parse(XOR1_BEFORE);
  const hits = NOT_CMP_PATTERNS.reduce((n, p) => n + applyPattern(fn, p), 0);
  dce(fn);
  expect(hits).toBe(1);
  expect(print(fn)).toBe(XOR1_AFTER);
  verify(fn);
});

test('the fold covers every comparison, in BOTH operand orders, and is involutive', () => {
  // one pattern per icmp — a comparison missing from the table would silently keep the
  // double-negative spelling, which is exactly the readability bug the fold exists to remove
  expect(NOT_CMP_PATTERNS.map((p) => p.id).sort()).toEqual(
    Object.keys(NEGATED_ICMP)
      .flatMap((c) => [`not-${c}`, `not-zerotest-${c}`, `is-zerotest-${c}`])
      .sort(),
  );
  for (const cmp of Object.keys(NEGATED_ICMP)) {
    // xor is commutative — a compiler may emit either operand order (`xori rD,rS,1`
    // lifts one way, a register-register `xor` the other)
    for (const order of ['%2, %3', '%3, %2']) {
      const fn = parse(
        `fn f {\n^bb0(%0: s32, %1: s32):\n  %2: u32 = ${cmp} %0, %1\n` +
          `  %3: u32 = const {value=1}\n  %4: u32 = xor ${order}\n  ret %4\n}\n`,
      );
      const hits = NOT_CMP_PATTERNS.reduce((n, p) => n + applyPattern(fn, p), 0);
      dce(fn);
      expect(hits).toBe(1);
      expect(print(fn)).toContain(NEGATED_ICMP[cmp]);
      // negating twice is the identity — the table is derived from involutive pairs, and a
      // consumer that disagreed about the opposite of a compare would show up here
      expect(NEGATED_ICMP[NEGATED_ICMP[cmp]]).toBe(cmp);
      verify(fn);
    }
  }
});

test('the fold is SEMANTIC, not compiler-pinned: it applies to every target', () => {
  // unlike the shift-pair/rotate folds (which trade one spelling for another and are only
  // byte-safe on the compilers measured), `xor(icmp, 1)` cannot mean anything but the negated
  // compare — an icmp result is 0/1 by construction — so no `applies` axis is declared
  const targets = [
    { id: 'armv4t', compiler: 'agbcc', capabilities: { hwDivide: false, hwFloat: false } },
    { id: 'mips', compiler: 'ido', capabilities: { hwDivide: true, hwFloat: true } },
    { id: 'ppc', compiler: 'mwcc', capabilities: { hwDivide: true, hwFloat: true } },
  ];
  for (const t of targets) {
    expect(NOT_CMP_PATTERNS.every((p) => patternApplies(p, t))).toBe(true);
  }
});

test('no spurious fold: a xor by any other constant, or of a non-comparison, is left alone', () => {
  const mask = parse(
    `fn f {\n^bb0(%0: s32, %1: s32):\n  %2: u32 = icmp_slt %0, %1\n  %3: u32 = const {value=2}\n  %4: u32 = xor %2, %3\n  ret %4\n}\n`,
  );
  expect(NOT_CMP_PATTERNS.reduce((n, p) => n + applyPattern(mask, p), 0)).toBe(0);
  // ReadKeyInput's `eor rX, #0x3ff` shape: a bitwise mask-xor of a plain value, not a boolean flip
  const plain = parse(`fn f {\n^bb0(%0: s32):\n  %1: u32 = const {value=1}\n  %2: u32 = xor %0, %1\n  ret %2\n}\n`);
  expect(NOT_CMP_PATTERNS.reduce((n, p) => n + applyPattern(plain, p), 0)).toBe(0);
});

test('the table covers the WHOLE icmp family — a new comparison cannot be silently missed', () => {
  // NEGATED_ICMP is authored data seated beside the opcode registry, and its symmetry is the only
  // part construction guarantees. An eleventh `icmp_*` registered without a negation entry degrades
  // three consumers three different ways — the MIPS branch fold throws in the verifier, the
  // short-circuit recognizer silently declines, and NOT_CMP_PATTERNS silently omits it. This is the
  // one assertion that turns all three into a red test here instead.
  expect(Object.keys(NEGATED_ICMP).sort()).toEqual(
    Object.keys(OPCODES)
      .filter((k) => k.startsWith('icmp_'))
      .sort(),
  );
});

test('composition: mwcc `!(x == 0)` folds through cntlzw-eq0 into a single `x != 0`', () => {
  // `cntlzw rD,rS; srwi rD,rD,5; xori rD,rD,1` — mwcc's `x != 0`. Neither fold reaches it alone:
  // cntlzw-eq0 must run FIRST to turn `clz(x) >> 5` into the `icmp_eq` this one then negates. That
  // ordering is an invariant of DEFAULT_IDIOM_PATTERNS (each pattern runs to its own fixpoint, in
  // list order), and this is what pins it — reorder the list and the fold silently stops composing.
  const fn = parse(
    `fn notb {\n^bb0(%0: s32):\n  %1: u32 = clz %0\n  %2: u32 = shr_u %1 {imm=5}\n` +
      `  %3: u32 = const {value=1}\n  %4: u32 = xor %2, %3\n  ret %4\n}\n`,
  );
  let hits = applyPattern(fn, CNTLZW_EQ0);
  for (const p of NOT_CMP_PATTERNS) {
    hits += applyPattern(fn, p);
  }
  dce(fn);
  expect(hits).toBe(2);
  expect(print(fn)).toBe(
    'fn notb {\n^bb0(%0: s32):\n  %1: s32 = const {value=0}\n  %2: u32 = icmp_ne %0, %1\n  ret %2\n}\n',
  );
  verify(fn);
});

test('the four effect views over the registry name four different questions', () => {
  // Each set answers one question about an op, and all four are derived from the signature flags
  // rather than listed, so registering an opcode cannot leave one behind. Pinned because the
  // memberships OVERLAP, and the disagreements are the whole reason there is more than one set.
  expect([...EFFECTFUL_OPS].sort()).toEqual(['astore', 'call', 'opaque', 'store']);
  expect([...HOIST_UNSAFE_OPS].sort()).toEqual([...EFFECTFUL_OPS].sort());
  expect([...ORDER_SENSITIVE_OPS].sort()).toEqual(['aload', 'astore', 'call', 'load', 'opaque', 'store']);
  expect([...REEVAL_UNSAFE_OPS].sort()).toEqual([
    'aload',
    'astore',
    'call',
    'load',
    'opaque',
    'sdiv',
    'smod',
    'store',
    'udiv',
    'umod',
  ]);
  // One opcode, four answers: a dead load is reapable, hoisting one is allowed (its consumers
  // re-guard it), moving one on the same path is not, and neither is rebuilding it elsewhere.
  expect(isDceSafe('load')).toBe(true);
  expect(HOIST_UNSAFE_OPS.has('load')).toBe(false);
  expect(ORDER_SENSITIVE_OPS.has('load')).toBe(true);
  // A divide separates the last two: reordering one on a path it already ran is fine, running it
  // on a path that skipped it is not — which is the only difference between the two sets.
  expect(ORDER_SENSITIVE_OPS.has('sdiv')).toBe(false);
  expect(REEVAL_UNSAFE_OPS.has('sdiv')).toBe(true);
});

// ── an idiom that declares an operand order load-bearing ──────────────────────────────────────
// `mul` is commutative, so by default a pattern node over one matches its operands in either
// order. `ordered: true` turns that off for one node, which is what an idiom needs when the
// machine's operand order is the evidence rather than an accident of the encoding.
const MUL_ORDER_PROBE: RewritePattern = {
  id: 'test/neg-times',
  applies: {},
  match: { op: 'mul', ordered: true, args: [{ op: 'neg', args: [{ bind: 'X' }] }, { bind: 'Y' }] },
  replaceWith: { op: 'sub', args: ['Y', 'X'] },
};

const NEG_FIRST = `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = neg %0
  %3: s32 = mul %2, %1
  ret %3
}
`;

const NEG_SECOND = `fn f {
^bb0(%0: s32, %1: s32):
  %2: s32 = neg %0
  %3: s32 = mul %1, %2
  ret %3
}
`;

test('`ordered` matches the written operand order and refuses the swap', () => {
  expect(applyPattern(parse(NEG_FIRST), MUL_ORDER_PROBE)).toBe(1);
  expect(applyPattern(parse(NEG_SECOND), MUL_ORDER_PROBE)).toBe(0);
});

test('without `ordered` the same pattern matches a commutative op both ways', () => {
  const both: RewritePattern = { ...MUL_ORDER_PROBE, match: { ...MUL_ORDER_PROBE.match, ordered: undefined } };
  expect(applyPattern(parse(NEG_FIRST), both)).toBe(1);
  expect(applyPattern(parse(NEG_SECOND), both)).toBe(1);
});

// ── PPC's synthesized remainder ───────────────────────────────────────────────────────────────
// `divw; mullw; subf` with the same two operands throughout IS `a % b` — PowerPC has no remainder
// instruction, so the operator only exists in the source. The fold gives it back.
const HWMOD_SMOD = HWMOD_PATTERNS[0];
const HWMOD_UMOD = HWMOD_PATTERNS[1];

const MOD_BEFORE = `fn modv {
^bb0(%0: s32, %1: s32):
  %2: s32 = sdiv %0, %1
  %3: s32 = mul %2, %1
  %4: s32 = sub %0, %3
  ret %4
}
`;

const MOD_AFTER = `fn modv {
^bb0(%0: s32, %1: s32):
  %2: s32 = smod %0, %1
  ret %2
}
`;

test('golden: hwmod-smod folds divide-multiply-subtract to one remainder', () => {
  const fn = parse(MOD_BEFORE);
  const n = applyPattern(fn, HWMOD_SMOD);
  dce(fn);
  expect(n).toBe(1);
  expect(print(fn)).toBe(MOD_AFTER);
  verify(fn);
});

test('golden: hwmod-umod is the same fold over the unsigned divide', () => {
  const fn = parse(MOD_BEFORE.replace('sdiv', 'udiv'));
  expect(applyPattern(fn, HWMOD_UMOD)).toBe(1);
  dce(fn);
  expect(print(fn)).toBe(MOD_AFTER.replace('smod', 'umod'));
  verify(fn);
});

test('hwmod refuses the multiply that reads the DIVISOR first', () => {
  // `mullw rP,b,rQ` is what a source-level `a - b * (a / b)` compiles to, and asmlift already
  // reproduces that byte-exact by spelling the decomposition back out. Folding it would respell it.
  expect(applyPattern(parse(MOD_BEFORE.replace('mul %2, %1', 'mul %1, %2')), HWMOD_SMOD)).toBe(0);
});

test('hwmod refuses a different dividend or a different divisor', () => {
  const withThird = (body: string) => `fn f {\n^bb0(%0: s32, %1: s32, %9: s32):\n${body}  ret %4\n}\n`;
  // `c - a / b * b` — the subtraction's left operand is not the dividend.
  const otherDividend = withThird('  %2: s32 = sdiv %0, %1\n  %3: s32 = mul %2, %1\n  %4: s32 = sub %9, %3\n');
  // `a - a / b * c` — the multiplier is not the divisor.
  const otherDivisor = withThird('  %2: s32 = sdiv %0, %1\n  %3: s32 = mul %2, %9\n  %4: s32 = sub %0, %3\n');
  expect(applyPattern(parse(otherDividend), HWMOD_SMOD)).toBe(0);
  expect(applyPattern(parse(otherDivisor), HWMOD_SMOD)).toBe(0);
});

test('hwmod applies to PPC/mwcc only — not to the hardware-divide ISA that HAS a remainder', () => {
  // Not the `hwDivide` axis: MIPS divides in hardware too, and needs no fold because `div` leaves
  // the remainder in `hi` for the frontend to read out as `smod` directly.
  const mips = { id: 'mips', compiler: 'ido', capabilities: { hwDivide: true, hwFloat: true } };
  const arm = { id: 'armv4t', compiler: 'agbcc', capabilities: { hwDivide: false, hwFloat: false } };
  const ppc = { id: 'ppc', compiler: 'mwcc', capabilities: { hwDivide: true, hwFloat: true } };
  expect(patternApplies(HWMOD_SMOD, ppc)).toBe(true);
  expect(patternApplies(HWMOD_SMOD, mips)).toBe(false);
  expect(patternApplies(HWMOD_SMOD, arm)).toBe(false);
});

// ── an idiom that may not DE-SEQUENCE what it folds ───────────────────────────────────────────
// A fold collapses several ops into one, which drops its operands from two uses to one — and the
// structurer inlines a single-use effect AT its one use, so both land as operands of one C
// expression, whose order C leaves unspecified. asmlift's inline-at-use model exempts that case on
// the premise that "the recompiling compiler orders unsequenced operands of one expression exactly
// as it originally chose to", which is true only when the expression is the one the SOURCE wrote.
// A fold invents an expression, so it checks: mwcc evaluates `%`'s RIGHT operand first (compiled in
// both directions), so an inlined `A % B` runs B's def first and the fold preserves the machine's
// order only when B's def already precedes A's.
const HWMOD_SEQ = HWMOD_PATTERNS[0];
const twoCalls = (first: string, second: string, dividend: string, divisor: string, between = '') =>
  parse(
    `fn f {\n^bb0():\n  %0: s32 = call {target="${first}"}\n${between}  %1: s32 = call {target="${second}"}\n` +
      `  %2: s32 = sdiv ${dividend}, ${divisor}\n  %3: s32 = mul %2, ${divisor}\n` +
      `  %4: s32 = sub ${dividend}, %3\n  ret %4\n}\n`,
  );

test('unsequencedRightFirst refuses the fold that would swap two calls', () => {
  // `f()` then `g()` on the machine, folded to `f() % g()` — which mwcc runs as `g()` then `f()`.
  expect(applyPattern(twoCalls('f', 'g', '%0', '%1'), HWMOD_SEQ)).toBe(0);
});

test('unsequencedRightFirst admits the fold when the RIGHT operand`s def already runs first', () => {
  // `f()` then `g()`, folded to `g() % f()` — mwcc runs `f()` then `g()`, the machine's own order.
  expect(applyPattern(twoCalls('f', 'g', '%1', '%0'), HWMOD_SEQ)).toBe(1);
});

test('unsequencedRightFirst admits the fold when a sibling effect stands between the two', () => {
  // The store is a barrier the inline-at-use model refuses to cross, so `f()`'s result gets a named
  // temp at its own position and the order is pinned there rather than left to the expression.
  const between = '  %9: s32 = const {value=0}\n  store %9, %9 {off=0, width=4}\n';
  expect(applyPattern(twoCalls('f', 'g', '%0', '%1', between), HWMOD_SEQ)).toBe(1);
});

// The operand the fold names is not the only thing that moves with it: the structurer inlines
// through pure single-use ops, so the whole inlinable CONE lands at that operand position. These
// four pin the two ways the shallow reading of the question was wrong — one pure op between the
// effect and the operand, and a memory read weighed against a call.
const coneFn = (body: string, dividend: string, divisor: string) =>
  parse(
    `fn f {\n^bb0(%8: s32, %7: s32):\n${body}` +
      `  %2: s32 = sdiv ${dividend}, ${divisor}\n  %3: s32 = mul %2, ${divisor}\n` +
      `  %4: s32 = sub ${dividend}, %3\n  ret %4\n}\n`,
  );

test('unsequencedRightFirst refuses when a PURE op stands between the effect and the operand', () => {
  // `(f() + 1) % g()` reorders exactly as `f() % g()` does — the `add` is inlined, not a barrier.
  const body =
    '  %0: s32 = call {target="f"}\n  %6: s32 = const {value=1}\n' +
    '  %5: s32 = add %0, %6\n  %1: s32 = call {target="g"}\n';
  expect(applyPattern(coneFn(body, '%5', '%1'), HWMOD_SEQ)).toBe(0);
});

test('unsequencedRightFirst admits when the cone stops at a MULTI-USE value', () => {
  // A second use names `f()`'s result, so it is a statement at its own position and the order is
  // pinned there; only the pure `add` is left inside the invented expression.
  const body =
    '  %0: s32 = call {target="f"}\n  %6: s32 = const {value=1}\n  %5: s32 = add %0, %6\n' +
    '  %1: s32 = call {target="g"}\n  store %8, %0 {off=0, width=4}\n';
  expect(applyPattern(coneFn(body, '%5', '%1'), HWMOD_SEQ)).toBe(1);
});

test('unsequencedRightFirst refuses hoisting a memory READ over a call', () => {
  // The read answers whichever stores ran before it, and the call may be the one that writes.
  const body = '  %0: s32 = load %8 {off=0, signed=true, width=4}\n  %1: s32 = call {target="g"}\n';
  expect(applyPattern(coneFn(body, '%0', '%1'), HWMOD_SEQ)).toBe(0);
});

test('unsequencedRightFirst admits two READS, which commute', () => {
  const body =
    '  %0: s32 = load %8 {off=0, signed=true, width=4}\n' + '  %1: s32 = load %7 {off=0, signed=true, width=4}\n';
  expect(applyPattern(coneFn(body, '%0', '%1'), HWMOD_SEQ)).toBe(1);
});

test('unsequencedRightFirst admits the fold when at most ONE operand has an effect', () => {
  const oneCall = parse(
    'fn f {\n^bb0(%1: s32):\n  %0: s32 = call {target="f"}\n' +
      '  %2: s32 = sdiv %0, %1\n  %3: s32 = mul %2, %1\n  %4: s32 = sub %0, %3\n  ret %4\n}\n',
  );
  expect(applyPattern(oneCall, HWMOD_SEQ)).toBe(1);
});

// ── malformed pattern DATA fails loud, with the pattern's id ──────────────────────────────────
// Patterns are meant to become generated data, so a declaration that could not have an effect is a
// bug to report rather than to ignore. `ordered` is read only inside the commutative-swap branch.
test('`ordered` on a node where it could not fire throws, naming the pattern', () => {
  const inert: RewritePattern = {
    id: 'test/inert-ordered',
    applies: {},
    match: { op: 'sub', ordered: true, args: [{ bind: 'X' }, { bind: 'Y' }] },
    replaceWith: { op: 'add', args: ['X', 'Y'] },
  };
  expect(() => applyPattern(parse(NEG_FIRST), inert)).toThrow(/test\/inert-ordered.*'sub'/);
});

test('`unsequencedRightFirst` naming a non-replaceWith operand throws, naming the pattern', () => {
  const bogus: RewritePattern = { ...HWMOD_SEQ, id: 'test/bogus-seq', unsequencedRightFirst: ['A', 'Z'] };
  expect(() => applyPattern(parse(MOD_BEFORE), bogus)).toThrow(/test\/bogus-seq.*'Z'/);
});

// The operand DIRECTION the field asserts was measured on one compiler, so a pattern that widens
// its compiler gate would be inheriting an unmeasured fact silently. Make it loud instead.
test('`unsequencedRightFirst` on a compiler the direction was not measured for throws', () => {
  const widened: RewritePattern = {
    ...HWMOD_SEQ,
    id: 'test/widened-seq',
    applies: { ...HWMOD_SEQ.applies, compilers: ['mwcc', 'gcc'] },
  };
  expect(() => applyPattern(parse(MOD_BEFORE), widened)).toThrow(/test\/widened-seq.*mwcc, gcc/);
});
