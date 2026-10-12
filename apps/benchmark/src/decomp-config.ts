// The benchmark scores asmlift THROUGH the same decomp.yaml path a real project uses.
// The configs themselves are COMMITTED as live documentation —
// dataset/toolchains/<id>/decomp.yaml, one per toolchain — with machine locations as
// $ASMLIFT_* placeholders and the codegen flags as `{{flags}}`. Materializing a config substitutes
// the placeholders through @asmlift/toolchains (the single source of truth for paths, itself
// overridable via the same env names), so machine paths land only in the gitignored .cache / repro
// dirs, never in the tree. The result is loaded with the REAL loader and its compile template,
// with each row's flags in `{{flags}}`, drives candidate compilation via compileFromCommand.
//
// Deliberate split: the NATIVE toolchains (agbcc, IDO) keep their `tools.asmlift.compiler`
// template — the benchmark then exercises the user-command path on the majority of rows. For
// the DOCKERIZED pair (KMC GCC, mwcc) the harness STRIPS the compiler before loading: their
// configs still load and resolve the target (the same "no compile command" user path), while
// candidate compilation goes to @asmlift/toolchains' own compiler bound at the row's flags — which
// pools Docker containers, an optimization the one-shot `docker run` template cannot express, or
// runs the compiler natively where the host can (@asmlift/toolchains' native.ts). The other three
// dockerized toolchains (GCC 2.7.2 and two CodeWarrior builds) keep the user-command path, and on a
// host that runs their 32-bit binaries natively that command is the toolchain's entry in
// dataset/toolchains/native-commands.yaml instead of the committed `docker run` one: the same
// compiler and words over host paths, so the same code, at the cost of one process instead of one
// container per candidate. The reproduction scripts (`bench target`) get the committed command
// intact on every toolchain.
import { type BenchCommand, benchCommand, renderBenchPlaceholders } from '@asmlift/cli/candcache-bench';
import { type CandidateCompiler, compileFromCommand } from '@asmlift/cli/compile-command';
import { asmliftBlock, resolveTarget } from '@asmlift/cli/config';
import { type MatchScore, scoreObjects } from '@asmlift/cli/score';
import { C_TYPEDEFS, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  GCC272_TOOLCHAIN,
  GCC_KMC_TOOLCHAIN,
  IDO_TOOLCHAIN,
  KMC_REPORT_FLAGS,
  MWCC_PPC_TOOLCHAIN,
  TOOLCHAIN,
  compileCandKmcReported,
  compileCandPpc,
  gcc272Native,
  isMwccToolchainId,
  kmcCandidateCompiler,
  kmcNative,
  kmcPoolCfg,
  mwccCandidateCompiler,
  mwccDir,
  mwccNative,
  ppcPoolCfg,
} from '@asmlift/toolchains';
import { createRunner } from '@match-kit/compiler';
import { loadDecompYaml } from '@match-kit/decomp-yaml/files';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';
import YAML from 'yaml';

import {
  DOCKER_COMPILE_SOURCES,
  type DockerCacheSpec,
  GCC_MIPS_HOST_SPECS,
  dockerCachedBy,
  gccRefused,
  mwccRefused,
} from './compile/docker-cache';
import type { ToolchainId } from './toolchains';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = join(SRC_DIR, '..', 'dataset', 'toolchains');
const CONFIG_ROOT = join(SRC_DIR, '..', '.cache', 'decomp-configs');

/** Machine locations for the $ASMLIFT_* placeholders in the committed configs — resolved through
 *  @asmlift/toolchains, which honors each of the names below as an env override, with ONE
 *  exception.
 *
 *  `$ASMLIFT_MWCC_DIR` is that exception, and it is not a machine location at all: it is per
 *  TOOLCHAIN. The three CodeWarrior configs are the same command over three different compiler
 *  directories, and which directory is mounted is the whole difference between them — so this one
 *  is computed, `mwccDir(id)`, under the machine's `$ASMLIFT_MWCC_ROOT`. Exporting
 *  `ASMLIFT_MWCC_DIR` moves nothing here (it remains what a user's own shell expands in the
 *  command this file renders for them); `ASMLIFT_MWCC_ROOT` is the knob. */
