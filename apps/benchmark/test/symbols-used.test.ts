// symbolsUsed / candidateLabel PROVENANCE CAPTURE (eval/asmlift.ts): a scored row records which
// candidate spelling won the differ and — on map rows — every map symbol the winner's output
// references, shape pre-formatted for the report. The ranking itself is mocked (no compiler in
// this suite); the refs it hands back are REAL — derived by core's enumeration from the exact
// tree each spelling was emitted from, so the call-target exclusion is exercised, not simulated.
import type { CandidateCompiler } from '@asmlift/cli/compile-command';
import { decompileRanked } from '@asmlift/cli/rank';
import type { MatchScore } from '@asmlift/cli/score';
import { decompile } from '@asmlift/core/pipeline';
import { enumerateCandidates } from '@asmlift/core/rank';
import type { SymbolInfo, SymbolMap } from '@asmlift/core/symbols';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { describe, expect, test, vi } from 'vitest';

import { runAsmlift, symbolShape, symbolsUsedFrom } from '../src/eval/asmlift';
import type { Toolchain } from '../src/toolchains';

vi.mock('@asmlift/cli/rank', () => ({ decompileRanked: vi.fn() }));
// Real decompile, but call-countable — pins the backstop's RETIREMENT (exactly ONE phase-1
// decompile per row; the old retry-without-map second call must never come back).
vi.mock('@asmlift/core/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@asmlift/core/pipeline')>();
  return { ...actual, decompile: vi.fn(actual.decompile) };
});

const ranked = vi.mocked(decompileRanked);

const TC = { id: 'agbcc', targetDesc: ARMV4T_AGBCC } as Toolchain;
// the ranking is mocked, so the candidate compiler must never run
const noCompile = (() => {
  throw new Error('candidate compile must not run in this suite');
}) as unknown as CandidateCompiler;

const SCORE: MatchScore = {
  symbol: 'f',
  score: 3,
  match: false,
  rows: 10,
  matching: 7,
  breakdown: { insert: 0, delete: 0, replace: 0, opMismatch: 3, argMismatch: 0 },
};

/** Rank-for-real minus the scorer: enumerate the true candidates, pick by label predicate. */
function rankPicking(pick: (label: string) => boolean): void {
  ranked.mockImplementation((name, asm, target, _obj, opts) => {
    const cands = enumerateCandidates(name, asm, target, opts);
    const cand = cands.find((c) => pick(c.label));
    if (!cand) {
      throw new Error(`no candidate matches the pick among: ${cands.map((c) => c.label).join(', ')}`);
    }
    const scored = { ...cand, score: SCORE };
    return { best: scored, candidates: [scored], dropped: [], withheld: [] };
  });
}

// ldr rN, =0x03001234; load a halfword through it — promotes to the mapped name
const LOADH = 'f:\n\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
const COUNTER: SymbolInfo = { name: 'gCounter', kind: 'data', shape: 'scalar', size: 2, signed: false };
const MAP: SymbolMap = new Map([[0x03001234, [COUNTER]]]);

describe('symbolsUsed / candidateLabel capture (pinned)', () => {
  test('a symbol-fed row records the winning refs with pre-formatted shapes, plus the label', () => {
    rankPicking((l) => !l.includes('/raw-globals'));
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile, MAP);
    expect(r.outcome).toBe('nonmatch');
    expect(r.symbolMap).toBe(true);
    expect(r.symbolsUsed).toEqual([{ name: 'gCounter', shape: 'scalar u16' }]);
    expect(r.candidateLabel).toBeDefined();
    expect(r.candidateLabel).not.toContain('/raw-globals');
  });

  test('a CALL target is never recorded, even alongside a recorded data ref', () => {
    const body =
      'f:\n\tpush\t{lr}\n\tbl\tDoThing\n\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x03001234\n';
    const map: SymbolMap = new Map([
      [0x03001234, [COUNTER]],
      [0x08001000, [{ name: 'DoThing', kind: 'code' }]],
    ]);
    rankPicking((l) => !l.includes('/raw-globals'));
    const r = runAsmlift(TC, 'f', body, '/nonexistent.o', undefined, noCompile, map);
    const names = (r.symbolsUsed ?? []).map((s) => s.name);
    expect(names).toContain('gCounter');
    expect(names).not.toContain('DoThing'); // called ⇒ excluded upstream (C89 prototype poison)
  });

  test('a raw-globals winner on a map row ⇒ symbolMap true, symbolsUsed HONESTLY empty', () => {
    rankPicking((l) => l.includes('/raw-globals'));
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile, MAP);
    expect(r.symbolMap).toBe(true);
    expect(r.symbolsUsed).toEqual([]);
    expect(r.candidateLabel).toContain('/raw-globals'); // the label says which spelling won
  });

  test('no map ⇒ no symbolsUsed field at all; the label still records the winner', () => {
    rankPicking(() => true);
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile);
    expect(r).not.toHaveProperty('symbolMap');
    expect(r).not.toHaveProperty('symbolsUsed');
    expect(r.candidateLabel).toBeDefined();
  });

  test('an unscored row (noncompile) carries neither provenance field', () => {
    ranked.mockImplementation(() => {
      throw new Error('error: boom');
    });
    const r = runAsmlift(TC, 'f', LOADH, '/nonexistent.o', undefined, noCompile, MAP);
    expect(r.outcome).toBe('noncompile');
    expect(r).not.toHaveProperty('symbolsUsed');
    expect(r).not.toHaveProperty('candidateLabel');
  });

  test('BACKSTOP RETIRED: a gapped map row declines WITH the map — one decompile, no retry, no fell-back marker', () => {
    // (schema-historical) is never set.
    const gapped = 'f:\n\tclz\tr0, r0\n\tbx\tlr\n';
    vi.mocked(decompile).mockClear();
    const r = runAsmlift(TC, 'f', gapped, '/nonexistent.o', undefined, noCompile, MAP);
    expect(r.outcome).toBe('declined');
    expect(r.symbolMap).toBe(true);
    expect(decompile).toHaveBeenCalledTimes(1);
  });
});

