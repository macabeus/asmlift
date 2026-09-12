// L3 re-spelling lever: a pointer local the source ADVANCED between two accesses, rather than two
// addresses the compiler derived from one.
//
// `ldr r3,=X; strh [r3]; adds r3,#2; strh [r3]` — the machine held an address in a register, used
// it, moved it, used it again. `raise/const.ts` folds the lift's `add(const X, const 2)` into the
// literal `X + 2`, because on Thumb that pair is also how a compiler materialises a 32-bit literal
// it cannot encode in one instruction, and it records the distinction it is erasing as
// `index.baseAdvanced` (l3/ast.ts's third evidence field). This pass reads it:
//
//     *(u16 *)0x04000048 = a;  *(u16 *)0x0400004A = b;
//   → u16 *p = (u16 *)0x04000048;  *p = a;  p = p + 1;  *p = b;
//
// WHY IT IS A CANDIDATE. Against the INDEXED spelling of the same minted local the advance buys
// nothing: agbcc folds `p = p + 1; *p` straight back into `strh [r3, #2]`, byte for byte the
// subscript's own object. What makes it visible is the CONJUNCTION with a `volatile` pointee,
// which bars that fold and leaves the `add` the target records. Both halves were compiled against
// `kleod:StreamCmd_SetWindowRegs`'s target object before this pass was written; the four corners
// are in test/advance.test.ts's header. So this pass emits a spelling and `compareScored`
// referees; nothing here claims the source wrote it.
//
// SOUNDNESS IS ADDRESS EQUALITY. `p` is freshly minted and assigned by nothing else, so at each
// member's access it holds `A0 + Σ steps so far` — that member's own absolute address — PROVIDED
// every advance sits between the accesses it separates on every path, and PROVIDED every node this
// pass re-spells as `*p` is one of those accesses. A top-level statement list has no back edge and
// runs its statements in order at most once each, so placing each advance at the top level
// immediately above its member's statement, with the members at STRICTLY INCREASING top-level
// indices, carries the first half.
//
// THE SECOND HALF IS `rewrite`, AND IT MATCHES BY ADDRESS, NOT BY IDENTITY (`:rewrite` below): it
// replaces EVERY `index` node whose `cellAddress` is a chain member's, wherever it sits. So a
// second access at a member's address — a twin at the top level, or one inside an arm or a loop
// body — is re-spelled `*p` at a point where `p` does not hold that address. The two rules that
// refuse those shapes (`member-second-site`, `member-nested-site`, and their head twins) are
// therefore SOUND, not narrowing. Removing `member-nested-site` and fuzzing 49,528 chains against
// a pointer-aware memory-trace oracle moves 3,664 addresses (the wave-1 breaker's `fuzz2.mts`);
// the shape is pinned here by `an access at a chain address inside a loop is not re-spelled`.
//
// SCOPE (decline over approximate) is `ADVANCE_HEAD_GATES` and `ADVANCE_MEMBER_GATES` below — as
// tables rather than an `||` chain, so `sound` costs a `guardedBy` and every rule is ablated
// against the real pass by test/advance.test.ts's battery, which records WHAT THE ABLATED PASS
// EMITS and checks `sound` against it. NOT by `bench gates`: `pnpm bench gates --pass advance`
// answers `no censusable pass "advance"`, and structurally must, because this pass is reached
// through a static import binding in rank.ts rather than through a mutable caller-side record
// (run/gate-census.ts's header, which measures the `TypeError` a module-namespace write raises).
// The census below was therefore taken BY HAND; the recipe is two lines and in the header.
//
// FIVE OF THE TWELVE ARE NARROWING rather than soundness and each says which it is. Three are
// judgements about what the asm shows (`head-already-advanced`, `member-negative-step`,
// `member-no-evidence` — the last is what makes this a reading rather than a guess); one,
// `member-signedness`, buys the minted local ONE pointee type where the backend would otherwise
// spell a correct reinterpret cast; one, `member-element-grid`, is a LOUD refusal — ablated it
// emits `p0 = p0 + 0.5;`, which is not C. Dropping `member-no-evidence` alone leaves the emitted
// step `undefined / width` = `NaN`, refused downstream only by the two arithmetic rules'
// comparisons against it (`NaN % w !== 0`, `NaN !== addr`) — an accident when it was unwritten,
// pinned now by the battery's `noncompile` verdicts for both.
//
// HOW OFTEN EACH FIRES, over the whole corpus — `bench sweep --fan`, both arms, 2,126 records,
// instrumented on `firstRejection` (2026-09-12), which is HAND INSTRUMENTATION and reproduced by
// wrapping both tables in `tallying()` (l3/gates.ts) at this pass's one call site in rank.ts,
// passing `.gates` to `advancedBases`, and printing `.refusals()` when the sweep ends. The numbers
// count CALLS, and enumeration calls this pass about eleven times per record, once per outer-axis
// tree:
//     23,322 calls · 112 found a chain · 23,210 declined
//     head-second-site 872 · member-no-evidence 664 · head-nested-site 256 · head-already-advanced 144
//     every other member rule: 0
// So the eight remaining member rules are pinned by the battery and by NOTHING IN THE CORPUS —
// where the corpus refuses a chain, it refuses it at the head. Chain lengths found: 96 of two
// members and 16 of four, no others.
//
// WHAT THIS PASS DOES NOT DO, both measured rather than assumed:
//   • A function with TWO disjoint chains gets one candidate, spelling the FIRST BY POSITION — not
//     the longest, and the second chain is unreachable by any label. ZERO of the 112 chain-bearing
//     calls above held a second chain sharing no address with the first (the instrument kept
//     scanning), so the second local this would need has no inhabitant to price it.
//   • The init is `prepend`ed and there is no sunk twin; see the note at `placeBaseLocals` below.
//   • IT IS MAP-LESS ONLY. Every member is reached through `cellAddress`, which answers null once
//     a symbol map promotes the pool word to `&REG_WININ` — so with a map this pass enumerates
//     nothing, and every `/advance` candidate the corpus carries is a `/raw-globals` one. That is
//     what caps the lever at five rows, and it is the question to ask of it the day the symbol-map
//     direction lands: this capability survives only if `cellAddress` learns the promoted form.
import { type IrType, scalarTypeForAccess } from '../ir/types';
import { cellAddress } from './address';
import { type Expr, type SFn, type Stmt, mapExprChildren, mapStmtExprs, stmtChildren, stmtExprs } from './ast';
import { type Gate, firstRejection } from './gates';
import type { BaseInit } from './hoist';
import { nameAllocator, placeBaseLocals } from './hoist';