const placeholderValues = (id: ToolchainId): Record<string, string> => ({
  ...PLACEHOLDER_VALUES,
  ...(isMwccToolchainId(id) ? { ASMLIFT_MWCC_DIR: mwccDir(id) } : {}),
});

const PLACEHOLDER_VALUES: Record<string, string> = {
  ASMLIFT_AGBCC: TOOLCHAIN.agbcc,
  ASMLIFT_ARM_AS: TOOLCHAIN.as,
  ASMLIFT_IDO_CC: IDO_TOOLCHAIN.cc,
  ASMLIFT_GCC272_DIR: GCC272_TOOLCHAIN.dir,
  ASMLIFT_GCC272_IMAGE: GCC272_TOOLCHAIN.image,
  ASMLIFT_DOCKER: GCC_KMC_TOOLCHAIN.docker,
  ASMLIFT_KMC_DIR: GCC_KMC_TOOLCHAIN.dir,
  ASMLIFT_KMC_IMAGE: GCC_KMC_TOOLCHAIN.image,
  ASMLIFT_PPC_IMAGE: MWCC_PPC_TOOLCHAIN.image,
  ASMLIFT_WIBO: MWCC_PPC_TOOLCHAIN.wibo,
  ASMLIFT_NATIVE_WIBO: MWCC_PPC_TOOLCHAIN.nativeWibo,
};

/** Whether this host runs a toolchain natively, for each toolchain that has a native command. */
const NATIVE: Partial<Record<ToolchainId, () => boolean>> = {
  'gcc2.7.2': gcc272Native,
  mwcc_233_163n: () => mwccNative('mwcc_233_163n'),
  mwcc_247_107: () => mwccNative('mwcc_247_107'),
};

/** What decides the command a toolchain's candidates compile with: whether the host runs the
 *  toolchain natively, and the value of each `$ASMLIFT_*` placeholder. */
export interface BenchHost {
  native: (id: ToolchainId) => boolean;
  placeholders: (id: ToolchainId) => Record<string, string>;
}

const THIS_HOST: BenchHost = { native: (id) => NATIVE[id]?.() ?? false, placeholders: placeholderValues };

/** The command `id`'s candidates compile with on `host`, placeholders rendered, and the name the
 *  candidate store knows it by: the toolchain's native command where the host runs it natively,
 *  else its committed decomp.yaml command. */
export function benchCommandFor(
  id: ToolchainId,
  host: BenchHost = THIS_HOST,
): { command: string; bench: BenchCommand } {
  const bench: BenchCommand = {
    toolchain: id,
    placeholders: host.placeholders(id),
    ...(host.native(id) ? { native: true } : {}),
  };
  try {
    return { command: benchCommand(bench), bench };
  } catch (e) {
    throw new Error(`${(e as Error).message} (dataset/toolchains)`);
  }
}

/** The pooled pair's C compiles behind the candidate store, keyed as compile/docker-cache.ts says.
 *  A Pascal candidate goes straight to the toolchain's own compiler, which refuses it. KMC GCC's
 *  own preprocessor reports what it read; CodeWarrior's reports nothing, so its TU's text is read. */
