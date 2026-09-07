// asmlift — 32-bit constant materialisation (F-CONST; L1 recognition, ISA-neutral).
//
// A RISC target builds a 32-bit literal in two halves: a high-half load (MIPS `lui`, PPC `lis`) then a
// low-half `ori`/`addiu`. The frontends lift that pair faithfully as `or(const(hi<<16), const(lo))` /
// `add(const(hi<<16), const(lo))` — a live binary op over two `const` ops — because neither frontend can
// see across the two instructions. This pass folds such a const/const `or`/`add` into a single `const`,
// which is the form that (a) type-recovers as one 32-bit literal and (b) recompiles to the exact
// `lui;ori` / `lis;ori` pair. Without it a magic-division reciprocal or an address literal is never a
// single value the later passes can reason about.
//
// THE CLIENTELE IS "A VALUE THE TARGET MATERIALISES IN TWO INSTRUCTIONS", and it is wider than the
// RISC pair above in both directions, and both halves are measured:
//   - It is NOT ARM-free. On Thumb a literal is a pool word plus an immediate `add`, which is exactly a
//     two-instruction materialisation and lifts as the same const/const pair. Ablating the whole pass
//     costs three agbcc BYTE-MATCHES — `synthetic:dmafield` MATCH -> diff:29, `synthetic:fieldbase`
//     MATCH -> diff:22, `synthetic:bgfixed` MATCH -> diff:2 (measured, whole pass off). Do not gate
//     this pass on a RISC target.
//   - The pair is NOT confined to ONE block. `synthetic:mergepool:gcc2.7.2kmc` lifts a genuine
//     `lui;ori` as `or(const 65536, const 9029)` whose two halves are defined in DIFFERENT blocks
//     (instrumented: `b0=0 b1=1`), because gcc hoisted the high half above the branch. A guard
//     tightened to a literal same-block test loses folds the corpus depends on.
// What the refusal below actually excludes is narrower than either: an operand a terminator hands to a
// successor's block-parameter — a REGISTER the compiler held live across a branch — where the pair is
// ALSO not recognisable as a hi/lo pair and the result is not an address. See its site for the cost.
//
// This cannot be a data-`RewritePattern`: the fold's result is COMPUTED from the two operands' values,
// which the pattern engine's numeric-exact `attrEquals` cannot express. So it lives here as an always-on
// recognizer, run before type recovery. Value-preserving and local; a single left-to-right pass suffices
// (SSA guarantees each const is defined before the op that consumes it, and a folded result feeds
// forward for any chained materialisation).
import { Fn, Op, Value, defOpMap, mkOp } from '../ir/core';
import { MEM_BASE_OPS } from '../ir/opcodes';

// The binary opcodes whose const/const form is a constant. `>> 0` normalises to a signed 32-bit result
// (hardware wraparound): `|` already yields int32, `+` may exceed it and is truncated to match `addu`/`add`.
const FOLD: Record<string, (a: number, b: number) => number> = {
  or: (a, b) => (a | b) >> 0,
  add: (a, b) => (a + b) >> 0,
};

/** Is `v` a RISC HIGH HALF — what one `lui`/`lis`/`addis` puts in a register? `hi << 16`, for a
 *  NON-ZERO `hi`. Zero is excluded deliberately, and that exclusion is what makes this test
 *  trustworthy as a positive: `lui rD, 0` is a no-op no compiler emits, so a `const 0` is never a
 *  half being materialised — it is an initialised register, exactly the shape the refusal below
 *  exists to protect.
 *
 *  IT COVERS THE RISC HALF OF THE CLIENTELE ONLY, because the 16/16 split is an ISA fact: censused
 *  over the corpus's const/const fold sites, all 19 RISC ones (gcc2.7.2kmc / mwcc_242_81 / ido7.1)
 *  are recognisable to it and 0 of the 20 agbcc ones are — an ARM pool word is an arbitrary 32-bit
 *  value (`0x03001C00`, low half `0x1C00`) and can never pass. The ARM half of the clientele is
 *  protected by `memBases` and by simply not being edge-carried; four agbcc sites on three rows
 *  (`dmascope` ×2, `dmascope2`, `dmafield`'s `add(…,112)`) sit behind neither carve-out. If a row
 *  ever needs the buy-back on ARM, the half-width belongs on the target description —
 *  `PreRecoveryPass` already threads `target`, and `softdiv` gates on `capabilities.hwDivide` —
 *  rather than as a second constant here. */
const isHighHalf = (v: number): boolean => (v & 0xffff) === 0 && v !== 0;

