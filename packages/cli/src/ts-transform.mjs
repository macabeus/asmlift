// What `ts-transform-hook.mjs` compiles with, and when it leaves a file to tsx, kept apart from the
// hook so a test can read it without registering the hook. JavaScript, because it loads beside tsx.
import { transformSync } from 'esbuild';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** tsx's options for an ES module (`tsx/dist`: `Re` with `format: 'esm'`), save `keepNames`. */
export const transformOptions = (path) => ({
  target: `node${process.versions.node}`,
  loader: 'ts',
  format: 'esm',
  sourcefile: path,
  sourcemap: 'inline',
  sourcesContent: false,
  minifyWhitespace: true,
  keepNames: false,
});

/** The tsconfig tsx loads once for the process: `TSX_TSCONFIG_PATH`, else the nearest
 *  `tsconfig.json` from the working directory up (get-tsconfig's `getTsconfig()`). */
export function tsxTsconfigPath(env = process.env, cwd = process.cwd()) {
  if (env.TSX_TSCONFIG_PATH) {
    return resolve(cwd, env.TSX_TSCONFIG_PATH);
  }
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const p = join(d, 'tsconfig.json');
    if (existsSync(p) && statSync(p).isFile()) {
      return p;
    }
    if (dirname(d) === d) {
      return undefined;
    }
  }
}

/** JSON with the comments and trailing commas a tsconfig may hold. Throws on anything else. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) {
        throw new SyntaxError('unterminated comment');
      }
      i = end + 1;
      out += ' ';
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// tsconfig `compilerOptions` esbuild's transform reads. `strict`/`alwaysStrict` only add "use strict"
// to a non-ES-module output, `baseUrl`/`paths` only steer bundling, and `target` only sets
// `useDefineForClassFields`, whose default from an ES2022-or-later target is the one the node target
// above gives. Any other option here would change what tsx (which hands esbuild the tsconfig) emits.
const INERT = new Set(['strict', 'alwaysStrict', 'baseUrl', 'paths']);
const ESBUILD_READS = new Set([
  ...INERT,
  'target',
  'useDefineForClassFields',
  'experimentalDecorators',
  'emitDecoratorMetadata',
  'importsNotUsedAsValues',
  'preserveValueImports',
  'verbatimModuleSyntax',
  'jsx',
  'jsxFactory',
  'jsxFragmentFactory',
  'jsxImportSource',
]);
const CLASS_FIELDS_TARGET = /^es(next|20(2[2-9]|[3-9]\d))$/i;

/** Why the hook must leave every file to tsx under the tsconfig at `path`, or undefined when it
 *  may compile them: the tsconfig sets an option esbuild reads that the hook would not apply (tsx
 *  hands esbuild the parsed tsconfig), or the hook cannot tell (`extends`, unreadable). */
export function tsconfigStandDown(path) {
  if (path === undefined) {
    return undefined;
  }
  let config;
  try {
    config = parseJsonc(readFileSync(path, 'utf8'));
  } catch (e) {
    return `${path} does not parse (${e.message})`;
  }
  if (config === null || typeof config !== 'object') {
    return `${path} is not an object`;
  }
  if ('extends' in config) {
    return `${path} extends another tsconfig`;
  }
  const options = config.compilerOptions ?? {};
  for (const key of Object.keys(options)) {
    if (!ESBUILD_READS.has(key) || INERT.has(key)) {
      continue;
    }
    if (key === 'target' && CLASS_FIELDS_TARGET.test(String(options[key]))) {
      continue;
    }
    return `${path} sets compilerOptions.${key}, which esbuild reads`;
  }
  return undefined;
}

/** The code the hook loads for the ES module `.ts` source at `path`, or undefined to leave it to
 *  tsx: one whose compiled code calls `import(` gets tsx's dynamic-import interop, which tsx
 *  decides on its own compiled (whitespace-minified) code, as here. */
export function compileForHook(source, path) {
  const code = transformSync(source, transformOptions(path)).code;
  return code.includes('import(') ? undefined : code;
}
