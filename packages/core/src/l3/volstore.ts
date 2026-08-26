// L3 re-spelling lever: pin a STORE at a fixed DEVICE-REGISTER address `volatile`
// (`*(volatile s32 *)0x40000d4 = x` rather than `*(s32 *)0x40000d4 = x`).
//
// A numeric address has no declaration anywhere, so whether the original source wrote through a
// `volatile` lvalue is not derivable from the asm — the same gap l3/volatileptr.ts's header
// argues. That lever answers it for a pointer LOCAL holding the address; this one answers it
// where there is no local at all, which is the spelling a `#define REG(x) *(vu32 *)(x)` macro
// produces and the shape structure.ts leaves when the address re-materializes at each use.
//
// IT IS CODEGEN-VISIBLE, and the mechanism is one line of the compiler. agbcc's loop optimizer
// runs `load_mems` (gcc/loop.c:8877) between the invariant hoist and strength reduction; it
// PROMOTES a loop-invariant MEM into a register for the loop's duration and writes it back once
// after the exit, and it stands down on exactly two conditions (gcc/loop.c:8934):
//
//     if (MEM_VOLATILE_P (mem) || invariant_p (XEXP (mem, 0)) != 1)
//       loop_mems[i].optimize = 0;
//
// So an unpinned store to a fixed address inside a loop LEAVES THE LOOP — verified in both
// directions on synthetic:dmafill (unpinned: one store in the body, three after the `ble`, two
// pool words; pinned: four stores per iteration, four pool words). A decompiler that never spells
// the qualifier can therefore never reproduce the loop body of any function that drives a device
// register in a loop, whatever else it gets right.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION: `volatile` only RESTRICTS what a compiler may do with
// an access; every execution of the qualified spelling is an execution of the plain one. The
// qualifier goes on the POINTEE of the deref cast, which is where C puts it and what
// backend/cfamily.ts already prints for the casts l3/inlinebase.ts mints.
//
// GATE (VOL_STORE_GATES, read once per access): the target must declare a device-register window
// (TargetDescription.capabilities.deviceRegisters); the access's WHOLE address must be a
// compile-time constant — a base that rematerializes to a numeric address plus a constant
// subscript, no `lead` — that constant must lie inside the window, and the access must not
// already be qualified. Nothing qualifying ⇒ decline (null), never a duplicate of the primary.
//
// THE WINDOW IS A REACH GATE, PRICED — not a soundness one, which is why it is `sound: false`.
// A `volatile` qualifier only restricts the compiler, so widening the range can never make a
// candidate WRONG; what it would make is a claim about ordinary memory that the target denies
// (IWRAM, EWRAM, palette, VRAM and OAM are memory a source does not qualify — target.ts) and that
// the differ can only referee by luck. Measured by running the lever twice, once with the declared
// range and once with one admitting every constant address: 8 trees over 7 rows carry a
// const-address store the window excludes, and the fan moves on two of them —
// `synthetic:readarm` 6 candidates → 8 (the extra one TIES its match at 0) and
// `synthetic:fieldbase` 14 → 20 (best extra 22, losing to 0). No row's score or outcome moves
// either way. So the range buys candidate discipline and the honesty of the claim, and no match
// rests on it.
//
// SCOPE: STORES only. A device READ is a different question with a different answer — the idiom
// fold's DCE drops a use-less device load outright (synthetic:dmaback), so a read that survives to
// L3 is one whose value the function consumes, and whether THAT may be CSEd is the question
// `/reread-globals` referees as a structuring axis. The price of pinning one is real and is
// measured on `synthetic:ucmp:agbcc`, a byte-exact match whose loop test READS 0x3001048: qualify
// that read and the row scores 15. This lever does not reach it — ucmp's stores go through a
// runtime address (`*(u8 *)(v1 + 0x3002000)`), so it declines there on `non-const-address`, in
// both configurations and with any window. No row demands the read spelling, and a lever with no
// inhabitant is what "earn the level" forbids.
import { type IrType, T, scalarTypeForAccess } from '../ir/types';
import { type Expr, type SFn, type Stmt } from './ast';
import { type Gate, firstRejection } from './gates';

/** One STORE lvalue as the gates read it. */
interface AccessCtx {
  /** the target declares a device-register range at all */
  hasWindow: boolean;
  /** the access's whole address as a compile-time constant, or null */
  address: number | null;
  /** that address lies inside the declared window */
  inWindow: boolean;
  /** the lvalue already carries a `volatile` qualifier */
  qualified: boolean;
}

export const VOL_STORE_GATES: readonly Gate<AccessCtx>[] = [
  {
    id: 'no-window',
    why: 'a target that declares no device range has no address this lever may call volatile',
    sound: false,
    rejects: (c) => !c.hasWindow,
  },
  {
    id: 'non-const-address',
    why: 'a runtime address names no cell, so nothing here can say which object it reaches',
    sound: false,
    rejects: (c) => c.address === null,
  },
  {
    id: 'outside-window',
    why: 'ordinary memory is not a device register — qualifying it claims what the target denies',
    sound: false,
    rejects: (c) => !c.inWindow,
  },
  {
    id: 'already-qualified',
    why: 'a second qualifier would nest a cast over a spelling that already asserts volatility',
    sound: false,
    rejects: (c) => c.qualified,
  },
];

