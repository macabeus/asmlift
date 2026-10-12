// The candidate store keys the benchmark's own commands and no other (src/candcache-bench.ts): a
// committed benchmark template under the benchmark's placeholder values, byte for byte, run by
// `/bin/sh`, whose every program is a native executable or a flagless `#!/bin/sh` exec shim,
// compiled under an environment that changes nothing the namespace cannot see (src/candcache.ts
// `refuseUnkeyedEnv`). A command that does not name itself as the benchmark's never reaches the
// store at all.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';

import {
  compileEnvironment,
  findOnPath,
  lddLibraries,
  linuxLibraries,
  loadedCodeDigest,
  noteLoadedCode,
  otoolLibraries,
  refuseUnkeyedEnv,
  sha,
  toolchainFileChain,
} from '../../src/candcache';
import {
  NOT_A_BENCH_TEMPLATE,
  benchCommand,
  benchCommandRefusal,
  templateCommands,
  templateRefusal,
} from '../../src/candcache-bench';
import { commandStaticStamp, noteLoadedRunner, runnerPackageDir } from '../../src/compile-command';
import { benchAgbcc } from './bench-command-double';

vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});
const scratch = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(d);
  return d;
};
const script = (dir: string, name: string, body: string): string => {
  const p = join(dir, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
};

const BENCH = benchAgbcc();
const DOUBLE = BENCH.bench.placeholders.ASMLIFT_AGBCC;
const cwd = scratch('candcache-bench-cwd-');
const refusal = (command: string, bench = BENCH.bench, env: NodeJS.ProcessEnv = process.env): string | undefined =>
  benchCommandRefusal(command, bench, { cwd, env });
/** The bench command with one placeholder pointing at `program`. */
const withSlot = (
  slot: 'ASMLIFT_AGBCC' | 'ASMLIFT_ARM_AS',
  program: string,
): { command: string; bench: typeof BENCH.bench } => {
  const bench = { toolchain: 'agbcc', placeholders: { ...BENCH.bench.placeholders, [slot]: program } };
  return { command: benchCommand(bench), bench };
};
const withAgbcc = (program: string): ReturnType<typeof withSlot> => withSlot('ASMLIFT_AGBCC', program);

describe('benchCommandRefusal', () => {
  test('admits the benchmark agbcc command under the values it was rendered with', () => {
    expect(refusal(BENCH.command)).toBeUndefined();
  });

  test('refuses a command that names no benchmark toolchain', () => {
    expect(benchCommandRefusal(BENCH.command, undefined, { cwd, env: process.env })).toBe(NOT_A_BENCH_TEMPLATE);
    expect(refusal(BENCH.command, { toolchain: 'no-such-toolchain', placeholders: {} })).toBe(NOT_A_BENCH_TEMPLATE);
    expect(refusal(BENCH.command, { toolchain: '../agbcc', placeholders: BENCH.bench.placeholders })).toBe(
      NOT_A_BENCH_TEMPLATE,
    );
  });

  test('refuses the benchmark template under other values, or one byte away from it', () => {
    const other = { toolchain: 'agbcc', placeholders: { ...BENCH.bench.placeholders, ASMLIFT_ARM_AS: '/bin/cp' } };
    expect(refusal(BENCH.command, other), 'the values the command was rendered with are not these').toBe(
      NOT_A_BENCH_TEMPLATE,
    );
    expect(refusal(`${BENCH.command} `)).toBe(NOT_A_BENCH_TEMPLATE);
    expect(refusal(BENCH.command.replace('-nostdinc', '-nostdinc -include pre.h'))).toBe(NOT_A_BENCH_TEMPLATE);
  });

  test('refuses the committed template copied with its placeholders left for the shell to expand', () => {
    const verbatim = BENCH.command
      .replace(`'${DOUBLE}'`, '"$ASMLIFT_AGBCC"')
      .replace(`'${BENCH.bench.placeholders.ASMLIFT_ARM_AS}'`, '"$ASMLIFT_ARM_AS"');
    expect(verbatim).toContain('"$ASMLIFT_AGBCC"');
    expect(refusal(verbatim)).toBe(NOT_A_BENCH_TEMPLATE);
  });

  test('R310-26: checks the program after `&&` on its own — the assembler slot', () => {
    const shim = script(scratch('candcache-bench-as-'), 'as', `#!/bin/zsh\nexec ${DOUBLE} "$@"\n`);
    const c = withSlot('ASMLIFT_ARM_AS', shim);
    expect(refusal(c.command, c.bench)).toBe(
      `the-bench-command-runs-what-the-store-cannot-key: it runs ${shim}, a script that is not a flagless #!/bin/sh exec of a program with its own arguments`,
    );
  });

  test('reads every committed template’s programs: each placeholder or name is checked', () => {
    // `$ASMLIFT_DOCKER` resolves to `docker` or to nothing on this PATH; either way it is checked
    // as a program, and the namespace stamp then refuses the container runtime.
    const placeholders = Object.fromEntries(
      ['ASMLIFT_DOCKER', 'ASMLIFT_KMC_DIR', 'ASMLIFT_KMC_IMAGE'].map((k) => [k, `/no/such/${k}`]),
    );
    expect(
      refusal(benchCommand({ toolchain: 'gcc2.7.2kmc', placeholders }), { toolchain: 'gcc2.7.2kmc', placeholders }),
    ).toBe('the-bench-command-runs-what-the-store-cannot-key: it runs /no/such/ASMLIFT_DOCKER, which does not exist');
  });
});

describe('R310-15: a program reached through a shell script runs only under a flagless #!/bin/sh', () => {
  const dir = scratch('candcache-bench-shims-');
  test('admits a flagless #!/bin/sh shim whose whole program is exec <program> "$@"', () => {
    const shim = script(dir, 'sh-shim', `#!/bin/sh\nexec ${DOUBLE} "$@"\n`);
    const c = withAgbcc(shim);
    expect(refusal(c.command, c.bench)).toBeUndefined();
  });
  test.each([
    ['zsh, which reads .zshenv for every script', '#!/bin/zsh'],
    ['bash, which reads $BASH_ENV', '#!/bin/bash'],
    ['sh -l, which reads .profile', '#!/bin/sh -l'],
    ['a flag of any kind', '#!/bin/sh -e'],
    ['env, which runs whatever it names', '#!/usr/bin/env sh'],
  ])('refuses a shim under %s', (_what, shebang) => {
    const shim = script(dir, `shim-${shebang.replace(/\W/g, '_')}`, `${shebang}\nexec ${DOUBLE} "$@"\n`);
    const c = withAgbcc(shim);
    expect(refusal(c.command, c.bench)).toMatch(
      /^the-bench-command-runs-what-the-store-cannot-key: it runs .* a script/,
    );
  });
  test('refuses a #!/bin/sh script that does more than exec', () => {
    const shim = script(dir, 'adds-include', `#!/bin/sh\nexec ${DOUBLE} -include pre.h "$@"\n`);
    const c = withAgbcc(shim);
    expect(refusal(c.command, c.bench)).toMatch(/a script that is not a flagless #!\/bin\/sh exec/);
  });
  test('refuses the command when the `cpp` it names on PATH is a zsh shim', () => {
    const bin = scratch('candcache-bench-path-');
    script(bin, 'cpp', `#!/bin/zsh\nexec ${DOUBLE} "$@"\n`);
    expect(refusal(BENCH.command, BENCH.bench, { ...process.env, PATH: `${bin}:${process.env.PATH}` })).toMatch(
      /it runs cpp, a script/,
    );
  });
  test('the namespace chain refuses a script under any interpreter but a flagless /bin/sh', async () => {
    const { toolchainFileChain } = await import('../../src/candcache');
    expect(toolchainFileChain(script(dir, 'chain-sh', `#!/bin/sh\nexec ${DOUBLE} "$@"\n`))).toContain(
      realpathSync(DOUBLE),
    );
    for (const shebang of ['#!/bin/zsh', '#!/bin/bash', '#!/bin/sh -l', '']) {
      const p = script(dir, `chain-${shebang.replace(/\W/g, '_') || 'none'}`, `${shebang}\nexec ${DOUBLE} "$@"\n`);
      expect(() => toolchainFileChain(p), shebang || 'no #! line').toThrow(/not a flagless \/bin\/sh/);
    }
  });
});

describe('R310-16, R310-23, R310-24: a variable that changes what a compile runs or reads refuses the namespace', () => {
  test.each([
    'BASH_FUNC_cpp%%',
    'BASH_FUNC_arm-none-eabi-gcc%%',
    'BASH_ENV',
    'ENV',
    'SHELLOPTS',
    'BASHOPTS',
    'PS4',
    'BASH_XTRACEFD',
    'BASH_COMPAT',
    'POSIXLY_CORRECT',
    'EXECIGNORE',
    'GLOBIGNORE',
    'CDPATH',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'LD_PRELOAD',
    'LD_AUDIT',
    'LD_LIBRARY_PATH',
    'LD_DEBUG',
    'CCC_OVERRIDE_OPTIONS',
    'GCC_EXEC_PREFIX',
    'COMPILER_PATH',
    'CPATH',
    'C_INCLUDE_PATH',
    'CPLUS_INCLUDE_PATH',
    'OBJC_INCLUDE_PATH',
    'DEPENDENCIES_OUTPUT',
    'SUNPRO_DEPENDENCIES',
  ])('%s', (name) => {
    expect(() => refuseUnkeyedEnv({ PATH: '/bin', [name]: 'x' })).toThrow(name);
    expect(() => refuseUnkeyedEnv({ PATH: '/bin', [name]: '' }), 'set and empty is set').toThrow(name);
    expect(() => refuseUnkeyedEnv({ PATH: '/bin', LANG: 'C' })).not.toThrow();
  });
});

type CompileCommandModule = typeof import('../../src/compile-command');
/** One compile of `tu` through `command` with the store on over a private store: what the store did,
 *  what it said, and whether it made a namespace. */
async function storeRun(
  command: string,
  opts: Parameters<CompileCommandModule['compileFromCommand']>[1],
  env: Record<string, string> = {},
  store = scratch('candcache-bench-store-'),
): Promise<{ stats: Record<string, number>; said: string; namespaced: boolean }> {
  const all = { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: store, ...env };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  Object.assign(process.env, all);
  let said = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    said += typeof c === 'string' ? c : Buffer.from(c).toString();
    return true;
  });
  vi.resetModules();
  try {
    const { compileFromCommand } = (await import('../../src/compile-command')) as CompileCommandModule;
    try {
      await compileFromCommand(command, opts)('int f(void) { return 7; }\n', 'f', 'c');
    } catch {
      /* the store's answer is the question, not the compile's */
    }
    const stats = (await import('../../src/candcache')).cacheStats();
    return { stats, said, namespaced: existsSync(join(store, 'ns')) && readdirSync(join(store, 'ns')).length > 0 };
  } finally {
    spy.mockRestore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    vi.resetModules();
  }
}

