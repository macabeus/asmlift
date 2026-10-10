// `DefaultAcceptsMemo` answers `assertDefaultAccepts` for a reset it has already structured: the
// guard's own run either accepted it, or threw the refusal the memo throws again. Answering a reset
// it has NOT structured would let a candidate ship where the default declines, so most of what is
// pinned here is when it runs the reset again.
//
// A replayed refusal is the error object the first run threw, and a fresh run throws a new one, so
// `toBe` on the caught error tells a replay from a run.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Fn } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import {
  DefaultAcceptsMemo,
  StructureError,
  type StructureHooks,
  type StructureOptions,
  structure,
} from '../src/structure/structure';
import type { SymbolInfo } from '../src/symbols';

const fnOf = (ir: string): Fn => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return fn;
};

// A cycle entered at both of its blocks: no block dominates it, so structuring declines it under
// every option, and the guard's reset run is the first to throw.
const IRREDUCIBLE = `fn irred {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_sgt %0, %1
  cond_br %2, ^bb1(%0), ^bb2(%0)
^bb1(%3: s32):
  %4: s32 = const {value=1}
  %5: s32 = sub %3, %4
  br ^bb2(%5)
^bb2(%6: s32):
  %7: s32 = const {value=0}
  %8: u32 = icmp_sgt %6, %7
  cond_br %8, ^bb1(%6), ^bb3(%6)
^bb3(%9: s32):
  ret %9
}
`;

// `u16 v = gVolReg; if (a0 > 0) return v; return v + 1;` — under a map declaring `gVolReg` volatile,
// structuring stamps the read before it reaches the guard.
const VOLATILE_READ = `fn arms {
^bb0(%0: s32):
  %1: u16* = gaddr {sym="gVolReg"}
  %2: u16 = load %1 {off=0, signed=false, width=2}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  ret %2
^bb2():
  %5: s32 = const {value=1}
  %6: s32 = add %2, %5
  ret %6
}
`;
const VOLATILE = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data', volatile: true }]]);

/** What `structure()` threw. */
const refusal = (fn: Fn, opts: StructureOptions, memo?: DefaultAcceptsMemo, hooks: StructureHooks = {}): unknown => {
  try {
    structure(fn, opts, hooks, memo);
  } catch (e) {
    return e;
  }
  throw new Error('structure() accepted a function it must decline');
};

