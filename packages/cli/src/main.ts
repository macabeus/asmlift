// asmlift — the command-line entry point. Decompile one function's assembly to source:
//
//   asmlift <file.s|file.asm|file.o|-> --target <agbcc-arm|ido-mips|gcc-mips|mwcc-ppc> [options]
//
// Reads GNU-as text (agbcc), objdump -d text (IDO/KMC-GCC/mwcc), or an ELF OBJECT FILE — an
// object is disassembled with the target's own objdump (objfile.ts), and its jump-table
// side-table is extracted automatically. Prints the decompiled source to stdout and any gap
// diagnostics to stderr. Multi-function input is fine: the requested symbol is selected (an
// absent symbol declines loud). Scoring (--score-against) compiles candidates with the
// project's own decomp.yaml `compiler` command — never with a bundled toolchain.
//
// Exit codes: 0 = clean; 1 = gaps (ASMLIFT_ERROR markers) or a failure — the stderr prefix
// says whether it was a principled decline or an internal error; 64 = usage error;
// 66 = input unreadable (or an object that could not be disassembled).
import { cBackend } from '@asmlift/core/backend/c';
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { ContractError } from '@asmlift/core/contracts';
import { detectName } from '@asmlift/core/detect';
import { type AsmData, parseAsmData } from '@asmlift/core/frontend/asmdata';
import { FrontendUnsupportedError } from '@asmlift/core/frontend/errors';
import { VerifyError } from '@asmlift/core/ir/verify';
import type { LanguageBackend } from '@asmlift/core/l3/ast';
import { type OnGap, decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import { RaiseUnsupportedError } from '@asmlift/core/raise/errors';
import { StructureError } from '@asmlift/core/structure/structure';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '@asmlift/core/target';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type CandidateCompiler, compileFromCommand } from './compile-command';
import { type AsmliftToolConfig, loadDecompConfig, resolveTarget } from './config';
import { ObjectInputUnsupportedError, asmDataForObject, disasmObject, isElfObject } from './objfile';

export { detectName };

const TARGETS: Record<string, TargetDescription> = {
  'agbcc-arm': ARMV4T_AGBCC,
  'ido-mips': MIPS_IDO,
  'gcc-mips': MIPS_GCC,
  'mwcc-ppc': PPC_MWCC,
};

const BACKENDS: Record<string, LanguageBackend> = {
  c: cBackend,
  pascal: pascalBackend,
};

// Every flag the CLI understands. An unknown flag is a HARD usage error — silently ignoring
// `--nmae foo` or `--backned pascal` would quietly discard the user's intent.
const KNOWN_FLAGS = new Set(['target', 'name', 'backend', 'strict', 'config', 'score-against', 'asm-data', 'proto']);
const BOOL_FLAGS = new Set(['strict']);
// The emitted source embeds the name verbatim; a non-identifier would be silently invalid C.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;

const USAGE = `usage: asmlift <file.s|file.asm|file.o|-> [--target <${Object.keys(TARGETS).join('|')}>]
                [--name <symbol>] [--backend <c|pascal>] [--strict]
                [--config <decomp.yaml>] [--score-against <target.o>]
                [--asm-data <dump.txt>] [--proto <proto.json>]

Decompiles a function to source on stdout.
Input: GBA .s text (agbcc output or pret-style splits), objdump -d text, or a
MIPS/PPC ELF object.
Gaps are annotated in-source as ASMLIFT_ERROR markers, diagnostics on stderr.

  --name           select the function in multi-function input (default: detected)
  --strict         fail on any gap instead of annotating
  --config         decomp.yaml to use (default: nearest ancestor of the input)
  --score-against  recompile the output with the project's compiler and objdiff
                   it against this object; exit 0 only on a byte-exact match
                   (implies --strict)
  --asm-data       for text input: objdump -s -r -t dump of the source object
                   (jump tables, anonymous constants)
  --proto          callee prototypes JSON, e.g. {"sym":{"params":2|["u8","s32"]}}

Exit codes: 0 clean/match · 1 gaps/declined/nonmatch · 64 usage · 66 unreadable input.
Full reference (flags, decomp.yaml integration): the @asmlift/cli README.`;

// A principled decline (the pipeline refusing to guess) vs an internal error (a bug) must be
// distinguishable at the CLI surface — both exit 1, but the prefix names which one happened.
const DECLINE_ERRORS = [FrontendUnsupportedError, RaiseUnsupportedError, StructureError, ContractError, VerifyError];
const isDecline = (e: unknown) => DECLINE_ERRORS.some((c) => e instanceof c);

