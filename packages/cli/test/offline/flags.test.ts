// The compiler flags a run is about (src/flags.ts): read off a project's compile command, given with
// --cflags, or assumed at the target's canonical flags — and every refusal, at the CLI surface too.
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import YAML from 'yaml';

import { type FlagsInput, readCompilerCommand, resolveFlags, withCflagsWord } from '../../src/flags';
import { runCli } from '../../src/main';

const flagsOf = (command: string, family: 'agbcc' | 'ido' | 'gcc' | 'mwcc') =>
  readCompilerCommand(command, family)?.flagWords.map((w) => w.value);

/** A pret-style GBA compile script, as a project writes it: variables, continuations, a second
 *  command that is not the compiler. */
const SCRIPT = `ASM_DIR="$(dirname "{{outputPath}}")"
PRE_FILE="$ASM_DIR/$(basename "{{outputPath}}" .o).i"
ASM_FILE="$ASM_DIR/$(basename "{{outputPath}}" .o).s"

arm-none-eabi-cpp \\
  -nostdinc -I tools/agbcc/include -iquote include \\
  "{{inputPath}}" -o "$PRE_FILE"

./tools/agbcc/bin/agbcc \\
  "$PRE_FILE" -o "$ASM_FILE" \\
  -mthumb-interwork -Wimplicit -Wparentheses \\
  -O2 -fhex-asm -fprologue-bugfix

arm-none-eabi-as -mcpu=arm7tdmi -mthumb-interwork \\
  "$ASM_FILE" -o "{{outputPath}}"
`;

describe('reading the flags a compile command spells', () => {
  test('the words after the compiler binary, without its operands, output and diagnostics', () => {
    expect(flagsOf(SCRIPT, 'agbcc')).toEqual(['-mthumb-interwork', '-O2', '-fhex-asm', '-fprologue-bugfix']);
    expect(
      flagsOf(
        'cpp -P -nostdinc {{inputPath}} > {{inputPath}}.pp.c 2>/dev/null; agbcc {{inputPath}}.pp.c -o {{inputPath}}.s -O1 && as {{inputPath}}.s -o {{outputPath}}',
        'agbcc',
      ),
    ).toEqual(['-O1']);
  });

  test('through a container wrapper, past a mount and an assignment that name a compiler path', () => {
    const kmc =
      'docker run --rm -v /opt/gcc:/gcc -e COMPILER_PATH=/kmc/gcc img /kmc/gcc -nostdinc -w -mips3 -G 0 -O2 ' +
      '-c -o "/work/$(basename {{outputPath}})" "/work/$(basename {{inputPath}})"';
    expect(flagsOf(kmc, 'gcc')).toEqual(['-mips3', '-G', '0', '-O2']);
    const mwcc =
      "docker run --rm img wibo /mwcc/mwcceppc.exe '-pragma' 'msg_show_realref off' -c -nostdinc -stderr " +
      "-proc gekko -O4,p -pragma 'cats off' -str reuse,readonly -o {{outputPath}} {{inputPath}}";
    expect(flagsOf(mwcc, 'mwcc')).toEqual(['-proc', 'gekko', '-O4,p', '-str', 'reuse,readonly']);
  });

  test("a command that runs no compiler of the target's family reads nothing", () => {
    expect(readCompilerCommand(SCRIPT, 'ido')).toBeUndefined();
    expect(readCompilerCommand('./build.sh {{inputPath}} {{outputPath}}', 'agbcc')).toBeUndefined();
  });

  test('{{cflags}} is seen, and is not a flag', () => {
    const r = readCompilerCommand('cc -c -Xcpluscomm {{cflags}} -o {{outputPath}} {{inputPath}}', 'ido');
    expect(r?.takesCflags).toBe(true);
    expect(r?.flagWords).toEqual([]);
  });

  test('the flags replaced by one {{cflags}} leave the rest of the command as written', () => {
    const rewritten = withCflagsWord(SCRIPT, readCompilerCommand(SCRIPT, 'agbcc')!);
    expect(rewritten).toBe(
      SCRIPT.replace(
        '-mthumb-interwork -Wimplicit -Wparentheses \\\n  -O2 -fhex-asm -fprologue-bugfix',
        '{{cflags}} -Wimplicit -Wparentheses \\\n',
      ),
    );
    const reread = readCompilerCommand(rewritten, 'agbcc');
    expect(reread?.takesCflags).toBe(true);
    expect(reread?.flagWords).toEqual([]);
    const bare = 'cc {{inputPath}} -o {{outputPath}}';
    expect(withCflagsWord(bare, readCompilerCommand(bare, 'ido')!)).toBe(
      'cc {{cflags}} {{inputPath}} -o {{outputPath}}',
    );
  });
});

