// asmlift — the idiom layer: rewrite patterns AS DATA + a generic greedy driver.
// A pattern is a serializable object (match-DAG over the SSA def-graph → replacement);
// a single generic interpreter applies any of them, so a PDL-style data format and
// AI-generation are an incremental step, not a rewrite.
//
// Crucially, rewrites go through replaceAllUsesWith + DCE — never in-place opcode
// mutation of a live value.
import { Fn, Op, Value, defOpMap, mkOp, mkValue, replaceAllUsesWith } from '../ir/core';
import { type Opcode, isDceSafe } from '../ir/opcodes';
import type { IrType } from '../ir/types';
import { T } from '../ir/types';

export type MatchNode =
  | { op: string; attrEquals?: Record<string, number>; bindImm?: Record<string, string>; args: MatchNode[] }
  | { bind: string } // bind this operand's VALUE to a name
  | { same: string } // this operand must equal a previously-bound value
  | { constImm: string }; // this operand must be a `const`; bind its numeric VALUE to an imm name

// A tiny declarative arithmetic over bound immediate names. It keeps a *computed* replacement
// attribute DATA rather than a JS closure, so a strength-reduced idiom whose replacement is a
// FUNCTION of the matched immediates — `x*(2^k+1)` from a bound shift `k`, `x*(c·2^k)` from a bound
// multiplier `c` and shift `k` — stays serializable/AI-generable like every other pattern.
// `pow2(e)` = 2**e.
export type ImmExpr =
  number | { imm: string } | { op: '+' | '-' | '*'; args: [ImmExpr, ImmExpr] } | { op: 'pow2'; args: [ImmExpr] };

function evalImm(e: ImmExpr, imms: Map<string, number>): number {
  if (typeof e === 'number') {
    return e;
  }
  if ('imm' in e) {
    const v = imms.get(e.imm);
    if (v === undefined) {
      throw new Error(`pattern references unbound immediate '${e.imm}'`);
    }
    return v;
  }
  const a = e.args.map((x) => evalImm(x, imms));
  switch (e.op) {
    case '+':
      return a[0] + a[1];
    case '-':
      return a[0] - a[1];
    case '*':
      return a[0] * a[1];
    case 'pow2':
      return 2 ** a[0];
  }
}

// A replacement operand is either a previously-BOUND value (by name) or a SYNTHESIZED constant
// computed from the bound immediates (e.g. the derived multiplier `2^k+1`). A synthesized const
// is materialized as its own `const` op spliced in before the rewrite site.
export type ReplaceArg = string | { constImm: ImmExpr };

export interface RewritePattern {
  id: string;
  // `applies` is DATA, consumed generically by patternApplies — NOT an `arch ==` branch.
  // `isa` pins the ISA; `compilers` pins which COMPILERS emit this idiom (the same shift-sequence
  // for `/2` is produced by agbcc AND gcc, so a compiler LIST, not a single arch, is the honest
  // predicate); `capabilities` is a hardware predicate. An absent axis means "don't constrain on it".
  applies: { isa?: string; compilers?: string[]; capabilities?: Partial<{ hwDivide: boolean; hwFloat: boolean }> };
  match: MatchNode; // rooted at the op result to replace
  // NOTE: a RELATIONAL guard (a `where` clause constraining the bound immediates, e.g. "two shift
  // amounts sum to 32") is deliberately NOT built — the one candidate, magic-number division, needs
  // a computed divisor proof and lives as the bespoke raise/magicdiv.ts pass instead. The
  // COMPUTED-attr half of the envelope (ImmExpr, above) IS built — earned by the
  // multiply-by-constant idioms.
  replaceWith: { op: string; args: ReplaceArg[]; attrs?: Record<string, number | ImmExpr>; resultType?: IrType };
}

/** Does this pattern apply to `target`? Every DECLARED axis must match: the ISA (so an idiom can be
 *  pinned to one frontend), the compiler set (so an idiom fires only for the compilers that emit
 *  it — the reason MIPS+IDO and MIPS+GCC are distinguishable despite one frontend), and every
 *  declared capability. An omitted axis is unconstrained. */