/** Is `v` a LOW HALF — what one `ori`/`addi`/`addiu` can supply? `ori` takes an UNSIGNED 16-bit
 *  immediate and `addi`/`addiu` a SIGNED one, so the admissible range is the union: mwcc completes an
 *  `addis` with a NEGATIVE `addi` whenever bit 15 of the low half is set (`0x12350000 + -25924` is
 *  `0x12345ABC`). Deliberately NOT split per-opcode (`or` unsigned, `add` signed): that narrowing is
 *  true of the ISA, reaches 0 rows of the corpus, and no fixture reddens when it is removed, so it
 *  would be an unpinned clause. The half-width belongs on the target description if a row needs it. */
const isLowHalf = (v: number): boolean => v >= -0x8000 && v <= 0xffff;

/** The constant a foldable const/const pair denotes, or `null` when `opcode` is not one this pass
 *  folds. Exported because `structure.ts` repairs the refusal's residue at RENDER time and must
 *  print exactly what an unrefused fold here would have produced — the opcode set and the int32
 *  normalisation are one decision, so they live in one place. */
export function foldConstPair(opcode: string, a: number, b: number): number | null {
  const f = FOLD[opcode];
  return f ? f(a, b) : null;
}

/** Does this opcode's const/const form denote a constant? The membership half of `foldConstPair`,
 *  for callers that must classify an op before they have its operands' values. */
export const isConstFoldOpcode = (opcode: string): boolean => opcode in FOLD;

/** Fold each const/const `or`/`add` into one `const`, in place. Returns whether anything changed. The
 *  now-dead source consts are left for DCE (they may still have other uses; liveness is not our concern). */
