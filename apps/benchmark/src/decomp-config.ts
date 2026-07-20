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
import { GCC_KMC_TOOLCHAIN, IDO_TOOLCHAIN, MWCC_PPC_TOOLCHAIN, TOOLCHAIN } from '@asmlift/toolchains';
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
  ASMLIFT_DOCKER: GCC_KMC_TOOLCHAIN.docker,
  ASMLIFT_KMC_DIR: GCC_KMC_TOOLCHAIN.dir,
  ASMLIFT_KMC_IMAGE: GCC_KMC_TOOLCHAIN.image,
  ASMLIFT_MWCC_DIR: MWCC_PPC_TOOLCHAIN.dir,
  ASMLIFT_PPC_IMAGE: MWCC_PPC_TOOLCHAIN.image,
  ASMLIFT_WIBO: MWCC_PPC_TOOLCHAIN.wibo,
};

/** The pooled pair: scoring compiles through the built-in registry (long-lived containers). */
const POOLED: ReadonlySet<ToolchainId> = new Set(['gcc-mips', 'mwcc-ppc']);

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
  tools: { asmlift: { target: string; compiler?: string } };
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
  const compile = toolCfg.compiler ? compileFromCommand(toolCfg.compiler, { cwd: dir }) : undefined;
  memo.set(id, compile);
  return compile;
}

/** A benchmark Scorer that compiles through the decomp.yaml command when the target has one,
 *  and through the built-in registry scorer otherwise — the same either/or a real user gets. */
export function scoreViaBenchConfig(
  id: ToolchainId,
  builtin: (candC: string, sym: string, obj: string) => MatchScore,
): (candC: string, sym: string, obj: string) => MatchScore {
  return (candC, sym, obj) => {
    const compile = benchCompilerFor(id);
    return compile ? scoreObjects(obj, compile(candC, sym, 'c'), sym) : builtin(candC, sym, obj);
  };
}

/** Write `<dir>/decomp.yaml` for one toolchain with the candidate-compile command intact on
 *  EVERY toolchain (one-shot docker for the pooled pair) — the config `bench target` hands the
 *  reproduction scripts so `asmlift --config decomp.yaml --score-against` can compile with
 *  the benchmark's own toolchain. */
export function writeScoreConfig(id: ToolchainId, dir: string): void {
  writeFileSync(join(dir, 'decomp.yaml'), YAML.stringify(benchDoc(id, `asmlift benchmark repro (${id})`)));
}
