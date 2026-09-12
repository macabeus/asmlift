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

/** Serialization of ONE `Map`/`Set`/typed array, cached on the container's identity.
 *
 *  WHY: a project's vendored symbol map is ONE object shared by all 42 of that project's rows —
 *  1,784 entries for kleod, 41,016 for pokeemerald — and the sweep digests it once per row per arm.
 *  A/B'd on the real tier's 504 records, two runs each: a plain `JSON.stringify` digest is
 *  31.7 / 31.9 s, serializing the containers every time is 43.7 / 43.6 s (+37%), and caching on
 *  identity is 35.2 / 35.0 s (+10%) and catches the same perturbations, because the expensive
 *  containers are dataset-owned and shared. The cache buys back 8.5 s of the 11.9 s the correctness
 *  costs.
 *
 *  THE ASSUMPTION, said out loud: a container is not MUTATED between two digests of it inside one
 *  sweep process. The corpus is built once per process and `rankOptionsFor` only reads it; a
 *  producer that mutated a symbol map in place mid-sweep would be reported as unchanged here (and
 *  would already break `--repeat`, which exists to catch exactly that class). */
const serialized = new WeakMap<object, string>();

/** A canonical string for an option value: object keys sorted at every depth, `Map` entries sorted,
 *  `Set` members sorted, bytes hashed.
 *
 *  NOT `JSON.stringify`, and this was a MEASURED defect in the first shape of this digest.
 *  `JSON.stringify(new Map(...))` is `{}` and `JSON.stringify(new Set(...))` is `{}` — so the two
 *  options that carry the real tier's whole vendored input digested the same no matter what was in
 *  them: `SymbolMap = Map<number, SymbolInfo[]>` (`opts.symbols`) and `AsmData`'s `sections`/
 *  `symbols` maps. Renaming all 1,784 symbols in `dataset/real/tu/kleod/symbols.json.gz` and no
 *  line of `packages/` then moved 25 records reading `src`/`len` ALONE — verbatim the sentence
 *  these two fields were added to prevent, on the tier both round command files point this command
 *  at. A typed array survived `JSON.stringify` as an index object, which is visible but pays a
 *  megabyte of string per `.rodata` section; it is hashed instead.
 *
 *  Cycles are marked rather than followed (a hang here would be worse than a collision) and a value
 *  that contains one is not cached, since its rendering depends on where the walk entered it. */
const canon = (v: unknown, seen: Set<object>): string => {
  if (typeof v === 'function') {
    return '"fn"';
  }
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v) ?? 'undefined';
  }
  const o = v as object;
  const memo = serialized.get(o);
  if (memo !== undefined) {
    return memo;
  }
  if (seen.has(o)) {
    return '"[cycle]"';
  }
  seen.add(o);
  let out: string;
  if (ArrayBuffer.isView(o)) {
    const b = o as ArrayBufferView;
    const bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    out = `bytes(${b.byteLength}):${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}`;
  } else if (Array.isArray(o)) {
    out = `[${o.map((x) => canon(x, seen)).join(',')}]`;
  } else if (o instanceof Map) {
    // SORTED, because a `Map` preserves insertion order and insertion order is a property of the
    // loader, not of the map's contents: `--repeat` and a base/head pair must agree.
    out = `Map{${[...o]
      .map(([k, val]) => `${canon(k, seen)}:${canon(val, seen)}`)
      .sort()
      .join(',')}}`;
  } else if (o instanceof Set) {
    out = `Set{${[...o]
      .map((x) => canon(x, seen))
      .sort()
      .join(',')}}`;
  } else {
    out = `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((o as Record<string, unknown>)[k], seen)}`)
      .join(',')}}`;
  }
  seen.delete(o);
  const cyclic = out.includes('"[cycle]"');
  if (out.length > 256) {
    out = `#${createHash('sha1').update(out).digest('hex').slice(0, 16)}`;
  }
  if (!cyclic) {
    serialized.set(o, out);
  }
  return out;
};

/** The canonical rendering of one option value. Exported for the test that pins the `Map` case. */
export const stable = (v: unknown): string => canon(v, new Set());

/** A digest of the OPTION OBJECT this arm was lifted with — `rankOptionsFor`'s result, which
 *  carries the row's prototypes, its `asmData` side table, its symbol map and whether a candidate
 *  compiler was attached.
 *
 *  WHY THE RECORD CARRIES IT. `collect` loads the tree under test's OWN dataset and harness, so the
 *  base side lifts the BASE tree's rows with the BASE tree's options. A row whose INPUT moved under
 *  a stable id — an authored `src` edit, a re-vendored TU, a changed `proto` — therefore produces a
 *  moved `src` that reads as a decompiler change and is not one. Measured on this branch: editing
 *  one string in `dataset/synthetic.ts` and no line of `packages/` moved 6 records. `asm` and
 *  `opts` are what make that readable — a `[moved]` line naming them says the INPUT moved, and a
 *  line naming `src` alone says the decompiler did. This is the field `report/diff.ts` watches per
 *  side for the same reason (MEMORY #112/#113: label unchanged while the program changed).
 *
 *  WHAT IT CAN SEE is decided entirely by `canon` above — a container it cannot render inside
 *  digests the same whatever it holds, so read that header before trusting this digest with a new
 *  option shape. */
