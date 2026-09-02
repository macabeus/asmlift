// The benchmark scores asmlift THROUGH the same decomp.yaml path a real project uses.
// The configs themselves are COMMITTED as live documentation —
// dataset/toolchains/<id>/decomp.yaml, one per toolchain — with machine locations as
// $ASMLIFT_* placeholders. Materializing a config substitutes those through
// @asmlift/toolchains (the single source of truth for paths, itself overridable via the same
// env names), so machine paths land only in the gitignored .cache / repro dirs, never in the
// tree. The result is loaded with the REAL loader and its compile template drives candidate
// compilation via compileFromCommand.
//
// Deliberate split: the NATIVE toolchains (agbcc, IDO) keep their `tools.asmlift.compiler`
// template — the benchmark then exercises the user-command path on the majority of rows. For
// the DOCKERIZED pair (KMC GCC, mwcc) the harness STRIPS the compiler before loading: their
// configs still load and resolve the target (the same "no compile command" user path), while
// candidate compilation falls to the built-in registry — which pools Docker containers, an
// optimization the one-shot `docker run` template cannot express. The reproduction scripts
// (`bench target`) get the command intact on every toolchain.
import { type CandidateCompiler, compileFromCommand } from '@asmlift/cli/compile-command';
import { loadDecompConfig, resolveTarget } from '@asmlift/cli/config';
import { type MatchScore, scoreObjects } from '@asmlift/cli/score';
import { GCC272_TOOLCHAIN, GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN } from '@asmlift/toolchains';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { shq } from './compile/util';
import type { ToolchainId } from './toolchains';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = join(SRC_DIR, '..', 'dataset', 'toolchains');
const CONFIG_ROOT = join(SRC_DIR, '..', '.cache', 'decomp-configs');

/** Machine locations for the $ASMLIFT_* placeholders in the committed configs — resolved
 *  through @asmlift/toolchains, which honors these exact names as env overrides. */
const PLACEHOLDER_VALUES: Record<string, string> = {
  ASMLIFT_AGBCC: TOOLCHAIN.agbcc,
  ASMLIFT_ARM_AS: TOOLCHAIN.as,
  ASMLIFT_IDO_CC: IDO_TOOLCHAIN.cc,
  ASMLIFT_GCC272_DIR: GCC272_TOOLCHAIN.dir,
  ASMLIFT_GCC272_IMAGE: GCC272_TOOLCHAIN.image,
  ASMLIFT_DOCKER: GCC_KMC_TOOLCHAIN.docker,
  ASMLIFT_KMC_DIR: GCC_KMC_TOOLCHAIN.dir,
  ASMLIFT_KMC_IMAGE: GCC_KMC_TOOLCHAIN.image,
  ASMLIFT_MWCC_DIR: MWCC_PPC_TOOLCHAIN.dir,
  ASMLIFT_PPC_IMAGE: MWCC_PPC_TOOLCHAIN.image,
  ASMLIFT_WIBO: MWCC_PPC_TOOLCHAIN.wibo,
};

/** The pooled pair: scoring compiles through the built-in registry (long-lived containers). */
const POOLED: ReadonlySet<ToolchainId> = new Set(['gcc2.7.2kmc', 'mwcc_242_81']);

/** `"$VAR"` becomes the shell-quoted machine value; a bare `$VAR` substitutes verbatim.
 *  Unknown $ASMLIFT_* names are a loud error — a typo would otherwise reach sh unexpanded. */
function substitutePlaceholders(cmd: string, id: ToolchainId): string {
  return cmd.replace(/"\$(ASMLIFT_[A-Z0-9_]+)"|\$(ASMLIFT_[A-Z0-9_]+)/g, (_, quoted, bare) => {
    const value = PLACEHOLDER_VALUES[quoted ?? bare];
    if (value === undefined) {
      throw new Error(`unknown placeholder $${quoted ?? bare} in dataset/toolchains/${id}/decomp.yaml`);
    }
    return quoted !== undefined ? shq(value) : value;
  });
}

interface BenchDoc {
  name: string;
  platform: string;
  tools: { asmlift: { target: string; compiler?: string; elf?: string; symbols?: string; candidateCache?: 'off' } };
}

