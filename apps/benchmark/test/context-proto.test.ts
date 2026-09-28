// A real row's prototype table (src/cases/context-proto.ts): the vendored context's declarations
// under the manifest's own entries, without the row's own declaration, narrowed to what the
// assembly names before it is published.
import { validatePrototypes } from '@asmlift/core/proto';
import { prototypesFromContext } from '@asmlift/core/proto-context';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { referencedPrototypes, rowPrototypes } from '../src/cases/context-proto';

const CTX = 'typedef signed long s32; s32 callee(s32 a); s32 other(s32 a, s32 b); void self(s32 x);';

describe('a real row prototype table', () => {
  test('context declarations under the manifest, which wins per symbol, and never the row itself', () => {
    const p = rowPrototypes({ other: { params: 3 } }, CTX, 'c', 'self', undefined);
    expect(p).toEqual({ callee: { returns: 's32', params: ['s32'] }, other: { params: 3 } });
  });

  test('a name the symbol map signs keeps the map signature: the context entry is withdrawn', () => {
    const map = new Map([
      [0x100, [{ name: 'callee', kind: 'code' as const, signature: { params: [], returns: null } }]],
    ]);
    expect(rowPrototypes(undefined, CTX, 'c', 'self', map as never)).toEqual({
      other: { returns: 's32', params: ['s32', 's32'] },
    });
  });

  test('an empty context leaves the manifest table as it is', () => {
    expect(rowPrototypes(undefined, '', 'c', 'self', undefined)).toBeUndefined();
    expect(rowPrototypes({ self: { returnsVoid: true } }, '', 'c', 'self', undefined)).toEqual({
      self: { returnsVoid: true },
    });
  });

  test('publishes only the entries the assembly names, plus the row own', () => {
    const p = rowPrototypes({ self: { returnsVoid: true } }, CTX, 'c', 'self', undefined);
    const asm = 'self:\n  mflr r0\n  bl callee\n  blr\n';
    expect(referencedPrototypes(p, asm, 'self')).toEqual({
      self: { returnsVoid: true },
      callee: { returns: 's32', params: ['s32'] },
    });
    expect(referencedPrototypes(undefined, asm, 'self')).toBeUndefined();
  });
});

describe('every vendored context', () => {
  test('parses to a table the CLI --proto accepts', () => {
    const root = join(import.meta.dirname, '..', 'dataset', 'real', 'tu');
    let contexts = 0;
    for (const project of readdirSync(root)) {
      for (const f of readdirSync(join(root, project)).filter((x) => x.startsWith('ctx-'))) {
        const text = gunzipSync(readFileSync(join(root, project, f))).toString('utf8');
        for (const language of ['c', 'c++'] as const) {
          expect(validatePrototypes(prototypesFromContext(text, language)), `${project}/${f} (${language})`).toEqual(
            [],
          );
        }
        contexts++;
      }
    }
    expect(contexts).toBeGreaterThan(100);
  }, 120_000);
});
