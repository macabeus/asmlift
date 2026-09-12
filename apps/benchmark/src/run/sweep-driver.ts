// THE DRIVER `bench sweep` runs — once per tree under comparison, and it is the SAME code both
// times.
//
// WHY IT TAKES A TREE ROOT AND DYNAMIC-IMPORTS. A base-versus-head sweep needs BASE's decompiler
// to lift the base side and HEAD's to lift the head side, while the METHOD — which rows, which
// arms, which fields, in which order — stays fixed. Two ways to get that, and the hand rigs used
// both:
//
//   - run the base tree's OWN sweep command. Correct, and impossible against a revision older than
//     this commit, which is every revision a round wants to A/B today.
//   - point ONE driver at a tree root and dynamic-import that tree's modules by absolute path.
//     That is `sweep.mts`, `det.mts`, `census2.mts` and `rowhash.mts` in this project's scratch,
//     and it works for a reason worth writing down: a module imported by absolute path resolves
//     its OWN `@asmlift/core/*` specifiers relative to ITSELF, so `${root}/apps/benchmark/src/
//     cases/real.ts` reaches `${root}/packages/core` through `${root}/node_modules` no matter
//     where this file sits. The driver needs nothing but node builtins of its own.
//
// This is the second. `bench sweep` runs it in-process for this tree and spawns it (through this
// tree's `tsx`) for the base tree, so the base side needs only `pnpm install` — no checkouts, no
// toolchain symlinks, and no `sweep` subcommand of its own. `cases/real.ts` reads VENDORED
// preprocessed TUs, not project checkouts (`manifests.ts`: "the runtime shape — no checkout"), so
// a bare `git worktree add` plus `pnpm install` is a complete base tree for this purpose.
//
// THE HAZARD THIS SHAPE HAS, said out loud: the base tree's modules are loaded into a process whose
// entry came from the head tree. Nothing static crosses (see the imports below — `node:` only), so
// there is no shared module instance to contaminate; what CAN cross is an environment variable, and
// both sides inherit the same one deliberately, because a toolchain that resolves on one side and
// not the other is a difference this command must NOT attribute to the code.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { SweepRecord } from './sweep';

export interface SweepSelection {
  /** `synthetic`, `real` or both */
  tiers: readonly ('synthetic' | 'real')[];
  /** substring of a row id, the same selector `bench fan` and `bench gates` take */
  only?: string;
  /** real tier only: one manifest project */
  project?: string;
  /** `harness` (the row's own configuration) and/or `nomap` (that, minus the symbol map) */
  arms: readonly string[];
  /** also enumerate each row's fan (see `SWEEP_FAN_LIMIT` — 120× the lift) */
  fan?: boolean;
  /** enumerate rows the committed artifact prices above `SWEEP_FAN_LIMIT` anyway */
  force?: boolean;
  /** rows whose recorded fan exceeds the limit, as id → count. Computed by the CALLER (off THIS
   *  tree's committed artifact) and passed in, so both sides of a comparison skip the same rows
   *  even when the base tree's artifact disagrees. */
  overLimit?: Record<string, number>;
  /** sweep a tree of raw `.s`/`.inc` files instead of dataset rows */
  asmDir?: string;
  /** `--asm-dir` only: which target lifted them */
  toolchain?: string;
  /** `--asm-dir` only: whose symbol map to use for the `harness` arm */
  asmProject?: string;
  /** `--repeat` only: iterate the selection in REVERSE. A pass that carries state between rows
   *  (a module-level cache, a counter, a `Map` keyed by nothing row-specific) disagrees with
   *  itself under reordering and agrees under repetition, so a repeat-only determinism check is
   *  blind to the one class of nondeterminism a corpus driver can actually introduce. */
  reverse?: boolean;
}

const sha = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);
const firstLine = (e: unknown): string =>
  String(e instanceof Error ? e.message : e)
    .split('\n')[0]
    .slice(0, 160);

/** One row's two-arm option sets, built through the harness's own `rankOptionsFor` so the
 *  `harness` arm is BY CONSTRUCTION the configuration `bench run` and `bench fan` measure. The
 *  `nomap` arm is the same call with the symbol map withheld — not a hand-assembled object, which
 *  is how a rig ends up comparing two configurations and calling the difference a code change. */