describe('the store on the benchmark command', () => {
  test('stores what the benchmark command compiles — the control for every refusal below', async () => {
    const r = await storeRun(BENCH.command, { cwd, cflags: ['-O2'], bench: BENCH.bench });
    expect(r.stats).toMatchObject({ miss: 1, stored: 1 });
    expect(r.namespaced).toBe(true);
  });

  test('R310-16: refuses it while an exported function replaces its cpp', async () => {
    const r = await storeRun(
      BENCH.command,
      { cwd, cflags: ['-O2'], bench: BENCH.bench },
      { 'BASH_FUNC_cpp%%': '() { command cpp -DK=1 "$@"; }' },
    );
    expect(r.said).toContain('REFUSED label=command reason=stamp-threw: BASH_FUNC_cpp%% is set');
    expect(r.stats.stored).toBeUndefined();
    expect(r.namespaced).toBe(false);
  });
});

describe('R310-22: every template runs under /bin/sh', () => {
  test('refuses the command while the sh a spawn finds first on PATH is another program', () => {
    const bin = scratch('candcache-bench-sh-');
    script(bin, 'sh', '#!/bin/sh\nexec /bin/sh "$@"\n');
    expect(refusal(BENCH.command, BENCH.bench, { ...process.env, PATH: `${bin}:${process.env.PATH}` })).toBe(
      `the-bench-command-runs-what-the-store-cannot-key: its shell, the sh a spawn finds on PATH, is ${bin}/sh and not /bin/sh`,
    );
  });

  test('admits a PATH whose first sh is /bin/sh under another name', () => {
    const bin = scratch('candcache-bench-shlink-');
    symlinkSync('/bin/sh', join(bin, 'sh'));
    expect(refusal(BENCH.command, BENCH.bench, { ...process.env, PATH: `${bin}:${process.env.PATH}` })).toBeUndefined();
  });

  test('the namespace hashes /bin/sh and the shell it runs', () => {
    const chain = toolchainFileChain('/bin/sh');
    expect(chain).toContain(realpathSync('/bin/sh'));
    if (existsSync('/private/var/select/sh')) {
      expect(chain).toContain(realpathSync('/private/var/select/sh'));
    }
  });

  test('a store run under a PATH-first sh stores nothing', async () => {
    const bin = scratch('candcache-bench-shrun-');
    script(bin, 'sh', '#!/bin/sh\nexec /bin/sh "$@"\n');
    const r = await storeRun(
      BENCH.command,
      { cwd, cflags: ['-O2'], bench: BENCH.bench },
      { PATH: `${bin}:${process.env.PATH}` },
    );
    expect(r.said).toContain(
      'REFUSED-KEY label=command reason=the-bench-command-runs-what-the-store-cannot-key: its shell',
    );
    expect(r.stats.stored).toBeUndefined();
    expect(r.namespaced).toBe(false);
  });
});