describe('symbolShape formatting (pinned)', () => {
  const cases: [SymbolInfo, string | undefined][] = [
    [{ name: 'g', kind: 'data', shape: 'struct', structName: 'Unk_03004C20', size: 24 }, 'struct Unk_03004C20 (24 B)'],
    [{ name: 'g', kind: 'data', shape: 'struct', size: 8 }, 'struct ? (8 B)'],
    [{ name: 'g', kind: 'data', shape: 'array', elemSize: 2 }, 'u16[]'],
    [{ name: 'g', kind: 'data', shape: 'array', elemSize: 1, elemSigned: true }, 's8[]'],
    // a struct-element array must not masquerade as a giant int type (kleod gBgInfo is 28 B/elem)
    [{ name: 'g', kind: 'data', shape: 'array', elemSize: 28 }, 'array (28 B/elem)'],
    [{ name: 'g', kind: 'data', shape: 'scalar', size: 1 }, 'scalar u8'],
    [{ name: 'g', kind: 'data', shape: 'scalar', size: 12 }, 'scalar (12 B)'],
    [{ name: 'g', kind: 'data', shape: 'scalar', size: 4, signed: true }, 'scalar s32'],
    [{ name: 'g', kind: 'data', shape: 'pointer' }, 'pointer'],
    [{ name: 'F', kind: 'code' }, 'code'],
    [{ name: 'g', kind: 'data' }, undefined], // name-only symbol: no shape claim
  ];
  test.each(cases)('%o → %s', (info, want) => {
    expect(symbolShape(info)).toBe(want);
  });

  test('a SYNTHESIZED ref is not a symbolsUsed row — the field answers a MAP question', () => {
    // Since the map-less declaration round a candidate's refs are the union of the map's symbols
    // and the names read out of the asm's own pool (core rank.ts); the synthesized ones carry
    // `synthesized: true`. This field is the symbolMap A/B's provenance — "which MAP symbols did
    // the winner use" — so a name the map never knew must not appear under it. Measured: 9 of the
    // 252 real rows name a pool symbol their project's map does not know.
    const used = symbolsUsedFrom([
      { name: 'gAlpha', info: COUNTER },
      { name: 'gPoolOnly', info: { name: 'gPoolOnly', kind: 'data' }, synthesized: true },
    ]);
    expect(used).toEqual([{ name: 'gAlpha', shape: 'scalar u16' }]);
  });

  test('symbolsUsedFrom sorts by name and omits absent shapes', () => {
    const used = symbolsUsedFrom([
      { name: 'gZeta', info: { name: 'gZeta', kind: 'data' } },
      { name: 'gAlpha', info: COUNTER },
    ]);
    expect(used).toEqual([{ name: 'gAlpha', shape: 'scalar u16' }, { name: 'gZeta' }]);
    expect(used[1]).not.toHaveProperty('shape');
  });
});

describe('dropped candidates are recorded, never silently swallowed', () => {
  test('a spelling that failed to build is published with its diagnostic', () => {
    ranked.mockImplementation((name, asm, target, _obj, opts) => {
      const cands = enumerateCandidates(name, asm, target, opts);
      const scored = { ...cands[0], score: SCORE };
      return {
        best: scored,
        candidates: [scored],
        dropped: [{ label: 'unsigned', error: "too many arguments to `thunk_sub_080002A0'" }],
        withheld: [],
      };
    });
    const r = runAsmlift(TC, 'f', LOADH, 'obj', undefined, noCompile, MAP);
    expect(r.outcome).toBe('nonmatch');
    expect(r.droppedCandidates).toEqual([{ label: 'unsigned', error: "too many arguments to `thunk_sub_080002A0'" }]);
  });

  test('every candidate building ⇒ the field is absent, not an empty array', () => {
    rankPicking(() => true);
    expect(runAsmlift(TC, 'f', LOADH, 'obj', undefined, noCompile, MAP)).not.toHaveProperty('droppedCandidates');
  });
});

describe('withheld candidates are recorded too, and are a different fact', () => {
  const WHY = 'this spelling rests on a device-behaviour fact no gate over the C can settle';

  test('a spelling refused PUBLICATION is published with the score it reached', () => {
    ranked.mockImplementation((name, asm, target, _obj, opts) => {
      const cands = enumerateCandidates(name, asm, target, opts);
      const scored = { ...cands[0], score: SCORE };
      return {
        best: scored,
        candidates: [scored],
        dropped: [],
        withheld: [{ label: 'unsigned/unreduce', score: 35, why: WHY }],
      };
    });
    const r = runAsmlift(TC, 'f', LOADH, 'obj', undefined, noCompile, MAP);
    // NOT folded into droppedCandidates: nothing failed to build, and reporting one as the other
    // would make the dropped column name compile errors that never happened.
    expect(r.droppedCandidates).toBeUndefined();
    expect(r.withheldCandidates).toEqual([{ label: 'unsigned/unreduce', score: 35, why: WHY }]);
  });

  test('nothing withheld ⇒ the field is absent, not an empty array', () => {
    rankPicking(() => true);
    expect(runAsmlift(TC, 'f', LOADH, 'obj', undefined, noCompile, MAP)).not.toHaveProperty('withheldCandidates');
  });
});
