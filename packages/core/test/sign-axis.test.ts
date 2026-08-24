// THE SIGNEDNESS AXIS and what it costs. The axis itself — pin the entry scalars signed, then
// unsigned, and let the differ referee — is pinned by the rows that win on each side; this file
// pins the two halves nothing else can: where a second pass produces no candidate at all, and why
// the candidates it does produce cannot be thinned out by predicting which of them are redundant.
// Toolchain-free.
import { describe, expect, test, vi } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Frontend } from '../src/frontend/frontend';
import { type IrType, T } from '../src/ir/types';
import { type BinOp, type Expr, type LanguageBackend, exprChildren } from '../src/l3/ast';
import { type VarTypes, renderedIntSignedness } from '../src/l3/typing';
import { enumerateCandidates } from '../src/rank';
import { type SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

/** Lifts taken by the enumeration under test. The DECLINE's entire effect is a lift that never
 *  happens, and it is invisible everywhere downstream: a decline that stopped firing would re-lift,
 *  re-raise, re-structure, reach the tree the first pass already emitted, and be dropped by the tree
 *  skip — same candidates, same labels, same print count. So the guard counts lifts. */
const lifts = vi.hoisted(() => ({ n: 0 }));
vi.mock('../src/frontend/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/frontend/registry')>();
  return {
    ...actual,
    frontendFor: (target: Parameters<typeof actual.frontendFor>[0]): Frontend => {
      const f = actual.frontendFor(target);
      return {
        ...f,
        lift: (...args: Parameters<Frontend['lift']>) => {
          lifts.n++;
          return f.lift(...args);
        },
      };
    },
  };
});

