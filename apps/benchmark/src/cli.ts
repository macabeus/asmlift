// THE entry point: one argv parser, one subcommand dispatch. Every path the harness offers is a
// subcommand here — there are no other executable scripts.
//
//   pnpm bench run [--jobs N] [--tier synthetic|real|both] [--only s] [--project p]
//                  [--serial] [--shard i/N] [--toolchain id] [--no-lock]
//   pnpm bench in-flight                 # is a `bench run` measuring this worktree RIGHT NOW?
//                                        # exit 1 if so, naming the record, its pid, argv and age.
//                                        # Run it before ANY phase that edits the tree: the
//                                        # provenance sampler is sticky, so one mid-run save costs
//                                        # the whole run (see run/lock.ts)
//   pnpm bench repro <sym|id> [--out <dir>] [--tool asmlift|m2c] [--run]
//                                        # THE vehicle that reproduces one published row: writes
//                                        # the row's own generated script with this machine's
//                                        # paths filled in, under the gitignored .local/repro/,
//                                        # and with --run executes it and reports `[ranked]`
//   pnpm bench target <id> --out <dir>   # repro-script pre-step: target object + decomp.yaml
//   pnpm bench fan <row> [--show <label>] [--enumerate] [--force] [--base <ref>]
//   pnpm bench fan <sym> --asm <file.s> --toolchain <id>
//                                        # ONE row's whole candidate fan — every spelling's label
//                                        # and score, not just the winner's — in the harness's own
//                                        # configuration; --show prints a candidate's SOURCE and
//                                        # --enumerate lists the fan without compiling anything;
//                                        # --base <ref> adds the fan multiplier vs that artifact
//                                        # (on a declined row, the count that LEFT), and --asm
//                                        # prices a .s that is not a row, no scoring. --toolchain
//                                        # belongs to --asm alone: a row names its own in its id
//   pnpm bench sweep [--base <ref>|--base-dir <path>] [--tier t] [--only s] [--project p]
//                    [--arms harness,nomap] [--fan] [--force] [--repeat N]
//                    [--json <f>] [--compare <base.json> <head.json>] [--asm-dir <d> --toolchain <id>]
//                                        # THE CORPUS A/B: re-lift every row in this tree and in
//                                        # another one, map-ful and map-less, and print the rows
//                                        # whose emitted C (or enumerated fan, with --fan) differs.
//                                        # Compile-free: 28.8 s over 1,062 rows warm against a
//                                        # ~2,040 s `bench run`, so it answers "did my branch
//                                        # change anything" twenty times per round. --repeat asks
//                                        # the same question of this tree against ITSELF
//                                        # (determinism). Exit 1 when anything moved, like `diff`
//   pnpm bench gates --pass <id> [--only <row>] [--toolchain id]
//                                        # the per-id REFUSAL CENSUS of an l3/gates.ts table, off a
//                                        # real enumeration: which rule refused, how many times, in
//                                        # the harness's own configuration. Replaces the
//                                        # edit-instrument-revert loop for a tabled pass whose
//                                        # caller-side seam is reachable (`--pass` with no value
//                                        # lists them)
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
//   pnpm bench baseline <sym> [--base ref]
//                                        # the COMMITTED number for a row, plus whether anything
//                                        # since can have moved it — what a round opens with,
//                                        # instead of inheriting a brief's number
//   pnpm bench stale-check [--base ref]  # committed vs fresh results (measurement-level)
//   pnpm bench regression [--base ref]   # committed vs fresh MATCH gate: exit 1 on any lost match
//   pnpm bench diff [--base ref]         # committed vs fresh per-ROW, per-FIELD: exit 1 on any move
//                                        #   exit 2 = nothing compared (no run behind it)
//   pnpm bench smoke                     # one trivial fn through every available toolchain
//   pnpm bench verify <manifest.json>    # compile-check loop for authoring real manifests
//   pnpm bench vendor [--project p] [--symbols-only]   # freeze the real tier's preprocessed TUs
//                                        # (needs checkouts); --symbols-only rewrites just the
//                                        # ELF-derived symbol maps
//
// `run` fans shard child processes by default (see run/orchestrate.ts); `--serial` runs
// in-process — the debugging path, and also HOW the shard children themselves run (the parent
// spawns `run --serial --shard i/N`, which writes `<tier>.part<i>.json` for the stitcher).
import type { FunctionResult } from '@asmlift/bench-schema';
import {
  CACHE_MISMATCH_EXIT,
  MISMATCH_LOG,
  cacheMismatches,
  cacheMode,
  cacheSampleNote,
  cacheStats,
} from '@asmlift/cli/candcache';
import { macroDefinesUsedBy } from '@asmlift/core/macros';
import { symbolMapToJson } from '@asmlift/core/symbols';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { acquireBenchLock, benchLockStatus } from './run/lock';
import { type Tier, emptySelectionError, orchestrate, tierIsFiltered } from './run/orchestrate';
import { preflightRefusals, runIsWholeTier, runTakesTheBenchLock } from './run/preflight';
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
    // run only: the sanctioned way past the concurrent-run refusal (run/lock.ts). It skips the
    // verdict AND the record, so this run is invisible to the next one — which is the price, said
    // out loud on stderr. It exists so that the way past a refusal is not `rm`ing a record someone
    // else's live run depends on.
    'no-lock': { type: 'boolean', default: false },
    build: { type: 'boolean', default: false },
    out: { type: 'string' },
    'project-root': { type: 'string' },
    // which committed artifact the comparison gates read. HEAD by default; a branch that has
    // already committed its own results.json must name its branch point (origin/main), or it
    // compares itself against itself and every gate passes vacuously.
    base: { type: 'string' },
    // vendor only: rewrite just the derived symbol maps, leaving the preprocessed TUs, index.json
    // and PROVENANCE.json exactly as committed (see cases/vendor.ts).
    'symbols-only': { type: 'boolean', default: false },
    // repro only: which of the row's two scripts, and whether to execute it here.
    tool: { type: 'string' },
    run: { type: 'boolean', default: false },
    // fan only: which candidate's source to print, listing the fan without compiling it, and the
    // override for the fan-size refusal. `--asm` swaps the dataset row for a raw `.s` file (with
    // `--toolchain` for the target and the positional read as the SYMBOL); the fan-vs-a-base
    // comparison rides on the `--base` flag above rather than a second word for one ref.
    show: { type: 'string' },
    enumerate: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    asm: { type: 'string' },
    // gates only: which tabled pass to census (see run/gate-census.ts's registry).
    pass: { type: 'string' },
    // sweep only: the corpus-wide differential re-lift (run/sweep.ts). `--base`/`--base-dir` name
    // the OTHER tree; `--arms` which configurations to lift each row in; `--fan` adds enumeration
    // (120x the lift); `--repeat` asks this tree whether it agrees with itself; `--json` and
    // `--compare` split a comparison into two runs that need not happen on the same machine.
    // `--asm-dir` swaps dataset rows for a tree of raw `.s`/`.inc` files, which is the corpus the
    // hand-built rigs swept that `bench fan` cannot reach.
    'base-dir': { type: 'string' },
    arms: { type: 'string', default: 'harness,nomap' },
    fan: { type: 'boolean', default: false },
    repeat: { type: 'string' },
    json: { type: 'string' },
    // `--compare <base.json> <head.json>`: the second file is a POSITIONAL. `multiple: true` would
    // need `--compare a --compare b`, which nobody types and which silently compared one file
    // against `undefined` when they did not.
    compare: { type: 'string' },
    'asm-dir': { type: 'string' },
    'asm-project': { type: 'string' },
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
 *  published reproduction script must land on the same rung the benchmark did. The gitignored
 *  per-tier `real.json` is read ONLY for a row `results.json` does not carry at all, so a local
 *  `bench run --tier real --only <sym>` that moves a PUBLISHED row does not refresh the rung — the
 *  reproduction stays frozen at the published one. Right for a reader reproducing a published row,
 *  wrong for an author iterating: the author's confirm is `bench run`, not this. Neither file has
 *  the row, or the row is unscored ⇒ undefined, and the caller takes the richest rung — the
 *  behavior before the rung was derived at all. */
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
    // `--shard` is meaningful only on the `--serial` path — the fan-out branch below never reads
    // `opts.shard`. Left to run, `run --shard i/N` discards the shard, fans every child over the
    // whole tier and rewrites `results/<tier>.json`, while looking to a reader like the one argv
    // the preflight exempts. Reject the argv rather than interpret it.
    if (opts.shard && !opts.serial) {
      console.error(
        `--shard ${opts.shard} without --serial: this path fans out across --jobs children and ignores the shard.\n` +
          'Use `--serial --shard i/N` (what orchestrate.ts spawns), or drop --shard.',
      );
      process.exit(2);
    }
    // BEFORE anything that costs: the conditions that make a run's numbers worthless — or that
    // make starting it at all a mistake — are all decidable in under a second. ONE options object,
    // read by every verdict and by the record below, because two hand-kept copies of it drift.
    // See run/preflight.ts.
    const runOpts = {
      tiers,
      only: opts.only,
      project: opts.project,
      toolchain: opts.toolchain,
      shard: opts.shard,
      serial: opts.serial,
    };
    const preflight = preflightRefusals(runOpts, { ignoreLock: opts['no-lock'] });
    for (const w of preflight.warnings) {
      console.error(`${w}\n`);
    }
    if (preflight.refusals.length > 0) {
      console.error(preflight.refusals.join('\n\n'));
      process.exit(1);
    }
    // Then record that this worktree is being measured, so the phases that EDIT it — and the next
    // `bench run` on this machine — can tell. Taking the record is a WRITE and not a verdict,
    // which is why it is here and the refusal is in preflight.ts; which invocations are exempt is
    // that file's `runTakesTheBenchLock`.
    if (runTakesTheBenchLock(runOpts)) {
      if (opts['no-lock']) {
        console.error(
          '[bench lock] --no-lock: this run takes NO record, so nothing will stop an agent editing\n' +
            '             the tree under it, and the next `bench run` cannot see it. You said so.\n',
        );
      } else {
        acquireBenchLock(`bench ${process.argv.slice(2).join(' ')}`, {
          tiers,
          whole: runIsWholeTier(runOpts),
        });
      }
    }
    // Deliberately NOT folded into `preflightRefusals`: each of that function's verdicts is gated
    // on a predicate (takes-a-record / whole-tier / touches-real), while the m2c pin applies to
    // EVERY run, shard children and `--only` included, and throws its own remediation line.
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
        const n = runCases(cases, out, shard, { writeEmpty: !filtered }).length;
        if (filtered) {
          selected = (selected ?? 0) + n;
        }
        // A row that is SELECTED and then SKIPPED (its toolchain is unavailable) reaches here
        // with n === 0 and cases.length > 0 — the guard above cannot see it, and the write is
        // suppressed by `writeEmpty` rather than by that guard. Say so, and add the tier to
        // `untouched` so the verdict below names a file instead of a blank.
        if (filtered && n === 0) {
          untouched.push(tier);
          console.log(`\nNo ${tier} row was MEASURED — ${out} left unchanged`);
          continue;
        }
        console.log(`\nWrote ${n} ${tier} results → ${out}`);
      }
      if (selected === 0) {
        throw emptySelectionError(opts, untouched);
      }
      // What the cross-run candidate-object cache did in THIS shard, when it did anything.
      // Gate E ("run the whole workload in verify mode and count") reads these lines; a shard
      // that prints `mismatch` has served bytes a fresh compile disagrees with, and the store's
      // whole namespace is suspect. An `on` shard reports the same way: it compiles a sampled
      // fraction of the keys it serves anyway and audits them, and the `sample=…%/seed=…` field
      // says at what rate — a bench run is where the negative half of the store (84% of what this
      // run's shards were served, and 0 of the LoadBGTilemapData fan) gets sampled at all. Absent
      // only when the cache is off, which is not the default — an unset ASMLIFT_CANDCACHE serves,
      // so a shard with no line here was turned off on purpose (ASMLIFT_CANDCACHE=0/off/empty,
      // ASMLIFT_BENCH_CACHE=0, or a refusal).
      if (cacheMode() !== 'off') {
        const stats = cacheStats();
        if (Object.keys(stats).length > 0) {
          console.log(`[candcache] ${cacheMode()}${cacheSampleNote()} ${JSON.stringify(stats)}`);
        }
        // A mismatch FAILS THE SHARD, with the CLI's own code for it. Printing is not enough: one
        // line among sixteen shard logs and a zero exit makes a "0 differing" result rest on a
        // human's grep — and a throw here would exit 1, which on this path is also what an
        // ordinary build failure exits, so the status would carry no more than the grep did.
        // `process.exitCode` rather than `process.exit`: the parent reads this child's stdout
        // through a pipe, and exiting outright can truncate the very lines that say why.
        if (cacheMismatches() > 0) {
          console.error(
            `[candcache] ${cacheMismatches()} stored answer(s) disagreed with a fresh compile — the store is ` +
              `serving objects this toolchain no longer produces. See ${MISMATCH_LOG}, then drop the store ` +
              `(ASMLIFT_CANDCACHE_DIR).`,
          );
          process.exitCode = CACHE_MISMATCH_EXIT;
        }
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
  case 'in-flight': {
    // The read every tree-EDITING phase makes: is a bench measuring this worktree right now?
    // Exits 1 while one is, naming the record. Not called `lock`, because it takes nothing and
    // holds nothing — `bench run` is what writes a record, and a reader who typed a verb would
    // reasonably expect this to reserve the tree for them. See run/lock.ts.
    process.exit(benchLockStatus());
    break;
  }
  case 'repro': {
    // The reproduce-one-row command both function briefs point at. `bench target` is its step 1,
    // not this: run alone it prints no `[score]` and writes no input `.s`.
    const sym = positionals[1];
    if (!sym) {
      console.error('usage: pnpm bench repro <sym|project:sym:toolchain> [--out <dir>] [--tool asmlift|m2c] [--run]');
      process.exit(2);
    }
    const { repro } = await import('./report/repro');
    try {
      process.exit(await repro(sym, { out: opts.out, tool: opts.tool, run: opts.run }));
    } catch (e) {
      console.error(`repro: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
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
    let symbolsFile: string | undefined;
    if (c.symbols && c.tier === 'synthetic') {
      // A SYNTHETIC row's map is AUTHORED in the dataset, not derived from any ELF, so there is
      // no checkout to graft and nothing for --project-root to point at. Write the same map the
      // harness fed the row, in the CLI's `tools.asmlift.symbols` JSON shape, beside target.o.
      // Without this the script would run map-less and reproduce a DIFFERENT source than the
      // row it claims to reproduce — a `/no-bitfield` or `/no-ptr-elem` row's whole content is
      // the spelling the map licenses.
      writeFileSync(join(out, 'symbols.json'), `${JSON.stringify(symbolMapToJson(c.symbols), null, 2)}\n`);
      symbolsFile = 'symbols.json';
    } else if (c.symbols) {
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
    writeScoreConfig(c.toolchain.id, out, elf, ctxFile, symbolsFile);
    console.log(
      `Wrote ${join(out, 'target.o')} + decomp.yaml (${c.toolchain.id}${elf ? ' + symbol-map ELF' : ''}${
        symbolsFile ? ' + authored symbol map' : ''
      }${ctxFile ? ` + scoring context (escalation rung ${ctxRung}: ${RUNG_NAMES[ctxRung - 1]})` : ''})`,
    );
    break;
  }
  case 'fan': {
    // fan <row> [--show <label>] [--enumerate] [--force] [--base <ref>] — print the ranked
    // candidate fan the harness computes for this row and then discards (run/fan.ts). ROW-SCOPED
    // by construction, and that is the point rather than an omission: a tier-wide form would write
    // tens of thousands of sources to answer a question that is always about one function.
    //
    // `--base <ref>` adds one line: this row's fan against the count the artifact at that ref
    // recorded — the multiplier a round reports before merging an axis, without a bench run.
    //
    // `--asm <file.s> --toolchain <id>` swaps the row for a raw `.s`, and then the positional is
    // the SYMBOL rather than a row id. Enumeration only: scoring needs a target object, which is
    // exactly what a row carries and a bare `.s` does not.
    const rowId = positionals[1];
    const usage =
      'usage: pnpm bench fan <sym|project:sym:toolchain> [--show <label>] [--enumerate] [--force] [--base <ref>]\n' +
      '   or: pnpm bench fan <sym> --asm <file.s> --toolchain <id> [--show <label>]';
    if (!rowId) {
      console.error(usage);
      process.exit(2);
    }
    const { fan, fanOfAsm } = await import('./run/fan');
    // `!== undefined` and not truthiness: `--base=` parses as the EMPTY STRING, and dropping it
    // ran the whole command with no comparison at exit 0 — the same silence the refusals here
    // exist to end. An empty ref reaches `readCommitted` and is refused there, by name.
    //
    // `toolchain`/`asmPath` go to BOTH paths, and only so `optionRefusal` can see the pair:
    // `--toolchain` without `--asm` was accepted and ignored, pricing whichever toolchain the row
    // id resolved to.
    const fanOpts = {
      ...(opts.show ? { show: opts.show } : {}),
      ...(opts.base !== undefined ? { base: opts.base } : {}),
      ...(opts.toolchain !== undefined ? { toolchain: opts.toolchain } : {}),
      ...(opts.asm !== undefined ? { asmPath: opts.asm } : {}),
      enumerateOnly: opts.enumerate,
      force: opts.force,
    };
    if (opts.asm) {
      if (!opts.toolchain) {
        console.error(`--asm needs --toolchain: a .s file does not say which target lifted it.\n${usage}`);
        process.exit(2);
      }
      process.exit(fanOfAsm(rowId, opts.asm, opts.toolchain, fanOpts));
    }
    process.exit(fan(rowId, fanOpts));
    break;
  }
  case 'sweep': {
    // sweep [--base <ref>|--base-dir <path>] [--tier t] [--only s] [--project p] [--arms a,b]
    //       [--fan] [--force] [--repeat N] [--json f] [--compare <base.json> <head.json>]
    //       [--asm-dir d --toolchain t]
    //
    // The corpus A/B twenty agents hand-built. CORPUS-WIDE and affordable for the same reason
    // `bench gates` is and `bench fan` is not: nothing here is COMPILED. Lifting all 1,062
    // available rows in both arms is 28.8 s warm; `--fan` adds enumeration and is 277.4 s, which
    // is why it is a flag. run/sweep.ts's header carries the measured table.
    const { sweep } = await import('./run/sweep');
    process.exit(
      await sweep({
        tiers,
        ...(opts.only !== undefined ? { only: opts.only } : {}),
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        arms: opts.arms.split(',').filter((a) => a !== ''),
        fan: opts.fan,
        force: opts.force,
        ...(opts.repeat !== undefined ? { repeat: Number(opts.repeat) } : {}),
        ...(opts.json !== undefined ? { json: opts.json } : {}),
        ...(opts.compare !== undefined ? { compare: [opts.compare, ...positionals.slice(1)] } : {}),
        ...(opts.base !== undefined ? { base: opts.base } : {}),
        ...(opts['base-dir'] !== undefined ? { baseDir: opts['base-dir'] } : {}),
        ...(opts['asm-dir'] !== undefined ? { asmDir: opts['asm-dir'] } : {}),
        ...(opts.toolchain !== undefined ? { toolchain: opts.toolchain } : {}),
        ...(opts['asm-project'] !== undefined ? { asmProject: opts['asm-project'] } : {}),
      }),
    );
    break;
  }
  case 'gates': {
    // gates --pass <id> [--only <row>] [--toolchain id] — the refusal census of a tabled pass.
    // CORPUS-WIDE by default and that is affordable, unlike `fan`: nothing is COMPILED here, the
    // enumeration alone answers the question (~10 s over the agbcc synthetic tier).
    const { CENSUSABLE_PASSES, gateCensus } = await import('./run/gate-census');
    if (!opts.pass) {
      console.error(`usage: pnpm bench gates --pass <${CENSUSABLE_PASSES.join('|')}> [--only <row>] [--toolchain id]`);
      process.exit(2);
    }
    process.exit(
      gateCensus({
        pass: opts.pass,
        ...(opts.only ? { only: opts.only } : {}),
        ...(opts.toolchain ? { toolchain: opts.toolchain } : {}),
      }),
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
  case 'baseline': {
    // Phase 0 of every round: what does the PUBLISHED benchmark say about this row, and is that
    // still the answer. `docs/baseline-freshness.md` is the argument; this is the command.
    //
    // `--base origin/main` by default and not HEAD, unlike the comparison gates: the question is
    // what the published baseline says, and a branch that has committed its own artifact would
    // otherwise be asked about itself. An unfetched `origin/main` throws out of `readCommitted`
    // carrying the fetch instruction, rather than reading as "this symbol has no row".
    const sym = positionals[1];
    if (!sym) {
      console.error(
        'usage: bench baseline <sym> [--base ref]   # <sym> is a substring, or a full project:sym:toolchain id',
      );
      process.exit(2);
    }
    const { baseline } = await import('./report/baseline');
    try {
      process.exit(baseline(sym, opts.base ?? 'origin/main'));
    } catch (e) {
      // The message, not a stack: what reaches here is an unreadable ref, whose text from
      // `readCommitted` already says what to do about it (`git fetch origin`).
      console.error(`baseline: ${e instanceof Error ? e.message : e}`);
      process.exit(2);
    }
    break;
  }
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
  }
  case 'diff': {
    // The NEUTRALITY gate: exit 1 if any published field of a row moved, or if the row set
    // changed. `report/diff.ts`'s FIELDS owns which fields those are, per side. What a refactor,
    // a harness change or a tooling change has to prove, and what `regression` (outcome only) and
    // `stale-check` (one word, no row named) each answer half of.
    const { diffGate } = await import('./report/diff');
    process.exit(diffGate(opts.base));
  }
  case 'smoke':
    smoke();
    break;
  case 'vendor': {
    const { vendor } = await import('./cases/vendor');
    await vendor(opts.project, { symbolsOnly: opts['symbols-only'] });
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
      `usage: bench <run|in-flight|repro|target|fan|sweep|gates|setup|fidelity|merge|publish|baseline|stale-check|regression|diff|smoke|verify|vendor> — got ${JSON.stringify(command)}`,
    );
    process.exit(2);
}