export const pooledKmcSpec = (flags: readonly string[]): DockerCacheSpec => ({
  label: 'bench-pooled-kmc',
  native: kmcNative,
  docker: GCC_KMC_TOOLCHAIN.docker,
  image: GCC_KMC_TOOLCHAIN.image,
  pool: kmcPoolCfg().name,
  dirs: [GCC_KMC_TOOLCHAIN.dir],
  words: [...GCC_KMC_TOOLCHAIN.harnessFlags, ...flags, ...KMC_REPORT_FLAGS],
  prelude: C_TYPEDEFS,
  hostCommands: [],
  sources: DOCKER_COMPILE_SOURCES,
  hostFiles: GCC_MIPS_HOST_SPECS,
  refused: gccRefused,
  gnuAs: true,
});
export const pooledMwccSpec = (flags: readonly string[]): DockerCacheSpec => ({
  label: 'bench-pooled-mwcc_242_81',
  native: () => mwccNative('mwcc_242_81'),
  docker: MWCC_PPC_TOOLCHAIN.docker,
  image: MWCC_PPC_TOOLCHAIN.image,
  pool: ppcPoolCfg('mwcc_242_81').name,
  dirs: [mwccDir('mwcc_242_81')],
  words: [MWCC_PPC_TOOLCHAIN.wibo, ...MWCC_PPC_TOOLCHAIN.harnessFlags, ...flags],
  prelude: C_TYPEDEFS,
  hostCommands: mwccNative('mwcc_242_81') ? [MWCC_PPC_TOOLCHAIN.nativeWibo] : [],
  sources: DOCKER_COMPILE_SOURCES,
  hostFiles: [],
  refused: mwccRefused,
  gnuAs: false,
});
const pooledKmc = dockerCachedBy(pooledKmcSpec, (flags: readonly string[]) => (tu, _sym, seen) => {
  const { obj, report } = compileCandKmcReported(tu, flags);
  seen.report = report;
  return obj;
});
const pooledMwcc = dockerCachedBy(
  pooledMwccSpec,
  (flags: readonly string[]) => (tu) => compileCandPpc('mwcc_242_81', tu, flags),
);
const cachedPooled =
  (
    uncached: (flags: readonly string[]) => CandidateCompiler,
    cached: (flags: readonly string[]) => (tu: string, sym: string) => string,
  ) =>
  (flags: readonly string[]): CandidateCompiler => {
    const pascal = uncached(flags);
    return async (source, symbol, backendId, declarations) =>
      backendId === 'pascal' ? pascal(source, symbol, backendId, declarations) : cached(flags)(source, symbol);
  };

/** The pooled pair: candidates compile through @asmlift/toolchains' own compiler (long-lived
 *  containers), bound at the row's flags. */
const POOLED: Partial<Record<ToolchainId, (flags: readonly string[]) => CandidateCompiler>> = {
  'gcc2.7.2kmc': cachedPooled(kmcCandidateCompiler, pooledKmc),
  mwcc_242_81: cachedPooled(mwccCandidateCompiler('mwcc_242_81'), pooledMwcc),
};

/** `"$VAR"` becomes the shell-quoted machine value; a bare `$VAR` substitutes verbatim — the rendering
 *  the candidate store matches a command against (@asmlift/cli/candcache-bench). Unknown $ASMLIFT_*
 *  names are a loud error — a typo would otherwise reach sh unexpanded. */
function substitutePlaceholders(cmd: string, id: ToolchainId): string {
  try {
    return renderBenchPlaceholders(cmd, placeholderValues(id));
  } catch (e) {
    throw new Error(`${(e as Error).message} in dataset/toolchains/${id}/decomp.yaml`);
  }
}

interface BenchDoc {
  name: string;
  platform: string;
  tools: { asmlift: { target: string; compiler?: string; elf?: string; symbols?: string } };
}

/** The committed config for one toolchain, with placeholders materialized. Its command takes the
 *  codegen flags through `{{flags}}`, because every row compiles at its own. */
function benchDoc(id: ToolchainId, name: string): BenchDoc {
  const doc = YAML.parse(readFileSync(join(DATASET_DIR, id, 'decomp.yaml'), 'utf8')) as BenchDoc;
  if (
    doc.tools?.asmlift?.target !== id ||
    typeof doc.tools.asmlift.compiler !== 'string' ||
    !doc.tools.asmlift.compiler.includes('{{flags}}')
  ) {
    throw new Error(
      `dataset/toolchains/${id}/decomp.yaml must declare tools.asmlift.{target: ${id}, compiler} with {{flags}}`,
    );
  }
  doc.name = name;
  doc.tools.asmlift.compiler = substitutePlaceholders(doc.tools.asmlift.compiler, id);
  return doc;
}

/** The materialized candidate-compile command at `cflags` — exported for the parity test. */
export function renderScoreCommand(id: ToolchainId, cflags: readonly string[]): string {
  return createRunner(benchDoc(id, `asmlift benchmark (${id})`).tools.asmlift.compiler!, { flags: cflags }).command;
}

const memo = new Map<string, CandidateCompiler>();

