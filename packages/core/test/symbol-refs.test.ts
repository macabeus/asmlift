// SELF-DECLARING CANDIDATES — Candidate.symbolRefs, derived by l3/symbol-refs.ts from each
// candidate's final tree at enumeration (research/self-declaring-candidates-2026-07-26.md).
//
// Pins the derivation's contracts: a map-derived VALUE reference (data global, `(u32)Func`) is
// recorded with its SymbolInfo; a CALL target is NEVER recorded — not even when the same symbol
// is also value-referenced (prototyping a called symbol is C89 poison, verified fact 3 of the
// research doc), unless a static's initializer names it ahead of the call, where it is recorded as
// C's own implicit declaration; the '/raw-globals' variation names nothing so it carries no refs;
// and INERTNESS — no map ⇒ the field is absent everywhere.
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import { enumerateCandidates } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

const enumerate = (sym: string, body: string, symbols?: SymbolMap) =>
  enumerateCandidates(sym, `${sym}:\n${body}`, ARMV4T_AGBCC, symbols ? { symbols } : {});

// ldr rN, =0x03001234; load a halfword through it — promotes to the mapped name
const LOADH = '\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
const COUNTER = { name: 'gCounter', kind: 'data', shape: 'scalar', size: 2, signed: false } as const;
// a second mapped symbol this function never touches — a real project map is mostly these
const ELSEWHERE = { name: 'gElsewhere', kind: 'data', shape: 'scalar', size: 4, signed: true } as const;