describe('R310-24: the namespace follows a program to the libraries it loads', () => {
  test('a program linked to a library outside the OS has that library in its chain', () => {
    const dir = scratch('candcache-bench-lib-');
    writeFileSync(join(dir, 'k.c'), 'int k(void) { return 7; }\n');
    writeFileSync(join(dir, 'main.c'), 'int k(void);\nint main(void) { return k(); }\n');
    const lib = join(dir, platform() === 'darwin' ? 'libk.dylib' : 'libk.so');
    execFileSync(
      'cc',
      platform() === 'darwin'
        ? ['-dynamiclib', '-install_name', lib, '-o', lib, join(dir, 'k.c')]
        : ['-shared', '-fPIC', '-o', lib, join(dir, 'k.c')],
    );
    execFileSync('cc', ['-o', join(dir, 'prog'), join(dir, 'main.c'), lib, `-Wl,-rpath,${dir}`]);
    expect(toolchainFileChain(join(dir, 'prog'))).toContain(realpathSync(lib));
  });

  test('reads an ldd listing: resolved paths, the loader, and a library it did not find', () => {
    expect(
      lddLibraries(
        [
          '\tlinux-vdso.so.1 (0x00007ffd3b7f2000)',
          '\tlibgmp.so.10 => /lib/x86_64-linux-gnu/libgmp.so.10 (0x00007f3c1a400000)',
          '\tlibisl.so.23 => not found',
          '\t/lib64/ld-linux-x86-64.so.2 (0x00007f3c1a9d2000)',
        ].join('\n'),
      ),
    ).toEqual(['/lib/x86_64-linux-gnu/libgmp.so.10', 'UNRESOLVED:libisl.so.23', '/lib64/ld-linux-x86-64.so.2']);
  });
});

