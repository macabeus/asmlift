// Reproduction shell scripts for one benchmark function (a results.json row), copied from the
// Function Explorer. Both call the tool directly with every parameter commented. The m2c script
// heredoc-embeds the exact inputs the benchmark fed m2c (normalized asm incl. data sections,
// context header). The asmlift script is benchmark-grade: a `pnpm bench target` pre-step builds
// the target object + a decomp.yaml carrying the benchmark's own compile command, then the
// plain CLI decompiles the embedded input and --score-against ranks candidates against it.
import type { FunctionResult } from '@asmlift/bench-schema';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { REAL_DIR, type RealManifest, loadManifestsForVendor } from '../cases/manifests';
import { M2C_PINNED_COMMIT as M2C_COMMIT } from '../config';
import { disasmToM2c, m2cTarget } from '../eval/m2c-normalizer';

// ── real-tier provenance preambles (comments only — nothing here executes) ────────────────
// The committed manifests are part of the dataset, so the generator can name each project's
// pinned fork/branch and the vendored symbol map without any checkout present.
let manifestCache: Map<string, RealManifest> | null = null;
function manifestFor(project: string): RealManifest | null {
  manifestCache ??= new Map(loadManifestsForVendor().map((m) => [m.project, m]));
  return manifestCache.get(project) ?? null;
}

const mapShaCache = new Map<string, string | null>();
/** sha256 of the DECOMPRESSED vendored symbol-map JSON — the map's identity across machines
 *  (the .gz bytes vary with compressor settings; the JSON is byte-stable by construction). */
function vendoredMapSha(project: string): string | null {
  let sha = mapShaCache.get(project);
  if (sha === undefined) {
    const p = join(REAL_DIR, 'tu', project, 'symbols.json.gz');
    sha = existsSync(p)
      ? createHash('sha256')
          .update(gunzipSync(readFileSync(p)))
          .digest('hex')
      : null;
    mapShaCache.set(project, sha);
  }
  return sha;
}

/** The full checkout recipe for a real row: the PINNED benchmark branch of the project's fork
 *  (provenance base + one integration commit), the build, and — sidecar projects — the derived
 *  symbols ELF. Comments only: the vendored inputs below keep the script itself checkout-free. */
function checkoutRecipe(fn: FunctionResult): string {
  const man = fn.tier === 'real' ? manifestFor(fn.project) : null;
  if (!man) {
    return '';
  }
  const dir = man.repoDir;
  return `

# This function's decomp project — the PINNED benchmark branch (provenance base + one
# integration commit). Not needed to run this script (inputs are embedded/vendored); to
# rebuild the project itself:
#   git clone --branch ${man.branch} https://github.com/${man.repo}.git ${dir}
#   make -C ${dir}${
    man.elfMake
      ? `
#   make -C ${dir} ${man.elfMake}   # derive the symbols ELF (DWARF types-sidecar)`
      : ''
  }`;
}

/** Whether this row's script must load the project's symbol map (the row was measured with
 *  it, and the committed manifest names the checkout dir the script's placeholder points at). */
function usesSymbolMap(fn: FunctionResult): boolean {
  return fn.tier === 'real' && Boolean(fn.asmlift.symbolMap) && manifestFor(fn.project) !== null;
}

/** The symbol-map provenance note for a real row (asmlift script only — the map is asmlift's
 *  analogue of m2c's context input). Map rows also declare the PROJECT_PATH placeholder here:
 *  step 1 grafts that checkout's tools.asmlift.elf into the scoring config, so the CLI loads
 *  the same map the benchmark fed this function. */
function symbolsNote(fn: FunctionResult): string {
  if (fn.tier !== 'real') {
    return '';
  }
  if (usesSymbolMap(fn)) {
    const rel = `apps/benchmark/dataset/real/tu/${fn.project}/symbols.json.gz`;
    const sha = vendoredMapSha(fn.project);
    return `
# SYMBOLS: this row ran WITH the project's symbol map (names + declaration shapes derived
# from the ELF its decomp.yaml names), vendored at ${rel}
#   sha256 of the decompressed map JSON: ${sha ?? 'unavailable (vendored blob not present)'}
# Set PROJECT_PATH to your BUILT checkout of the project above (clone recipe in the comments);
# step 1 then points the scoring config at the checkout's decomp.yaml (tools.asmlift.elf) —
# the CLI loads the same map, so this run reproduces the row's named spellings. A missing
# checkout/ELF warns and runs map-less (output may then differ from the row).
PROJECT_PATH='/path/to/${manifestFor(fn.project)!.repoDir}'`;
  }
  return `
