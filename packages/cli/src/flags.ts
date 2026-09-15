// asmlift — the compiler flags a run is about, and where they came from.
//
// One resolver serves both halves of a run. The flags it finds fill the compile command's
// `{{cflags}}` word for word, and core parses the same words into the profile the run reports. The
// first source that gives flags wins, and the `[flags]` line names it:
//   1. --cflags "<flags>"
//   2. the flags already written in tools.asmlift.compiler, read off the words after the compiler
//      binary, wherever a wrapper (`docker run … wibo`) puts it
//   3. none: a plain decompile assumes the toolchain's canonical flags and says so; a ranked run
//      whose command takes `{{cflags}}` refuses
// Every refusal is one message, with no usage block, because it names its own fix.
import {
  type FlagFamily,
  UnreadableLevelError,
  effectiveFlags,
  parseFlags,
  shellJoinFlags,
  storedFlags,
  tokenizeFlags,
} from '@asmlift/core/codegen-flags';
import {
  type ResolvedTarget,
  TOOLCHAIN_TARGETS,
  type ToolchainId,
  isToolchainId,
  targetFor,
} from '@asmlift/core/target';
import YAML from 'yaml';

import { type ShellWord, shellCommands } from './shell-text';

/** The names a family's compiler binary is run by. */
const COMPILER_BINARIES: Record<FlagFamily, readonly string[]> = {
  agbcc: ['agbcc', 'old_agbcc', 'cc1'],
  ido: ['cc'],
  gcc: ['gcc', 'cc1'],
  mwcc: ['mwcceppc.exe'],
};

/** A word that runs the family's compiler: a path whose last component is one of its binaries. An
 *  assignment (`COMPILER_PATH=/kmc/gcc`) and a container mount (`-v /opt/gcc:/gcc`) only name one. */
const runsCompiler = (value: string, family: FlagFamily): boolean =>
  !value.includes('=') &&
  !value.includes(':/') &&
  COMPILER_BINARIES[family].includes(value.split(/[/\\]/).at(-1)!.toLowerCase());

/** The compiler's words in a compile command. */
export interface CommandReading {
  /** the word that runs the compiler */
  binary: ShellWord;
  /** its codegen flags and their arguments, in command order */
  flagWords: readonly ShellWord[];
  /** whether its words take `{{cflags}}` */
  takesCflags: boolean;
}

/** The first command that runs the family's compiler, with its flags: every word after the binary
 *  except `-o` and its argument, a word naming a `{{…}}` path, an operand (the file it compiles)
 *  and an inert word. `undefined` when no command runs the compiler. Throws `UnreadableLevelError`
 *  on a level word the family cannot read. */
export function readCompilerCommand(command: string, family: FlagFamily): CommandReading | undefined {
  for (const words of shellCommands(command)) {
    const at = words.findIndex((w) => runsCompiler(w.value, family));
    if (at === -1) {
      continue;
    }
    const after = words.slice(at + 1);
    const candidates: ShellWord[] = [];
    for (let k = 0; k < after.length; k++) {
      if (after[k].value === '-o') {
        k++;
      } else if (!after[k].value.includes('{{')) {
        candidates.push(after[k]);
      }
    }
    const profile = parseFlags(
      family,
      candidates.map((w) => w.value),
    );
    const notFlags = new Set([...profile.inertAt, ...profile.operandAt]);
    return {
      binary: words[at],
      flagWords: candidates.filter((_, k) => !notFlags.has(k)),
      takesCflags: after.some((w) => w.value.includes('{{cflags}}')),
    };
  }
  return undefined;
}

/** The command with its compiler's flag words replaced by one `{{cflags}}`. */
export function withCflagsWord(command: string, reading: CommandReading): string {
  const [first, ...rest] = reading.flagWords;
  if (first === undefined) {
    const at = reading.binary.end;
    return `${command.slice(0, at)} {{cflags}}${command.slice(at)}`;
  }
  let out = command;
  for (const w of rest.reverse()) {
    let start = w.start;
    while (start > first.end && (out[start - 1] === ' ' || out[start - 1] === '\t')) {
      start--;
    }
    out = out.slice(0, start) + out.slice(w.end);
  }
  return `${out.slice(0, first.start)}{{cflags}}${out.slice(first.end)}`;
}

export interface FlagsInput {
  toolchain: ToolchainId;
  /** `--cflags`, as typed */
  cflags: string | undefined;
  /** `tools.asmlift.compiler` */
  command: string | undefined;
  /** the decomp.yaml the command is written in */
  configPath: string | undefined;
  /** `--score-against`: the command compiles every candidate */
  ranked: boolean;
}

export type FlagsResolution =
  | {
      ok: true;
      /** the words that fill the command's `{{cflags}}`; absent when the command spells its own */
      fill: readonly string[] | undefined;
      resolved: ResolvedTarget;
      /** the `[flags]` lines */
      lines: string;
    }
  | { ok: false; message: string };

/** A refusal of a level word, naming every target whose compiler spells its levels that way. */
function levelRefusal(source: string, e: UnreadableLevelError): { ok: false; message: string } {
  const readers = Object.keys(TOOLCHAIN_TARGETS)
    .filter(isToolchainId)
    .filter((id) => TOOLCHAIN_TARGETS[id].family === e.spelledBy);
  const hint = readers.length === 0 ? '' : `; did you mean ${readers.map((id) => `--target ${id}`).join(' or ')}?`;
  return { ok: false, message: `${source}: ${e.message}${hint}` };
}

