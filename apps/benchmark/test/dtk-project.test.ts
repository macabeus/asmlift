// Building a dtk project from the harness (cases/dtk-project.ts): the version gate, the disc-hash
// gate, the supervised ninja (timeout, stall detector, resume) and the objdiff.json target objects.
// The supervised runs drive shell scripts standing in for ninja, so every failure mode wine
// produces on this machine — a launch failure, a frozen compile, a build that never ends — is
// reproduced here without wine.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import {
  configuredVersions,
  discInputs,
  dtkTargetObjects,
  requireDisc,
  requireVersion,
  runNinja,
} from '../src/cases/dtk-project';

const scratch = mkdtempSync(join(tmpdir(), 'dtk-project-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let made = 0;
const dir = (): string => {
  const path = join(scratch, `p${made++}`);
  mkdirSync(path, { recursive: true });
  return path;
};

const write = (root: string, rel: string, text: string): string => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};

// Pikmin's own shape: the comment on a version can itself hold a quoted string — the disc path
// that version was dumped from
const configurePy = (index: number, versions: readonly string[]): string =>
  [
    `DEFAULT_VERSION = ${index}`,
    'VERSIONS = [',
    ...versions.map((v) => `    "${v}",  # USA Rev 0 "zz_PikminDemo-1210.tgc"`),
    ']',
    '',
  ].join('\n');

describe('the version a checkout builds', () => {
  test('is configure.py’s DEFAULT_VERSION entry of VERSIONS', () => {
    const root = dir();
    write(root, 'configure.py', configurePy(1, ['GPIE01_00', 'GPIE01_01']));
    expect(configuredVersions(root)).toEqual({ versions: ['GPIE01_00', 'GPIE01_01'], fallback: 'GPIE01_01' });
    expect(() => requireVersion(root, 'GPIE01_01')).not.toThrow();
  });

  test('is refused when it is not the version the rows are keyed to', () => {
    const root = dir();
    write(root, 'configure.py', configurePy(0, ['GPIE01_00', 'GPIE01_01']));
    expect(() => requireVersion(root, 'GPIE01_01')).toThrow(/builds GPIE01_00 by default, not GPIE01_01/);
  });

  test('is refused when the index names no version', () => {
    const root = dir();
    write(root, 'configure.py', configurePy(7, ['GPIE01_00']));
    expect(() => requireVersion(root, 'GPIE01_00')).toThrow(/DEFAULT_VERSION 7 names none/);
  });
});

/** A checkout with one DOL and one module in config.yml, and `contents` written under orig/. */
function discProject(contents: Record<string, string>): string {
  const root = dir();
  const hashes: Record<string, string> = {};
  for (const [rel, text] of Object.entries(contents)) {
    write(root, join('orig/GAFE01_00', rel), text);
    hashes[rel] = createHash('sha1').update(text).digest('hex');
  }
  write(
    root,
    'config/GAFE01_00/config.yml',
    [
      'object_base: orig/GAFE01_00',
      'object: sys/main.dol',
      `hash: ${(hashes['sys/main.dol'] ?? 'f'.repeat(40)).toUpperCase()}`,
      'modules:',
      '- object: files/foresta.rel.szs',
      `  hash: ${hashes['files/foresta.rel.szs'] ?? 'e'.repeat(40)}`,
      '',
    ].join('\n'),
  );
  return root;
}

describe('the disc a dtk build cuts its targets from', () => {
  test('is every object config.yml hashes, under its object_base', () => {
    const root = discProject({ 'sys/main.dol': 'dol' });
    const { objectBase, inputs } = discInputs(root, 'GAFE01_00');
    expect(objectBase).toBe('orig/GAFE01_00');
    expect(inputs.map((i) => i.object)).toEqual(['sys/main.dol', 'files/foresta.rel.szs']);
  });

  test('passes when every extracted object matches its hash, whatever the case', () => {
    const root = discProject({ 'sys/main.dol': 'dol', 'files/foresta.rel.szs': 'rel' });
    expect(requireDisc(root, 'GAFE01_00')).toBe(2);
  });

  test('fails loudly on an object that is not the one config.yml names', () => {
    const root = discProject({ 'sys/main.dol': 'dol', 'files/foresta.rel.szs': 'rel' });
    write(root, 'orig/GAFE01_00/sys/main.dol', 'another game');
    expect(() => requireDisc(root, 'GAFE01_00')).toThrow(/sys\/main\.dol is sha1 [0-9a-f]{40}, and config\.yml wants/);
  });

  test('accepts a part-extracted checkout that still has its image', () => {
    const root = discProject({ 'sys/main.dol': 'dol' });
    write(root, 'orig/GAFE01_00/Animal Crossing (USA).rvz', 'x'.repeat(2_000_000));
    expect(requireDisc(root, 'GAFE01_00')).toBe(1);
  });

  test.each(['.gitkeep', '.DS_Store', '._Animal Crossing (USA).rvz', 'README.md'])(
    'does not take a %s for a disc image',
    (stray) => {
      const root = discProject({ 'sys/main.dol': 'dol' });
      write(root, join('orig/GAFE01_00', stray), 'not 470 MB of disc');
      expect(() => requireDisc(root, 'GAFE01_00')).toThrow(/put the GAFE01_00 disc image in/);
    },
  );

  test('refuses a checkout with neither the objects nor an image, naming the directory', () => {
    const root = discProject({ 'sys/main.dol': 'dol' });
    rmSync(join(root, 'orig/GAFE01_00/sys/main.dol'));
    expect(() => requireDisc(root, 'GAFE01_00')).toThrow(/holds 0 of the 2 objects.*put the GAFE01_00 disc image in/s);
  });
});

/** A stand-in for ninja that writes `lines` to stdout and then behaves as `ending` says. Each run
 *  appends to a counter file, so a script can fail once and succeed on the resume. */
function fakeNinja(root: string, script: string): string {
  const path = join(root, 'fake-ninja.sh');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      '[ -n "$FAKE_NINJA_WARMUP" ] && exit 0',
      `n=$(cat "${join(root, 'runs')}" 2>/dev/null || echo 0)`,
      'n=$((n+1))',
      `echo $n > "${join(root, 'runs')}"`,
      script,
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  // The FIRST exec of a freshly written script costs a few hundred milliseconds on macOS before
  // its first byte reaches the log, and the stall windows below are of that order: pay it here,
  // where nothing is being timed, rather than inside a supervised run.
  spawnSync(path, [], { stdio: 'ignore', env: { ...process.env, FAKE_NINJA_WARMUP: '1' } });
  return path;
}

const supervised = { attempts: 3, pollMs: 20, graceMs: 200, timeoutMs: 5_000, stallMs: 5_000 };

describe('ninja under supervision', () => {
  test('passes its output through and returns one attempt when it succeeds', async () => {
    const root = dir();
    const exe = fakeNinja(root, 'echo "[1/1] CHECK build.sha1"\nexit 0');
    const runs = await runNinja({ ...supervised, dir: root, log: join(root, 'log'), exe });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe(0);
  });

  test('resumes a ninja that failed to launch a tool', async () => {
    const root = dir();
    const exe = fakeNinja(root, 'if [ "$n" = 1 ]; then echo "FAILED: [code=1]"; exit 1; fi\necho ok\nexit 0');
    const runs = await runNinja({ ...supervised, dir: root, log: join(root, 'log'), exe });
    expect(runs.map((r) => r.status)).toEqual([1, 0]);
  });

  test('stops an attempt whose log has stopped growing, and resumes it', async () => {
    const root = dir();
    // run 1 prints, then freezes at 0% CPU for longer than the whole test would wait
    const exe = fakeNinja(
      root,
      'echo "[9176/9188] MWCC npc_1_landing1.o"\nif [ "$n" = 1 ]; then exec sleep 30; fi\nexit 0',
    );
    const runs = await runNinja({ ...supervised, stallMs: 1_000, dir: root, log: join(root, 'log'), exe });
    expect(runs).toHaveLength(2);
    expect(runs[0].stopped).toBe('stalled');
    expect(runs[1].status).toBe(0);
  });

  test('does not call a slow but talking ninja stalled', async () => {
    const root = dir();
    // talks for twice the stall window, never pausing for more than a fifth of it
    const exe = fakeNinja(
      root,
      'i=0\nwhile [ $i -lt 10 ]; do i=$((i+1)); echo "[$i/10] MWCC"; sleep 0.2; done\nexit 0',
    );
    const runs = await runNinja({ ...supervised, stallMs: 1_000, dir: root, log: join(root, 'log'), exe });
    expect(runs).toEqual([{ status: 0, signal: null, stopped: undefined, seconds: expect.any(Number) }]);
    expect(runs[0].seconds).toBeGreaterThan(1);
  });

  test('abandons an attempt that outlives the timeout even while it talks', async () => {
    const root = dir();
    const exe = fakeNinja(root, 'while true; do echo "[1/999999] MWCC"; sleep 0.05; done');
    await expect(
      runNinja({ ...supervised, attempts: 2, timeoutMs: 400, stallMs: 5_000, dir: root, log: join(root, 'log'), exe }),
    ).rejects.toThrow(/did not finish in 2 attempts \(timeout .*; timeout .*\)/);
  });

  test('names the log when the attempts run out', async () => {
    const root = dir();
    const log = join(root, 'deep', 'ninja.log');
    const exe = fakeNinja(root, 'echo "FAILED"\nexit 2');
    await expect(runNinja({ ...supervised, attempts: 2, dir: root, log, exe })).rejects.toThrow(log);
  });
});

/** An objdiff.json naming `units`, with an object written for each unit in `built`. */
function objdiffProject(units: readonly string[], built: readonly string[]): string {
  const root = dir();
  write(
    root,
    'objdiff.json',
    JSON.stringify({
      units: units.map((name) => ({ name, target_path: `build/obj/${name}.o`, base_path: `build/src/${name}.o` })),
    }),
  );
  for (const name of built) {
    write(root, `build/obj/${name}.o`, '');
  }
  return root;
}

describe('the target objects of a dtk build', () => {
  test('are objdiff.json’s target_path, keyed by unit name', () => {
    const root = objdiffProject(['main/game/main', 'foresta/m_choice'], ['main/game/main', 'foresta/m_choice']);
    expect([...dtkTargetObjects(root).keys()]).toEqual(['main/game/main', 'foresta/m_choice']);
    expect(dtkTargetObjects(root).get('foresta/m_choice')).toBe(join(root, 'build/obj/foresta/m_choice.o'));
  });

  test('refuse a split that left a unit without its object', () => {
    const root = objdiffProject(['main/game/main', 'foresta/m_choice'], ['main/game/main']);
    expect(() => dtkTargetObjects(root)).toThrow(/1 unit\(s\) have no target object, e\.g\. build\/obj\/foresta/);
  });

  test('are read from the field a real objdiff.json spells them in', () => {
    // the Mario Party 4 fixture carries the objdiff.json its build wrote, and none of its objects
    expect(() => dtkTargetObjects(join(import.meta.dirname, 'fixtures/dtk/marioparty4'))).toThrow(
      'build/GMPE01_00/obj/game/main.o',
    );
  });

  test('refuse a checkout that has not been configured since the split', () => {
    expect(() => dtkTargetObjects(dir())).toThrow(/has no objdiff\.json/);
  });
});