# (no symbols needed: this row ran without a project symbol map.)`;
}

/** One bash-array element with its explanatory comment, comment column aligned. A long flag
 *  must still get ≥1 space before `#` — a glued `flag#comment` is NOT a comment in bash and
 *  feeds the comment words to the tool as arguments. */
function flagLine(flag: string, comment: string): string {
  return `  ${flag.padEnd(Math.max(24, flag.length + 1))}# ${comment}`;
}

/** The m2c input for this function: agbcc `.s` verbatim (ARM); the harness's objdump→GNU-as
 *  normalization otherwise, fed the published `objdump -s -r -t` dump so jump tables and
 *  anonymous constants emit exactly as they did in the benchmark. */
function m2cInput(fn: FunctionResult): string {
  if (fn.isa === 'arm') {
    return fn.targetAsm;
  }
  try {
    return disasmToM2c(fn.targetAsm, fn.isa, fn.asmDump);
  } catch {
    return fn.targetAsm; // unparseable stored asm: embed verbatim rather than hide the function
  }
}

export function m2cScript(fn: FunctionResult): string {
  const asmNote =
    fn.isa === 'arm'
      ? '# The exact agbcc `.s` text the benchmark fed m2c, verbatim.'
      : `# The benchmark's objdump→GNU-as normalization of this function's disassembly (m2c cannot
# read raw objdump), including the jump-table/const data sections recovered from the target
# object — the exact text the benchmark fed m2c.`;
  return `#!/usr/bin/env bash
# Reproduce m2c on \`${fn.sym}\` — benchmark function ${fn.id}.
set -euo pipefail

# m2c checkout (https://github.com/matt-kempster/m2c); the benchmark pins commit ${M2C_COMMIT.slice(0, 7)}:
#   git clone https://github.com/matt-kempster/m2c && git -C m2c checkout ${M2C_COMMIT}
M2C_PATH='/path/to/m2c'${
    fn.ctxRef
      ? `
# asmlift checkout — this function's context is the project's own vendored preprocessor
# output, stored in the repo (referenced rather than embedded — it can be hundreds of KB):
ASMLIFT_PATH='/path/to/asmlift'`
      : ''
  }

${asmNote}
cat > in.s <<'ASM_INPUT'
${m2cInput(fn).trimEnd()}
ASM_INPUT
${
  fn.ctxRef
    ? `
# The project context the benchmark passed via --context: the VERBATIM vendored blob — this
# function's translation unit run through the project's own preprocessor with the function body
# removed, i.e. whatever that TU's headers and the manifest's prependC declare, and nothing
# added. How much that is varies by project (a full header tree for some, a handful of typedefs
# for others); the file below is the exact bytes, so read it rather than this comment.${
        fn.ctxProto
          ? `
# One line is appended: the function's own prototype, and ONLY because the project's headers do
# not declare it and the row's asmlift \`--proto\` already carries the same void-ness. It is
# derived from that field, never from the reference source.`
          : ''
      }
gunzip -kc "$ASMLIFT_PATH/${fn.ctxRef}" > ctx.h${
        fn.ctxProto
          ? `
cat >> ctx.h <<'CTX_PROTO'
${fn.ctxProto}
CTX_PROTO`
          : ''
      }
`
    : fn.ctx
      ? `
# The exact context header the benchmark passed via --context.${
          fn.tier === 'real'
            ? `
# This is one of the six rows whose callees the project's own vendored headers do not declare, so
# the benchmark states them here instead; the same callees are named to asmlift through its
# --proto hints, and a test holds the two lists equal. Everything else the project declares
# reaches asmlift as a symbol map and does not reach m2c on this row.`
            : `
# Prototypes only — no struct or global layouts. The synthetic tier measures COLD recovery and is
# symmetric by construction: these are the same facts asmlift is given as --proto hints, and
# neither tool is given a project.`
        }
cat > ctx.h <<'CTX_INPUT'
${fn.ctx.trimEnd()}
CTX_INPUT
`
      : `
