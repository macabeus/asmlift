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
    // `msg_show_realref` only steers diagnostics and goes; `cats` decides a section and stays
    expect(flagsOf(mwcc, 'mwcc')).toEqual(['-proc', 'gekko', '-O4,p', '-pragma', 'cats off', '-str', 'reuse,readonly']);
  });

  // Recipe lines as `gmake -n` prints them for one unit of five benchmark projects (pokeemerald,
  // snowboardkids2, marioparty3, af, sa3), include lists shortened.
  test('a path given as an option argument is not the compiler binary', () => {
    const pokeemerald =
      'arm-none-eabi-cpp -iquote include -I tools/agbcc/include -I tools/agbcc -nostdinc -undef src/math_util.c | ' +
      'tools/preproc/preproc -i src/math_util.c charmap.txt | tools/agbcc/bin/agbcc -mthumb-interwork -Wimplicit ' +
      '-Wparentheses -Werror -O2 -fhex-asm -g -o - - | arm-none-eabi-as -mcpu=arm7tdmi -o build/emerald/src/math_util.o -';
    expect(flagsOf(pokeemerald, 'agbcc')).toEqual(['-mthumb-interwork', '-O2', '-fhex-asm', '-g']);
  });

  test('a run that only preprocesses or only checks compiles nothing', () => {
    const snowboardkids2 =
      'COMPILER_PATH=tools/gcc_kmc tools/gcc_kmc/gcc -mips3 -EB -O2 -fno-asm -I include -E src/38C90.c | ' +
      'COMPILER_PATH=tools/gcc_kmc tools/gcc_kmc/gcc -x c -mips3 -EB -O2 -fno-asm -I ./ -c -o build/src/38C90.o -';
    expect(readCompilerCommand(snowboardkids2, 'gcc')?.flagWords.map((w) => w.value)).toEqual(
      readCompilerCommand(snowboardkids2.split(' | ')[1], 'gcc')?.flagWords.map((w) => w.value),
    );
    expect(flagsOf(snowboardkids2, 'gcc')).not.toContain('-E');
    const marioparty3 =
      'gcc -fcommon -fsyntax-only -fsigned-char -m32 -I include src/sprman.c || true\n' +
      'export COMPILER_PATH=tools/gcc_2.7.2/mac && tools/gcc_2.7.2/mac/gcc -O1 -G0 -mips3 -mgp32 -mfp32 ' +
      '-Wa,--vr4300mul-off -D_LANGUAGE_C -I include -c -o build/src/sprman.c.o src/sprman.c';
    expect(flagsOf(marioparty3, 'gcc')).toEqual(['-O1', '-G0', '-mips3', '-mgp32', '-mfp32', '-Wa,--vr4300mul-off']);
  });

  test("asm-processor's assembler words between its two -- are not the compiler's", () => {
    const af =
      '.venv/bin/python3 tools/asm-processor/build.py --input-enc=utf-8 --convert-statics=global-with-filename ' +
      'tools/ido/macos/7.1/cc -- mips-linux-gnu-as -march=vr4300 -32 -G0 -- -c -G 0 -non_shared -Xcpluscomm ' +
      '-nostdinc -Wab,-r4300_mul -Iinclude -fullwarn -verbose -woff 624,649 -mips2 -EB -O2 -g3 ' +
      '-o build/src/code/sys_math_atan.o src/code/sys_math_atan.c';
    expect(flagsOf(af, 'ido')).toEqual(['-G', '0', '-non_shared', '-Wab,-r4300_mul', '-mips2', '-EB', '-O2', '-g3']);
  });

  test('standard input is an operand, not a flag', () => {
    const sa3 =
      'tools/preproc/preproc build/gba/sa3/src/lib/agb_flash/agb_flash.i | tools/agbcc/bin/agbcc  -O1 ' +
      '-mthumb-interwork -Werror -o build/gba/sa3/src/lib/agb_flash/agb_flash.s -';
    expect(flagsOf(sa3, 'agbcc')).toEqual(['-O1', '-mthumb-interwork']);
  });

  test('a compiler named by a variable is read through the environment the command runs under', () => {
    const command = '"$AGBCC" {{inputPath}} -o {{outputPath}} -mthumb-interwork -O1 && as {{inputPath}}.s';
    expect(readCompilerCommand(command, 'agbcc')).toBeUndefined();
    expect(flagsOf(command, 'agbcc')).toBeUndefined();
    const env = { AGBCC: '/opt/agbcc/bin/agbcc' };
    expect(readCompilerCommand(command, 'agbcc', env)?.flagWords.map((w) => w.value)).toEqual([
      '-mthumb-interwork',
      '-O1',
    ]);
    expect(readCompilerCommand('${AGBCC} -O2 -o x.s -', 'agbcc', env)?.flagWords.map((w) => w.value)).toEqual(['-O2']);
    expect(resolveFlags(input({ command, env }))).toMatchObject({
      ok: true,
      lines: 'asmlift: [flags] -mthumb-interwork -O1 (compiler command)\n',
    });
  });

  test('a variable among the words is read through the environment, split into words unless quoted', () => {
    const command = 'agbcc -mthumb-interwork $MYFLAGS {{inputPath}} -o {{outputPath}}';
    const env = { MYFLAGS: '-O1 -fhex-asm' };
    expect(readCompilerCommand(command, 'agbcc', env)?.flagWords.map((w) => w.value)).toEqual([
      '-mthumb-interwork',
      '-O1',
      '-fhex-asm',
    ]);
    expect(readCompilerCommand(command, 'agbcc')?.flagWords.map((w) => w.value)).toEqual(['-mthumb-interwork']);
    expect(
      readCompilerCommand('agbcc "$ONE" -o x.s -', 'agbcc', { ONE: '-O1 -fhex-asm' })?.flagWords.map((w) => w.value),
    ).toEqual(['-O1 -fhex-asm']);
    expect(resolveFlags(input({ command, env }))).toMatchObject({
      ok: true,
      lines: 'asmlift: [flags] -mthumb-interwork -O1 -fhex-asm (compiler command)\n',
    });
  });

  test('a variable the command sets itself is unread, and named', () => {
    const command = 'CFLAGS="-O1 -fhex-asm"; agbcc -mthumb-interwork $CFLAGS {{inputPath}} -o {{outputPath}}';
    const reading = readCompilerCommand(command, 'agbcc', { CFLAGS: '-O3' });
    expect(reading?.flagWords.map((w) => w.value)).toEqual(['-mthumb-interwork']);
    expect(reading?.unread.map((w) => w.value)).toEqual(['$CFLAGS']);
    expect(resolveFlags(input({ command }))).toMatchObject({
      ok: true,
      lines:
        'asmlift: [flags] -mthumb-interwork (compiler command)\n' +
        'asmlift: [flags] note: tools.asmlift.compiler sets $CFLAGS itself and passes it to the compiler, so the ' +
        'flags in it are unread\n',
    });
  });

  test('a compiler variable the environment does not set is named', () => {
    const command = '"$NOT_SET_AGBCC" {{inputPath}} -o {{outputPath}} -O1';
    const r = resolveFlags(input({ command }));
    expect(r.ok && r.lines).toBe(
      CANONICAL_LINE.replace('none given', 'unread (compiler command)') +
        "asmlift: [flags] note: tools.asmlift.compiler runs $NOT_SET_AGBCC, which asmlift's environment does not " +
        'set, so its flags are unread\n',
    );
    expect(refusal({ command, cflags: '-O1', ranked: true })).toBe(
      '--cflags gives the flags, and tools.asmlift.compiler has no {{cflags}} to take them. It runs ' +
        "$NOT_SET_AGBCC, which asmlift's environment does not set: set it, and write {{cflags}} where the command " +
        'passes the compiler its flags.',
    );
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
  env: {},
  unreadObjdiff: undefined,
  configPath: undefined,
  ranked: false,
  dtk: undefined,
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

  test('a level word the compiler reads as another level is a note', () => {
    expect(resolveFlags(input({ cflags: '-O9 -mthumb-interwork' }))).toMatchObject({
      ok: true,
      lines: 'asmlift: [flags] -O9 -mthumb-interwork (--cflags)\nasmlift: [flags] note: agbcc reads -O9 as -O3\n',
    });
    expect(resolveFlags(input({ toolchain: 'mwcc_242_81', cflags: '-proc gekko -O4 -Op' }))).toMatchObject({
      ok: true,
      lines: 'asmlift: [flags] -proc gekko -O4 -Op (--cflags)\nasmlift: [flags] note: mwcc reads -O4 -Op as -O4,p\n',
    });
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
      lines:
        'asmlift: [flags] -O0 (--cflags)\n' +
        'asmlift: [flags] note: this decompile reads the flags from --cflags, not the -mthumb-interwork -O1 in ' +
        'tools.asmlift.compiler; write {{cflags}} there before --score-against\n',
    });
    // the notes that qualify the head come first, the advice after them
    expect(resolveFlags(input({ command, cflags: '-O' }))).toMatchObject({
      ok: true,
      lines:
        'asmlift: [flags] -O (--cflags)\n' +
        'asmlift: [flags] note: agbcc reads -O as -O1\n' +
        'asmlift: [flags] note: this decompile reads the flags from --cflags, not the -mthumb-interwork -O1 in ' +
        'tools.asmlift.compiler; write {{cflags}} there before --score-against\n',
    });
    expect(resolveFlags(input({ command, cflags: '-mthumb-interwork -Wimplicit -O1' }))).toMatchObject({
      ok: true,
      lines: 'asmlift: [flags] -mthumb-interwork -O1 (--cflags)\n',
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
      CANONICAL_LINE.replace('none given', 'unread (compiler command)') +
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

  // A toolchain with no synthetic tier has no canonical flags to assume (target.ts): every row of
  // it names the flags its own build compiles that unit with, so a run that found none anywhere has
  // nothing to fall back on and says so instead of picking a set.
  test('a toolchain with no canonical flags refuses a run that gives none', () => {
    expect(refusal({ toolchain: 'mwcc_247_107' })).toBe(
      'mwcc_247_107 has no canonical flags; pass --cflags "<the flags your build compiles this file with>"',
    );
    expect(refusal({ toolchain: 'mwcc_233_163n', cflags: '' })).toBe(
      '--cflags is empty; mwcc_233_163n has no canonical flags to leave it out for',
    );
    // …and with flags it resolves like any other toolchain
    const given = resolveFlags(input({ toolchain: 'mwcc_247_107', cflags: '-proc gekko -O0,p -char unsigned' }));
    expect(given).toMatchObject({ ok: true });
    expect(given.ok && given.resolved.profile.slots.O).toBe('0,p');
    // the shipped build, at the SAME missing flags, still has its own set to assume
    expect(resolveFlags(input({ toolchain: 'mwcc_242_81' }))).toMatchObject({ ok: true });
  });

  test('a level word the family cannot read names the target that reads it', () => {
    expect(refusal({ cflags: '-O4,p' })).toBe(
      '--cflags: -O4,p is not an optimisation level agbcc accepts; mwcc spells its levels that way; ' +
        'did you mean --target mwcc_242_81 or --target mwcc_233_163n or --target mwcc_247_107?',
    );
    expect(refusal({ toolchain: 'mwcc_242_81', cflags: '-O9' })).toBe(
      '--cflags: -O9 is not an optimisation level mwcc accepts',
    );
    expect(refusal({ command: 'agbcc -O4,s {{inputPath}} -o {{outputPath}}' })).toBe(
      'tools.asmlift.compiler: -O4,s is not an optimisation level agbcc accepts; mwcc spells its levels that way; ' +
        'did you mean --target mwcc_242_81 or --target mwcc_233_163n or --target mwcc_247_107?',
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

  test('a codegen flag spelled beside {{cflags}} is a second source: a paste-ready command without it', () => {
    const [first, ...rest] = refusal({
      cflags: '-O1',
      ranked: true,
      command: 'agbcc -Wimplicit -O2 {{cflags}} -mthumb-interwork {{inputPath}} -o {{outputPath}}',
    }).split('\n');
    expect(first).toBe(
      'tools.asmlift.compiler spells -O2 -mthumb-interwork beside {{cflags}}, a second source of flags: give them in ' +
        '--cflags and remove them from the command:',
    );
    expect(YAML.parse(rest.join('\n'))).toEqual({
      compiler: 'agbcc -Wimplicit {{cflags}} {{inputPath}} -o {{outputPath}}',
    });
  });

  test('a variable beside {{cflags}} is a second source when it gives flags, and unreadable when the command sets it', () => {
    const command = 'agbcc -mthumb-interwork $MYFLAGS {{cflags}} {{inputPath}} -o {{outputPath}}';
    const [first, ...rest] = refusal({
      cflags: '-O1',
      ranked: true,
      command,
      env: { MYFLAGS: '-O2 -fprologue-bugfix' },
    }).split('\n');
    expect(first).toBe(
      'tools.asmlift.compiler spells -mthumb-interwork -O2 -fprologue-bugfix beside {{cflags}}, a second source of ' +
        'flags: give them in --cflags and remove them from the command:',
    );
    const pasted = (YAML.parse(rest.join('\n')) as { compiler: string }).compiler;
    expect(pasted).toBe('agbcc {{cflags}} {{inputPath}} -o {{outputPath}}');
    expect(resolveFlags(input({ cflags: '-O1', ranked: true, command: pasted, env: { MYFLAGS: '-O2' } })).ok).toBe(
      true,
    );
    const [set, ...line] = refusal({
      cflags: '-O1',
      ranked: true,
      command: `EXTRA=-O2; ${pasted.replace('{{cflags}}', '$EXTRA {{cflags}}')}`,
    }).split('\n');
    expect(set).toBe(
      'tools.asmlift.compiler passes $EXTRA beside {{cflags}}, and sets it itself, so asmlift cannot read whether ' +
        'it is a second source of flags: give the flags in --cflags and remove $EXTRA from the command:',
    );
    expect(YAML.parse(line.join('\n'))).toEqual({ compiler: `EXTRA=-O2; ${pasted}` });
  });

  test('a ranked run whose command takes {{cflags}} needs flags to give it', () => {
    expect(refusal({ ranked: true, command: 'agbcc {{cflags}} {{inputPath}} -o {{outputPath}}' })).toBe(
      'tools.asmlift.compiler takes its flags through {{cflags}}, and nothing gives them: ' +
        'pass --cflags "<the flags your build compiles this file with>"',
    );
  });
});

const CLAMP0 =
  '\t.code\t16\n\t.globl\tclamp0\n\t.thumb_func\nclamp0:\n\tcmp\tr0, #0\n\tbge\t.L4\n\tmov\tr0, #0x0\n.L4:\n\tbx\tlr\n';

describe('at the CLI surface', () => {
  const project = (compiler: string) => {
    const root = mkdtempSync(join(tmpdir(), 'asmlift-flags-'));
    writeFileSync(join(root, 'decomp.yaml'), YAML.stringify({ platform: 'gba', tools: { asmlift: { compiler } } }));
    const file = join(root, 'clamp0.s');
    writeFileSync(file, CLAMP0);
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

  test('--score-against with no compiler command is its message, with no usage block', async () => {
    const { file, target, root } = project('placeholder');
    writeFileSync(join(root, 'decomp.yaml'), 'platform: gba\ntools:\n  asmlift:\n    target: agbcc\n');
    const r = await runCli([file, '--score-against', target]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/^asmlift: --score-against needs tools.asmlift.compiler in decomp.yaml/);
    expect(r.stderr).not.toContain('usage:');
  });

  test('an objdiff.json with no decomp.yaml beside it is named as unread', async () => {
    const root = mkdtempSync(join(tmpdir(), 'asmlift-bare-dtk-'));
    writeFileSync(join(root, 'objdiff.json'), '{"units": []}\n');
    const file = join(root, 'clamp0.s');
    writeFileSync(file, CLAMP0);
    const r = await runCli([file, '--target', 'agbcc']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(
      `asmlift: [flags] note: ${join(root, 'objdiff.json')} is not read: asmlift reads a dtk unit's flags from the ` +
        'objdiff.json beside decomp.yaml; a decomp.yaml with platform: gba beside it is enough\n',
    );
    expect((await runCli([file, '--target', 'agbcc', '--cflags', '-O2'])).stderr).not.toContain('is not read');
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