type Armed = {
  arm: string;
  /** which COMPUTATION this arm asks for. Two arms sharing a key are one lift and one enumeration;
   *  see `record` below for why that is not a shortcut. */
  key: string;
  opts: Record<string, unknown>;
};

/** Everything this driver needs out of the tree under test, loaded by absolute path. */
async function treeModules(root: string) {
  const [synthetic, real, manifests, scrub, evalAsmlift, pipeline, rank, symbols, toolchains] = await Promise.all([
    import(`${root}/apps/benchmark/src/cases/synthetic.ts`),
    import(`${root}/apps/benchmark/src/cases/real.ts`),
    import(`${root}/apps/benchmark/src/cases/manifests.ts`),
    import(`${root}/apps/benchmark/src/asm-scrub.ts`),
    import(`${root}/apps/benchmark/src/eval/asmlift.ts`),
    import(`${root}/packages/core/src/pipeline.ts`),
    import(`${root}/packages/cli/src/rank.ts`),
    import(`${root}/packages/core/src/symbols.ts`),
    import(`${root}/apps/benchmark/src/toolchains.ts`),
  ]);
  return { synthetic, real, manifests, scrub, evalAsmlift, pipeline, rank, symbols, toolchains };
}

/** Recursively, every `.s`/`.inc` under `dir` — the shape the hand rigs used to sweep a project's
 *  `asm/matchings` and `asm/nonmatchings` trees, which are the functions that are NOT rows. */
export function asmFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else if (p.endsWith('.s') || p.endsWith('.inc')) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** The whole sweep of one tree. Records come back in a deterministic order (case order, then arm
 *  order), because `--repeat` compares runs and an order that depends on a scheduler would report
 *  a flake that is the rig's. */
