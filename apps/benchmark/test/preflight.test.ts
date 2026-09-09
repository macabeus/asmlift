// The START-time half of the provenance story. `provenance.test.ts` pins the mid-run sample and the
// merge refusal; this pins what is refused before the run spends anything, and — the part that
// actually matters — what is NOT refused, because a preflight that stops the `--only` dev loop
// would be traded away within a round.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { cppRefusal, dirtyTreeRefusal, preflightRefusals, probeCpp, runIsWholeTier } from '../src/run/preflight';

/** A `cpp` stub with the given body, executable, on disk. */
function stubCpp(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'asmlift-cppstub-')), 'cpp');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('which runs are checked at all', () => {
  test('an unfiltered run of either tier is — it rewrites the tier file whole', () => {
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'] })).toBe(true);
    expect(runIsWholeTier({ tiers: ['real'] })).toBe(true);
    expect(runIsWholeTier({ tiers: ['synthetic'] })).toBe(true);
  });

  test('the scoped dev loop is NOT — a dirty tree is the point of it', () => {
    expect(runIsWholeTier({ tiers: ['real'], only: 'sub_802DFC8' })).toBe(false);
    expect(runIsWholeTier({ tiers: ['synthetic'], toolchain: 'agbcc' })).toBe(false);
    expect(runIsWholeTier({ tiers: ['real'], project: 'kleod' })).toBe(false);
  });

  test('a filter that selects in only ONE of two tiers still leaves the other whole', () => {
    // `--toolchain` filters synthetic alone, so `--tier both --toolchain agbcc` rewrites real.json
    // in full — the same file merge publishes.
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'], toolchain: 'agbcc' })).toBe(true);
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'], project: 'kleod' })).toBe(true);
    // `--only` reads both tiers, so it scopes the whole run.
    expect(runIsWholeTier({ tiers: ['synthetic', 'real'], only: 'dmaback' })).toBe(false);
  });

  test('a shard CHILD is exempt — its parent already answered, once', () => {
    expect(runIsWholeTier({ tiers: ['real'], shard: '3/8' })).toBe(false);
  });
});

describe('the dirty-tree refusal', () => {
  test('names every offending path, so nobody re-runs git status to guess', () => {
    const msg = dirtyTreeRefusal(['?? .envrc.probe', 'M packages/core/src/rank.ts']);
    expect(msg).toContain('.envrc.probe');
    expect(msg).toContain('packages/core/src/rank.ts');
    expect(msg).toContain('2 paths');
  });

  test('points at the ONE sanctioned name for a local env file', () => {
    // Without a sanctioned name the refusal is just an obstacle, and the round routes around it.
    expect(dirtyTreeRefusal(['?? envrc.sh'])).toContain('.envrc.local');
  });

  test('caps the list, so the three actionable sentences stay on screen after a format sweep', () => {
    const msg = dirtyTreeRefusal(Array.from({ length: 57 }, (_, i) => ` M packages/core/src/f${i}.ts`));
    expect(msg).toContain('57 paths');
    expect(msg).toContain(' M packages/core/src/f19.ts');
    expect(msg).not.toContain(' M packages/core/src/f20.ts');
    expect(msg).toContain('…and 37 more');
  });

  test('a clean tree refuses nothing', () => {
    expect(dirtyTreeRefusal([])).toBeUndefined();
  });
});

describe('the cpp probe refusal', () => {
  test('a cpp that ignores -o is refused, with what it did', () => {
    const msg = cppRefusal({ ok: false, how: 'exit 1: cc: error: no input files' });
    expect(msg).toContain('no input files');
    expect(msg).toContain('ASMLIFT_CPP');
  });

  test('a working cpp refuses nothing', () => {
    expect(cppRefusal({ ok: true, how: 'ok' })).toBeUndefined();
  });
});

