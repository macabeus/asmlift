// The benchmark scores asmlift THROUGH the same decomp.yaml path a real project uses.
// The configs themselves are COMMITTED as live documentation —
// dataset/toolchains/<id>/decomp.yaml, one per toolchain — with machine locations as
// $ASMLIFT_* placeholders and the codegen flags as `{{cflags}}`. Materializing a config substitutes
// the placeholders through @asmlift/toolchains (the single source of truth for paths, itself
// overridable via the same env names), so machine paths land only in the gitignored .cache / repro
// dirs, never in the tree. The result is loaded with the REAL loader and its compile template,
// with each row's flags in `{{cflags}}`, drives candidate compilation via compileFromCommand.
//
// Deliberate split: the NATIVE toolchains (agbcc, IDO) keep their `tools.asmlift.compiler`
// template — the benchmark then exercises the user-command path on the majority of rows. For
// the DOCKERIZED pair (KMC GCC, mwcc) the harness STRIPS the compiler before loading: their
// configs still load and resolve the target (the same "no compile command" user path), while
// candidate compilation goes to @asmlift/toolchains' own compiler bound at the row's flags — which
// pools Docker containers, an optimization the one-shot `docker run` template cannot express. The
// reproduction scripts (`bench target`) get the command intact on every toolchain.
import { type CandidateCompiler, compileFromCommand, renderCflags } from '@asmlift/cli/compile-command';
import { loadDecompConfig, resolveTarget } from '@asmlift/cli/config';
import { type MatchScore, scoreObjects } from '@asmlift/cli/score';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import {
  GCC272_TOOLCHAIN,
  GCC_KMC_TOOLCHAIN,
  IDO_TOOLCHAIN,
  MWCC_PPC_TOOLCHAIN,
  TOOLCHAIN,
  isMwccToolchainId,
  kmcCandidateCompiler,
  mwccCandidateCompiler,
  mwccDir,
} from '@asmlift/toolchains';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { shq } from './compile/util';
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
};

/** The pooled pair: candidates compile through @asmlift/toolchains' own compiler (long-lived
 *  containers), bound at the row's flags. */
const POOLED: Partial<Record<ToolchainId, (flags: readonly string[]) => CandidateCompiler>> = {
  'gcc2.7.2kmc': kmcCandidateCompiler,
  mwcc_242_81: mwccCandidateCompiler('mwcc_242_81'),
};

/** `"$VAR"` becomes the shell-quoted machine value; a bare `$VAR` substitutes verbatim.
 *  Unknown $ASMLIFT_* names are a loud error — a typo would otherwise reach sh unexpanded. */
function substitutePlaceholders(cmd: string, id: ToolchainId): string {
  return cmd.replace(/"\$(ASMLIFT_[A-Z0-9_]+)"|\$(ASMLIFT_[A-Z0-9_]+)/g, (_, quoted, bare) => {
    const value = placeholderValues(id)[quoted ?? bare];
    if (value === undefined) {
      throw new Error(`unknown placeholder $${quoted ?? bare} in dataset/toolchains/${id}/decomp.yaml`);
    }
    return quoted !== undefined ? shq(value) : value;
  });
}

interface BenchDoc {
  name: string;
  platform: string;
  tools: { asmlift: { target: string; compiler?: string; elf?: string; symbols?: string } };
}

/** The committed config for one toolchain, with placeholders materialized. Its command takes the
 *  codegen flags through `{{cflags}}`, because every row compiles at its own. */
function benchDoc(id: ToolchainId, name: string): BenchDoc {
  const doc = YAML.parse(readFileSync(join(DATASET_DIR, id, 'decomp.yaml'), 'utf8')) as BenchDoc;
  if (
    doc.tools?.asmlift?.target !== id ||
    typeof doc.tools.asmlift.compiler !== 'string' ||
    !doc.tools.asmlift.compiler.includes('{{cflags}}')
  ) {
    throw new Error(
      `dataset/toolchains/${id}/decomp.yaml must declare tools.asmlift.{target: ${id}, compiler} with {{cflags}}`,
    );
  }
  doc.name = name;
  doc.tools.asmlift.compiler = substitutePlaceholders(doc.tools.asmlift.compiler, id);
  return doc;
}

