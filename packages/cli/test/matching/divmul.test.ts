// DIVMUL — general division + multiply-by-constant idioms, and the IDIOM-ENVELOPE widening they
// force. Three layers, offline → toolchain:
//
//  1. Golden pattern folds (parse IR → apply → print) — the per-pattern unit tests, AI-addable.
//  2. The widening mechanism itself — bound immediates, a COMPUTED replacement attribute, and a
//     bound const-operand value — each exercised in isolation so a regression in the pattern
//     interpreter fails here, not only in a downstream byte-diff.
//  3. IDO byte-exact fixtures — multiply-by-constant AND real hardware division/remainder
//     (`div`/`divu` + `mflo`/`mfhi`), the inhabitant that finally consumes `capabilities.hwDivide`.
import { mipsFrontend } from '@asmlift/core/frontend/mips';
import { mkOp, mkValue } from '@asmlift/core/ir/core';
import { parse } from '@asmlift/core/ir/parse';
import { print } from '@asmlift/core/ir/print';
import { T } from '@asmlift/core/ir/types';
import { verify } from '@asmlift/core/ir/verify';
import {
  MUL_CONST_PATTERNS,
  MUL_SHIFT_ADD,
  MUL_SHIFT_SUB,
  type RewritePattern,
  applyPattern,
  dce,
  patternApplies,
} from '@asmlift/core/pattern/engine';
import { decompile } from '@asmlift/core/pipeline';
import { MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget, scoreCMips } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const fold = (ir: string, pats: RewritePattern[]) => {
  const fn = parse(ir);
  let hits = 0;
  for (const p of pats) {
    hits += applyPattern(fn, p);
  }
  dce(fn);
  verify(fn);
  return { hits, ir: print(fn) };
};

// ── 1. golden pattern folds ─────────────────────────────────────────────────────────────
describe('DIVMUL golden folds: shift-chain → x * C', () => {
  test('mul-shift-add: (x<<1)+x → x*3  [2^k+1 computed multiplier]', () => {
    const { hits, ir } = fold(
      'fn f {\n^bb0(%0: s32):\n  %1: s32 = shl %0 {imm=1}\n  %2: s32 = add %1, %0\n  ret %2\n}\n',
      [MUL_SHIFT_ADD],
    );
    expect(hits).toBe(1);
    expect(ir).toBe('fn f {\n^bb0(%0: s32):\n  %1: s32 = const {value=3}\n  %2: s32 = mul %0, %1\n  ret %2\n}\n');
  });

  test('mul-shift-add is commutativity-aware: x+(x<<2) (gcc operand order) → x*5', () => {
    const { hits, ir } = fold(
      'fn f {\n^bb0(%0: s32):\n  %1: s32 = shl %0 {imm=2}\n  %2: s32 = add %0, %1\n  ret %2\n}\n',
      [MUL_SHIFT_ADD],
    );
    expect(hits).toBe(1);
    expect(ir).toContain('const {value=5}');
  });

  test('mul-shift-sub: (x<<3)-x → x*7  [2^k-1, non-commutative order preserved]', () => {
    const { hits, ir } = fold(
      'fn f {\n^bb0(%0: s32):\n  %1: s32 = shl %0 {imm=3}\n  %2: s32 = sub %1, %0\n  ret %2\n}\n',
      [MUL_SHIFT_SUB],
    );
    expect(hits).toBe(1);
    expect(ir).toContain('const {value=7}');
  });

  test('mul-shift-scale: (x*3)<<1 → x*6  [composite c·2^k, binds the const operand]', () => {
    const { hits, ir } = fold(
      'fn f {\n^bb0(%0: s32):\n  %1: s32 = shl %0 {imm=2}\n  %2: s32 = sub %1, %0\n  %3: s32 = shl %2 {imm=1}\n  ret %3\n}\n',
      MUL_CONST_PATTERNS,
    );
    expect(hits).toBe(2); // inner sub→*3, then scale→*6
    expect(ir).toBe('fn f {\n^bb0(%0: s32):\n  %1: s32 = const {value=6}\n  %2: s32 = mul %0, %1\n  ret %2\n}\n');
  });
});