describe('value references are recorded with their SymbolInfo', () => {
  test('a named data global carries its map facts; an untouched mapped symbol carries none', () => {
    // The map holds two symbols and the function names ONE. The exact-equality assertion below is
    // what pins that the reference set is the TREE's, not the map's: refs are derived from each
    // candidate's final tree at the consumption point (l3/symbol-refs.ts) rather than accumulated
    // as symbols are encountered, so an unreferenced symbol is never a declaration. (m2c reached
    // the same end differently — its symbols WERE accumulated, and declaration emission was later
    // wired into its existing `Expression.use()` protocol, upstream 7e8e106.)
    const cands = enumerate(
      'f',
      LOADH,
      new Map([
        [0x03001234, [{ ...COUNTER }]],
        [0x03005678, [{ ...ELSEWHERE }]],
      ]),
    );
    const named = cands.filter((c) => !hasVariation(c.variations, 'raw-globals'));
    const raw = cands.filter((c) => hasVariation(c.variations, 'raw-globals'));
    expect(named.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    for (const c of named) {
      expect(c.symbolRefs).toEqual([{ name: 'gCounter', info: COUNTER }]);
    }
    for (const c of raw) {
      expect(c.symbolRefs).toBeUndefined(); // names nothing ⇒ declares nothing
    }
  });

  test('the WRITE-only and address-only arms record too — the ones no other test covers', () => {
    // The collector has three arms and only the `var`-leaf one is exercised elsewhere. Both of these
    // are load-bearing and silent when broken: the candidate simply loses a declaration it needs and
    // fails to compile. The `assign` arm is the likeliest to be lost in a refactor — it is the one
    // place the collector hand-rolls a name lookup instead of going through the shared expression
    // vocabulary, because an assignment carries its target as a NAME, not an Expr.
    const SEED = { name: 'gSeed', kind: 'data', shape: 'scalar', size: 4, signed: true } as const;
    const write = '\tldr\tr1, .L1\n\tstr\tr0, [r1]\n\tbx\tlr\n.L1:\n\t.word\tgSeed\n';
    for (const c of enumerate('f', write, new Map([[0x02000000, [{ ...SEED }]]]))) {
      expect(c.source).toContain('gSeed = a0;'); // a WRITE is the only mention of the symbol
      expect(c.symbolRefs).toEqual([{ name: 'gSeed', info: SEED }]);
    }
    // `&gThing` as a call argument: the symbol is named by an `addr` leaf and never read
    const THING = { name: 'gThing', kind: 'data', shape: 'struct', size: 4, structName: 'Thing' } as const;
    const addr = '\tpush\t{lr}\n\tldr\tr0, .L1\n\tbl\tUse\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\tgThing\n';
    for (const c of enumerate('f', addr, new Map([[0x02000010, [{ ...THING }]]]))) {
      expect(c.source).toContain('Use(&gThing)');
      expect((c.symbolRefs ?? []).map((r) => r.name)).toEqual(['gThing']);
    }
  });

  test('a value-referenced CODE symbol ((u32)Func) is recorded with kind code', () => {
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x08001001\n'; // odd Thumb pointer
    const cands = enumerate('f', body, new Map([[0x08001000, [{ name: 'DoThing', kind: 'code' }]]]));
    const named = cands.filter((c) => !hasVariation(c.variations, 'raw-globals'));
    expect(named.length).toBeGreaterThan(0);
    for (const c of named) {
      expect(c.source).toContain('(u32)DoThing');
      expect(c.symbolRefs).toEqual([{ name: 'DoThing', info: { name: 'DoThing', kind: 'code' } }]);
    }
  });
});

describe('call targets are NEVER recorded', () => {
  test('a plain call to a mapped code symbol records nothing', () => {
    const body =
      '\tpush\t{lr}\n\tbl\tDoThing\n\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x03001234\n';
    const map: SymbolMap = new Map([
      [0x03001234, [{ ...COUNTER }]],
      [0x08001000, [{ name: 'DoThing', kind: 'code' }]],
    ]);
    for (const c of enumerate('f', body, map)) {
      const names = (c.symbolRefs ?? []).map((r) => r.name);
      expect(names).not.toContain('DoThing'); // called ⇒ excluded
      if (!hasVariation(c.variations, 'raw-globals')) {
        expect(names).toContain('gCounter'); // the data ref still records
      }
    }
  });

  test('called AND value-referenced ⇒ still excluded (the both-contexts poison)', () => {
    // DoThing is called, and its address is also the return value — the value use alone would
    // record it, but the call excludes it entirely: `void DoThing(void);` + `DoThing(...)`
    // with args is a hard gcc-2.9 error, while the undeclared call implicit-declares.
    const body = '\tpush\t{lr}\n\tbl\tDoThing\n\tldr\tr0, .L1\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x08001001\n';
    const cands = enumerate('f', body, new Map([[0x08001000, [{ name: 'DoThing', kind: 'code' }]]]));
    const named = cands.filter((c) => c.source.includes('(u32)DoThing'));
    expect(named.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect((c.symbolRefs ?? []).map((r) => r.name)).not.toContain('DoThing');
    }
  });

  test('…except one a static initializer ALSO names: recorded as the implicit declaration', () => {
    // agbcc's own listing of `static void (*const tbl[2])(void) = { h1, h2 }; h2(); tbl[i]();`.
    // The static's `(u32)&h2` precedes the call `h2(a0)` in the emitted C, so the implicit
    // declaration the call makes comes too late for the initializer ("`h2' undeclared …
    // initializer element is not constant"). The ref is kept and marked, and the block prints C's
    // implicit declaration itself, ahead of the static — `int h2();`, which binds the call the same.
    const asm =
      '\t.section .rodata\n\t.align\t2, 0\n\t.type\t tbl.3,object\n\t.size\t tbl.3,8\ntbl.3:\n' +
      '\t.word\th1\n\t.word\th2\n.text\n\t.align\t2, 0\n\t.globl\tp1b\n\t.thumb_func\np1b:\n' +
      '\tpush\t{r4, lr}\n\tadd\tr4, r0, #0\n\tbl\th2\n\tldr\tr0, .L3\n\tlsl\tr4, r4, #0x2\n' +
      '\tadd\tr4, r4, r0\n\tldr\tr0, [r4]\n\tbl\t_call_via_r0\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n' +
      '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\ttbl.3\n';
    const cands = enumerateCandidates('p1b', asm, ARMV4T_AGBCC, {});
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.source).toContain('(u32)&h2');
      const refs = new Map((c.symbolRefs ?? []).map((r) => [r.name, r]));
      expect(refs.get('h2')?.implicitCall).toBe(true); // called, unprototyped, named by the static
      expect(refs.get('h1')).not.toHaveProperty('implicitCall'); // never called
      expect(renderDeclarations(c.symbolRefs ?? [])).toMatch(/^int h2\(\);$/m);
    }
  });

  test("the function's OWN name is never recorded (definition IS the declaration)", () => {
    // f loads its own address (a self-registering callback): declaring `void f(void);` above
    // the candidate's own `s32 f(...)` definition would be a conflicting-types hard error.
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x08001001\n';
    const cands = enumerate('f', body, new Map([[0x08001000, [{ name: 'f', kind: 'code' }]]]));
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect((c.symbolRefs ?? []).map((r) => r.name)).not.toContain('f');
    }
  });
});

describe('inertness', () => {
  test('no map ⇒ no symbolRefs field on any candidate', () => {
    for (const c of enumerate('f', LOADH)) {
      expect(c.symbolRefs).toBeUndefined();
    }
  });
});
