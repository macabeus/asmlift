// The ONE case loop: skip-if-unavailable, build, evaluate both decompilers, log, and flush
// incrementally so a mid-run failure keeps prior progress. Used identically by the serial path
// and by every shard child.
import type { BenchMeta, BenchOutput, DecompilerResult, FunctionResult } from '@asmlift/bench-schema';
import { writeFileSync } from 'node:fs';

import type { Case } from '../cases/types';
import { type EvalSpec, evaluate } from '../eval/evaluate';

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

/** The base meta block for a result set (merge extends it with provenance). */
export function benchMeta(results: FunctionResult[]): BenchMeta {
  return {
    generatedAt: new Date().toISOString(),
    toolchains: [...new Set(results.map((r) => r.toolchain))],
    counts: {
      total: results.length,
      synthetic: results.filter((r) => r.tier === 'synthetic').length,
      real: results.filter((r) => r.tier === 'real').length,
    },
  };
}

function fmt(d: DecompilerResult): string {
  if (d.outcome === 'match') {
    return 'MATCH';
  }
  if (d.outcome === 'nonmatch') {
    return `diff:${d.score}`;
  }
  if (d.outcome === 'noncompile') {
    return `noncompile(${d.compileErrors})`;
  }
  if (d.outcome === 'declined') {
    return `declined(${d.errorMarkers?.length ?? '?'} gap(s))`;
  }
  return d.outcome; // 'failed'
}

/** Whether flat index `idx` belongs to `shard` — the slicing contract the orchestrator rides on. */
export function inShard(idx: number, shard: Shard): boolean {
  return idx % shard.n === shard.idx;
}

/** Run this shard's slice of `cases`, writing `outPath` after every case. Returns the results. */
export function runCases(cases: Case[], outPath: string, shard: Shard = { idx: 0, n: 1 }): FunctionResult[] {
  const mine = cases.filter((_, idx) => inShard(idx, shard));
  const results: FunctionResult[] = [];
  const tag = shard.n > 1 ? ` s${shard.idx}` : '';
  let done = 0;
  const buildFails: string[] = [];

  const flush = (): void => {
    const out: BenchOutput = { meta: benchMeta(results), results };
    writeFileSync(outPath, JSON.stringify(out, null, 2));
  };

  for (const c of mine) {
    if (!c.toolchain.available()) {
      console.log(`SKIP ${c.id}: toolchain unavailable`);
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
      asm = asm.replace(/^\/\S+\.o:/m, 'target.o:');
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
      proto: c.proto,
      symbols: c.symbols,
      note: c.note,
    };
    const r = evaluate(c.toolchain, spec, obj, asm, c.scorer, c.compile);
    results.push(r);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${++done}/${mine.length}]${tag} ${c.id}  asmlift=${fmt(r.asmlift)} m2c=${fmt(r.m2c)}  (${secs}s)`);
    flush();
  }
  flush();
  if (buildFails.length > 0) {
    throw new Error(
      `${buildFails.length} target build(s) failed — every case must yield a row: ${buildFails.join(', ')}`,
    );
  }
  return results;
}
