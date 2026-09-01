// `/no-ptr-elem` WINS — the corpus's negative census, answered by construction.
//
// `structure/structure.ts`'s `ptrMemberElement` spells a whole-element subscript through a
// map-declared pointer MEMBER (`gBgDataPtrs.pBufBg3Tilemap[i + 157]`) where the byte arithmetic
// the asm actually carries would otherwise stand. `/no-ptr-elem` is the arm that turns it off
// (`spellPtrMemberElements`, enumerated at rank.ts's `ptrElemCands`), and the two are the same
// ADDRESS and different OBJECTS — so the differ referees.
//
// No REAL row wins under a label containing `ptr-elem`, and that is a fact about the CORPUS, not
// about the axis: the enumeration gate needs a symbol map declaring a pointer member with a
// pointee width of 1, 2 or 4, and klonoa's map holds exactly ONE such symbol — whose every
// decompiled caller happens to have been written in the element form.
//
// THE SYNTHETIC TIER CAN NOW CARRY A MAP (`SynthSpec.symbols`), and `synthetic:ptrelem:agbcc` is
// the row that pins the WIN: match at 0 under `unsigned/no-ptr-elem`, NONMATCH 6 when the arm is
// ablated. This header shipped in the same change as that row still saying a synthetic case never
// carries `symbols` and that a synthetic row cannot pin this axis — both false as written, and
// false about the very commit they were written in.
//
// SO WHAT IS THIS FILE FOR, given the row exists. Two things the row cannot do. It runs against
// the PROJECT'S OWN map and toolchain rather than an authored map, so it would catch a divergence
// between what an ELF really says and what the dataset hand-writes; and it pins the axis TWO-SIDED
// on four shapes at once — on the byte target the arm is the only match, on the element target the
// default is — where a benchmark row can only ever pin the side it was compiled from.
//
// WHAT THIS PINS, and it is the thing a census cannot see: on the byte-arithmetic target the
// `/no-ptr-elem` candidate is the ONLY match and the default arm does not match, and on the
// element target the two swap. Delete the arm and the first column's matches are gone.
//
// The lifted asm carries the container as the ABSOLUTE pool address a ROM disassembly holds
// (`0x03004790`), which is what the map resolves; the scoring target keeps the relocation the
// project's own build has, exactly as a real row's does.
//
// GATE: needs the bench-owned klonoa checkout for its symbols ELF (`pnpm bench setup --project
// kleod --build`) and the pinned agbcc. Missing pieces skip GREEN, checkout-gate.ts style.
import { renderDeclarations } from '@asmlift/core/declare';
import { enumerateCandidates } from '@asmlift/core/rank';
import type { SymbolMap } from '@asmlift/core/symbols';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';

import { loadSymbolMap } from '../../src/symbols-provider';
import { KLEOD_CHECKOUT as CHECKOUT, kleodCheckoutGate } from './checkout-gate';

const SYMS_ELF = 'klonoa-eod-syms.elf';
const HAVE = kleodCheckoutGate('ptr-elem-axis', [SYMS_ELF], ['arm-none-eabi-as']);

/** The container the map declares — `struct BgDataPtrs` at 0x03004790, whose `pBufBg2Tilemap` is
 *  a `u8 *` and whose `pBufBg3Tilemap` is a `u16 *`. Only the shape matters here; the map is the
 *  authority asmlift reads, this is just what agbcc needs to compile the reference. */
const DECLS = `struct BgDataPtrs {
    void *pBufBg0Tiles; u16 *pBufBg0Tilemap;
    void *pBufBg1Tiles; u16 *pBufBg1Tilemap;
    void *pBufBg2Tiles; u8 *pBufBg2Tilemap;
    void *pBufBg3Tiles; u16 *pBufBg3Tilemap;
};
extern struct BgDataPtrs gBgDataPtrs;
`;

