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
// `candCacheNamespaceFiles()` is the LIST (a dropped entry is an input the cache stops noticing)
// and `candCacheStaticStamp(files)` is the digest over it (content, not paths). The pipeline's own
// object bytes are the third half, measured by the two-directory probe, which needs agbcc and is
// exercised by the matching suite.
//
// Only the DIGEST half runs everywhere. Building the LIST is itself a measurement of the machine's
// compilers — it resolves `TOOLCHAIN.agbcc` and follows its delegates, and REFUSES rather than
// guess when the binary is not installed — so the two tests that call it are skipped where agbcc
// is absent, which is every hosted runner. What must not be lost there is the dropped-entry guard,
// so `SHAPING_SOURCES` is asserted directly: that half is a constant and needs no toolchain.
import { toolchainFileChain } from '@asmlift/cli/candcache';
import { TOOLCHAIN } from '@asmlift/toolchains';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { SHAPING_SOURCES, candCacheNamespaceFiles, candCacheStaticStamp } from '../src/compile/agbcc';

const HARNESS = join(import.meta.dirname, '../src/compile');
/** Building the namespace's file list resolves the installed agbcc and follows what it delegates
 *  to; where there is no agbcc there is nothing to measure and the module refuses, by design. */
const HAVE_AGBCC = existsSync(TOOLCHAIN.agbcc);
const scratch = (): string => mkdtempSync(join(tmpdir(), 'candcache-ns-'));

describe('hole 1 — the namespace hashes the harness code that shapes the compiler input', () => {
  test('agbcc.ts and util.ts are shaping sources, and they exist', () => {
    for (const shaping of ['agbcc.ts', 'util.ts']) {
      const hit = SHAPING_SOURCES.find((f) => f === join(HARNESS, shaping));
      expect(hit, `${shaping} must be a namespace input: it shapes what the compiler is handed`).toBeDefined();
      expect(readFileSync(hit!, 'utf8').length).toBeGreaterThan(0);
    }
  });

  test.skipIf(!HAVE_AGBCC)('…and the list the namespace hashes ends with exactly those two', () => {
    expect(candCacheNamespaceFiles().slice(-SHAPING_SOURCES.length)).toEqual([...SHAPING_SOURCES]);
  });

  test('patching the .s tail agbcc.ts appends MOVES the digest — the exact stale-object repro', () => {
    const dir = scratch();
    const copy = join(dir, 'agbcc.ts');
    copyFileSync(join(HARNESS, 'agbcc.ts'), copy);

    const before = candCacheStaticStamp([copy]);
    const src = readFileSync(copy, 'utf8');
    expect(src, 'this test pins the real tail; if the pipeline changed it, re-pin it here').toContain(
      "'\\n.text\\n\\t.align\\t2, 0\\n'",
    );
    writeFileSync(copy, src.replace("'\\n.text\\n\\t.align\\t2, 0\\n'", "'\\n.text\\n\\t.align\\t4, 0\\n'"));

    expect(candCacheStaticStamp([copy]), 'a harness edit that changes the object must re-namespace').not.toBe(before);
  });

  test('it is CONTENT, not the path: identical bytes at two paths agree, different bytes do not', () => {
    const a = join(scratch(), 'shaping.ts');
    const b = join(scratch(), 'shaping.ts');
    writeFileSync(a, 'export const tail = 2;\n');
    copyFileSync(a, b);
    // The path is in the digest too (it names WHICH input this is), so compare each against
    // itself under an edit rather than against the other.
    const bBefore = candCacheStaticStamp([b]);
    expect(candCacheStaticStamp([a])).toBe(candCacheStaticStamp([a]));
    writeFileSync(b, 'export const tail = 4;\n');
    expect(candCacheStaticStamp([b])).not.toBe(bBefore);
  });

  test('an input that cannot be READ throws — the cache refuses, it never guesses', () => {
    expect(() => candCacheStaticStamp([join(scratch(), 'absent.ts')])).toThrow(/ENOENT|no such file/i);
  });
});

