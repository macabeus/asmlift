// asmlift — the command-line entry point. Decompile one function's assembly to source:
//
//   asmlift <file.s|file.asm|file.o|-> --target <agbcc|ido7.1|gcc2.7.2kmc|gcc2.7.2|mwcc_242_81> [options]
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
import { type Prototypes, validatePrototypes } from '@asmlift/core/proto';
import { RaiseUnsupportedError } from '@asmlift/core/raise/errors';
import { StructureError } from '@asmlift/core/structure/structure';
import { type SymbolMap, asIfUndecompiled } from '@asmlift/core/symbols';
import { ARMV4T_AGBCC, MIPS_GCC, MIPS_IDO, PPC_MWCC, type TargetDescription } from '@asmlift/core/target';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { guessedArityNote } from './callees';
import { MISMATCH_LOG, cacheMismatches, cacheMode, cacheStats } from './candcache';
import { type CommandCompilers, compilersFromCommand } from './compile-command';
import { type AsmliftToolConfig, loadDecompConfig, resolveTarget } from './config';
import { renderDeclarations } from './declare';
import { ObjectInputUnsupportedError, asmDataForObject, disasmObject, isElfObject } from './objfile';
import { PhaseClock } from './phase';
import { bakedBuild, sampleSourceTree, sourceStamp } from './provenance';

// The `[candcache]` line, and — when a stored answer disagreed with a fresh compile — the loud
// second line that turns a verify run into a FAILING one. A counter that only prints cannot stop
// anything: a verify pass writes one line among sixteen shard logs, so the mismatch has to reach
// the exit status.
const candCacheLine = (): string => {
  if (cacheMode() === 'off') {
    return '';
  }
  const line = `asmlift: [candcache] ${cacheMode()} ${JSON.stringify(cacheStats())}\n`;
  return cacheMismatches() === 0
    ? line
    : line +
        `asmlift: [candcache] ${cacheMismatches()} STORED ANSWER(S) DISAGREED WITH A FRESH COMPILE — ` +
        `the store is serving objects this toolchain no longer produces. See ${MISMATCH_LOG}\n`;
};

export { detectName };

const TARGETS: Record<string, TargetDescription> = {
  agbcc: ARMV4T_AGBCC,
  'ido7.1': MIPS_IDO,
  'gcc2.7.2kmc': MIPS_GCC,
  'gcc2.7.2': MIPS_GCC,
  mwcc_242_81: PPC_MWCC,
};

const BACKENDS: Record<string, LanguageBackend> = {
  c: cBackend,
  pascal: pascalBackend,
};

// Every flag the CLI understands. An unknown flag is a HARD usage error — silently ignoring
// `--nmae foo` or `--backned pascal` would quietly discard the user's intent.
const KNOWN_FLAGS = new Set([
  'target',
  'name',
  'backend',
  'strict',
  'config',
  'score-against',
  'asm-data',
  'proto',
  'jobs',
  'progress',
]);
const BOOL_FLAGS = new Set(['strict', 'progress']);
// The emitted source embeds the name verbatim; a non-identifier would be silently invalid C.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;

