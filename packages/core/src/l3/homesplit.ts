// The `/livebase-block × /regionbase` PAIRING (rank.ts `/livebase-block/homesplit`): one base kept
// at the function head and a SECOND base split into one local per region, in the same function.
//
// WHY IT IS NOT REACHABLE FROM EITHER LEVER. Both are whole-FUNCTION policies over the bases they
// bind: `hoistBaseLocals` homes every key its table admits at one placement, and
// `hoistScopedBases` splits every key its region rule admits. A function whose two bases want
// OPPOSITE answers is spelled by neither. `synthetic:dmapoll` is that function and its endpoint is
// compiled rather than argued: with both bases at function scope agbcc scores 11, with both split
// per region 18, with neither hoisted 69 — and 0 only where the two policies apply to DIFFERENT
// bases (the lattice in apps/benchmark/dataset/synthetic.ts).
//
// A PIPE, NEVER A MERGE, and that is the whole safety argument for the names. `hoistBaseLocals`
// runs FIRST with one key withheld; every key it homes now reads through a pointer LOCAL, which
// `SCOPEBASE_ELIGIBILITY`'s `shadowed-or-nonarray-base` refuses outright, so the second pass sees
// exactly the withheld key still inline. `nameAllocator` (l3/hoist.ts) re-derives its taken names
// from the tree it is handed, so the second pass cannot re-mint the first's. Merging two runs over
// ONE input is the shape that would collide, and nothing here does it.
//
// WHICH KEY IS WITHHELD IS NOT DERIVABLE, so every admitted key is offered as its own candidate and
// the differ referees — the same posture `/scopebase` and `/regionbase` take toward each other.
// The withhold itself is DATA: one rejection prepended to the caller's own admission table, in the
// `Gate<BaseKey>` type that table already has, so `firstRejection` names it and `ablateHeuristic`
// can price it.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION — both halves only re-spell where the address of a global
// is materialized, and each half's own contracts (`placeBaseLocals`' ordering, `assertHoistsDominate`
// on the region plan) still run. What the pairing can get WRONG is bytes, and one qualifier.
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtExprs, stmtLists } from './ast';
import { type BaseKey, baseSites, hoistBaseLocals } from './basecse';
import { type Gate, firstRejection } from './gates';
import type { HoistPlacement } from './hoist';
import { hoistScopedBases, planScopedBases, scopedBaseKey } from './scopebase';

/** `gates` with `key` refused. The withhold goes FIRST so `firstRejection` attributes a refusal to
 *  it rather than to whichever inherited rule would also have fired. */
export const withholdingKey = (gates: readonly Gate<BaseKey>[], key: string): readonly Gate<BaseKey>[] => [
  {
    id: 'withheld-key',
    why: 'this key is the one the region rule is to split, so the head hoist must not claim it',
    sound: false,
    rejects: (c) => c.key === key,
  },
  ...gates,
];

/** One candidate PAIRING, as the admission rules see it. */
export interface HomeSplitCtx {
  /** how many keys the caller's admission table binds — the pairing needs at least two */
  readonly hoistableKeys: number;
  /** the region rule gives the withheld key two or more locals */
  readonly withheldSplits: boolean;
  /** the withheld key is a DEVICE address and the piped tree leaves a READ of it inline */
  readonly inlineDeviceRead: boolean;
}

/** The pairing's admission. NONE is sound, and none is owed a `sound: true`: withholding a key from
 *  the head hoist and splitting it per region names the SAME ADDRESS in a different place (`keyOf`
 *  folds width and signedness into the key), the two rules that decide MEANING already live in
 *  `SCOPEBASE_ELIGIBILITY`, and a plan over a SUBSET of the keys admits nothing the all-keys plan
 *  did not. What these rules decide is bytes, fan, and one qualifier.
 *
 *  `homesplit-drops-device-volatile` is the one that protects a row rather than the fan.
 *  `/volatile` (l3/volatileptr.ts) qualifies MINTED POINTER LOCALS and `/vol-store` (l3/volstore.ts)
 *  a STORE at a fixed device address; a device READ left inline is reached by neither. Withholding
 *  a key is exactly what can leave one there — the head hoist would have homed it into a local
 *  `/volatile` covers — so the pairing declines rather than publish a spelling that silently drops
 *  a qualifier the spelling it replaces carried. */
