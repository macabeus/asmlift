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

test('without the map: the same asm decompiles shapeless (inertness)', () => {
  // The names come from the asm's own pool words; only the SHAPES vanish — the struct
  // dot-field and the typed array indexing degrade to honest cast spellings.
  const src = decompile('UpdateTimer', preset.asm, ARMV4T_AGBCC, {}).source;
  expect(src).toBe(
    's32 UpdateTimer(s32 a0) {\n' +
      '    ((s32 *)&gState)[1] = gCounter + ((s32 *)&gState)[1] + ((u16 *)&gBlendModeTable)[a0];\n' +
      '    return &DoThing;\n' +
      '}\n',
  );
});
