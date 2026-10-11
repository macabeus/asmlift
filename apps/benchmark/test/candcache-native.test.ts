// The native commands (dataset/toolchains/native-commands.yaml) behind the candidate store: on a host
// that runs GCC 2.7.2 and CodeWarrior's 32-bit Linux binaries natively, `benchCommandFor` hands their
// rows the native command, and the store keys it as it keys a committed decomp.yaml command. The
// host is a stand-in (`BenchHost`), and the compilers are doubles built here with the host's `cc`, so
// every case runs on every host:
//   - `gcc` writes its flags, the `cc1` beside it, the COMPILER_PATH it was handed and its input to
//     its `-o` output — so an object follows the compiler's directory as GCC 2.7.2's does;
//   - `wibo` writes the program it was asked to run (CodeWarrior's `mwcceppc.exe`, a data file here),
//     its flags and its input — so an object follows that program and the runner.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { type BenchHost, benchCommandFor } from '../src/decomp-config';
import type { ToolchainId } from '../src/toolchains';

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

const SOURCE = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Which build this is: bytes of the program, never of its output. */
const char *build_tag = BUILD_TAG;

static void copy(FILE *o, const char *path) {
  FILE *f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "%s: cannot read\n", path);
    exit(2);
  }
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) {
    fwrite(buf, 1, n, o);
  }
  fclose(f);
}