export function optsDigest(opts: Record<string, unknown>): string {
  const seen = new Set<object>();
  return sha(
    Object.keys(opts)
      .sort()
      .map((k) => `${k}=${typeof opts[k] === 'function' ? 'fn' : canon(opts[k], seen)}`)
      .join('\0'),
  );
}

/** One row's two-arm option sets, built through the harness's own `rankOptionsFor` so the
 *  `harness` arm is BY CONSTRUCTION the configuration `bench run` and `bench fan` measure. The
 *  `nomap` arm is the same call with the symbol map withheld — not a hand-assembled object, which
 *  is how a rig ends up comparing two configurations and calling the difference a code change. */
export type Armed = {
  arm: string;
  /** which COMPUTATION this arm asks for. Two arms sharing a key are one lift and one enumeration;
   *  see `record` below for why that is not a shortcut. */
  key: string;
  opts: Record<string, unknown>;
};

/** The arms, as the one table both populations read. */
export const ARMS = ['harness', 'nomap'] as const;

/** Which computation each selected arm asks for, and the options that compute it.
 *
 *  ONE FUNCTION AND NOT TWO SPELLINGS OF THE RULE, because the rule is the command's whole point
 *  and it was written out at three sites: the `harness` arm only differs from `nomap` when the row
 *  HAS a symbol map, so a map-less row is one computation reported under both names (rectangular
 *  record set, and a row that GAINS a map between two revisions then shows as a move in the
 *  `harness` arm rather than as a record appearing out of nowhere).
 *
 *  ABLATED, which is why it is exported and pinned: collapsing this to `key: 'nomap'` makes the
 *  sweep blind to every symbol-map change — half of what the two arms exist for, and the half that
 *  covers most naming and global-recovery work. Nothing else in `apps/benchmark/test` fails on that
 *  edit; the one test that does is `sweep.test.ts`'s, so keep the ablation in mind before relaxing
 *  it (`const key = 'nomap'` → 1 failed of 1,152, 2026-09-12). `optsFor` is called once per
 *  distinct computation, never once per arm. */
export function armsFor(
  arms: readonly string[],
  hasMap: boolean,
  optsFor: (withMap: boolean) => Record<string, unknown>,
): Armed[] {
  const computed = new Map<string, Record<string, unknown>>();
  return arms.map((arm) => {
    const key = arm === 'harness' && hasMap ? 'harness' : 'nomap';
    let opts = computed.get(key);
    if (opts === undefined) {
      opts = optsFor(key === 'harness');
      computed.set(key, opts);
    }
    return { arm, key, opts };
  });
}

/** Everything this driver needs out of the tree under test, in load order — and the list `sweep.ts`
 *  checks a base tree against BEFORE spawning, so a revision older than one of these refuses with a
 *  sentence instead of an `ERR_MODULE_NOT_FOUND` stack out of `tsx`'s resolver. These are the
 *  harness's internals and they move: the newest by creation date is `asm-scrub.ts` (85f81116,
 *  2026-09-09), which is therefore the floor `--base` reaches. */
export const TREE_MODULES = [
  'apps/benchmark/src/cases/synthetic.ts',
  'apps/benchmark/src/cases/real.ts',
  'apps/benchmark/src/cases/manifests.ts',
  'apps/benchmark/src/asm-scrub.ts',
  'apps/benchmark/src/eval/asmlift.ts',
  'packages/core/src/pipeline.ts',
  'packages/cli/src/rank.ts',
  'packages/core/src/symbols.ts',
  'apps/benchmark/src/toolchains.ts',
] as const;

/** Everything this driver needs out of the tree under test, loaded by absolute path. */
async function treeModules(root: string) {
  const [synthetic, real, manifests, scrub, evalAsmlift, pipeline, rank, symbols, toolchains] = await Promise.all(
    TREE_MODULES.map((p) => import(`${root}/${p}`)),
  );
  return { synthetic, real, manifests, scrub, evalAsmlift, pipeline, rank, symbols, toolchains };
}

/** Recursively, every `.s`/`.inc` under `dir` — the shape that sweeps a project's `asm/matchings`
 *  and `asm/nonmatchings` trees, which are the functions that are NOT rows. */
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
      // THE INPUTS, recorded beside the output: what was lifted (`asm`) and with which options
      // (`opts`). Without them a dataset edit is indistinguishable from a decompiler change — see
      // `optsDigest`'s header for the measurement.
      const rec: SweepRecord = { id, arm, asm: sha(asm), opts: optsDigest(opts) };
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
      const armed = armsFor(sel.arms, map !== undefined, (withMap) =>
        withMap ? { symbols: m.symbols.asIfUndecompiled(map, sym) } : {},
      );
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
    const armed = armsFor(sel.arms, c.symbols !== undefined, (withMap) =>
      m.evalAsmlift.rankOptionsFor(c.toolchain, built.obj, c.proto, c.compile, withMap ? c.symbols : undefined),
    );
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
