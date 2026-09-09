// `pnpm bench gates` (src/run/gate-census.ts) is the supported way to take a gate table's refusal
// census, and it replaced a ~20-line recipe a round was told to copy into the repo and delete
// again. What can go wrong here is not the arithmetic — `tallying()` owns the counting and
// `packages/core/test/gate-tally.test.ts` pins it — it is the SEAM: the census counts nothing
// unless the wrapped tables are the ones the pass actually consults, and a swap that is not undone
// leaves the rest of the process counting into a stale wrapper.
//
// So this asserts the seam and the undo on a hand-built tree, with no toolchain: the CI mirror gate
// (`vitest run apps/benchmark/test`) runs where no compiler is available, so the enumeration itself
// is not what is exercised here.
import { T } from '@asmlift/core/ir/types';
import type { Expr, SFn, Stmt } from '@asmlift/core/l3/ast';
import { tallying } from '@asmlift/core/l3/gates';
import { PRE_FAN_PRODUCTS } from '@asmlift/core/rank-axes';
import { describe, expect, it } from 'vitest';

import { CENSUSABLE_PASSES, PASSES, gateCensus } from '../src/run/gate-census';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });

/** An `if` with an EMPTY arm, followed by a store — the shape `UNMERGE_SITE_GATES`' `empty-arm`
 *  rule refuses, chosen because it is the census's own top row on the agbcc synthetic tier. */
const emptyArmSite = (): SFn => ({
  name: 'f',
  params: [],
  locals: [{ name: 'p', type: T.s(32) }],
  globals: [],
  retType: T.void(),
  body: [
    { k: 'if', cond: v('cond'), then: [], else: [{ k: 'assign', name: 'p', value: c(1) }] },
    { k: 'store', lval: { k: 'index', base: v('p'), idx: c(0), width: 2, signed: false }, value: c(3) },
  ] as Stmt[],
});

const product = () => PRE_FAN_PRODUCTS.find((p) => p.suffix === '/unmerge')!;

describe('the gate census seam', () => {
  it('names the one pass whose caller-side seam is reachable from outside core', () => {
    // Not a count for its own sake: `run/gate-census.ts`'s header explains WHY it is one — fourteen
    // other tabled passes are reached through read-only module namespaces — so a second entry has
    // to re-open that paragraph rather than arrive silently.
    expect(CENSUSABLE_PASSES).toEqual(['unmerge']);
  });

  it('declares the five tables `UnmergeGates` names, in its order', () => {
    expect(PASSES.unmerge.tables.map(([name]) => name)).toEqual(['site', 'arm', 'value', 'rung', 'totality']);
  });

  it('routes the pass through the WRAPPED tables, and the undo restores the entry exactly', () => {
    const pass = PASSES.unmerge;
    const wrapped = pass.tables.map(([, t]) => tallying(t));
    const before = product().apply;
    const uninstall = pass.install(wrapped.map((w) => w.gates));
    expect(product().apply).not.toBe(before);

    // The swapped entry IS what a census counts through: one refusing tree, one count.
    product().apply(emptyArmSite());
    expect(wrapped[0].refusals()).toEqual([['empty-arm', 1]]);

    uninstall();
    expect(product().apply).toBe(before);

    // …and nothing counts afterwards, which is what makes a second census in one process readable.
    product().apply(emptyArmSite());
    expect(wrapped[0].refusals()).toEqual([['empty-arm', 1]]);
  });

  it('refuses a pass it cannot reach, rather than censusing zero', () => {
    // `raise/retsink.ts` takes its table as a parameter and is NOT censusable: its caller is a
    // static import in `pipeline.ts`. The distinction this refusal draws is the whole registry.
    expect(gateCensus({ pass: 'retsink' })).toBe(2);
  });
});
