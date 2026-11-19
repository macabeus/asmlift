// The code a candidate store's namespace hashes, as this process loaded it.
//
// A namespace is stamped at its first compile, long after the code it hashes was loaded, and a
// `git pull` or `pnpm install` may have put other bytes on disk meanwhile. Reading a file when the
// module that names it EVALUATES is no better: an ES module graph is fetched whole before any of it
// runs (186 ms warm, 733 ms on a cold tsx cache), so an edit in that window is recorded while the
// fetched text runs. So the key is the text the module was compiled from: `loaded-code-hook.mjs`,
// imported ahead of tsx's loader (`loadedCodeArgv`), sees the bytes tsx reads for a `.ts` file
// and Node for a `.js` one. A process without it (vitest, whose loader is not Node's) hashes the
// file as it is on disk, and refuses a file changed since the process started.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The node flags that run a TypeScript program with `loaded-code-hook.mjs` beneath tsx's loader:
 *  imported first, it is the loader tsx's own reads go through. */
export const loadedCodeArgv = (): string[] => [
  '--import',
  new URL('./loaded-code-hook.mjs', import.meta.url).href,
  '--import',
  pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
];

/** `execArgv` with `loadedCodeArgv()` in place of any preload of tsx or of the hook it held, which
 *  a child must load in that order. */
export function withLoadedCodeArgv(execArgv: readonly string[]): string[] {
  const preload = (v: string): boolean => v.includes('tsx') || v.endsWith('loaded-code-hook.mjs');
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const a = execArgv[i];
    if (['--import', '--require', '-r'].includes(a) && preload(execArgv[i + 1] ?? '')) {
      i++;
    } else if (!(/^--(?:import|require)=/.test(a) && preload(a))) {
      kept.push(a);
    }
  }
  return [...loadedCodeArgv(), ...kept];
}

const hooked = (): Map<string, string | Error> | undefined =>
  (globalThis as Record<symbol, Map<string, string | Error> | undefined>)[Symbol.for('asmlift.loaded-code')];

/** A change this long before the process started may carry a time from before it: a file system
 *  that keeps whole seconds (HFS+), or two (FAT), rounds a change made after the start down. */
const CHANGE_SLACK_MS = 2000;

/** The sha256 of `path` on disk, where nothing has changed it since this process started — the
 *  bytes it loaded, if it loaded the file. Throws for a file changed (written, replaced, renamed
 *  over) since then, and for one it cannot read. */
function unchangedSinceStart(path: string): string {
  let bytes: Buffer;
  let changed: number;
  try {
    bytes = readFileSync(path);
    const st = statSync(path);
    changed = Math.max(st.ctimeMs, st.mtimeMs);
  } catch (e) {
    throw new Error(`cannot read ${path} (${e instanceof Error ? e.message : String(e)}), so nothing is cached`);
  }
  if (changed >= performance.timeOrigin - CHANGE_SLACK_MS) {
    throw new Error(
      `${path} changed after this process started, so the code it runs may not be the file's, and ` +
        `nothing is cached`,
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}

const realOrResolved = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The digest of the code file `path` as this process loaded it: what the hook hashed, or, in a
 *  process without the hook, its bytes while unchanged since the process started. Throws for a file
 *  the hook did not see loaded, and one it cannot vouch for. */
export function loadedCodeDigest(path: string): string {
  const p = realOrResolved(path);
  const sources = hooked();
  if (sources === undefined) {
    return unchangedSinceStart(p);
  }
  const d = sources.get(p);
  if (d === undefined) {
    throw new Error(
      `${path} is namespace code this process's load hook did not see loaded, so the code that runs is ` +
        `not known, and nothing is cached`,
    );
  }
  if (d instanceof Error) {
    throw d;
  }
  return d;
}

/** The digest of the package in `dir` as this process loaded it: its manifest and every file under
 *  `dir/dist`, by relative path — each module the hook saw loaded as it was loaded, every other file
 *  as it is; in a process without the hook, each while unchanged since the process started. Throws
 *  where there is none to vouch for, and for a package the hook saw nothing of loaded. */
export function loadedPackageDigest(dir: string): string {
  const root = realOrResolved(dir);
  const sources = hooked();
  const files = new Set<string>();
  if (sources !== undefined) {
    for (const p of sources.keys()) {
      if (p.startsWith(root + sep)) {
        files.add(p);
      }
    }
    if (files.size === 0) {
      throw new Error(`no module of ${root} was loaded by this process, so nothing is cached`);
    }
  }
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        walk(join(d, e.name));
      } else {
        files.add(join(d, e.name));
      }
    }
  };
  walk(join(root, 'dist'));
  const digest = (p: string): string => {
    if (sources === undefined) {
      return unchangedSinceStart(p);
    }
    const d = sources.get(p);
    if (d instanceof Error) {
      throw d;
    }
    return d ?? createHash('sha256').update(readFileSync(p)).digest('hex');
  };
  const h = createHash('sha256');
  h.update(`package.json:${digest(join(root, 'package.json'))}`);
  for (const p of [...files].sort()) {
    h.update(`file:${relative(root, p)}:${digest(p)}`);
  }
  return h.digest('hex');
}