/** One const-addressed access, with the top-level statement it was reached at. */
export interface Site {
  stmt: number;
  addr: number;
  width: number;
  signed: boolean;
  advanced?: number;
}

/** One candidate member, judged against the chain so far. `twin`/`nested` are the two ways some
 *  OTHER node in the tree names this site's address — the facts `rewrite`'s by-address match makes
 *  load-bearing. */
export interface MemberCtx {
  prev: Site;
  site: Site;
  twin: boolean;
  nested: boolean;
}
export type HeadCtx = Omit<MemberCtx, 'prev'>;

/** The head's own admission. The two address rules are the same PREDICATE as the member table's
 *  and deliberately not the same rule objects (see gates.ts on why a second consumer owns its
 *  own): a head that is re-spelled at a second site is wrong for the same reason a member is. */
export const ADVANCE_HEAD_GATES: readonly Gate<HeadCtx>[] = [
  {
    id: 'head-second-site',
    why: 'rewrite matches by address, so a twin elsewhere would read `p` before it is set',
    sound: true,
    guardedBy: 'advance.test.ts: a chain address reached at a second site declines',
    rejects: (c) => c.twin,
  },
  {
    id: 'head-nested-site',
    why: 'the same address inside an arm or a loop body is re-spelled at a point `p` may not hold',
    sound: true,
    guardedBy: 'advance.test.ts: an access at a chain address inside a loop is not re-spelled',
    rejects: (c) => c.nested,
  },
  {
    id: 'head-already-advanced',
    why: 'NARROWING: a stamped site is somebody else’s successor, so starting there spells an absolute init for an address the machine reached by advancing',
    sound: false,
    guardedBy: 'advance.test.ts: a chain may not START at an advanced site',
    rejects: (c) => c.site.advanced !== undefined,
  },
];

