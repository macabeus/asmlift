// `pnpm bench gates` (src/run/gate-census.ts) is the supported way to take a gate table's refusal
// census. What can go wrong here is not the arithmetic — `tallying()` owns the counting and
// `packages/core/test/gate-tally.test.ts` pins it — it is the SEAM: the census counts nothing
// unless the wrapped tables are the ones the pass actually consults, and a swap that is not undone
// leaves the rest of the process counting into a stale wrapper.
//
// So this asserts the seam and the undo on a hand-built tree, with no toolchain: the CI mirror gate
// (`vitest run apps/benchmark/test`) runs where no compiler is available, so the enumeration itself
// is not what is exercised here.
import { parse } from '@asmlift/core/ir/parse';
import { T } from '@asmlift/core/ir/types';
import type { Expr, SFn, Stmt } from '@asmlift/core/l3/ast';
import { tallying } from '@asmlift/core/l3/gates';
import { emptyScaleRecord } from '@asmlift/core/raise/extscale';
import { PRE_RECOVERY_PASSES } from '@asmlift/core/raise/pre-recovery';
import { PRE_FAN_PRODUCTS } from '@asmlift/core/rank-axes';
import { ARMV4T_AGBCC, PPC_MWCC, type TargetDescription } from '@asmlift/core/target';
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
  it('names the two registered passes', () => {
    // Not a count for its own sake: `run/gate-census.ts`'s header says which tabled passes have a
    // caller-side seam and what an entry costs, so a third entry has to re-open that paragraph
    // rather than arrive silently.
    expect(CENSUSABLE_PASSES).toEqual(['unmerge', 'arm-reread']);
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

  it('routes the branch fold through the WRAPPED re-read table, and the undo restores the entry', () => {
    // A site `read-behind-effect` refuses on agbcc: the arm reads the second test's load after a
    // call. Parsed IR, so no toolchain — the same reason as the unmerge case above.
    const site = () =>
      parse(
        'fn f {\n^bb0(%0: u8*, %1: s32):\n  %2: s32 = const {value=0}\n  %3: u32 = icmp_ne %1, %2\n' +
          '  cond_br %3, ^bb1(), ^bb2()\n^bb1():\n  %4: u8 = load %0 {off=1, width=1, signed=false}\n' +
          '  %5: s32 = const {value=127}\n  %6: u32 = icmp_eq %4, %5\n  cond_br %6, ^bb3(), ^bb2()\n' +
          '^bb2():\n  ret\n^bb3():\n  %7: s32 = call {target="fnB"}\n  store %0, %4 {off=2, width=1}\n  ret\n}\n',
      );
    const entry = () => PRE_RECOVERY_PASSES.find((p) => p.id === 'branch-shortcircuit')!;
    const run = (target: TargetDescription) =>
      entry().run(site(), undefined, {}, target, {
        mergeShapes: new Map(),
        poolOrder: { entryParams: new Set(), afterPoolLoad: new Set() },
        scales: emptyScaleRecord(),
      });
    const pass = PASSES['arm-reread'];
    const wrapped = pass.tables.map(([, t]) => tallying(t));
    const before = entry().run;
    const uninstall = pass.install(wrapped.map((w) => w.gates));
    expect(entry().run).not.toBe(before);
    expect(run(ARMV4T_AGBCC)).toBe(false);
    expect(wrapped[0].refusals()).toEqual([['read-behind-effect', 1]]);
    // …and the wrapper keeps the TARGET the entry reads: on mwcc a local is one load, so it folds.
    expect(run(PPC_MWCC)).toBe(true);
    expect(wrapped[0].refusals()).toEqual([['read-behind-effect', 1]]);
    uninstall();
    expect(entry().run).toBe(before);
    run(ARMV4T_AGBCC);
    expect(wrapped[0].refusals()).toEqual([['read-behind-effect', 1]]);
  });

  it('refuses a pass it cannot reach, rather than censusing zero', () => {
    // `raise/retsink.ts` takes its table as a parameter and is NOT censusable: its caller is a
    // static import in `pipeline.ts`. The distinction this refusal draws is the whole registry.
    expect(gateCensus({ pass: 'retsink' })).toBe(2);
  });
});
