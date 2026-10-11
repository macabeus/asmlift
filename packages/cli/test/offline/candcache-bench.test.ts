// The candidate store keys the benchmark's own commands and no other (src/candcache-bench.ts): a
// committed benchmark template under the benchmark's placeholder values, byte for byte, whose every
// program is a native executable or a flagless `#!/bin/sh` exec shim, compiled under an environment
// that changes nothing the namespace cannot see (src/candcache.ts `refuseUnkeyedEnv`).
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { NOT_A_BENCH_TEMPLATE, benchCommand, benchCommandRefusal } from '../../src/candcache-bench';
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
const withAgbcc = (program: string): { command: string; bench: typeof BENCH.bench } => {
  const bench = { toolchain: 'agbcc', placeholders: { ...BENCH.bench.placeholders, ASMLIFT_AGBCC: program } };
  return { command: benchCommand(bench), bench };
};

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

describe('R310-16: a variable that changes what a compile runs or reads refuses the namespace', () => {
  test.each([
    'BASH_FUNC_cpp%%',
    'BASH_FUNC_arm-none-eabi-gcc%%',
    'BASH_ENV',
    'ENV',
    'CCC_OVERRIDE_OPTIONS',
    'GCC_EXEC_PREFIX',
    'COMPILER_PATH',
    'CPATH',
    'C_INCLUDE_PATH',
    'CPLUS_INCLUDE_PATH',
    'OBJC_INCLUDE_PATH',
    'DEPENDENCIES_OUTPUT',
    'SUNPRO_DEPENDENCIES',
  ])('%s', async (name) => {
    const { refuseUnkeyedEnv } = await import('../../src/candcache');
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
): Promise<{ stats: Record<string, number>; said: string; namespaced: boolean }> {
  const store = scratch('candcache-bench-store-');
  const all = { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: store, ...env };
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

describe('a project’s own command is never keyed', () => {
  const project = scratch('candcache-bench-project-');
  writeFileSync(join(project, 'x.cfg'), '-include pre.h\n');
  writeFileSync(join(project, 'pre.h'), '#define K 1\n');
  mkdirSync(join(project, 'gt/x'), { recursive: true });
  const refusedOutright = (r: Awaited<ReturnType<typeof storeRun>>): void => {
    expect(r.said).toContain(`REFUSED-KEY label=command reason=${NOT_A_BENCH_TEMPLATE}`);
    expect(r.stats).toMatchObject({ refusedKeys: 1 });
    expect(r.stats.stored).toBeUndefined();
    expect(r.namespaced, 'nor stamped').toBe(false);
  };

  test('R310-17: a glued -B prefix, a --config file, a GCC_EXEC_PREFIX assignment', async () => {
    for (const command of [
      'cc -Bpfx- -O2 -c -o {{outputPath}} {{inputPath}}',
      'cc --config=./x.cfg -O2 -c -o {{outputPath}} {{inputPath}}',
      'GCC_EXEC_PREFIX=gt/x/ cc -O2 -c -o {{outputPath}} {{inputPath}}',
    ]) {
      refusedOutright(await storeRun(command, { cwd: project }));
    }
  });

  test('R310-18: an intermediate written outside the scratch directory', async () => {
    refusedOutright(
      await storeRun('cc -O2 -S -o out.s {{inputPath}} && cc -c -o {{outputPath}} out.s && rm -f out.s', {
        cwd: project,
      }),
    );
  });

  test('the benchmark command itself, handed over without naming its toolchain', async () => {
    refusedOutright(await storeRun(BENCH.command, { cwd, cflags: ['-O2'] }));
  });
});