export function patternApplies(
  p: RewritePattern,
  target: { id: string; compiler: string; capabilities: { hwDivide: boolean; hwFloat: boolean } },
): boolean {
  if (p.applies.isa && p.applies.isa !== target.id) {
    return false;
  }
  if (p.applies.compilers && !p.applies.compilers.includes(target.compiler)) {
    return false;
  }
  const req = p.applies.capabilities;
  if (!req) {
    return true;
  }
  return Object.entries(req).every(([k, v]) => target.capabilities[k as keyof typeof target.capabilities] === v);
}

// mwcc's `x == 0` / `!x` spelling, as pure data: `cntlzw rD,rS; srwi rD,rD,5` — clz(x) is 32
// exactly when x == 0, so `clz(x) >> 5` IS the boolean. Folding to `icmp_eq(x, 0)` gives
// recovery/structuring the comparison it actually is, and re-emitting `x == 0` reproduces the
// cntlzw+srwi pair under mwcc (byte-exact — the iszero/notb benchmark rows). Without the fold,
// the transient `clz` survives to the structurer and gaps loud (see ir/opcodes.ts).
export const CNTLZW_EQ0: RewritePattern = {
  id: 'cntlzw-eq0',
  applies: { compilers: ['mwcc'] },
  match: {
    op: 'shr_u',
    attrEquals: { imm: 5 },
    args: [{ op: 'clz', args: [{ bind: 'X' }] }],
  },
  replaceWith: { op: 'icmp_eq', args: ['X', { constImm: 0 }], resultType: T.u(32) },
};

// The PPC rotate mirror, as pure data: hardware only rotates LEFT, so mwcc spells `rotr(x, n)`
// as `rotlw(x, 32 - n)`. Lowering that literally emits `x << (32 - n) | x >> (32 - (32 - n))`,
// whose inner subtraction recompiles to an extra instruction; folding to `rotr(x, n)` lets the
// structurer spell the clean right-rotate idiom. mwcc-gated: a thumb `ror` whose amount happens
// to be a source-level `32 - n` must NOT be respelled (that round-trip is unverified on agbcc).
export const ROTL_MIRROR: RewritePattern = {
  id: 'rotl-mirror',
  applies: { compilers: ['mwcc'] },
  match: {
    op: 'rotl',
    args: [{ bind: 'X' }, { op: 'sub', args: [{ op: 'const', attrEquals: { value: 32 }, args: [] }, { bind: 'M' }] }],
  },
  replaceWith: { op: 'rotr', args: ['X', 'M'] },
};

// Signed-division-by-2 idiom, as pure data:  shr_s( add( X, shr_u(X, 31) ), 1 )  ==  X / 2.
// The lifted IR shape is ISA-NEUTRAL (shr_u/add/shr_s), and BOTH agbcc (ARMv4T) and KMC GCC
// (MIPS) strength-reduce signed `/2` to exactly it — even KMC despite the N64 having hardware
// divide (shifting is cheaper than `div` for a power of two). So the predicate is the COMPILER,
// not a hardware capability: gate by `compilers`, and re-emitting `x / 2` reproduces the sequence.
export const SDIV_POW2_2: RewritePattern = {
  id: 'sdiv-pow2/2',
  applies: { compilers: ['agbcc', 'gcc'] },
  match: {
    op: 'shr_s',
    attrEquals: { imm: 1 },
    args: [
      {
        op: 'add',
        args: [{ bind: 'X' }, { op: 'shr_u', attrEquals: { imm: 31 }, args: [{ same: 'X' }] }],
      },
    ],
  },
  replaceWith: { op: 'sdiv', args: ['X'], attrs: { imm: 2 }, resultType: T.s() },
};