/** The candidate compiler for a benchmark toolchain at one flag set, built through the real user
 *  path: materialize the committed decomp.yaml → loadDecompYaml → resolveTarget (asserted) →
 *  compileFromCommand, with `cflags` filling the command's `{{flags}}`. The pooled (dockerized)
 *  targets' command is stripped, and their candidates compile through @asmlift/toolchains at
 *  `cflags`. One config and one working directory per toolchain: the flags reach the command
 *  namespace through the rendered command. */
export function benchCompilerFor(id: ToolchainId, cflags: readonly string[]): CandidateCompiler {
  const memoKey = `${id}\0${JSON.stringify(cflags)}`;
  const known = memo.get(memoKey);
  if (known !== undefined) {
    return known;
  }

  const pooled = POOLED[id];
  const doc = benchDoc(id, `asmlift benchmark (${id})`);
  const scored = pooled === undefined ? benchCommandFor(id) : undefined;
  if (scored === undefined) {
    delete doc.tools.asmlift.compiler;
  } else {
    doc.tools.asmlift.compiler = scored.command;
  }
  const dir = join(CONFIG_ROOT, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'decomp.yaml');
  // Atomic write: parallel bench workers — processes, and a row's compile threads within one — may
  // generate concurrently; rename prevents torn reads, and a temp file per thread keeps one writer's
  // rename from taking another's.
  const tmp = `${file}.${process.pid}-${threadId}.tmp`;
  writeFileSync(tmp, YAML.stringify(doc));
  renameSync(tmp, file);

  const loaded = loadDecompYaml(file);
  const toolCfg = asmliftBlock(loaded)!;
  const res = resolveTarget(undefined, loaded, toolCfg);
  if ('error' in res || res.targetKey !== id) {
    throw new Error(`benchmark decomp.yaml for ${id} did not resolve to ${id}: ${JSON.stringify(res)}`);
  }
  // The command names itself to the candidate store, which keys no command but the benchmark's own.
  const compile =
    pooled !== undefined
      ? pooled(cflags)
      : compileFromCommand(toolCfg.compiler!, { cwd: dir, cflags, bench: scored!.bench });
  memo.set(memoKey, compile);
  return compile;
}

/** A benchmark Scorer at one flag set: compile through `benchCompilerFor`, objdiff against the target. */
export function benchScorer(
  id: ToolchainId,
  cflags: readonly string[],
): (candC: string, sym: string, obj: string, declarations?: string) => Promise<MatchScore> {
  const compile = benchCompilerFor(id, cflags);
  // `declarations` reaches the compiler's own prelude slot, never the front of the source: the
  // prelude already emits C_TYPEDEFS, and a concatenated copy redefines `s16`/`s32`.
  return async (candC, sym, obj, declarations) => scoreObjects(obj, await compile(candC, sym, 'c', declarations), sym);
}

/** What a reproduction config carries beyond its toolchain and flags: the project's symbol-map ELF
 *  or its authored map, the materialized scoring context, and the row's language. */
export interface ScoreConfigParts {
  elf?: string; // absolute path — symbol-fed rows
  ctxFile?: string; // basename of the materialized scoring context (materializeScoringContext)
  symbolsFile?: string; // basename of an authored symbol map, where no ELF backs it
  // The dialect the CANDIDATE is compiled in — not the one the target was built in. `c++` is
  // legal only alongside a `ctxFile`, the one place the linkage block a C++ candidate needs can
  // be written; absent ⇒ C.
  language?: 'c' | 'c++';
  // The dialect the UNIT is compiled in, which is the `-lang` the command states — it is what the
  // CLI reads its emission dialect from. A C++ unit's candidate scored as C states `-lang=c++` and is
  // compiled as C by a `#pragma cplusplus off` opening its scoring context (`bench target`); absent ⇒
  // `language`.
  unitLanguage?: 'c' | 'c++';
}

/** Write `<dir>/decomp.yaml` for one toolchain with the candidate-compile command intact on
 *  EVERY toolchain (one-shot docker for the pooled pair) — the config `bench target` hands the
 *  reproduction scripts so `asmlift --config decomp.yaml --score-against` can compile with
 *  the benchmark's own toolchain. The command spells the row's `cflags`, which the CLI reads off
 *  it. `elf` (absolute path — symbol-fed rows) lands as tools.asmlift.elf so the CLI loads the
 *  project's symbol map exactly as the benchmark did.
 *
 *  A reproduction compiles every candidate: the CLI keys no command a `decomp.yaml` hands it (the
 *  candidate store keys only the benchmark's own, @asmlift/cli/candcache-bench). A cache changes
 *  throughput and never a result, so this costs a reader time and nothing else. */
