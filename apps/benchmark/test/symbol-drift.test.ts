// Pins for the fidelity symbol-map drift check: the comparison is over the DECOMPRESSED JSON
// bytes (gzip envelopes never participate), equal maps pass, and any byte of drift is named.
import { symbolMapFromJson, symbolMapToJson } from '@asmlift/core/symbols';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { symbolMapDrift } from '../src/run/symbol-drift';

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