export function recognizeConsts(fn: Fn): boolean {
  let changed = false;
  const defs = defOpMap(fn);
  // The two facts the CLIENTELE REFUSAL below reads, both collected in one walk.
  //   `edgeSlots` — for every value a terminator hands to a successor, WHICH block-parameters it
  //     feeds. Being in the map at all is "a register the compiler held live across a branch": in
  //     functional-form SSA the machine had this value in a register at the branch and the join
  //     reads it back. WHICH parameter is the second question, and the buy-back below needs it.
  //   `memBases`  — every value used as a memory base, i.e. the values that ARE addresses.
  const edgeSlots = new Map<Value, Set<Value>>();
  const memBases = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const sc of op.successors) {
        sc.args.forEach((v, i) => {
          const param = sc.block.params[i];
          if (param === undefined) {
            return;
          }
          const slots = edgeSlots.get(v);
          if (slots) {
            slots.add(param);
          } else {
            edgeSlots.set(v, new Set([param]));
          }
        });
      }
      if (MEM_BASE_OPS.has(op.opcode) && op.operands.length > 0) {
        memBases.add(op.operands[0]);
      }
    }
  }
  /** Do these two values reach the SAME block-parameter — i.e. are they two arms' feeds of one
   *  merge? See the refusal for why that is what tells an accumulator from a shared high half. */
  const meetAtSameParam = (x: Value, y: Value): boolean => {
    const sx = edgeSlots.get(x);
    const sy = edgeSlots.get(y);
    return !!sx && !!sy && [...sx].some((k) => sy.has(k));
  };
  const constOf = (op: Op | undefined): number | null =>
    op && op.opcode === 'const' ? (op.attrs.value as number) : null;
  for (const b of fn.blocks) {
    for (let i = 0; i < b.ops.length; i++) {
      const op = b.ops[i];
      const fold = FOLD[op.opcode];
      if (!fold || op.operands.length !== 2 || op.results.length !== 1) {
        continue;
      }
      const a = constOf(defs.get(op.operands[0]));
      const c = constOf(defs.get(op.operands[1]));
      if (a === null || c === null) {
        continue;
      }
      // ── THE REFUSAL: this shape is not a literal being materialised ───────────────────────────
      // An operand a terminator ALSO hands to a successor's block-parameter is a register the compiler
      // held live across the branch, whose value on this path happens to be a constant. agbcc's
      // `s = 0; ... if (c) s += 1;` lifts as `add(%s = const 0, const 1)` in the taken arm, where
      // `%s` is also the value bb0 hands the join. Folding it to `const 1` deletes the accumulator's
      // last reference, so every later level sees an arm that materialises a literal and spells it
      // as one (`v = 1;` with an `else v = 0;`) instead of the `s += 1` the target records — and the
      // enumeration gate for the shipped `/merge-home` axis, which is what would have spelled the
      // hoisted init, reads FALSE because the merge feed it looks for is gone.
      //
      // The mapping is a FUNCTION, not a choice, so this is a default and not an axis: a register
      // carried across a branch is not a literal being materialised, whichever compiler produced it.
      //
      // IT IS A PROXY, and the two carve-outs are where it is bought back. Edge-carrying is evidence
      // of a register, not proof, and the same `add(const 0, const K)` still folds wherever nothing
      // carries the zero (6 sites on 5 marioparty3/snowboardkids2 rows) — defensible, since with no
      // merge there is no home to hoist and the incident cannot occur, but the rule is narrower than
      // "never fold a const/const pair over a branch".
      //   - `hiLoPair` — the pass's OWN clientele beats the proxy. mwcc materialises `0x12345678` as
      //     `lis; addi` and shares the `lis` across a branch whenever the high half is live at the
      //     join, so the genuine pair IS edge-carried and the proxy refuses it: measured, a
      //     `base = 0x12340000; if (c) q[0] = base|0x5678; else q[1] = base|0x9ABC; *p = base;` row
      //     emitted `*a2 = 305397760 + 22136;` on mwcc_242_81 where every other toolchain emitted the
      //     folded literal. The literal is then no longer ONE value for `recognizeMagicDivision`, type
      //     recovery or the symbol map — the same never-enumerated failure this refusal exists to fix,
      //     one level down.
      //
      //     `feedsSameMerge` IS A CONDITION ON THAT BUY-BACK: read as a bare "is this a hi/lo pair"
      //     it re-opens the very incident this refusal exists for. An accumulator's `const 0` init
      //     passes `isLowHalf`, so `s = 0; if (c) s += 0x10000;` — one 16.16 fixed-point step — is a
      //     hi/lo pair by the letter of the test, and its MIRROR `s = 0x10000; if (c) s += 1;` is
      //     one whichever operand is read as the half. Folded, a two-arm `s += 0x10000` row scores
      //     **diff:1** on mwcc_242_81 with `hasMergeFeedHome` FALSE; refused, **MATCH** with the
      //     gate TRUE. What separates the two shapes is WHERE THE VALUES GO rather than their bit
      //     patterns: an accumulator's init and its updated copy are two arms' feeds of ONE block
      //     parameter — exactly the merge `/merge-home` exists to home — whereas a shared high half
      //     reaches the join while the COMPLETED literal is stored or returned, never merged with
      //     the half it was built from. Measured FREE: with it in, 770 synthetic + 252 real rows are
      //     byte-identical in post-recovery IR, in emitted source and in gap list to the branch
      //     without it.
      //   - `memBases` — an address literal, `0x03001C00 + 1206` reached through one arm's base
      //     register. It decides 0 folds over the corpus's 806 lifted rows and is here as a
      //     statement of scope; `hiLoPair` is the clause that carries real traffic. Deliberately NOT
      //     transitive and NOT extended to call arguments: an address literal escaping as a call
      //     argument is a shape the refusal HELPS (a probe row scored diff:7 -> MATCH with it
      //     firing), so widening this test would give that back.
      //
      // A REFUSAL IS ALSO A SCHEDULING DECISION, and that coupling is invisible at this site:
      // `pre-recovery.ts` registers this pass `dce: true` and runs `dce(fn)` only when the pass
      // returns TRUTHY, so a function whose ONLY const/const pair is refused gets no DCE here at
      // all — and `addrnum` above is `dce: false`, so this is the first pass that can schedule one.
      // Measured inert: forcing the cancelled `dce(fn)` removes 0 ops on every invocation of every
      // reachable row (`sinkacc`, 3 invocations). Worth knowing before this refusal is widened.
      const edgeCarried = edgeSlots.has(op.operands[0]) || edgeSlots.has(op.operands[1]);
      const feedsSameMerge =
        meetAtSameParam(op.results[0], op.operands[0]) || meetAtSameParam(op.results[0], op.operands[1]);
      const hiLoPair = ((isHighHalf(a) && isLowHalf(c)) || (isHighHalf(c) && isLowHalf(a))) && !feedsSameMerge;
      if (edgeCarried && !hiLoPair && !memBases.has(op.results[0])) {
        continue;
      }
      // Reuse the SAME result Value → every existing use already points at it (no RAUW needed).
      const folded = mkOp('const', { results: [op.results[0]], attrs: { value: fold(a, c) } });
      b.ops.splice(i, 1, folded);
      defs.set(op.results[0], folded); // keep the def map current so a chained fold sees this const
      changed = true;
    }
  }
  return changed;
}
