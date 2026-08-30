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
//   pnpm bench fidelity [--jobs N] [--project p] [--only s]
//                                        # pre-publish gate: re-run BOTH repro scripts, every function
//   pnpm bench merge                     # tiers → results.json, then publish
//   pnpm bench publish                   # re-stage results.json into the web app
//   pnpm bench stale-check [--base ref]  # committed vs fresh results (measurement-level)
//   pnpm bench regression [--base ref]   # committed vs fresh MATCH gate: exit 1 on any lost match
//   pnpm bench diff [--base ref]         # committed vs fresh per-ROW, per-FIELD: exit 1 on any move
//                                        #   exit 2 = nothing compared (no run behind it)
//   pnpm bench smoke                     # one trivial fn through every available toolchain
//   pnpm bench verify <manifest.json>    # compile-check loop for authoring real manifests
//   pnpm bench vendor [--project p]      # freeze the real tier's preprocessed TUs (needs checkouts)
//
// `run` fans shard child processes by default (see run/orchestrate.ts); `--serial` runs
// in-process — the debugging path, and also HOW the shard children themselves run (the parent
// spawns `run --serial --shard i/N`, which writes `<tier>.part<i>.json` for the stitcher).
import type { FunctionResult } from '@asmlift/bench-schema';
import { cacheMode, cacheStats } from '@asmlift/cli/candcache';
import { macroDefinesUsedBy } from '@asmlift/core/macros';
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
import { type Tier, emptySelectionError, orchestrate, tierIsFiltered } from './run/orchestrate';
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
    // which committed artifact the comparison gates read. HEAD by default; a branch that has
    // already committed its own results.json must name its branch point (origin/main), or it
    // compares itself against itself and every gate passes vacuously.
    base: { type: 'string' },
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
      // The same empty-selection verdict the fanned-out path takes, because this path writes
      // <tier>.json DIRECTLY: `--tier synthetic --only <typo> --toolchain agbcc --serial` — the
      // per-toolchain smoke shape /attribute-function instructs — replaced a 594-row
      // synthetic.json with an empty one and exited 0, and the next `bench merge` published the
      // other tier alone. A shard CHILD is exempt: it always writes its part file (even 0 rows —
      // the stitcher owns <tier>.json), and a filter narrower than the shard count legitimately
      // leaves most shards empty.
      let selected: number | null = null;
      const untouched: Tier[] = [];
      for (const tier of tiers) {
        const out = join(RESULTS_DIR, opts.shard ? `${tier}.part${shard.idx}.json` : `${tier}.json`);
        const filtered = !opts.shard && tierIsFiltered(tier, opts);
        const cases = casesFor(tier);
        if (filtered && cases.length === 0) {
          selected = selected ?? 0;
          untouched.push(tier);
          console.log(`\nNo ${tier} row selected — ${out} left unchanged`);
          continue;
        }
        const n = runCases(cases, out, shard).length;
        if (filtered) {
          selected = (selected ?? 0) + n;
        }
        console.log(`\nWrote ${n} ${tier} results → ${out}`);
      }
      if (selected === 0) {
        throw emptySelectionError(opts, untouched);
      }
      // What the cross-run candidate-object cache did in THIS shard, when it did anything.
      // Gate E ("run the whole workload in verify mode and count") reads these lines; a shard
      // that prints `mismatch` has served bytes a fresh compile disagrees with, and the store's
      // whole namespace is suspect. Absent when the cache is off, which is the default.
      if (cacheMode() !== 'off') {
        console.log(`[candcache] ${cacheMode()} ${JSON.stringify(cacheStats())}`);
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
        // Address-cast macro defines the published source NAMES. Every rung needs them (the
        // scoring compile prepends them too), and the reproduction context must carry them or
        // the published script cannot build the source the benchmark published.
        const macros = source && man.symbols ? macroDefinesUsedBy(man.symbols, source) : '';
        // Only a SCORED row's source pins a rung. declined/noncompile/failed rows have no source
        // that compiles anywhere (a marker stub, an error string), so replaying would just burn
        // three compiles to land on the richest rung — take it directly.
        const picked = source
          ? resolveScoringPrelude(c.toolchain.id, prependC, ctxI, c.sym, source, macros)
          : { prelude: ladder[ladder.length - 1], rung: ladder.length };
        ctxRung = picked.rung;
        ctxFile = materializeScoringContext(picked.prelude + macros, out);
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
    await fidelity(jobs, { project: opts.project, only: opts.only });
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
    const verdict = staleCheck(opts.base);
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
    process.exit(regressionGate(opts.base));
    break;
  }
  case 'diff': {
    // The NEUTRALITY gate: exit 1 if any row's asmlift {outcome,score,candidateLabel,source} or
    // m2c {outcome,score,source} moved, or if the row set changed. What a refactor, a harness
    // change or a tooling change has to prove, and what `regression` (outcome only) and
    // `stale-check` (one word, no row named) each answer half of.
    const { diffGate } = await import('./report/diff');
    process.exit(diffGate(opts.base));
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
      `usage: bench <run|target|setup|fidelity|merge|publish|stale-check|regression|diff|smoke|verify|vendor> — got ${JSON.stringify(command)}`,
    );
    process.exit(2);
}
