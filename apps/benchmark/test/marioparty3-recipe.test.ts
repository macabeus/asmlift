// The marioparty3 recipe's venv step (cases/project-setup.ts) must recover from a HALF-CREATED
// venv: `python3 -m venv venv` without ensurepip exits 1 but leaves venv/bin/python3 behind, and
// a sentinel on the venv's own files would then skip install.sh for good — and from a HALF-RUN
// install.sh, whose first pip line installs splat64 (so venv/bin/splat exists) before its second
// fails. The sentinel is a stamp the recipe writes only after install.sh returned. The tools and
// split steps are pre-satisfied so only the venv step runs, and the two commands it issues are
// stand-ins on PATH that record themselves.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test } from 'vitest';

import { PROJECT_RECIPES } from '../src/cases/project-setup';

const scratch = mkdtempSync(join(tmpdir(), 'mp3-recipe-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

/** A checkout whose tools and split steps are already done, with a venv that only got as far as
 *  the interpreter symlinks (what a failed `python3 -m venv` leaves). */
const halfVenvCheckout = (name: string): string => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'tools', 'gcc_2.7.2', 'mac'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'gcc_2.7.2', 'mac', 'gcc'), '');
  writeFileSync(join(dir, 'marioparty3.ld'), '');
  mkdirSync(join(dir, 'venv', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'venv', 'bin', 'python3'), '');
  return dir;
};

/** `python3` and `bash` stand-ins that log their argv; the `bash install.sh` one also installs
 *  `splat`, the way the real install.sh's first pip line does. */
const fakeTools = (log: string): string => {
  const bin = join(scratch, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ['python3', `echo "python3 $*" >> ${JSON.stringify(log)}\n`],
    ['bash', `echo "bash $*" >> ${JSON.stringify(log)}\nmkdir -p venv/bin && : > venv/bin/splat\n`],
  ]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
};

const STEP = ['python3 -m venv venv', 'bash install.sh'];
const calls = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

describe('the marioparty3 venv step', () => {
  test('a half-created venv is completed and install.sh runs; a stamped venv is left alone', () => {
    const dir = halfVenvCheckout('half-venv');
    const log = join(scratch, 'calls-1.log');
    process.env.PATH = `${fakeTools(log)}:${savedPath ?? ''}`;

    PROJECT_RECIPES.marioparty3.prepare?.(dir);
    expect(calls(log)).toEqual(STEP);
    expect(existsSync(join(dir, 'venv', '.asmlift-installed'))).toBe(true);

    PROJECT_RECIPES.marioparty3.prepare?.(dir); // idempotent once the stamp is there
    expect(calls(log)).toEqual(STEP);
  });

  test('a venv where install.sh died after installing splat runs the step again', () => {
    const dir = halfVenvCheckout('half-install');
    writeFileSync(join(dir, 'venv', 'bin', 'splat'), ''); // the first pip line got through
    const log = join(scratch, 'calls-2.log');
    process.env.PATH = `${fakeTools(log)}:${savedPath ?? ''}`;

    PROJECT_RECIPES.marioparty3.prepare?.(dir);
    expect(calls(log)).toEqual(STEP);
  });
});
