// asmlift — the compiler flags a run is about, and where they came from.
//
// One resolver serves both halves of a run. The flags it finds fill the compile command's
// `{{cflags}}` word for word, and core parses the same words into the profile the run reports. The
// first source that gives flags wins, and the `[flags]` line names it:
//   1. --cflags "<flags>"
//   2. the dtk unit whose target object defines the function, in the `objdiff.json` beside
//      decomp.yaml (dtk-unit.ts): its `scratch.c_flags`, compiled by its `scratch.compiler`
//   3. the flags already written in tools.asmlift.compiler, read off the words after the compiler
//      binary, wherever a wrapper (`docker run … wibo`) puts it
//   4. none: a plain decompile assumes the toolchain's canonical flags and says so; a ranked run
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

import { targetSetting } from './config';
import type { DtkLookup } from './dtk-unit';
import { type ShellWord, shellCommands } from './shell-text';

/** The names a family's compiler binary is run by. */
const COMPILER_BINARIES: Record<FlagFamily, readonly string[]> = {
  agbcc: ['agbcc', 'old_agbcc', 'cc1'],
  ido: ['cc'],
  gcc: ['gcc', 'cc1'],
  mwcc: ['mwcceppc.exe'],
};

/** The environment a command runs under. */
export type CommandEnv = Readonly<Record<string, string | undefined>>;

/** The name of the variable a word is, when it is exactly `$NAME` or `${NAME}`. */
const variableName = (value: string): string | undefined => {
  const variable = /^\$(?:(\w+)|\{(\w+)\})$/.exec(value);
  return variable === null ? undefined : (variable[1] ?? variable[2]);
};

/** The program a word runs: the word, or the value of the variable it is, since the shell runs the command
 *  under the same environment. */
const programPath = (value: string, env: CommandEnv): string => {
  const name = variableName(value);
  return name === undefined ? value : (env[name] ?? value);
};

/** The variables a command's words run as a program that the environment does not set (`$AGBCC`). */
function unsetPrograms(command: string, env: CommandEnv): string[] {
  return shellCommands(command).flatMap((words) => {
    const program = words.find((w) => !/^\w+=/.test(w.value));
    const name = program === undefined ? undefined : variableName(program.value);
    return name !== undefined && env[name] === undefined ? [`$${name}`] : [];
  });
}

/** The variables a command assigns itself (`CFLAGS=-O2; agbcc $CFLAGS`), whose values the environment
 *  does not hold. */
function assignedNames(command: string): Set<string> {
  const names = new Set<string>();
  for (const words of shellCommands(command)) {
    for (const w of words[0]?.value === 'export' ? words.slice(1) : words) {
      const assignment = /^(\w+)=/.exec(w.value);
      if (assignment === null) {
        break;
      }
      names.add(assignment[1]);
    }
  }
  return names;
}

/** The words a word after the compiler gives it: a variable is read through `env` and split into words
 *  unless it is quoted, an unset one giving none, as the shell expands it. Each keeps the variable's
 *  place in the command. */
function expanded(command: string, word: ShellWord, env: CommandEnv): ShellWord[] {
  const name = variableName(word.value);
  if (name === undefined) {
    return [word];
  }
  const value = env[name] ?? '';
  const parts = command[word.start] === '"' ? [value] : value.split(/\s+/).filter((part) => part !== '');
  return parts.map((part) => ({ ...word, value: part }));
}

/** Whether `words[k]` runs the family's compiler: a path whose last component is one of its binaries.
 *  An assignment (`COMPILER_PATH=/kmc/gcc`), a container mount (`-v /opt/gcc:/gcc`) and the argument of
 *  an option (`-I tools/agbcc`) only name one. */
const runsCompiler = (words: readonly ShellWord[], k: number, family: FlagFamily, env: CommandEnv): boolean => {
  const value = programPath(words[k].value, env);
  const previous = words[k - 1]?.value;
  return (
    !value.includes('=') &&
    !value.includes(':/') &&
    !(previous !== undefined && previous.startsWith('-') && !previous.includes('=')) &&
    COMPILER_BINARIES[family].includes(value.split(/[/\\]/).at(-1)!.toLowerCase())
  );
};

