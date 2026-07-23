// asmlift — L2→L3 structuring: CFG + block-argument SSA → a structured AST.
//
// Three jobs:
//  1. SSA destruction WITH COALESCING — a merge block-argument that already carries a
//     variable's value on one path is coalesced to that variable, so only the
//     non-identity paths emit an assignment (reproducing agbcc's register allocation:
//     NOTE the coupled INVERSE: l3/regspell.ts re-derives the UN-coalesced copy-carrying
//     spelling as a ranked candidate — its R1 template matches THIS pass's diamond output
//     shape, so a change to coalescing here can silently stop that lever firing (the
//     matching-suite regspell gate is what makes the coupling loud).
//     the clamp0 diamond becomes `if (x < 0) x = 0; return x;` rather than a temp copy).
//     Coalescing is INTERFERENCE-CHECKED against per-block value liveness, and
//     inline-at-use rendering carries an effect-ordering model: a call/load that cannot
//     soundly render at its use is MATERIALIZED as a named temp at its own program
//     position. Where no correct spelling exists, the structurer declines loud
//     (StructureError) — never silent wrong code.
//  2. If-recovery over the CFG using immediate post-dominators as merge points, with an
//     empty-then peephole (negate + swap).
//  3. Loop-recovery: a back-edge (edge into a dominating header) is recognised, and the
//     gcc "guard + do-while" lowering is un-rotated back into a `while` — the loop
//     condition is the latch test read on the header's OWN parameters (back-edge args
//     substituted back to the phi they feed), and the loop body is the header's
//     parallel block-argument update, sequentialised so an assignment never clobbers a
//     value a later one still needs.
//
// Module layout: loop DISCOVERY is loops.ts; the pure ANALYSIS phase (use registry, liveness,
// materialization) is analysis.ts; comparison-tree switch recovery is switch-recover.ts
// (explicit-deps factory). THIS file keeps the mutually-entangled remainder: SSA-destruction
// coalescing (canTakeName + seeding) and emission (structureBlock + the loop emitters) — they
// share varName/backArgName mutation and the activeSub/loopCtx dynamic state.
//
// Scope: reducible single-latch natural loops — GUARDED self-loop `while` (the guard-fusion
// un-rotation), UNGUARDED self-loop `do-while` (single block, header === latch), test-at-top
// `while`, bottom-test `do-while`, PROPERLY-nested loops, in-body `break`/early-`return`,
// comparison-tree and jump-table `switch`. Still DECLINED (loud StructureError, never wrong
// code): multi-latch headers, irreducible/overlapping loops, conditional `continue`, a `break`
// whose exit copies would clobber, switch fall-through, and mixed-entry self-loops (a guarded
// header also entered by a plain br).
import { Block, Fn, Op, Value, defOpMap, successorsOf } from '../ir/core';
import { type IrType, T } from '../ir/types';
import { BinOp, Expr, SFn, Stmt, SwitchCase, exprChildren, mapExprChildren } from '../l3/ast';
import { exprCType, ptrElemBytes } from '../l3/typing';
import { returnType } from '../raise/recover';
import { collectStructs } from '../raise/structs';
import type { SymbolInfo } from '../symbols';
import { analyze } from './analysis';
import { makeLoopHazards, updateWriteSet } from './hazards';
import { analyzeLoops, dominators } from './loops';
import { makeSwitchRecovery } from './switch-recover';

// Lower a constant-offset memory access to its lvalue/rvalue Expr. If the base was recovered as a
// struct pointer (raise/structs.ts), the byte offset resolves to a NAMED field (`base->field_<off>`);
// otherwise it stays the width-scaled array index (`base[off/width]`, `*base` for offset 0).
//
// The scalar path builds a WIDTH-CARRYING `index` node and inserts NO cast: each backend
// legalizes the base itself from the node's width (the C family inserts the reinterpret cast at
// print time when the base's rendered type does not stride the width — derefStrideOk, l3/typing —
// and Pascal loud-declines instead). The struct path still bakes its cast into the tree: the
// legalization target is the RECOVERED struct pointer type, which the `field` node does not carry
// TODAY — carrying the struct name (resolved against SFn.structs) is the same move as width and
// the named follow-up; until then no backend pays a tax for the tree cast (Pascal loud-fails
// `field` regardless, C++ falls through its leaf hook to the shared C spelling).
// `&gSym`, possibly wearing the value-context integer cast the additive lowering adds
// (`(u32)&gSym` — see lowerDef's addr-intify): both spell the same link-time constant, so the
// fold rules match through the cast and every access that CAN spell a named element still does.
// WIDTH 32 ONLY — a NARROWING cast (`(u8)&gSym`, from a zext/sext lowering) is a different
// VALUE (`addr & 0xFF`), and folding through it would read the named global at a wrong address
// (the adversarial round's probe: `*(u8*)(u8)&gSym` must keep its truncation, never become
// `*(u8*)&gSym` — let alone a confidently-named `gSym.field`).
function addrIn(e: Expr): Extract<Expr, { k: 'addr' }> | null {
  if (e.k === 'addr') {
    return e;
  }
  if (e.k === 'cast' && e.to.kind === 'int' && e.to.width === 32 && e.e.k === 'addr') {
    return e.e;
  }
  return null;
}

// If `e` is a global address `&gSym` (optionally `+ index`), return the global name and the
// element index (byte residual divided by the access width). `&gSym` alone → idx const 0;
// `&gSym + i` → idx `i / width` (exact division only — a non-multiple residual is a mid-element
// access this whole-global spelling can't express, so it declines to null and the caller casts).
function globalOf(e: Expr, width: number): { name: string; idx: Expr } | null {
  const top = addrIn(e);
  if (top) {
    return { name: top.name, idx: { k: 'const', value: 0 } };
  }
  if (e.k === 'bin' && e.op === '+') {
    for (const [side, other] of [
      [e.l, e.r],
      [e.r, e.l],
    ] as const) {
      const addrSide = addrIn(side);
      if (addrSide) {
        // width 1 → the byte residual IS the index; width>1 → a constant residual divides, a
        // non-constant residual must already be element-scaled (`i * width`) to divide exactly.
        if (width === 1) {
          return { name: addrSide.name, idx: other };
        }
        if (other.k === 'const') {
          return other.value % width === 0
            ? { name: addrSide.name, idx: { k: 'const', value: other.value / width } }
            : null;
        }
        if (other.k === 'bin' && (other.op === '*' || other.op === '<<')) {
          const factor =
            other.op === '<<'
              ? other.r.k === 'const'
                ? 1 << other.r.value
                : 0
              : other.r.k === 'const'
                ? other.r.value
                : 0;
          if (factor === width) {
            return { name: addrSide.name, idx: other.l };
          }
        }
        return null; // a non-element-aligned residual — decline the global-array spelling
      }
    }
  }
  return null;
}

/** The symbol-map rendering context threaded into memAccess/arrayAccess: shape facts per
 *  global name, plus a callback registering an array-shaped global's env type (so the bare
 *  `gSym[i]` spelling passes the stride check uncast). Absent ⇒ today's spellings. */
interface SymRenderCtx {
  info(name: string): SymbolInfo | undefined;
  noteArray(name: string, type: IrType): void;
}

// The (name, byte offset) of a global access with a CONSTANT total offset — `&gSym` → off,
// `&gSym + K` → K + off. The exact byte is what a struct-layout field lookup needs; a variable
// residual returns null (no field spelling — falls through to the index/cast forms).
function globalConstByte(baseExpr: Expr, off: number): { name: string; byte: number } | null {
  const top = addrIn(baseExpr);
  if (top) {
    return { name: top.name, byte: off };
  }
  if (baseExpr.k === 'bin' && baseExpr.op === '+') {
    for (const [a, b] of [
      [baseExpr.l, baseExpr.r],
      [baseExpr.r, baseExpr.l],
    ] as const) {
      const a2 = addrIn(a);
      if (a2 && b.k === 'const') {
        return { name: a2.name, byte: b.value + off };
      }
    }
  }
  return null;
}

function memAccess(
  base: Value,
  baseExpr: Expr,
  off: number,
  width: number,
  signed: boolean,
  ctype: (e: Expr) => IrType | undefined,
  scalarGlobals: Set<string>,
  sym?: SymRenderCtx,
): Expr {
  // A deref of a global's address collapses to the bare global: `*(&gSym)` at off 0 is `gSym`;
  // at off N the global is an array — `gSym[N/width]` (a C global name decays to a pointer, so
  // the index reproduces the offset). A `+`-tree base holding `&gSym` is a global-ARRAY element
  // `*(&gSym + i)` → `gSym[i + off/width]` (byte offset `i` peeled from the tree; for a u8 global
  // the residual IS the index). This is what makes an agbcc `.word gSym` pool access a named
  // global read/element rather than a phantom-pointer deref.
  // Declaration-shape spellings (symbol map): a STRUCT global's constant-offset access is the
  // named field (`gSym.field` — the source spelling a folded literal can never match); an ARRAY
  // global indexes its BARE name (`gSym[i]`, see below). Exact field match only (offset AND
  // width) — anything else falls through to the honest cast forms, never a guessed field.
  if (sym) {
    const gb = globalConstByte(baseExpr, off);
    const si = gb ? sym.info(gb.name) : undefined;
    if (gb && si?.shape === 'struct' && si.layout) {
      const fld = si.layout.find((f) => f.offset === gb.byte && f.size === width);
      if (fld) {
        return { k: 'field', base: { k: 'var', name: gb.name }, name: fld.name, dot: true };
      }
    }
  }
  const g = globalOf(baseExpr, width);
  if (g) {
    const idxVal = g.idx;
    // off-0 access of a SCALAR global (accessed only at offset 0, per scalarGlobals) → the BARE
    // global `gSym` (byte-exact, matches the source spelling). Any other access — a non-zero
    // offset, a variable index, or an AGGREGATE global (accessed at multiple offsets) — indexes
    // the global's ADDRESS `&gSym`, NOT the bare value: a struct global does not decay, so
    // `((s32 *)gSym)[i]` is invalid C, but `((s32 *)&gSym)[i]` reinterpret-casts the address and
    // strides correctly for BOTH a struct and an array global.
    if (off === 0 && idxVal.k === 'const' && idxVal.value === 0 && scalarGlobals.has(g.name)) {
      return { k: 'var', name: g.name };
    }
    const idx: Expr =
      off === 0
        ? idxVal
        : idxVal.k === 'const'
          ? { k: 'const', value: idxVal.value + off / width }
          : { k: 'bin', op: '+', l: idxVal, r: { k: 'const', value: off / width } };
    // ARRAY-declared global (symbol map): index the bare name — `gSym[i]`, the spelling the
    // dogfood proved agbcc needs for ROM tables — with the element type registered in the env
    // so the stride check passes and no cast is added. Element-width match only.
    const siArr = sym?.info(g.name);
    if (siArr?.shape === 'array' && siArr.elemSize === width) {
      sym!.noteArray(g.name, T.ptr(T.int(width * 8, siArr.elemSigned ?? false)));
      return { k: 'index', base: { k: 'var', name: g.name }, idx, width, signed };
    }
    return { k: 'index', base: { k: 'addr', name: g.name }, idx, width, signed };
  }
  const bt = base.type;
  if (bt.kind === 'ptr' && bt.to.kind === 'struct') {
    const rt = ctype(baseExpr);
    // `->` requires the base to render as a pointer to THIS struct (field names resolve against
    // its declaration) AND as a non-`index` node (the printer spells an index-node base with `.`,
    // the array-element form — wrong for a pointer). Anything else is cast to the recovered
    // struct pointer type; the cast node prints with `->`.
    const ok = rt?.kind === 'ptr' && rt.to.kind === 'struct' && rt.to.name === bt.to.name && baseExpr.k !== 'index';
    return { k: 'field', base: ok ? baseExpr : { k: 'cast', to: bt, e: baseExpr }, name: `field_${off}` };
  }
  return { k: 'index', base: baseExpr, idx: { k: 'const', value: off / width }, width, signed };
}