describe('DefaultAcceptsMemo', () => {
  test('replays the refusal it recorded to a setting that shares the reset', () => {
    const fn = fnOf(IRREDUCIBLE);
    const memo = new DefaultAcceptsMemo(fn);
    const first = refusal(fn, { coalesceMergeNames: true }, memo);
    expect(first).toBeInstanceOf(StructureError);
    expect(refusal(fn, { materializeJoinFeeds: true }, memo)).toBe(first);
    expect(refusal(fn, { followEarlyReturns: true, anchorConstCopies: true }, memo)).toBe(first);
  });

  test('replays the refusal a fresh structuring throws', () => {
    const fn = fnOf(IRREDUCIBLE);
    const memo = new DefaultAcceptsMemo(fn);
    refusal(fn, { homeLoopExprs: true }, memo);
    const replayed = refusal(fn, { homeDerivedReads: true }, memo);
    const fresh = refusal(fn, { homeDerivedReads: true });
    expect(fresh).not.toBe(replayed);
    expect(fresh).toBeInstanceOf(StructureError);
    expect((fresh as Error).message).toBe((replayed as Error).message);
  });

  test('runs the reset again for a setting whose reset differs in any value', () => {
    const fn = fnOf(IRREDUCIBLE);
    const memo = new DefaultAcceptsMemo(fn);
    const seen = [
      refusal(fn, { coalesceMergeNames: true }, memo),
      refusal(fn, { coalesceMergeNames: true, returnsVoid: true }, memo),
      refusal(fn, { coalesceMergeNames: true, spillSlotOrder: 'ascending' }, memo),
      refusal(fn, { coalesceMergeNames: true, spillSlotOrder: 'descending' }, memo),
      refusal(fn, { coalesceMergeNames: true, branchSenseFlipSites: new Set([1]) }, memo),
      refusal(fn, { coalesceMergeNames: true, branchSenseFlipSites: new Set([2]) }, memo),
      refusal(fn, { coalesceMergeNames: true, branchSenseFlipSites: new Set([1, 2]) }, memo),
      refusal(fn, { coalesceMergeNames: true, symbols: new Map() }, memo),
      refusal(fn, { coalesceMergeNames: true, symbols: new Map() }, memo),
    ];
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('keys a small set of primitives by its members, and a bigger one or a map by identity', () => {
    const fn = fnOf(IRREDUCIBLE);
    const memo = new DefaultAcceptsMemo(fn);
    const symbols = new Map<string, SymbolInfo>();
    const small = refusal(fn, { coalesceMergeNames: true, branchSenseFlipSites: new Set([3]), symbols }, memo);
    expect(refusal(fn, { freshParamMerge: true, branchSenseFlipSites: new Set([3]), symbols }, memo)).toBe(small);

    const sites = Array.from({ length: 65 }, (_, i) => i);
    const big = new Set(sites);
    const bigFirst = refusal(fn, { coalesceMergeNames: true, branchSenseFlipSites: big }, memo);
    expect(refusal(fn, { freshParamMerge: true, branchSenseFlipSites: big }, memo)).toBe(bigFirst);
    expect(refusal(fn, { freshParamMerge: true, branchSenseFlipSites: new Set(sites) }, memo)).not.toBe(bigFirst);
  });

  test('treats an option set to undefined as an option left out', () => {
    const fn = fnOf(IRREDUCIBLE);
    const memo = new DefaultAcceptsMemo(fn);
    const first = refusal(fn, { coalesceMergeNames: true, symbols: undefined }, memo);
    expect(refusal(fn, { coalesceMergeNames: true }, memo)).toBe(first);
  });

  test('runs the reset on every call that carries a hook', () => {
    const fn = fnOf(IRREDUCIBLE);
    const memo = new DefaultAcceptsMemo(fn);
    const hooks: StructureHooks = { onBranchSenseSite: () => {} };
    const first = refusal(fn, { coalesceMergeNames: true }, memo, hooks);
    expect(refusal(fn, { coalesceMergeNames: true }, memo, hooks)).not.toBe(first);
  });

  test('answers an accepted reset once it has structured it', () => {
    const fn = fnOf(VOLATILE_READ);
    const memo = new DefaultAcceptsMemo(fn);
    let runs = 0;
    const reset: StructureOptions = { symbols: VOLATILE, coalesceMergeNames: false };
    const run = (): void => {
      runs++;
      structure(fn, reset);
    };
    memo.check(fn, {}, reset, run);
    memo.check(fn, {}, { ...reset }, run);
    expect(runs).toBe(1);
  });

  test('structures every setting it answers as a fresh structuring does', () => {
    const fn = fnOf(VOLATILE_READ);
    const memo = new DefaultAcceptsMemo(fn);
    const settings: StructureOptions[] = [
      { symbols: VOLATILE, coalesceMergeNames: true },
      { symbols: VOLATILE, materializeJoinFeeds: true },
      { symbols: VOLATILE, followEarlyReturns: true },
      { coalesceMergeNames: true },
      { symbols: VOLATILE, homeSharedAddresses: true },
    ];
    for (const opts of settings) {
      expect(cBackend.emit(structure(fn, opts, {}, memo))).toBe(cBackend.emit(structure(fnOf(VOLATILE_READ), opts)));
    }
  });

  test('refuses a fn it was not made for', () => {
    const memo = new DefaultAcceptsMemo(fnOf(IRREDUCIBLE));
    const other = fnOf(IRREDUCIBLE);
    expect(() => structure(other, { coalesceMergeNames: true }, {}, memo)).toThrow(/not made for/);
  });
});
