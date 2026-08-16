// The cross-module contract between the four passes that answer "is this address a local?" —
// raise/gvn.ts (never), l3/basecse.ts (function top), l3/scopebase.ts (innermost scope),
// l3/argbase.ts (before the call). Each is unit-tested on its own; what has no home is what they
// promise EACH OTHER, which is where a consolidation would break something silently.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { simplifyTrivialPhis } from '../src/ir/simplify';
import { T } from '../src/ir/types';
import { materializeArgBases } from '../src/l3/argbase';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import { hoistReusedGlobalBases } from '../src/l3/basecse';
import { hoistScopedBases } from '../src/l3/scopebase';
import { structureChecked } from '../src/pipeline';
import { numberPureValues } from '../src/raise/gvn';
import type { SymbolInfo } from '../src/symbols';

// Two arms both naming `gTable`, merged, then read at two statements with a call between them —
// the shape gvn.ts's header is written about, and the one that satisfies analysis.ts's
// multi-use-live-across-a-call test if that test ever admitted an address op.
const TWO_ARMS_ACROSS_A_CALL = `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: u16* = gaddr {sym="gTable"}
  br ^bb3(%3)
^bb2():
  %4: u16* = gaddr {sym="gTable"}
  br ^bb3(%4)
^bb3(%5: u16*):
  %6: s32 = load %5 {off=0, signed=false, width=2}
  %7: s32 = call %6 {target="sink"}
  %8: s32 = load %5 {off=8, signed=false, width=2}
  ret %8
}
`;

const numbered = (symbols?: Map<string, SymbolInfo>): SFn => {
  const fn = parse(TWO_ARMS_ACROSS_A_CALL);
  expect(numberPureValues(fn)).toBe(2);
  simplifyTrivialPhis(fn);
  return structureChecked(fn, symbols ? { symbols } : {});
};

/** gTable as the project's own headers declare it: `u16 gTable[4][0x400]`. */
const RANK_2 = new Map<string, SymbolInfo>([
  ['gTable', { name: 'gTable', kind: 'data', shape: 'array', elemSize: 2, dims: [4, 1024], declared: true }],
]);

describe('gvn hoists to the ENTRY block, which is only free if nothing gives it a home', () => {
  test('a numbered address reused across a call is re-spelled at each use, not named', () => {
    // gvn puts one `gaddr` in the entry block — the MAXIMAL live range, the opposite of what the
    // other three passes do — and its whole safety argument is that the structurer inlines a pure
    // non-`const` value at each use. Widen analysis.ts's materialize rule to address ops and this
    // reverts to `v0 = (u16 *)&gTable;` at the function top: the very local gvn exists to delete,
    // reintroduced one level up. Nothing else in the suite notices that edit.
    const out = numbered(RANK_2);
    expect(out.locals).toEqual([]);
    expect(cBackend.emit(out)).toContain('gTable[0][0]');
  });
});

describe('the win is contingent on the symbol map — gvn.ts says so, this is the measurement', () => {
  test('WITH a rank-aware map the accesses spell bare, and no pass re-creates the local', () => {
    expect(cBackend.emit(numbered(RANK_2))).not.toMatch(/u16 \* \w+;/);
  });

  test('WITHOUT one they spell `(u16 *)&gTable` and basecse hoists the local straight back', () => {
    // Not a defect to fix: it is the same address in the same place, one pass later, and it is why
    // gvn.ts calls its own win contingent. Pinned so the contingency cannot quietly stop being true.
    const src = cBackend.emit(numbered());
    expect(src).toMatch(/u16 \* (\w+);\n\s+\1 = \(u16 \*\)&gTable;/);
  });
});

const ix = (i: Expr, base: Expr = { k: 'addr', name: 'g' }): Expr => ({
  k: 'index',
  base,
  idx: i,
  width: 1,
  signed: false,
});

