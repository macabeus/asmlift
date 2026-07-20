// @asmlift/core's load-bearing contract: the whole package is browser-pure — no Node/Bun
// APIs, no external or cross-package imports, so `decompile` bundles for the web unchanged.
// The checks resolve import PATHS (a relative `../../cli/...` escape is caught, not just
// bare-specifier reach), cover dynamic import() and globalThis indirection, and scan every
// script extension. The compiler-level twin of this gate is packages/core/tsconfig.json
// (`types: []` — root tsconfig's ambient bun globals do NOT leak into the dedicated check).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { expect, test } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', 'src');

const files: string[] = [];
(function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      walk(join(dir, e.name));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) {
      files.push(join(dir, e.name));
    }
  }
})(SRC);

// `process.\w` / `Bun.\w` (not bare "process."/"Bun.") so prose in comments can end a
// sentence with the word; any API use still matches.
const FORBIDDEN: [RegExp, string][] = [
  [/from\s+["']node:/, 'node: builtin import'],
  [/import\s*\(\s*["']node:/, 'dynamic node: import'],
  [/from\s+["']bun/, 'bun builtin import'],
  [/import\s*\(\s*["']bun/, 'dynamic bun import'],
  [/\bimport\.meta\b/, 'import.meta (breaks bundling + module-load purity)'],
  [/\bprocess\.\w/, 'process.* API'],
  [/\bglobalThis\b/, 'globalThis (indirection over forbidden globals)'],
  [/\bBun\.\w/, 'Bun.* API'],
  [/\brequire\s*(\?\.)?\s*\(/, 'require()'],
];

test('core/src is browser-pure: no Node/Bun APIs anywhere', () => {
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const [re, what] of FORBIDDEN) {
      const m = src.match(re);
      if (m) {
        hits.push(`${f}: ${what} (${JSON.stringify(m[0])})`);
      }
    }
  }
  expect(hits, `Node/Bun usage in @asmlift/core — move it to @asmlift/cli:\n${hits.join('\n')}`).toEqual([]);
});

test('core/src imports stay INSIDE core/src: relative-only, and never escaping the package', () => {
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const specs = [
      ...src.matchAll(/from\s+["']([^"']+)["']/g),
      ...src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (!spec.startsWith('.')) {
        hits.push(`${f}: non-relative import "${spec}"`);
        continue;
      }
      const resolved = resolve(join(f, '..'), spec);
      if (!(resolved + sep).startsWith(SRC + sep) && resolved !== SRC) {
        hits.push(`${f}: import "${spec}" escapes packages/core/src (→ ${resolved})`);
      }
    }
  }
  expect(hits, `boundary-violating import in @asmlift/core:\n${hits.join('\n')}`).toEqual([]);
});

test('the package manifest declares no dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8'));
  expect(pkg.dependencies).toBeUndefined();
  expect(pkg.devDependencies).toBeUndefined();
});