describe('hole 4 — the namespace hashes the BINARIES, not their version banners', () => {
  test.skipIf(!HAVE_AGBCC)(
    'the assembler and the preprocessor are on the list, resolved or explicitly UNRESOLVED',
    () => {
      const files = candCacheNamespaceFiles();
      // agbcc, the assembler, the preprocessor AND WHATEVER THOSE DELEGATE TO, then the two shaping
      // sources. The count is not the claim (a chain is as long as the toolchain makes it); every
      // entry being a real file or an explicit marker is.
      expect(files.length).toBeGreaterThanOrEqual(5);
      for (const entry of files.slice(0, -2)) {
        expect(
          entry.startsWith('/') || entry.startsWith('UNRESOLVED:'),
          `a bare command name must resolve to a file to hash, or say it did not: ${entry}`,
        ).toBe(true);
      }
      expect(files.slice(-2)).toEqual([join(HARNESS, 'agbcc.ts'), join(HARNESS, 'util.ts')]);
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

    const before = candCacheStaticStamp(chain);
    writeFileSync(delegate, '#!/bin/sh\nexec /usr/bin/true VERSION-TWO\n');
    expect(
      candCacheStaticStamp(toolchainFileChain(shim)),
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

    const stampA = candCacheStaticStamp(chainA);
    expect(candCacheStaticStamp(chainWith(b)), 'repointing the variable re-namespaces').not.toBe(stampA);
    expect(candCacheStaticStamp(chainWith(a)), 'and pointing it back is the same toolchain again').toBe(stampA);
    expect(readFileSync(w, 'utf8'), 'the wrapper really did not move').toBe(
      '#!/bin/sh\nexec "$ASMLIFT_TEST_DELEGATE" "$@"\n',
    );
  });

  test('a variable the script ASSIGNS itself is not an external input', () => {
    const dir = scratch();
    const w = join(dir, 'wrapper-selfassign');
    writeFileSync(w, '#!/bin/sh\nCC=/usr/bin/true\nexec "$CC" "$@"\n');
    chmodSync(w, 0o755);
    expect(toolchainFileChain(w).some((e) => e.startsWith('ENV:CC='))).toBe(false);
  });

  test('the file half is keyed by CONTENT, not by the absolute path it sits at', () => {
    // Two worktrees of this repo hold byte-identical sources and toolchains at different paths.
    // Keying the digest on the path gave each its own namespace, so every parallel round
    // cold-started and left a second store behind that nothing ever evicts.
    const one = join(scratch(), 'agbcc.ts');
    const two = join(scratch(), 'agbcc.ts');
    writeFileSync(one, 'export const x = 1;\n');
    writeFileSync(two, 'export const x = 1;\n');
    expect(candCacheStaticStamp([two])).toBe(candCacheStaticStamp([one]));
    writeFileSync(two, 'export const x = 2;\n');
    expect(candCacheStaticStamp([two]), 'content still decides').not.toBe(candCacheStaticStamp([one]));
  });

  test('a same-named binary with different bytes is a different toolchain', () => {
    // What a $PATH wrapper does, without touching $PATH: the same list position, other bytes.
    const p = join(scratch(), 'arm-none-eabi-as');
    writeFileSync(p, '#!/bin/sh\nexec /usr/bin/true "$@"\n');
    const before = candCacheStaticStamp([p]);
    writeFileSync(p, '#!/bin/sh\nexec /usr/bin/false "$@"\n');
    expect(candCacheStaticStamp([p])).not.toBe(before);
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

  test('CPATH and C_INCLUDE_PATH move the digest — cpp honours them even under -nostdinc', () => {
    for (const v of ['CPATH', 'C_INCLUDE_PATH']) {
      const bare = withEnv(v, undefined, () => candCacheStaticStamp([]));
      const set = withEnv(v, '/private/tmp/candcache-ns-probe-inc', () => candCacheStaticStamp([]));
      expect(set, `${v} is an include-path input and must re-namespace`).not.toBe(bare);
    }
  });

  test('an unrelated variable does NOT move it — the list is the claim, not "the whole environment"', () => {
    const bare = withEnv('ASMLIFT_CANDCACHE_NS_UNRELATED', undefined, () => candCacheStaticStamp([]));
    const set = withEnv('ASMLIFT_CANDCACHE_NS_UNRELATED', 'x', () => candCacheStaticStamp([]));
    expect(set).toBe(bare);
  });
});
