// The ONE case loop: skip-if-unavailable, build, evaluate both decompilers, log, and flush
// incrementally so a mid-run failure keeps prior progress. Used identically by the serial path
// and by every shard child.
import type { BenchMeta, BenchOutput, DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import { writeFileSync } from 'node:fs';

import { scrubObjectHeader } from '../asm-scrub';
import type { Case } from '../cases/types';
import { type EvalSpec, evaluate } from '../eval/evaluate';
import { asmliftProvenance } from '../provenance';

export interface Shard {
  idx: number; // 0-based shard index
  n: number; // shard count (1 = the whole set)
}

/** Parse "i/N" (the CLI's --shard form). Throws on malformed input. */
export function parseShard(s: string): Shard {
  const [i, n] = s.split('/').map(Number);
  if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 0 || i >= n) {
    throw new Error(`bad --shard ${s}; want i/N with 0<=i<N`);
  }
  return { idx: i, n };
}

/** The base meta block for a result set, carrying the provenance sampled WHERE THE NUMBERS WERE
 *  PRODUCED. `merge` re-stamps `asmlift` with its own sample and cross-checks the two (see
 *  ../provenance.ts for why one sample at merge time was not enough). */
export function benchMeta(results: FunctionResult[]): BenchMeta {
  return {
    generatedAt: new Date().toISOString(),
    toolchains: [...new Set(results.map((r) => r.toolchain))],
    counts: {
      total: results.length,
      synthetic: results.filter((r) => r.tier === 'synthetic').length,
      real: results.filter((r) => r.tier === 'real').length,
    },
    asmlift: asmliftProvenance(),
  };
}

/** The per-row log line's rendering of one decompiler's outcome.
 *
 *  A gap prints `diff:<score>/<maxScore>`, NOT `diff:<score>`, because `maxScore` is not a
 *  constant of the row: it is the objdiff row count of the winning candidate's alignment, so it
 *  moves whenever the candidate does (`kleod:CountCollectedGems:agbcc` went 290/404 → 171/387
 *  between two committed artifacts). A bare numerator invites reading two runs' scores as a
 *  subtraction on a fixed scale, which is how a 17-point denominator move got attributed to
 *  capability gaps. */
export function fmt(d: DecompilerResult): string {
  if (d.outcome === 'match') {
    return 'MATCH';
  }
  if (d.outcome === 'nonmatch') {
    // `typeof`, deliberately not `=== null`: the artifact types it `number | null`, but this
    // renderer also runs over hand-built and older objects where the key is simply ABSENT, and
    // `diff:12/undefined` is a worse answer than `diff:12`.
    return typeof d.maxScore === 'number' ? `diff:${d.score}/${d.maxScore}` : `diff:${d.score}`;
  }
  if (d.outcome === 'noncompile') {
    return `noncompile(${d.compileErrors})`;
  }
  if (d.outcome === 'declined') {
    return `declined(${d.errorMarkers?.length ?? '?'} gap(s))`;
  }
  return d.outcome; // 'failed'
}

/** The per-row log line's COST note: the row's wall seconds, and the size of the fan that is most
 *  of them.
 *
 *  The seconds alone say a row took 400 s and not that it compiled 5,952 spellings to get there.
 *  The pair is the only thing on this line that is not an outcome, and it is what a round watching
 *  a run scroll past steers by when it asks whether an axis it just shipped is affordable.
 *
 *  Absent on a row that never ranked (declined, failed): a bare `(1.2s)` rather than `fan 0`, which
 *  would read as a claim about the row's enumeration instead of about the run. */
export function costNote(d: DecompilerResult, secs: string): string {
  return d.candidateCount === undefined ? `(${secs}s)` : `(${secs}s, fan ${d.candidateCount})`;
}

/** THE PER-ROW LINE, assembled — a round's whole live view of a run. Pinning `costNote` alone
 *  leaves the line it goes into unpinned, which is how a counted line drifts from the test that
 *  asserts its shape. Pure, so the assembled line is testable without a run. */
export function rowLine(n: number, total: number, tag: string, r: FunctionResult, secs: string): string {
  return `[${n}/${total}]${tag} ${r.id}  asmlift=${fmt(r.asmlift)} m2c=${fmt(r.m2c)}  ${costNote(r.asmlift, secs)}`;
}

