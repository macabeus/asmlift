// SELF-DECLARING CANDIDATES — the core reference channel (SFn.symbolRefs →
// Candidate.symbolRefs), research/self-declaring-candidates-2026-07-26.md.
//
// Pins the channel's contracts: a map-derived VALUE reference (data global, `(u32)Func`) is
// recorded with its SymbolInfo; a CALL target is NEVER recorded — not even when the same symbol
// is also value-referenced (prototyping a called symbol is C89 poison, verified fact 3 of the
// research doc); the '/raw-globals' lever names nothing so it carries no refs; and INERTNESS —
// no map ⇒ the field is absent everywhere.
import { describe, expect, test } from 'vitest';

import { enumerateCandidates } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const enumerate = (sym: string, body: string, symbols?: SymbolMap) =>
  enumerateCandidates(sym, `${sym}:\n${body}`, ARMV4T_AGBCC, symbols ? { symbols } : {});

// ldr rN, =0x03001234; load a halfword through it — promotes to the mapped name
const LOADH = '\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
const COUNTER = { name: 'gCounter', kind: 'data', shape: 'scalar', size: 2, signed: false } as const;

describe('value references are recorded with their SymbolInfo', () => {
  test('a named data global carries its map facts; /raw-globals carries none', () => {
    const cands = enumerate('f', LOADH, new Map([[0x03001234, [{ ...COUNTER }]]]));
    const named = cands.filter((c) => !c.label.endsWith('/raw-globals'));
    const raw = cands.filter((c) => c.label.endsWith('/raw-globals'));
    expect(named.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    for (const c of named) {
      expect(c.symbolRefs).toEqual([{ name: 'gCounter', info: COUNTER }]);
    }
    for (const c of raw) {
      expect(c.symbolRefs).toBeUndefined(); // names nothing ⇒ declares nothing
    }
  });

  test('a value-referenced CODE symbol ((u32)Func) is recorded with kind code', () => {
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x08001001\n'; // odd Thumb pointer
    const cands = enumerate('f', body, new Map([[0x08001000, [{ name: 'DoThing', kind: 'code' }]]]));
    const named = cands.filter((c) => !c.label.endsWith('/raw-globals'));
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
      if (!c.label.endsWith('/raw-globals')) {
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