const input = (over: Partial<FlagsInput>): FlagsInput => ({
  toolchain: 'agbcc',
  cflags: undefined,
  command: undefined,
  configPath: undefined,
  ranked: false,
  ...over,
});

const CANONICAL_LINE =
  "asmlift: [flags] none given: decompiling at agbcc's canonical flags -mthumb-interwork -O2 -fhex-asm " +
  '-fprologue-bugfix; pass --cflags if your build differs\n';

describe('resolving the flags', () => {
  test('none given: the canonical flags, said once', () => {
    const r = resolveFlags(input({}));
    expect(r).toMatchObject({ ok: true, fill: undefined, lines: CANONICAL_LINE });
    expect(r.ok && r.resolved.profile.slots.O).toBe('2');
  });

  test('--cflags: the effective flags, what a later word overrode, and the words no table names', () => {
    const plain = resolveFlags(input({ cflags: '-mthumb-interwork -Wimplicit -O2 -O1 -ansi' }));
    expect(plain.ok && plain.lines).toBe(
      'asmlift: [flags] -mthumb-interwork -O1 -ansi (--cflags)\n' +
        'asmlift: [flags] note: -O2 overridden by later -O1\n' +
        "asmlift: [flags] not in asmlift's flag table: -ansi\n",
    );
    const ranked = resolveFlags(
      input({
        cflags: '-mthumb-interwork -Wimplicit -O1 -ansi',
        ranked: true,
        command: 'agbcc {{cflags}} {{inputPath}} -o {{outputPath}}',
      }),
    );
    expect(ranked).toMatchObject({ ok: true, fill: ['-mthumb-interwork', '-Wimplicit', '-O1', '-ansi'] });
    expect(ranked.ok && ranked.lines).toContain("not in asmlift's flag table, passed to the compiler verbatim: -ansi");
  });

  test('what one flag makes of another is a note', () => {
    const r = resolveFlags(input({ toolchain: 'ido7.1', cflags: '-mips2 -O2 -g' }));
    expect(r.ok && r.lines).toContain(
      'asmlift: [flags] note: ido does not optimise with -g or -g1: -O2 compiles as -O1 (-g3 keeps both)\n',
    );
  });

  test('the compile command spells the flags; --cflags wins over it on a plain decompile', () => {
    const command = 'agbcc {{inputPath}} -o {{outputPath}} -mthumb-interwork -O1';
    expect(resolveFlags(input({ command }))).toMatchObject({
      ok: true,
      fill: undefined,
      lines: 'asmlift: [flags] -mthumb-interwork -O1 (compiler command)\n',
    });
    expect(resolveFlags(input({ command, cflags: '-O0' }))).toMatchObject({
      ok: true,
      lines: 'asmlift: [flags] -O0 (--cflags)\n',
    });
    expect(resolveFlags(input({ command: 'agbcc {{inputPath}} -o {{outputPath}}' }))).toMatchObject({
      ok: true,
      lines: 'asmlift: [flags] no codegen flags (compiler command)\n',
    });
  });

  test('a command asmlift cannot read is named, and the run assumes the canonical flags', () => {
    const r = resolveFlags(input({ command: './build.sh {{inputPath}} {{outputPath}}', ranked: true }));
    expect(r).toMatchObject({ ok: true, fill: undefined });
    expect(r.ok && r.lines).toBe(
      CANONICAL_LINE +
        'asmlift: [flags] note: tools.asmlift.compiler runs no agbcc compiler asmlift can find, so its flags are unread: ' +
        './build.sh {{inputPath}} {{outputPath}}\n',
    );
  });
});

const refusal = (over: Partial<FlagsInput>): string => {
  const r = resolveFlags(input(over));
  if (r.ok) {
    throw new Error('expected a refusal');
  }
  return r.message;
};