/** byte spelling / element spelling of the same address, per shape. */
const SHAPES = [
  {
    name: 'load u16 at a constant element offset',
    byte: 'u16 f(s32 i) { return *(u16 *)((i << 1) + (u8 *)gBgDataPtrs.pBufBg3Tilemap + 314); }',
    elem: 'u16 f(s32 i) { return gBgDataPtrs.pBufBg3Tilemap[i + 157]; }',
  },
  {
    name: 'load u16 one element in',
    byte: 'u16 f(s32 i) { return *(u16 *)((i << 1) + (u8 *)gBgDataPtrs.pBufBg3Tilemap + 2); }',
    elem: 'u16 f(s32 i) { return gBgDataPtrs.pBufBg3Tilemap[i + 1]; }',
  },
  {
    name: 'load u8 — a pointee width of one, where no scale separates the two',
    byte: 'u8 f(s32 i) { return *((u8 *)gBgDataPtrs.pBufBg2Tilemap + i + 20); }',
    elem: 'u8 f(s32 i) { return gBgDataPtrs.pBufBg2Tilemap[i + 20]; }',
  },
  {
    name: 'STORE through the member',
    byte: 'void f(s32 i, u16 v) { *(u16 *)((i << 1) + (u8 *)gBgDataPtrs.pBufBg3Tilemap + 8) = v; }',
    elem: 'void f(s32 i, u16 v) { gBgDataPtrs.pBufBg3Tilemap[i + 4] = v; }',
  },
] as const;

/** The best-scoring candidate's label and score for one reference source, lifted with the map. */
interface Ranked {
  label: string;
  score: number;
  labels: string[];
}

describe.runIf(HAVE)('`/no-ptr-elem` is the winner wherever the source wrote the bytes (checkout-gated)', () => {
  let symbols: SymbolMap;
  const ranked = new Map<string, Ranked>();

  const rank = (src: string): Ranked => {
    const targetAsm = compileTargetAsm(DECLS + src);
    const obj = assembleTarget(targetAsm);
    // the ROM-disassembly form asmlift's frontend reads: the container is an absolute pool word,
    // which is what makes the symbol map the authority on what it is.
    const liftAsm = targetAsm.replace(/\bgBgDataPtrs\b/g, '0x03004790');
    const cands = enumerateCandidates('f', liftAsm, ARMV4T_AGBCC, {
      symbols,
      prototypes: { f: { returnsVoid: src.startsWith('void ') } },
    });
    let best: Ranked = { label: '', score: Number.POSITIVE_INFINITY, labels: cands.map((c) => c.label) };
    for (const c of cands) {
      // the per-candidate declaration block the CLI's scorer prepends (cli/src/rank.ts
      // `declarationsOf`) — a candidate names the map's symbols and does not declare them itself.
      const decls = c.symbolRefs?.length ? renderDeclarations(c.symbolRefs) : '';
      const s = scoreC(decls + c.source, 'f', obj);
      if (s.score < best.score) {
        best = { label: c.label, score: s.score, labels: best.labels };
      }
    }
    return best;
  };

  beforeAll(async () => {
    symbols = await loadSymbolMap(join(CHECKOUT, SYMS_ELF));
    for (const s of SHAPES) {
      ranked.set(`${s.name}/byte`, rank(s.byte));
      ranked.set(`${s.name}/elem`, rank(s.elem));
    }
  }, 600_000);

  test('the map really declares the sized pointer members this axis needs', () => {
    const info = [...symbols.values()].flat().find((i) => i.name === 'gBgDataPtrs');
    expect(info?.layout?.filter((f) => f.pointer && [1, 2, 4].includes(f.pointeeSize ?? 0))).toHaveLength(4);
  });

  for (const s of SHAPES) {
    describe(s.name, () => {
      test('the axis is enumerated at all — both arms present, so the comparison is real', () => {
        expect(ranked.get(`${s.name}/byte`)?.labels.filter((l) => l.includes('no-ptr-elem')).length).toBeGreaterThan(0);
      });

      test('BYTE target: `/no-ptr-elem` matches and the element default does not', () => {
        const r = ranked.get(`${s.name}/byte`);
        expect(r?.score).toBe(0);
        expect(r?.label).toContain('no-ptr-elem');
      });

      test('ELEMENT target: the default matches — the axis is two-sided, not a better default', () => {
        const r = ranked.get(`${s.name}/elem`);
        expect(r?.score).toBe(0);
        expect(r?.label).not.toContain('no-ptr-elem');
      });
    });
  }
});
