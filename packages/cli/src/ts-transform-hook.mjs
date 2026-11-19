// Imported after tsx (`loadedCodeArgv`), so its load hook runs ahead of tsx's: it compiles an ES
// module `.ts` file itself, with tsx's own esbuild options save `keepNames`, and hands every other
// load to tsx. tsx sets `keepNames` unconditionally, which wraps each named function a module
// creates in a `__name(fn, "fn")` call that redefines its `name` — a property call per closure,
// paid wherever a function binds a named arrow per call. Nothing is minified or renamed, so a name
// is the one the source spells either way, and the bundled CLI (`scripts/build.mjs`) is already
// built without it. On `kleod:PauseMenuScreenHandler:agbcc` the shim was about a quarter of the
// fan's enumeration. JavaScript, because it loads beside tsx.
//
// A file it compiles is recorded as `loaded-code-hook.mjs` records one, from the bytes read here,
// so a candidate store keys the same text. It leaves to tsx a file outside an ES module package
// and one whose compiled code calls `import(` (tsx's dynamic-import interop), and it leaves tsx
// every file when the tsconfig tsx loaded sets an option esbuild reads (`ts-transform.mjs`).
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { recordLoaded } from './loaded-code-hook.mjs';
import { compileForHook, tsconfigStandDown, tsxTsconfigPath } from './ts-transform.mjs';

const TS_FILE = /\.m?ts$/;
const ESM_FORMATS = new Set([undefined, 'module', 'module-typescript']);

if (tsconfigStandDown(tsxTsconfigPath()) === undefined) {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !ESM_FORMATS.has(context.format)) {
        return nextLoad(url, context);
      }
      const path = fileURLToPath(url);
      if (!TS_FILE.test(path) || path.endsWith('.d.ts') || path.includes('/node_modules/')) {
        return nextLoad(url, context);
      }
      const bytes = readFileSync(path);
      const code = compileForHook(bytes.toString('utf8'), path);
      if (code === undefined) {
        return nextLoad(url, context);
      }
      recordLoaded(url, bytes);
      return { format: 'module', source: code, shortCircuit: true };
    },
  });
}