export const HOMESPLIT_GATES: readonly Gate<HomeSplitCtx>[] = [
  {
    id: 'homesplit-degenerate',
    why: 'withholding the only hoistable key is `/regionbase`, and withholding none is `/livebase-block`',
    sound: false,
    rejects: (c) => c.hoistableKeys < 2,
  },
  {
    id: 'homesplit-fan-cap',
    why: 'one candidate per hoistable key, times the volatile products — the whole cost of the axis',
    sound: false,
    rejects: (c) => c.hoistableKeys > 3,
  },
  {
    id: 'homesplit-no-region',
    why: 'a withheld key the region rule declines to split leaves the spelling the primary carries',
    sound: false,
    rejects: (c) => !c.withheldSplits,
  },
  {
    id: 'homesplit-drops-device-volatile',
    why: 'a device read left inline is qualified by neither /volatile nor /vol-store',
    sound: false,
    rejects: (c) => c.inlineDeviceRead,
  },
];

export interface HomeSplitOpts {
  /** the caller's own admission table — `/livebase-block`'s on the roster row that pairs */
  readonly gates: readonly Gate<BaseKey>[];
  readonly placement: HoistPlacement;
  /** the key withheld from the head hoist, in `l3/basecse.ts` vocabulary */
  readonly key: string;
  /** how many keys `gates` binds on this tree — the caller already censused it */
  readonly hoistableKeys: number;
  readonly deviceRegisters?: readonly [number, number];
  readonly admission?: readonly Gate<HomeSplitCtx>[];
}

/** Every `index`-of-const-base READ in the tree — an access reached anywhere but as a store's own
 *  lvalue. A store's lvalue is what `/vol-store` can still qualify; nothing else is. */
function constBaseReads(body: Stmt[], out: Set<number>): void {
  const visit = (e: Expr): void => {
    if (e.k === 'index' && e.base.k === 'const') {
      out.add(e.base.value);
    }
    childrenOf(e).forEach(visit);
  };
  for (const s of body) {
    for (const e of stmtExprs(s)) {
      // a store's LVALUE is the one position `/vol-store` reaches, so it is not a read
      if (s.k === 'store' && e === s.lval) {
        childrenOf(e).forEach(visit);
        continue;
      }
      visit(e);
    }
    for (const child of stmtLists(s)) {
      constBaseReads(child, out);
    }
  }
}

const childrenOf = (e: Expr): Expr[] => {
  const out: Expr[] = [];
  mapExprChildren(e, (c) => {
    out.push(c);
    return c;
  });
  return out;
};

/**
 * The pairing for ONE withheld key: the tree with every OTHER admitted base homed at `placement`,
 * and the withheld one split per region. `homed` is the intermediate — the caller re-checks the
 * placement differential across the pipe with it. Null when a rule refuses, or when either half
 * declines.
 */
export function splitHomeBases(sfn: SFn, opts: HomeSplitOpts): { homed: SFn; split: SFn } | null {
  const gates = opts.admission ?? HOMESPLIT_GATES;
  const homed = hoistBaseLocals(sfn, withholdingKey(opts.gates, opts.key), opts.placement);
  const out = hoistScopedBases(homed, { regions: 'per-region' });
  // The withheld key in the REGION pass's vocabulary. The two passes key on the same address but
  // spell an `addr` base's identity differently, so the translation is explicit — a string compare
  // across them would silently never match for an `addr` base.
  const meta = baseSites(sfn).get(opts.key);
  const scoped = meta ? scopedBaseKey(meta.base, meta.width, meta.signed) : null;
  const split = planScopedBases(homed, { regions: 'per-region' }).entries.filter((e) => e.key === scoped).length;
  // Judged on the SPLIT tree, which is the only one that answers the question: an access the region
  // rule repoints into a minted local is one `/volatile` covers, and on `homed` it is still inline.
  const reads = new Set<number>();
  constBaseReads((out ?? homed).body, reads);
  const win = opts.deviceRegisters;
  const addr = meta?.base.k === 'const' ? meta.base.value : undefined;
  if (
    firstRejection(gates, {
      hoistableKeys: opts.hoistableKeys,
      withheldSplits: split >= 2,
      inlineDeviceRead: win !== undefined && addr !== undefined && addr >= win[0] && addr < win[1] && reads.has(addr),
    }) !== null
  ) {
    return null;
  }
  return out ? { homed, split: out } : null;
}
