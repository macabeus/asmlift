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
// WHICH KEY IS WITHHELD IS NOT DERIVABLE, so every admitted key is offered as its own candidate,
// LABELLED WITH THAT KEY, and the differ referees — the same posture `/scopebase` and `/regionbase`
// take toward each other. The label carries `homeSplitTag(key)` because a candidate label is an
// IDENTITY: `bench diff` and docs/ranked-repro.md compare candidates by it, so one label over two
// withholds would hide a program swap from both. The withhold itself is DATA: one rejection
// prepended to the caller's own admission table, in the `Gate<BaseKey>` type that table already
// has, so `firstRejection` names it and `ablateHeuristic` can price it.
//
// EXACTLY ONE KEY IS WITHHELD, and the arity is a claim rather than an oversight. A two-key withhold
// exists only where the caller's table binds three — `homesplit-fan-cap` admits no more — so it is
// three more candidates per axis point on those functions alone, and no row asks for one.
// `l3/volatileptr.ts`'s `volatileSubsetCandidates` enumerates every proper subset under the same
// cap; it does that because a row demanded each of them. Widen this the same way, on a row.
//
// SEMANTICS ARE PRESERVED BY CONSTRUCTION — both halves only re-spell where the address of a global
// is materialized, and each half's own contracts (`placeBaseLocals`' ordering, `assertHoistsDominate`
// on the region plan) still run. What the pairing can get WRONG is bytes, and one qualifier.
import { inRange } from './address';
import type { Expr, SFn, Stmt } from './ast';
import { mapExprChildren, stmtExprs, stmtLists } from './ast';
import { type BaseKey, baseSites, hoistBaseLocals } from './basecse';
import { type Gate, firstRejection } from './gates';
import type { HoistPlacement } from './hoist';
import { applyScopedBasePlan, planScopedBases, scopedBaseKey } from './scopebase';

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

/** The withheld key as a LABEL token: `c:67109076 4 true` → `0x40000d4.4s`. Width and signedness
 *  ride because they are part of the key — two keys over one address are two different spellings. */
export function homeSplitTag(key: string): string {
  const [id = '', width = '', signed = ''] = key.split(' ');
  const base = id.startsWith('c:') ? `0x${Number(id.slice(2)).toString(16)}` : id.slice(id.indexOf(':') + 1);
  return `${base}.${width}${signed === 'true' ? 's' : 'u'}`;
}

/** The FUNCTION-level half of the admission: how many keys the caller's table binds on this tree.
 *  Nothing about one withheld key, which is why it is decided once (see `homeSplitWithholds`). */
export interface HomeSplitFanCtx {
  /** how many keys the caller's admission table binds — the pairing needs at least two */
  readonly hoistableKeys: number;
}

/** The two rules that read the tree's KEY COUNT and nothing else. Asking them per candidate ran the
 *  whole pipe — head hoist, region plan, rewrite, census — to be told the function has more than
 *  three keys, which is a fact the caller holds before any of it. */
export const HOMESPLIT_FAN_GATES: readonly Gate<HomeSplitFanCtx>[] = [
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
];

/** One candidate PAIRING, as the per-key admission rules see it. */
export interface HomeSplitCtx {
  /** the region rule gives the withheld key two or more locals */
  readonly withheldSplits: boolean;
  /** the withheld key is a DEVICE address and the piped tree leaves a READ of it inline */
  readonly inlineDeviceRead: boolean;
}

/** The pairing's PER-KEY admission. NONE is sound, and none is owed a `sound: true`: withholding a
 *  key from the head hoist and splitting it per region names the SAME ADDRESS in a different place
 *  (`keyOf` folds width and signedness into the key), the two rules that decide MEANING already
 *  live in `SCOPEBASE_ELIGIBILITY`, and a plan over a SUBSET of the keys admits nothing the
 *  all-keys plan did not. What these rules decide is bytes, fan, and one qualifier.
 *
 *  `homesplit-drops-device-volatile` is the one that protects a row rather than the fan.
 *  `/volatile` (l3/volatileptr.ts) qualifies MINTED POINTER LOCALS and `/vol-store` (l3/volstore.ts)
 *  a STORE at a fixed device address; a device READ left inline is reached by neither. Withholding
 *  a key is exactly what can leave one there — the head hoist would have homed it into a local
 *  `/volatile` covers — so the pairing declines rather than publish a spelling that silently drops
 *  a qualifier the spelling it replaces carried. It asks about an ADDRESS, not about a node kind:
 *  under a symbol map an absolute pool constant lifts to a `gaddr`, so a rule reading only `const`
 *  bases would stand down on exactly the arm the benchmark runs (see `HomeSplitOpts.addressOf`). */
