// asmlift — re-rolling a loop test the compiler peeled into the loop's entry (ISA-neutral CFG pass).
//
// `for (i = 0; i < 16; i++) { if (t[i] == 7) { hit(); break; } } out();` — agbcc rotates the loop so
// it is entered at the increment, and evaluates the body's test for i = 0 in the ENTRY block:
//
//     E:  ldrb r1, [t]      ; t[0]
//         cmp r1, #7
//         beq .Lhit         ; the first iteration's test
//     H:  add r2, #1        ; i++
//         cmp r2, #15
//         bhi .Lout
//     T:  ldrb r0, [t + i]
//         cmp r0, #7
//         bne H             ; the same test, every later iteration
//     .Lhit: …
//
// The arm `.Lhit` then has two predecessors, one outside the loop, and no loop spelling owns it. But
// E's test IS T's, at the values E hands the loop: it is the loop's first iteration. Rotating the
// loop back — T becomes the header, entered from E with E's values and from H with H's — makes
// E's test redundant and leaves `.Lhit` one predecessor:
//
//     E:  br T(A)           T(q): test(q) ? X : H(q)           H(p): …; cond ? out : T(B)
//
// Sound when T computes what E computes on E's values, which is what the checks below establish:
//   • the loop has one forward predecessor E and one latch T, whose only predecessor is the header H;
//     T's other edge leaves the loop for X, and E's other edge reaches X too;
//   • T reads nothing H defines except its back-edge arguments B (so, renamed to T's own params, its
//     ops are a function of the values it hands round);
//   • E's condition and arguments into X are T's, with B replaced by E's arguments A into H, compared
//     as canonical expression trees (`canon`) over the values both see;
//   • E runs no effect after the first op its test reads, so the test reads the same memory moved to
//     the head of T as it did at the end of E.
// Every check that fails leaves the function as it was.
import { Block, Fn, Op, Value, dominators, mkValue, predecessors, successorsOf } from '../ir/core';
import { effectful } from '../ir/discipline';
import { simplifyTrivialPhis } from '../ir/simplify';
import { analyzeLoops } from '../structure/loops';

/** Commutative opcodes, whose operands `canon` sorts. */
const COMMUTES = new Set(['add', 'mul', 'and', 'or', 'xor', 'icmp_eq', 'icmp_ne']);
/** A compare and the one that is its negation, so a test spelled with the arms swapped compares. */
const NEGATED: Record<string, string> = { icmp_eq: 'icmp_ne', icmp_ne: 'icmp_eq' };

/** Re-roll every peeled loop test the conditions above admit; returns how many. */
export function rerollPeeledTests(fn: Fn): number {
  let done = 0;
  // one at a time: each rotation changes the loop forest
  while (rerollOne(fn)) {
    done++;
  }
  return done;
}

function rerollOne(fn: Fn): boolean {
  const preds = predecessors(fn);
  const defs = new Map<Value, Op>();
  const defBlock = new Map<Value, Block>();
  for (const b of fn.blocks) {
    b.params.forEach((p) => defBlock.set(p, b));
    for (const op of b.ops) {
      op.results.forEach((r) => {
        defs.set(r, op);
        defBlock.set(r, b);
      });
    }
  }
  const forest = analyzeLoops(fn, dominators(fn));
  for (const nl of forest.byHeader.values()) {
    const H = nl.header;
    if (nl.selfLoop || nl.latches.length !== 1 || nl.forwardPreds.length !== 1) {
      continue;
    }
    const T = nl.latches[0];
    const E = nl.forwardPreds[0];
    const tTerm = T.ops[T.ops.length - 1];
    const eTerm = E.ops[E.ops.length - 1];
    if (
      T === H ||
      tTerm.opcode !== 'cond_br' ||
      eTerm.opcode !== 'cond_br' ||
      (preds.get(T) ?? []).some((p) => p !== H) ||
      successorsOf(H).filter((s) => s === T).length !== 1 ||
      T.params.length > 0
    ) {
      continue;
    }
    const tBack = tTerm.successors.findIndex((s) => s.block === H);
    const tOut = 1 - tBack;
    const eIn = eTerm.successors.findIndex((s) => s.block === H);
    const eOut = 1 - eIn;
    if (tBack < 0 || eIn < 0 || tTerm.successors[tOut].block !== eTerm.successors[eOut].block) {
      continue;
    }
    const X = tTerm.successors[tOut].block;
    if (nl.body.has(X) || X === E) {
      continue;
    }
    const B = tTerm.successors[tBack].args;
    const A = eTerm.successors[eIn].args;
    // T reads nothing H defines but B
    const fromH = (v: Value) => defBlock.get(v) === H;
    const tReads = [
      ...T.ops.flatMap((op) => op.operands),
      ...T.ops.flatMap((op) => op.successors.flatMap((s) => s.args)),
    ];
    if (tReads.some((v) => fromH(v) && !B.includes(v))) {
      continue;
    }
    // compare E's test with T's at E's values: T's spelled with each B[k] replaced by E's A[k]
    const local = (v: Value) => defBlock.get(v) === T || defBlock.get(v) === E;
    const ids = new Map<Value, number>();
    const eCanon = canon(defs, () => null, local, ids);
    const tCanon = canon(defs, (v) => (B.includes(v) ? eCanon(A[B.indexOf(v)]) : null), local, ids);
    const tCond = tCanon(tTerm.operands[0]);
    const eCond = eCanon(eTerm.operands[0]);
    // the sense: which arm of the condition leaves for X
    const tX = tOut === 0;
    const eX = eOut === 0;
    const sameTest = tX === eX ? tCond === eCond : negatedCanon(tCond) === eCond;
    const tArgs = tTerm.successors[tOut].args.map(tCanon);
    const eArgs = eTerm.successors[eOut].args.map(eCanon);
    if (!sameTest || tArgs.length !== eArgs.length || tArgs.some((a, k) => a !== eArgs[k])) {
      continue;
    }
    // neither test runs an effect (E's copy would stay and run it twice), and E runs none after the
    // first op its test reads
    const slice = sliceIn(defs, E, eTerm.operands[0]);
    const tSlice = sliceIn(defs, T, tTerm.operands[0]);
    if ([...slice, ...tSlice].some(effectful)) {
      continue;
    }
    const firstRead = E.ops.findIndex((op) => slice.has(op));
    if (firstRead >= 0 && E.ops.slice(firstRead, -1).some((op) => !slice.has(op) && effectful(op))) {
      continue;
    }
    // ROTATE: T(q) heads the loop; H hands it B, E hands it A, and T hands H its own params.
    const q = B.map((v) => mkValue(v.type));
    const rename = new Map<Value, Value>(B.map((v, k) => [v, q[k]]));
    const sub = (v: Value) => rename.get(v) ?? v;
    T.params = q;
    for (const op of T.ops) {
      op.operands = op.operands.map(sub);
      for (const s of op.successors) {
        s.args = s.args.map(sub);
      }
    }
    for (const op of H.ops) {
      for (const s of op.successors) {
        if (s.block === T) {
          s.args = [...B];
        }
      }
    }
    eTerm.opcode = 'br';
    eTerm.operands = [];
    eTerm.successors = [{ block: T, args: [...A] }];
    eTerm.attrs = {};
    // the test E no longer reads
    for (let changed = true; changed;) {
      changed = false;
      const used = new Set(
        fn.blocks.flatMap((b) => b.ops.flatMap((op) => [...op.operands, ...op.successors.flatMap((s) => s.args)])),
      );
      E.ops = E.ops.filter((op) => {
        const dead = op.successors.length === 0 && !effectful(op) && op.results.every((r) => !used.has(r));
        changed ||= dead;
        return !dead;
      });
    }
    // T now heads the loop: lay it out where H was, so the loop reads in its own order
    fn.blocks = fn.blocks.filter((b) => b !== T);
    fn.blocks.splice(fn.blocks.indexOf(H), 0, T);
    // H's params now take T's own params on their one in-edge: each is that value under a second name
    simplifyTrivialPhis(fn);
    return true;
  }
  return false;
}