describe('R310-25: the namespace keys the deployment target and the host release', () => {
  test('compileEnvironment moves with MACOSX_DEPLOYMENT_TARGET and an allocator setting, and names the host', () => {
    const base = { PATH: '/bin' };
    expect(compileEnvironment({ ...base, MACOSX_DEPLOYMENT_TARGET: '11.0' })).not.toBe(
      compileEnvironment({ ...base, MACOSX_DEPLOYMENT_TARGET: '14.0' }),
    );
    expect(compileEnvironment({ ...base, MALLOC_PERTURB_: '1' })).not.toBe(compileEnvironment(base));
    expect(compileEnvironment(base)).toContain(`host:${platform()} ${release()} `);
  });

  test('a store filled under one deployment target serves nothing under another', async () => {
    const store = scratch('candcache-bench-mdt-');
    const opts = { cwd, cflags: ['-O2'], bench: BENCH.bench };
    expect((await storeRun(BENCH.command, opts, { MACOSX_DEPLOYMENT_TARGET: '11.0' }, store)).stats).toMatchObject({
      miss: 1,
      stored: 1,
    });
    expect((await storeRun(BENCH.command, opts, { MACOSX_DEPLOYMENT_TARGET: '11.0' }, store)).stats).toEqual({
      hit: 1,
    });
    expect((await storeRun(BENCH.command, opts, { MACOSX_DEPLOYMENT_TARGET: '14.0' }, store)).stats).toMatchObject({
      miss: 1,
      stored: 1,
    });
  });
});

describe('R310-27: a relative PATH entry is read as a spawn reads it', () => {
  const away = scratch('candcache-bench-relpath-');
  script(join(away, 'r310-27-bin'), 'cpp', `#!/bin/sh\nexec ${DOUBLE} "$@"\n`);
  script(away, 'cpp', `#!/bin/sh\nexec ${DOUBLE} "$@"\n`);
  test.each([
    ['a relative entry', 'r310-27-bin'],
    ['the working directory as `.`', '.'],
    ['an empty entry, the working directory', ''],
  ])('refuses %s that holds a program the command runs, ahead of its answer', (_what, entry) => {
    const PATH = `${entry}:${process.env.PATH}`;
    expect(benchCommandRefusal(BENCH.command, BENCH.bench, { cwd: away, env: { ...process.env, PATH } })).toBe(
      `the-bench-command-runs-what-the-store-cannot-key: PATH's relative entry ${entry || '(empty)'} holds cpp at ` +
        `${join(away, entry, 'cpp')}: which cpp runs depends on where it is started, so nothing is cached`,
    );
  });

  test('admits a relative entry behind the answer, or one that holds none of the programs', () => {
    expect(
      benchCommandRefusal(BENCH.command, BENCH.bench, {
        cwd: away,
        env: { ...process.env, PATH: `${process.env.PATH}:r310-27-bin` },
      }),
    ).toBeUndefined();
    const empty = scratch('candcache-bench-relpath-empty-');
    mkdirSync(join(empty, 'r310-27-bin'));
    expect(
      benchCommandRefusal(BENCH.command, BENCH.bench, {
        cwd: empty,
        env: { ...process.env, PATH: `r310-27-bin:${process.env.PATH}` },
      }),
    ).toBeUndefined();
  });

  test('skips a relative entry that names no directory — a literal ~/.dotnet/tools — as every spawn does', () => {
    const PATH = `~/.dotnet/tools:${process.env.PATH}`;
    expect(findOnPath('sh', { PATH })).toBe(findOnPath('sh', process.env));
    expect(refusal(BENCH.command, BENCH.bench, { ...process.env, PATH })).toBeUndefined();
  });
});