/** Whether flat index `idx` belongs to `shard` — the slicing contract the orchestrator rides on. */
export function inShard(idx: number, shard: Shard): boolean {
  return idx % shard.n === shard.idx;
}

/** Run this shard's slice of `cases`, writing `outPath` after every case. Returns the results.
 *
 *  `writeEmpty: false` suppresses the write while there is nothing to write — the same rule
 *  `orchestrate.ts`'s `stitch` already applies to the fanned path (`filtered && results.length
 *  === 0` returns without touching `<tier>.json`). The serial path had no such guard, and a row
 *  that is SELECTED and then SKIPPED walks straight past cli.ts's `cases.length === 0` check:
 *  `--tier synthetic --only <row> --toolchain agbcc --serial` with that toolchain unavailable
 *  wrote a 287-byte `results: []` over the tier file and then threw an error announcing the file
 *  had been "left unchanged". A shard CHILD always writes its part file (the stitcher owns
 *  `<tier>.json`), so this stays opt-in. */
export function runCases(
  cases: Case[],
  outPath: string,
  shard: Shard = { idx: 0, n: 1 },
  { writeEmpty = true }: { writeEmpty?: boolean } = {},
): FunctionResult[] {
  const mine = cases.filter((_, idx) => inShard(idx, shard));
  const results: FunctionResult[] = [];
  const tag = shard.n > 1 ? ` s${shard.idx}` : '';
  let done = 0;
  const buildFails: string[] = [];
  // A skipped row is a MISSING measurement, not a decompiler outcome — and 40 of them scroll past
  // unnoticed among 800 result lines. Counted here and totalled per tier by the orchestrator.
  const skippedToolchains = new Set<string>();
  let skips = 0;

  const flush = (): void => {
    if (!writeEmpty && results.length === 0) {
      return;
    }
    const out: BenchOutput = { meta: benchMeta(results), results };
    writeFileSync(outPath, JSON.stringify(out, null, 2));
  };

  for (const c of mine) {
    if (!c.toolchain.available()) {
      console.log(`SKIP ${c.id}: toolchain unavailable`);
      skips++;
      skippedToolchains.add(c.toolchain.id);
      continue;
    }
    const t0 = Date.now();
    let obj: string, asm: string;
    try {
      ({ obj, asm } = c.build());
      // the objdump header names the reference object's ABSOLUTE scratch path (mkdtemp-random,
      // machine-specific); scrub it so targetAsm — and everything embedding it (scripts, m2c
      // cache keys) — is byte-stable across machines and cache generations. No parser reads
      // the header line.
      asm = scrubObjectHeader(asm);
    } catch (e) {
      // couldn't produce the scoring target — a HARNESS defect, not a decompiler outcome.
      // Finish the shard (keep the other rows), then fail loudly below: a case with no row
      // would otherwise vanish from the results without a trace.
      buildFails.push(c.id);
      console.log(`[--/${mine.length}] ${c.id}  BUILD-FAIL: ${(e as Error).message.split('\n')[0]}`);
      continue;
    }
    const spec: EvalSpec = {
      sym: c.sym,
      project: c.project,
      tier: c.tier,
      language: c.language,
      features: c.features,
      refSource: c.refSource,
      sourceUrl: c.sourceUrl,
      loc: c.loc,
      ctx: c.ctx,
      ctxRef: c.ctxRef,
      ctxProto: c.ctxProto,
      proto: c.proto,
      symbols: c.symbols,
      note: c.note,
    };
    const r = evaluate(c.toolchain, spec, obj, asm, c.scorer, c.compile);
    results.push(r);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(rowLine(++done, mine.length, tag, r, secs));
    flush();
  }
  flush();
  if (skips > 0) {
    // the shape the orchestrator greps for; keep the prefix and the `n/total` in step with it
    console.log(
      `SKIPPED ${skips}/${mine.length} case(s): toolchain unavailable (${[...skippedToolchains].join(', ')})`,
    );
  }
  if (buildFails.length > 0) {
    throw new Error(
      `${buildFails.length} target build(s) failed — every case must yield a row: ${buildFails.join(', ')}`,
    );
  }
  return results;
}