int main(int argc, char **argv) {
  const char *self = strrchr(argv[0], '/') ? strrchr(argv[0], '/') + 1 : argv[0];
  int wibo = !strcmp(self, "wibo");
  const char *out = 0, *in = 0, *b = 0;
  for (int i = wibo ? 2 : 1; i < argc; i++) {
    if (!strcmp(argv[i], "-o") && i + 1 < argc) {
      out = argv[++i];
    } else if (!strcmp(argv[i], "-B") && i + 1 < argc) {
      b = argv[++i];
    } else if (!strcmp(argv[i], "-pragma") && i + 1 < argc) {
      i++;
    } else if (argv[i][0] != '-') {
      in = argv[i];
    }
  }
  if (!out || !in) {
    fprintf(stderr, "%s: usage\n", self);
    return 2;
  }
  FILE *o = fopen(out, "wb");
  fprintf(o, "%s:", self);
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] == '-') {
      fprintf(o, " %s", argv[i]);
    }
  }
  fputs("\n", o);
  if (wibo) {
    copy(o, argv[1]);
  } else {
    char cc1[4096];
    snprintf(cc1, sizeof cc1, "%scc1", b ? b : "");
    copy(o, cc1);
    fprintf(o, "COMPILER_PATH=%s\n", getenv("COMPILER_PATH") ? getenv("COMPILER_PATH") : "");
  }
  copy(o, in);
  fclose(o);
  return 0;
}
`;

/** The doubles' directories: GCC 2.7.2's (a `gcc` and a `cc1`), CodeWarrior's (an `mwcceppc.exe`), and
 *  the one `wibo` lives in. */
function doubles(): { gccDir: string; mwccDir: string; wibo: string; build: (tag: string) => string } {
  const src = scratch('native-double-src-');
  writeFileSync(join(src, 'double.c'), SOURCE);
  const build = (tag: string): string => {
    const out = join(src, `double-${tag}`);
    execFileSync('cc', ['-O1', `-DBUILD_TAG="${tag}"`, '-o', out, join(src, 'double.c')]);
    return out;
  };
  const gccDir = scratch('native-gcc272-');
  copyFileSync(build('a'), join(gccDir, 'gcc'));
  chmodSync(join(gccDir, 'gcc'), 0o755);
  writeFileSync(join(gccDir, 'cc1'), 'cc1 v1\n');
  const mwccDir = scratch('native-mwcc-');
  writeFileSync(join(mwccDir, 'mwcceppc.exe'), 'mwcceppc v1\n');
  const wiboDir = scratch('native-wibo-');
  copyFileSync(build('a'), join(wiboDir, 'wibo'));
  chmodSync(join(wiboDir, 'wibo'), 0o755);
  return { gccDir, mwccDir, wibo: join(wiboDir, 'wibo'), build };
}

const D = doubles();
const STAND_IN: BenchHost = {
  native: () => true,
  placeholders: () => ({ ASMLIFT_GCC272_DIR: D.gccDir, ASMLIFT_MWCC_DIR: D.mwccDir, ASMLIFT_NATIVE_WIBO: D.wibo }),
};
const NATIVE: readonly ToolchainId[] = ['gcc2.7.2', 'mwcc_233_163n', 'mwcc_247_107'];
const FLAGS = ['-O1'];
/** The command's working directory, which the namespace keys: one for every run, as the benchmark's is. */
const CWD = scratch('native-cwd-');
const TU = 'int f(void) { return 7; }\n';

/** One run of asmlift's worth of modules over `store`: compile `TU` through `id`'s command on
 *  `host`, and report the object and what the store did. */
async function storeRun(
  id: ToolchainId,
  store: string,
  host: BenchHost = STAND_IN,
): Promise<{ object: string; stats: Record<string, number>; said: string }> {
  const env = { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_SAMPLE: '0', ASMLIFT_CANDCACHE_DIR: store };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let said = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    said += typeof c === 'string' ? c : Buffer.from(c).toString();
    return true;
  });
  vi.resetModules();
  try {
    const { compileFromCommand } = await import('@asmlift/cli/compile-command');
    const { command, bench } = benchCommandFor(id, host);
    const object = readFileSync(
      await compileFromCommand(command, { cwd: CWD, cflags: FLAGS, bench })(TU, 'f', 'c'),
      'utf8',
    );
    return { object, stats: (await import('@asmlift/cli/candcache')).cacheStats(), said };
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

describe('benchCommandFor on a host that runs the 32-bit toolchains natively', () => {
  test.each(NATIVE)('%s gets its native command, named to the store as native', (id) => {
    const { command, bench } = benchCommandFor(id, STAND_IN);
    expect(bench).toMatchObject({ toolchain: id, native: true });
    expect(command).toMatch(/^cd "\$\(dirname \{\{outputPath\}\}\)" && /);
    expect(command).not.toContain('docker');
  });

  test.each(NATIVE)('%s gets its committed docker command on a host that does not', (id) => {
    const docker = {
      ASMLIFT_DOCKER: 'docker',
      ASMLIFT_GCC272_IMAGE: 'img',
      ASMLIFT_PPC_IMAGE: 'img',
      ASMLIFT_WIBO: 'wibo',
    };
    const { command, bench } = benchCommandFor(id, {
      native: () => false,
      placeholders: (t) => ({ ...STAND_IN.placeholders(t), ...docker }),
    });
    expect(bench.native).toBeUndefined();
    expect(command).toContain(' run --rm ');
  });
});

describe('the store keys a native command as it keys a committed one', () => {
  test.each(NATIVE)('%s: a cold run stores, and a warm run serves the same object', async (id) => {
    const store = join(scratch(`native-store-${id}-`), 'store');
    const cold = await storeRun(id, store);
    expect(cold.stats, cold.said).toMatchObject({ miss: 1, stored: 1 });
    const warm = await storeRun(id, store);
    expect(warm.stats).toEqual({ hit: 1 });
    expect(warm.object).toBe(cold.object);
  });

  test('gcc2.7.2: the COMPILER_PATH directory is keyed by content — an edited cc1 serves nothing', async () => {
    const store = join(scratch('native-store-cc1-'), 'store');
    const cold = await storeRun('gcc2.7.2', store);
    expect(cold.object).toContain('cc1 v1');
    expect(cold.object).toContain(`COMPILER_PATH=${D.gccDir}`);
    writeFileSync(join(D.gccDir, 'cc1'), 'cc1 v2\n');
    try {
      const warm = await storeRun('gcc2.7.2', store);
      expect(warm.stats).toMatchObject({ miss: 1, stored: 1 });
      expect(warm.object).toContain('cc1 v2');
    } finally {
      writeFileSync(join(D.gccDir, 'cc1'), 'cc1 v1\n');
    }
  });

  test('mwcc: the compiler directory and the wibo binary are keyed by content', async () => {
    const store = join(scratch('native-store-mwcc-'), 'store');
    expect((await storeRun('mwcc_233_163n', store)).object).toContain('mwcceppc v1');
    writeFileSync(join(D.mwccDir, 'mwcceppc.exe'), 'mwcceppc v2\n');
    const edited = await storeRun('mwcc_233_163n', store);
    expect(edited.stats).toMatchObject({ miss: 1, stored: 1 });
    expect(edited.object).toContain('mwcceppc v2');
    copyFileSync(D.build('b'), D.wibo);
    chmodSync(D.wibo, 0o755);
    const rebuilt = await storeRun('mwcc_233_163n', store);
    expect(rebuilt.stats, 'another wibo is another namespace').toMatchObject({ miss: 1, stored: 1 });
  });

  test('a native command handed over without naming itself never reaches the store', async () => {
    const store = join(scratch('native-store-unnamed-'), 'store');
    const saved = {
      ASMLIFT_CANDCACHE: process.env.ASMLIFT_CANDCACHE,
      ASMLIFT_CANDCACHE_DIR: process.env.ASMLIFT_CANDCACHE_DIR,
    };
    Object.assign(process.env, { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: store });
    vi.resetModules();
    try {
      const { compileFromCommand } = await import('@asmlift/cli/compile-command');
      const { command } = benchCommandFor('gcc2.7.2', STAND_IN);
      await compileFromCommand(command, { cwd: scratch('native-cwd-'), cflags: FLAGS })(TU, 'f', 'c');
      expect((await import('@asmlift/cli/candcache')).cacheStats()).toEqual({});
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
      vi.resetModules();
    }
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([]);
  });
});

describe('a native command for another toolchain is not that toolchain’s', () => {
  test('gcc2.7.2’s native command named as CodeWarrior’s is refused every key', async () => {
    const { command } = benchCommandFor('gcc2.7.2', STAND_IN);
    const { bench } = benchCommandFor('mwcc_233_163n', STAND_IN);
    const store = join(scratch('native-store-swap-'), 'store');
    const saved = {
      ASMLIFT_CANDCACHE: process.env.ASMLIFT_CANDCACHE,
      ASMLIFT_CANDCACHE_DIR: process.env.ASMLIFT_CANDCACHE_DIR,
    };
    Object.assign(process.env, { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: store });
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.resetModules();
    try {
      const { compileFromCommand } = await import('@asmlift/cli/compile-command');
      await compileFromCommand(command, { cwd: scratch('native-cwd-'), cflags: FLAGS, bench })(TU, 'f', 'c');
      expect((await import('@asmlift/cli/candcache')).cacheStats()).toEqual({ refusedKeys: 1 });
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
  });
});