// The two functions the acceptance criterion is actually about — the probe that decides, and the
// composition that spawns git — were the two with no test. Neither is pure, so both are given the
// thing they read (a `cpp` path, a repo root) rather than mocked.
describe('the cpp probe itself', () => {
  test('the incident is caught: a cpp that writes to stdout, ignores -o and exits 1', () => {
    // Apple's /usr/bin/cpp answering as clang, reproduced. Measured against the real binary:
    // "cc: error: no input files", exit 1, no output file.
    const probe = probeCpp(stubCpp('echo "int probe;"; echo "cc: error: no input files" >&2; exit 1'));
    expect(probe.ok).toBe(false);
    expect(probe.how).toContain('no input files');
  });

  test('a cpp that exits 0 and STILL writes no -o file is caught', () => {
    // The nastier half of the same shape: exit 0 would sail past a status-only check and the
    // compile rung would then read a file that is not there.
    expect(probeCpp(stubCpp('exit 0')).ok).toBe(false);
  });

  test('a cpp that honours -o passes', () => {
    expect(
      probeCpp(stubCpp('while [ $# -gt 1 ]; do [ "$1" = "-o" ] && { echo x > "$2"; exit 0; }; shift; done; exit 1')).ok,
    ).toBe(true);
  });

  test('a cpp that is not there is a failure, not a throw', () => {
    const probe = probeCpp(join(tmpdir(), 'asmlift-no-such-cpp'));
    expect(probe.ok).toBe(false);
    expect(probe.how).toContain('cannot be run');
  });
});

describe('the whole preflight, against a real throwaway checkout', () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-preflight-repo-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    return dir;
  };

  test('an untracked file in a clean-but-for-it checkout refuses the whole-tier run, by name', () => {
    const dir = repo();
    writeFileSync(join(dir, '.envrc.probe'), 'export FOO=1\n');
    const { refusals } = preflightRefusals({ tiers: ['real'] }, { repoRoot: dir });
    const dirty = refusals.find((r) => r.includes("working tree's code differs"));
    expect(dirty).toBeDefined();
    expect(dirty).toContain('.envrc.probe');
  });

  test('the same tree does NOT refuse the scoped dev loop', () => {
    const dir = repo();
    writeFileSync(join(dir, '.envrc.probe'), 'export FOO=1\n');
    expect(preflightRefusals({ tiers: ['real'], only: 'dmaback' }, { repoRoot: dir })).toEqual({
      refusals: [],
      warnings: [],
    });
  });

  test('an empty checkout refuses nothing on the git axis', () => {
    expect(
      preflightRefusals({ tiers: ['real'] }, { repoRoot: repo() }).refusals.some((r) =>
        r.includes('differs from HEAD'),
      ),
    ).toBe(false);
  });
});

// The probe's claim to BE the failure holds only while its argv is the compile rung's argv. That is
// now one exported constant instead of four copies, and this is the guard against someone
// re-inlining the flags in one of the three rungs — the same shape `fidelity-provenance.test.ts`
// uses to hold `check-artifact-provenance.sh` and `MEASURED_PATHS` in step.
describe('the cpp argv is not four copies', () => {
  test('every candidate-compile rung preprocesses through the constant the probe uses', () => {
    for (const mod of ['ido', 'kmc', 'gcc272']) {
      const src = readFileSync(join(import.meta.dirname, '..', 'src', 'compile', `${mod}.ts`), 'utf8');
      expect(src, `${mod}.ts must import the shared flags`).toContain('CPP_PREPROCESS_FLAGS');
      expect(src, `${mod}.ts re-inlines the probe's flags`).not.toContain("'-P', '-nostdinc'");
    }
  });
});

// The branch that decides whether a broken `cpp` is fatal. Both sides are pinned because the
// no-toolchain side is unreachable on a machine that HAS the MIPS toolchains — which is every
// machine that runs the full bench, and therefore not the machine this regresses on.
describe('a broken cpp is fatal only when something here would have used it', () => {
  const broken = () => ({ ok: false, how: 'exit 1: cc: error: no input files' });
  const clean = mkdtempSync(join(tmpdir(), 'asmlift-preflight-clean-'));
  execFileSync('git', ['-C', clean, 'init', '-q']);

  test('with a MIPS toolchain installed it REFUSES', () => {
    const r = preflightRefusals(
      { tiers: ['real'] },
      { repoRoot: clean, probe: broken, cppUsingToolchains: () => ['ido7.1'] },
    );
    expect(r.refusals.some((m) => m.includes('does not preprocess'))).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('with none installed it WARNS and lets the run go — the rows would SKIP', () => {
    const r = preflightRefusals({ tiers: ['real'] }, { repoRoot: clean, probe: broken, cppUsingToolchains: () => [] });
    expect(r.refusals).toEqual([]);
    expect(r.warnings.join('\n')).toContain('WARNING');
  });
});