describe('basecse and scopebase disagree about a `for` init, and the disagreement is observable', () => {
  // scopebase.ts records this in a comment; a consolidation has to pick one reading, so it is pinned
  // rather than described. A `for`'s init runs ONCE: scopebase counts it at the enclosing cadence
  // (the truthful reading), basecse counts it in-loop via `stmtChildren('for')` and refuses.
  const forStmt: Stmt = {
    k: 'for',
    init: {
      k: 'assign',
      name: 'i',
      value: { k: 'bin', op: '+', l: ix({ k: 'const', value: 1 }), r: ix({ k: 'var', name: 'a0' }) },
    },
    cond: { k: 'const', value: 1 },
    inc: { k: 'assign', name: 'i', value: { k: 'const', value: 0 } },
    body: [{ k: 'exprstmt', value: { k: 'call', fn: 'sink', args: [] } }],
  };
  const fn: SFn = {
    name: 'f',
    params: [{ name: 'a0', type: T.s(32) }],
    locals: [{ name: 'i', type: T.s(32) }],
    globals: [{ name: 'g', type: T.ptr(T.u(8)) }],
    retType: T.void(),
    body: [{ k: 'if', cond: { k: 'const', value: 1 }, then: [forStmt], else: [] }],
  };

  test('basecse refuses it — its `for` children are recursed with the loop flag set', () => {
    expect(cBackend.emit(hoistReusedGlobalBases(fn))).toContain('((u8 *)&g)[1]');
  });

  test('scopebase hoists it, immediately before the loop', () => {
    const out = hoistScopedBases(fn);
    expect(out).not.toBeNull();
    expect(cBackend.emit(out!)).toMatch(/(\w+) = \(u8 \*\)&g;\n\s+for \(i = \1\[1\]/);
  });
});

describe('a global name shadowed by a local: scopebase refuses, argbase does not — and must not', () => {
  // The asymmetry is load-bearing, not drift. scopebase re-spells the base as `&g`, which under a
  // shadowing local binds the LOCAL's address — a different object — so it filters shadowed names
  // out. argbase keeps the base expression verbatim (`(u8 *)g`) and places the assignment
  // immediately before the same statement, so it denotes what the original access denoted.
  // Giving argbase scopebase's filter, or scopebase argbase's laxity, breaks one of them.
  const shadowed: SFn = {
    name: 'f',
    params: [],
    locals: [{ name: 'g', type: T.ptr(T.u(8)) }],
    globals: [
      { name: 'g', type: T.ptr(T.u(8)) },
      { name: 'h', type: T.ptr(T.u(8)) },
    ],
    retType: T.void(),
    body: [
      {
        k: 'exprstmt',
        value: {
          k: 'call',
          fn: 'sink',
          args: [
            ix({ k: 'const', value: 1 }, { k: 'var', name: 'g' }),
            ix({ k: 'const', value: 2 }, { k: 'var', name: 'h' }),
          ],
        },
      },
    ],
  };

  test('argbase names it, by VALUE — `(u8 *)g`, never `&g`', () => {
    const out = materializeArgBases(shadowed);
    expect(out).not.toBeNull();
    const src = cBackend.emit(out!);
    expect(src).toContain('= (u8 *)g;');
    expect(src).not.toContain('&g');
  });

  // Inside an `if` arm, so a scope exists to hoist INTO: at the function's top level scopebase
  // declines whatever the name is, and the filter would not be what decided.
  const inAnArm = (name: string): SFn => ({
    ...shadowed,
    body: [
      {
        k: 'if',
        cond: { k: 'const', value: 1 },
        then: [
          { k: 'exprstmt', value: { k: 'call', fn: 'sink', args: [ix({ k: 'const', value: 1 }, { k: 'var', name })] } },
          { k: 'exprstmt', value: { k: 'call', fn: 'sink', args: [ix({ k: 'const', value: 2 }, { k: 'var', name })] } },
        ],
        else: [],
      },
    ],
  });

  test('scopebase declines the shadowed name rather than take its address', () => {
    expect(hoistScopedBases(inAnArm('g'))).toBeNull();
    // the same shape on the UNSHADOWED `h` does fire — so it is the filter that decided
    expect(cBackend.emit(hoistScopedBases(inAnArm('h'))!)).toContain('= (u8 *)&h;');
  });
});