export function writeScoreConfig(
  id: ToolchainId,
  cflags: readonly string[],
  dir: string,
  { elf, ctxFile, symbolsFile, language, unitLanguage }: ScoreConfigParts = {},
): void {
  const doc = benchDoc(id, `asmlift benchmark repro (${id})`);
  // `-lang=c++` without a context file is a config that cannot work: the linkage block lives in the
  // `cat` the context file builds, and without it the C++ front end mangles the candidate a second
  // time and the scorer finds no symbol to align. Refuse it here rather than write a repro that
  // fails with "symbol not found" in the reader's hands.
  if (language === 'c++' && !ctxFile) {
    throw new Error(`${id}: a C++ candidate needs a scoring context to carry its linkage block`);
  }
  // A CodeWarrior row's DIALECT is stated in the command, exactly as compile/mwcc.ts states it for
  // the harness's own compiles and for the same reason: the reproduction writes its candidate to a
  // `.c` path, so an unstated `-lang` would read a C++ row's candidate with the C front end and
  // export an unmangled symbol the target has none of.
  doc.tools.asmlift.compiler = createRunner(doc.tools.asmlift.compiler!, {
    flags: TOOLCHAIN_TARGETS[id].family === 'mwcc' ? [...cflags, `-lang=${unitLanguage ?? language ?? 'c'}`] : cflags,
  }).command;
  if (elf) {
    doc.tools.asmlift.elf = elf;
  }
  // A row whose map has no ELF behind it — the synthetic tier's hand-written maps. `bench
  // target` writes the map itself next to target.o and names it here, so the reproduction feeds
  // the CLI the SAME map the harness fed the row rather than running map-less and answering a
  // different question. Never both: the CLI refuses a config declaring two map sources.
  if (symbolsFile) {
    doc.tools.asmlift.symbols = symbolsFile;
  }
  if (ctxFile) {
    // REAL rows are scored INSIDE the escalation rung compile/real.ts stopped at for this row
    // (usually the project's vendored context) — the same world m2c is scored in. Wrap the
    // toolchain's own command so every
    // candidate is concatenated after that context: the reproduction grades where the
    // benchmark graded. The CLI's prelude probe sees a context-injecting template and drops
    // its typedefs + synthesized declarations on its own, so no flag says any of this.
    //
    // A C++ row's candidate is enclosed in the SAME linkage block the scorer compiles it in
    // (compile/real.ts's candidateLinkage), because its target is keyed by a mangled symbol and a
    // C-shaped candidate mangles a second time without it. The block cannot live in `ctx.i`: it
    // has to close AFTER the candidate, and the context is a C++ translation unit that must stay
    // outside it.
    const cat =
      language === 'c++'
        ? `{ cat ${ctxFile}; echo 'extern "C" {'; cat {{inputPath}}; echo '}'; }`
        : `cat ${ctxFile} {{inputPath}}`;
    doc.tools.asmlift.compiler =
      `${cat} > {{inputPath}}.ctx.c && ` +
      doc.tools.asmlift.compiler.replaceAll('{{inputPath}}', '{{inputPath}}.ctx.c');
  }
  writeFileSync(join(dir, 'decomp.yaml'), YAML.stringify(doc));
}

/** Materialize one real row's scoring context as `<dir>/ctx.i` (returns its basename, the name
 *  the generated compile command concatenates ahead of every candidate).
 *
 *  `prelude` is a rung of compile/real.ts's escalation ladder — the ONE the harness actually
 *  scored this row's source in (compile/real.ts's resolveScoringPrelude picks it). It is not
 *  always the richest: a project context can REJECT what bare typedefs accept, and materializing
 *  the vendored context for such a row leaves the script with no scorable candidate at all. */
export function materializeScoringContext(prelude: string, dir: string): string {
  writeFileSync(join(dir, 'ctx.i'), prelude);
  return 'ctx.i';
}