// ── 2. the widening mechanism, in isolation ─────────────────────────────────────────────
describe('IDIOM-ENVELOPE widening mechanism', () => {
  // mul-shift-sub must NOT fire when the subtrahend is a DIFFERENT value (`(x<<3) - y`): the `same`
  // constraint distinguishes `x*7` from an unrelated subtraction. Guards a false-positive fold.
  test('negative: (x<<3) - y does not fold (the `same` operand constraint holds)', () => {
    const { hits } = fold(
      'fn f {\n^bb0(%0: s32, %1: s32):\n  %2: s32 = shl %0 {imm=3}\n  %3: s32 = sub %2, %1\n  ret %3\n}\n',
      [MUL_SHIFT_SUB],
    );
    expect(hits).toBe(0);
  });

  // A bound immediate that is absent fails the match rather than binding `undefined` — a register
  // (2-operand) shift carries no `imm` attr, so mul-shift-add cannot fire over it.
  test('negative: a register-amount shift (no `imm` attr) is not matched by bindImm', () => {
    const { hits } = fold(
      'fn f {\n^bb0(%0: s32, %1: s32):\n  %2: s32 = shl %0, %1\n  %3: s32 = add %2, %0\n  ret %3\n}\n',
      [MUL_SHIFT_ADD],
    );
    expect(hits).toBe(0);
  });

  // A synthetic pattern exercising bindImm on TWO ops + a computed multiplier that sums two powers
  // of two: `(x<<a)+(x<<b)` → `x*(2^a+2^b)`. Pins that multiple bound immediates flow into one
  // ImmExpr correctly (the computed-attr half of the envelope; a relational `where` guard is
  // deliberately not built — magic-number division lives as the bespoke raise/magicdiv.ts pass
  // instead; see engine.ts).
  const TWO_SHIFT: RewritePattern = {
    id: 'two-shift-probe',
    applies: {},
    match: {
      op: 'add',
      args: [
        { op: 'shl', bindImm: { imm: 'a' }, args: [{ bind: 'X' }] },
        { op: 'shl', bindImm: { imm: 'b' }, args: [{ same: 'X' }] },
      ],
    },
    replaceWith: {
      op: 'mul',
      args: [
        'X',
        {
          constImm: {
            op: '+',
            args: [
              { op: 'pow2', args: [{ imm: 'a' }] },
              { op: 'pow2', args: [{ imm: 'b' }] },
            ],
          },
        },
      ],
    },
  };
  test('two bound immediates flow into one computed multiplier: (x<<1)+(x<<2) → x*6', () => {
    const { hits, ir } = fold(
      'fn f {\n^bb0(%0: s32):\n  %1: s32 = shl %0 {imm=1}\n  %2: s32 = shl %0 {imm=2}\n  %3: s32 = add %1, %2\n  ret %3\n}\n',
      [TWO_SHIFT],
    );
    expect(hits).toBe(1);
    expect(ir).toContain('const {value=6}'); // 2^1 + 2^2
  });
});

// The hwDivide capability is genuinely load-bearing (not dormant scaffolding): a `div` decoded
// against a target that declares NO hardware divider degrades to a loud `opaque` and the boundary
// contract fires, rather than silently modelling a divide the hardware cannot do. This exercises
// the gate's false branch — the real consumer that earns `capabilities.hwDivide`.
test('hwDivide gate: a hardware `div` on a no-hw-divide target fails LOUD (opaque), not silent', () => {
  const { asm } = compileMipsTarget('int div3(int a){ return a / 3; }', 'div3');
  const noHwDiv = { ...MIPS_IDO, capabilities: { ...MIPS_IDO.capabilities, hwDivide: false } };
  const raw = print(mipsFrontend.lift('div3', asm, noHwDiv, {})); // the lift succeeds…
  expect(raw).toContain('opaque'); // …but the divide is an honest opaque…
  expect(raw).not.toContain('sdiv');
  expect(() => decompile('div3', asm, noHwDiv)).toThrow(); // …and reaching output trips assertResolved.
});