/** Each successor, against the member before it. FIRST rejection wins, so a refusal is
 *  attributable to one rule. */
export const ADVANCE_MEMBER_GATES: readonly Gate<MemberCtx>[] = [
  {
    id: 'member-no-evidence',
    why: 'without the stamp the pair is a compiler deriving two addresses from one pool word',
    sound: false,
    guardedBy: 'advance.test.ts: the same pair with no evidence declines',
    rejects: (c) => c.site.advanced === undefined,
  },
  {
    id: 'member-second-site',
    why: 'rewrite matches by address, so a twin elsewhere would read `p` at the wrong value',
    sound: true,
    guardedBy: 'advance.test.ts: a chain address reached at a second site declines',
    rejects: (c) => c.twin,
  },
  {
    id: 'member-nested-site',
    why: 'the same address inside an arm or a loop body is re-spelled at a point `p` may not hold',
    sound: true,
    guardedBy: 'advance.test.ts: an access at a chain address inside a loop is not re-spelled',
    rejects: (c) => c.nested,
  },
  {
    id: 'member-statement-order',
    why: 'the advance must sit between the two accesses it separates, so the indices must increase',
    sound: true,
    guardedBy: 'advance.test.ts: two accesses in ONE statement are not a chain',
    rejects: (c) => c.site.stmt <= c.prev.stmt,
  },
  {
    id: 'member-width',
    why: 'the minted local has ONE pointee width, and `*p` at another width names other bytes',
    sound: true,
    guardedBy: 'advance.test.ts: members of different widths decline',
    rejects: (c) => c.site.width !== c.prev.width,
  },
  {
    id: 'member-signedness',
    why: 'NARROWING: one pointee TYPE, so the second member is not spelled through a reinterpret cast the source did not write',
    sound: false,
    guardedBy: 'advance.test.ts: members of different signedness decline',
    rejects: (c) => c.site.signed !== c.prev.signed,
  },
  {
    id: 'member-element-grid',
    why: 'LOUD: off the grid the emitted `p = p + step / width` is fractional (`p0 + 0.5`), which is not C at all',
    sound: false,
    guardedBy: 'advance.test.ts: a step off the element grid declines',
    rejects: (c) => c.site.advanced! % c.prev.width !== 0,
  },
  {
    id: 'member-step-lands',
    why: 'a step that does not land on this access is evidence about some other pair of addresses',
    sound: true,
    guardedBy: 'advance.test.ts: a step that does not land on the next access declines',
    rejects: (c) => c.prev.addr + c.site.advanced! !== c.site.addr,
  },
  {
    id: 'member-negative-step',
    why: 'NARROWING: `p = p + -1` is valid C and address-correct; the direction is unpinned and has no inhabitant',
    sound: false,
    guardedBy: 'advance.test.ts: a NEGATIVE step declines',
    rejects: (c) => c.site.advanced! <= 0,
  },
];

/** Every const-addressed `index` node in the body, split into the ones reached EXACTLY ONCE per
 *  execution of a top-level statement — the only places an advance statement can be put — and the
 *  ADDRESSES of every other one, which the chain rule refuses outright.
 *
 *  A loop's OWN expression joins its body on the second side: a `while` condition runs once per
 *  iteration, so an advance above the loop and an access in its test are not the same count. A
 *  top-level `if`'s condition stays on the first side, because the `if` statement itself runs once
 *  whatever its arms do. */