// A variable-index array access `base[index]`, or `base[index].field_K` when a `fieldOff` marks an
// array-of-STRUCT element (raise/struct-arrays.ts). The `.field` on an array element prints
// with `.` (the printer decides dot-vs-arrow from the base being an `index` node).
//
// Scalar path: a width-carrying `index` node, no cast — the backend legalizes (see memAccess).
// Struct-array path: like memAccess's struct path, the recovered struct pointer type is an L2
// fact the AST cannot carry, so a base that does not render as THAT struct pointer is cast here
// (C then scales the index by the struct size, exactly the aload/astore element stride); the
// `index` node's width is the struct size only nominally — strideOk never fires on struct
// pointees, so the C backend leaves a struct-typed base uncast and the tree-level cast governs.
function arrayAccess(
  base: Value,
  baseExpr: Expr,
  idxExpr: Expr,
  fieldOff: number | undefined,
  elemSize: number,
  signed: boolean,
  ctype: (e: Expr) => IrType | undefined,
  sym?: SymRenderCtx,
): Expr {
  // A variable-index access off a global's address indexes the ADDRESS `&gSym` (the cast form
  // `((T *)&gSym)[i]` — valid for a struct global too, unlike casting the bare value). A
  // struct-array-of-globals (fieldOff) through `&gSym` is out of scope — fall through.
  if (baseExpr.k === 'addr' && fieldOff === undefined) {
    // ARRAY-declared global (symbol map): the bare-name spelling, same rule as memAccess.
    const si = sym?.info(baseExpr.name);
    if (si?.shape === 'array' && si.elemSize === elemSize) {
      sym!.noteArray(baseExpr.name, T.ptr(T.int(elemSize * 8, si.elemSigned ?? false)));
      return { k: 'index', base: { k: 'var', name: baseExpr.name }, idx: idxExpr, width: elemSize, signed };
    }
    return { k: 'index', base: baseExpr, idx: idxExpr, width: elemSize, signed };
  }
  const bt = base.type;
  if (fieldOff !== undefined) {
    const structTo = bt.kind === 'ptr' && bt.to.kind === 'struct' ? bt.to : null;
    const rt = ctype(baseExpr);
    const ok = structTo !== null && rt?.kind === 'ptr' && rt.to.kind === 'struct' && rt.to.name === structTo.name;
    // an ill-typed struct-array base with no recovered struct type has no derivable cast target:
    // left as rendered — assertDerefsTyped's FIELD rule flags the definite violations at the
    // stage boundary (the dot-form field types non-struct there).
    const b = ok || structTo === null ? baseExpr : { k: 'cast' as const, to: T.ptr(structTo), e: baseExpr };
    const index: Expr = { k: 'index', base: b, idx: idxExpr, width: elemSize, signed };
    return { k: 'field', base: index, name: `field_${fieldOff}` };
  }
  return { k: 'index', base: baseExpr, idx: idxExpr, width: elemSize, signed };
}

// Raised when the CFG contains control flow the structurer cannot recover (see the module scope
// note above for what IS recovered vs declined). It is an explicit, catchable "out of scope"
// signal — NOT a bug — so callers fail loud with a diagnostic instead of stack-overflowing.
export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructureError';
  }
}

// THE one copy of the guard shape (like fieldSpellsDot/derefStrideOk): a predecessor whose
// cond_br decides "enter `header` vs its `exit`". The self-loop DISCOVERY classifies ownership
// with it, and the guard-FUSION site consumes the same shape (its `takenB/fallB === li.exit`
// check is this predicate from the branch's own viewpoint) — a drift between the two is
// fail-safe (traced: either an onStack decline or an unfused `if (g) do…while` spelling, never
// wrong code) but wastes capability, so both keep pointing here.
function isGuardShapedPred(pred: Block, header: Block, exit: Block): boolean {
  if (pred === header) {
    return false;
  }
  const t = pred.ops[pred.ops.length - 1];
  return (
    t.opcode === 'cond_br' &&
    t.successors.some((sx) => sx.block === header) &&
    t.successors.some((sx) => sx.block === exit)
  );
}

const CMP_TO_BIN: Record<string, BinOp> = {
  icmp_slt: '<',
  icmp_sle: '<=',
  icmp_sgt: '>',
  icmp_sge: '>=',
  icmp_ult: '<',
  icmp_ule: '<=',
  icmp_ugt: '>',
  icmp_uge: '>=', // unsignedness is in the operand types
  icmp_eq: '==',
  icmp_ne: '!=',
};
const ARITH_TO_BIN: Record<string, BinOp> = {
  add: '+',
  sub: '-',
  mul: '*',
  sdiv: '/',
  udiv: '/',
  smod: '%',
  umod: '%',
  or: '|',
  and: '&',
  xor: '^',
  shl: '<<',
  shr_u: '>>',
  shr_s: '>>',
  logic_and: '&&',
  logic_or: '||', // short-circuit connectives (raise/shortcircuit.ts)
};
const NEGATE: Record<string, BinOp> = { '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!=', '!=': '==' };

// Recovered info for a self-loop header: its exit block and the per-parameter back-edge
// arg it feeds (the value on the header→header edge). The back-edge arg is the "next"
// value of the phi; mapping it back to the phi turns the latch test into the while test.
interface LoopInfo {
  header: Block;
  exit: Block;
  backArgOfParam: Value[]; // index-aligned with header.params
}

// A test-at-top multi-block `while`. The header is a pure test whose cond_br enters `bodyEntry`
// (inside the loop) or leaves to `exit` (the single loop exit). Unlike LoopInfo the condition reads
// the header's params directly (top-of-iteration values) — no back-edge substitution.
interface WhileLoopInfo {
  header: Block;
  bodyEntry: Block;
  exit: Block;
  latch: Block; // the single block with the back-edge to header (its args = the update)
  forwardPreds: Block[]; // header preds outside the loop body (the entry/init side)
  body: Set<Block>; // the pure natural-loop body (for in-body vs exit classification)
}

// A bottom-tested `do { body } while(cond)`. The header is the body entry (entered before any
// test); the LATCH holds the loop condition and the single exit. Body = header..latch structured, then
// the latch's own ops + the loop-update; the latch test is the do-while condition. The condition is
// read under the latch back-edge substitution (post-update the params hold their next-iteration value).
interface DoWhileInfo {
  header: Block;
  latch: Block;
  exit: Block;
  forwardPreds: Block[];
  body: Set<Block>; // the pure natural-loop body (for in-body vs exit classification)
}

// Structuring levers, threaded as DATA so a new one is a field here + its consumer, not a new
// positional boolean widened across every call site:
//   returnsVoid                    — from the function's own prototype (suppress phantom r0 return);
//   coalesceLoopInit               — keep the induction var in its arg register;
//   preserveDivergentBranchSense   — reproduce source branch direction on divergent ifs;
//   orderArgCopiesByComputation    — order edge copies by computation order in the predecessor.
// The last three are `compilerBehaviors` (target.ts) — this pass stays target-AGNOSTIC: it reads
// booleans, never a compiler name.
export interface StructureOptions {
  returnsVoid?: boolean;
  coalesceLoopInit?: boolean;
  preserveDivergentBranchSense?: boolean;
  orderArgCopiesByComputation?: boolean;
  // Comparison-tree switch recovery: treat an `x != K` test as a case (the EQUAL side is a case
  // body). GCC freely uses `!=`; IDO prefers `==`/`<`. A per-compiler DATA lever, not an `arch ==`
  // branch — default true (permissive; the decline path keeps it sound either way).
  switchAllowsNeqCase?: boolean;
  // How an unresolvable VALUE degrades (a live `opaque`, an unlowered transient op, a dropped def):
  //   "strict"   (default) — the `"?"` sentinel, tripping assertResolved at the boundary (loud in
  //              the PROCESS);
  //   "annotate" — a `marker` node that spells as the undefined ASMLIFT_ERROR(...) symbol (loud in
  //              the ARTIFACT: the function emits complete, but cannot compile un-acknowledged).
  onGap?: 'strict' | 'annotate';
  /** NAME-keyed project symbol facts (symbols.ts `symbolsByName`) — drives the byte-sensitive
   *  declaration-shape spellings: `shape:'array'` forces the aggregate classification and the
   *  bare `gSym[i]` form; `shape:'struct'`+layout spells interiors as `gSym.field`. Absent (or
   *  a symbol not in the map) ⇒ today's usage-inferred behavior, byte-identical. */
  symbols?: Map<string, SymbolInfo>;
}

