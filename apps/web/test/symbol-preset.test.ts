// Pins the symbol-map preset end to end with the EXACT asm + map the Playground ships: with the
// map all four spellings appear (named scalar, struct dot-field, bare array element, Thumb code
// pointer); without it the same asm decompiles to raw literals (the inertness contract the
// pane's degrade path relies on).
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

test('with the map: all four spellings, pinned', () => {
  const parsed = parseSymbolsJson(preset.symbols!);
  if (!parsed || !('map' in parsed)) {
    throw new Error('the preset map must parse');
  }
  const src = decompile('UpdateTimer', preset.asm, ARMV4T_AGBCC, { symbols: parsed.map }).source;
  expect(src).toBe(
    's32 UpdateTimer(s32 a0) {\n' +
      '    gState.timer = gBlendModeTable[a0] + (gCounter + gState.timer);\n' +
      '    return (u32)DoThing;\n' +
      '}\n',
  );
});

test('without the map: the same asm decompiles to raw literals (inertness)', () => {
  const src = decompile('UpdateTimer', preset.asm, ARMV4T_AGBCC, {}).source;
  expect(src).not.toContain('gCounter');
  expect(src).not.toContain('gState');
  expect(src).toContain('50336308'); // 0x03001234 as a raw literal
});
