// Pins for the fidelity symbol-map drift check: the comparison is over the DECOMPRESSED JSON
// bytes (gzip envelopes never participate), equal maps pass, and any byte of drift is named.
import { symbolMapFromJson, symbolMapToJson } from '@asmlift/core/symbols';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import type { RealManifest } from '../src/cases/manifests';
import { symbolMapDrift, vendoredMapPaths } from '../src/run/symbol-drift';

// a small fixture map in the exact shape vendor writes (symbolMapToJson output)
const fixture = JSON.stringify({
  '0x03001000': [{ name: 'gPlayer', kind: 'data', declared: true, shape: 'struct', size: 88 }],
  '0x08012345': [{ name: 'UpdatePlayer', kind: 'code' }],
});

describe('symbolMapDrift', () => {
  test('identical decompressed JSON ⇒ no drift, regardless of gzip settings', () => {
    // two DIFFERENT gzip envelopes of the same JSON (level 1 vs 9) must still compare equal
    const a = gunzipSync(gzipSync(Buffer.from(fixture), { level: 1 })).toString('utf8');
    const b = gunzipSync(gzipSync(Buffer.from(fixture), { level: 9 })).toString('utf8');
    expect(symbolMapDrift(a, b)).toBeNull();
  });

  test('a one-symbol difference is drift, named by both hashes', () => {
    const drifted = fixture.replace('UpdatePlayer', 'UpdatePlayer2');
    const reason = symbolMapDrift(fixture, drifted);
    expect(reason).toContain('vendored map sha256');
    expect(reason).toContain('!= re-derived');
  });

  test('the vendor round-trip is byte-stable (fromJson→toJson reproduces the vendored bytes)', () => {
    // the drift check relies on this: re-deriving via symbolMapToJson must reproduce the
    // exact bytes vendor wrote for an unchanged ELF
    const roundTripped = JSON.stringify(symbolMapToJson(symbolMapFromJson(JSON.parse(fixture))));
    expect(symbolMapDrift(fixture, roundTripped)).toBeNull();
  });
});

describe("vendoredMapPaths — every map the project's rows are read with", () => {
  const man = (addrs: string[]): RealManifest =>
    ({ project: 'marioparty4', functions: addrs.map((addr, i) => ({ sym: `fn${i}`, addr })) }) as RealManifest;

  test('a project of linked addresses has one map: its own', () => {
    expect(vendoredMapPaths(man(['0x80003100', '0x80003200'])).map((m) => m.module)).toEqual([undefined]);
  });

  test("a REL module with rows adds one map of its own, once, sorted, beside the project's", () => {
    const maps = vendoredMapPaths(
      man(['0x80003100', 'm427Dll:.text+0x0000c2bc', 'm416Dll:.text+0x00001f20', 'm416Dll:.data+0x00000010']),
    );
    expect(maps.map((m) => m.module)).toEqual([undefined, 'm416Dll', 'm427Dll']);
    expect(maps[1].path.endsWith('/tu/marioparty4/symbols/m416Dll.json.gz')).toBe(true);
    expect(maps[0].path.endsWith('/tu/marioparty4/symbols.json.gz')).toBe(true);
  });
});