/** The ops in `blk` the value `root` is computed from. */
function sliceIn(defs: ReadonlyMap<Value, Op>, blk: Block, root: Value): Set<Op> {
  const out = new Set<Op>();
  const walk = (v: Value) => {
    const d = defs.get(v);
    if (d !== undefined && blk.ops.includes(d) && !out.has(d)) {
      out.add(d);
      d.operands.forEach(walk);
    }
  };
  walk(root);
  return out;
}

/** A canonical spelling of `v` as an expression tree: through the ops `local` admits, down to the
 *  values `leaf` names and to everything else by identity, numbered in `ids` so two spellings that
 *  share it name one value alike. A constant is its value, an `add` of 0 is
 *  its other operand, a load off an `add` of a constant folds the constant into its offset, and a
 *  commutative op sorts its operands. */
function canon(
  defs: ReadonlyMap<Value, Op>,
  leaf: (v: Value) => string | null,
  local: (v: Value) => boolean,
  ids: Map<Value, number>,
) {
  const id = (v: Value) => ids.get(v) ?? (ids.set(v, ids.size), ids.size - 1);
  const rec = (v: Value): string => {
    const named = leaf(v);
    if (named !== null) {
      return named;
    }
    const d = defs.get(v);
    if (d?.opcode === 'const') {
      return `c(${String(d.attrs.value)})`;
    }
    if (d?.opcode === 'gaddr') {
      return `g(${String(d.attrs.sym)})`;
    }
    if (d === undefined || !local(v) || d.results.length !== 1) {
      return `v${id(v)}`;
    }
    const ops = d.operands.map(rec);
    if (d.opcode === 'add' && (ops[0] === 'c(0)' || ops[1] === 'c(0)')) {
      return ops[0] === 'c(0)' ? ops[1] : ops[0];
    }
    if (d.opcode === 'load') {
      let base = ops[0];
      let off = Number(d.attrs.off);
      const m = /^add\((.*)\)$/.exec(base);
      const parts = m ? splitTop(m[1]) : null;
      const c = parts?.find((p) => /^c\(-?\d+\)$/.test(p));
      if (parts?.length === 2 && c !== undefined) {
        off += Number(c.slice(2, -1));
        base = parts.find((p) => p !== c) ?? parts[0];
      }
      return `load(${base}|${off}|${String(d.attrs.width)}|${String(d.attrs.signed)})`;
    }
    const args = COMMUTES.has(d.opcode) ? [...ops].sort() : ops;
    const attrs = Object.keys(d.attrs)
      .sort()
      .map((k) => `${k}=${JSON.stringify(d.attrs[k])}`)
      .join(',');
    return `${d.opcode}(${args.join(',')})${attrs ? `{${attrs}}` : ''}`;
  };
  return rec;
}

/** Split a canonical argument list at its top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === '}') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/** The canonical spelling of a compare's negation, where one is known; otherwise a spelling no
 *  compare canonicalizes to. */
function negatedCanon(c: string): string {
  const m = /^(icmp_[a-z]+)\(/.exec(c);
  const neg = m ? NEGATED[m[1]] : undefined;
  return neg !== undefined ? neg + c.slice(m![1].length) : `not(${c})`;
}