// The object-input seam, injectable so the offline CLI tests can fake the objdump spawns.
export interface ObjInput {
  disasm: typeof disasmObject;
  asmData: typeof asmDataForObject;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(
  argv: string[],
  readInput: (path: string) => string | Uint8Array = defaultRead,
  objInput?: ObjInput,
): Promise<CliResult> {
  const usage = (msg: string) => ({ code: 64, stdout: '', stderr: `asmlift: ${msg}\n${USAGE}\n` });
  const args = [...argv];
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  while (args.length > 0) {
    const a = args.shift()!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    // both `--flag value` and `--flag=value` forms
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!KNOWN_FLAGS.has(key)) {
      return usage(`unknown flag --${key}`);
    }
    if (BOOL_FLAGS.has(key)) {
      if (eq !== -1) {
        return usage(`--${key} takes no value`);
      }
      flags.set(key, true);
      continue;
    }
    const v = eq === -1 ? args.shift() : a.slice(eq + 1);
    if (v === undefined) {
      return usage(`missing value for --${key}`);
    }
    flags.set(key, v);
  }
  if (positional.length !== 1) {
    return { code: 64, stdout: '', stderr: `${USAGE}\n` };
  }

  // decomp.yaml (decomp_settings): nearest ancestor of the INPUT file (cwd for stdin), or the
  // explicit --config path. Supplies the target when --target is absent, plus the
  // tools.asmlift payload (compile command, objdump override).
  let toolCfg: AsmliftToolConfig | undefined;
  let configDir: string | undefined;
  let targetKey: string;
  let targetTrace = '';
  try {
    const startDir = positional[0] === '-' ? undefined : dirname(resolve(positional[0]));
    const loaded = loadDecompConfig(flags.get('config') as string | undefined, startDir);
    toolCfg = loaded?.config.tools?.asmlift;
    configDir = loaded ? dirname(loaded.path) : undefined;
    const res = resolveTarget(flags.get('target') as string | undefined, loaded);
    if ('error' in res) {
      return usage(res.error);
    }
    targetKey = res.targetKey;
    if (res.trace !== '--target flag') {
      targetTrace = `asmlift: [config] target ${targetKey} (${res.trace})\n`;
    }
  } catch (e) {
    return { code: 66, stdout: '', stderr: `asmlift: ${e instanceof Error ? e.message : e}\n` };
  }
  const target = TARGETS[targetKey];
  if (!target) {
    return usage(`--target must be one of: ${Object.keys(TARGETS).join(', ')} (got '${targetKey}')`);
  }
  const backend = BACKENDS[String(flags.get('backend') ?? 'c')];
  if (!backend) {
    return usage(`--backend must be one of: ${Object.keys(BACKENDS).join(', ')}`);
  }
  const nameFlag = flags.get('name') as string | undefined;
  if (nameFlag !== undefined && !IDENT.test(nameFlag)) {
    return usage(`--name must be a non-empty identifier (got ${JSON.stringify(nameFlag)})`);
  }

  let raw: string | Uint8Array;
  try {
    raw = readInput(positional[0]);
  } catch (e) {
    // a clean message on ITS OWN exit code — never a stack trace, never conflated with "gaps"
    return {
      code: 66,
      stdout: '',
      stderr: `asmlift: cannot read ${positional[0]}: ${e instanceof Error ? e.message : e}\n`,
    };
  }