/** The materialized candidate-compile command at `cflags` — exported for the parity test. */
export function renderScoreCommand(id: ToolchainId, cflags: readonly string[]): string {
  return renderCflags(benchDoc(id, `asmlift benchmark (${id})`).tools.asmlift.compiler!, cflags);
}

const memo = new Map<string, CandidateCompiler>();

/** The candidate compiler for a benchmark toolchain at one flag set, built through the real user
 *  path: materialize the committed decomp.yaml → loadDecompConfig → resolveTarget (asserted) →
 *  compileFromCommand, with `cflags` filling the command's `{{cflags}}`. The pooled (dockerized)
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
  if (pooled !== undefined) {
    delete doc.tools.asmlift.compiler;
  }
  const dir = join(CONFIG_ROOT, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'decomp.yaml');
  // Atomic write: parallel bench workers may generate concurrently; rename prevents torn reads.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, YAML.stringify(doc));
  renameSync(tmp, file);

  const loaded = loadDecompConfig(file);
  const res = resolveTarget(undefined, loaded);
  if ('error' in res || res.targetKey !== id) {
    throw new Error(`benchmark decomp.yaml for ${id} did not resolve to ${id}: ${JSON.stringify(res)}`);
  }
  const toolCfg = loaded!.config.tools!.asmlift!;
  const compile = pooled !== undefined ? pooled(cflags) : compileFromCommand(toolCfg.compiler!, { cwd: dir, cflags });
  memo.set(memoKey, compile);
  return compile;
}

/** A benchmark Scorer at one flag set: compile through `benchCompilerFor`, objdiff against the target. */
export function benchScorer(
  id: ToolchainId,
  cflags: readonly string[],
): (candC: string, sym: string, obj: string, declarations?: string) => MatchScore {
  const compile = benchCompilerFor(id, cflags);
  // `declarations` reaches the compiler's own prelude slot, never the front of the source: the
  // prelude already emits C_TYPEDEFS, and a concatenated copy redefines `s16`/`s32`.
  return (candC, sym, obj, declarations) => scoreObjects(obj, compile(candC, sym, 'c', declarations), sym);
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
}

/** Write `<dir>/decomp.yaml` for one toolchain with the candidate-compile command intact on
 *  EVERY toolchain (one-shot docker for the pooled pair) — the config `bench target` hands the
 *  reproduction scripts so `asmlift --config decomp.yaml --score-against` can compile with
 *  the benchmark's own toolchain. The command spells the row's `cflags`, which the CLI reads off
 *  it. `elf` (absolute path — symbol-fed rows) lands as tools.asmlift.elf so the CLI loads the
 *  project's symbol map exactly as the benchmark did.
 *
 *  Nothing here decides whether a reproduction CACHES. The candidate-object cache needs no
 *  per-project declaration — everything the command reads is measured — and it is on by default,
 *  so a reader running one of these scripts gets the same store the harness does unless they say
 *  ASMLIFT_CANDCACHE=0. Sound either way: a cache changes throughput and never a result, so a miss is
 *  indistinguishable in RESULT from no cache at all. */
export function writeScoreConfig(
  id: ToolchainId,
  cflags: readonly string[],
  dir: string,
  { elf, ctxFile, symbolsFile, language }: ScoreConfigParts = {},
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
  doc.tools.asmlift.compiler = renderCflags(
    doc.tools.asmlift.compiler!,
    TOOLCHAIN_TARGETS[id].family === 'mwcc' ? [...cflags, `-lang=${language ?? 'c'}`] : cflags,
  );
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