// ── multiply-by-constant idioms (DIVMUL) ────────────────────────────────────────────────
// A compiler strength-reduces `x * C` for a small constant C into shifts + one add/sub, because a
// shift-add chain is cheaper than a general multiply. The reduction is COMPILER-driven and shared
// across every target measured (agbcc/ARM, IDO/MIPS, GCC/MIPS all emit `lsl;add` / `sll;addu` for
// `x*5`), so — like the /2 idiom — the honest predicate is the compiler LIST, not the ISA. The
// replacement multiplier is a FUNCTION of the bound shift amount (ImmExpr), not a literal.
// Re-emitting `x * C` lets the compiler regenerate the exact shift chain byte-for-byte.
const MUL_COMPILERS = ['agbcc', 'ido', 'gcc'];

// x * (2^k + 1)  ==  (x << k) + x     (`lsl rD,x,#k; add rD,rD,x`)
export const MUL_SHIFT_ADD: RewritePattern = {
  id: 'mul-shift-add',
  applies: { compilers: MUL_COMPILERS },
  match: {
    op: 'add',
    args: [{ op: 'shl', bindImm: { imm: 'k' }, args: [{ bind: 'X' }] }, { same: 'X' }],
  },
  replaceWith: { op: 'mul', args: ['X', { constImm: { op: '+', args: [{ op: 'pow2', args: [{ imm: 'k' }] }, 1] } }] },
};

// x * (2^k - 1)  ==  (x << k) - x     (`lsl rD,x,#k; sub rD,rD,x`)  — sub is non-commutative.
export const MUL_SHIFT_SUB: RewritePattern = {
  id: 'mul-shift-sub',
  applies: { compilers: MUL_COMPILERS },
  match: {
    op: 'sub',
    args: [{ op: 'shl', bindImm: { imm: 'k' }, args: [{ bind: 'X' }] }, { same: 'X' }],
  },
  replaceWith: { op: 'mul', args: ['X', { constImm: { op: '-', args: [{ op: 'pow2', args: [{ imm: 'k' }] }, 1] } }] },
};

// x * (c · 2^k)  ==  (x * c) << k — the composite tail a compiler appends when the constant is not
// itself 2^k±1 (`x*6` = `(x*3)<<1`, `x*12` = `(x*3)<<2`). Runs AFTER the two base multiplies fold
// the inner `x*c`; binds the inner multiplier `c` off its `const` operand and the outer shift `k`,
// and folds to a single `x * (c·2^k)`. This is the operand-const bind + computed-attr combination.
export const MUL_SHIFT_SCALE: RewritePattern = {
  id: 'mul-shift-scale',
  applies: { compilers: MUL_COMPILERS },
  match: {
    op: 'shl',
    bindImm: { imm: 'k' },
    args: [{ op: 'mul', args: [{ bind: 'X' }, { constImm: 'c' }] }],
  },
  replaceWith: {
    op: 'mul',
    args: ['X', { constImm: { op: '*', args: [{ imm: 'c' }, { op: 'pow2', args: [{ imm: 'k' }] }] } }],
  },
};

/** The multiply-by-constant idiom bundle (ordered: the two base folds before the composite tail). */
export const MUL_CONST_PATTERNS: RewritePattern[] = [MUL_SHIFT_ADD, MUL_SHIFT_SUB, MUL_SHIFT_SCALE];