describe('templateRefusal: what a committed template may run', () => {
  const gccDir = scratch('candcache-bench-gccdir-');
  execFileSync('cp', [DOUBLE, join(gccDir, 'gcc')]);
  const where = { cwd, env: process.env };
  const NATIVE_GCC =
    'cd "$(dirname {{outputPath}})" && COMPILER_PATH="$ASMLIFT_GCC272_DIR" "$ASMLIFT_GCC272_DIR"/gcc -c';
  const gcc = (native: boolean, toolchain = 'gcc2.7.2') => ({
    toolchain,
    placeholders: { ASMLIFT_GCC272_DIR: gccDir },
    ...(native ? { native: true } : {}),
  });

  test('reads each simple command: its assignments, its program, and the command of each $(…)', () => {
    expect(templateCommands(NATIVE_GCC)).toEqual([
      { assignments: [], program: 'cd' },
      { assignments: ['COMPILER_PATH="$ASMLIFT_GCC272_DIR"'], program: '"$ASMLIFT_GCC272_DIR"/gcc' },
      { assignments: [], program: 'dirname' },
    ]);
  });

  test('admits GCC 2.7.2’s native COMPILER_PATH, the builtin cd and the dirname it runs', () => {
    expect(templateRefusal(NATIVE_GCC, gcc(true), where)).toBeUndefined();
  });

  test('refuses that assignment anywhere but GCC 2.7.2’s native command, and any other assignment', () => {
    expect(templateRefusal(NATIVE_GCC, gcc(false), where)).toBe(
      'the-bench-command-runs-what-the-store-cannot-key: it assigns COMPILER_PATH="$ASMLIFT_GCC272_DIR" for "$ASMLIFT_GCC272_DIR"/gcc',
    );
    expect(templateRefusal(NATIVE_GCC, gcc(true, 'mwcc_233_163n'), where)).toMatch(/it assigns COMPILER_PATH=/);
    expect(templateRefusal(NATIVE_GCC.replace('COMPILER_PATH=', 'GCC_EXEC_PREFIX='), gcc(true), where)).toMatch(
      /it assigns GCC_EXEC_PREFIX=/,
    );
  });

  test('checks the program a $(…) runs', () => {
    expect(templateRefusal(NATIVE_GCC, gcc(true), { cwd, env: { ...process.env, PATH: gccDir } })).toBe(
      'the-bench-command-runs-what-the-store-cannot-key: its shell, the sh a spawn finds on PATH, is on no PATH directory and not /bin/sh',
    );
    const bin = scratch('candcache-bench-dirname-');
    symlinkSync('/bin/sh', join(bin, 'sh'));
    expect(templateRefusal(NATIVE_GCC, gcc(true), { cwd, env: { ...process.env, PATH: bin } })).toBe(
      'the-bench-command-runs-what-the-store-cannot-key: it runs dirname, which is no program on this PATH',
    );
  });
});

describe('a command that does not name itself as the benchmark’s never reaches the store', () => {
  const project = scratch('candcache-bench-project-');
  writeFileSync(join(project, 'x.cfg'), '-include pre.h\n');
  writeFileSync(join(project, 'pre.h'), '#define K 1\n');
  mkdirSync(join(project, 'gt/x'), { recursive: true });
  const untouched = (r: Awaited<ReturnType<typeof storeRun>>): void => {
    expect(r.said, 'nothing said').not.toContain('[candcache]');
    expect(r.stats, 'nothing counted').toEqual({});
    expect(r.namespaced, 'nothing stamped').toBe(false);
  };

  test('R310-17: a glued -B prefix, a --config file, a GCC_EXEC_PREFIX assignment', async () => {
    for (const command of [
      'cc -Bpfx- -O2 -c -o {{outputPath}} {{inputPath}}',
      'cc --config=./x.cfg -O2 -c -o {{outputPath}} {{inputPath}}',
      'GCC_EXEC_PREFIX=gt/x/ cc -O2 -c -o {{outputPath}} {{inputPath}}',
    ]) {
      untouched(await storeRun(command, { cwd: project }));
    }
  });

  test('R310-18: an intermediate written outside the scratch directory', async () => {
    untouched(
      await storeRun('cc -O2 -S -o out.s {{inputPath}} && cc -c -o {{outputPath}} out.s && rm -f out.s', {
        cwd: project,
      }),
    );
  });

  test('the benchmark command itself, handed over without naming its toolchain', async () => {
    untouched(await storeRun(BENCH.command, { cwd, cflags: ['-O2'] }));
  });

  test('the CLI’s ranked run: no store, no [candcache] line, whatever the store variables say', async () => {
    const fixture = (f: string): string => join(import.meta.dirname, 'fixtures', 'objdiff', f);
    const root = scratch('candcache-bench-cli-');
    const store = scratch('candcache-bench-cli-store-');
    const asm = join(root, 'add_one.s');
    writeFileSync(asm, '\t.text\n\t.code\t16\n\t.globl\tadd_one\n\t.thumb_func\nadd_one:\n\tadd\tr0, #1\n\tbx\tlr\n');
    const template = `cat {{inputPath}} > /dev/null && cp ${fixture('candidate-diff.o')} {{outputPath}}`;
    writeFileSync(
      join(root, 'decomp.yaml'),
      `name: test\nplatform: gba\nversions: []\ntools:\n  asmlift:\n    compiler: ${JSON.stringify(template)}\n`,
    );
    for (const env of [
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: store },
      { ASMLIFT_CANDCACHE: 'verfiy', ASMLIFT_CANDCACHE_DIR: '', ASMLIFT_CANDCACHE_SAMPLE: 'abc' },
    ]) {
      const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      vi.resetModules();
      let said = '';
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
        said += typeof c === 'string' ? c : Buffer.from(c).toString();
        return true;
      });
      let run: { code: number; stderr: string };
      try {
        run = await (
          await import('../../src/main')
        ).runCli([
          asm,
          '--name',
          'add_one',
          '--score-against',
          fixture('target.o'),
          '--config',
          join(root, 'decomp.yaml'),
        ]);
      } finally {
        spy.mockRestore();
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) {
            delete process.env[k];
          } else {
            process.env[k] = v;
          }
        }
        vi.resetModules();
      }
      expect(run.code, 'a nonmatching ranked run').toBe(1);
      expect(run.stderr + said).not.toContain('[candcache]');
      expect(readdirSync(store), 'the store directory is never written').toEqual([]);
    }
  });
});

