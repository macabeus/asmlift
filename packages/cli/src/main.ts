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
// Exit codes: `EXIT` below, plus `CACHE_MISMATCH_EXIT` from candcache.ts — one table, so a status
// this file returns and a status the README documents cannot drift apart.
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
import {
  CACHE_MISMATCH_EXIT,
  MISMATCH_LOG,
  cacheMismatches,
  cacheMode,
  cacheSampleNote,
  cacheStats,
} from './candcache';
import { type CommandCompilers, compilersFromCommand } from './compile-command';
import { type AsmliftToolConfig, loadDecompConfig, resolveTarget } from './config';
import { renderDeclarations } from './declare';
import { ObjectInputUnsupportedError, asmDataForObject, disasmObject, isElfObject } from './objfile';
import { PhaseClock } from './phase';
import { bakedBuild, sampleSourceTree, sourceStamp } from './provenance';
// TYPE-ONLY, and it must stay that way: `./rank` pulls in objdiff-wasm, which this module loads
// through a dynamic `import()` on the ranked path alone so a plain decompile stays toolchain-light.
// An `import type` is erased outright and adds no runtime edge.
import type { RankedResult } from './rank';

/** Every status this CLI returns, named. `CACHE_MISMATCH_EXIT` (3) is candcache.ts's and is
 *  imported rather than restated, because the code that DETECTS a mismatch is what should own the
 *  number for it. */
const EXIT = { clean: 0, gaps: 1, usage: 64, unreadable: 66 } as const;

// A cache mismatch has to reach the EXIT STATUS, not merely the log. A counter that only prints
// cannot stop anything: a verify pass writes one line among sixteen shard logs. The same is true
// of an `on` run, whose sampled audit fails the run exactly as verify's does.

/**
 * The exit status of a ranked run, ON EITHER OF ITS TWO RETURNS — and both is the point.
 *
 * A cache mismatch outranks what the run would otherwise say, a decline included: a store that
 * lied invalidates the fan, while a decline is an ordinary outcome. The failure return needs it
 * because a mismatch is REACHABLE behind one — the audit runs inside the candidate compiles, so a
 * run that declines after them has already reported — and a 1 there is indistinguishable from the
 * decline every wrapper keying on the status expects. Which reason it was is not lost: `[declined]`
 * / `[internal error]` and the `[candcache]` lines are both in the stderr returned beside the code.
 */
export const rankedExitCode = (match: boolean): number =>
  cacheMismatches() > 0 ? CACHE_MISMATCH_EXIT : match ? EXIT.clean : EXIT.gaps;
/** The run's `[candcache]` line, and — when a stored answer disagreed with a fresh compile — the
 *  loud second line that says the store is serving objects this toolchain no longer produces.
 *
 *  `cacheSampleNote()` carries the sampling RATE and the run's SEED, so a reader can tell an
 *  audited serve from an unaudited one and replay the exact selection
 *  (ASMLIFT_CANDCACHE_SAMPLE_SEED). Without it a run with the audit switched off would print the
 *  same line as one with it on. */
const candCacheLine = (): string => {
  if (cacheMode() === 'off') {
    return '';
  }
  const line = `asmlift: [candcache] ${cacheMode()}${cacheSampleNote()} ${JSON.stringify(cacheStats())}\n`;
  return cacheMismatches() === 0
    ? line
    : line +
        `asmlift: [candcache] ${cacheMismatches()} STORED ANSWER(S) DISAGREED WITH A FRESH COMPILE — ` +
        `the store is serving objects this toolchain no longer produces. See ${MISMATCH_LOG}\n`;
};

/** A declaration block as stderr lines: rendered, blank lines dropped, each one under the
 *  `asmlift:` prefix that separates this tool's output from the compiler's in a shared log. */
const indentedDeclarations = (refs: Parameters<typeof renderDeclarations>[0]): string =>
  renderDeclarations(refs)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => `asmlift:   ${l}\n`)
    .join('');

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
                   {"sym":{"params":2|["u8","s32"],"returnsVoid":true}} — a
                   callee's count gives its call-site arity, a typed list also
                   gives its widths, and the decompiled function's OWN entry
                   gives its void-ness
  --jobs           with --score-against: compile n candidates at a time (default 1)
  --progress       with --score-against: stream a liveness line to stderr while
                   scoring; the [score] table it prints at the end is unchanged

