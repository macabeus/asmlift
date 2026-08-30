// THE BYTE GATE FOR A SYNTHESIZED DECLARATION — the one claim the self-declaring work makes that
// nothing else compiles.
//
// A declaration asmlift synthesized was read out of the same asm the candidate is then scored
// against (rank.ts `bareGlobalAccessFacts` supplies its width and signedness), so it CANNOT LOSE
// score — only manufacture agreement. Every other check on that path is a text comparison. The
// two suites that do compare object BYTES do not reach it: `self-declared-ab.test.ts` runs on a
// checkout whose asm carries raw addresses (`ldr r0, [pc,#0x020] @ =0x030034A0`), so every name
// there comes from the symbol MAP and its five dogfood functions synthesize nothing; and the
// benchmark's real tier is a headers world by construction (`makeRealCompile` threads only
// `macroDefinesOf`), so a synthesized declaration renders no line it ever compiles.
//
// So: one real ROM function whose asm names its globals TEXTUALLY (the committed corpus `.s`, the
// shape a pasted `.s` has), compiled twice through the pinned agbcc.
//
// BOTH DIRECTIONS, because half of this is only worth running if the other half can fail:
//   A. FAITHFUL — the synthesized block and the project's OWN declarations must produce identical
//      object bytes. This is the claim; if the synthesis ever drifts, the bytes diverge.
//   B. LOAD-BEARING — the fitted WIDTH must be a claim and not decoration: on a function that
//      accesses a bare global at offset 0, the fitted `extern u16` and the unfitted `extern u32`
//      fallback must produce DIFFERENT bytes (`strh` against `str`). Without B, A could pass on a
//      row where no declaration decides anything.
// agbcc-native, no Docker, no checkout.
import { renderDeclarations } from '@asmlift/core/declare';
import type { SymbolRef } from '@asmlift/core/l3/symbol-refs';
import { enumerateCandidates } from '@asmlift/core/rank';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { compileCandAgbcc } from '@asmlift/toolchains';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const corpus = (f: string) => readFileSync(join(import.meta.dirname, '../../../core/test/corpus', f), 'utf8');

/** Object bytes of `decls + source` through the harness's own agbcc candidate compiler (which
 *  prepends the typedef prelude), as hex — so the two worlds differ in nothing but the
 *  declaration block. */
const bytes = (decls: string, source: string): string => readFileSync(compileCandAgbcc(decls + source)).toString('hex');

test('A — the synthesized block compiles to the same bytes as the project’s own declarations', () => {
  // The reported playground row, enumerated the way the playground enumerates it: no symbol map,
  // so all three globals are named out of the literal pool and declared by synthesis.
  const cands = enumerateCandidates('UpdateWorldMapNodeTile', corpus('agbcc-mapless-globals.s'), ARMV4T_AGBCC);
  const refs = cands[0].symbolRefs ?? [];
  expect(refs.map((r) => r.name)).toEqual(['gBgTilemapBufs', 'gUnk_08116748', 'gUnk_08116880']);
  expect(refs.every((r) => r.synthesized)).toBe(true);

  // The same three names as the project's own symbol map declares them — the shapes the
  // benchmark's vendored map for this project carries, which this path never sees.
  const truth: SymbolRef[] = [
    {
      name: 'gBgTilemapBufs',
      info: {
        name: 'gBgTilemapBufs',
        kind: 'data',
        declared: true,
        shape: 'array',
        elemSize: 2,
        elemSigned: false,
        size: 8192,
        dims: [4, 1024],
      },
    },
    {
      name: 'gUnk_08116748',
      info: {
        name: 'gUnk_08116748',
        kind: 'data',
        declared: true,
        const: true,
        shape: 'array',
        elemSize: 1,
        elemSigned: false,
        size: 56,
        dims: [7, 8],
      },
    },
    {
      name: 'gUnk_08116880',
      info: {
        name: 'gUnk_08116880',
        kind: 'data',
        declared: true,
        const: true,
        shape: 'array',
        elemSize: 1,
        elemSigned: false,
        size: 8,
        dims: [8],
      },
    },
  ];
  expect(renderDeclarations(truth)).not.toBe(renderDeclarations(refs)); // the two blocks really differ

  expect(bytes(renderDeclarations(refs), cands[0].source)).toBe(bytes(renderDeclarations(truth), cands[0].source));
});

test('B — and the fitted width is what decides those bytes, not the fallback', () => {
  // A bare halfword read of a global at offset 0: the access fact says `u16`, and the `extern u32`
  // cell declare.ts would render without one is a DIFFERENT load. If these ever agree, A above is
  // comparing two declarations neither of which the compiler consulted.
  const cands = enumerateCandidates('maplesshalf', corpus('agbcc-mapless-half.s'), ARMV4T_AGBCC);
  const refs = cands[0].symbolRefs ?? [];
  expect(renderDeclarations(refs)).toBe('extern u16 gHalfCell;\n');
  expect(bytes('extern u16 gHalfCell;\n', cands[0].source)).not.toBe(bytes('extern u32 gHalfCell;\n', cands[0].source));
});
