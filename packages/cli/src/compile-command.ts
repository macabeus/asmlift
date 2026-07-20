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
  /** Prepend asmlift's `s32`/`u32`… typedefs to the candidate C (default true). Set false when
   *  the command injects project headers that already define them (C89 forbids re-typedefs). */
  prelude?: boolean;
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
 *  templates, so a project's tool blocks read uniformly. The command runs via `sh -c`; a non-zero exit
 *  or a missing output object throws with the full command + its stderr — configured means
 *  configured, there is no fallback. */
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
  return (source, symbol, backendId) => {
    const dir = mkdtempSync(join(tmpdir(), 'asmlift-usercc-'));
    const inPath = join(dir, backendId === 'pascal' ? 'cand.p' : 'cand.c');
    const outPath = join(dir, 'cand.o');
    const prelude = backendId === 'pascal' || opts.prelude === false ? '' : C_TYPEDEFS;
    writeFileSync(inPath, prelude + source);
    const cmd = template
      .replaceAll('{{inputPath}}', safe(inPath, '{{inputPath}}'))
      .replaceAll('{{outputPath}}', safe(outPath, '{{outputPath}}'))
      .replaceAll('{{symbol}}', safe(symbol, 'the symbol name'));
    const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', cwd: opts.cwd });
    if (r.status !== 0) {
      throw new Error(
        `compile command failed (exit ${r.status ?? 'signal'}): ${cmd}\n${(r.stderr || r.stdout).trim()}`,
      );
    }
    if (!existsSync(outPath)) {
      throw new Error(`compile command exited 0 but produced no object at {{outputPath}}: ${cmd}`);
    }
    return outPath;
  };
}