Exit codes: 0 clean/match · 1 gaps/declined/nonmatch · 3 the candidate-object cache served
            bytes a fresh compile disagrees with · 64 usage · 66 unreadable input.
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

/** Everything a ranked run writes to stderr, in the order a reader reads it.
 *
 *  A TIMING VALUE, never a timing call: `phaseReport` and `stamp` are computed by the caller at
 *  the moment the run ended, because both measure the run and neither may be re-measured by the
 *  act of rendering it. */
function rankedStderr(a: {
  targetTrace: string;
  warn: string;
  ranked: RankedResult;
  leverErrors: Map<string, string>;
  /** the probe's verdict: `true` = candidates compiled in the SELF-DECLARED world */
  selfDeclared: boolean;
  phaseReport: string;
  stamp: string;
  protoNote: string;
}): string {
  const { ranked } = a;
  const table = ranked.candidates
    .map((c) => `asmlift: [score] ${c.label}: ${c.score.score}${c.score.match ? ' (match)' : ''}\n`)
    .join('');
  // Spellings the scorer refused are recorded, not silent: a lever whose every candidate
  // fails to build looks identical to one that declined unless the drops are visible.
  // …and the same idea one stage EARLIER: `[dropped]` reports a spelling the SCORER refused,
  // which presumes the spelling was enumerated at all. A lever that threw produced no
  // candidate to drop.
  const levers = [...a.leverErrors]
    .map(([label, error]) => `asmlift: [lever] ${label} threw (no candidate from it): ${error}\n`)
    .join('');
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
  // headers world the block is dropped and the project's own declarations did the work, so the
  // COUNT is zero there whatever the fan named.
  const assumed = (ranked.best.symbolRefs ?? []).filter((r) => r.synthesized);
  const synthesized = a.selfDeclared ? assumed.length : 0;
  const declared =
    synthesized > 0
      ? `asmlift: [declared] ${synthesized} declaration(s) synthesized from the target asm — no symbol ` +
        `map knows these names, so the score is about this block plus the source; check it against your ` +
        `headers:\n` +
        indentedDeclarations(assumed)
      : '';
  // The counts docs/ranked-repro.md requires beside every ranked score, as ONE line that is
  // ALWAYS PRESENT. AN ABSENT LINE IS NOT EVIDENCE: a clean run, a truncated log and a killed
  // run are indistinguishable to a reader counting `[dropped]` lines that are not there, and
  // every published score in this loop rests on the claim those counts make. So each is
  // stated, including when it is zero. That covers `dropped`, `withheld`, and `synthesized` —
  // whose block above is conditional, so a `(match)` fitted to the target asm by declarations
  // asmlift invented would otherwise be publishable by pasting exactly the line the doc asks
  // for.
  //
  // …plus WHICH TREE produced them, because a run against different SOURCES is otherwise
  // indistinguishable from a clean one (provenance.ts). On the same line as the score
  // deliberately: the doc tells readers to quote this one line, so a stamp anywhere else is a
  // stamp nobody pastes.
  const summary =
    `asmlift: [ranked] ${ranked.candidates.length} candidate(s) scored, ${ranked.dropped.length} dropped, ` +
    `${ranked.withheld.length} withheld, ${synthesized} synthesized, ` +
    `best ${ranked.best.label}: ${ranked.best.score.score}${ranked.best.score.match ? ' (match)' : ''} ` +
    `[${a.stamp}]\n`;
  // …and where the time went, ABOVE the line readers paste, so `[ranked]` and its `[proto]`
  // tail stay adjacent.
  return (
    a.targetTrace +
    a.warn +
    table +
    levers +
    drops +
    held +
    declared +
    a.phaseReport +
    summary +
    a.protoNote +
    candCacheLine()
  );
}

/** A run that THREW, as its result. The stderr prefix is what separates a principled decline from
 *  a bug, and `tail` is the ranked path's `[candcache]` line — which belongs on a failure too,
 *  because a decline drops out before the success-path stderr is assembled and a reader would
 *  otherwise not learn that the store had disagreed. */
