// THE entry point: one argv parser, one subcommand dispatch. Every path the harness offers is a
// subcommand here — there are no other executable scripts.
//
//   pnpm bench run [--jobs N] [--tier synthetic|real|both] [--only s] [--project p]
//                  [--serial] [--shard i/N] [--toolchain id]
//   pnpm bench target <id> --out <dir>   # repro-script pre-step: target object + decomp.yaml
//   pnpm bench setup [--project p] [--build]
//                                        # materialize the BENCH-OWNED project checkouts
//                                        # (apps/benchmark/checkouts/: clone + baseroms + prepare;
//                                        # --build runs each project's full verified build) + fetch
//                                        # bench-owned toolchains; non-bench-owned checkouts are
//                                        # only reported, never touched
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
import type { FunctionResult } from '@asmlift/bench-schema';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { loadManifests, loadManifestsForVendor, resolveProjectRoot } from './cases/manifests';
import { resolveProjectElf } from './cases/project-elf';
import { realCases } from './cases/real';
import { syntheticCases } from './cases/synthetic';
import { resolveScoringPrelude, scoringPreludes } from './compile/real';
import { RESULTS_DIR } from './config';
import { materializeScoringContext, writeScoreConfig } from './decomp-config';
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
    build: { type: 'boolean', default: false },
    out: { type: 'string' },
    'project-root': { type: 'string' },
  },
});

const command = positionals[0];
const tiers: Tier[] = opts.tier === 'both' ? ['synthetic', 'real'] : [opts.tier as Tier];
if (opts.tier !== 'both' && opts.tier !== 'synthetic' && opts.tier !== 'real') {
  console.error(`unknown --tier ${opts.tier}`);
  process.exit(2);
}

/** Human names for compile/real.ts's escalation rungs, for the `bench target` log line. */
const RUNG_NAMES = ['bare typedefs', '+ manifest prependC', 'vendored ctx'];

/** The published WINNING source for one real row — but only when asmlift's outcome was actually
 *  SCORED (a declined/noncompile/failed row's stored text compiles nowhere, so it pins nothing).
 *  `bench target` replays the scoring escalation over it to recover the context rung the harness
 *  used.
 *
 *  `results.json` first, because that is the COMMITTED file every checkout has — a user running a
 *  published reproduction script must land on the same rung the benchmark did. The per-tier
 *  `real.json` is gitignored (present only right after a local `bench run`) and serves the
 *  pre-merge loop. Neither present, or the row unscored ⇒ undefined, and the caller takes the
 *  richest rung — the behavior before the rung was derived at all. */
function publishedAsmliftSource(rowId: string): string | undefined {
  for (const file of ['results.json', 'real.json']) {
    let results: FunctionResult[];
    try {
      ({ results } = JSON.parse(readFileSync(join(RESULTS_DIR, file), 'utf8')) as { results: FunctionResult[] });
    } catch {
      continue;
    }
    const row = results.find((r) => r.id === rowId);
    if (row) {
      return row.asmlift.outcome === 'match' || row.asmlift.outcome === 'nonmatch' ? row.asmlift.source : undefined;
    }
  }
  return undefined;
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
    // target <rowId> --out <dir> [--project-root <dir>] — the repro scripts' pre-step: build
    // this function's target object (content-cached) and write a decomp.yaml whose compile
    // command is the benchmark's own toolchain invocation, so `asmlift --config decomp.yaml
    // --score-against target.o` scores exactly what the benchmark scored. Symbol-fed rows
    // additionally graft the project checkout's tools.asmlift.elf (the symbol-map source) into
    // that decomp.yaml — --project-root names the checkout (default: the same resolution the
    // harness uses); a missing checkout/ELF warns LOUDLY and degrades to a map-less config.
    const rowId = positionals[1];
    const out = opts.out;
    if (!rowId || !out) {
      console.error('usage: pnpm bench target <project:sym:toolchain> --out <dir> [--project-root <dir>]');
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
    let elf: string | undefined;
    if (c.symbols) {
      // the row was MEASURED with the project's symbol map — resolve the checkout's derived
      // symbols ELF so the CLI loads the same map the benchmark fed this function
      const man = loadManifestsForVendor().find((m) => m.project === c.project);
      const root = opts['project-root'] ?? (man ? resolveProjectRoot(man) : undefined);
      const mapless = (why: string): void =>
        console.error(
          `WARN: ${c.project}: ${why} — decomp.yaml written WITHOUT tools.asmlift.elf (the ` +
            `symbol map); output may differ from the published row`,
        );
      if (root === undefined || !existsSync(root)) {
        mapless(`project checkout not found${root ? ` at ${root}` : ''} (set PROJECT_PATH / --project-root)`);
      } else {
        const res = resolveProjectElf(c.project, root);
        if (res.elf !== null) {
          elf = res.elf;
        } else {
          mapless(`symbol map unavailable (${res.reason})`);
        }
      }
    }
    // REAL rows are scored inside an ESCALATING context (compile/real.ts) — materialize the rung
    // the harness actually stopped at for this row, so the generated compile command grades the
    // candidate in the same world the benchmark did. Not always the richest: a project context
    // can reject what bare typedefs accept (its prototype vs. an implicitly-declared call), and
    // the row's published source is the evidence of where escalation stopped — so replay the
    // ladder against it. (Synthetic rows have no context: they are scored bare, config stays bare.)
    let ctxFile: string | undefined;
    let ctxRung = 0;
    if (c.tier === 'real') {
      const man = loadManifests().find((m) => m.project === c.project);
      if (man) {
        const { ctxI } = man.vendored(c.sym);
        const prependC = man.functions.find((f) => f.sym === c.sym)?.prependC ?? '';
        const source = publishedAsmliftSource(rowId);
        const ladder = scoringPreludes(prependC, ctxI, c.sym);
        // Only a SCORED row's source pins a rung. declined/noncompile/failed rows have no source
        // that compiles anywhere (a marker stub, an error string), so replaying would just burn
        // three compiles to land on the richest rung — take it directly.
        const picked = source
          ? resolveScoringPrelude(c.toolchain.id, prependC, ctxI, c.sym, source)
          : { prelude: ladder[ladder.length - 1], rung: ladder.length };
        ctxRung = picked.rung;
        ctxFile = materializeScoringContext(picked.prelude, out);
      }
    }
    writeScoreConfig(c.toolchain.id, out, elf, ctxFile);
    console.log(
      `Wrote ${join(out, 'target.o')} + decomp.yaml (${c.toolchain.id}${elf ? ' + symbol-map ELF' : ''}${
        ctxFile ? ` + scoring context (escalation rung ${ctxRung}: ${RUNG_NAMES[ctxRung - 1] ?? 'vendored ctx'})` : ''
      })`,
    );
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
  case 'setup': {
    const { setup } = await import('./cases/setup');
    await setup(opts.project, { build: opts.build });
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
      `usage: bench <run|target|setup|fidelity|merge|publish|stale-check|regression|smoke|verify|vendor> — got ${JSON.stringify(command)}`,
    );
    process.exit(2);
}