describe('R310-28: an xcrun trampoline refuses the namespace', () => {
  test('a listing that loads libxcselect throws, naming what picks the tool', () => {
    const listing = [
      '/usr/bin/cpp:',
      '\t/usr/lib/libxcselect.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)',
    ].join('\n');
    expect(() => otoolLibraries(listing, '/usr/bin/cpp', '/usr/bin/cpp')).toThrow(
      '/usr/bin/cpp is an xcrun trampoline: the tool it runs is chosen by xcode-select, DEVELOPER_DIR, SDKROOT and TOOLCHAINS',
    );
  });

  test.runIf(platform() === 'darwin' && existsSync('/usr/bin/cpp'))(
    'a store run whose cpp is Apple’s /usr/bin/cpp stores nothing',
    async () => {
      expect(() => toolchainFileChain('/usr/bin/cpp')).toThrow(/is an xcrun trampoline/);
      const r = await storeRun(
        BENCH.command,
        { cwd, cflags: ['-O2'], bench: BENCH.bench },
        { PATH: `/usr/bin:/bin:${process.env.PATH}` },
      );
      expect(r.said).toContain('REFUSED label=command reason=stamp-threw: /usr/bin/cpp is an xcrun trampoline');
      expect(r.stats.stored).toBeUndefined();
      expect(r.namespaced).toBe(false);
    },
  );
});

