// Which project compile commands the candidate store keys at all (src/candcache-command.ts), read
// over real files: native programs on this PATH, scripts written here, a directory and a text file.
// The real compiles that pin what each refusal prevents are in
// apps/benchmark/test/candcache-reads.test.ts ('a GNU compile command').
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { commandAdmission } from '../../src/candcache-command';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'candcache-command-')));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
mkdirSync(join(cwd, 'inc'));
writeFileSync(join(cwd, 'flags.txt'), '-include pre.h\n');
const script = (name: string, body: string): void => {
  writeFileSync(join(cwd, name), body);
  chmodSync(join(cwd, name), 0o755);
};
script('shim', '#!/bin/sh\n# hands every argument to cp\nexec cp "$@"\n');
script('shim2', `#!/bin/sh\nexec ${join(cwd, 'shim')} "$@"\n`);
script('relative-shim', '#!/bin/sh\nexec ./shim "$@"\n');
script('adds.sh', '#!/bin/sh\nexec cp -p "$@"\n');
script('env-shim', '#!/usr/bin/env sh\nexec cp "$@"\n');
script('two-lines', '#!/bin/sh\nset -e\nexec cp "$@"\n');
script('no-shebang', 'exec cp "$@"\n');

const admit = (command: string, env: NodeJS.ProcessEnv = {}) =>
  commandAdmission(command, { cwd, env: { PATH: process.env.PATH, ...env } });

describe('a command the store keys', () => {
  test.each([
    ['one native program found on PATH', 'cp {{inputPath}} {{outputPath}}'],
    [
      'steps joined by ; and &&, redirected into the scratch directory or to /dev/null',
      'cat {{inputPath}} > {{inputPath}}.i 2>/dev/null; cp {{inputPath}}.i {{outputPath}} && cat {{outputPath}} >/dev/null 2>&1',
    ],
    [
      'a cd into the scratch directory, and its files by basename there',
      'cd "$(dirname {{outputPath}})" && cp "$(basename {{inputPath}})" "$(dirname {{outputPath}})/x.o"',
    ],
    ['a script whose whole program is exec "$@"', './shim {{inputPath}} {{outputPath}}'],
    ['a shim of a shim', './shim2 {{inputPath}} {{outputPath}}'],
    ['a directory operand, plain words and a line continuation', 'cp -R inc \\\n {{outputPath}}'],
    ['an assignment of an existing path or a plain word', 'TMPDIR=inc LC_ALL=C cp {{inputPath}} {{outputPath}}'],
    ['a # comment', 'cp {{inputPath}} {{outputPath}} # copies, see flags.txt'],
  ])('keys %s', (_what, command) => {
    expect(admit(command)).toHaveProperty('words');
  });

  test('reads the words as the programs receive them: quotes removed, a variable split unless quoted', () => {
    expect(
      admit(`"$PROG" $FLAGS "$ONE" {{inputPath}} '{{outputPath}}'`, { PROG: 'cp', FLAGS: '-p  -R', ONE: '-a b' }),
    ).toEqual({
      words: ['cp', '-p', '-R', '-a b', '{{inputPath}}', '{{outputPath}}'],
    });
  });
});

