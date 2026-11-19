// A load hook, imported after tsx so it runs first, that hands each `.ts` file outside
// node_modules to tsx and writes one JSON line to `$CAPTURE_OUT`: what tsx emitted beside what
// `ts-transform-hook.mjs` would emit with tsx's `keepNames` put back. It loads an empty module in
// its place, so no file it captures runs. It reads the hook's options from `ts-transform.mjs`,
// not the hook, which would register itself and sit between this hook and tsx.
import { transformSync } from 'esbuild';
import { appendFileSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { compileForHook, transformOptions } from '../../../src/ts-transform.mjs';

const code = (s) => {
  const text = Buffer.from(s).toString('utf8');
  const i = text.indexOf('//# sourceMappingURL=');
  return (i < 0 ? text : text.slice(0, i)).trimEnd();
};

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || url.includes('/node_modules/') || !/\.m?ts$/.test(url)) {
      return nextLoad(url, context);
    }
    const path = fileURLToPath(url);
    const source = readFileSync(path, 'utf8');
    const tsx = nextLoad(url, context);
    const hooked = compileForHook(source, path) !== undefined;
    const kept = code(transformSync(source, { ...transformOptions(path), keepNames: true }).code);
    const line = { path, format: context.format, hooked, same: code(tsx.source) === kept };
    appendFileSync(process.env.CAPTURE_OUT, `${JSON.stringify(line)}\n`);
    return { format: 'module', source: 'export {};', shortCircuit: true };
  },
});