describe('R310-29: the namespace holds the runner’s code', () => {
  const runner = runnerPackageDir();
  const copy = (): string => {
    const d = join(scratch('candcache-bench-runner-'), 'compiler');
    cpSync(runner, d, { recursive: true });
    return d;
  };
  const edit = (file: string, from: string, to: string): void => {
    const text = readFileSync(file, 'utf8');
    expect(text, file).toContain(from);
    writeFileSync(file, text.replace(from, to));
  };

  test('is the installed @match-kit/compiler, its files rather than a link to them', () => {
    expect(realpathSync(runner)).toBe(runner);
    expect(JSON.parse(readFileSync(join(runner, 'package.json'), 'utf8')).name).toBe('@match-kit/compiler');
    expect(commandStaticStamp(BENCH.command, cwd)).toBe(commandStaticStamp(BENCH.command, cwd, runner));
  });

  test('moves when the code that runs the template changes', () => {
    const before = copy();
    const after = copy();
    edit(join(after, 'dist/process/run.js'), "'-ec'", "'-c'");
    noteLoadedRunner(before);
    noteLoadedRunner(after);
    expect(commandStaticStamp(BENCH.command, cwd, after)).not.toBe(commandStaticStamp(BENCH.command, cwd, before));
  });

  test('moves when the code that words a failed outcome changes', () => {
    const before = copy();
    const after = copy();
    edit(
      join(after, 'dist/process/outcome.js'),
      'output: scrub(output, paths.dir)',
      "output: scrub(output, paths.dir) + '.'",
    );
    noteLoadedRunner(before);
    noteLoadedRunner(after);
    expect(commandStaticStamp(BENCH.command, cwd, after)).not.toBe(commandStaticStamp(BENCH.command, cwd, before));
  });

  test.each(['dependencies', 'peerDependencies', 'optionalDependencies'])(
    'refuses a runner whose %s name a package it does not measure',
    (field) => {
      const d = copy();
      const manifest = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      writeFileSync(join(d, 'package.json'), JSON.stringify({ ...manifest, [field]: { 'left-pad': '1.3.0' } }));
      noteLoadedRunner(d);
      expect(() => commandStaticStamp(BENCH.command, cwd, d)).toThrow(/depends on left-pad/);
    },
  );

  test('R310-37: holds the runner as it was loaded, not as the disk holds it at the stamp', () => {
    const d = copy();
    noteLoadedRunner(d);
    const loaded = commandStaticStamp(BENCH.command, cwd, d);
    edit(join(d, 'dist/process/run.js'), "'-ec'", "'-c'");
    expect(commandStaticStamp(BENCH.command, cwd, d), 'the process still runs what it loaded').toBe(loaded);
  });

  test('R310-37: refuses a runner no one recorded when it was loaded', () => {
    expect(() => commandStaticStamp(BENCH.command, cwd, copy())).toThrow(/was not recorded when it was loaded/);
  });

  test("R310-37: this module's own bytes are the ones it was loaded with", () => {
    const self = fileURLToPath(new URL('../../src/compile-command.ts', import.meta.url));
    expect(loadedCodeDigest(self)).toBe(sha(readFileSync(self)));
  });

  test('R310-37: a process whose compile-command.ts changed on disk after it loaded stamps the code it runs', () => {
    // A copy of this package's sources, beside them so that they resolve the same packages, and a
    // process per run: `edit` changes the copy's compile-command.ts after importing it.
    const pkg = fileURLToPath(new URL('../..', import.meta.url));
    const root = mkdtempSync(join(pkg, '.r310-37-'));
    try {
      cpSync(join(pkg, 'src'), join(root, 'src'), { recursive: true });
      const probe = join(root, 'probe.ts');
      writeFileSync(
        probe,
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          'const [command, cwd, mode] = JSON.parse(process.argv[2]) as [string, string, string];',
          "const { commandStaticStamp } = await import('./src/compile-command');",
          "const self = new URL('./src/compile-command.ts', import.meta.url);",
          "if (mode === 'edit') writeFileSync(self, readFileSync(self, 'utf8') + '// edited after the load\\n');",
          'console.log(commandStaticStamp(command, cwd));',
          '',
        ].join('\n'),
      );
      const tsx = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));
      const stamp = (mode: string): string =>
        execFileSync(tsx, [probe, JSON.stringify([BENCH.command, cwd, mode])], { encoding: 'utf8' }).trim();
      const original = readFileSync(join(root, 'src/compile-command.ts'));
      const editedAfterLoad = stamp('edit');
      expect(stamp('plain'), 'a process that loaded the edit is another namespace').not.toBe(editedAfterLoad);
      writeFileSync(join(root, 'src/compile-command.ts'), original);
      expect(stamp('plain'), 'and the one that loaded the original is this one').toBe(editedAfterLoad);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('R310-37: code a namespace hashes, as this process loaded it', () => {
  test('keeps the bytes it first read, whatever the file holds later', () => {
    const f = join(scratch('candcache-bench-loaded-'), 'run.js');
    writeFileSync(f, "spawn('sh', ['-ec', command]);\n");
    noteLoadedCode(f);
    const loaded = loadedCodeDigest(f);
    expect(loaded).toBe(sha(readFileSync(f)));
    writeFileSync(f, "spawn('sh', ['-c', command]);\n");
    noteLoadedCode(f);
    expect(loadedCodeDigest(f)).toBe(loaded);
  });

  test('refuses a file no module recorded, and one it could not read', () => {
    const d = scratch('candcache-bench-loaded-');
    expect(() => loadedCodeDigest(join(d, 'never.js'))).toThrow(/no module recorded when it was loaded/);
    noteLoadedCode(join(d, 'absent.js'));
    writeFileSync(join(d, 'absent.js'), '');
    expect(() => loadedCodeDigest(join(d, 'absent.js'))).toThrow(/cannot read .*absent\.js as it was loaded/);
  });
});

describe('R310-30: the libraries a program loads, as the loader finds them', () => {
  test('only /usr/lib and /System are the OS’s; /usr/local and /opt are followed', () => {
    const listing = [
      '/opt/tc/bin/cc1:',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)',
      '\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 4109.0.0)',
      '\t/usr/local/lib/libasmlift-none.1.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/opt/homebrew/lib/libasmlift-none.2.dylib (compatibility version 1.0.0, current version 1.0.0)',
    ].join('\n');
    expect(otoolLibraries(listing, '/opt/tc/bin/cc1', '/opt/tc/bin/cc1')).toEqual([
      'UNRESOLVED:/usr/local/lib/libasmlift-none.1.dylib',
      'UNRESOLVED:/opt/homebrew/lib/libasmlift-none.2.dylib',
    ]);
  });

  test('R310-40: refuses a listing that names no libSystem: it was not read as one', () => {
    const listing = '/opt/tc/bin/cc1:\n\t/opt/tc/lib/libisl.23.dylib (compatibility version 24.0.0)\n';
    expect(() => otoolLibraries(listing, '/opt/tc/bin/cc1', '/opt/tc/bin/cc1')).toThrow(
      'cannot read the libraries /opt/tc/bin/cc1 loads: otool -L names no /usr/lib/libSystem.B.dylib',
    );
    expect(() =>
      otoolLibraries('/opt/tc/bin/cc1: is not an object file\n', '/opt/tc/bin/cc1', '/opt/tc/bin/cc1'),
    ).toThrow(/names no \/usr\/lib\/libSystem\.B\.dylib/);
  });

  test.runIf(platform() === 'darwin')(
    'R310-40: refuses a program otool cannot read, which it lists as no libraries',
    () => {
      const elf = join(scratch('candcache-bench-elf-'), 'gcc');
      writeFileSync(elf, Buffer.concat([Buffer.from('\x7fELF\x01\x01\x01', 'latin1'), Buffer.alloc(64)]));
      chmodSync(elf, 0o755);
      expect(execFileSync('/usr/bin/otool', ['-L', elf], { encoding: 'utf8' })).toContain('is not an object file');
      expect(() => toolchainFileChain(elf)).toThrow(/otool -L names no \/usr\/lib\/libSystem\.B\.dylib/);
    },
  );

  test('refuses a library loaded through the run path', () => {
    const listing =
      '/opt/tc/bin/cc1:\n\t@rpath/libisl.23.dylib (compatibility version 24.0.0, current version 24.0.0)\n';
    expect(() => otoolLibraries(listing, '/opt/tc/bin/cc1', '/opt/tc/bin/cc1')).toThrow(
      '/opt/tc/bin/cc1 loads @rpath/libisl.23.dylib through its run path',
    );
  });

  test('reads @loader_path from the library and @executable_path from the main program, and skips the library’s own name', () => {
    const exeDir = scratch('candcache-bench-exe-');
    const libDir = scratch('candcache-bench-libdir-');
    for (const f of [join(exeDir, 'libexe.dylib'), join(libDir, 'libload.dylib')]) {
      writeFileSync(f, '');
    }
    const listing = [
      `${libDir}/libouter.dylib:`,
      `\t${libDir}/libouter.dylib (compatibility version 1.0.0, current version 1.0.0)`,
      '\t@executable_path/libexe.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t@loader_path/libload.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)',
    ].join('\n');
    expect(
      otoolLibraries(listing, join(libDir, 'libouter.dylib'), join(exeDir, 'prog'), [join(libDir, 'libouter.dylib')]),
    ).toEqual([join(exeDir, 'libexe.dylib'), join(libDir, 'libload.dylib')]);
  });

  test.runIf(platform() === 'darwin')(
    'a library’s @executable_path and @loader_path libraries are in its program’s chain',
    () => {
      const exeDir = scratch('candcache-bench-exe-');
      const libDir = scratch('candcache-bench-libdir-');
      const c = (dir: string, name: string, body: string): string => {
        writeFileSync(join(dir, name), body);
        return join(dir, name);
      };
      const lib = (dir: string, name: string, installName: string, ...rest: string[]): string => {
        execFileSync('cc', ['-dynamiclib', '-install_name', installName, '-o', join(dir, name), ...rest]);
        return join(dir, name);
      };
      const libexe = lib(
        exeDir,
        'libexe.dylib',
        '@executable_path/libexe.dylib',
        c(exeDir, 'e.c', 'int e(void) { return 1; }\n'),
      );
      const libload = lib(
        libDir,
        'libload.dylib',
        '@loader_path/libload.dylib',
        c(libDir, 'l.c', 'int l(void) { return 2; }\n'),
      );
      const outer = join(libDir, 'libouter.dylib');
      lib(
        libDir,
        'libouter.dylib',
        outer,
        c(libDir, 'o.c', 'int e(void); int l(void);\nint o(void) { return e() + l(); }\n'),
        libexe,
        libload,
      );
      execFileSync('cc', [
        '-o',
        join(exeDir, 'prog'),
        c(exeDir, 'main.c', 'int o(void);\nint main(void) { return o() == 3 ? 0 : 1; }\n'),
        outer,
      ]);
      execFileSync(join(exeDir, 'prog'), { stdio: 'pipe' }); // dyld finds every library where the chain says
      expect(toolchainFileChain(join(exeDir, 'prog'))).toEqual(
        expect.arrayContaining([realpathSync(outer), realpathSync(libexe), realpathSync(libload)]),
      );
    },
  );

  describe('on Linux, through the ldd on PATH (a stand-in here)', () => {
    const lddSaying = (stdout: string, status: number): NodeJS.ProcessEnv => {
      const bin = scratch('candcache-bench-ldd-');
      script(bin, 'ldd', `#!/bin/sh\nprintf '%s' '${stdout}'\nexit ${status}\n`);
      return { PATH: `${bin}:/usr/bin:/bin` };
    };
    test('a dynamic program loads the libraries ldd lists, the C library and its loader included', () => {
      const env = lddSaying(
        '\tlinux-vdso.so.1 (0x00007ffd3b7f2000)\n' +
          '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f3c1a200000)\n' +
          '\t/lib64/ld-linux-x86-64.so.2 (0x00007f3c1a9d2000)\n',
        0,
      );
      expect(linuxLibraries('/usr/bin/wibo', env)).toEqual([
        '/lib/x86_64-linux-gnu/libc.so.6',
        '/lib64/ld-linux-x86-64.so.2',
      ]);
    });
    test('a static program loads none', () => {
      expect(linuxLibraries('/opt/gcc272/gcc', lddSaying('\tnot a dynamic executable\n', 1))).toEqual([]);
      expect(linuxLibraries('/opt/gcc272/gcc', lddSaying('\tstatically linked\n', 0))).toEqual([]);
    });
    test('a listing ldd could not make throws', () => {
      expect(() =>
        linuxLibraries('/opt/gcc272/gcc', lddSaying('ldd: /opt/gcc272/gcc: No such file or directory\n', 1)),
      ).toThrow('cannot list the libraries /opt/gcc272/gcc loads: ldd ldd: /opt/gcc272/gcc: No such file or directory');
    });
  });

  test('compileEnvironment keys GLIBC_TUNABLES', () => {
    const base = { PATH: '/bin' };
    expect(compileEnvironment({ ...base, GLIBC_TUNABLES: 'glibc.malloc.perturb=1' })).not.toBe(
      compileEnvironment(base),
    );
  });
});

describe('R310-31: the namespace keys the OS build', () => {
  test('names the macOS build on macOS, and nothing more elsewhere', () => {
    const env = compileEnvironment({ PATH: '/bin' });
    if (platform() === 'darwin') {
      const build = execFileSync('/usr/bin/sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim();
      expect(env).toMatch(new RegExp(`^os:.*BuildVersion: ${build}$`, 'm'));
    } else {
      expect(env).not.toMatch(/^os:/m);
    }
  });
});