export const HOMESPLIT_GATES: readonly Gate<HomeSplitCtx>[] = [
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

/** The keys this tree offers as withholds — one candidate each, or none at all. The caller asks
 *  ONCE per (tree, admission table) and loops over the answer. */
export function homeSplitWithholds(
  keys: readonly string[],
  admission: readonly Gate<HomeSplitFanCtx>[] = HOMESPLIT_FAN_GATES,
): readonly string[] {
  return firstRejection(admission, { hoistableKeys: keys.length }) === null ? keys : [];
}

export interface HomeSplitOpts {
  /** the caller's own admission table — `/livebase-block`'s on the roster row that pairs */
  readonly gates: readonly Gate<BaseKey>[];
  readonly placement: HoistPlacement;
  /** the key withheld from the head hoist, in `l3/basecse.ts` vocabulary */
  readonly key: string;
  readonly deviceRegisters?: readonly [number, number];
  /** the address a NAMED base denotes. A symbol's address is the symbol map's fact and no L3 tree
   *  carries it, so the caller resolves it; unresolved, the device rule stands down. */
  readonly addressOf?: (name: string) => number | null;
  readonly admission?: readonly Gate<HomeSplitCtx>[];
}

/** A leaf deref base's identity, ignoring the access width — `l3/basecse.ts`'s spelling of it. */
const leafBaseId = (b: Expr): string | null =>
  b.k === 'const' ? `c:${b.value}` : b.k === 'addr' ? `a:${b.name}` : null;

/** Every leaf-based READ in the tree, by base identity — an access reached anywhere but as a
 *  store's own lvalue. A store's lvalue is what `/vol-store` can still qualify; nothing else is. */
function baseReads(body: Stmt[], out: Set<string>): void {
  const visit = (e: Expr): void => {
    if (e.k === 'index') {
      const id = leafBaseId(e.base);
      if (id !== null) {
        out.add(id);
      }
    }
    childrenOf(e).forEach(visit);
  };
  const walk = (s: Stmt): void => {
    for (const e of stmtExprs(s)) {
      // a store's LVALUE is the one position `/vol-store` reaches, so it is not a read
      if (s.k === 'store' && e === s.lval) {
        childrenOf(e).forEach(visit);
        continue;
      }
      visit(e);
    }
    if (s.k === 'for') {
      // `init` and `inc` are STATEMENTS, reached by neither `stmtExprs` nor `stmtLists` — the same
      // walker asymmetry `l3/scopebase.ts`'s `collect` calls out. A read missed here is a device
      // read the rule below cannot see.
      walk(s.init);
      walk(s.inc);
    }
    for (const child of stmtLists(s)) {
      child.forEach(walk);
    }
  };
  body.forEach(walk);
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
  // The withheld key in the REGION pass's vocabulary. The two passes key on the same address but
  // spell an `addr` base's identity differently, so the translation is explicit — a string compare
  // across them would silently never match for an `addr` base.
  const meta = baseSites(sfn).get(opts.key);
  const scoped = meta ? scopedBaseKey(meta.base, meta.width, meta.signed) : null;
  // ONE plan, then its applier — the count below and the rewrite read the same decision rather than
  // two runs of the planner that a future rule could make disagree.
  const plan = planScopedBases(homed, { regions: 'per-region' });
  const split = plan.entries.filter((e) => e.key === scoped).length;
  const out = applyScopedBasePlan(homed, plan);
  // Judged on the SPLIT tree, which is the only one that answers the question: an access the region
  // rule repoints into a minted local is one `/volatile` covers, and on `homed` it is still inline.
  const reads = new Set<string>();
  baseReads((out ?? homed).body, reads);
  const id = meta ? leafBaseId(meta.base) : null;
  const addr = meta ? (meta.base.k === 'const' ? meta.base.value : (opts.addressOf?.(meta.base.name) ?? null)) : null;
  if (
    firstRejection(gates, {
      withheldSplits: split >= 2,
      inlineDeviceRead: id !== null && inRange(addr, opts.deviceRegisters) && reads.has(id),
    }) !== null
  ) {
    return null;
  }
  if (out === null) {
    // `homesplit-no-region` admitted two or more entries for the withheld key, so the plan is
    // neither empty nor compound and the applier cannot decline. Loud rather than a silent refusal.
    throw new Error(`homesplit: the region plan splits ${opts.key} ${split} ways and the applier declined`);
  }
  return { homed, split: out };
}