describe('refusals', () => {
  test('empty --cflags', () => {
    expect(refusal({ cflags: '' })).toBe("--cflags is empty; leave it out to decompile at agbcc's canonical flags");
    expect(refusal({ cflags: ' ', ranked: true })).toBe(
      '--cflags is empty; --score-against compiles every candidate with the flags it gives',
    );
    expect(refusal({ cflags: '-pragma "cats off' })).toBe(
      '--cflags: unterminated " quote at column 9: -pragma "cats off',
    );
  });

  test('a level word the family cannot read names the target that reads it', () => {
    expect(refusal({ cflags: '-O4,p' })).toBe(
      '--cflags: -O4,p is not an optimisation level agbcc accepts; mwcc spells its levels that way; ' +
        'did you mean --target mwcc_242_81?',
    );
    expect(refusal({ toolchain: 'mwcc_242_81', cflags: '-O9' })).toBe(
      '--cflags: -O9 is not an optimisation level mwcc accepts',
    );
    expect(refusal({ command: 'agbcc -O4,s {{inputPath}} -o {{outputPath}}' })).toBe(
      'tools.asmlift.compiler: -O4,s is not an optimisation level agbcc accepts; mwcc spells its levels that way; ' +
        'did you mean --target mwcc_242_81?',
    );
  });

  test('flags the command cannot take: a paste-ready command with {{cflags}} in place of its own flags', () => {
    const message = refusal({ cflags: '-O1', ranked: true, command: SCRIPT, configPath: '/p/decomp.yaml' });
    const [first, ...rest] = message.split('\n');
    expect(first).toBe(
      '--cflags gives the flags, and tools.asmlift.compiler in /p/decomp.yaml has no {{cflags}} to take them. ' +
        'Write {{cflags}} where the command spells its flags:',
    );
    const { compiler } = YAML.parse(rest.join('\n')) as { compiler: string };
    expect(compiler).toBe(withCflagsWord(SCRIPT, readCompilerCommand(SCRIPT, 'agbcc')!));
    expect(refusal({ cflags: '-O1', ranked: true, command: './build.sh {{inputPath}} {{outputPath}}' })).toBe(
      '--cflags gives the flags, and tools.asmlift.compiler has no {{cflags}} to take them. ' +
        'Write {{cflags}} where the command passes the compiler its flags.',
    );
    // a plain decompile runs no command, so the same inputs are not refused there
    expect(resolveFlags(input({ cflags: '-O1', command: SCRIPT })).ok).toBe(true);
  });

  test('a codegen flag spelled beside {{cflags}} is a second source', () => {
    expect(
      refusal({
        cflags: '-O1',
        ranked: true,
        command: 'agbcc -Wimplicit -O2 {{cflags}} {{inputPath}} -o {{outputPath}}',
      }),
    ).toBe(
      'tools.asmlift.compiler spells -O2 beside {{cflags}}, a second source of flags: give them in --cflags and ' +
        'remove them from the command',
    );
  });

  test('a ranked run whose command takes {{cflags}} needs flags to give it', () => {
    expect(refusal({ ranked: true, command: 'agbcc {{cflags}} {{inputPath}} -o {{outputPath}}' })).toBe(
      'tools.asmlift.compiler takes its flags through {{cflags}}, and nothing gives them: ' +
        'pass --cflags "<the flags your build compiles this file with>"',
    );
  });
});

describe('at the CLI surface', () => {
  const project = (compiler: string) => {
    const root = mkdtempSync(join(tmpdir(), 'asmlift-flags-'));
    writeFileSync(join(root, 'decomp.yaml'), YAML.stringify({ platform: 'gba', tools: { asmlift: { compiler } } }));
    const file = join(root, 'clamp0.s');
    writeFileSync(
      file,
      '\t.code\t16\n\t.globl\tclamp0\n\t.thumb_func\nclamp0:\n\tcmp\tr0, #0\n\tbge\t.L4\n\tmov\tr0, #0x0\n.L4:\n\tbx\tlr\n',
    );
    const target = join(root, 't.o');
    writeFileSync(target, 'placeholder');
    return { root, file, target };
  };

  test('the [flags] lines follow the target on a plain decompile', async () => {
    const { file } = project('agbcc {{inputPath}} -o {{outputPath}} -mthumb-interwork -O2 -fhex-asm');
    const r = await runCli([file]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(
      /^asmlift: \[config\] target agbcc \([^)]*\)\nasmlift: \[flags\] -mthumb-interwork -O2 -fhex-asm \(compiler command\)\n$/,
    );
  });

  test('a refusal is its message and exit 64, with no usage block', async () => {
    const { file, target, root } = project(SCRIPT);
    const empty = await runCli([file, '--cflags', '']);
    expect(empty).toEqual({
      code: 64,
      stdout: '',
      stderr: "asmlift: --cflags is empty; leave it out to decompile at agbcc's canonical flags\n",
    });
    const ranked = await runCli([file, '--cflags', '-O1', '--score-against', target]);
    expect(ranked.code).toBe(64);
    expect(ranked.stderr).toMatch(
      new RegExp(
        `^asmlift: --cflags gives the flags, and tools.asmlift.compiler in ${join(root, 'decomp.yaml')} has no`,
      ),
    );
    expect(ranked.stderr).not.toContain('usage:');
  });

  test('every canonical flag set reads back through a plain run at its own flags', async () => {
    for (const id of ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2', 'mwcc_242_81'] as const) {
      const r = resolveFlags(input({ toolchain: id, cflags: TOOLCHAIN_TARGETS[id].canonicalFlags.join(' ') }));
      expect(r.ok && r.lines, id).toBe(
        `asmlift: [flags] ${TOOLCHAIN_TARGETS[id].canonicalFlags.join(' ')} (--cflags)\n`,
      );
    }
  });
});
