// THE entry point: one argv parser, one subcommand dispatch. Every path the harness offers is a
// subcommand here — there are no other executable scripts.
//
//   pnpm bench run [--jobs N] [--tier synthetic|real|both] [--only s] [--project p]
//                  [--serial] [--shard i/N] [--toolchain id]
//   pnpm bench target <id> --out <dir>   # repro-script pre-step: target object + decomp.yaml
//   pnpm bench fidelity [--jobs N]       # pre-publish gate: re-run BOTH repro scripts, every function
//   pnpm bench merge                     # tiers → results.json, then publish
//   pnpm bench publish                   # re-stage results.json into the web app
//   pnpm bench stale-check               # committed vs fresh results (measurement-level)
//   pnpm bench regression                # committed vs fresh MATCH gate: exit 1 on any lost match
//   pnpm bench smoke                     # one trivial fn through every available toolchain
//   pnpm bench verify <manifest.json>    # compile-check loop for authoring real manifests
//   pnpm bench vendor [--project p]      # freeze the real tier's preprocessed TUs (needs checkouts)
//
// `run` fans shard child processes by default (see run/orchestrate.ts); `--serial` runs
// in-process — the debugging path, and also HOW the shard children themselves run (the parent
// spawns `run --serial --shard i/N`, which writes `<tier>.part<i>.json` for the stitcher).
import { copyFileSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { realCases } from './cases/real';
import { syntheticCases } from './cases/synthetic';
import { RESULTS_DIR } from './config';
import { writeScoreConfig } from './decomp-config';
import { merge } from './report/merge';
import { publish } from './report/publish';
import { type Tier, orchestrate } from './run/orchestrate';
import { parseShard, runCases } from './run/runner';
import { smoke } from './run/smoke';
import { verify } from './run/verify';
import type { ToolchainId } from './toolchains';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    jobs: { type: 'string' },
    tier: { type: 'string', default: 'both' },
    only: { type: 'string' },
    project: { type: 'string' },
    toolchain: { type: 'string' },
    shard: { type: 'string' },
    serial: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const command = positionals[0];
const tiers: Tier[] = opts.tier === 'both' ? ['synthetic', 'real'] : [opts.tier as Tier];
if (opts.tier !== 'both' && opts.tier !== 'synthetic' && opts.tier !== 'real') {
  console.error(`unknown --tier ${opts.tier}`);
  process.exit(2);
}

function casesFor(tier: Tier) {
  return tier === 'synthetic'
    ? syntheticCases({ only: opts.only, toolchain: opts.toolchain as ToolchainId | undefined })
    : realCases({ project: opts.project, only: opts.only });
}

switch (command) {
  case 'run': {
    const { assertM2cPinned } = await import('./eval/m2c');
    assertM2cPinned();
    if (opts.serial) {
      mkdirSync(RESULTS_DIR, { recursive: true });
      const shard = opts.shard ? parseShard(opts.shard) : { idx: 0, n: 1 };
      for (const tier of tiers) {
        // a spawned shard child ALWAYS writes its part file (even 0/1) — the stitcher owns <tier>.json
        const out = join(RESULTS_DIR, opts.shard ? `${tier}.part${shard.idx}.json` : `${tier}.json`);
        const n = runCases(casesFor(tier), out, shard).length;
        console.log(`\nWrote ${n} ${tier} results → ${out}`);
      }
    } else {
      const jobs = Number(opts.jobs ?? Math.min(8, cpus().length));
      if (!Number.isInteger(jobs) || jobs < 1) {
        console.error(`bad --jobs ${opts.jobs}; want a positive integer`);
        process.exit(2);
      }
      await orchestrate({ jobs, tiers, only: opts.only, project: opts.project, toolchain: opts.toolchain });
    }
    break;
  }
  case 'target': {
    // target <rowId> --out <dir> — the repro scripts' pre-step: build this function's target
    // object (content-cached) and write a decomp.yaml whose compile command is the benchmark's
    // own toolchain invocation, so `asmlift --config decomp.yaml --score-against target.o`
    // scores exactly what the benchmark scored.
    const rowId = positionals[1];
    const out = opts.out;
    if (!rowId || !out) {
      console.error('usage: pnpm bench target <project:sym:toolchain> --out <dir>');
      process.exit(2);
    }
    const c = [...syntheticCases(), ...realCases()].find((x) => x.id === rowId);
    if (!c) {
      console.error(`no such function: ${rowId}`);
      process.exit(2);
    }
    mkdirSync(out, { recursive: true });
    const { obj } = c.build();
    copyFileSync(obj, join(out, 'target.o'));
    writeScoreConfig(c.toolchain.id, out);
    console.log(`Wrote ${join(out, 'target.o')} + decomp.yaml (${c.toolchain.id})`);
    break;
  }
  case 'fidelity': {
    const jobs = Number(opts.jobs ?? Math.min(8, cpus().length));
    if (!Number.isInteger(jobs) || jobs < 1) {
      console.error(`bad --jobs ${opts.jobs}`);
      process.exit(2);
    }
    const { fidelity } = await import('./run/fidelity');
    await fidelity(jobs);
    break;
  }
  case 'merge':
    merge();
    publish();
    break;
  case 'publish':
    publish();
    break;
  case 'stale-check': {
    // exit 0 either way; a thrown safety refusal (shrunk coverage / dirty provenance) exits 1.
    // Emits `stale=true|false` for GitHub Actions when GITHUB_OUTPUT is set.
    const { staleCheck } = await import('./report/stale-check');
    const verdict = staleCheck();
    console.log(`stale=${verdict === 'stale'}`);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `stale=${verdict === 'stale'}\n`);
    }
    break;
  }
  case 'regression': {
    // The refactor/feature gate `run` deliberately isn't: exit 1 on any match→non-match flip or
    // any committed row missing from the fresh run. Needs a merged results/results.json.
    const { regressionGate } = await import('./report/regression');
    process.exit(regressionGate());
    break;
  }
  case 'smoke':
    smoke();
    break;
  case 'vendor': {
    const { vendor } = await import('./cases/vendor');
    await vendor(opts.project);
    break;
  }
  case 'verify': {
    const manifest = positionals[1];
    if (!manifest) {
      console.error('usage: bench verify <manifest.json>');
      process.exit(2);
    }
    verify(manifest);
    break;
  }
  default:
    console.error(
      `usage: bench <run|target|fidelity|merge|publish|stale-check|regression|smoke|verify|vendor> — got ${JSON.stringify(command)}`,
    );
    process.exit(2);
}