# (This function ran with NO context header — the benchmark fed m2c the assembly alone.)
`
}
args=(
${flagLine(`--target ${m2cTarget(fn.compiler, fn.language)}`, "ISA + compiler dialect (selects m2c's code-shape assumptions)")}
${flagLine(`--function ${fn.sym}`, 'the symbol to decompile from in.s')}${
    fn.ctx || fn.ctxRef
      ? `
${flagLine('--context ctx.h', fn.ctxRef ? 'the project context header written above' : fn.tier === 'real' ? "this row's authored callee prototypes, above" : 'the prototype header written above')}`
      : ''
  }
${flagLine('--no-cache', "bypass m2c's on-disk cache — always a fresh run")}
)
python3 "$M2C_PATH/m2c.py" "\${args[@]}" in.s
`;
}

export function asmliftScript(fn: FunctionResult): string {
  const asmKind = fn.isa === 'arm' ? 'agbcc `.s`' : '`objdump -d --no-show-raw-insn`';
  const dumpBlock = fn.asmDump
    ? `

# The target object's objdump -s -r -t dump — the data sections (jump tables, anonymous
# constants) the text-only disassembly lacks; the benchmark recovered them from the object.
cat > dump.txt <<'DUMP_INPUT'
${fn.asmDump.trimEnd()}
DUMP_INPUT`
    : '';
  const protoBlock = fn.proto
    ? `

# The prototype hints the benchmark fed asmlift (callee arities / void-ness).
cat > proto.json <<'PROTO_INPUT'
${JSON.stringify(fn.proto, null, 2)}
PROTO_INPUT`
    : '';
  const realNote =
    fn.tier === 'real'
      ? `
# (real tier: candidates are scored INSIDE the project's own context — step 1 materializes the
# row's vendored context next to target.o as ctx.i, and the generated decomp.yaml concatenates
# it ahead of every candidate, so this scores in the same world the benchmark did)`
      : '';
  return `#!/usr/bin/env bash
# Reproduce asmlift on \`${fn.sym}\` — benchmark function ${fn.id}.
set -euo pipefail

# asmlift checkout — run \`pnpm install\` there once, with this function's toolchain available
# (\`pnpm bench setup\` fetches bench-owned toolchains + pinned project checkouts;
# apps/benchmark/README lists the env-var overrides; .github/workflows/benchmark.yml shows a
# complete from-scratch setup):
ASMLIFT_PATH='/path/to/asmlift'${checkoutRecipe(fn)}${symbolsNote(fn)}

# ── Step 1: scoring inputs ───────────────────────────────────────────────────
# Builds this function's target object (content-cached) and writes a decomp.yaml whose compile
# command is the benchmark's own toolchain invocation — what --score-against compiles with.${
    usesSymbolMap(fn)
      ? `
# --project-root grafts the checkout's tools.asmlift.elf (the symbol map) into that decomp.yaml.`
      : ''
  }
# (progress goes to stderr so the script's stdout stays purely the decompiled source)
pnpm --dir "$ASMLIFT_PATH" bench target ${fn.id} --out "$PWD"${
    usesSymbolMap(fn) ? ' --project-root "$PROJECT_PATH"' : ''
  } 1>&2

# ── Step 2: the input the benchmark fed asmlift, verbatim ────────────────────
# The exact ${asmKind} text.
cat > in.asm <<'ASM_INPUT'
${fn.targetAsm.trimEnd()}
ASM_INPUT${dumpBlock}${protoBlock}

# ── Step 3: decompile + benchmark-grade scoring ──────────────────────────────${realNote}
args=(
${flagLine('in.asm', 'input: the disassembly text above')}
${flagLine(`--target ${fn.toolchain}`, 'frontend + target description (ISA, calling convention, compiler idioms)')}
${flagLine(`--name ${fn.sym}`, 'the symbol to decompile (multi-function input selects by name)')}${
    fn.asmDump
      ? `
${flagLine('--asm-data dump.txt', 'the data sections above (jump-table/const recovery)')}`
      : ''
  }${
    fn.proto
      ? `
${flagLine('--proto proto.json', 'the prototype hints above (callee arities / void-ness)')}`
      : ''
  }
${flagLine('--config decomp.yaml', 'the compile command from step 1')}
${flagLine('--score-against target.o', 'rank candidate variants, objdiff-score each; exit 0 only on byte-exact')}
)
# the checkout's own asmlift bin (pnpm links it; it runs through the repo's pinned tsx)
"$ASMLIFT_PATH/node_modules/.bin/asmlift" "\${args[@]}"
`;
}