/** A run with one of these words preprocesses or checks its input and compiles nothing, as a Makefile
 *  recipe does before the compile proper (`gcc -E … | gcc -c …`, a `-fsyntax-only` lint pass). */
const COMPILES_NOTHING: ReadonlySet<string> = new Set(['-E', '-fsyntax-only']);

/** How many of the units, or modules, that define a function a refusal names before "and N more". */
const AMBIGUOUS_SHOWN = 5;

/** The compiler's words in a compile command. */
export interface CommandReading {
  /** the word that runs the compiler */
  binary: ShellWord;
  /** its codegen flags and their arguments, in command order; the words of a variable share its place */
  flagWords: readonly ShellWord[];
  /** the variables among its words that the command assigns itself, so their words are unread */
  unread: readonly ShellWord[];
  /** whether its words take `{{cflags}}` */
  takesCflags: boolean;
}

/** The first command that compiles with the family's compiler, with its flags: every word after the
 *  binary except `-o` and its argument, a word naming a `{{…}}` path, an operand (the file it
 *  compiles) and an inert word. asm-processor's `<compiler> -- <assembler words> -- <flags>` puts
 *  the flags after the second `--`. A variable, naming the compiler or giving it words, is read
 *  through `env`. `undefined` when no command compiles with the compiler. Throws `UnreadableLevelError`
 *  on a level word the family cannot read. */