/** The numeric address behind a deref base, through SCALAR pointer casts only — a struct-pointer
 *  cast is the dot-form's base, whose stride a raw re-spelling would collapse (the same reading
 *  l3/nearbase.ts's `baseConst` takes). */
const baseConst = (e: Expr): number | null =>
  e.k === 'const'
    ? e.value
    : e.k === 'cast' && !(e.to.kind === 'ptr' && e.to.to.kind === 'struct')
      ? baseConst(e.e)
      : null;

/** The whole address an `index` access denotes, or null when any part of it is not constant. */
function constAddress(ix: Extract<Expr, { k: 'index' }>): number | null {
  if (ix.lead !== undefined) {
    return null; // leading dimensions of a multidimensional global — not a numeric address
  }
  const base = baseConst(ix.base);
  return base === null || ix.idx.k !== 'const' ? null : base + ix.idx.value * ix.width;
}

/** Does this base already assert volatility — a `volatile` cast at any depth of the cast chain? */
const qualifiedBase = (e: Expr): boolean => e.k === 'cast' && (e.volatile === true || qualifiedBase(e.e));

/** The pointee the deref cast carries: the access's own scalar type. */
const pointee = (ix: Extract<Expr, { k: 'index' }>): IrType => scalarTypeForAccess(ix.width, ix.signed);

/** The store lvalue the gates admit, rewritten — or the input unchanged. */
function qualify(lval: Expr, window: readonly [number, number] | undefined): Expr {
  if (lval.k !== 'index') {
    return lval; // a `field` lvalue is a recovered struct view, whose declaration owns volatility
  }
  const address = constAddress(lval);
  const ctx: AccessCtx = {
    hasWindow: window !== undefined,
    address,
    inWindow: window !== undefined && address !== null && address >= window[0] && address < window[1],
    qualified: qualifiedBase(lval.base),
  };
  if (firstRejection(VOL_STORE_GATES, ctx) !== null) {
    return lval;
  }
  // An existing scalar pointer cast takes the qualifier in place; a bare const gets one minted,
  // exactly the node backend/cfamily.ts's own deref legalization would have synthesized.
  const base: Expr =
    lval.base.k === 'cast' && lval.base.to.kind === 'ptr'
      ? { ...lval.base, volatile: true }
      : { k: 'cast', to: T.ptr(pointee(lval)), volatile: true, e: lval.base };
  return { ...lval, base };
}

/** How many stores this tree would qualify — the enumeration gate, so a function with no device
 *  store costs one walk and no candidate. */
export function deviceStoreCount(sfn: SFn, window?: readonly [number, number]): number {
  let n = 0;
  const visit = (stmts: readonly Stmt[]): void => {
    for (const s of stmts) {
      if (s.k === 'store' && qualify(s.lval, window) !== s.lval) {
        n++;
      }
      for (const c of children(s)) {
        visit(c);
      }
    }
  };
  visit(sfn.body);
  return n;
}

/** The nested statement lists of one statement. Local rather than `stmtChildren` because the
 *  rewrite has to REBUILD each list in place, so it needs the lists themselves. */
function children(s: Stmt): Stmt[][] {
  switch (s.k) {
    case 'if':
      return [s.then, s.else];
    case 'while':
    case 'dowhile':
      return [s.body];
    case 'for':
      return [[s.init], [s.inc], s.body];
    case 'switch':
      return [...s.cases.map((c) => c.body), s.default ?? []];
    default:
      return [];
  }
}

/** The `/vol-store` candidate, or null when no store qualifies. Read-only: returns a fresh SFn
 *  whose body is rebuilt, leaving the input untouched. */
export function volatileDeviceStores(sfn: SFn, window?: readonly [number, number]): SFn | null {
  if (deviceStoreCount(sfn, window) === 0) {
    return null;
  }
  const rewrite = (stmts: readonly Stmt[]): Stmt[] =>
    stmts.map((s): Stmt => {
      switch (s.k) {
        case 'store':
          return { ...s, lval: qualify(s.lval, window) };
        case 'if':
          return { ...s, then: rewrite(s.then), else: rewrite(s.else) };
        case 'while':
        case 'dowhile':
          return { ...s, body: rewrite(s.body) };
        case 'for':
          return { ...s, init: rewrite([s.init])[0], inc: rewrite([s.inc])[0], body: rewrite(s.body) };
        case 'switch':
          return {
            ...s,
            cases: s.cases.map((c) => ({ ...c, body: rewrite(c.body) })),
            ...(s.default ? { default: rewrite(s.default) } : {}),
          };
        default:
          return s;
      }
    });
  return { ...sfn, body: rewrite(sfn.body) };
}
