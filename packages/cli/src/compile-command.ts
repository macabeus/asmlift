// asmlift — the candidate-compile seam.
//
// A candidate compile is ONE contract: candidate source in, relocatable object out. A project
// fills it with its OWN compiler via a `decomp.yaml` `compiler` command template — different
// version, different flags, no asmlift Docker image anywhere. (asmlift's pinned toolchains
// implement the same contract in the private @asmlift/toolchains package, for the benchmark
// and the matching suite.)
//
// This module is deliberately free of score.ts/objdiff imports so the CLI can build a compiler
// from config without loading the objdiff wasm, and so its tests stay offline.
import { C_TYPEDEFS } from '@asmlift/core/target';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Compile one candidate translation unit into a relocatable object; returns the object path.
 *  Throws on any failure — a candidate that cannot be compiled must never score. */
export type CandidateCompiler = (source: string, symbol: string, backendId: string) => string;

export interface CompileCommandOptions {
  /** Working directory for the command — the decomp.yaml's directory, so project-relative
   *  paths (`./tools/agbcc/bin/agbcc`) resolve regardless of where asmlift was invoked. */
  cwd?: string;
}

// Substituted values are injected RAW so the template owns its quoting (a natural template
// writes `PRE="{out}.i"` — a pre-quoted substitution would put literal quotes in the
// filename). The guarantee instead: every substituted value is shell-inert, or the compile
// throws. Paths come from mkdtemp (always safe); the symbol can come from UNVALIDATED
// pasted-asm labels, so this check is load-bearing against shell injection.
const SHELL_SAFE = /^[A-Za-z0-9_./+-]+$/;
const safe = (value: string, what: string): string => {
  if (!SHELL_SAFE.test(value)) {
    throw new Error(`${what} contains shell-unsafe characters, refusing to substitute: ${JSON.stringify(value)}`);
  }
  return value;
};

/** Build a CandidateCompiler from a `decomp.yaml` command template. `{{inputPath}}` and
 *  `{{outputPath}}` are REQUIRED placeholders (substituted with absolute paths);
 *  `{{symbol}}` is optional. The placeholder style matches other decomp tools' `compiler`
 *  templates, so a project's tool blocks read uniformly. The command runs via `sh -ec` — EVERY
 *  step must succeed, not just the last one: gcc-2.9-family compilers exit nonzero on a hard
 *  error (an undeclared identifier, even an invalid flag) yet still write a PARTIAL .s with the
 *  erroring statements deleted, so without `-e` a later assemble step "succeeds" and a silently
 *  TRUNCATED object gets scored (found scoring real 22/28/38 phantoms in the klonoa dogfood).
 *  A non-zero exit or a missing output object throws with the full command + its stderr —
 *  configured means configured, there is no fallback. */
export function compileFromCommand(template: string, opts: CompileCommandOptions = {}): CandidateCompiler {
  if (!template.includes('{{inputPath}}') || !template.includes('{{outputPath}}')) {
    throw new Error(`compiler command must contain {{inputPath}} and {{outputPath}} placeholders — got: ${template}`);
  }
  // An unrecognized {{...}} placeholder is a config mistake (e.g. another tool's
  // {{functionName}} pasted verbatim) — name it now instead of a baffling shell failure.
  const unknown = template.replaceAll(/\{\{(inputPath|outputPath|symbol)\}\}/g, '').match(/\{\{\w+\}\}/);
  if (unknown) {
    throw new Error(
      `compiler command has an unknown placeholder ${unknown[0]} — supported: {{inputPath}}, {{outputPath}}, {{symbol}}`,
    );
  }
  // One template execution: write `content`, substitute, run under `sh -ec`, demand the object.
  const execute = (content: string, symbol: string, ext: 'c' | 'p'): { ok: boolean; cmd: string; err: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-usercc-'));
    const inPath = join(dir, `cand.${ext}`);
    const outPath = join(dir, 'cand.o');
    writeFileSync(inPath, content);
    const cmd = template
      .replaceAll('{{inputPath}}', safe(inPath, '{{inputPath}}'))
      .replaceAll('{{outputPath}}', safe(outPath, '{{outputPath}}'))
      .replaceAll('{{symbol}}', safe(symbol, 'the symbol name'));
    const r = spawnSync('sh', ['-ec', cmd], { encoding: 'utf8', cwd: opts.cwd });
    if (r.status !== 0) {
      return {
        ok: false,
        cmd,
        err: `compile command failed (exit ${r.status ?? 'signal'}): ${cmd}\n${(r.stderr || r.stdout).trim()}`,
      };
    }
    if (!existsSync(outPath)) {
      return { ok: false, cmd, err: `compile command exited 0 but produced no object at {{outputPath}}: ${cmd}` };
    }
    return { ok: true, cmd: outPath, err: '' };
  };

  // Whether asmlift's typedef prelude coexists with whatever the template injects — PROBED, never
  // configured. A template that wraps candidates with project headers already defines u8/u16/…,
  // and C89 hard-errors on a duplicate typedef; a bare template needs the prelude or nothing
  // compiles. The compiler itself is the only authority on which world we're in, so ask it once:
  // compile `C_TYPEDEFS + one harmless decl`. Success ⇒ prelude compatible. Failure ⇒ try the
  // decl alone: success confirms the collision (drop the prelude); failure means the TEMPLATE is
  // broken — keep the prelude so the first real candidate fails with the template's own loud
  // diagnostics. Exit-code-only: no error-message parsing (gcc-2.9/IDO/mwcc all format
  // differently). Cached per compiler instance — two tiny compiles worst case, ever.
  const PROBE = 'int asmlift_prelude_probe;\n';
  let preludeOk: boolean | undefined;
  const probePrelude = (symbol: string): boolean => {
    if (execute(C_TYPEDEFS + PROBE, symbol, 'c').ok) {
      return true;
    }
    return !execute(PROBE, symbol, 'c').ok;
  };

  return (source, symbol, backendId) => {
    let prelude = '';
    if (backendId !== 'pascal') {
      preludeOk ??= probePrelude(symbol);
      prelude = preludeOk ? C_TYPEDEFS : '';
    }
    const r = execute(prelude + source, symbol, backendId === 'pascal' ? 'p' : 'c');
    if (!r.ok) {
      throw new Error(r.err);
    }
    return r.cmd;
  };
}
