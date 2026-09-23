// asmlift IR — the verifier. Runs after every pass; a bad edit fails HERE, at its source,
// not three stages later as wrong output. Invariants:
//   1. every block ends in exactly one terminator (and it is the last op)
//   2. operands well-formed: opcode registered, correct arity/attrs
//   3. SSA: each value defined once; every use is defined; def dominates use
//   4. side data: a fn that carries a write-order record carries one for EVERY block, with every
//      ordinal inside that block's own write count (ir/core.ts `WriteOrder`)
import { Block, Fn, Op, Value, dominators } from './core';
import { WIDE_BITS, opSig } from './opcodes';
import { type IrType, intWidth } from './types';

export class VerifyError extends Error {}

// Opcodes admitting EITHER a 2-operand register form OR a 1-operand + `imm` attr form.
const TWO_OR_IMM = new Set(['sdiv', 'shl', 'shr_u', 'shr_s']);

// ── 64 DOES NOT MIX ────────────────────────────────────────────────────────────────────────────
// A 64-bit value is one `Value` whose type carries width 64 (ir/opcodes.ts, `concat`), so every
// pass that reads `t.width` and is wrong about it is wrong HERE rather than three stages later. The
// rule below is a QUARANTINE and not full width agreement, and the difference is measured rather
// than stylistic: full agreement is already false on 32-bit IR, because `raise/paramwidth.ts`
// narrows a parameter to 8 or 16 bits and `add(p_u8, x_s32)` is an ordinary correct shape. What
// must hold is that a 64-bit operand never meets a 32-bit one in an op that computes on both.
//
// `unknown` PARTICIPATES, and that is the whole point: at L1 every value is `unknown`, so a rule
// that skipped it would be vacuous exactly where this is meant to be red. The shifts count only
// their SHIFTED operand — a 64-bit shift by a 32-bit count is what the machine does.
const WIDTH_UNIFORM = new Set(['add', 'sub', 'mul', 'and', 'or', 'xor', 'neg', 'not', 'sdiv', 'udiv', 'smod', 'umod']);
// The shifts count only their SHIFTED operand: a 64-bit value shifted by a 32-bit count is what
// every one of these machines does. The comparisons count only their OPERANDS: the result of a C
// comparison is an `int` whatever it compared, which is what `raise/recover.ts` already types it.
const SHIFTS = new Set(['shl', 'shr_u', 'shr_s']);
const COMPARES = new Set([
  'icmp_slt',
  'icmp_sle',
  'icmp_sgt',
  'icmp_sge',
  'icmp_ult',
  'icmp_ule',
  'icmp_ugt',
  'icmp_uge',
  'icmp_eq',
  'icmp_ne',
]);
/** Whether `t` takes part in the width rule at all: it does exactly when it carries an integer
 *  width. `ir/types.ts` owns that question — `raise/widehelpers.ts` asks it too, of the same kinds,
 *  and reads the null with the opposite polarity. */
const widthOf = intWidth;
/** The types an op's width rule quantifies over. */
const widthParticipants = (op: Op): IrType[] => {
  const operands = op.operands.map((o) => o.type);
  if (COMPARES.has(op.opcode)) {
    return operands;
  }
  const results = op.results.map((r) => r.type);
  return SHIFTS.has(op.opcode) ? [...results, ...operands.slice(0, 1)] : [...results, ...operands];
};