/** The committed config for one toolchain, with placeholders materialized. */
function benchDoc(id: ToolchainId, name: string): BenchDoc {
  const doc = YAML.parse(readFileSync(join(DATASET_DIR, id, 'decomp.yaml'), 'utf8')) as BenchDoc;
  if (doc.tools?.asmlift?.target !== id || typeof doc.tools.asmlift.compiler !== 'string') {
    throw new Error(`dataset/toolchains/${id}/decomp.yaml must declare tools.asmlift.{target: ${id}, compiler}`);
  }
  doc.name = name;
  doc.tools.asmlift.compiler = substitutePlaceholders(doc.tools.asmlift.compiler, id);
  return doc;
}

/** The materialized candidate-compile command — exported for the parity test. */
export function renderScoreCommand(id: ToolchainId): string {
  return benchDoc(id, `asmlift benchmark (${id})`).tools.asmlift.compiler!;
}

const memo = new Map<ToolchainId, CandidateCompiler | undefined>();

/** The candidate compiler for a benchmark toolchain, built through the real user path:
 *  materialize the committed decomp.yaml → loadDecompConfig → resolveTarget (asserted) →
 *  compileFromCommand. `undefined` for the pooled (dockerized) targets, whose compiler is
 *  stripped — callers fall to the registry. */
export function benchCompilerFor(id: ToolchainId): CandidateCompiler | undefined {
  if (memo.has(id)) {
    return memo.get(id);
  }

  const doc = benchDoc(id, `asmlift benchmark (${id})`);
  if (POOLED.has(id)) {
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
  const compile = toolCfg.compiler
    ? compileFromCommand(toolCfg.compiler, { cwd: dir, candidateCache: toolCfg.candidateCache })
    : undefined;
  memo.set(id, compile);
  return compile;
}

/** A benchmark Scorer that compiles through the decomp.yaml command when the target has one,
 *  and through the built-in registry scorer otherwise — the same either/or a real user gets. */
export function scoreViaBenchConfig(
  id: ToolchainId,
  builtin: (candC: string, sym: string, obj: string) => MatchScore,
): (candC: string, sym: string, obj: string, declarations?: string) => MatchScore {
  return (candC, sym, obj, declarations) => {
    const compile = benchCompilerFor(id);
    // `declarations` reaches the compiler's own prelude slot, never the front of the source: the
    // prelude already emits C_TYPEDEFS, and a concatenated copy redefines `s16`/`s32`. The
    // builtin fallback has no such slot, so it is called unchanged — it is only reached where no
    // decomp.yaml command exists, which is not a configuration any row with a map runs in.
    return compile ? scoreObjects(obj, compile(candC, sym, 'c', declarations), sym) : builtin(candC, sym, obj);
  };
}

/** Write `<dir>/decomp.yaml` for one toolchain with the candidate-compile command intact on
 *  EVERY toolchain (one-shot docker for the pooled pair) — the config `bench target` hands the
 *  reproduction scripts so `asmlift --config decomp.yaml --score-against` can compile with
 *  the benchmark's own toolchain. `elf` (absolute path — symbol-fed rows) lands as
 *  tools.asmlift.elf so the CLI loads the project's symbol map exactly as the benchmark did.
 *
 *  Nothing here decides whether a reproduction CACHES. The candidate-object cache needs no
 *  per-project declaration — everything the command reads is measured — and it is on by default,
 *  so a reader running one of these scripts gets the same store the harness does unless they say
 *  ASMLIFT_CANDCACHE=0. Sound either way: a cache is a throughput lever and never a result lever, so a miss is
 *  indistinguishable in RESULT from no cache at all. */
export function writeScoreConfig(
  id: ToolchainId,
  dir: string,
  elf?: string,
  ctxFile?: string,
  symbolsFile?: string,
): void {
  const doc = benchDoc(id, `asmlift benchmark repro (${id})`);
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
    doc.tools.asmlift.compiler =
      `cat ${ctxFile} {{inputPath}} > {{inputPath}}.ctx.c && ` +
      doc.tools.asmlift.compiler!.replaceAll('{{inputPath}}', '{{inputPath}}.ctx.c');
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