const failureResult = (e: unknown, targetTrace: string, warn: string, code: number, tail = ''): CliResult => {
  const kind = isDecline(e) ? 'declined' : 'internal error';
  return {
    code,
    stdout: '',
    stderr: `${targetTrace}${warn}asmlift: [${kind}] ${e instanceof Error ? e.message : String(e)}\n${tail}`,
  };
};

/** The project's symbol map — `tools.asmlift.elf` (derive from a built ELF) or
 *  `tools.asmlift.symbols` (a map already derived, as JSON) — or the CliResult that refuses the
 *  run. Every failure here is LOUD and none is a fallback: this is explicit config, and a map that
 *  quietly failed to load reads exactly like a project that never had one, while producing
 *  different source. */
async function loadProjectSymbolMap(
  toolCfg: AsmliftToolConfig | undefined,
  configDir: string | undefined,
): Promise<{ map: SymbolMap | undefined } | { failure: CliResult }> {
  const failure = (r: CliResult): { failure: CliResult } => ({ failure: r });
  // tools.asmlift.elf → the project's symbol map (names + declaration shapes). Explicit
  // config, so an unreadable ELF is a loud input error, never a silent names-less run.
  let symbols: SymbolMap | undefined;
  if (toolCfg?.elf && toolCfg?.symbols) {
    return failure({
      code: EXIT.usage,
      stdout: '',
      stderr:
        'asmlift: tools.asmlift declares BOTH elf and symbols — two sources for one map. ' +
        'Name the one this project has (elf: derive from the built ELF; symbols: a map already ' +
        'derived, as JSON).\n',
    });
  }
  if (toolCfg?.elf) {
    const elfPath = resolve(configDir!, toolCfg.elf);
    try {
      const { loadSymbolMap } = await import('./symbols-provider');
      symbols = await loadSymbolMap(elfPath);
    } catch (e) {
      return failure({
        code: EXIT.unreadable,
        stdout: '',
        stderr: `asmlift: cannot load symbols from tools.asmlift.elf (${elfPath}): ${e instanceof Error ? e.message : e}\n`,
      });
    }
  } else if (toolCfg?.symbols) {
    // The already-derived map. Same loudness rule as `tools.asmlift.elf`: explicit config, so an
    // unreadable or malformed file is an input error and never a silent names-less run — a map
    // that quietly failed to load reads exactly like a row that never had one, and the two
    // produce different source.
    const mapPath = resolve(configDir!, toolCfg.symbols);
    let parsed;
    try {
      const { parseSymbolMapJson } = await import('@asmlift/core/symbols');
      parsed = parseSymbolMapJson(JSON.parse(readFileSync(mapPath, 'utf8')));
    } catch (e) {
      return failure({
        code: EXIT.unreadable,
        stdout: '',
        stderr: `asmlift: cannot load symbols from tools.asmlift.symbols (${mapPath}): ${e instanceof Error ? e.message : e}\n`,
      });
    }
    // A file that PARSES and still declares nothing is the failure this key exists to prevent, and
    // it is the one an exception cannot report: `[]`, `{}` and `{"nope": []}` are all valid JSON
    // that reduce to an EMPTY map, which is byte-for-byte the state a map-less run is in. The run
    // would then exit 0 having scored a different source under a different label — a silent wrong
    // answer wearing a published repro script's provenance. Both shapes are input errors here.
    if ('error' in parsed) {
      return failure({
        code: EXIT.unreadable,
        stdout: '',
        stderr: `asmlift: tools.asmlift.symbols (${mapPath}) is not a symbol map — ${parsed.error}\n`,
      });
    }
    if (parsed.map.size === 0) {
      return failure({
        code: EXIT.unreadable,
        stdout: '',
        stderr: `asmlift: tools.asmlift.symbols (${mapPath}) declares no symbols — remove the key to run without a map\n`,
      });
    }
    symbols = parsed.map;
  }
  return { map: symbols };
}

/** `argv` read as this CLI's flags and its ONE operand — or the shape of the usage error, with
 *  `message` absent where the complaint is the operand count and the bare USAGE dump is the whole
 *  answer.
 *
 *  Order is part of the contract and not an accident of the loop: the FIRST unknown flag wins, and
 *  it wins over the operand count, so `asmlift --nmae x a b` names the typo rather than counting
 *  operands at someone who has not been told their flag was discarded. */