export function verify(fn: Fn): void {
  if (fn.blocks.length === 0) {
    throw new VerifyError(`fn '${fn.name}' has no blocks`);
  }

  // --- collect definitions; reject double-definition ---
  const defined = new Set<Value>();
  const defBlock = new Map<Value, Block>();
  const defIndex = new Map<Value, number>(); // -1 for block params
  const define = (v: Value, b: Block, idx: number, what: string) => {
    if (defined.has(v)) {
      throw new VerifyError(`value defined twice (${what})`);
    }
    defined.add(v);
    defBlock.set(v, b);
    defIndex.set(v, idx);
  };
  for (const b of fn.blocks) {
    for (const p of b.params) {
      define(p, b, -1, 'block param');
    }
    b.ops.forEach((op, idx) => op.results.forEach((r) => define(r, b, idx, `result of '${op.opcode}'`)));
  }

  // --- per-op structural + arity + level checks ---
  const at = (b: Block, idx: number) => `(fn '${fn.name}', block ^bb${fn.blocks.indexOf(b)}, op ${idx})`;
  for (const b of fn.blocks) {
    if (b.ops.length === 0) {
      throw new VerifyError(`empty block ^bb${fn.blocks.indexOf(b)} in '${fn.name}'`);
    }
    b.ops.forEach((op, idx) =>
      locate(
        () => {
          const sig = opSig(op.opcode);
          if (!sig) {
            throw new VerifyError(`unknown opcode '${op.opcode}'`);
          }
          if (sig.operands !== 'variadic' && op.operands.length !== sig.operands) {
            throw new VerifyError(`'${op.opcode}' expects ${sig.operands} operands, got ${op.operands.length}`);
          }
          if (op.results.length !== sig.results) {
            throw new VerifyError(`'${op.opcode}' expects ${sig.results} results, got ${op.results.length}`);
          }
          // `sdiv` and the shifts are variadic to admit BOTH forms (2-operand register form, or
          // 1-operand + `imm`), so the generic arity check can't guard them. Enforce the real
          // invariant here — otherwise a malformed op (0 operands, or 1 with no `imm`) would slip
          // through and render `/ undefined` / `<< undefined` downstream instead of failing at its
          // source.
          if (
            TWO_OR_IMM.has(op.opcode) &&
            !(op.operands.length === 2 || (op.operands.length === 1 && 'imm' in op.attrs))
          ) {
            throw new VerifyError(
              `'${op.opcode}' must be 2 operands OR 1 operand with an 'imm' attr, got ${op.operands.length} operands`,
            );
          }
          // `ret` is variadic to admit the void form; anything past one returned value is malformed.
          if (op.opcode === 'ret' && op.operands.length > 1) {
            throw new VerifyError(`'ret' takes at most 1 operand, got ${op.operands.length}`);
          }
          const isTerm = !!sig.terminator;
          const isLast = idx === b.ops.length - 1;
          if (isTerm && !isLast) {
            throw new VerifyError(`terminator '${op.opcode}' is not the last op in its block`);
          }
          if (!isTerm && isLast) {
            throw new VerifyError(`block does not end in a terminator (ends with '${op.opcode}')`);
          }
          if (typeof sig.successors === 'number' && op.successors.length !== sig.successors) {
            throw new VerifyError(`'${op.opcode}' expects ${sig.successors} successors, got ${op.successors.length}`);
          }
          // `switch_br` has variadic successors (N cases + 1 default). Enforce its real invariants here (as
          // the generic count check can't): ≥2 successors, a `cases` list index-aligned with the first N,
          // and DISTINCT case values (a duplicate would only surface as a `duplicate case` error at recompile).
          if (op.opcode === 'switch_br') {
            if (op.successors.length < 2) {
              throw new VerifyError(`'switch_br' needs ≥2 successors (cases + default), got ${op.successors.length}`);
            }
            const cases = op.attrs.cases;
            if (!Array.isArray(cases) || cases.length !== op.successors.length - 1) {
              throw new VerifyError(
                `'switch_br' 'cases' must have (successors - 1) = ${op.successors.length - 1} entries`,
              );
            }
            if (new Set(cases as number[]).size !== cases.length) {
              throw new VerifyError(`'switch_br' has duplicate case values`);
            }
          }
          if (!isTerm && op.successors.length) {
            throw new VerifyError(`non-terminator '${op.opcode}' has successors`);
          }
          // `laddr` carries two shapes in one set of attrs and `count` is the only thing telling
          // them apart: one element is a SCALAR typed by the accesses the frame-object audit read
          // off the machine, and more than one is STORAGE that audit sized without typing, whose
          // width and signedness are therefore not an access at all. The structurer declares the
          // second as `u8 name[count]`, so a typed element there would be a type nothing pinned —
          // the exact answer the audit refuses to invent. (One BYTE encodes like a real `u8`
          // scalar either way; the declaration is the same one, so nothing has to tell them apart.)
          if (op.opcode === 'laddr') {
            const count = op.attrs.count;
            if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
              throw new VerifyError(`'laddr' count must be a positive integer, got ${String(count)}`);
            }
            if (count > 1 && (op.attrs.width !== 1 || op.attrs.signed !== false)) {
              throw new VerifyError(
                `'laddr' of ${count} elements is storage no access typed, so it must be unsigned bytes — ` +
                  `got width ${String(op.attrs.width)}, signed ${String(op.attrs.signed)}`,
              );
            }
          }
          // A 64-bit value is BUILT and TAKEN APART by exactly these three, so their shape is
          // checked here rather than left to whoever reads a half. `concat` is the only producer.
          if (op.opcode === 'concat' || op.opcode === 'lo32' || op.opcode === 'hi32') {
            const wide = op.opcode === 'concat' ? op.results[0].type : op.operands[0].type;
            const narrow = op.opcode === 'concat' ? op.operands.map((o) => o.type) : op.results.map((r) => r.type);
            const wideW = widthOf(wide);
            if (wideW !== WIDE_BITS) {
              throw new VerifyError(
                `'${op.opcode}' ${op.opcode === 'concat' ? 'result' : 'operand'} must be an integer of ` +
                  `width ${WIDE_BITS}, got ${String(wideW ?? wide.kind)}`,
              );
            }
            for (const t of narrow) {
              if (widthOf(t) !== 32) {
                throw new VerifyError(
                  `'${op.opcode}' half must be an integer of width 32, got ${String(widthOf(t) ?? t.kind)}`,
                );
              }
            }
          }
          // …and everywhere else, 64 does not mix (see the header above this file's checks).
          if (WIDTH_UNIFORM.has(op.opcode) || SHIFTS.has(op.opcode) || COMPARES.has(op.opcode)) {
            const ws = widthParticipants(op)
              .map(widthOf)
              .filter((w): w is number => w !== null);
            if (ws.some((w) => w === WIDE_BITS) && ws.some((w) => w !== WIDE_BITS)) {
              throw new VerifyError(
                `'${op.opcode}' mixes a ${WIDE_BITS}-bit operand with a narrower one (widths ${ws.join(', ')})`,
              );
            }
          }
          for (const k of sig.requiredAttrs ?? []) {
            if (!(k in op.attrs)) {
              throw new VerifyError(`'${op.opcode}' missing required attr '${k}'`);
            }
          }
          for (const u of op.operands) {
            if (!defined.has(u)) {
              throw new VerifyError(`use of undefined value in '${op.opcode}'`);
            }
          }
          for (const s of op.successors) {
            if (!fn.blocks.includes(s.block)) {
              throw new VerifyError(`successor of '${op.opcode}' is not a block of this fn`);
            }
            if (s.args.length !== s.block.params.length) {
              throw new VerifyError(
                `successor of '${op.opcode}' passes ${s.args.length} args to a block with ${s.block.params.length} params`,
              );
            }
            for (const u of s.args) {
              if (!defined.has(u)) {
                throw new VerifyError(`use of undefined value in successor args of '${op.opcode}'`);
              }
            }
          }
        },
        () => at(b, idx),
      ),
    );
  }

  // --- dominance: def must dominate every use (ir/core.ts owns the analysis) ---
  const dom = dominators(fn);
  const dominates = (a: Block, b: Block) => dom.get(b)!.has(a);

  for (const b of fn.blocks) {
    b.ops.forEach((op, idx) =>
      locate(
        () => {
          const checkUse = (u: Value) => {
            const db = defBlock.get(u)!;
            if (db === b) {
              const di = defIndex.get(u)!;
              if (di >= 0 && di >= idx) {
                throw new VerifyError(`use before def in '${op.opcode}'`);
              }
            } else if (!dominates(db, b)) {
              throw new VerifyError(`def does not dominate use in '${op.opcode}'`);
            }
          };
          op.operands.forEach(checkUse);
          op.successors.forEach((s) => s.args.forEach(checkUse));
        },
        () => at(b, idx),
      ),
    );
  }

  checkWriteOrder(fn);
}