function collectSites(body: readonly Stmt[]): { sites: Site[]; nestedAddrs: Set<number> } {
  const sites: Site[] = [];
  const nestedAddrs = new Set<number>();
  const visit = (e: Expr, stmt: number, nested: boolean): void => {
    if (e.k === 'index') {
      const addr = cellAddress(e);
      if (addr !== null) {
        if (nested) {
          nestedAddrs.add(addr);
        } else {
          sites.push({ stmt, addr, width: e.width, signed: e.signed, advanced: e.baseAdvanced });
        }
      }
    }
    mapExprChildren(e, (c) => {
      visit(c, stmt, nested);
      return c;
    });
  };
  const walk = (stmts: readonly Stmt[], stmt: number, nested: boolean): void => {
    for (const s of stmts) {
      const repeats = s.k === 'while' || s.k === 'dowhile' || s.k === 'for';
      for (const e of stmtExprs(s)) {
        visit(e, stmt, nested || repeats);
      }
      walk(stmtChildren(s), stmt, true);
    }
  };
  body.forEach((s, i) => walk([s], i, false));
  return { sites, nestedAddrs };
}

/** The one chain this pass spells, or null.
 *
 *  A NON-MEMBER SITE BETWEEN TWO MEMBERS DOES NOT END THE CHAIN. `p` is freshly minted, so an
 *  access that does not touch it cannot move it — and the clientele is MMIO setup code, where one
 *  `REG_BLDCNT = y;` between two window writes is the ordinary case. The rule used to be
 *  POSITIONAL (the head was the site immediately before the first stamped one, and the walk
 *  stopped at the first site that failed a gate), which declined that shape for no soundness
 *  reason; a `var`-based store between the same two members was admitted, which no reader could
 *  predict. Ambiguity is resolved greedily in statement order: where two later sites would both
 *  extend the chain, the earlier one does.
 *
 *  PRICED AT ZERO. `bench sweep --fan --base 9e393db5`, both arms: 0 records moved, 2,126
 *  identical. The shape this admits — MMIO writes with an unrelated const-addressed access between
 *  two members — has no inhabitant in the corpus either, so this is a rule the file can now state
 *  truthfully rather than reach the corpus can show. */
function chainOf(sites: readonly Site[], nestedAddrs: ReadonlySet<number>, gates: AdvanceGates): Site[] | null {
  const head = gates.head ?? ADVANCE_HEAD_GATES;
  const member = gates.member ?? ADVANCE_MEMBER_GATES;
  const occurrences = new Map<number, number>();
  for (const s of sites) {
    occurrences.set(s.addr, (occurrences.get(s.addr) ?? 0) + 1);
  }
  const ctx = (site: Site): HeadCtx => ({
    site,
    twin: (occurrences.get(site.addr) ?? 0) > 1,
    nested: nestedAddrs.has(site.addr),
  });
  for (let i = 0; i < sites.length; i++) {
    if (firstRejection(head, ctx(sites[i])) !== null) {
      continue;
    }
    const chain = [sites[i]];
    for (let j = i + 1; j < sites.length; j++) {
      if (firstRejection(member, { prev: chain[chain.length - 1], ...ctx(sites[j]) }) === null) {
        chain.push(sites[j]);
      }
    }
    if (chain.length >= 2) {
      return chain;
    }
  }
  return null;
}

/** The two tables, ablatable — `gates.ts`'s reason: a test drops one entry and re-runs the REAL
 *  predicate on real input, with no test-only branch in the shipped path. Nothing in `src/` passes
 *  this; a shipped ablation of a `sound: true` rule emits wrong addresses, which is what
 *  `ablateHeuristic` refuses. */
export interface AdvanceGates {
  head?: readonly Gate<HeadCtx>[];
  member?: readonly Gate<MemberCtx>[];
}