// `sdiv` was widened to variadic (to carry BOTH the 1-operand+imm fold form and the 2-operand
// hardware form), so the generic arity check can't guard it. The verifier enforces its real
// invariant explicitly — a malformed sdiv fails at its source, not as `/ undefined` downstream.
describe('sdiv variadic invariant (verifier)', () => {
  // Entry block carries the dividend `x` as a param (so operands are defined); the sdiv result is
  // returned. Only the sdiv shape varies.
  const fnWith = (
    operands: ReturnType<typeof mkValue>[],
    attrs: Record<string, number>,
    x: ReturnType<typeof mkValue>,
  ) => {
    const r = mkValue(T.s());
    return {
      name: 'f',
      blocks: [{ params: [x], ops: [mkOp('sdiv', { operands, results: [r], attrs }), mkOp('ret', { operands: [r] })] }],
    };
  };
  test('1 operand WITH imm is valid', () => {
    const x = mkValue(T.s());
    expect(() => verify(fnWith([x], { imm: 2 }, x))).not.toThrow();
  });
  test('1 operand WITHOUT imm fails loud', () => {
    const x = mkValue(T.s());
    expect(() => verify(fnWith([x], {}, x))).toThrow(/sdiv/);
  });
  test('0 operands fails loud', () => {
    const x = mkValue(T.s());
    expect(() => verify(fnWith([], {}, x))).toThrow(/sdiv/);
  });
});

// ── 3. gating (the compiler is the spec) ────────────────────────────────────────────────
test('multiply-by-constant fires for agbcc/ido/gcc (a shared compiler idiom), not others', () => {
  const caps = { hwDivide: false, hwFloat: false };
  for (const p of MUL_CONST_PATTERNS) {
    expect(patternApplies(p, { id: 'armv4t', compiler: 'agbcc', capabilities: caps })).toBe(true);
    expect(patternApplies(p, { id: 'mips', compiler: 'ido', capabilities: { hwDivide: true, hwFloat: true } })).toBe(
      true,
    );
    expect(patternApplies(p, { id: 'ppc', compiler: 'mwcc', capabilities: { hwDivide: false, hwFloat: true } })).toBe(
      false,
    );
  }
});

// ── 4. IDO byte-exact fixtures — multiply AND hardware divide (earns hwDivide) ───────────
// The division rows are the first inhabitant of `capabilities.hwDivide`: MIPS `div`/`divu` +
// `mflo`/`mfhi` model straight-line hardware quotient/remainder with a constant divisor (the -O2
// form with no div-by-zero guard block). Re-emitting `a / C` / `a % C` regenerates the exact
// `div;mflo` / `div;mfhi` sequence, byte-for-byte, including the signed-vs-`divu` distinction.
const IDO_CASES: { sym: string; c: string; patterns?: RewritePattern[]; expect: string }[] = [
  {
    sym: 'mul5',
    c: 'int mul5(int a){ return a * 5; }',
    patterns: MUL_CONST_PATTERNS,
    expect: 's32 mul5(s32 a0) {\n    return a0 * 5;\n}\n',
  },
  {
    sym: 'mul7',
    c: 'int mul7(int a){ return a * 7; }',
    patterns: MUL_CONST_PATTERNS,
    expect: 's32 mul7(s32 a0) {\n    return a0 * 7;\n}\n',
  },
  { sym: 'div3', c: 'int div3(int a){ return a / 3; }', expect: 's32 div3(s32 a0) {\n    return a0 / 3;\n}\n' },
  { sym: 'div7', c: 'int div7(int a){ return a / 7; }', expect: 's32 div7(s32 a0) {\n    return a0 / 7;\n}\n' },
  {
    sym: 'udiv3',
    c: 'unsigned udiv3(unsigned a){ return a / 3; }',
    expect: 'u32 udiv3(u32 a0) {\n    return a0 / 3;\n}\n',
  }, // `divu` → recovered u32 operands
  { sym: 'smod3', c: 'int smod3(int a){ return a % 3; }', expect: 's32 smod3(s32 a0) {\n    return a0 % 3;\n}\n' }, // remainder via `mfhi`
];

describe('DIVMUL — IDO byte-exact: compile → disasm → decompile → recompile → objdiff', () => {
  for (const { sym, c, patterns, expect: golden } of IDO_CASES) {
    test(`${sym}`, () => {
      const { obj, asm } = compileMipsTarget(c, sym);
      const r = decompile(sym, asm, MIPS_IDO, { patterns });
      expect(r.source).toBe(golden);
      const s = scoreCMips(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});