// ── byte/half extension idioms ───────────────────────────────────────────────────────────────
// A compiler with no dedicated byte/half move lowers a narrowing cast `(u8)x` / `(s8)x` (and 16-bit)
// to a shift PAIR `(x << (32-w)) >> (32-w)`: LOGICAL `shr_u` for unsigned (zero-extend), ARITHMETIC
// `shr_s` for signed (sign-extend). agbcc (ARMv4T, no byte move) emits exactly this (`lsl #24;
// lsr/asr #24`). The naive lift prints `x << 24 >> 24` — but C's `>>` over the s32-typed value is
// ARITHMETIC, so the UNSIGNED case recompiles with `asr` where the target has `lsr`: a miscompile
// (tou8/zextb/tou16 nonmatch). Folding to a cast op both fixes that and reads correctly; recompiling
// `(u8)x` reproduces `lsl;lsr`. Gated to agbcc: on IDO/GCC the zero-extend is `andi`/`and` (not a
// shift pair) and `(u8)x` lowers to `andi` there — so this shift-pair shape is agbcc's alone, and the
// fold must not touch the other compilers (where it would change `srl`↔`andi`). `k = 32 - w`.
const zextPat = (w: number, k: number): RewritePattern => ({
  id: `zext${w}`,
  applies: { compilers: ['agbcc'] },
  match: { op: 'shr_u', attrEquals: { imm: k }, args: [{ op: 'shl', attrEquals: { imm: k }, args: [{ bind: 'X' }] }] },
  replaceWith: { op: 'zext', args: ['X'], attrs: { width: w } },
});
const sextPat = (w: number, k: number): RewritePattern => ({
  id: `sext${w}`,
  applies: { compilers: ['agbcc'] },
  match: { op: 'shr_s', attrEquals: { imm: k }, args: [{ op: 'shl', attrEquals: { imm: k }, args: [{ bind: 'X' }] }] },
  replaceWith: { op: 'sext', args: ['X'], attrs: { width: w } },
});

/** Byte/half zero- and sign-extension casts. Byte = shift by 24, half = shift by 16. The
 *  zero-extend forms fix a miscompile; the sign-extend forms already byte-matched as raw shifts and
 *  fold here for readability + `(s8)`/`(s16)` parity, staying byte-exact (`(s8)x` → `lsl;asr`). */
export const CAST_PATTERNS: RewritePattern[] = [zextPat(8, 24), zextPat(16, 16), sextPat(8, 24), sextPat(16, 16)];

// The DEFAULT idiom bundle `decompile()` applies when the caller passes no `patterns`. It is
// EVERY idiom asmlift owns; each is `{compilers}`-gated (patternApplies), so this one global list
// self-selects per target — agbcc/gcc get sdiv-pow2, agbcc/ido/gcc get the mul-const folds, and a
// target whose compiler matches none (mwcc) applies nothing. Ordered like the sub-bundles: the
// division idiom, then the multiplies (base folds before the composite tail). Passing an explicit
// `patterns` (including `[]`) overrides this — `[]` runs the naive lift with no idiom folding.
export const DEFAULT_IDIOM_PATTERNS: RewritePattern[] = [
  SDIV_POW2_2,
  CNTLZW_EQ0,
  ROTL_MIRROR,
  ...MUL_CONST_PATTERNS,
  ...CAST_PATTERNS,
];

// Ops whose operands a compiler may emit in either order — so an idiom's match must try both
// (agbcc emits `add(X, shr_u(X,31))`; KMC GCC emits `add(shr_u(X,31), X)` for the SAME `x/2`).
const COMMUTATIVE = new Set(['add', 'mul', 'and', 'or', 'xor']);

interface Binds {
  values: Map<string, Value>;
  imms: Map<string, number>;
}