function parseFlags(
  argv: string[],
): { ok: true; flags: Map<string, string | true>; input: string } | { ok: false; message?: string } {
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
      return { ok: false, message: `unknown flag --${key}` };
    }
    if (BOOL_FLAGS.has(key)) {
      if (eq !== -1) {
        return { ok: false, message: `--${key} takes no value` };
      }
      flags.set(key, true);
      continue;
    }
    const v = eq === -1 ? args.shift() : a.slice(eq + 1);
    if (v === undefined) {
      return { ok: false, message: `missing value for --${key}` };
    }
    flags.set(key, v);
  }
  if (positional.length !== 1) {
    return { ok: false };
  }
  return { ok: true, flags, input: positional[0] };
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
  const usage = (msg: string) => ({ code: EXIT.usage, stdout: '', stderr: `asmlift: ${msg}\n${USAGE}\n` });
  const parsed = parseFlags(argv);
  if (!parsed.ok) {
    // A named complaint gets `usage(msg)`; the wrong number of operands gets the bare USAGE dump,
    // which is what a reader who typed nothing at all wants to see.
    return parsed.message === undefined
      ? { code: EXIT.usage, stdout: '', stderr: `${USAGE}\n` }
      : usage(parsed.message);
  }
  const { flags, input } = parsed;

  // decomp.yaml (decomp_settings): nearest ancestor of the INPUT file (cwd for stdin), or the
  // explicit --config path. Supplies the target when --target is absent, plus the
  // tools.asmlift payload (compile command, objdump override).
  let toolCfg: AsmliftToolConfig | undefined;
  let configDir: string | undefined;
  let targetKey: string;
  let targetTrace = '';
  try {
    const startDir = input === '-' ? undefined : dirname(resolve(input));
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
    return { code: EXIT.unreadable, stdout: '', stderr: `asmlift: ${e instanceof Error ? e.message : e}\n` };
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
    raw = readInput(input);
  } catch (e) {
    // a clean message on ITS OWN exit code — never a stack trace, never conflated with "gaps"
    return {
      code: EXIT.unreadable,
      stdout: '',
      stderr: `asmlift: cannot read ${input}: ${e instanceof Error ? e.message : e}\n`,
    };
  }

  // Object-file input: disassemble with the target's own objdump; the jump-table side-table
  // rides along for free. Extraction failure only WARNS — the side-table is optional (a dense
  // switch then declines loudly downstream), and the disassembly itself already succeeded.
  let asm: string;
  let asmData: AsmData | undefined;
  let warn = '';
  if (typeof raw !== 'string' && isElfObject(raw)) {
    if (input === '-') {
      return {
        code: EXIT.unreadable,
        stdout: '',
        stderr: 'asmlift: object-file input via stdin is not supported — pass a file path\n',
      };
    }
    const obj = objInput ?? {
      disasm: (path, t) => disasmObject(path, t, toolCfg?.objdump),
      asmData: (path, t) => asmDataForObject(path, t, toolCfg?.objdump),
    };
    try {
      asm = obj.disasm(input, target);
    } catch (e) {
      if (e instanceof ObjectInputUnsupportedError) {
        return { code: EXIT.gaps, stdout: '', stderr: `asmlift: [declined] ${e.message}\n` };
      }
      return {
        code: EXIT.unreadable,
        stdout: '',
        stderr: `asmlift: cannot disassemble ${input}: ${e instanceof Error ? e.message : e}\n`,
      };
    }
    try {
      asmData = obj.asmData(input, target);
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
        code: EXIT.unreadable,
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
    // A table INLINE (`--proto '{"sym":{"params":1}}'`) or the path to one. Both forms are
    // accepted because both are PUBLISHED: inline is what docs/ranked-repro.md's canonical command
    // uses, and what the `[proto]` note below prints as its own remedy. Reading only one of them
    // would make a documented command an unreadable-file error. (cli.test.ts pins both.)
    const inline = protoFlag.trimStart().startsWith('{');
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline ? protoFlag : readFileSync(resolve(protoFlag), 'utf8'));
    } catch (e) {
      return {
        code: EXIT.unreadable,
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

  const loadedMap = await loadProjectSymbolMap(toolCfg, configDir);
  if ('failure' in loadedMap) {
    return loadedMap.failure;
  }

  const name = nameFlag ?? detectName(asm);
  if (!name) {
    return {
      code: EXIT.usage,
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
  //
  // The FILTERED map is what the rest of this function has, under its own name; `loadedMap.map` is
  // the unfiltered one and stays visible on purpose, because the load has to happen ABOVE the name
  // detection — an unreadable ELF and an undetectable name are two different user-visible exits,
  // and swapping them would change which one a broken project sees first.
  const symbols = loadedMap.map === undefined ? undefined : asIfUndecompiled(loadedMap.map, name);

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
      return {
        code: EXIT.unreadable,
        stdout: '',
        stderr: `asmlift: cannot read --score-against object: ${scoreAgainst}\n`,
      };
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
      compilers = compilersFromCommand(toolCfg.compiler, {
        cwd: configDir,
        candidateCache: toolCfg.candidateCache,
      });
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
      // A lever that THREW is a defect and must not read as a lever that declined — core rank.ts
      // makes that argument for its own channel, and this is the consumer it had been missing.
      // Deduped by label: the enumeration walks a lever over every axis point, so one broken pass
      // would otherwise print thousands of identical lines. Silent when nothing threw.
      const leverErrors = new Map<string, string>();
      const rankOpts = {
        backend,
        asmData,
        prototypes,
        symbols,
        compile,
        onLeverError: (label: string, error: string) => {
          if (!leverErrors.has(label)) {
            leverErrors.set(label, error);
          }
        },
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
      const stamp = sourceStamp(treeBefore, sampleSourceTree(), bakedBuild());
      // Read AFTER the tree sample, which is work this run did and the clock should have charged.
      const phaseReport = clock?.report() ?? '';
      return {
        code: rankedExitCode(ranked.best.score.match),
        stdout: ranked.best.source,
        stderr: rankedStderr({
          targetTrace,
          warn,
          ranked,
          leverErrors,
          selfDeclared: compilers.selfDeclared() === true,
          phaseReport,
          stamp,
          protoNote,
        }),
      };
    } catch (e) {
      return failureResult(e, targetTrace, warn, rankedExitCode(false), candCacheLine());
    }
  }

  const onGap: OnGap = flags.has('strict') ? 'strict' : 'annotate';
  try {
    const result = decompile(name, asm, target, { backend, onGap, asmData, prototypes, symbols });
    // THE ASSUMPTIONS THE SOURCE RESTS ON, on the path that prints no declarations. Every other
    // spelling asmlift emits for a named global — `((T *)&gSym)[i]` — reproduces the target's
    // bytes under ANY declaration of that name, so the source alone is the whole answer. A bare
    // `gSym[i]` is not: it means what the DECLARATION of `gSym` says, and where that shape was
    // derived from the assembly (raise/globalshape.ts) rather than read from a symbol map, the
    // element's SIGNEDNESS in particular is a pick and not a reading — `(u16)gS[i]` over an
    // `extern const s16 gS[]` and `gS[i]` over an `extern const u16 gS[]` compile to the same
    // object under agbcc. The ranked path already states this in `[declared]`; without this line
    // the plain path would hand a user a subscript to paste into a project whose own header may
    // mean something else by it, with nothing said.
    const assumedNote =
      result.assumedSymbols.length === 0
        ? ''
        : `asmlift: [assumed] ${result.assumedSymbols.length} array shape(s) derived from this assembly — the ` +
          `source spells them BARE, so it is about these declarations; check them against your headers:\n` +
          indentedDeclarations(result.assumedSymbols.map((info) => ({ name: info.name, info })));
    const stderr =
      targetTrace +
      warn +
      result.diagnostics.map((d) => `asmlift: [${d.stage}] ${d.reason}\n`).join('') +
      assumedNote +
      protoNote;
    return { code: result.diagnostics.length === 0 ? EXIT.clean : EXIT.gaps, stdout: result.source, stderr };
  } catch (e) {
    return failureResult(e, targetTrace, warn, EXIT.gaps);
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
