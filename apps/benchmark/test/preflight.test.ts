// The START-time half of the provenance story. `provenance.test.ts` pins the mid-run sample and the
// merge refusal; this pins what is refused before the run spends anything, and — the part that
// actually matters — what is NOT refused, because a preflight that stops the `--only` dev loop
// would be traded away within a round.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  CPP_TOOLCHAINS,
  LOCAL_ENV_FILE,
  LOCAL_SCRATCH_DIR,
  cppRefusal,
  dirtyTreeRefusal,
  preflightRefusals,
  probeCpp,
  runIsWholeTier,
  runUsesHostCpp,
} from '../src/run/preflight';

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
    expect(runIsWholeTier({ tiers: ['real'], shard: '3/8', serial: true })).toBe(false);
  });

  test('`--shard` WITHOUT `--serial` is not a child and is not exempt', () => {
    // That argv fans out across `--jobs` children and never reads the shard, so it rewrites the
    // tier whole while looking like the one shape the exemption is for. `cli.ts` rejects it with
    // exit 2; this is the second lock, in case the argv ever becomes meaningful.
    expect(runIsWholeTier({ tiers: ['synthetic'], shard: '1/1' })).toBe(true);
    expect(runUsesHostCpp({ tiers: ['real'], shard: '1/1' })).toBe(true);
  });
});

// A separate axis from `runIsWholeTier`, which asks only about REWRITING A TIER FILE. Deciding
// the probe by that one silences it in the scoped loop, where TRAP 6 lives, and fires it on a tier
// that never preprocesses.
describe('which runs touch the host cpp at all', () => {
  test('every real-tier run does — scoped or whole, one row or all of them', () => {
    expect(runUsesHostCpp({ tiers: ['real'] })).toBe(true);
    expect(runUsesHostCpp({ tiers: ['real'], only: 'func_800600C0_60CC0' })).toBe(true);
    expect(runUsesHostCpp({ tiers: ['real'], project: 'marioparty3' })).toBe(true);
    // `--toolchain` does not filter the real tier (cases/real.ts takes project/only only), so it
    // cannot narrow this question either — an agbcc-flavoured real run still compiles gcc272 rows.
    expect(runUsesHostCpp({ tiers: ['real'], toolchain: 'agbcc' })).toBe(true);
  });

  test('no synthetic-only run does — no synthetic row preprocesses with the host cpp', () => {
    expect(runUsesHostCpp({ tiers: ['synthetic'] })).toBe(false);
    expect(runUsesHostCpp({ tiers: ['synthetic'], toolchain: 'ido7.1' })).toBe(false);
  });

  test('a shard child still asks neither question', () => {
    expect(runUsesHostCpp({ tiers: ['real'], shard: '3/8', serial: true })).toBe(false);
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
    // Asserted through the export, not another copy of the literal: the constant exists to be the
    // single source of truth, and a test that restates the string leaves it with no consumer.
    expect(dirtyTreeRefusal(['?? envrc.sh'])).toContain(LOCAL_ENV_FILE);
    // ...and the scoped home for everything that is not an env file, so the reader is not sent to
    // the main checkout's `info/exclude`, which no worktree ever cleans up.
    expect(dirtyTreeRefusal(['?? scratch.o'])).toContain(LOCAL_SCRATCH_DIR);
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

// The probe that decides and the composition that spawns git. Neither is pure, so both are given
// the thing they read (a `cpp` path, a repo root) rather than mocked.
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
  // These are about the GIT axis, so the probe is injected healthy: a real-tier run now asks the
  // cpp question too, and none of these assertions is about whichever `cpp` the machine has.
  const ok = () => ({ ok: true, how: 'ok' });
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-preflight-repo-'));
    execFileSync('git', ['-C', dir, 'init', '-q']);
    return dir;
  };

  test('an untracked file in a clean-but-for-it checkout refuses the whole-tier run, by name', () => {
    const dir = repo();
    writeFileSync(join(dir, '.envrc.probe'), 'export FOO=1\n');
    const { refusals } = preflightRefusals({ tiers: ['real'] }, { repoRoot: dir, probe: ok });
    const dirty = refusals.find((r) => r.includes("working tree's code differs"));
    expect(dirty).toBeDefined();
    expect(dirty).toContain('.envrc.probe');
  });

  test('the same tree does NOT refuse the scoped dev loop', () => {
    const dir = repo();
    writeFileSync(join(dir, '.envrc.probe'), 'export FOO=1\n');
    expect(preflightRefusals({ tiers: ['real'], only: 'dmaback' }, { repoRoot: dir, probe: ok })).toEqual({
      refusals: [],
      warnings: [],
    });
  });

  test('an empty checkout refuses nothing on the git axis', () => {
    expect(
      preflightRefusals({ tiers: ['real'] }, { repoRoot: repo(), probe: ok }).refusals.some((r) =>
        r.includes('differs from HEAD'),
      ),
    ).toBe(false);
  });
});

// The probe's claim to BE the failure holds only while its argv is the compile rung's argv, and
// `CPP_TOOLCHAINS`' claim to name the affected rows holds only while it names every rung that
// preprocesses. Both are guarded by a SCAN rather than a list: a guard against copies must not be
// a copy of the list it guards, or a 4th rung dropped into `compile/` passes it. Same technique
// `fidelity-provenance.test.ts` uses on `check-artifact-provenance.sh`: parse the source of truth,
// do not restate it.
const COMPILE_DIR = join(import.meta.dirname, '..', 'src', 'compile');
const compileSrc = (f: string) => readFileSync(join(COMPILE_DIR, f), 'utf8');

/** Every module under `src/compile` that pulls the HOST `cpp` out of config — discovered. */
function hostCppRungs(): string[] {
  return readdirSync(COMPILE_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => /import\s*\{[^}]*\bCPP\b[^}]*\}\s*from\s*'\.\.\/config'/.test(compileSrc(f)));
}