const wrap = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tr1\n`;

/** cBackend, plus every spelling it was asked to print — where the candidate list shows only what
 *  survived the dedup. */
function recordingBackend(): { backend: LanguageBackend; emitted: string[] } {
  const emitted: string[] = [];
  return {
    backend: {
      ...cBackend,
      emit: (fn) => {
        const s = cBackend.emit(fn);
        emitted.push(s);
        return s;
      },
    },
    emitted,
  };
}

describe('the signedness axis declines where the pin writes nothing', () => {
  // r0 is dereferenced, so it recovers as a pointer and NO_PIN_KINDS excludes it: `pinScalarParams`
  // has no scalar entry param to write, and both passes would lift the identical function.
  const PTR_ONLY = '\tldr\tr1, [r0]\n\tadd\tr1, r1, #1\n\tstr\tr1, [r0]\n';

  test('a function whose every entry param is a pointer is enumerated ONCE', () => {
    const { backend, emitted } = recordingBackend();
    lifts.n = 0;
    const cands = enumerateCandidates('f', wrap(PTR_ONLY), ARMV4T_AGBCC, { backend });
    // Eight axis points, one structured tree, one spelling printed — which is what the tree skip
    // produces whether the decline fires or not. The count that answers for the DECLINE is below.
    expect(cands.length).toBe(1);
    expect(new Set(emitted).size).toBe(1);
    expect(emitted.length).toBe(1);
    // The declined second pass never lifted: the probe's lift plus the first pass's.
    expect(lifts.n).toBe(2);
  });

  test('…and a scalar entry param keeps both passes', () => {
    // The counterpart, and what keeps the counts above about the PIN rather than only about the
    // tree skip: here the pin writes, the two passes reach two different trees, and both are
    // spelled. A pin that wrote nothing would collapse this to one tree, one label and one lift.
    const { backend, emitted } = recordingBackend();
    lifts.n = 0;
    const cands = enumerateCandidates('f', wrap('\tasr\tr0, r0, #2\n'), ARMV4T_AGBCC, { backend });
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'signed']);
    expect(emitted.length).toBe(2);
    expect(lifts.n).toBe(3);
  });

  // The per-variant decline, the shape addr-home.test.ts pins for its own gate: the `/raw-globals`
  // sibling lifts WITHOUT the map, so it decides for itself whether the pin has a param. A decline
  // read from one shared probe would answer for a lift it is not the lift of.
  const SCALAR_AND_GLOBAL =
    'f:\n\tldr\tr1, .L1\n\tldr\tr1, [r1]\n\tadds\tr0, r0, r1\n\tbx\tlr\n.L1:\n\t.word\t0x8057acc\n';

  test('both symbol variants carry both passes', () => {
    const symbols: SymbolMap = new Map([[0x8057acc, [{ name: 'gCounter', kind: 'data' }]]]);
    const cands = enumerateCandidates('f', SCALAR_AND_GLOBAL, ARMV4T_AGBCC, { symbols });
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'signed', 'unsigned/raw-globals', 'signed/raw-globals']);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE FAN CANNOT BE THINNED.
//
// Where the pin changes the tree the axis doubles the candidate set, and much of that set is the
// same program twice: klonoa's LoadBGTilemapData enumerates 26880 candidates as 13440 twin pairs,
// every pair tying in score, and the whole fan compiles to 6000 distinct objects. The recurring
// proposal is a predicate over the RENDERED TYPE — does any expression's type move under the pin?
// — that would drop the redundant spelling of each pair before it is compiled. It cannot exist,
// and the design space is a two-point lattice with nothing between the points. These tests pin
// both points, so the answer is read here rather than re-derived against five toolchains.
//
// Two things the predicate would have to be that a tree walk is not. It holds of a PAIR of trees,
// never of one: the pin runs in `beforeRecover`, so the second pass can recover different types and
// structure a different tree entirely, and only a pair already known equal modulo the param
// declarations is a twin at all. And every `undefined` would have to count as DIFFERS — the
// direction below shows the model does not give that for free.

/** Every node of one emitted expression, with what `renderedIntSignedness` reports for it under
 *  each pin. `pinned` names the entry params the axis writes; anything else takes `declared`. */
function underBothPins(root: Expr, pinned: readonly string[], declared: Record<string, IrType> = {}) {
  const varType =
    (signed: boolean): VarTypes =>
    (n) =>
      pinned.includes(n) ? (signed ? T.s(32) : T.u(32)) : declared[n];
  const nodes: { e: Expr; signedPin: boolean | undefined; unsignedPin: boolean | undefined }[] = [];
  (function walk(e: Expr) {
    nodes.push({
      e,
      signedPin: renderedIntSignedness(e, varType(true)),
      unsignedPin: renderedIntSignedness(e, varType(false)),
    });
    for (const c of exprChildren(e)) {
      walk(c);
    }
  })(root);
  return nodes;
}

/** How many of those nodes the pin moved — `leaves` selects the two readings. */
const movedBy = (nodes: ReturnType<typeof underBothPins>, opts: { leaves: boolean }): number =>
  nodes.filter((n) => n.signedPin !== n.unsignedPin && (opts.leaves || (n.e.k !== 'var' && n.e.k !== 'const'))).length;

const v = (name: string): Expr => ({ k: 'var', name });
const lit = (value: number): Expr => ({ k: 'const', value });
const op = (o: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op: o, l, r });

// The one SHAPE in which LoadBGTilemapData reads either pinned param — twice, at adjacent bytes,
// and the same in both symbol-map configurations (250 emitted lines with the project's `elf:`, 258
// without).
const LBG_READ: Expr = {
  k: 'cast',
  to: T.ptr(T.u(8)),
  e: op('+', op('+', op('<<', v('a1'), lit(1)), op('<<', v('a0'), lit(2))), lit(134576845)),
};
// `synthetic:maxi:agbcc`, whose published winner is the SIGNED spelling at score 0: the whole tree
// is `if (a1 < a0) a1 = a0; return a1;`, so its expressions are one compare and two bare reads.
const MAXI: Expr[] = [op('<', v('a1'), v('a0')), v('a0'), v('a1')];
// `synthetic:sw_sparse:agbcc`, likewise signed at score 0: a `switch` scrutinee is a bare `var` in
// a STATEMENT position — no operator over it, no result type, nothing for a tree walk to compare.
const SW_SCRUTINEE: Expr = v('a0');

describe('the fan cannot be thinned by a rendered-type predicate', () => {
  test('comparing every node, LEAVES INCLUDED, is sound — and says only "no pinned param is read"', () => {
    // A pinned param's own `var` leaf carries its declared type, so any read of one moves a node
    // and the predicate keeps both spellings. That is a var-leaf occurrence count with no type
    // propagation in it — which is the decline rank.ts already ships (`pinScalarParams` answering
    // false), and no published winner inhabits the gap between them.
    for (const [tree, moved] of [
      [LBG_READ, 6],
      [MAXI[0], 2],
      [SW_SCRUTINEE, 1],
    ] as const) {
      expect(movedBy(underBothPins(tree, ['a0', 'a1']), { leaves: true })).toBe(moved);
    }
  });

  test('EXCLUDING the leaves — the only reading that prunes anything — prunes published matches', () => {
    // C says a comparison yields `int` under either pin; the compiler picks the compare
    // INSTRUCTION from the operands. So `maxi`'s tree has no node whose type the pin moves, while
    // agbcc emits `bge` for the signed spelling against `bcs` for the unsigned one — scored
    // against the row's own target.o, signed 0 (MATCH) against unsigned 1. The switch scrutinee is
    // the same hole one level up (agbcc `bgt` against `bhi`, signed 0 against unsigned 1), and it
    // is not an expression at all.
    expect(MAXI.map((e) => movedBy(underBothPins(e, ['a0', 'a1']), { leaves: false }))).toEqual([0, 0, 0]);
    expect(movedBy(underBothPins(SW_SCRUTINEE, ['a0', 'a1']), { leaves: false })).toBe(0);
    // …and the reading that prunes those does not reach the function the thinning was for: four of
    // LoadBGTilemapData's ten nodes move with the leaves already excluded, because `<<` takes the
    // type of its left operand and that operand is the pinned param.
    expect(movedBy(underBothPins(LBG_READ, ['a0', 'a1']), { leaves: false })).toBe(4);
  });

  test('a node the model does not cover compares EQUAL under both pins', () => {
    // `undefined` is "not modelled", and typing.ts picks its conservative direction for a consumer
    // that INSERTS a cast — a redundant cast is codegen-identical, a missing one is a miscompile. A
    // consumer that DELETES a candidate needs the opposite reading and would silently get this one:
    // the pointer cast over LoadBGTilemapData's address is undefined under both pins, i.e. "same".
    const [cast] = underBothPins(LBG_READ, ['a0', 'a1']);
    expect(cast.e.k).toBe('cast');
    expect(cast.signedPin).toBeUndefined();
    expect(cast.unsignedPin).toBeUndefined();
  });
});
