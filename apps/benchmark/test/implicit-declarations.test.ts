// A vendored target TU declares every function it calls (cases/implicit-declarations.ts): checked on
// small sources, and over every committed blob. Needs a host C compiler (gcc or clang), which hosted CI
// runners have, and CodeWarrior's container for a GameCube unit.
import { unitLanguage } from '@asmlift/core/codegen-flags';
import { isMwccToolchainId, ppcDockerAvailable } from '@asmlift/toolchains';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

import { undeclaredCallees } from '../src/cases/implicit-declarations';
import { REAL_DIR, type RealManifest } from '../src/cases/manifests';
import { realCompilerFor } from '../src/compile/real';

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

  // Each unit is asked in its own dialect (compile/types.ts `undeclaredCallees`): the host compiler for
  // the GBA and N64 toolchains, CodeWarrior itself for a GameCube unit — which needs its container, so
  // where there is none those rows are named and left unasked rather than read by a host parser.
  test('no row calls an undeclared function', async () => {
    const found: string[] = [];
    const unasked: string[] = [];
    let checked = 0;
    // A `unit` TU is the project's own unit, implicit declarations and all (cases/vendor.ts).
    for (const man of manifests.filter((m) => m.tu === 'assembled')) {
      const dir = join(REAL_DIR, 'tu', man.project);
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<string, { tu: string }>;
      for (const fn of man.functions) {
        const unit = man.units[fn.unit];
        if (isMwccToolchainId(unit.toolchain) && !ppcDockerAvailable(unit.toolchain)) {
          unasked.push(`${man.project}:${fn.sym}`);
          continue;
        }
        const tu = gunzipSync(readFileSync(join(dir, index[fn.sym].tu))).toString('utf8');
        const undeclared = realCompilerFor(unit.toolchain).undeclaredCallees(
          tu,
          unit.cflags,
          unitLanguage(fn.unit, unit.cflags),
        );
        if (undeclared.length > 0) {
          found.push(`${man.project}:${fn.sym} calls ${undeclared.join(', ')}`);
        }
        checked++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    if (unasked.length > 0) {
      console.warn(`no CodeWarrior container: ${unasked.length} GameCube row(s) not asked (${unasked.join(', ')})`);
    }
    expect(found).toEqual([]);
    expect(checked + unasked.length).toBe(
      manifests.filter((m) => m.tu === 'assembled').reduce((n, m) => n + m.functions.length, 0),
    );
  }, 900_000);
});