describe('the cpp rungs are discovered, not listed', () => {
  test('every rung that preprocesses does it through the constant the probe uses', () => {
    const rungs = hostCppRungs();
    expect(rungs.length, 'no compile module imports CPP — the scan is broken, not the code').toBeGreaterThan(0);
    for (const f of rungs) {
      expect(compileSrc(f), `${f} must import the shared flags`).toContain('CPP_PREPROCESS_FLAGS');
      expect(compileSrc(f), `${f} re-inlines the probe's flags`).not.toContain("'-P', '-nostdinc'");
    }
  });

  test('CPP_TOOLCHAINS names exactly the toolchain ids those rungs serve', () => {
    // Derived through `REAL_COMPILERS`, the one table that maps a toolchain id to its rung, so a
    // rung added later cannot silently degrade a refusal into a warning by being absent from a
    // hand list. (`CPP_TOOLCHAINS` is load-bearing for the refuse-vs-warn branch.)
    const real = readFileSync(join(COMPILE_DIR, 'real.ts'), 'utf8');
    const table = real.slice(real.indexOf('REAL_COMPILERS'), real.indexOf('export function realCompilerFor'));
    const byExport = new Map<string, string>();
    for (const f of readdirSync(COMPILE_DIR).filter((x) => x.endsWith('.ts'))) {
      for (const m of compileSrc(f).matchAll(/export const (\w+)\s*:\s*RealCompile/g)) {
        byExport.set(m[1], f);
      }
    }
    const rungs = new Set(hostCppRungs());
    const derived = [...table.matchAll(/^\s*'?([\w.\-]+)'?\s*:\s*(\w+)\s*,/gm)]
      .filter(([, , sym]) => rungs.has(byExport.get(sym) ?? ''))
      .map(([, id]) => id);
    expect(derived.length, 'REAL_COMPILERS did not parse — fix this test, not the constant').toBeGreaterThan(0);
    expect([...derived].sort()).toEqual([...CPP_TOOLCHAINS].sort());
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

  test('the SCOPED real run is refused too — that is where the incident actually happens', () => {
    // Measured, same worktree and row, only ASMLIFT_CPP differing: `--tier real --only
    // func_800600C0_60CC0` gave `asmlift=diff:27/32` under the GNU shim and `asmlift=noncompile(1)`
    // under a broken one, exit 0 both times. `attribute-function.md` reads `noncompile` as a
    // signal to act on.
    for (const opts of [
      { tiers: ['real' as const], only: 'func_800600C0_60CC0' },
      { tiers: ['real' as const], project: 'marioparty3' },
    ]) {
      const r = preflightRefusals(opts, { repoRoot: clean, probe: broken, cppUsingToolchains: () => ['ido7.1'] });
      expect(
        r.refusals.some((m) => m.includes('does not preprocess')),
        JSON.stringify(opts),
      ).toBe(true);
    }
  });

  test('a synthetic-only run says NOTHING about cpp, whole tier included', () => {
    // The other direction: synthetic ido rows compile and score fine under a `cpp` this refusal
    // would have stopped the run for.
    for (const opts of [{ tiers: ['synthetic' as const] }, { tiers: ['synthetic' as const], toolchain: 'ido7.1' }]) {
      const r = preflightRefusals(opts, {
        repoRoot: clean,
        probe: broken,
        cppUsingToolchains: () => {
          throw new Error('a synthetic run must not even ask which toolchains are installed');
        },
      });
      expect(
        r.refusals.some((m) => m.includes('does not preprocess')),
        JSON.stringify(opts),
      ).toBe(false);
      expect(r.warnings, JSON.stringify(opts)).toEqual([]);
    }
  });
});