function tryMatch(node: MatchNode, v: Value, defs: Map<Value, Op>, b: Binds): boolean {
  if ('bind' in node) {
    b.values.set(node.bind, v);
    return true;
  }
  if ('same' in node) {
    return b.values.get(node.same) === v;
  }
  if ('constImm' in node) {
    const d = defs.get(v);
    if (!d || d.opcode !== 'const') {
      return false;
    }
    b.imms.set(node.constImm, d.attrs.value as number);
    return true;
  }
  const d = defs.get(v);
  if (!d || d.opcode !== node.op) {
    return false;
  }
  if (node.attrEquals) {
    for (const [k, val] of Object.entries(node.attrEquals)) {
      if (d.attrs[k] !== val) {
        return false;
      }
    }
  }
  // Bind selected immediate attributes of this op (e.g. a shift amount) for use in a computed
  // replacement. Absent attrs fail the match rather than binding `undefined`.
  if (node.bindImm) {
    for (const [attr, name] of Object.entries(node.bindImm)) {
      const val = d.attrs[attr];
      if (typeof val !== 'number') {
        return false;
      }
      b.imms.set(name, val);
    }
  }
  if (d.operands.length !== node.args.length) {
    return false;
  }
  // A commutative binary op matches its two args in EITHER order. Each order is tried on a cloned
  // bind map so a partial (then-failed) match can't leak bindings; the first full match commits.
  if (COMMUTATIVE.has(d.opcode) && node.args.length === 2) {
    for (const [i, j] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const trial: Binds = { values: new Map(b.values), imms: new Map(b.imms) };
      if (tryMatch(node.args[0], d.operands[i], defs, trial) && tryMatch(node.args[1], d.operands[j], defs, trial)) {
        for (const [k, val] of trial.values) {
          b.values.set(k, val);
        }
        for (const [k, val] of trial.imms) {
          b.imms.set(k, val);
        }
        return true;
      }
    }
    return false;
  }
  return node.args.every((a, i) => tryMatch(a, d.operands[i], defs, b));
}

/** Apply one pattern greedily to a fixed point. Returns the number of rewrites. */
export function applyPattern(fn: Fn, pat: RewritePattern): number {
  let count = 0,
    changed = true;
  while (changed) {
    changed = false;
    const defs = defOpMap(fn);
    scan: for (const b of fn.blocks) {
      for (let i = 0; i < b.ops.length; i++) {
        const op = b.ops[i];
        if (op.results.length !== 1) {
          continue;
        }
        const binds: Binds = { values: new Map(), imms: new Map() };
        if (!tryMatch(pat.match, op.results[0], defs, binds)) {
          continue;
        }
        // Materialize any synthesized-constant replacement operands as their own `const` ops,
        // spliced in before the rewrite; bound-value operands resolve from the value binds.
        const rw = pat.replaceWith;
        const newRes = mkValue(rw.resultType ?? op.results[0].type);
        const consts: Op[] = [];
        const operands: Value[] = rw.args.map((a) => {
          if (typeof a === 'string') {
            // Attribute a malformed pattern HERE with its id — an unbound value would otherwise
            // become `undefined` and detonate stages later; patterns are meant to become
            // AI-generated data, so diagnosability is first-class.
            const bound = binds.values.get(a);
            if (!bound) {
              throw new Error(`pattern '${pat.id}' replaceWith references unbound value '${a}'`);
            }
            return bound;
          }
          const cv = mkValue(T.s());
          consts.push(mkOp('const', { results: [cv], attrs: { value: evalImm(a.constImm, binds.imms) } }));
          return cv;
        });
        const attrs: Record<string, number> = {};
        for (const [k, v] of Object.entries(rw.attrs ?? {})) {
          attrs[k] = typeof v === 'number' ? v : evalImm(v, binds.imms);
        }
        const newOp = mkOp(rw.op as Opcode, { operands, results: [newRes], attrs }); // pattern data boundary: verify() rejects unknowns
        b.ops.splice(i, 1, ...consts, newOp);
        replaceAllUsesWith(fn, op.results[0], newRes);
        count++;
        changed = true;
        break scan;
      }
    }
  }
  return count;
}

/** Remove effect-free ops whose single result is unused, to a fixed point. Deletability is
 *  derived from the ONE effect table in ir/opcodes.ts. */
export function dce(fn: Fn): void {
  let changed = true;
  while (changed) {
    changed = false;
    const used = new Set<Value>();
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        for (const o of op.operands) {
          used.add(o);
        }
        for (const s of op.successors) {
          for (const a of s.args) {
            used.add(a);
          }
        }
      }
    }
    for (const b of fn.blocks) {
      const kept = b.ops.filter((op) => !(isDceSafe(op.opcode) && op.results.length === 1 && !used.has(op.results[0])));
      if (kept.length !== b.ops.length) {
        b.ops = kept;
        changed = true;
      }
    }
  }
}
