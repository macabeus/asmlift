// Pins the symbol-map preset end to end with the EXACT asm + map the Playground ships. The
// preset's asm is real agbcc output with SYMBOLIC pool words (what a decomp's compiled .s looks
// like), so the names ride the asm; what the map adds is the declaration SHAPES — struct layout
// for the dot-field, elemSize for the array indexing. Without the map the same asm still
// decompiles (the inertness contract the pane's degrade path relies on), just shapeless.
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { expect, test } from 'vitest';

import { EXAMPLES } from '../src/pages/playground/examples';
import { parseSymbolsJson } from '../src/pages/playground/symbols-json';

const preset = EXAMPLES.find((e) => e.label.includes('symbol map'))!;

test('the preset ships a map that the pane parser accepts', () => {
  expect(preset).toBeDefined();
  expect(preset.symbols).toBeDefined();
  const r = parseSymbolsJson(preset.symbols!);
  expect(r && 'map' in r).toBe(true);
});

test('with the map: the shaped spellings, pinned', () => {
  const parsed = parseSymbolsJson(preset.symbols!);
  if (!parsed || !('map' in parsed)) {
    throw new Error('the preset map must parse');
  }
  const src = decompile('UpdateTimer', preset.asm, ARMV4T_AGBCC, { symbols: parsed.map }).source;
  expect(src).toBe(
    's32 UpdateTimer(s32 a0) {\n' +
      '    gState.timer = gCounter + gState.timer + gBlendModeTable[a0];\n' +
      '    return &DoThing;\n' +
      '}\n',
  );
});

test('without the map: the STRUCT layout degrades, the array subscript is DERIVED', () => {
  // The names come from the asm's own pool words. Only the shape a map is the sole source of
  // goes: the struct dot-field degrades to an honest cast spelling, while the array subscript
  // survives because raise/globalshape.ts derives `gBlendModeTable`'s element from the asm's own
  // stride evidence — the pool `ldr` precedes the `lsl #0x1`, which is agbcc's array-subscript
  // order. A struct layout leaves no such evidence, which is why `gState.timer` still needs the
  // map. This test used to expect `((u16 *)&gBlendModeTable)[a0]` here and was the one gate that
  // saw the derivation reach the playground preset — `apps/web/test` is a CI step that
  // `test:offline`, `test:matching` and `apps/benchmark/test` all miss.
  const r = decompile('UpdateTimer', preset.asm, ARMV4T_AGBCC, {});
  expect(r.source).toBe(
    's32 UpdateTimer(s32 a0) {\n' +
      '    ((s32 *)&gState)[1] = gCounter + ((s32 *)&gState)[1] + gBlendModeTable[a0];\n' +
      '    return &DoThing;\n' +
      '}\n',
  );
  // …and the derived shape is not merely PLAUSIBLE, it is the preset map's own entry, field for
  // field. Map-less that declaration is an assumption the run publishes; map-ful it is the
  // caller's and nothing is assumed (the second test above spells the same subscript and reports
  // no assumption). A derivation that disagreed with the map beside it in this same file would
  // be handing the pane's reader a declaration to check against a map that already answered.
  expect(r.assumedSymbols).toEqual([
    { name: 'gBlendModeTable', kind: 'data', shape: 'array', elemSize: 2, elemSigned: false },
  ]);
  const mapped = parseSymbolsJson(preset.symbols!);
  if (!mapped || !('map' in mapped)) {
    throw new Error('the preset map must parse');
  }
  const entry = [...mapped.map.values()].flat().find((i) => i.name === 'gBlendModeTable');
  expect({ elemSize: entry?.elemSize, elemSigned: entry?.elemSigned }).toEqual({ elemSize: 2, elemSigned: false });
  expect(decompile('UpdateTimer', preset.asm, ARMV4T_AGBCC, { symbols: mapped.map }).assumedSymbols).toEqual([]);
});
