// A child node process that runs TypeScript, for tests of what a process keys as the code it loaded
// (src/loaded-code.ts). It may PAUSE right after Node fetched one module, before any of it runs
// (fixtures/pause-hook.mjs): the window in which an edit on disk is not the code that runs. The
// parent edits there, then lets it go on, so the timing is not a race.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { loadedCodeArgv } from '../../src/loaded-code';

/** tsx's loader, for a child without the hook. */
export const TSX_ONLY = ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href];

const PAUSE_HOOK = new URL('./fixtures/pause-hook.mjs', import.meta.url).href;

/** Runs `script` (a .ts file) with `args` under `node <flags>`, the hook's (`loadedCodeArgv`) by
 *  default. With `pause`, the child stops once the module at `pause.at` (a URL) is fetched, and
 *  `pause.edit` runs then. Resolves with its stdout; rejects when it exits otherwise than 0. */
export function runChild(
  script: string,
  args: unknown,
  opts: { flags?: readonly string[]; pause?: { at: string; edit: () => void } } = {},
): Promise<string> {
  const flags = [...(opts.flags ?? loadedCodeArgv()), ...(opts.pause ? ['--import', PAUSE_HOOK] : [])];
  const child = spawn(process.execPath, [...flags, script, JSON.stringify(args)], {
    env: { ...process.env, PAUSE_AT: opts.pause?.at ?? '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let paused = false;
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (opts.pause && !paused && out.startsWith('paused\n')) {
        paused = true;
        out = out.slice('paused\n'.length);
        try {
          opts.pause.edit();
        } finally {
          child.stdin.end('\n');
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${err}`));
      } else if (opts.pause && !paused) {
        reject(new Error(`child never fetched ${opts.pause.at}`));
      } else {
        resolve(out.trim());
      }
    });
  });
}