describe('a command the store does not key', () => {
  test.each([
    [
      'a wrapper script that adds a word',
      './adds.sh {{inputPath}} {{outputPath}}',
      'a script that does more than exec',
    ],
    [
      'a shim that does anything else first',
      './two-lines {{inputPath}} {{outputPath}}',
      'a script that does more than exec',
    ],
    ['a shim run through env', './env-shim {{inputPath}} {{outputPath}}', 'a script that does more than exec'],
    ['a shim of a relative path', './relative-shim {{inputPath}} {{outputPath}}', 'it runs ./shim'],
    ['a script with no #! line', './no-shebang {{inputPath}} {{outputPath}}', 'not a native executable'],
    ['flags piped from a file', 'cat flags.txt | xargs cp {{inputPath}} {{outputPath}}', 'a pipe'],
    ['||', 'cp {{inputPath}} {{outputPath}} || true', 'a pipe'],
    ['a background job', 'cp {{inputPath}} {{outputPath}} &', 'background'],
    ['a subshell', '(cp {{inputPath}} {{outputPath}})', 'a subshell or group'],
    ['a group', '{ cp {{inputPath}} {{outputPath}}; }', 'a brace group'],
    ['an input redirection', 'cp /dev/stdin {{outputPath}} < flags.txt', 'an input redirection'],
    ['a here-document', 'cat <<EOF > {{inputPath}}\nx\nEOF', 'an input redirection'],
    [
      'output written outside the scratch directory',
      'cp {{inputPath}} {{outputPath}} > log.txt',
      'outside the scratch',
    ],
    ['indirect expansion', 'cp ${!P} {{inputPath}} {{outputPath}}', 'neither $NAME nor ${NAME}'],
    ['a parameter expansion with a default', 'cp ${P:-x} {{inputPath}} {{outputPath}}', 'neither $NAME nor ${NAME}'],
    ['a command substitution', 'cp $(cat flags.txt) {{inputPath}} {{outputPath}}', 'neither $NAME nor ${NAME}'],
    ['a backquote', 'cp `cat flags.txt` {{inputPath}} {{outputPath}}', 'a backquote'],
    ['a backslash escape', 'cp \\-p {{inputPath}} {{outputPath}}', 'a backslash escape'],
    ['a glob', 'cp inc/*.h {{outputPath}}', 'the unquoted *'],
    ['a variable the command sets', 'F=-p; cp $F {{inputPath}} {{outputPath}}', 'a variable the command sets itself'],
    ['a command that only sets a variable', 'F=-p; cp {{inputPath}} {{outputPath}}', 'only sets shell variables'],
    ['an assignment of PATH', 'PATH=inc cp {{inputPath}} {{outputPath}}', 'the assignment PATH=inc'],
    [
      'an assignment of a path prefix',
      'GCC_EXEC_PREFIX=/no/such/gcc- cp {{inputPath}} {{outputPath}}',
      'the assignment',
    ],
    ['a path out of the scratch directory', 'cp "$(dirname {{inputPath}})/../flags.txt" {{outputPath}}', 'it hands cp'],
    [
      'a sibling of the scratch directory',
      'cp "$(dirname {{inputPath}})-x/f" {{outputPath}}',
      'neither a flag nor a path',
    ],
    [
      'a basename outside the scratch directory',
      'cp "$(basename {{inputPath}})" {{outputPath}}',
      'neither a flag nor a path',
    ],
    [
      'a redirection out of the scratch directory',
      'cp {{inputPath}} {{outputPath}} > {{inputPath}}/../../x',
      'outside the scratch',
    ],
    ['a cd elsewhere', 'cd inc && cp {{inputPath}} {{outputPath}}', 'a cd anywhere but'],
    ['eval', 'eval cp {{inputPath}} {{outputPath}}', 'it runs eval, a shell builtin'],
    ['a sourced script', '. ./shim && cp {{inputPath}} {{outputPath}}', 'it runs ., a shell builtin'],
    ['exec', 'exec cp {{inputPath}} {{outputPath}}', 'it runs exec, a shell builtin'],
    ['env', 'env -S"cp -p" {{inputPath}} {{outputPath}}', 'it runs env'],
    ['a program handed another by name', 'nice cp {{inputPath}} {{outputPath}}', 'cp, a program on this PATH'],
    ['a shell handed a script', 'sh ./shim {{inputPath}} {{outputPath}}', 'a program or a script'],
    ['a shell handed a command', 'sh -c "cp {{inputPath}} {{outputPath}}"', 'neither a flag nor a path'],
    [
      'a text file handed to a program',
      'cat flags.txt {{inputPath}} > {{outputPath}}',
      'a file it may read as flags or code',
    ],
    ['the symbol as a word', 'cp {{inputPath}} {{outputPath}} -p{{symbol}}', '{{symbol}}'],
    ['a program on no PATH', 'no-such-compiler-here {{inputPath}} {{outputPath}}', 'no program on this PATH'],
  ])('refuses %s', (_what, command, why) => {
    const a = admit(command);
    expect(a).toHaveProperty('refusal');
    expect((a as { refusal: string }).refusal).toContain(why);
  });
});
