// The cross-run candidate-object cache's NAMESPACE, on the bench's real agbcc pipeline.
//
// This is `cache-poison.test.ts`'s class at a new site. That file is about an entry whose CONTENT
// is poison; this one is about an entry whose KEY is a lie — a stored object served after an input
// moved. It compiles, it scores, and it is a claim about a toolchain that no longer produced it.
//
// Three holes were reproduced on this pipeline before the namespace closed them, each of which
// served a stale object as a real benchmark score:
//
//   1. The harness's OWN TypeScript. `compileCandidateRaw` preprocesses, runs `stripPrototype`,
//      runs agbcc, APPENDS `.text/.align 2, 0` to the `.s`, and assembles. Patching that tail to
//      `.align 4, 0` served the 644-byte object where the truth is 660, with every binary, flag
//      and `--version` banner identical.
//   4. The BINARIES behind the bare command names. `arm-none-eabi-cpp` and `arm-none-eabi-as`
//      entered only through their `--version` output; a shell wrapper first on $PATH left the
//      namespace unmoved three times running.
//   5. The compile ENVIRONMENT. `CPATH` is honoured by the preprocessor even under `-nostdinc`,
//      so it is an input to every candidate compile although nothing on the command line names it.
//
// The assertions are on the two exported halves of the namespace rather than on a live compile:
// `candCacheNamespaceFiles()` and `SHAPING_SOURCES` are the LISTS (a dropped entry is an input the cache
// stops noticing) and `candCacheStaticStamp(cflags, files, sources)` is the digest over them (content, not
// paths; the sources' as this process loaded them). The pipeline's own
// object bytes are the third half, measured by the two-directory probe, which needs agbcc and is
// exercised by the matching suite.
//
// Only the DIGEST half runs everywhere. Building the LIST is itself a measurement of the machine's
// compilers — it resolves `TOOLCHAIN.agbcc` and follows its delegates, and REFUSES rather than
// guess when the binary is not installed — so the two tests that call it are skipped where agbcc
// is absent, which is every hosted runner. What must not be lost there is the dropped-entry guard,
// so `SHAPING_SOURCES` is asserted directly: that half is a constant and needs no toolchain.
import { loadedCodeDigest, noteLoadedCode, refuseUnkeyedEnv, sha, toolchainFileChain } from '@asmlift/cli/candcache';
import { TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { TOOLCHAIN } from '@asmlift/toolchains';
import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { SHAPING_SOURCES, candCacheNamespaceFiles, candCacheStaticStamp } from '../src/compile/agbcc';

const HARNESS = join(import.meta.dirname, '../src/compile');
/** Building the namespace's file list resolves the installed agbcc and follows what it delegates
 *  to; where there is no agbcc there is nothing to measure and the module refuses, by design. */
const HAVE_AGBCC = existsSync(TOOLCHAIN.agbcc);
const scratch = (): string => mkdtempSync(join(tmpdir(), 'candcache-ns-'));
const CANONICAL = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
const CLT_CLANG = '/Library/Developer/CommandLineTools/usr/bin/clang';
const OLD_SDK = '/Library/Developer/CommandLineTools/SDKs/MacOSX12.3.sdk';

describe('hole 1 — the namespace hashes the harness code that shapes the compiler input', () => {
  test('agbcc.ts and util.ts are shaping sources, and they exist', () => {
    for (const shaping of ['agbcc.ts', 'util.ts']) {
      const hit = SHAPING_SOURCES.find((f) => f === join(HARNESS, shaping));
      expect(hit, `${shaping} must be a namespace input: it shapes what the compiler is handed`).toBeDefined();
      expect(readFileSync(hit!, 'utf8').length).toBeGreaterThan(0);
    }
  });

  test("core's compiler-diagnostics.ts is one: it words the message a stored rejection is served with", () => {
    const hit = SHAPING_SOURCES.find(
      (f) => f === join(HARNESS, '../../../../packages/core/src/compiler-diagnostics.ts'),
    );
    expect(hit, 'errorsFirst orders the diagnostic lines `stepFailed` keeps').toBeDefined();
    expect(readFileSync(hit!, 'utf8')).toMatch(/export function errorsFirst\b/);
  });

  test("the CLI's candcache-reads.ts is one: it decides, after the compile, which answers are kept", () => {
    const hit = SHAPING_SOURCES.find((f) => f === join(HARNESS, '../../../../packages/cli/src/candcache-reads.ts'));
    expect(hit, 'a stricter classifier must never serve what a looser one kept').toBeDefined();
    expect(readFileSync(hit!, 'utf8')).toMatch(/export function candidateReadsRefusal\b/);
  });

  test('…and the namespace hashes each of them as this process loaded it', () => {
    for (const f of SHAPING_SOURCES) {
      expect(loadedCodeDigest(f), f).toBe(sha(readFileSync(f)));
    }
  });

  test('patching the .s tail agbcc.ts appends MOVES the digest — the exact stale-object repro', () => {
    const before = join(scratch(), 'agbcc.ts');
    const after = join(scratch(), 'agbcc.ts');
    copyFileSync(join(HARNESS, 'agbcc.ts'), before);
    const src = readFileSync(before, 'utf8');
    expect(src, 'this test pins the real tail; if the pipeline changed it, re-pin it here').toContain(
      "'\\n.text\\n\\t.align\\t2, 0\\n'",
    );
    writeFileSync(after, src.replace("'\\n.text\\n\\t.align\\t2, 0\\n'", "'\\n.text\\n\\t.align\\t4, 0\\n'"));
    noteLoadedCode(before, after);

    expect(
      candCacheStaticStamp(CANONICAL, [], [after]),
      'a harness edit that changes the object must re-namespace',
    ).not.toBe(candCacheStaticStamp(CANONICAL, [], [before]));
  });

  test('it is CONTENT, not the path: identical bytes at two paths agree, different bytes do not', () => {
    const a = join(scratch(), 'shaping.ts');
    const b = join(scratch(), 'shaping.ts');
    writeFileSync(a, 'export const tail = 2;\n');
    copyFileSync(a, b);
    // The path is in the digest too (it names WHICH input this is), so compare each against
    // itself under an edit rather than against the other.
    const bBefore = candCacheStaticStamp(CANONICAL, [b]);
    expect(candCacheStaticStamp(CANONICAL, [a])).toBe(candCacheStaticStamp(CANONICAL, [a]));
    writeFileSync(b, 'export const tail = 4;\n');
    expect(candCacheStaticStamp(CANONICAL, [b])).not.toBe(bBefore);
  });

  test('an input that cannot be READ throws — the cache refuses, it never guesses', () => {
    expect(() => candCacheStaticStamp(CANONICAL, [join(scratch(), 'absent.ts')])).toThrow(/ENOENT|no such file/i);
    const unreadable = join(scratch(), 'absent.ts');
    noteLoadedCode(unreadable);
    writeFileSync(unreadable, 'export const late = 1;\n');
    expect(() => candCacheStaticStamp(CANONICAL, [], [unreadable])).toThrow(/cannot read .* as it was loaded/);
  });
});

describe('R310-37: the harness code is hashed as this process loaded it', () => {
  test('an edit on disk after the load does not move the namespace', () => {
    const src = join(scratch(), 'util.ts');
    copyFileSync(join(HARNESS, 'util.ts'), src);
    noteLoadedCode(src);
    const loaded = candCacheStaticStamp(CANONICAL, [], [src]);
    writeFileSync(src, readFileSync(src, 'utf8').replace('.slice(0, 240)', '.slice(0, 24)'));
    expect(candCacheStaticStamp(CANONICAL, [], [src]), 'the process still runs what it loaded').toBe(loaded);
  });

  test('a source no module recorded when it loaded refuses the namespace', () => {
    const src = join(scratch(), 'unrecorded.ts');
    writeFileSync(src, 'export const tail = 2;\n');
    expect(() => candCacheStaticStamp(CANONICAL, [], [src])).toThrow(/no module recorded when it was loaded/);
  });
});

describe('hole 4 — the namespace hashes the BINARIES, not their version banners', () => {
  test.skipIf(!HAVE_AGBCC)(
    'the assembler and the preprocessor are on the list, resolved or explicitly UNRESOLVED',
    () => {
      const files = candCacheNamespaceFiles();
      // agbcc, the assembler, the preprocessor AND WHATEVER THOSE DELEGATE TO. The count is not
      // the claim (a chain is as long as the toolchain makes it); every entry being a real file or
      // an explicit marker is.
      expect(files.length).toBeGreaterThanOrEqual(3);
      for (const entry of files) {
        expect(
          entry.startsWith('/') || entry.startsWith('UNRESOLVED:'),
          `a bare command name must resolve to a file to hash, or say it did not: ${entry}`,
        ).toBe(true);
      }
    },
  );

  test('a DELEGATE is a namespace input: the chain does not stop at the file a name resolves to', () => {
    // The hole this closes, measured on this machine: `cpp` is a 208-byte `#!/bin/sh` shim that
    // execs Homebrew's `cpp-14`, and `arm-none-eabi-cpp` is a driver binary that execs
    // `libexec/gcc/arm-none-eabi/14.2.1/cc1`. Hashing the outer file left the namespace at
    // cb762832443c2108 while the delegate emitted different code, and the stale object was served.
    const shimDir = scratch();
    const delegate = join(shimDir, 'real-tool');
    writeFileSync(delegate, '#!/bin/sh\nexec /usr/bin/true VERSION-ONE\n');
    const shim = join(shimDir, 'wrapper');
    writeFileSync(shim, `#!/bin/sh\nexec ${delegate} "$@"\n`);
    chmodSync(delegate, 0o755);
    chmodSync(shim, 0o755);

    // realpath: the chain is de-duplicated by real path, and $TMPDIR on macOS is a symlink.
    const chain = toolchainFileChain(shim);
    expect(chain, 'the delegate is IN the chain, not merely mentioned by it').toContain(realpathSync(delegate));

    const before = candCacheStaticStamp(CANONICAL, chain);
    writeFileSync(delegate, '#!/bin/sh\nexec /usr/bin/true VERSION-TWO\n');
    expect(
      candCacheStaticStamp(CANONICAL, toolchainFileChain(shim)),
      'editing what the wrapper EXECS must re-namespace, with the wrapper byte-identical',
    ).not.toBe(before);
    expect(readFileSync(shim, 'utf8'), 'the wrapper really did not move').toContain(delegate);
  });

  test('a wrapper that COMPUTES the program it runs is a refusal, never a hashed stand-in', () => {
    const dir = scratch();
    const p = join(dir, 'computed');
    writeFileSync(p, '#!/bin/sh\nexec "$(command -v true)" "$@"\n');
    chmodSync(p, 0o755);
    expect(() => toolchainFileChain(p)).toThrow(/computes the program it runs/);
  });

  test('a wrapper that names its delegate through a VARIABLE has that variable MEASURED', () => {
    // The commonest wrapper spelling there is (ccache / distcc / a toolchain wrapper):
    // `exec "$MYCPP" "$@"`. A syntax list that refuses `$(...)` and follows a literal path sees
    // nothing here at all — measured end to end, one byte-constant wrapper and two real compilers
    // gave ONE namespace and served the first compiler's object for the second.
    const dir = scratch();
    const a = join(dir, 'cc-a');
    const b = join(dir, 'cc-b');
    writeFileSync(a, '#!/bin/sh\nexec /usr/bin/true VERSION-ONE\n');
    writeFileSync(b, '#!/bin/sh\nexec /usr/bin/true VERSION-TWO\n');
    const w = join(dir, 'wrapper-var');
    writeFileSync(w, '#!/bin/sh\nexec "$ASMLIFT_TEST_DELEGATE" "$@"\n');
    for (const f of [a, b, w]) {
      chmodSync(f, 0o755);
    }

    const chainWith = (v: string): string[] => {
      process.env.ASMLIFT_TEST_DELEGATE = v;
      try {
        return toolchainFileChain(w);
      } finally {
        delete process.env.ASMLIFT_TEST_DELEGATE;
      }
    };
    const chainA = chainWith(a);
    expect(chainA, 'the variable itself is the measurement').toContain(`ENV:ASMLIFT_TEST_DELEGATE=${a}`);
    expect(chainA, 'and the file it names is followed like any other delegate').toContain(realpathSync(a));

    const stampA = candCacheStaticStamp(CANONICAL, chainA);
    expect(candCacheStaticStamp(CANONICAL, chainWith(b)), 'repointing the variable re-namespaces').not.toBe(stampA);
    expect(candCacheStaticStamp(CANONICAL, chainWith(a)), 'and pointing it back is the same toolchain again').toBe(
      stampA,
    );
    expect(readFileSync(w, 'utf8'), 'the wrapper really did not move').toBe(
      '#!/bin/sh\nexec "$ASMLIFT_TEST_DELEGATE" "$@"\n',
    );
  });

  test('a variable the script ASSIGNS itself is not an external input', () => {
    const dir = scratch();
    const w = join(dir, 'wrapper-selfassign');
    writeFileSync(w, '#!/bin/sh\nASMLIFT_TOOL=/usr/bin/true\nexec "$ASMLIFT_TOOL" "$@"\n');
    chmodSync(w, 0o755);
    expect(toolchainFileChain(w).some((e) => e.startsWith('ENV:ASMLIFT_TOOL='))).toBe(false);
  });

  test('the file half is keyed by CONTENT, not by the absolute path it sits at', () => {
    // Two worktrees of this repo hold byte-identical sources and toolchains at different paths.
    // Keying the digest on the path gave each its own namespace, so every parallel round
    // cold-started and left a second store behind that nothing ever evicts.
    const one = join(scratch(), 'agbcc.ts');
    const two = join(scratch(), 'agbcc.ts');
    writeFileSync(one, 'export const x = 1;\n');
    writeFileSync(two, 'export const x = 1;\n');
    expect(candCacheStaticStamp(CANONICAL, [two])).toBe(candCacheStaticStamp(CANONICAL, [one]));
    writeFileSync(two, 'export const x = 2;\n');
    expect(candCacheStaticStamp(CANONICAL, [two]), 'content still decides').not.toBe(
      candCacheStaticStamp(CANONICAL, [one]),
    );
  });

  test('a same-named binary with different bytes is a different toolchain', () => {
    // What a $PATH wrapper does, without touching $PATH: the same list position, other bytes.
    const p = join(scratch(), 'arm-none-eabi-as');
    writeFileSync(p, '#!/bin/sh\nexec /usr/bin/true "$@"\n');
    const before = candCacheStaticStamp(CANONICAL, [p]);
    writeFileSync(p, '#!/bin/sh\nexec /usr/bin/false "$@"\n');
    expect(candCacheStaticStamp(CANONICAL, [p])).not.toBe(before);
  });
});

describe('hole 5 — the compile environment is an input to every candidate compile', () => {
  const withEnv = (v: string, value: string | undefined, f: () => string): string => {
    const had = process.env[v];
    if (value === undefined) {
      delete process.env[v];
    } else {
      process.env[v] = value;
    }
    try {
      return f();
    } finally {
      if (had === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = had;
      }
    }
  };

  test('CPATH and C_INCLUDE_PATH refuse the namespace — cpp honours them even under -nostdinc', () => {
    for (const v of ['CPATH', 'C_INCLUDE_PATH']) {
      withEnv(v, '/private/tmp/candcache-ns-probe-inc', () => {
        expect(() => refuseUnkeyedEnv(), `${v} names directories, not what is in them`).toThrow(v);
        return '';
      });
    }
  });

  test('the locale moves the digest — it words the rejections the store keeps', () => {
    for (const v of ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES']) {
      const c = withEnv(v, 'C', () => candCacheStaticStamp(CANONICAL, []));
      const de = withEnv(v, 'de_DE.UTF-8', () => candCacheStaticStamp(CANONICAL, []));
      expect(de, `${v} picks a message's language`).not.toBe(c);
    }
  });

  test('the diagnostic variables move the digest — they word the rejections the store keeps', () => {
    for (const v of ['GCC_COLORS', 'GCC_URLS', 'TERM_URLS', 'GCC_EXTRA_DIAGNOSTIC_OUTPUT', 'COLUMNS']) {
      const bare = withEnv(v, undefined, () => candCacheStaticStamp(CANONICAL, []));
      const set = withEnv(v, '40', () => candCacheStaticStamp(CANONICAL, []));
      expect(set, `${v} shapes a diagnostic's colours, links, fix-it lines or width`).not.toBe(bare);
    }
  });

  test('the SDK a clang reads its predefines from moves the digest', () => {
    for (const v of ['SDKROOT', 'DEVELOPER_DIR']) {
      const bare = withEnv(v, undefined, () => candCacheStaticStamp(CANONICAL, []));
      const set = withEnv(v, '/Library/Developer/CommandLineTools', () => candCacheStaticStamp(CANONICAL, []));
      expect(set, `${v} picks the SDK`).not.toBe(bare);
    }
  });

  test.runIf(existsSync(CLT_CLANG) && existsSync(OLD_SDK))('…because a clang predefines from SDKROOT', () => {
    const predefined = (sdk: string | undefined): string =>
      withEnv('SDKROOT', sdk, () =>
        execSync(`${CLT_CLANG} -E -P -nostdinc -`, {
          input: 'int v = __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__;\n',
          encoding: 'utf8',
        }).trim(),
      );
    expect(predefined(OLD_SDK)).toBe('int v = 120300;');
    expect(predefined(undefined)).not.toBe(predefined(OLD_SDK));
  });

  test('an unrelated variable does NOT move it — the list is the claim, not "the whole environment"', () => {
    const bare = withEnv('ASMLIFT_CANDCACHE_NS_UNRELATED', undefined, () => candCacheStaticStamp(CANONICAL, []));
    const set = withEnv('ASMLIFT_CANDCACHE_NS_UNRELATED', 'x', () => candCacheStaticStamp(CANONICAL, []));
    expect(set).toBe(bare);
  });
});

describe("a script's PROSE is not its program", () => {
  // The class, MEASURED on the one script that inhabits the delegate refusal on this machine
  // (`scripts/pool_abs_syms.sh` in the author's klonoa checkout, byte-identical in five copies):
  // TEN of its lines trip `SCRIPT_COMPUTES_ITS_DELEGATE`, EIGHT are English sentences quoting
  // `.set`, `.4byte` and `make` in backticks — and the other TWO ARE CODE, so reading prose as
  // prose removes 8 of 10 refusal SITES and that script still refuses until the checkout that owns
  // it is edited. What this file is entitled to claim is the reading, not that checkout's number.
  // `compile-command.ts` had already decided this question for the compile TEMPLATE and for the
  // same reasons; the scripts the template NAMES were still read as prose-and-program at once.
  //
  // The refusal boundary itself is pinned in `packages/cli/test/offline/candcache-refusals.test.ts`
  // — inside `pnpm test:offline`, which this file is not. What stays here needs a real interpreter
  // resolved off `$PATH`, or the benchmark's own stamp.
  const wrapper = (body: string): string => {
    const p = join(scratch(), 'wrapper');
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    return p;
  };

  test('editing that comment STILL re-namespaces — the text is dropped from the scan, not the hash', () => {
    const p = wrapper('#!/bin/sh\n# one\nexec /usr/bin/true "$@"\n');
    const before = candCacheStaticStamp(CANONICAL, toolchainFileChain(p));
    writeFileSync(p, '#!/bin/sh\n# two\nexec /usr/bin/true "$@"\n');
    expect(candCacheStaticStamp(CANONICAL, toolchainFileChain(p)), 'the script is hashed by its whole bytes').not.toBe(
      before,
    );
  });

  test('the SHEBANG survives — it is the one `#` line that names a program', () => {
    const p = wrapper('#!/bin/sh\n# a comment\nexec /usr/bin/true "$@"\n');
    expect(toolchainFileChain(p), 'the interpreter is a delegate').toContain(realpathSync('/bin/sh'));
  });

  test('…and a script under `#!/usr/bin/env sh` is refused: `env` runs whatever interpreter it finds', () => {
    const p = wrapper('#!/usr/bin/env sh\n# a comment\nexec /usr/bin/true "$@"\n');
    expect(() => toolchainFileChain(p)).toThrow(/runs under \/usr\/bin\/env sh, not a flagless \/bin\/sh/);
  });
});

describe('compiler flags — one namespace per flag set', () => {
  test('the digest moves with the flags, and only with the flags', () => {
    const input = join(scratch(), 'shaping.ts');
    writeFileSync(input, 'export const tail = 2;\n');
    const o1 = ['-mthumb-interwork', '-O1', '-fhex-asm'];
    expect(candCacheStaticStamp(CANONICAL, [input])).toBe(candCacheStaticStamp([...CANONICAL], [input]));
    expect(candCacheStaticStamp(o1, [input])).not.toBe(candCacheStaticStamp(CANONICAL, [input]));
  });

  // A LIVE compile, cache on: the same TU and symbol at two flag sets must come back as two objects,
  // each the compiler's own answer at its flags, and a second canonical compile must be served the
  // canonical object rather than whichever set ran last.
  test.skipIf(!HAVE_AGBCC)('two flag sets for the same TU and symbol never share a cached object', async () => {
    const store = scratch();
    const saved = { mode: process.env.ASMLIFT_CANDCACHE, dir: process.env.ASMLIFT_CANDCACHE_DIR };
    process.env.ASMLIFT_CANDCACHE = '1';
    process.env.ASMLIFT_CANDCACHE_DIR = store;
    vi.resetModules();
    try {
      const { agbccReal } = await import('../src/compile/agbcc');
      const tu = 'int sum(int *p, int n){ int s = 0, i; for (i = 0; i < n; i++) s += p[i]; return s; }\n';
      const o1 = ['-mthumb-interwork', '-O1', '-fhex-asm'];
      const at = (cflags: readonly string[]) => readFileSync(agbccReal.compileCandidate(tu, 'sum', cflags, 'c'));
      const canonical = at(CANONICAL);
      const atO1 = at(o1);
      expect(atO1.equals(canonical), 'the TU must compile differently at -O1, or this test proves nothing').toBe(false);
      expect(at(CANONICAL).equals(canonical)).toBe(true);
      expect(at(o1).equals(atO1)).toBe(true);
      expect(
        execSync(`find ${store}/ns -mindepth 1 -maxdepth 1 -type d`, { encoding: 'utf8' }).trim().split('\n'),
      ).toHaveLength(2);
    } finally {
      process.env.ASMLIFT_CANDCACHE = saved.mode;
      process.env.ASMLIFT_CANDCACHE_DIR = saved.dir;
      vi.resetModules();
    }
  });
});

// agbcc `-g` writes its input's name and working directory into the listing. The harness compiles on
// stdin in `/`, so the determinism probe's two directories still build one object and the namespace
// resolves; compiled from a scratch file the probe disagrees and the cache refuses the whole flag set.
describe('debug-info flags — a `-g` unit keeps its cache and its listing', () => {
  const G = [...CANONICAL, '-g'];
  const tu = 'int twice(int x){ return x + x; }\n';

  test.skipIf(!HAVE_AGBCC)('a `-g` flag set resolves a namespace and is served its own object', async () => {
    const store = scratch();
    const saved = { mode: process.env.ASMLIFT_CANDCACHE, dir: process.env.ASMLIFT_CANDCACHE_DIR };
    process.env.ASMLIFT_CANDCACHE = '1';
    process.env.ASMLIFT_CANDCACHE_DIR = store;
    vi.resetModules();
    try {
      const { agbccReal } = await import('../src/compile/agbcc');
      const first = readFileSync(agbccReal.compileCandidate(tu, 'twice', G, 'c'));
      expect(readFileSync(agbccReal.compileCandidate(tu, 'twice', G, 'c')).equals(first)).toBe(true);
      expect(
        execSync(`find ${store}/ns -mindepth 1 -maxdepth 1 -type d`, { encoding: 'utf8' }).trim().split('\n'),
      ).toHaveLength(1);
    } finally {
      process.env.ASMLIFT_CANDCACHE = saved.mode;
      process.env.ASMLIFT_CANDCACHE_DIR = saved.dir;
      vi.resetModules();
    }
  });

  // A rejection is published as the row's `errorMarkers`, so its text must not depend on how the harness
  // hands cpp the TU.
  test.skipIf(!HAVE_AGBCC)("a candidate's diagnostics name its translation unit c.c", async () => {
    const store = scratch();
    const saved = { mode: process.env.ASMLIFT_CANDCACHE, dir: process.env.ASMLIFT_CANDCACHE_DIR };
    process.env.ASMLIFT_CANDCACHE = '1';
    process.env.ASMLIFT_CANDCACHE_DIR = store;
    vi.resetModules();
    try {
      const { agbccReal } = await import('../src/compile/agbcc');
      expect(() => agbccReal.compileCandidate('int f(void)\n{ return x; }\n', 'f', G, 'c')).toThrow(
        /^agbcc failed: c\.c:2: `x' undeclared/,
      );
    } finally {
      process.env.ASMLIFT_CANDCACHE = saved.mode;
      process.env.ASMLIFT_CANDCACHE_DIR = saved.dir;
      vi.resetModules();
    }
  });

  test.skipIf(!HAVE_AGBCC)(
    'the `-g` target listing both decompilers read has no debug section, and names no path',
    async () => {
      const { agbccReal } = await import('../src/compile/agbcc');
      const debug = agbccReal.buildTarget(`int thrice(int x){ return x + x + x; }\n`, 'thrice', G, 'c');
      const plain = agbccReal.buildTarget(`int thrice(int x){ return x + x + x; }\n`, 'thrice', CANONICAL, 'c');
      expect(debug.asm).not.toMatch(/\.section\s+\.debug/);
      expect(readFileSync(debug.obj).includes('.debug_info')).toBe(true);
      expect(readFileSync(debug.obj).toString('latin1')).not.toMatch(/\/tmp\/|\/private\/|\/var\/folders\//);
      expect(plain.asm).not.toMatch(/\.debug/);
    },
  );
});