const USAGE = `usage: asmlift <file.s|file.asm|file.o|-> [--target <${Object.keys(TARGETS).join('|')}>]
                [--name <symbol>] [--backend <c|pascal>] [--strict]
                [--config <decomp.yaml>] [--score-against <target.o>]
                [--asm-data <dump.txt>] [--proto <json|proto.json>]
                [--jobs <n>] [--progress]

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
  --proto          function prototypes, inline JSON or a path to it:
                   {"sym":{"params":2|["u8","s32"]}} — a callee's count gives
                   its call-site arity, a typed list also gives its widths
  --jobs           with --score-against: compile n candidates at a time (default 1)
  --progress       with --score-against: stream a liveness line to stderr while
                   scoring; the [score] table it prints at the end is unchanged

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
  /** where `--progress` writes. Absent (every non-process caller, including the tests) ⇒ the
   *  flag has nothing to write to and the run is silent, so `runCli`'s result stays the whole
   *  output. The process entry point below supplies stderr. */
  progressSink?: (line: string) => void,
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
    // A table INLINE (`--proto '{"sym":{"params":1}}'`) or the path to one. Inline is the form
    // docs/ranked-repro.md's canonical command uses, and the form the `[proto]` note below prints
    // as its own remedy — but it used to be resolved as a path, so following either exited 66 on
    // a missing file literally named `{"sym":{"params":1}}`. Three different scratch proto.json
    // files got invented around that, carrying two different tables for the same "canonical" run.
    const inline = protoFlag.trimStart().startsWith('{');
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline ? protoFlag : readFileSync(resolve(protoFlag), 'utf8'));
    } catch (e) {
      return {
        code: 66,
        stdout: '',
        stderr: `asmlift: cannot ${inline ? 'parse --proto JSON' : 'read --proto file'}: ${
          e instanceof Error ? e.message : e
        }\n`,
      };
    }
    // Every entry, not just the envelope — an unreadable `params` decompiles at a guessed arity
    // rather than failing (see validatePrototypes).
    const problems = validatePrototypes(parsed);
    if (problems.length) {
      return usage(`--proto ${protoFlag}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    }
    prototypes = parsed as Prototypes;
  }

  // tools.asmlift.elf → the project's symbol map (names + declaration shapes). Explicit
  // config, so an unreadable ELF is a loud input error, never a silent names-less run.
  let symbols: SymbolMap | undefined;
  if (toolCfg?.elf) {
    const elfPath = resolve(configDir!, toolCfg.elf);
    try {
      const { loadSymbolMap } = await import('./symbols-provider');
      symbols = await loadSymbolMap(elfPath);
    } catch (e) {
      return {
        code: 66,
        stdout: '',
        stderr: `asmlift: cannot load symbols from tools.asmlift.elf (${elfPath}): ${e instanceof Error ? e.message : e}\n`,
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

  // NEVER consume the TARGET's own definition-derived DWARF. A project that has already
  // decompiled `name` carries its signature (and later its locals) in this ELF, so using it
  // would make the output depend on already having the answer — and it is a fact a user
  // decompiling an `INCLUDE_ASM` function cannot have. Globals, struct layouts and CALLEE
  // signatures all survive; only the target's own compiled facts are withheld. The benchmark
  // applies the same filter, so a reproduction of a published row grades what was scored.
  if (symbols) {
    symbols = asIfUndecompiled(symbols, name);
  }

  // Which callees' arity this run had to guess — computed AFTER `asIfUndecompiled`, so the
  // target's own withheld signature cannot make the note claim a fact the run did not use.
  const protoNote = guessedArityNote(asm, name, prototypes, symbols);

  // --score-against: compile the output (and every ranked candidate) with the project's own
  // compiler command (decomp.yaml tools.asmlift.compiler — REQUIRED) and objdiff-score
  // against the given object. Inherently strict: candidates come from the strict tower, so a
  // gap is a decline, never a scored stub. score.ts (objdiff-wasm) loads only on this path,
  // keeping plain decompiles toolchain-light.
  const scoreAgainst = flags.get('score-against') as string | undefined;
  // Candidate compiles are most of the CPU a ranked run charges, and independent of one another,
  // so --jobs runs n of them at once; what the split was on a given run is on its own `[phase]`
  // line (phase.ts). Ranking is unaffected (rank.ts). Both flags belong to the
  // ranked path alone: accepting them elsewhere would silently discard what the user asked for.
  const jobsFlag = flags.get('jobs') as string | undefined;
  if ((jobsFlag !== undefined || flags.has('progress')) && scoreAgainst === undefined) {
    return usage('--jobs/--progress apply to --score-against runs only');
  }
  let jobs = 1;
  if (jobsFlag !== undefined) {
    jobs = Number(jobsFlag);
    if (!Number.isInteger(jobs) || jobs < 1) {
      return usage(`--jobs must be a positive integer (got ${JSON.stringify(jobsFlag)})`);
    }
  }
  // At most one line every few seconds: enough to tell a 20-minute run from a hung one, few
  // enough that the log stays readable. The `[progress]` prefix keeps it separable from the
  // `[score]` lines two ranked logs are compared on.
  let lastTick = 0;
  const onProgress =
    flags.has('progress') && progressSink
      ? (doneN: number, total: number, bestSoFar: number | undefined) => {
          const now = Date.now();
          if (doneN < total && now - lastTick < 5000) {
            return;
          }
          lastTick = now;
          const best = bestSoFar === undefined ? '' : `, best so far ${bestSoFar}`;
          progressSink(`asmlift: [progress] ${doneN}/${total} candidates scored${best}\n`);
        }
      : undefined;
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
    let compilers: CommandCompilers;
    try {
      compilers = compilersFromCommand(toolCfg.compiler, { cwd: configDir });
    } catch (e) {
      return usage(`tools.asmlift.compiler: ${e instanceof Error ? e.message : e}`);
    }
    const compile = compilers.compile;
    try {
      // Sampled BEFORE the run and again after it — see provenance.ts for the run this exists for.
      const treeBefore = sampleSourceTree();
      const { decompileRanked, decompileRankedParallel } = await import('./rank');
      // Under `--progress` — the flag that already says "report on this run as it goes" — the run
      // also says what it SPENT (phase.ts). A run nobody is watching writes only what it computed.
      const clock = flags.has('progress') ? new PhaseClock() : undefined;
      const rankOpts = {
        backend,
        asmData,
        prototypes,
        symbols,
        compile,
        ...(onProgress ? { onProgress } : {}),
        ...(clock ? { clock } : {}),
      };
      // jobs > 1 pools the candidate COMPILES; the ranking itself is the same code either way
      // (rank.ts), so the two differ in scheduling only.
      const ranked =
        jobs > 1
          ? await decompileRankedParallel(name, asm, target, targetObj, {
              ...rankOpts,
              jobs,
              worker: compilers.worker,
            })
          : decompileRanked(name, asm, target, targetObj, rankOpts);
      const table = ranked.candidates
        .map((c) => `asmlift: [score] ${c.label}: ${c.score.score}${c.score.match ? ' (match)' : ''}\n`)
        .join('');
      // Spellings the scorer refused are recorded, not silent: a lever whose every candidate
      // fails to build looks identical to one that declined unless the drops are visible.
      const drops = ranked.dropped.length
        ? `asmlift: [dropped] ${ranked.dropped.length} candidate(s) failed to score; first: ` +
          `${ranked.dropped[0].label}: ${ranked.dropped[0].error}\n`
        : '';
      // WITHHELD is a different fact from dropped and gets its own line: these compiled and scored
      // and were then refused publication for want of a byte-exact proof (Candidate.matchOnly).
      // Folding them into `dropped` would report compile failures that did not happen; leaving
      // them out entirely would make `candidates scored` under-count the fan with no trace.
      const held = ranked.withheld.length
        ? `asmlift: [withheld] ${ranked.withheld.length} candidate(s) scored but unpublishable; first: ` +
          `${ranked.withheld[0].label} at ${ranked.withheld[0].score}: ${ranked.withheld[0].why}\n`
        : '';
      // THE ASSUMPTIONS THE SCORE RESTS ON. A candidate names globals the asm's own literal pool
      // named, and where no symbol map knows them asmlift synthesizes their declarations — width
      // and signedness read out of the TARGET's own asm (core rank.ts bareGlobalSymbols). Such a
      // declaration is fitted to the bytes it is scored against: it cannot lose score, only
      // manufacture agreement, so a published `(match)` that depends on one has to name it. Only
      // in the SELF-DECLARED world, which is the probe's verdict and nobody else's — in the
      // headers world the block is dropped and the project's own declarations did the work.
      const assumed = (ranked.best.symbolRefs ?? []).filter((r) => r.synthesized);
      const declared =
        assumed.length > 0 && compilers.selfDeclared() === true
          ? `asmlift: [declared] ${assumed.length} declaration(s) synthesized from the target asm — no symbol ` +
            `map knows these names, so the score is about this block plus the source; check it against your ` +
            `headers:\n` +
            renderDeclarations(assumed)
              .split('\n')
              .filter((l) => l.trim() !== '')
              .map((l) => `asmlift:   ${l}\n`)
              .join('')
          : '';
      // The three counts docs/ranked-repro.md requires beside every ranked score, as ONE line that
      // is always present. They used to be recoverable only as the line count of a 2 MB stderr
      // stream, and "0 dropped" was asserted by the ABSENCE of the `[dropped]` line above — so a
      // clean run, a truncated log and a killed run left identical evidence for the claim this
      // loop's every published score rests on.
      //
      // …plus WHICH TREE produced them. The counts make a truncated run distinguishable from a clean
      // one; the stamp makes a run against different SOURCES distinguishable from both, which no
      // part of the log used to be (provenance.ts). On the same line as the score deliberately: the
      // doc tells readers to quote this one line, so a stamp anywhere else is a stamp nobody pastes.
      //
      // SYNTHESIZED is the fourth count, and it is here for the same reason as the other three:
      // the `[declared]` block below is CONDITIONAL, so "this score rests on no declaration
      // asmlift invented" would otherwise be spelled as an absent line — and a `(match)` whose
      // declaration block was fitted to the target asm would be publishable by pasting exactly
      // the one line the doc asks for. The count travels with the score; the block stays below.
      const summary =
        `asmlift: [ranked] ${ranked.candidates.length} candidate(s) scored, ${ranked.dropped.length} dropped, ` +
        `${ranked.withheld.length} withheld, ${declared === '' ? 0 : assumed.length} synthesized, ` +
        `best ${ranked.best.label}: ${ranked.best.score.score}${ranked.best.score.match ? ' (match)' : ''} ` +
        `[${sourceStamp(treeBefore, sampleSourceTree(), bakedBuild())}]\n`;
      return {
        code: ranked.best.score.match && cacheMismatches() === 0 ? 0 : 1,
        stdout: ranked.best.source,
        // …and where the time went, ABOVE the line readers paste, so `[ranked]` and its `[proto]`
        // tail stay adjacent.
        stderr:
          targetTrace +
          warn +
          table +
          drops +
          held +
          declared +
          (clock?.report() ?? '') +
          summary +
          protoNote +
          candCacheLine(),
      };
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
    const result = decompile(name, asm, target, { backend, onGap, asmData, prototypes, symbols });
    const stderr =
      targetTrace + warn + result.diagnostics.map((d) => `asmlift: [${d.stage}] ${d.reason}\n`).join('') + protoNote;
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
  const { code, stdout, stderr } = await runCli(process.argv.slice(2), undefined, undefined, (line) =>
    process.stderr.write(line),
  );
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  process.exit(code);
}
