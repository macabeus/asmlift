// The Symbols pane's parse-degrade contract: a well-formed map parses; ANYTHING else returns
// { error } (never a throw) so the Playground shows the error inline and decompiles WITHOUT
// the map — degrade, never block.
import { expect, test } from 'vitest';

import { parseSymbolsJson } from '../src/pages/playground/symbols-json';

test('an empty pane is null — no map, no error', () => {
  expect(parseSymbolsJson('')).toBeNull();
  expect(parseSymbolsJson('   \n')).toBeNull();
});

test('a well-formed vendored map parses to a SymbolMap keyed by the numeric address', () => {
  const r = parseSymbolsJson('{"0x03001234": [{"name": "gCounter", "kind": "data"}]}');
  expect(r && 'map' in r).toBe(true);
  const map = (r as { map: Map<number, { name: string }[]> }).map;
  expect(map.get(0x03001234)?.[0].name).toBe('gCounter');
});

test('broken JSON degrades to an error, never a throw', () => {
  const r = parseSymbolsJson('{"0x03001234": [');
  expect(r && 'error' in r && r.error).toContain('not valid JSON');
});

test('a non-object top level degrades to an error', () => {
  expect(parseSymbolsJson('[1, 2]')).toHaveProperty('error');
  expect(parseSymbolsJson('"hello"')).toHaveProperty('error');
});

test('a non-hex address key degrades to an error naming the key', () => {
  const r = parseSymbolsJson('{"gCounter": [{"name": "gCounter", "kind": "data"}]}');
  expect(r && 'error' in r && r.error).toContain('gCounter');
});

test('a symbol without a name/kind degrades to an error', () => {
  expect(parseSymbolsJson('{"0x03001234": [{"kind": "data"}]}')).toHaveProperty('error');
  expect(parseSymbolsJson('{"0x03001234": [{"name": "g", "kind": "mystery"}]}')).toHaveProperty('error');
  expect(parseSymbolsJson('{"0x03001234": []}')).toHaveProperty('error');
});