/** THE WRITE-ORDER RECORD'S CROSS-PASS OBLIGATION, checked rather than trusted (ir/core.ts
 *  `WriteOrder`, `foldWriteOrder`), because the consequence of missing it is silent: an unmeasured
 *  block's edge copies sort with no records at all, changing the order the structurer emits them in
 *  and, on a cycle, which register it spills. No decline, no marker.
 *
 *  WHAT IT CATCHES: a pass that MINTS a block into a measured fn, or drops a block's entry, leaving
 *  a hole indistinguishable from a fn nobody measured. Also an ordinal outside its block's own
 *  write count — a `foldWriteOrder` that moved records without growing the count. WHAT IT CANNOT:
 *  ops moved from one MEASURED block into another with the fold forgotten, since both blocks still
 *  have entries and no snapshot of the IR shows the move. That half stays a review obligation until
 *  the record hangs on `Successor` itself.
 *
 *  A fn is "measured" iff it has any entry at all; one with none is parsed or hand-built IR, whose
 *  edges take the def-position proxy by design. */
function checkWriteOrder(fn: Fn): void {
  const order = fn.writeOrder;
  if (order === undefined || order.writes.size === 0) {
    return;
  }
  for (const b of fn.blocks) {
    const writes = order.writes.get(b);
    if (writes === undefined) {
      throw new VerifyError(
        `fn '${fn.name}': block ^bb${fn.blocks.indexOf(b)} carries no write-order entry, but the fn is measured`,
      );
    }
    for (const at of order.lastWrite.get(b)?.values() ?? []) {
      if (at < 0 || at >= writes) {
        throw new VerifyError(
          `fn '${fn.name}': write-order ordinal ${at} on block ^bb${fn.blocks.indexOf(b)} is outside its ${writes} writes`,
        );
      }
    }
  }
}

/** Run a check body; a VerifyError it throws is re-thrown with the op's location appended —
 *  "value defined twice" is unactionable without WHICH block/op. */
function locate(body: () => void, where: () => string): void {
  try {
    body();
  } catch (e) {
    if (e instanceof VerifyError) {
      throw new VerifyError(`${e.message} ${where()}`);
    }
    throw e;
  }
}