/** Runs `f`, turning a level refusal into the resolver's refusal. */
function orLevelRefusal<T>(source: string, f: () => T): T | { ok: false; message: string } {
  try {
    return f();
  } catch (e) {
    if (e instanceof UnreadableLevelError) {
      return levelRefusal(source, e);
    }
    throw e;
  }
}

const isRefusal = (v: unknown): v is { ok: false; message: string } =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

/** The flags a run is about, or the refusal that stops it. */
export function resolveFlags(input: FlagsInput): FlagsResolution {
  const { toolchain, command, ranked } = input;
  const { family, canonicalFlags } = TOOLCHAIN_TARGETS[toolchain];
  const takesCflags = command?.includes('{{cflags}}') === true;
  const notes: string[] = [];

  let cflags: readonly string[] | undefined;
  let source = '';
  if (input.cflags !== undefined) {
    let argv: string[];
    try {
      argv = tokenizeFlags(input.cflags);
    } catch (e) {
      return { ok: false, message: `--cflags: ${e instanceof Error ? e.message : e}` };
    }
    if (argv.length === 0) {
      return {
        ok: false,
        message: ranked
          ? '--cflags is empty; --score-against compiles every candidate with the flags it gives'
          : `--cflags is empty; leave it out to decompile at ${toolchain}'s canonical flags`,
      };
    }
    if (ranked && command !== undefined) {
      const refusal = commandTakesFlags(command, family, '--cflags', input.configPath);
      if (refusal !== undefined) {
        return refusal;
      }
    }
    cflags = argv;
    source = '--cflags';
  } else if (command !== undefined && !takesCflags) {
    const reading = orLevelRefusal('tools.asmlift.compiler', () => readCompilerCommand(command, family));
    if (isRefusal(reading)) {
      return reading;
    }
    if (reading === undefined) {
      notes.push(
        `note: tools.asmlift.compiler runs no ${family} compiler asmlift can find, so its flags are unread: ${command}`,
      );
    } else {
      cflags = reading.flagWords.map((w) => w.value);
      source = 'compiler command';
    }
  } else if (ranked && takesCflags) {
    return {
      ok: false,
      message:
        'tools.asmlift.compiler takes its flags through {{cflags}}, and nothing gives them: ' +
        'pass --cflags "<the flags your build compiles this file with>"',
    };
  }

  const resolved = orLevelRefusal(source || 'tools.asmlift.compiler', () =>
    targetFor(toolchain, cflags ?? canonicalFlags),
  );
  if (isRefusal(resolved)) {
    return resolved;
  }
  const head =
    cflags === undefined
      ? `none given: decompiling at ${toolchain}'s canonical flags ${shellJoinFlags(canonicalFlags)}; ` +
        'pass --cflags if your build differs'
      : cflags.length === 0
        ? `no codegen flags (${source})`
        : `${shellJoinFlags(effectiveFlags(family, storedFlags(family, cflags)))} (${source})`;
  const { overrides, implied, unclassified } = resolved.profile;
  const lines = [
    head,
    ...notes,
    ...[...overrides, ...implied].map((o) => `note: ${o}`),
    ...(unclassified.length === 0
      ? []
      : [
          `not in asmlift's flag table${ranked ? ', passed to the compiler verbatim' : ''}: ${shellJoinFlags(unclassified)}`,
        ]),
  ];
  return {
    ok: true,
    fill: takesCflags && input.cflags !== undefined ? cflags : undefined,
    resolved,
    lines: lines.map((l) => `asmlift: [flags] ${l}\n`).join(''),
  };
}

/** The refusal when flags from `source` cannot reach the compiler through `command`: the command
 *  has no `{{cflags}}` (answered with a copy of it that has one), or spells codegen flags of its own
 *  beside it. */
function commandTakesFlags(
  command: string,
  family: FlagFamily,
  source: string,
  configPath: string | undefined,
): { ok: false; message: string } | undefined {
  const where = configPath === undefined ? 'tools.asmlift.compiler' : `tools.asmlift.compiler in ${configPath}`;
  let reading: CommandReading | undefined;
  try {
    reading = readCompilerCommand(command, family);
  } catch (e) {
    if (!(e instanceof UnreadableLevelError)) {
      throw e;
    }
  }
  if (!command.includes('{{cflags}}')) {
    const fix =
      reading === undefined
        ? 'Write {{cflags}} where the command passes the compiler its flags.'
        : `Write {{cflags}} where the command spells its flags:\n${YAML.stringify(
            { compiler: withCflagsWord(command, reading) },
            { lineWidth: 0 },
          ).trimEnd()}`;
    return { ok: false, message: `${source} gives the flags, and ${where} has no {{cflags}} to take them. ${fix}` };
  }
  const own = reading?.flagWords.map((w) => w.value) ?? [];
  if (own.length > 0) {
    return {
      ok: false,
      message:
        `${where} spells ${shellJoinFlags(own)} beside {{cflags}}, a second source of flags: ` +
        `give them in ${source} and remove them from the command`,
    };
  }
  return undefined;
}
