// Reproduction shell scripts for one benchmark function (a results.json row), copied from the
// Function Explorer. Both call the tool directly with every parameter commented. The m2c script
// heredoc-embeds the exact inputs the benchmark fed m2c (normalized asm incl. data sections,
// context header). The asmlift script is benchmark-grade: a `pnpm bench target` pre-step builds
// the target object + a decomp.yaml carrying the benchmark's own compile command, then the
// plain CLI decompiles the embedded input and --score-against ranks candidates against it.
import type { FunctionResult } from '@asmlift/bench-schema';

import { m2cFnPrototype } from '../cases/real';
import { M2C_PINNED_COMMIT as M2C_COMMIT } from '../config';
import { M2C_CTX_ATTRIBUTE_RE, disasmToM2c, m2cTarget } from '../eval/m2c-normalizer';

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
# asmlift checkout — this function's context is the project's own vendored headers, stored in
# the repo (referenced, not embedded — it is ~10–260 KB):
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
# The project context the benchmark passed via --context, exactly as its real workflow would —
# GCC attributes stripped (m2c's C parser cannot read them; same expression the harness uses)${
        m2cFnPrototype(fn.sym, fn.refSource)
          ? `,
# plus the function's own prototype (the TU-derived context never forward-declares it)`
          : ''
      }.
gunzip -kc "$ASMLIFT_PATH/${fn.ctxRef}" | perl -pe 's/${M2C_CTX_ATTRIBUTE_RE}//g' > ctx.h${
        m2cFnPrototype(fn.sym, fn.refSource)
          ? `
cat >> ctx.h <<'CTX_PROTO'
${m2cFnPrototype(fn.sym, fn.refSource)}
CTX_PROTO`
          : ''
      }
`
    : fn.ctx
      ? `
# The exact context header the benchmark passed via --context — prototypes only
# (no struct/global layouts: the benchmark measures cold recovery).
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
${flagLine('--context ctx.h', 'the C context header above (typedefs + prototypes)')}`
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
# (real tier: the benchmark scored candidates inside the project's own typedef context; this
# standalone score uses the plain typedef prelude, so a compile-sensitive candidate may grade
# differently than the published row)`
      : '';
  return `#!/usr/bin/env bash
# Reproduce asmlift on \`${fn.sym}\` — benchmark function ${fn.id}.
set -euo pipefail

# asmlift checkout — run \`pnpm install\` there once, with this function's toolchain available
# (apps/benchmark/README lists the env vars; .github/workflows/benchmark.yml shows a complete
# from-scratch setup):
ASMLIFT_PATH='/path/to/asmlift'

# ── Step 1: scoring inputs ───────────────────────────────────────────────────
# Builds this function's target object (content-cached) and writes a decomp.yaml whose compile
# command is the benchmark's own toolchain invocation — what --score-against compiles with.
# (progress goes to stderr so the script's stdout stays purely the decompiled source)
pnpm --dir "$ASMLIFT_PATH" bench target ${fn.id} --out "$PWD" 1>&2

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