export async function collect(root: string, sel: SweepSelection): Promise<SweepRecord[]> {
  const m = await treeModules(root);
  const out: SweepRecord[] = [];
  const overLimit = sel.overLimit ?? {};

  // ONE COMPUTATION PER DISTINCT CONFIGURATION, one record per selected arm. A row with no symbol
  // map lifts identically in both arms BY CONSTRUCTION — `rankOptionsFor(..., undefined)` is what
  // the `nomap` arm asks for and what a map-less row gets anyway — so computing it twice buys
  // nothing and doubles the only part of this command that is expensive. Measured: the synthetic
  // tier is 810 of the 1,062 rows and almost none of it carries a map, so the naive shape pays
  // `--fan` twice over for most of the corpus. The record is still emitted under BOTH arm names,
  // because a rectangular record set is what makes the comparison's row-set arithmetic readable
  // (and because a row that GAINS a symbol map between two revisions must show as a move in the
  // `harness` arm, not as a record appearing out of nowhere).
  const record = (
    id: string,
    armed: Armed[],
    sym: string,
    asm: string,
    targetDesc: unknown,
    fanAllowed: boolean,
  ): void => {
    const computed = new Map<string, SweepRecord>();
    for (const { arm, key, opts } of armed) {
      const already = computed.get(key);
      if (already !== undefined) {
        out.push({ ...already, arm });
        continue;
      }
      const rec: SweepRecord = { id, arm };
      try {
        const d = m.pipeline.decompile(sym, asm, targetDesc, { ...opts, onGap: 'annotate' });
        rec.src = sha(d.source);
        rec.len = d.source.length;
        rec.diag = d.diagnostics.length;
        rec.marks = (d.source.match(/ASMLIFT_ERROR/g) ?? []).length;
      } catch (e) {
        rec.threw = firstLine(e);
      }
      if (sel.fan) {
        if (!fanAllowed) {
          rec.skipped = 'fan-limit';
        } else {
          try {
            const cands = m.rank.enumerateRanked(sym, asm, targetDesc, { ...opts, onLeverError: () => {} });
            rec.fan = cands.length;
            const h = createHash('sha1');
            for (const c of cands) {
              h.update(`${c.label}\0${c.source}\0`);
            }
            rec.fanHash = h.digest('hex').slice(0, 12);
          } catch (e) {
            rec.fanThrew = firstLine(e);
          }
        }
      }
      computed.set(key, rec);
      out.push(rec);
    }
  };

  if (sel.asmDir !== undefined) {
    // RAW `.s` MODE. No target object, so no `asmData` side table, no prototypes, no candidate
    // compiler — the same disclosure `bench fan --asm` prints, and for the same reason: this
    // count is comparable with another `.s` run of the same file and with itself across two
    // revisions, and NOT with a row's recorded configuration.
    const tc = m.toolchains.TOOLCHAINS[sel.toolchain ?? ''];
    if (tc === undefined) {
      throw new Error(`unknown --toolchain ${JSON.stringify(sel.toolchain)}`);
    }
    const map = sel.asmProject === undefined ? undefined : projectSymbols(m, sel.asmProject);
    const files = asmFilesUnder(sel.asmDir);
    for (const file of sel.reverse === true ? [...files].reverse() : files) {
      const sym = file
        .split('/')
        .pop()!
        .replace(/\.(s|inc)$/, '');
      const asm = m.scrub.scrubObjectHeader(readFileSync(file, 'utf8'));
      const armed: Armed[] = sel.arms.map((arm) => ({
        arm,
        key: arm === 'harness' && map ? 'harness' : 'nomap',
        opts: arm === 'harness' && map ? { symbols: m.symbols.asIfUndecompiled(map, sym) } : {},
      }));
      record(`asm:${relative(sel.asmDir, file)}`, armed, sym, asm, tc.targetDesc, sel.fan === true);
    }
    return out;
  }

  const cases = [
    ...(sel.tiers.includes('synthetic') ? m.synthetic.syntheticCases(sel.only ? { only: sel.only } : {}) : []),
    ...(sel.tiers.includes('real')
      ? m.real.realCases({ ...(sel.only ? { only: sel.only } : {}), ...(sel.project ? { project: sel.project } : {}) })
      : []),
  ];
  for (const c of sel.reverse === true ? [...cases].reverse() : cases) {
    if (!c.toolchain.available()) {
      for (const arm of sel.arms) {
        out.push({ id: c.id, arm, skipped: 'toolchain' });
      }
      continue;
    }
    let built;
    try {
      built = c.build();
    } catch {
      // COUNTED, NOT SWALLOWED, and not fatal: the same discipline `bench gates` states — a census
      // over a truncated prefix must not look complete, and one unbuildable row must not end a
      // 1,062-row sweep.
      for (const arm of sel.arms) {
        out.push({ id: c.id, arm, skipped: 'build' });
      }
      continue;
    }
    const asm = m.scrub.scrubObjectHeader(built.asm);
    const armed: Armed[] = sel.arms.map((arm) => ({
      arm,
      key: arm === 'nomap' || c.symbols === undefined ? 'nomap' : 'harness',
      opts: m.evalAsmlift.rankOptionsFor(
        c.toolchain,
        built.obj,
        c.proto,
        c.compile,
        arm === 'nomap' ? undefined : c.symbols,
      ),
    }));
    const fanAllowed = sel.force === true || overLimit[c.id] === undefined;
    record(c.id, armed, c.sym, asm, c.toolchain.targetDesc, fanAllowed);
  }
  return out;
}

/** The project's WHOLE vendored symbol map, for `--asm-dir --project`.
 *
 *  Off `loadManifests()` and deliberately NOT off a `realCases()` row: every row's `symbols` has
 *  already had that row's own definition stripped (`asIfUndecompiled`, the real tier's
 *  leakage rule), so reusing one row's map for a different symbol silently withholds a
 *  DIFFERENT function's declaration than the one being swept. The stripping is applied per file
 *  at the call site instead, which is the rule the rule exists to state: a function being lifted
 *  does not get to read its own map entry. */
function projectSymbols(m: Awaited<ReturnType<typeof treeModules>>, project: string): unknown {
  const man = m.manifests.loadManifests().find((x: { project: string }) => x.project === project);
  if (man === undefined) {
    throw new Error(`--project ${project}: no such manifest project`);
  }
  if (man.symbols === undefined) {
    throw new Error(`--project ${project}: this project exposes no vendored symbol map`);
  }
  return man.symbols;
}

/** Subprocess entry: `tsx sweep-driver.ts <root> <out.json> <selection.json>`. Used only for the
 *  BASE side; the head side calls `collect` in-process. */
if (process.argv[1] !== undefined && process.argv[1].endsWith('sweep-driver.ts')) {
  const [root, out, selJson] = process.argv.slice(2);
  const records = await collect(root, JSON.parse(selJson) as SweepSelection);
  writeFileSync(out, JSON.stringify(records));
  console.error(`asmlift: [sweep] base tree ${root}: ${records.length} record(s)`);
}
