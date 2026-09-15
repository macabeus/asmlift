// A vendored target TU declares every function it calls (cases/implicit-declarations.ts): checked on
// small sources, and over every committed blob. Needs a host C compiler (gcc or clang), which hosted CI
// runners have.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { undeclaredCallees } from '../src/cases/implicit-declarations';
import { REAL_DIR, type RealManifest } from '../src/cases/manifests';

describe('undeclaredCallees', () => {
  test('names each function called with no declaration in scope, once, sorted', () => {
    expect(undeclaredCallees('int f(int a) { h(a); return g(a) + h(a); }\n')).toEqual(['g', 'h']);
  });

  test('a prototype or an earlier definition declares a callee', () => {
    expect(
      undeclaredCallees('int g(int);\nstatic int h(int x) { return x; }\nint f(int a) { return g(a) + h(a); }\n'),
    ).toEqual([]);
  });

  test('a declaration after the call does not declare it', () => {
    expect(undeclaredCallees('int f(int a) { return g(a); }\nint g(int);\n')).toEqual(['g']);
  });
});

describe('every committed vendored TU declares every function it calls', () => {
  const manifests = readdirSync(REAL_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(REAL_DIR, f), 'utf8')) as RealManifest);

  test('no row calls an undeclared function', async () => {
    const found: string[] = [];
    let checked = 0;
    for (const man of manifests) {
      const dir = join(REAL_DIR, 'tu', man.project);
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<string, { tu: string }>;
      for (const fn of man.functions) {
        const undeclared = undeclaredCallees(gunzipSync(readFileSync(join(dir, index[fn.sym].tu))).toString('utf8'));
        if (undeclared.length > 0) {
          found.push(`${man.project}:${fn.sym} calls ${undeclared.join(', ')}`);
        }
        checked++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    expect(found).toEqual([]);
    expect(checked).toBe(manifests.reduce((n, m) => n + m.functions.length, 0));
  }, 180_000);
});