export function readCompilerCommand(
  command: string,
  family: FlagFamily,
  env: CommandEnv = {},
): CommandReading | undefined {
  for (const words of shellCommands(command)) {
    const at = words.findIndex((_, k) => runsCompiler(words, k, family, env));
    if (at === -1 || words.some((w) => COMPILES_NOTHING.has(w.value))) {
      continue;
    }
    let from = at + 1;
    if (words[from]?.value === '--') {
      const second = words.findIndex((w, k) => k > from && w.value === '--');
      from = second === -1 ? words.length : second + 1;
    }
    const assigned = assignedNames(command);
    const after = words.slice(from);
    const candidates: ShellWord[] = [];
    const unread: ShellWord[] = [];
    for (let k = 0; k < after.length; k++) {
      const name = variableName(after[k].value);
      if (after[k].value === '-o') {
        k++;
      } else if (name !== undefined && assigned.has(name)) {
        unread.push(after[k]);
      } else if (!after[k].value.includes('{{')) {
        candidates.push(...expanded(command, after[k], env));
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
      unread,
      takesCflags: after.some((w) => w.value.includes('{{cflags}}')),
    };
  }
  return undefined;
}

/** The codegen flags a command gives the family's compiler, in core's normal form and command order, or
 *  `undefined` when no command compiles with it. Throws as `readCompilerCommand` does. */
export function commandFlags(command: string, family: FlagFamily, env: CommandEnv = {}): string[] | undefined {
  const reading = readCompilerCommand(command, family, env);
  return (
    reading &&
    storedFlags(
      family,
      reading.flagWords.map((w) => w.value),
    )
  );
}

/** The command without `words`, each place removed once with the blanks before it. */
function withoutWords(command: string, words: readonly ShellWord[]): string {
  let out = command;
  const places = [...new Map(words.map((w) => [w.start, w])).values()].sort((a, b) => a.start - b.start);
  for (const w of places.reverse()) {
    let start = w.start;
    while (start > 0 && (out[start - 1] === ' ' || out[start - 1] === '\t')) {
      start--;
    }
    out = out.slice(0, start) + out.slice(w.end);
  }
  return out;
}

/** The command with its compiler's flag words replaced by one `{{cflags}}`. */
export function withCflagsWord(command: string, reading: CommandReading): string {
  const [first, ...rest] = reading.flagWords;
  if (first === undefined) {
    const at = reading.binary.end;
    return `${command.slice(0, at)} {{cflags}}${command.slice(at)}`;
  }
  const out = withoutWords(
    command,
    rest.filter((w) => w.start !== first.start),
  );
  return `${out.slice(0, first.start)}{{cflags}}${out.slice(first.end)}`;
}

/** A `compiler:` line to paste into decomp.yaml. */
const compilerLine = (command: string): string => YAML.stringify({ compiler: command }, { lineWidth: 0 }).trimEnd();

export interface FlagsInput {
  toolchain: ToolchainId;
  /** `--cflags`, as typed */
  cflags: string | undefined;
  /** `tools.asmlift.compiler` */
  command: string | undefined;
  /** the environment the command runs under, where a variable can name the compiler (`"$AGBCC"`) */
  env: CommandEnv;
  /** an `objdiff.json` at or above the input that nothing reads, because no decomp.yaml sits beside it */
  unreadObjdiff: string | undefined;
  /** the decomp.yaml the command is written in */
  configPath: string | undefined;
  /** `--score-against`: the command compiles every candidate */
  ranked: boolean;
  /** the `objdiff.json` lookup for the function, when the project has one and `--cflags` is absent */
  dtk: { symbol: string; module: string | undefined; lookup: DtkLookup } | undefined;
}

type Refusal = { ok: false; message: string };

export type FlagsResolution =
  | {
      ok: true;
      /** the words that fill the command's `{{cflags}}`; absent when the command spells its own */
      fill: readonly string[] | undefined;
      /** the compiler name that fills the command's `{{cc}}` */
      cc: string | undefined;
      resolved: ResolvedTarget;
      /** the `[flags]` lines */
      lines: string;
    }
  | Refusal;

/** A refusal of a level word, naming every target whose compiler spells its levels that way. */
function levelRefusal(source: string, e: UnreadableLevelError): Refusal {
  const readers = Object.keys(TOOLCHAIN_TARGETS)
    .filter(isToolchainId)
    .filter((id) => TOOLCHAIN_TARGETS[id].family === e.spelledBy);
  const hint = readers.length === 0 ? '' : `; did you mean ${readers.map((id) => `--target ${id}`).join(' or ')}?`;
  return { ok: false, message: `${source}: ${e.message}${hint}` };
}

/** Runs `f`, turning a level refusal into the resolver's refusal. */
function orLevelRefusal<T>(source: string, f: () => T): T | Refusal {
  try {
    return f();
  } catch (e) {
    if (e instanceof UnreadableLevelError) {
      return levelRefusal(source, e);
    }
    throw e;
  }
}

const isRefusal = (v: unknown): v is Refusal =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

/** A flag string as words, or the refusal naming its source. */
function words(source: string, text: string): string[] | Refusal {
  try {
    return tokenizeFlags(text);
  } catch (e) {
    return { ok: false, message: `${source}: ${e instanceof Error ? e.message : e}` };
  }
}

/** The flags a run is about, or the refusal that stops it. */
export function resolveFlags(input: FlagsInput): FlagsResolution {
  const { toolchain, command, env, ranked, dtk } = input;
  const { family, canonicalFlags } = TOOLCHAIN_TARGETS[toolchain];
  const takesCflags = command?.includes('{{cflags}}') === true;
  const takesCc = command?.includes('{{cc}}') === true;
  /** what the source of the flags is, said under the head */
  const notes: string[] = [];
  /** what to do before a ranked run, said after the profile's own notes */
  const advice: string[] = [];
  if (input.unreadObjdiff !== undefined && input.cflags === undefined) {
    notes.push(
      `note: ${input.unreadObjdiff} is not read: asmlift reads a dtk unit's flags from the objdiff.json beside ` +
        `decomp.yaml; a decomp.yaml with ${targetSetting(toolchain)} beside it is enough`,
    );
  }

  let cflags: readonly string[] | undefined;
  let cc: string | undefined;
  let source = '';
  let unread = false;
  if (input.cflags !== undefined) {
    const argv = words('--cflags', input.cflags);
    if (isRefusal(argv)) {
      return argv;
    }
    if (argv.length === 0) {
      return {
        ok: false,
        message: ranked
          ? '--cflags is empty; --score-against compiles every candidate with the flags it gives'
          : `--cflags is empty; leave it out to decompile at ${toolchain}'s canonical flags`,
      };
    }
    cflags = argv;
    source = '--cflags';
  } else if (dtk?.lookup.kind === 'found') {
    const { unit } = dtk.lookup;
    source = `objdiff.json unit ${unit.name}`;
    if (unit.compiler !== toolchain && !takesCc) {
      const known = isToolchainId(unit.compiler);
      const escapes = [
        ...(known ? [`pass --target ${unit.compiler}`] : []),
        ...(command !== undefined || ranked
          ? [
              "write {{cc}} in tools.asmlift.compiler where the compiler's name goes to compile with the unit's compiler",
            ]
          : []),
        `pass --cflags ${shellJoinFlags([unit.cflags])} to give the unit's flags yourself`,
      ];
      return {
        ok: false,
        message:
          `${source} is compiled by ${unit.compiler}, and the target is ${toolchain}` +
          `${known ? '' : `; asmlift has no ${unit.compiler} target`}: ` +
          (escapes.length === 1 ? escapes[0] : `${escapes.slice(0, -1).join(', ')}, or ${escapes.at(-1)}`),
      };
    }
    const argv = words(source, unit.cflags);
    if (isRefusal(argv)) {
      return argv;
    }
    cflags = argv;
    cc = takesCc ? unit.compiler : undefined;
  } else if (dtk?.lookup.kind === 'ambiguous') {
    const { units } = dtk.lookup;
    const modules = [...new Set(units.map((u) => u.name.split('/')[0]))];
    // one unit per module: the modules are what --module chooses among
    const byModule = dtk.module === undefined && modules.length === units.length;
    const names = byModule ? modules : units.map((u) => u.name);
    const shown =
      names.slice(0, AMBIGUOUS_SHOWN).join(', ') +
      (names.length > AMBIGUOUS_SHOWN ? `, and ${names.length - AMBIGUOUS_SHOWN} more` : '');
    const choose = dtk.module === undefined ? 'pass --module <module> to choose one, or --cflags' : 'pass --cflags';
    return {
      ok: false,
      message: byModule
        ? `${dtk.symbol} is defined by an objdiff.json unit in each of ${modules.length} modules (${shown}); ${choose}`
        : `${dtk.symbol} is defined by ${units.length} objdiff.json units (${shown}); ${choose}`,
    };
  } else {
    if (dtk?.lookup.kind === 'none') {
      const inModule = dtk.module === undefined ? '' : ` in module ${dtk.module}`;
      const unbuilt = dtk.lookup.unbuilt === 0 ? '' : ` (${dtk.lookup.unbuilt} units have no target object to read)`;
      const next = command !== undefined && !takesCflags ? '; reading the compiler command' : '';
      notes.push(`note: objdiff.json has no unit defining ${dtk.symbol}${inModule}${unbuilt}${next}`);
    }
    if (command !== undefined && !takesCflags) {
      const reading = orLevelRefusal('tools.asmlift.compiler', () => readCompilerCommand(command, family, env));
      if (isRefusal(reading)) {
        return reading;
      }
      if (reading === undefined) {
        unread = true;
        const unset = unsetPrograms(command, env);
        notes.push(
          unset.length === 0
            ? `note: tools.asmlift.compiler runs no ${family} compiler asmlift can find, so its flags are unread: ${command}`
            : `note: tools.asmlift.compiler runs ${unset.join(', ')}, which asmlift's environment does not set, so its flags are unread`,
        );
      } else {
        cflags = reading.flagWords.map((w) => w.value);
        source = 'compiler command';
        if (reading.unread.length > 0) {
          notes.push(
            `note: tools.asmlift.compiler sets ${reading.unread.map((w) => w.value).join(', ')} itself and passes it to ` +
              'the compiler, so the flags in it are unread',
          );
        }
      }
    } else if (ranked && takesCflags) {
      return {
        ok: false,
        message:
          'tools.asmlift.compiler takes its flags through {{cflags}}, and nothing gives them: ' +
          'pass --cflags "<the flags your build compiles this file with>"',
      };
    }
  }

  const given = source === '--cflags' || source.startsWith('objdiff.json');
  if (!ranked && given && command !== undefined && !takesCflags) {
    // a plain decompile runs no command, so it is not refused; the ranked run with the same inputs is
    const own = orLevelRefusal('tools.asmlift.compiler', () => commandFlags(command, family, env));
    const ownWords = isRefusal(own) || own === undefined ? [] : own;
    if (ownWords.length > 0 && ownWords.join(' ') !== storedFlags(family, cflags ?? []).join(' ')) {
      advice.push(
        `note: this decompile reads the flags ${source === '--cflags' ? 'from --cflags' : `of ${source}`}, not the ` +
          `${shellJoinFlags(ownWords)} in tools.asmlift.compiler; write {{cflags}} there before --score-against`,
      );
    }
  }
  if (ranked && command !== undefined) {
    if (given) {
      const refusal = commandTakesFlags(command, family, source, input.configPath, env);
      if (refusal !== undefined) {
        return refusal;
      }
    }
    if (takesCc && cc === undefined) {
      const why =
        input.cflags !== undefined
          ? '--cflags gives the flags without one'
          : dtk === undefined
            ? 'there is no objdiff.json beside decomp.yaml'
            : `no objdiff.json unit defines ${dtk.symbol}`;
      return {
        ok: false,
        message: `tools.asmlift.compiler takes an objdiff.json unit's compiler through {{cc}}, and ${why}`,
      };
    }
  }

  const resolved = orLevelRefusal(source || 'tools.asmlift.compiler', () =>
    targetFor(toolchain, cflags ?? canonicalFlags),
  );
  if (isRefusal(resolved)) {
    return resolved;
  }
  const head =
    cflags === undefined
      ? `${unread ? 'unread (compiler command)' : 'none given'}: decompiling at ${toolchain}'s canonical flags ${shellJoinFlags(canonicalFlags)}; ` +
        'pass --cflags if your build differs'
      : cflags.length === 0
        ? `no codegen flags (${source})`
        : `${shellJoinFlags(effectiveFlags(family, storedFlags(family, cflags)))} (${source})`;
  const { overrides, implied, unclassified } = resolved.profile;
  const lines = [
    head,
    ...notes,
    ...[...overrides, ...implied].map((o) => `note: ${o}`),
    ...advice,
    ...(unclassified.length === 0
      ? []
      : [
          `not in asmlift's flag table${ranked ? ', passed to the compiler verbatim' : ''}: ${shellJoinFlags(unclassified)}`,
        ]),
  ];
  return {
    ok: true,
    fill: takesCflags && given ? cflags : undefined,
    cc,
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
  env: CommandEnv,
): Refusal | undefined {
  const where = configPath === undefined ? 'tools.asmlift.compiler' : `tools.asmlift.compiler in ${configPath}`;
  let reading: CommandReading | undefined;
  try {
    reading = readCompilerCommand(command, family, env);
  } catch (e) {
    if (!(e instanceof UnreadableLevelError)) {
      throw e;
    }
  }
  if (!command.includes('{{cflags}}')) {
    const unset = unsetPrograms(command, env);
    const fix =
      reading !== undefined
        ? `Write {{cflags}} where the command spells its flags:\n${compilerLine(withCflagsWord(command, reading))}`
        : unset.length === 0
          ? 'Write {{cflags}} where the command passes the compiler its flags.'
          : `It runs ${unset.join(', ')}, which asmlift's environment does not set: set it, and write {{cflags}} ` +
            'where the command passes the compiler its flags.';
    return { ok: false, message: `${source} gives the flags, and ${where} has no {{cflags}} to take them. ${fix}` };
  }
  if (reading !== undefined && reading.unread.length > 0) {
    const names = reading.unread.map((w) => w.value).join(', ');
    return {
      ok: false,
      message:
        `${where} passes ${names} beside {{cflags}}, and sets it itself, so asmlift cannot read whether it is a ` +
        `second source of flags: give the flags in ${source} and remove ${names} from the command:\n` +
        compilerLine(withoutWords(command, reading.unread)),
    };
  }
  if (reading !== undefined && reading.flagWords.length > 0) {
    return {
      ok: false,
      message:
        `${where} spells ${shellJoinFlags(reading.flagWords.map((w) => w.value))} beside {{cflags}}, a second source ` +
        `of flags: give them in ${source} and remove them from the command:\n` +
        compilerLine(withoutWords(command, reading.flagWords)),
    };
  }
  return undefined;
}