/** Re-spell one advanced chain as a pointer local moved in place, or decline (null). */
export function advancedBases(sfn: SFn, gates: AdvanceGates = {}): SFn | null {
  const { sites, nestedAddrs } = collectSites(sfn.body);
  const chain = chainOf(sites, nestedAddrs, gates);
  if (chain === null) {
    return null;
  }
  const name = nameAllocator(sfn)();
  const elem: IrType = scalarTypeForAccess(chain[0].width, chain[0].signed);
  const ptr: IrType = { kind: 'ptr', to: elem };
  const members = new Set(chain.map((m) => m.addr));
  // The access itself: every chain member reads `*p`, because `p` has been advanced to exactly its
  // address. The evidence fields go with the old base — they described how the ADDRESS was
  // computed, and this spelling is the answer to that question rather than another instance of it.
  //
  // BY ADDRESS, NOT BY IDENTITY, and the header's soundness argument turns on it: a node this
  // finds at a member's address that is NOT the member — a twin, or one inside an arm or a loop —
  // is re-spelled too, which is why the gates that refuse those shapes are `sound: true`.
  const rewrite = (e: Expr): Expr => {
    const m = mapExprChildren(e, rewrite);
    const addr = m.k === 'index' ? cellAddress(m) : null;
    if (m.k === 'index' && addr !== null && members.has(addr)) {
      return { k: 'index', base: { k: 'var', name }, idx: { k: 'const', value: 0 }, width: m.width, signed: m.signed };
    }
    return m;
  };
  // The emitted distance is the GATED quantity — the step `member-step-lands` tied to this pair of
  // addresses and `member-element-grid` divided — rather than the address difference, which is the
  // same number only because those two rules hold. Deriving it separately is how a later ablation
  // of one of them emits a fractional advance nothing checked.
  //
  // WHICH MAKES THE ARITHMETIC HERE TOTAL ONLY BECAUSE OF THE TABLE, and both ways out are LOUD
  // rather than silent — measured, and pinned by the battery's `noncompile` verdicts rather than
  // guarded here: with `member-element-grid` dropped this emits `p0 = p0 + 0.5;`, and with
  // `member-no-evidence` dropped `advanced` is `undefined` and this emits `p0 = p0 + NaN;`.
  // Neither is C, so a candidate carrying one is dropped at compile with its message rather than
  // scored — which is why the two rules are `sound: false` and why no `Number.isInteger` refusal
  // stands here: adding one would turn those two ablations into a DECLINE and delete the evidence
  // the battery reads. `member-no-evidence` is ablatable by `ablateHeuristic`, so a round that
  // ships that ablation as a ranked candidate ships noncompiling sources; that is its price.
  const advanceAt = new Map<number, number>();
  for (let i = 1; i < chain.length; i++) {
    advanceAt.set(chain[i].stmt, chain[i].advanced! / chain[i].width);
  }
  const body: Stmt[] = [];
  sfn.body.forEach((s, i) => {
    const step = advanceAt.get(i);
    if (step !== undefined) {
      body.push({
        k: 'assign',
        name,
        value: { k: 'bin', op: '+', l: { k: 'var', name }, r: { k: 'const', value: step } },
      });
    }
    body.push(mapStmtExprs(s, rewrite));
  });
  const init: BaseInit = {
    k: 'assign',
    name,
    value: { k: 'cast', to: ptr, e: { k: 'const', value: chain[0].addr } },
  };
  const locals = [...sfn.locals, { name, type: ptr as SFn['locals'][number]['type'] }];
  // `prepend` for `l3/nearbase.ts`'s reason and a second one this pass owns: the init MATERIALISES
  // the register the chain advances, and the target's own instruction order is what says where the
  // pool word was loaded. Putting it in first-use order instead moves it below whatever else the
  // function loads first, which on the row this pass was built for swaps the two pool words and
  // costs the match (measured: variant A vs variant C in test/advance.test.ts's header).
  //
  // AND NO `/advance/sinkinit` TWIN, unlike `/nearbase`, which ships one for exactly this choice —
  // not because the choice is better determined here (the generator cannot see the target either
  // way) but because the twin CANNOT EXIST. `sinkInitsToFirstUse` sinks an init only when
  // `localMentions` counts ONE assignment to its local ("or the move would cross the other write",
  // l3/hoist.ts), and an advance IS a second assignment to this one — so the sink declines on every
  // tree this pass produces, by construction rather than by row. Measured both ways: registering
  // `/advance/sinkinit` and re-ranking `kleod:StreamCmd_SetWindowRegs:agbcc` leaves the fan at 18
  // candidates with `--enumerate` listing only `/advance` and `/advance/volatile`, and the sink
  // returns null on the advanced tree in-process. The `prepend` choice above is therefore the only
  // placement this lever HAS, which is a stronger reason to record the compile behind it.
  const { body: placed } = placeBaseLocals({ ...sfn, locals, body }, [init], 'prepend');
  return { ...sfn, locals, body: placed };
}
