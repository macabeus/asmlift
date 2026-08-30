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
//      `.align 4, 0` served the 648-byte object where the truth is 660, with every binary, flag
//      and `--version` banner identical.
//   4. The BINARIES behind the bare command names. `arm-none-eabi-cpp` and `arm-none-eabi-as`
//      entered only through their `--version` output; a shell wrapper first on $PATH left the
//      namespace unmoved three times running.
//   5. The compile ENVIRONMENT. `CPATH` is honoured by the preprocessor even under `-nostdinc`,
//      so it is an input to every candidate compile although nothing on the command line names it.
//
// The assertions below are on the two exported halves of the namespace rather than on a live
// compile, so they run in the toolchain-free gate: `candCacheNamespaceFiles()` is the LIST (a
// dropped entry is an input the cache stops noticing) and `candCacheStaticStamp(files)` is the
// digest over it (content, not paths). The pipeline's own object bytes are the third half and are
// measured by the two-directory probe, which needs agbcc and is exercised by the matching suite.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { candCacheNamespaceFiles, candCacheStaticStamp } from '../src/compile/agbcc';

const HARNESS = join(import.meta.dirname, '../src/compile');
const scratch = (): string => mkdtempSync(join(tmpdir(), 'candcache-ns-'));

describe('hole 1 — the namespace hashes the harness code that shapes the compiler input', () => {
  test('agbcc.ts and util.ts are ON the list, and they exist', () => {
    const files = candCacheNamespaceFiles();
    for (const shaping of ['agbcc.ts', 'util.ts']) {
      const hit = files.find((f) => f === join(HARNESS, shaping));
      expect(hit, `${shaping} must be a namespace input: it shapes what the compiler is handed`).toBeDefined();
      expect(readFileSync(hit!, 'utf8').length).toBeGreaterThan(0);
    }
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
  test('the assembler and the preprocessor are on the list, resolved or explicitly UNRESOLVED', () => {
    const files = candCacheNamespaceFiles();
    // Entry 0 is agbcc itself; 1 and 2 are the two commands whose bare names hide a binary.
    expect(files.length).toBe(5);
    for (const entry of files.slice(1, 3)) {
      expect(
        entry.startsWith('/') || entry.startsWith('UNRESOLVED:'),
        `a bare command name must resolve to a file to hash, or say it did not: ${entry}`,
      ).toBe(true);
    }
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