  // Object-file input: disassemble with the target's own objdump; the jump-table side-table
  // rides along for free. Extraction failure only WARNS — the side-table is optional (a dense
  // switch then declines loudly downstream), and the disassembly itself already succeeded.
  let asm: string;
  let asmData: AsmData | undefined;
  let warn = '';
  if (typeof raw !== 'string' && isElfObject(raw)) {
    if (positional[0] === '-') {
      return {
        code: 66,
        stdout: '',
        stderr: 'asmlift: object-file input via stdin is not supported — pass a file path\n',
      };
    }
    const obj = objInput ?? {
      disasm: (path, t) => disasmObject(path, t, toolCfg?.objdump),
      asmData: (path, t) => asmDataForObject(path, t, toolCfg?.objdump),
    };
    try {
      asm = obj.disasm(positional[0], target);
    } catch (e) {
      if (e instanceof ObjectInputUnsupportedError) {
        return { code: 1, stdout: '', stderr: `asmlift: [declined] ${e.message}\n` };
      }
      return {
        code: 66,
        stdout: '',
        stderr: `asmlift: cannot disassemble ${positional[0]}: ${e instanceof Error ? e.message : e}\n`,
      };
    }
    try {
      asmData = obj.asmData(positional[0], target);
    } catch (e) {
      warn = `asmlift: warning: no jump-table side-table (${e instanceof Error ? e.message : e}) — a dense switch will decline\n`;
    }
  } else {
    asm = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  }
  const asmDataFlag = flags.get('asm-data') as string | undefined;
  if (asmDataFlag !== undefined) {
    if (asmData !== undefined) {
      return usage('--asm-data is for text input — an object file already carries its data sections');
    }
    let dump: string;
    try {
      dump = readFileSync(resolve(asmDataFlag), 'utf8');
    } catch (e) {
      return {
        code: 66,
        stdout: '',
        stderr: `asmlift: cannot read --asm-data file: ${e instanceof Error ? e.message : e}\n`,
      };
    }
    // one combined objdump text carries all three tables (symbols, relocs, contents)
    asmData = parseAsmData(dump, dump, dump, true);
  }
  let prototypes: Prototypes | undefined;
  const protoFlag = flags.get('proto') as string | undefined;
  if (protoFlag !== undefined) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(resolve(protoFlag), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return usage('--proto must be a JSON object: {"sym": {"params": N | ["u8", ...], "returnsVoid": true}, ...}');
      }
      prototypes = parsed as Prototypes;
    } catch (e) {
      return {
        code: 66,
        stdout: '',
        stderr: `asmlift: cannot read --proto file: ${e instanceof Error ? e.message : e}\n`,
      };
    }
  }

  const name = nameFlag ?? detectName(asm);
  if (!name) {
    return {
      code: 64,
      stdout: '',
      stderr: 'asmlift: could not detect the function name from the asm — pass --name <symbol>\n',
    };
  }

  // --score-against: compile the output (and every ranked candidate) with the project's own
  // compiler command (decomp.yaml tools.asmlift.compiler — REQUIRED) and objdiff-score
  // against the given object. Inherently strict: candidates come from the strict tower, so a
  // gap is a decline, never a scored stub. score.ts (objdiff-wasm) loads only on this path,
  // keeping plain decompiles toolchain-light.
  const scoreAgainst = flags.get('score-against') as string | undefined;
  if (scoreAgainst !== undefined) {
    const targetObj = resolve(scoreAgainst);
    if (!existsSync(targetObj)) {
      return { code: 66, stdout: '', stderr: `asmlift: cannot read --score-against object: ${scoreAgainst}\n` };
    }
    // Scoring REQUIRES the project's own compiler command — a wrong compiler silently
    // mis-scores every candidate, the one failure mode this project never permits. (asmlift's
    // own pinned toolchains live in the private @asmlift/toolchains workspace package, serving
    // the benchmark and the matching suite; this npm package carries no compiler at all.)
    if (!toolCfg?.compiler) {
      return usage(
        "--score-against needs tools.asmlift.compiler in decomp.yaml — scoring must use YOUR project's compiler and flags",
      );
    }
    let compile: CandidateCompiler;
    try {
      compile = compileFromCommand(toolCfg.compiler, { prelude: toolCfg.prelude, cwd: configDir });
    } catch (e) {
      return usage(`tools.asmlift.compiler: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const { decompileRanked } = await import('./rank');
      const ranked = decompileRanked(name, asm, target, targetObj, { backend, asmData, prototypes, compile });
      const table = ranked.candidates
        .map((c) => `asmlift: [score] ${c.label}: ${c.score.score}${c.score.match ? ' (match)' : ''}\n`)
        .join('');
      return { code: ranked.best.score.match ? 0 : 1, stdout: ranked.best.source, stderr: targetTrace + warn + table };
    } catch (e) {
      const kind = isDecline(e) ? 'declined' : 'internal error';
      return {
        code: 1,
        stdout: '',
        stderr: `${targetTrace}${warn}asmlift: [${kind}] ${e instanceof Error ? e.message : String(e)}\n`,
      };
    }
  }

  const onGap: OnGap = flags.has('strict') ? 'strict' : 'annotate';
  try {
    const result = decompile(name, asm, target, { backend, onGap, asmData, prototypes });
    const stderr = targetTrace + warn + result.diagnostics.map((d) => `asmlift: [${d.stage}] ${d.reason}\n`).join('');
    return { code: result.diagnostics.length === 0 ? 0 : 1, stdout: result.source, stderr };
  } catch (e) {
    const kind = isDecline(e) ? 'declined' : 'internal error';
    return {
      code: 1,
      stdout: '',
      stderr: `${targetTrace}${warn}asmlift: [${kind}] ${e instanceof Error ? e.message : String(e)}\n`,
    };
  }
}

function defaultRead(path: string): Uint8Array {
  return path === '-' ? readFileSync(0) : readFileSync(path);
}

// True only when this module is the process entry point (run as `tsx main.ts` or via the
// package bin), false when it's imported. Both sides are realpath'd: a pnpm bin shim invokes
// this file through the node_modules/@asmlift/cli SYMLINK, so a plain string compare of
// argv[1] against this module's (resolved) URL silently never matches — the CLI would exit 0
// having done nothing.
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href ===
    pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  const { code, stdout, stderr } = await runCli(process.argv.slice(2));
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  process.exit(code);
}