export function structure(fn: Fn, opts: StructureOptions = {}): SFn {
  const {
    returnsVoid = false,
    coalesceLoopInit = false,
    preserveDivergentBranchSense = true,
    orderArgCopiesByComputation = true,
    switchAllowsNeqCase = true,
    onGap = 'strict',
    symbols,
  } = opts;
  const defs = defOpMap(fn);
  const preds = predecessorBlocks(fn);
  const ipdom = postDominators(fn);
  const dom = dominators(fn);

  // ── analysis phase (structure/analysis.ts): use registry, liveness, materialization ──
  const { useSitesOf, opIndex, opBlock, liveIn, materialize, reachFrom } = analyze(fn, returnsVoid);

  // SCALAR-vs-AGGREGATE globals: a `gaddr` symbol accessed EXCLUSIVELY at offset 0 is a scalar
  // global → the bare name `gSym` (byte-exact, matches the source). A symbol accessed at any
  // non-zero offset (or via a variable index) is an array/struct global → EVERY access uses the
  // `((T *)&gSym)[i]` address-cast form (a struct value does not decay, so casting the bare name is
  // invalid C; casting the address is valid and byte-exact). Computed once here.
  //
  // Only the offset set is tracked, not width: a single symbol read at off-0 with two DIFFERENT
  // widths is a union/type-pun, which the downstream struct-layout recovery rejects LOUD
  // ("overlapping fields ... unions not modelled") before this classification is consumed — so a
  // width collision at off-0 declines honestly rather than reaching a wrong bare-`gSym` emission.
  const scalarGlobals = new Set<string>();
  {
    const offsets = new Map<string, Set<number>>();
    const bumpAgg = (sym: string) => offsets.set(sym, new Set([-1])); // -1 marks "variable index"
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        const gaddrSym = (v: Value) => (defs.get(v)?.opcode === 'gaddr' ? (defs.get(v)!.attrs.sym as string) : null);
        if (op.opcode === 'load' || op.opcode === 'store') {
          const s = gaddrSym(op.operands[0]);
          if (s) {
            (offsets.get(s) ?? offsets.set(s, new Set()).get(s)!).add(op.attrs.off as number);
          }
        } else if (op.opcode === 'add' || op.opcode === 'sub') {
          // ANY arithmetic on the symbol's address is interior addressing ⇒ aggregate — even when
          // the sum only reaches memory through a copy/phi (a pointer-walk loop `p = &g + 2;
          // do { *p++ … }` never makes the add a DIRECT load/store base, which is all the old
          // check saw; the symbol then classified scalar and emitted the bare `g = 0` spelling,
          // which a project declaring `extern u16 g[]` rejects as an incomplete-type assignment).
          for (const o of op.operands) {
            const s2 = gaddrSym(o);
            if (s2) {
              bumpAgg(s2);
            }
          }
        } else if (op.opcode === 'aload' || op.opcode === 'astore') {
          const s = gaddrSym(op.operands[0]);
          if (s) {
            bumpAgg(s);
          }
        }
      }
    }
    for (const [sym, offs] of offsets) {
      if (offs.size === 1 && offs.has(0)) {
        scalarGlobals.add(sym);
      }
    }
    // Declaration-shape OVERRIDE (symbol map): a project-declared array/struct global is an
    // AGGREGATE whatever the usage inference saw — a lone off-0 access to `extern u16 tbl[]`
    // must still spell through the aggregate/array forms, never the bare scalar `tbl`.
    if (symbols) {
      for (const [n, si] of symbols) {
        if (si.shape === 'array' || si.shape === 'struct') {
          scalarGlobals.delete(n);
        }
      }
    }
  }

  // Symbol-map rendering context (memAccess/arrayAccess): shape lookups + the env registry for
  // array-shaped globals actually referenced (they surface as SFn.globals — typed, undeclared).
  const shapedGlobalTypes = new Map<string, IrType>();
  const symCtx: SymRenderCtx | undefined = symbols
    ? { info: (n) => symbols.get(n), noteArray: (n, t) => shapedGlobalTypes.set(n, t) }
    : undefined;

  // --- loop discovery (loops.ts): natural loops via dominator back-edges + the nesting forest ---
  const forest = analyzeLoops(fn, dom);

  // GUARDED self-loop headers (a block that is its own successor, entered through a guard-shaped
  // cond_br) — recovered by the guard-fusion + emitWhile un-rotation path below (the gcc "guard +
  // do-while" → `while` shape; countdown/shifts). UNGUARDED self-loops register as single-block
  // do-whiles in the structured-loop discovery instead. A self-loop's
  // test and update live in ONE block, so the latch test reads the UPDATED value → emitWhile substitutes
  // the back-edge arg back to the header param. This is DISTINCT from a test-at-top multi-block `while`
  // (whileLoops, below) whose header is a pure test read on entry values.
  const loops = new Map<Block, LoopInfo>();
  for (const nl of forest.byHeader.values()) {
    if (!nl.selfLoop) {
      continue;
    } // multi-block loops go through whileLoops
    const b = nl.header;
    const term = b.ops[b.ops.length - 1];
    if (term.opcode !== 'cond_br') {
      continue;
    } // a many-way self-terminator has no single "exit"
    const exit = term.successors.find((s) => s.block !== b)?.block;
    if (!exit) {
      continue;
    }
    // GUARDED self-loops only: some forward pred's cond_br decides "enter b vs its exit" — the
    // shape the guard-fusion + emitWhile un-rotation below consumes. An UNGUARDED self-loop
    // (entered by a plain br / fall-through) is a bottom-tested loop whose body always runs
    // once — a single-block do-while — and is claimed by the structured-loop discovery below
    // instead (each header lives in exactly ONE map, so seeding stays single-pass).
    if (!(preds.get(b) ?? []).some((pr) => isGuardShapedPred(pr, b, exit))) {
      continue;
    }
    const back = successorTo(b, b)!;
    loops.set(b, { header: b, exit, backArgOfParam: b.params.map((_, i) => back.args[i]) });
  }

  // --- structured natural loops (test-at-top `while` / bottom-test `do-while`) ---
  // Both share the fail-closed preconditions: single latch, properly-nested inner loops only,
  // reducible single-entry body, and a SINGLE real (non-ret) exit — early returns (ret-terminated
  // targets) are allowed in-body. The shape then splits on WHERE the exit lives: the HEADER exits
  // (pure test-at-top) → `while`; the LATCH exits (body-first) → `do-while`. Anything that fails
  // declines to plain if-recovery, which re-enters the header and fails loud via `onStack`.
  const isRet = (blk: Block) => blk.ops[blk.ops.length - 1]?.opcode === 'ret';
  // A pure "return trampoline" out of the loop: forward-walking from `start` WITHOUT re-entering the
  // loop `body`, every path terminates in a `ret` and no block on the way carries an OBSERVABLE side
  // effect (store/astore/call/opaque). agbcc/gcc merge every `return` into ONE epilogue block and each
  // return site just sets the return register and branches there — so a second body exit that lands on
  // such a chain is an early RETURN, not a break to a live merge. Structuring it on more than one exit
  // path is sound precisely because it is side-effect-free (a duplicated `return v` is harmless).
  // This lets two returns merged through a shared `bx lr` recover as a `while` with an in-body early
  // `return` instead of declining as "multi-exit".
  const leadsToReturnOnly = (start: Block, body: Set<Block>): boolean => {
    const seen = new Set<Block>();
    const stack = [start];
    while (stack.length) {
      const bb = stack.pop()!;
      if (seen.has(bb)) {
        continue;
      }
      seen.add(bb);
      if (body.has(bb)) {
        return false;
      } // re-enters the loop → not a pure exit
      if (
        bb.ops.some(
          (op) => op.opcode === 'store' || op.opcode === 'astore' || op.opcode === 'call' || op.opcode === 'opaque',
        )
      ) {
        return false;
      }
      const t = bb.ops[bb.ops.length - 1];
      if (t.opcode === 'ret') {
        continue;
      }
      if (t.opcode === 'br' || t.opcode === 'cond_br') {
        for (const s of t.successors) {
          stack.push(s.block);
        }
        continue;
      }
      return false; // switch_br / unknown terminator → decline
    }
    return true;
  };
  const whileLoops = new Map<Block, WhileLoopInfo>();
  const doWhileLoops = new Map<Block, DoWhileInfo>();
  for (const nl of forest.byHeader.values()) {
    const h = nl.header;
    if (nl.selfLoop && loops.has(h)) {
      continue;
    } // guarded self-loops use emitWhile (above); UNGUARDED ones are single-block do-whiles
    if (!nl.selfLoop && nl.latches.length !== 1) {
      continue;
    } // single latch only
    const latch = nl.selfLoop ? h : nl.latches[0];
    // Nested loops: an inner loop whose header sits in this body is fine ONLY if it is PROPERLY
    // nested — its ENTIRE body is contained in ours (a forest descendant). Structuring then recurses
    // naturally: when the outer body reaches the inner header, structureBlock dispatches to the inner's
    // own emitWhile/emitDoWhile. An OVERLAPPING loop (shared blocks, neither containing the other →
    // irreducible) DECLINES. If a contained inner is itself unstructurable, the outer's body
    // structuring loud-fails at the inner back-edge (onStack) — a safe decline, not a miscompile.
    if (
      [...forest.byHeader.keys()].some(
        (h2) => h2 !== h && nl.body.has(h2) && ![...forest.byHeader.get(h2)!.body].every((b) => nl.body.has(b)),
      )
    ) {
      continue;
    }
    // Reducible entry (single-entry): every body block except the header is entered ONLY from
    // inside the body — no jump into the loop interior.
    let reducible = true;
    for (const bb of nl.body) {
      if (bb === h) {
        continue;
      }
      if ((preds.get(bb) ?? []).some((p) => !nl.body.has(p))) {
        reducible = false;
        break;
      }
    }
    if (!reducible) {
      continue;
    }

    // Identify the loop's single STRUCTURAL exit — where the loop-condition sends control when it
    // fails. It may itself be a ret block (a loop ending in `return`), so it CANNOT be found by
    // filtering ret targets (that would hide the exit of every `while(*p){} return q;`). It is the
    // header's non-body edge (test-at-top `while`) or the latch's non-body edge (bottom-test
    // `do-while`). `while` is tried first; `do-while` only when the header keeps BOTH edges in-body.
    const hTerm = h.ops[h.ops.length - 1];
    const lTerm = latch.ops[latch.ops.length - 1];
    const hInBody = hTerm.opcode === 'cond_br' ? hTerm.successors.filter((s) => nl.body.has(s.block)) : [];
    const hOut = hTerm.opcode === 'cond_br' ? hTerm.successors.filter((s) => !nl.body.has(s.block)) : [];
    const lOut = lTerm.opcode === 'cond_br' ? lTerm.successors.filter((s) => !nl.body.has(s.block)) : [];
    // Header purity — the header block is KEPT as the re-evaluated `while` condition, so no
    // store/astore/opaque, and no `call` (expr() inlines a result at every use with no CSE → a call
    // whose result also feeds the body would be evaluated twice per iteration). A `load` is fine —
    // but NOT a materialized one: its temp assignment renders only via sideEffects(), which a
    // condition-only header never emits, so its uses would read an unassigned variable.
    const headerPure = !h.ops.some(
      (op) =>
        op.opcode === 'store' ||
        op.opcode === 'astore' ||
        op.opcode === 'opaque' ||
        op.opcode === 'call' ||
        materialize.has(op),
    );

    let exitFrom: Block,
      exit: Block,
      kind: 'while' | 'dowhile',
      bodyEntry: Block | null = null;
    if (!nl.selfLoop && hTerm.opcode === 'cond_br' && hInBody.length === 1 && hOut.length === 1 && headerPure) {
      kind = 'while';
      exitFrom = h;
      exit = hOut[0].block;
      bodyEntry = hInBody[0].block;
    } else if (lTerm.opcode === 'cond_br' && lOut.length === 1 && lTerm.successors.some((s) => s.block === h)) {
      // a SELF-loop always lands here: its ops run before its bottom test (body-first), so the
      // faithful spelling is `do { ops; updates } while (cond)` with header === latch
      kind = 'dowhile';
      exitFrom = latch;
      exit = lOut[0].block;
    } else {
      continue; // neither a clean pre-tested nor bottom-tested single-exit shape
    }
    // Single loop exit (ret-aware): the chosen exit is the ONE real exit; every OTHER edge leaving
    // the body must be an early `return` — a ret-terminated target OR a pure return-trampoline chain
    // (agbcc's merged epilogue; `leadsToReturnOnly`). A second exit that lands on a LIVE non-return
    // merge is a genuine `break`/second structured exit → decline.
    if (
      nl.exitEdges.some(
        (e) => !(e.from === exitFrom && e.to === exit) && !isRet(e.to) && !leadsToReturnOnly(e.to, nl.body),
      )
    ) {
      continue;
    }

    if (kind === 'while') {
      whileLoops.set(h, {
        header: h,
        bodyEntry: bodyEntry!,
        exit,
        latch,
        forwardPreds: nl.forwardPreds,
        body: nl.body,
      });
    } else {
      doWhileLoops.set(h, { header: h, latch, exit, forwardPreds: nl.forwardPreds, body: nl.body });
    }
  }

  // --- coalesce SSA values to variable names ---
  const varName = new Map<Value, string>();
  const varType = new Map<string, IrType>();
  // Global symbols referenced by name (agbcc pool `.word gSym`, lowered by the global read/write
  // paths below). They print as bare `gSym`, declared by the project headers — so they are
  // EXCLUDED from the emitted local declarations (localNames below).
  const globalNames = new Set<string>();
  const entry = fn.blocks[0];
  entry.params.forEach((p, i) => {
    varName.set(p, `a${i}`);
    varType.set(`a${i}`, p.type);
  });
  const backArgName = new Map<Value, string>();
  // The C static type of a rendered expression, over the declared variable types — what decides
  // whether a memory access's base may be dereferenced as spelled (memAccess/arrayAccess).
  const ctype = (e0: Expr): IrType | undefined => exprCType(e0, (n) => varType.get(n));
  let fresh = 0;
  // Materialized defs are named FIRST: the temp is the register the compiler held the
  // value in, so downstream coalescing (loop inits, merge params) may adopt it — subject to the
  // same interference check as any other name.
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (materialize.has(op)) {
        const r = op.results[0];
        const name = `v${fresh++}`;
        varName.set(r, name);
        varType.set(name, r.type);
      }
    }
  }
  // Interference check: may block-param `p` of block B adopt `name`? The in-edge copies into
  // `name` execute just before B, and inside/after B the name means p — so it is a silent
  // clobber if ANY other value already under that name is still LIVE at B's entry (the textbook
  // "two live values merged into one variable"), or if a SIBLING param of B claimed it (one
  // edge would then write the name twice).
  //
  // AND THE CONVERSE: the name must not be WRITTEN anywhere `p` itself is live. Every other
  // block param under the name is such a write — its in-edge copies execute at each
  // predecessor's end, and a LOOP header's update copy is emitted inside the loop body, where it
  // also runs on the final (exiting) iteration — so the test is `p` live into the writer's block
  // OR live out of any of its predecessors (the conservative union covers that placement). A
  // materialized def under the name writes at its own block. This applies even to a
  // redundant-phi alias (`pureAlias` waives only the value-at-B check: aliasing is sound at B's
  // entry, but a later write to the shared name still splits them — e.g. a saved pre-increment
  // `i` read post-loop).
  const paramBlock = new Map<Value, Block>();
  for (const blk of fn.blocks) {
    for (const pv of blk.params) {
      paramBlock.set(pv, blk);
    }
  }
  const canTakeName = (p: Value, B: Block, name: string, pureAlias = false): boolean => {
    if (B.params.some((q) => q !== p && varName.get(q) === name)) {
      return false;
    }
    const lin = liveIn.get(B)!;
    for (const [v, n] of varName) {
      if (n !== name || v === p) {
        continue;
      }
      if (!pureAlias && lin.has(v)) {
        return false;
      } // v still live at B → p's copies clobber it
      const wblk = paramBlock.get(v);
      if (wblk && wblk !== entry) {
        // v is a param → `name` written at wblk's edges
        if (liveIn.get(wblk)!.has(p)) {
          return false;
        }
        for (const pr of preds.get(wblk) ?? []) {
          for (const s of successorsOf(pr)) {
            if (liveIn.get(s)!.has(p)) {
              return false;
            }
          }
        }
      }
      const d = defs.get(v);
      if (d && materialize.has(d) && liveIn.get(opBlock.get(d)!)!.has(p)) {
        return false;
      }
    }
    return true;
  };
  // ONE seeding routine for self-loop and structured-loop headers. On a coalesceLoopInit target,
  // keep the induction variable in its entry (forward-edge) value's register — reproducing a
  // compiler that mutates the arg register across the loop instead of copying to a fresh local,
  // so the init copy vanishes. The loop mutates the adopted name every iteration — canTakeName
  // declines it when any value under it is still live at the header. `exclude` are names never to
  // adopt (enclosing loops' induction vars — the cross-level collision below); every seeded
  // param's name is ADDED to it, so sibling params can't collapse.
  const seedLoopParams = (
    header: Block,
    forwardPreds: Block[],
    backArgs: readonly Value[] | null,
    exclude: Set<string>,
  ): void => {
    header.params.forEach((p, i) => {
      if (!varName.has(p)) {
        let name: string | undefined;
        if (coalesceLoopInit) {
          for (const fp of forwardPreds) {
            const nm = varName.get(successorTo(fp, header)?.args[i] as Value);
            if (nm && !exclude.has(nm) && canTakeName(p, header, nm)) {
              name = nm;
              break;
            }
          }
        }
        name ??= `v${fresh++}`;
        varName.set(p, name);
        if (!varType.has(name)) {
          varType.set(name, p.type);
        }
      }
      exclude.add(varName.get(p)!);
      if (backArgs) {
        backArgName.set(backArgs[i], varName.get(p)!);
      }
    });
  };
  // Self-loop headers seed FIRST, with an EMPTY exclusion set. KNOWN GAP: a nested self-loop
  // (a guard-fused inner loop inside a structured loop DOES structure) seeds before the
  // enclosing loop's induction name exists to exclude — the outermost-first discipline below
  // does not cover this ordering. canTakeName's liveness/write-site checks are the only guard
  // against a cross-level name adoption here.
  for (const li of loops.values()) {
    const fwdPreds = (preds.get(li.header) ?? []).filter((pr) => pr !== li.header);
    seedLoopParams(li.header, fwdPreds, li.backArgOfParam, new Set());
  }
  // Seed structured-loop (`while`/`do-while`) header params: same discipline as self-loops. On
  // coalesceLoopInit, keep the loop variable in its forward-edge (init) register; else a fresh local
  // (agbcc copies the init to a new reg). Never reuse a name already taken by a SIMULTANEOUSLY-LIVE
  // sibling header param — two loop-carried values seeded from one source must not collapse (a silent
  // clobber). The latch's back-edge arg carries the param's name so the loop update assigns it.
  const structuredLoops = [
    ...[...whileLoops.values()].map((l) => ({
      header: l.header,
      latch: l.latch,
      forwardPreds: l.forwardPreds,
      body: l.body,
    })),
    ...[...doWhileLoops.values()].map((l) => ({
      header: l.header,
      latch: l.latch,
      forwardPreds: l.forwardPreds,
      body: l.body,
    })),
  ];
  // Cross-level collision: with nesting, an outer loop's induction variable is LIVE across the inner
  // loop (the outer latch reads it after). If the inner var is coalesced onto the outer var's name
  // (its init reads the outer var), the inner loop would MUTATE the outer variable — a silent
  // miscompile. Process OUTERMOST-first (so an enclosing loop is named first) and, per loop, exclude
  // the names of every enclosing loop's header params from the coalescing candidates.
  // `enclosingNames(l)` = names of params of headers whose natural body strictly contains `l.header`.
  structuredLoops.sort((a, b) => b.body.size - a.body.size); // outermost first
  const enclosingNames = (l: { header: Block; body: Set<Block> }): Set<string> => {
    const names = new Set<string>();
    for (const nl2 of forest.byHeader.values()) {
      if (nl2.header !== l.header && nl2.body.has(l.header)) {
        // nl2 strictly encloses l
        for (const p of nl2.header.params) {
          const nm = varName.get(p);
          if (nm) {
            names.add(nm);
          }
        }
      }
    }
    return names;
  };
  for (const l of structuredLoops) {
    const back = successorTo(l.latch, l.header);
    // exclusion seeded with enclosing-loop names → never coalesce onto them
    seedLoopParams(l.header, l.forwardPreds, back ? back.args : null, enclosingNames(l));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of fn.blocks) {
      if (b === entry) {
        continue;
      }
      b.params.forEach((p, i) => {
        if (varName.has(p)) {
          return;
        }
        // EVERY in-edge record, not successorTo (which returns only the FIRST record to `b` — a
        // terminator with two edges to the same block would hide the second edge's args here).
        const incoming: Value[] = [];
        for (const pr of new Set(preds.get(b) ?? [])) {
          for (const s of pr.ops[pr.ops.length - 1].successors) {
            if (s.block === b) {
              incoming.push(s.args[i]);
            }
          }
        }
        // A redundant phi (every edge passes the SAME value) is a pure alias of it — sharing the
        // name is sound even while the value stays live (they are equal on every path). This
        // waives only the LIVENESS half of canTakeName; the sibling-param check always applies.
        const allSame = incoming.length > 0 && incoming.every((v) => v === incoming[0]);
        // prefer a carrier that already has a name; then a loop var whose update this receives —
        // but only one whose name survives the C3 interference check (else the edge copies into
        // the name would clobber a still-live value).
        let name: string | undefined;
        for (const c of [...incoming.filter((v) => varName.has(v)), ...incoming.filter((v) => backArgName.has(v))]) {
          const nm = varName.get(c) ?? backArgName.get(c)!;
          if (canTakeName(p, b, nm, allSame)) {
            name = nm;
            break;
          }
        }
        name ??= `v${fresh++}`;
        varName.set(p, name);
        if (!varType.has(name)) {
          varType.set(name, p.type);
        }
        changed = true;
      });
    }
  }

  // An unresolvable value: strict mode keeps the `"?"` sentinel (assertResolved trips at the
  // boundary — loud in the PROCESS); annotate mode emits a marker (the undefined ASMLIFT_ERROR
  // symbol — loud in the ARTIFACT, function still complete).
  const mkGap = (reason: string, args: Expr[]): Expr =>
    onGap === 'annotate' ? { k: 'marker', reason, args } : { k: 'var', name: '?' };

  // Lower ONE def's operation to an Expr, rendering operands through `e`. Shared between the
  // inline-at-use path (exprWith) and the materialized-temp path (sideEffects), so both spell a
  // given op identically.
  const lowerDef = (d: Op, e: (v: Value) => Expr): Expr => {
    if (d.opcode === 'const') {
      return { k: 'const', value: d.attrs.value as number };
    }
    if (CMP_TO_BIN[d.opcode]) {
      // A bare global address `&gSym` as a COMPARISON operand is the same unspelled escape as the
      // arithmetic case below (see intifyAddr): its C type comes from the PROJECT's own
      // declaration, unknowable here. Worse, the compare's SIGNEDNESS lives in the operand types
      // (CMP_TO_BIN maps icmp_ult and icmp_slt to the same '<'), so leaving `&gSym` untyped lets
      // the project's declaration pick the compare the compiler emits — silently byte-inexact
      // whenever it disagrees with the asm. The honest spelling is integer math on the address
      // with the cast AGREEING with the opcode's signedness: unsigned compares (and the
      // sign-agnostic ==/!=) spell `(u32)&gSym`, signed compares `(s32)&gSym` — exactly the
      // compare the asm did. The deref folds never see a compare operand, so no named spelling is
      // lost; a NARROWING cast (`(u8)&gSym`) is not a bare `addr` and keeps its truncation.
      // SCOPE (adversarial review): this closes the hole for BARE addr operands only. An
      // addr-carrying arithmetic tree (`(u32)&gSym + 4`, spelled by intifyAddr below) under an
      // icmp_s* still compares unsigned in C (u32 wins the usual-arithmetic-conversions) — the
      // same pre-existing wrongness the old ptr-vs-int spelling had, surfacing as a scoring
      // nonmatch, never a silent regression of a formerly-correct compare. Rare shape; an outer
      // signed cast on addr-carrying trees is the follow-up if it ever costs a row.
      const t = /^icmp_s/.test(d.opcode) ? T.s(32) : T.u(32);
      const intifyAddrCmp = (x: Expr): Expr => (x.k === 'addr' ? { k: 'cast', to: t, e: x } : x);
      return {
        k: 'bin',
        op: CMP_TO_BIN[d.opcode],
        l: intifyAddrCmp(e(d.operands[0])),
        r: intifyAddrCmp(e(d.operands[1])),
      };
    }
    if (ARITH_TO_BIN[d.opcode]) {
      let l = e(d.operands[0]);
      let r = d.operands.length === 2 ? e(d.operands[1]) : ({ k: 'const', value: d.attrs.imm as number } as Expr);
      // Pointer stride: C pointer arithmetic is ELEMENT-scaled, but the asm added a BYTE
      // constant — `addi p,4` on an `s32*` walks 1 element, yet C `p + 4` walks 4. Divide the byte
      // constant by the pointee size so the walk recompiles to the same address math.
      //
      // Keyed on the operand's RENDERED C type, never the IR value's recovered type: C scales by
      // the type of the expression it actually sees, and the two diverge exactly like memAccess's
      // deref bases (a value recovered `s32*` can render as an int-typed tree — C then does NO
      // element scaling, so pre-dividing the constant would bake in a WRONG address that the
      // deref cast downstream turns into silently-wrong bytes; found by the adversarial round).
      // An int-rendered walk keeps its raw byte constant and derefs through the access-width cast.
      // Fires only for a rendered pointer whose element size (>1) DIVIDES the constant exactly;
      // otherwise raw (a misaligned/struct-array stride is left as-is; a `u8*` is size 1 so
      // unchanged). Since C `(K/es) + p == p + (K/es)`, scaling the const on whichever side it
      // sits fixes the bytes: `add` is commutative so the pointer may be either operand; `sub` is
      // not, so only operand[0] (the minuend) may be the pointer.
      const scale = (t: IrType | undefined, c: Extract<Expr, { k: 'const' }>): Expr => {
        const es = t?.kind === 'ptr' ? ptrElemBytes(t.to) : 0;
        return es > 1 && c.value % es === 0 ? { k: 'const', value: c.value / es } : c;
      };
      if ((d.opcode === 'add' || d.opcode === 'sub') && r.k === 'const') {
        r = scale(ctype(l), r);
      } else if (d.opcode === 'add' && d.operands.length === 2 && l.k === 'const') {
        l = scale(ctype(r), l); // commuted `const + ptr`
      }
      // C rejects a pointer operand outright under the non-additive operators (& | ^ << >> * / %),
      // under `ptr + ptr`, and as the subtrahend of `int - ptr` — the asm just does 32-bit integer
      // math on the address, so the honest spelling is the value cast to its integer self. Only a
      // DEFINITELY-pointer rendering is cast (same conservative direction as memAccess); the
      // additive ops keep C's legal pointer arithmetic untouched.
      const op = ARITH_TO_BIN[d.opcode];
      const intify = (x: Expr): Expr => (ctype(x)?.kind === 'ptr' ? { k: 'cast', to: T.s(32), e: x } : x);
      if (!['+', '-', '&&', '||'].includes(op)) {
        l = intify(l);
        r = intify(r);
      } else if (op === '+' && ctype(l)?.kind === 'ptr' && ctype(r)?.kind === 'ptr') {
        r = intify(r); // ptr + ptr is not C; ptr + (s32)ptr is, with the same bytes
      } else if (op === '-' && ctype(l)?.kind !== 'ptr' && ctype(r)?.kind === 'ptr') {
        r = intify(r); // int - ptr is not C
      }
      // A bare global address `&gSym` under ANY of these operators is never emitted as-is: its C
      // type comes from the PROJECT's own declaration (unknowable here — exprCType types `addr`
      // undefined, so the ptr-keyed intify above never fires on it), which makes `&gSym + K`
      // byte-INEXACT (C scales K by sizeof(gSym)) and `&gSym & K` ill-formed. The honest spelling
      // is integer math on the address — `(u32)&gSym + K`, exactly the arithmetic the asm did.
      // The deref folds (globalOf / globalConstByte, via addrIn) look through this cast, so every
      // access that CAN spell a named element/field still does; only a genuine value-context
      // escape (a call argument, a stored address, a compare) keeps it — previously such an
      // escape tripped assertDerefsTyped's interior-pointer rule and declined the whole function.
      const intifyAddr = (x: Expr): Expr => (x.k === 'addr' ? { k: 'cast', to: T.u(32), e: x } : x);
      l = intifyAddr(l);
      r = intifyAddr(r);
      return { k: 'bin', op, l, r };
    }
    // `-`/`~` on a pointer rendering is equally not C — same honest integer cast as above.
    if (d.opcode === 'rotr' || d.opcode === 'rotl') {
      // The C rotate idiom — `x >> n | x << (32 - n)` (mirrored for rotl). Byte-exact round-trip
      // on agbcc (thumb ror) and mwcc (rotlw/rotlwi), verified against both toolchains before the
      // ops landed. `x` and `n` render twice — both pure by construction (SSA values; the rotate's
      // operands are register reads), and recovery seeds the rotated value unsigned so `>>`
      // spells the logical shift the idiom requires.
      //
      // (The PPC mirror fold — `rotl(x, 32 - m)` ⇒ rotr(x, m) — lives in the PATTERN layer,
      // engine.ts ROTL_MIRROR: it is a compiler-spelling idiom, mwcc-gated there, not a
      // structurer concern.)
      const dir: 'rotr' | 'rotl' = d.opcode;
      const n: Expr = d.operands.length === 2 ? e(d.operands[1]) : { k: 'const', value: d.attrs.imm as number };
      const x = e(d.operands[0]);
      // constant-amount edges: 0 and 32 are the IDENTITY (the C idiom would spell the UB
      // shift-by-32); otherwise a constant folds the complement (`a0 >> 24`, not `a0 >> 32 - 8`).
      if (n.k === 'const' && (n.value === 0 || n.value === 32)) {
        return x;
      }
      const w: Expr =
        n.k === 'const'
          ? { k: 'const', value: 32 - n.value }
          : { k: 'bin', op: '-', l: { k: 'const', value: 32 }, r: n };
      const [near, far] = dir === 'rotr' ? (['>>', '<<'] as const) : (['<<', '>>'] as const);
      return {
        k: 'bin',
        op: '|',
        l: { k: 'bin', op: near, l: x, r: n },
        r: { k: 'bin', op: far, l: x, r: w },
      };
    }
    if (d.opcode === 'neg') {
      const x = e(d.operands[0]);
      return { k: 'un', op: '-', e: ctype(x)?.kind === 'ptr' || x.k === 'addr' ? { k: 'cast', to: T.s(32), e: x } : x };
    }
    if (d.opcode === 'not') {
      const x = e(d.operands[0]);
      return { k: 'un', op: '~', e: ctype(x)?.kind === 'ptr' || x.k === 'addr' ? { k: 'cast', to: T.s(32), e: x } : x };
    }
    // Width-narrowing casts: `zext`/`sext` widen a `width`-bit value back to 32 → C `(u8)e`/`(s8)e`.
    if (d.opcode === 'zext') {
      return { k: 'cast', to: T.int(d.attrs.width as number, false), e: e(d.operands[0]) };
    }
    if (d.opcode === 'sext') {
      return { k: 'cast', to: T.int(d.attrs.width as number, true), e: e(d.operands[0]) };
    }
    if (d.opcode === 'call') {
      return { k: 'call', fn: d.attrs.target as string, args: d.operands.map(e) };
    }
    if (d.opcode === 'gaddr') {
      // A promoted CODE symbol (frontend `code: true`) is a function pointer stored as an
      // integer: spelled `(u32)Name` — the source idiom — never `&Name` (defect G of the
      // dogfood report; the & form compiles but is a different, non-matching spelling).
      if (d.attrs.code === true) {
        return { k: 'cast', to: T.int(32, false), e: { k: 'var', name: d.attrs.sym as string } };
      }
      return { k: 'addr', name: d.attrs.sym as string };
    }
    if (d.opcode === 'load') {
      return memAccess(
        d.operands[0],
        e(d.operands[0]),
        d.attrs.off as number,
        d.attrs.width as number,
        (d.attrs.signed as boolean) ?? false,
        ctype,
        scalarGlobals,
        symCtx,
      );
    }
    // aload carries a runtime index operand (variable-index array access) — `base[index]`, or
    // `base[index].field_K` when it carries a `fieldOff` (array-of-STRUCT element access).
    if (d.opcode === 'aload') {
      return arrayAccess(
        d.operands[0],
        e(d.operands[0]),
        e(d.operands[1]),
        d.attrs.fieldOff as number | undefined,
        d.attrs.elemSize as number,
        (d.attrs.signed as boolean) ?? false,
        ctype,
        symCtx,
      );
    }
    return d.opcode === 'opaque'
      ? mkGap(`unmodelled instruction '${(d.attrs.mnemonic as string) ?? '?'}'`, d.operands.map(e))
      : mkGap(`no lowering for op '${d.opcode}'`, d.operands.map(e));
  };

  const exprWith = (sub: Map<Value, string> | null) => {
    const e = (v: Value): Expr => {
      const subbed = sub?.get(v);
      if (subbed) {
        return { k: 'var', name: subbed };
      }
      if (varName.has(v)) {
        return { k: 'var', name: varName.get(v)! };
      }
      const d = defs.get(v);
      if (!d) {
        return mkGap('value has no reaching definition (dropped def)', []);
      }
      return lowerDef(d, e);
    };
    return e;
  };
  // The loop-emission hazard checks (readsClobbered / loopEscapeHazard / loopUpdateHazard) —
  // pure decline-or-emit predicates, extracted to hazards.ts behind the explicit-deps factory.
  // `varName` is captured as a live reference: it is still being populated here in the naming
  // pipeline, and each check reads the names that exist when EMISSION calls it.
  const { loopUpdateHazard } = makeLoopHazards({ defs, varName, useSitesOf });

  // A POST-LOOP substitution active while structuring a loop's exit region: a loop-carried value (a
  // latch back-edge arg) is held in its loop-variable NAME after the loop, so any post-loop use must
  // read the name, not re-inline the computation (which would double-count, e.g. `(u8)(v1+1)` instead
  // of `v1`). `expr` consults it; `withSub` installs/merges it around the exit region. Null normally.
  let activeSub: Map<Value, string> | null = null;
  const expr = (v: Value): Expr => exprWith(activeSub)(v);
  const withSub = <R>(sub: Map<Value, string>, run: () => R): R => {
    const prev = activeSub;
    activeSub = prev ? new Map([...prev, ...sub]) : sub;
    try {
      return run();
    } finally {
      activeSub = prev;
    }
  };

  // Assignments a predecessor must perform when branching into `target`, as a PARALLEL
  // copy (skip identities), then sequentialised so no assignment clobbers a still-needed
  // value. `sub` (used for the emitWhile un-rotation's exit copies) substitutes back-edge args to
  // their header-param NAMES — post-loop the params already hold their updated values, so a merged
  // exit value is read as `v` not `v-1`.
  const tempCounter = { n: 0 }; // per-function swap-cycle temp names (sequentialize)
  // The copies for ONE specific successor record — the workhorse behind argAssigns, taken
  // directly by the switch_br path, whose duplicate case targets successorTo cannot
  // disambiguate.
  const argAssignsFor = (
    pred: Block,
    succ: { block: Block; args: Value[] },
    sub: Map<Value, string> | null = null,
  ): Stmt[] => {
    const target = succ.block;
    const argExpr = sub ? exprWith(sub) : expr;
    const copies: { name: string; value: Expr; arg: Value }[] = [];
    target.params.forEach((p, i) => {
      const name = varName.get(p)!;
      const arg = succ.args[i];
      if ((sub?.get(arg) ?? varName.get(arg)) === name) {
        return;
      } // identity copy — coalesced away
      copies.push({ name, value: argExpr(arg), arg });
    });
    // Emit in the order the args are COMPUTED in `pred` — a compiler that lays the defining ops
    // (and thus the copies that read them) out in that order matches with no spurious arg-swap.
    // This is a per-compiler behavior (orderArgCopiesByComputation), not a universal: a compiler
    // that emits copies in source/param order sets it false. Dependency ordering (sequentialize)
    // still has the final say regardless.
    if (orderArgCopiesByComputation) {
      // opIndex is only valid for a def IN this block; a def elsewhere keeps indexOf's -1 (sorts first).
      const pos = (v: Value) => {
        const d = defs.get(v);
        return d && opBlock.get(d) === pred ? opIndex.get(d)! : -1;
      };
      copies.sort((a, b) => pos(a.arg) - pos(b.arg));
    }
    return sequentialize(
      copies.map(({ name, value }) => ({ name, value })),
      varType,
      tempCounter,
      fn.name,
    );
  };
  const argAssigns = (pred: Block, target: Block, sub: Map<Value, string> | null = null): Stmt[] => {
    const succ = successorTo(pred, target);
    return succ ? argAssignsFor(pred, succ, sub) : [];
  };

  // Side-effecting ops of a block, emitted as statements in program order: memory stores,
  // calls whose return value nothing consumes (a void/discarded call), and MATERIALIZED defs
  // — a call/load whose value cannot soundly render at its use is assigned to its named
  // temp here, at its own program position.
  const sideEffects = (b: Block): Stmt[] => {
    const out: Stmt[] = [];
    for (const op of b.ops) {
      if (op.opcode === 'store') {
        // A store whose lvalue is a bare global (`gSym = v`, from an `&gSym` base at off 0) emits
        // as an ASSIGN, not a store — memAccess returns a `var` node for that case.
        const width = op.attrs.width as number;
        const lval0 = memAccess(
          op.operands[0],
          expr(op.operands[0]),
          op.attrs.off as number,
          width,
          width === 4,
          ctype,
          scalarGlobals,
          symCtx,
        );
        if (lval0.k === 'var') {
          globalNames.add(lval0.name);
          out.push({ k: 'assign', name: lval0.name, value: expr(op.operands[1]) });
          continue;
        }
        // signedness mirrors recoverTypes' store seed (word ⇒ signed, narrow ⇒ unsigned), so an
        // inserted cast declares the same scalar the recovered pointee would have.
        out.push({ k: 'store', lval: lval0, value: expr(op.operands[1]) });
      } else if (op.opcode === 'astore') {
        const elemSize = op.attrs.elemSize as number;
        out.push({
          k: 'store',
          lval: arrayAccess(
            op.operands[0],
            expr(op.operands[0]),
            expr(op.operands[1]),
            op.attrs.fieldOff as number | undefined,
            elemSize,
            elemSize === 4,
            ctype,
            symCtx,
          ),
          value: expr(op.operands[2]),
        });
      } else if (op.opcode === 'call' && op.results.length && !useSitesOf.has(op.results[0])) {
        out.push({ k: 'exprstmt', value: expr(op.results[0]) });
      } else if (materialize.has(op)) {
        out.push({ k: 'assign', name: varName.get(op.results[0])!, value: lowerDef(op, expr) });
      }
    }
    return out;
  };

  // Blocks currently on the recursion stack. A well-formed reducible CFG structures each
  // block at most once per active path, so re-entering a block already on the stack means an
  // unrecovered back-edge (a cycle loop-recovery didn't lower) — which would recurse forever.
  // Bail explicitly instead. This also bounds recursion depth by the block count.
  const onStack = new Set<Block>();
  // do-while headers currently being emitted — so structuring the do-while's own body (which re-enters
  // the header block to structure its ops up to the latch) does not re-trigger the do-while hook.
  const dwActive = new Set<Block>();
  // The innermost loop whose BODY is currently being structured. A body cond_br with one edge back
  // to `header` is a conditional continue; its other edge, when it leaves the loop, is an early exit
  // (a `break` to `exit`, or an early `return` through a trampoline). Null outside any loop body —
  // the early-exit branch in structureBlock is inert there.
  type LoopFrame = { header: Block; exit: Block; body: Set<Block> };
  let loopCtx: LoopFrame | null = null;
  const withLoop = <R>(frame: LoopFrame, run: () => R): R => {
    const prev = loopCtx;
    loopCtx = frame;
    try {
      return run();
    } finally {
      loopCtx = prev;
    }
  };

  const structureRegion = (b: Block, stop: Block | null): Stmt[] => {
    if (b === stop) {
      return [];
    }
    if (onStack.has(b)) {
      throw new StructureError(
        `cannot structure '${fn.name}': unrecovered back-edge into block #${fn.blocks.indexOf(b)} ` +
          `(loop-recovery declined this shape: multi-latch, irreducible/overlapping loops, ` +
          `a conditional continue, or an unsafe break)`,
      );
    }
    onStack.add(b);
    try {
      return structureBlock(b, stop);
    } finally {
      onStack.delete(b);
    }
  };

  // ── Regime-A switch recovery (structure/switch-recover.ts): the recognizer's case bodies call
  // back into structureRegion, and Regime B (switch_br, below) shares its fall-through predicate.
  const { recognizeSwitch, caseRegionReachesSibling } = makeSwitchRecovery({
    fn,
    defs,
    dom,
    ipdom,
    opBlock,
    isNamed: (v) => varName.has(v),
    isCmpOpcode: (opcode) => !!CMP_TO_BIN[opcode],
    switchAllowsNeqCase,
    expr: (v) => expr(v),
    structureRegion: (b, stop) => structureRegion(b, stop),
  });

  const structureBlock = (b: Block, stop: Block | null): Stmt[] => {
    // Bottom-test `do-while`: this block is a do-while header (the body-first loop entry). Emit the
    // do-while — its body includes `b`'s own ops (structured via structureRegion with the hook masked),
    // so do NOT emit sideEffects(b) here. The init was already emitted by the predecessor's argAssigns.
    const dw = doWhileLoops.get(b);
    if (dw && !dwActive.has(b)) {
      return emitDoWhile(dw, stop);
    }

    const out: Stmt[] = [...sideEffects(b)];
    const term = b.ops[b.ops.length - 1];
    if (term.opcode === 'ret') {
      // A void function's `bx lr` leaves whatever in r0; suppress that phantom return value.
      out.push({ k: 'return', value: returnsVoid || !term.operands.length ? undefined : expr(term.operands[0]) });
      return out;
    }
    if (term.opcode === 'br') {
      const target = term.successors[0].block;
      out.push(...argAssignsFor(b, term.successors[0]));
      out.push(...structureRegion(target, stop));
      return out;
    }
    // Regime B: a `switch_br` (jump-table dispatch) lowers directly to the `switch` node — scrutinee,
    // per-successor case value, last successor = default. Case bodies delegate to structureRegion (as in
    // Regime A). Fall-through between jump-table cases is not yet handled: if a case body reaches another
    // case/default block inside the region, fail LOUD rather than duplicate it.
    if (term.opcode === 'switch_br') {
      const merge = ipdom.get(b) ?? stop;
      const succ = term.successors;
      const caseVals = term.attrs.cases as number[];
      const targets = new Set<Block>(succ.map((s) => s.block));
      if (caseRegionReachesSibling(targets, b, merge)) {
        throw new StructureError(
          `cannot structure '${fn.name}': fall-through between jump-table cases is not yet supported`,
        );
      }
      // Switch edges CARRY phi args (frontend/ssa.ts appends them terminator-generically) — each
      // case/default body must open with its edge's copies, exactly as cond_br edges do; dropping
      // them leaves the target's params uninitialized on the switch path. Two case values sharing
      // a target must agree on their args (else the copies are ambiguous → loud decline); the
      // shared body is then structured per case entry.
      const argsSeen = new Map<Block, Value[]>();
      for (const s of succ) {
        const prev = argsSeen.get(s.block);
        if (prev && (prev.length !== s.args.length || prev.some((v, i) => v !== s.args[i]))) {
          throw new StructureError(
            `cannot structure '${fn.name}': jump-table cases share a target block with differing phi args`,
          );
        }
        argsSeen.set(s.block, s.args as Value[]);
      }
      const outCases: SwitchCase[] = succ.slice(0, -1).map((s, i) => ({
        values: [caseVals[i]],
        body: [...argAssignsFor(b, s), ...structureRegion(s.block, merge)],
        fallsThrough: false,
      }));
      const sw: Stmt = {
        k: 'switch',
        scrutinee: expr(term.operands[0]),
        cases: outCases,
        default: [...argAssignsFor(b, succ[succ.length - 1]), ...structureRegion(succ[succ.length - 1].block, merge)],
      };
      out.push(sw);
      if (merge && merge !== stop) {
        out.push(...structureRegion(merge, stop));
      }
      return out;
    }
    // Everything below assumes a 2-way `cond_br`. Any OTHER terminator (a malformed op) must fail LOUD
    // here — otherwise it is silently read as a `cond_br` and every successor past the second is dropped,
    // a silent control-flow miscompile at the structuring seam.
    if (term.opcode !== 'cond_br') {
      throw new StructureError(
        `cannot structure '${fn.name}': unsupported terminator '${term.opcode}' in block #${fn.blocks.indexOf(b)} ` +
          `(only ret / br / cond_br / switch_br are structured today)`,
      );
    }
    // cond_br: successors = [taken, fallthrough]
    const takenB = term.successors[0].block;
    const fallB = term.successors[1].block;

    // Test-at-top `while`: this block IS a loop header whose pure test decides body-vs-exit. The
    // header test is the loop condition (read on entry values); the body is a region that stops at the
    // header (= continue). The init was already emitted by the predecessor's argAssigns into `b`.
    const wl = whileLoops.get(b);
    if (wl) {
      out.push(...emitTestAtTopWhile(wl, stop));
      return out;
    }

    // guard-fused loop: this cond_br decides "enter loop header h vs its exit". Emit the
    // inits unconditionally, then a while whose own test subsumes this guard. Never fuse when `b`
    // is itself the header (a guard-LESS single-block do-while would emit the update once before a
    // wrongly-`while` loop) — require a DISTINCT dominating guard block.
    for (const h of [takenB, fallB]) {
      const li = loops.get(h);
      if (li && h !== b && (takenB === li.exit || fallB === li.exit)) {
        // A MATERIALIZED header op's temp is assigned only inside the body (sideEffects), but the
        // un-rotated `while` condition renders BEFORE the body ever ran — reading the temp
        // uninitialized on the first test. Mirror of the headerPure gate: decline loud.
        if (li.header.ops.some((o) => materialize.has(o))) {
          throw new StructureError(
            `cannot structure '${fn.name}': loop header holds a materialized def its condition would read uninitialized`,
          );
        }
        // Self-loop emitter hazards: the while condition, the header→exit args, and every
        // post-loop use of a header-computed value render under the un-rotation sub — sound only
        // when their loop-variable reads go through sub-mapped back-edge args (post-update). A
        // direct read of an updated variable is a PRE-update value the emitted name no longer
        // holds → decline LOUD, never emit wrong code.
        const sub = loopSub(li);
        const updates = argAssigns(li.header, li.header);
        const updateWrites = updateWriteSet(updates);
        const hterm = li.header.ops[li.header.ops.length - 1];
        const hexitArgs = (successorTo(li.header, li.exit)?.args ?? []) as Value[];
        if (
          loopUpdateHazard(
            hterm.operands[0],
            hexitArgs,
            new Set([li.header]),
            sub,
            updateWrites,
            null,
            new Set(li.header.params),
          )
        ) {
          throw new StructureError(
            `cannot structure '${fn.name}': loop condition or a post-loop value reads a pre-update loop variable`,
          );
        }
        out.push(...argAssigns(b, h)); // loop-variable initialisation
        out.push(emitWhile(li, updates));
        // The header→exit edge may carry non-identity phi args (the exit param merges the guard-false
        // value with the loop's final value). Emit those copies after the loop — dropping them returns
        // a stale value. Read under the un-rotation substitution (post-loop the params hold their
        // updated values), and structure the exit region under the same substitution so a post-loop
        // use of a loop value reads its name.
        out.push(...withSub(sub, () => [...argAssigns(li.header, li.exit, sub), ...structureRegion(li.exit, stop)]));
        return out;
      }
    }

    // Conditional latch / in-body early exit: one edge of this cond_br is the loop back-edge (a
    // continue to `loopCtx.header`); the other LEAVES the loop. When the leaving edge lands on the
    // loop's own exit block it is a `break`; when it trampolines to a `return` it is an early `return`.
    // Emit the loop update (the back-edge args, RAW) then a single `if (leaveCond) { <exit arm> }` — the
    // back-edge arm is the implicit continue (control falls to the loop bottom). Guarded to leaving
    // edges only (`!body.has(exitB)` AND a break/return target); an in-body conditional continue still
    // declines (falls through → the header re-entry trips `onStack`, an honest loud fail).
    if (loopCtx && (takenB === loopCtx.header || fallB === loopCtx.header)) {
      const contIsTaken = takenB === loopCtx.header;
      const exitB = contIsTaken ? fallB : takenB;
      const isBreak = exitB === loopCtx.exit;
      // SOUNDNESS (break-clobber): a structured `break` jumps to AFTER the loop, where the header→exit
      // phi copies are emitted (emitTestAtTopWhile / emitDoWhile). If those copies are NON-identity, the
      // break path would fall through them and CLOBBER the value the break carried into the exit param.
      // Only emit `break` for a WHILE header whose header→exit copy is empty (the exit param already
      // coalesces across both edges); otherwise decline (fall through → honest loud fail). A do-while
      // `break` declines here (its exit copies live post-loop too, but the check differs) — the
      // return-trampoline path below still serves both. Trampolines are immune (the `return` terminates
      // the arm, so nothing falls through).
      const breakSafe = whileLoops.has(loopCtx.header) && argAssigns(loopCtx.header, loopCtx.exit).length === 0;
      // The back-edge substitution: each header param's back-edge arg → the param's name, so a test that
      // reads a POST-update value (the value carried to the header) shows the header var name.
      const sub = subFor(loopCtx.header.params, successorTo(b, loopCtx.header)!.args);
      // SOUNDNESS (pre-update-read hazard): the loop update (`argAssigns(b, header)`) is emitted
      // BEFORE the exit test/args. If the test or an exit arg reads a PRE-update value of an
      // induction variable (a body/header param, NOT a back-edge arg) whose coalesced name the
      // update overwrites, the emitted C would read the post-update value → a silent miscompile
      // (break/return fires on the wrong value; e.g. a test on `v0` where the update did
      // `v0 = v0 - 1`). Back-edge args (in `sub`) are the INTENDED post-update reads and are safe.
      // `readsClobbered` distinguishes the two at the VALUE level; on a hazard, decline (fall
      // through → honest loud fail) rather than emit wrong code.
      const updateCopies = argAssigns(b, loopCtx.header);
      const updateWrites = updateWriteSet(updateCopies);
      const exitArgs = (successorTo(b, exitB)?.args ?? []) as Value[];
      // The exit ARM may also read loop-body-computed values directly (an exitB dominated by `b`
      // — e.g. its `ret` operand), not just through edge args: apply the same escape test to the
      // arm's region (blocks reachable from exitB outside the loop body).
      const exitRegion = new Set([exitB, ...reachFrom(exitB)].filter((x) => !loopCtx!.body.has(x)));
      const hazard = loopUpdateHazard(
        term.operands[0],
        exitArgs,
        loopCtx.body,
        sub,
        updateWrites,
        exitRegion,
        new Set(loopCtx.header.params),
      );
      if (
        !hazard &&
        !loopCtx.body.has(exitB) &&
        ((isBreak && breakSafe) || (!isBreak && leadsToReturnOnly(exitB, loopCtx.body)))
      ) {
        out.push(...updateCopies); // the loop update, RAW (i++, p>>=1, …)
        let leaveCond = exprWith(sub)(term.operands[0]);
        if (contIsTaken) {
          leaveCond = negate(leaveCond);
        } // continue is `taken` → leave when NOT it
        const exitArm = isBreak
          ? [...argAssigns(b, loopCtx.exit, sub), { k: 'break' } as Stmt] // break to the loop exit
          : withSub(sub, () => [...argAssigns(b, exitB, sub), ...structureRegion(exitB, stop)]); // early return
        out.push(mkIf(leaveCond, exitArm, []));
        return out;
      }
    }

    // Regime-A switch: if this cond_br roots a comparison tree over a single scrutinee, emit a
    // `switch`. A pre-check here — mirroring the guard-fused-loop check above — so it sees the raw
    // tree before if-recovery claims the diamonds. Declines (null) fall through to plain if-recovery.
    const asSwitch = recognizeSwitch(b, stop);
    if (asSwitch) {
      out.push(...asSwitch);
      return out;
    }

    const cond = expr(term.operands[0]);
    const ipd = ipdom.get(b) ?? null; // null ⇒ the arms diverge (both reach EXIT), no join
    const merge = ipd ?? stop;
    // Per-successor records, NOT successorTo(b, block): a cond_br whose two edges reach the SAME
    // block with different args would otherwise give both arms the first edge's copies.
    const thenS = [...argAssignsFor(b, term.successors[0]), ...structureRegion(takenB, merge)];
    const elseS = [...argAssignsFor(b, term.successors[1]), ...structureRegion(fallB, merge)];
    if (ipd === null && thenS.length && elseS.length && preserveDivergentBranchSense) {
      // Divergent arms (both terminate — no reconvergence). The asm branched forward to the
      // `taken` block and fell through to `fall`; a compiler that PRESERVES source branch direction
      // re-emits that as a forward branch on the NEGATED condition to the else-arm, so putting the
      // taken arm as `else` (and negating) reproduces the original branch sense. Byte-exact on
      // IDO/MIPS; agbcc/GCC canonicalise either way, so it is safe there too. A compiler that
      // inverts branch canonicalization sets preserveDivergentBranchSense false and falls through
      // to the positive form below.
      out.push({ k: 'if', cond: negate(cond), then: elseS, else: thenS });
      return out;
    }
    out.push(mkIf(cond, thenS, elseS));
    if (merge && merge !== stop) {
      out.push(...structureRegion(merge, stop));
    }
    return out;
  };

  // The un-rotation / back-edge substitution: each header param's back-edge arg → the param's
  // name, so a latch test (and exit copies) reads the post-update value under the param's name.
  // ONE builder for all three loop emitters (self-loop, do-while, early-exit).
  const subFor = (params: Value[], backArgs: Value[]): Map<Value, string> => {
    const sub = new Map<Value, string>();
    params.forEach((p, i) => sub.set(backArgs[i], varName.get(p)!));
    return sub;
  };
  const loopSub = (li: LoopInfo): Map<Value, string> => subFor(li.header.params, li.backArgOfParam);

  // Un-rotate a header's do-while latch into a `while`: the test reads the header's own
  // params (back-edge args substituted back), and the body is the header's SIDE EFFECTS in
  // program order followed by its parallel update. The side effects are required — a copies-only
  // body would silently delete every store/discarded call in the header. Effect order is right by
  // construction: statements read pre-update names, the updates land after.
  const emitWhile = (li: LoopInfo, updates?: Stmt[]): Stmt => {
    const term = li.header.ops[li.header.ops.length - 1];
    let cond = exprWith(loopSub(li))(term.operands[0]);
    if (term.successors[0].block !== li.header) {
      cond = negate(cond);
    } // loop-continue must be `taken`
    const body = [...sideEffects(li.header), ...(updates ?? argAssigns(li.header, li.header))];
    return { k: 'while', cond, body };
  };

  // Test-at-top `while`: the header's cond_br is the loop condition. The body is a region that stops
  // at the header (the back-edge = end-of-iteration; the latch's argAssigns emit the loop update where
  // it structurally lands). Polarity: the continue edge is the body-entry; negate iff body-entry
  // is the FALL-THROUGH (successors[1]) — NOT the self-loop-relative test emitWhile uses.
  const emitTestAtTopWhile = (wl: WhileLoopInfo, stop: Block | null): Stmt[] => {
    const term = wl.header.ops[wl.header.ops.length - 1];
    let cond = expr(term.operands[0]);
    if (term.successors[1].block === wl.bodyEntry) {
      cond = negate(cond);
    }
    // The header→bodyEntry edge may carry non-identity phi args (a value the header COMPUTED and passes
    // into the body). Those copies must open the body — dropping them reads an uninitialised local.
    // Mirror the br/cond_br cases: argAssigns then structureRegion. Structure the body under this
    // loop's frame so an in-body conditional exit (break / early return) is recognised instead of
    // tripping the header-re-entry `onStack` guard.
    const body = withLoop({ header: wl.header, exit: wl.exit, body: wl.body }, () => [
      ...argAssigns(wl.header, wl.bodyEntry),
      ...structureRegion(wl.bodyEntry, wl.header),
    ]);
    const out: Stmt[] = [{ k: 'while', cond, body }];
    out.push(...argAssigns(wl.header, wl.exit)); // phi args carried on the header→exit edge, if any
    out.push(...structureRegion(wl.exit, stop));
    return out;
  };

  // The latch back-edge substitution (do-while) — subFor over the latch's back-edge args.
  const latchSub = (dw: DoWhileInfo): Map<Value, string> =>
    subFor(dw.header.params, successorTo(dw.latch, dw.header)!.args);

  // Bottom-test `do-while`: the body runs header..latch (structured, with `b`'s do-while hook masked
  // via dwActive), then the latch's own side-effects + the loop update; the latch's cond_br test is the
  // do-while condition, read under `latchSub` (post-update the params hold their next value). Polarity:
  // the loop-CONTINUE edge is the back-edge to the header; negate iff that is the FALL-THROUGH.
  const emitDoWhile = (dw: DoWhileInfo, stop: Block | null): Stmt[] => {
    // The bottom test and everything post-loop render under `latchSub` — the update copies have
    // ALREADY run by then, so a condition/exit-arg/escaped-value read of an updated loop variable
    // that does NOT go through a sub-mapped back-edge arg means the PRE-update value (the
    // `i++ < n` shape: `icmp %i, %n` reads the pre-increment %i) and would render as the
    // post-update name — one iteration off, silently. Same readsClobbered guard the early-exit
    // path applies; on a hazard, decline LOUD.
    const sub = latchSub(dw);
    const updates = argAssigns(dw.latch, dw.header);
    const updateWrites = updateWriteSet(updates);
    const lterm = dw.latch.ops[dw.latch.ops.length - 1];
    const exitArgs = (successorTo(dw.latch, dw.exit)?.args ?? []) as Value[];
    if (loopUpdateHazard(lterm.operands[0], exitArgs, dw.body, sub, updateWrites, null, new Set(dw.header.params))) {
      throw new StructureError(
        `cannot structure '${fn.name}': do-while condition or a post-loop value reads a pre-update loop variable`,
      );
    }
    dwActive.add(dw.header);
    // structure the header's own block up to the latch. Call structureBlock DIRECTLY (not
    // structureRegion): the header is already on `onStack` from the caller's structureRegion, so
    // re-entering it via structureRegion would trip the back-edge guard. dwActive masks the do-while
    // hook so this pass structures `header` as an ordinary block (its ifs reconverge at the latch=stop).
    // Structure the header..latch body under this loop's frame so an in-body conditional exit
    // (break / early return before the bottom test) is recognised rather than declining.
    const inner =
      dw.header === dw.latch
        ? [] // single-block self-loop: the header IS the latch — its ops render via sideEffects below
        : withLoop({ header: dw.header, exit: dw.exit, body: dw.body }, () => structureBlock(dw.header, dw.latch)); // header..latch (exclusive of latch)
    dwActive.delete(dw.header);
    // The UPDATE is RAW (`v = v - 1`) — it IS the decrement; applying `sub` would make it look like the
    // identity `v = v` and drop it. Only the CONDITION and EXIT copies use `sub` (post-update the param
    // already holds the next value, so the latch-computed test reads `v`, not `v - 1`). `updates`
    // reuses the hazard check's computation — a second argAssigns call would burn a spurious
    // swap-cycle temp number.
    const body = [...inner, ...sideEffects(dw.latch), ...updates];
    let cond = exprWith(sub)(lterm.operands[0]);
    if (lterm.successors[1].block === dw.header) {
      cond = negate(cond);
    } // continue edge must be `taken`
    const out: Stmt[] = [{ k: 'dowhile', cond, body }];
    // The exit region reads latch back-edge values under `sub` (post-loop they live in the loop vars).
    out.push(...withSub(sub, () => [...argAssigns(dw.latch, dw.exit, sub), ...structureRegion(dw.exit, stop)]));
    return out;
  };

  const body = recognizeForLoops(structureRegion(entry, null));
  // v* = coalesced/materialized locals; t* = sequentialize's swap-cycle temps (varType-only —
  // they have no Value, so they are collected from varType, not varName).
  const localNames = [...new Set([...varName.values(), ...[...varType.keys()].filter((n) => /^t\d+$/.test(n))])].filter(
    (n) => /^[vt]\d+$/.test(n) && !globalNames.has(n),
  );
  const structs = collectStructs(fn);
  return {
    name: fn.name,
    params: entry.params.map((p, i) => ({ name: `a${i}`, type: p.type })),
    locals: localNames.map((n) => ({ name: n, type: varType.get(n)! })),
    ...(shapedGlobalTypes.size
      ? {
          globals: [...shapedGlobalTypes]
            .map(([name, type]) => ({ name, type }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : {}),
    retType: returnsVoid ? T.void() : returnType(fn),
    body,
    ...(structs.length ? { structs } : {}),
  };
}

// Does any statement CONTINUE this loop (vs. a nested one)? A `continue` inside a nested while/dowhile/
// for targets THAT loop, so we do not descend into them; but `if`/`switch` do not capture `continue`,
// so we scan through those. DEFENSIVE: the structurer does not currently emit an explicit `continue`
// node (the in-body early-exit is an IMPLICIT continue — a fall-through to the loop bottom — and a
// conditional continue DECLINES), so this never fires today; it guards the one case where the while→for
// re-bracketing would change semantics (a `continue` runs `inc` under `for`, skips it under `while`).
function hasEnclosingContinue(stmts: Stmt[]): boolean {
  const scan = (s: Stmt): boolean => {
    switch (s.k) {
      case 'continue':
        return true;
      case 'if':
        return s.then.some(scan) || s.else.some(scan);
      case 'switch':
        return s.cases.some((c) => c.body.some(scan)) || (s.default ?? []).some(scan);
      case 'while':
      case 'dowhile':
      case 'for':
        return false; // nested loop captures its own continue
      default:
        return false;
    }
  };
  return stmts.some(scan);
}

// Re-spell an eligible test-at-top `while` as a `for` (quality only). PURELY cosmetic — the C
// desugaring `for(init;cond;inc){body}` compiles identically to `init; while(cond){body; inc}`, so it
// NEVER changes a byte-exact match. Conservative preconditions (a Ghidra `findLoopVariable`-style
// recognition that moves NO op — the init already precedes the loop, the increment is already the
// body's last statement):
//   • the `while` is IMMEDIATELY preceded by `assign(iv, e0)` (the init literally precedes it);
//   • the `while` cond references `iv`;
//   • the body's LAST statement is `assign(iv, e1)` with `e1` referencing `iv` (a genuine self-update —
//     the increment is literally the body's last op, not an unrelated trailing assign);
//   • the body EXCLUDING that increment has no `continue` targeting THIS loop — a `continue` RUNS `inc`
//     under `for` but SKIPS it under `while`, so folding the increment into the header would change
//     semantics. This is the one hazard of the transform; all others are pure re-bracketing.
// Any precondition failing leaves the `while` untouched. Runs bottom-up so inner loops convert first.
function recognizeForLoops(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  for (const s0 of stmts) {
    const s: Stmt =
      s0.k === 'if'
        ? { ...s0, then: recognizeForLoops(s0.then), else: recognizeForLoops(s0.else) }
        : s0.k === 'while' || s0.k === 'dowhile'
          ? { ...s0, body: recognizeForLoops(s0.body) }
          : s0.k === 'for'
            ? { ...s0, body: recognizeForLoops(s0.body) }
            : s0.k === 'switch'
              ? {
                  ...s0,
                  cases: s0.cases.map((c) => ({ ...c, body: recognizeForLoops(c.body) })),
                  ...(s0.default ? { default: recognizeForLoops(s0.default) } : {}),
                }
              : s0;

    const prev = out[out.length - 1];
    if (s.k === 'while' && s.body.length >= 1 && prev && prev.k === 'assign') {
      const iv = prev.name;
      const inc = s.body[s.body.length - 1];
      if (
        inc.k === 'assign' &&
        inc.name === iv &&
        exprVars(inc.value).has(iv) &&
        exprVars(s.cond).has(iv) &&
        !hasEnclosingContinue(s.body.slice(0, -1))
      ) {
        out.pop(); // the init assign moves into the for-header
        out.push({ k: 'for', init: prev, cond: s.cond, inc, body: s.body.slice(0, -1) });
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

// Sequentialise a parallel copy: order the assignments so none writes a variable that a
// still-pending assignment reads; break a cycle by spilling one destination to a temp.
// `tmp` is the per-FUNCTION temp counter (threaded from structure()) so two independent
// parallel copies never reuse a temp name against conflicting types.
function sequentialize(
  copies: { name: string; value: Expr }[],
  varType: Map<string, IrType>,
  tmp: { n: number },
  fnName: string,
): Stmt[] {
  // Two writes to one destination have no correct order — that is two phi params coalesced onto
  // one name, which canTakeName prevents upstream. Fail loud, never pick one.
  const dests = new Set<string>();
  for (const c of copies) {
    if (dests.has(c.name)) {
      throw new StructureError(`cannot structure '${fnName}': parallel copy writes '${c.name}' twice (coalescing bug)`);
    }
    dests.add(c.name);
  }
  const pending = copies.map((c) => ({ ...c, reads: exprVars(c.value) }));
  const out: Stmt[] = [];
  while (pending.length) {
    const i = pending.findIndex((a) => !pending.some((b) => b !== a && b.reads.has(a.name)));
    if (i >= 0) {
      const a = pending.splice(i, 1)[0];
      out.push({ k: 'assign', name: a.name, value: a.value });
      continue;
    }
    // All remaining form a cycle: spill one destination into a temp, rewrite its readers, and
    // RECOMPUTE their read-sets — with stale sets the spilled copy never becomes emittable and
    // the loop mints fresh temps forever.
    const a = pending[0];
    const t = `t${tmp.n++}`;
    varType.set(t, varType.get(a.name)!);
    out.push({ k: 'assign', name: t, value: { k: 'var', name: a.name } });
    for (const b of pending) {
      if (b !== a) {
        b.value = substVar(b.value, a.name, t);
        b.reads = exprVars(b.value);
      }
    }
  }
  return out;
}
// Read-set / rewrite walkers over the FULL Expr union — a walker that misses a node kind (e.g.
// call/index/field reads) sequentializes a copy keyed by an array index in the wrong order.
function exprVars(e: Expr, acc: Set<string> = new Set()): Set<string> {
  if (e.k === 'var') {
    acc.add(e.name);
  }
  for (const c of exprChildren(e)) {
    exprVars(c, acc);
  }
  return acc;
}
function substVar(e: Expr, from: string, to: string): Expr {
  if (e.k === 'var') {
    return e.name === from ? { k: 'var', name: to } : e;
  }
  return mapExprChildren(e, (c) => substVar(c, from, to));
}

// empty-then peephole: `if (c) {} else { S }` → `if (!c) { S }`
function mkIf(cond: Expr, thenS: Stmt[], elseS: Stmt[]): Stmt {
  if (thenS.length === 0 && elseS.length > 0) {
    return { k: 'if', cond: negate(cond), then: elseS, else: [] };
  }
  return { k: 'if', cond, then: thenS, else: elseS };
}
function negate(e: Expr): Expr {
  if (e.k === 'bin' && NEGATE[e.op]) {
    return { ...e, op: NEGATE[e.op] };
  }
  return { k: 'un', op: '!', e };
}

// --- CFG utilities ---
function predecessorBlocks(fn: Fn): Map<Block, Block[]> {
  const m = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    m.set(b, []);
  }
  for (const b of fn.blocks) {
    for (const s of successorsOf(b)) {
      m.get(s)!.push(b);
    }
  }
  return m;
}
function successorTo(pred: Block, target: Block) {
  const term = pred.ops[pred.ops.length - 1];
  return term.successors.find((s) => s.block === target);
}

// Immediate post-dominators. EXIT is represented as `null`; ret-blocks post-lead to it.
function postDominators(fn: Fn): Map<Block, Block | null> {
  const nodes: (Block | null)[] = [null, ...fn.blocks];
  const succ = (b: Block): (Block | null)[] => {
    const term = b.ops[b.ops.length - 1];
    return term.opcode === 'ret' ? [null] : successorsOf(b);
  };
  const pdom = new Map<Block | null, Set<Block | null>>();
  pdom.set(null, new Set([null]));
  for (const b of fn.blocks) {
    pdom.set(b, new Set(nodes));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of fn.blocks) {
      const ss = succ(b);
      let inter: Set<Block | null> | null = null;
      for (const s of ss) {
        const ps = pdom.get(s)!;
        if (inter === null) {
          inter = new Set(ps);
          continue;
        }
        for (const x of inter) {
          if (!ps.has(x)) {
            inter.delete(x);
          }
        } // intersect in place (spec-safe delete-in-iter)
      }
      const next = new Set<Block | null>(inter ?? []);
      next.add(b);
      if (!setEq(next, pdom.get(b)!)) {
        pdom.set(b, next);
        changed = true;
      }
    }
  }
  // ipdom(b) = the strict post-dom c with (strictPostDoms(b) \ {c}) ⊆ pdom(c)
  const ipdom = new Map<Block, Block | null>();
  for (const b of fn.blocks) {
    const strict = [...pdom.get(b)!].filter((c) => c !== b);
    let chosen: Block | null = null;
    for (const c of strict) {
      const others = strict.filter((x) => x !== c);
      if (others.every((x) => pdom.get(c)!.has(x))) {
        chosen = c;
        break;
      }
    }
    ipdom.set(b, chosen);
  }
  return ipdom;
}
function setEq<X>(a: Set<X>, b: Set<X>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const x of a) {
    if (!b.has(x)) {
      return false;
    }
  }
  return true;
}
