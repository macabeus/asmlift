// Which compiled answers the candidate store keeps, through the bench's own pipelines: the real
// tier's agbcc on the host, GCC 2.7.2 and KMC GCC behind the host cpp in their containers,
// CodeWarrior with its own preprocessor; the synthetic tier's pooled KMC GCC, whose own preprocessor
// reports, and its agbcc `decomp.yaml` command, which reports nothing. A TU that reads a file is
// compiled afresh on every run; each case compiles it, edits the file, and compiles it again in a
// new process over the same store, and the edit must reach the object. Every spelling here was
// served the old file's object before the store read the compile's own dependency list, or, where
// there is none, before it refused the TU's text.
import {
  agbccAvailable,
  gcc272Available,
  gcc272Native,
  hostTmp,
  kmcAvailable,
  kmcNative,
  mwccNative,
  ppcDockerAvailable,
} from '@asmlift/toolchains';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

import { scrubScratchDir } from '../src/compile/docker-cache';
import { canonicalCodegen } from '../src/toolchains';

/** A compile in the container costs seconds, and several of them on a loaded machine. */
const BUDGET = 240_000;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});
const scratch = (prefix: string, under = tmpdir()): string => {
  const d = mkdtempSync(join(under, prefix));
  roots.push(d);
  return d;
};

type Pipeline = 'agbcc' | 'gcc272' | 'kmc' | 'mwcc' | 'pooled-kmc' | 'command-agbcc';
type Stats = Record<string, number>;

/** One process's worth of modules over `store` with the audit off (or with the store off): `tu`
 *  through `pipeline`, as the object's bytes (scratch suffix aside) or the rejection's message and
 *  whole diagnostic. */
async function compileIn(
  store: string,
  pipeline: Pipeline,
  tu: string,
  mode: 'on' | 'off' = 'on',
): Promise<{ out: string; stats: Stats }> {
  const env = {
    ASMLIFT_CANDCACHE: mode === 'on' ? 'on' : '0',
    ASMLIFT_CANDCACHE_DIR: store,
    ASMLIFT_CANDCACHE_SAMPLE: '0',
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  vi.resetModules();
  try {
    const compile = async (): Promise<string> => {
      switch (pipeline) {
        case 'agbcc':
          return (await import('../src/compile/agbcc')).agbccReal.compileCandidate(
            tu,
            'f',
            canonicalCodegen('agbcc').cflags,
            'c',
          );
        case 'gcc272':
          return (await import('../src/compile/gcc272')).gcc272Real.compileCandidate(
            tu,
            'f',
            canonicalCodegen('gcc2.7.2').cflags,
            'c',
          );
        case 'kmc':
          return (await import('../src/compile/kmc')).kmcReal.compileCandidate(
            tu,
            'f',
            canonicalCodegen('gcc2.7.2kmc').cflags,
            'c',
          );
        case 'mwcc':
          return (await import('../src/compile/mwcc'))
            .mwccReal('mwcc_242_81')
            .compileCandidate(tu, 'f', canonicalCodegen('mwcc_242_81').cflags, 'c');
        case 'pooled-kmc':
        case 'command-agbcc': {
          const id = pipeline === 'pooled-kmc' ? 'gcc2.7.2kmc' : 'agbcc';
          const compiler = (await import('../src/decomp-config')).benchCompilerFor(id, canonicalCodegen(id).cflags);
          return (await compiler(tu, 'f', 'c')) as string;
        }
      }
    };
    let out: string;
    try {
      out = scrubScratchDir(await compile()).toString('hex');
    } catch (e) {
      // A fresh module graph has a fresh `CompilerRejection` class, so the diagnostic is read by name.
      const { diagnostic } = e as { diagnostic?: string };
      out = `threw ${(e as Error).message}${diagnostic === undefined ? '' : `\n${diagnostic}`}`;
    }
    return { out, stats: (await import('@asmlift/cli/candcache')).cacheStats() };
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
}

const HAVE: Record<Pipeline, boolean> = {
  agbcc: agbccAvailable(),
  gcc272: gcc272Available(),
  kmc: kmcAvailable(),
  mwcc: ppcDockerAvailable('mwcc_242_81'),
  'pooled-kmc': kmcAvailable(),
  'command-agbcc': agbccAvailable(),
};

/** `path` as the compile running in `pipeline`'s container (or natively) sees it. */
const inside = (pipeline: Pipeline, path: string): string => {
  if (pipeline === 'agbcc' || pipeline === 'command-agbcc') {
    return path;
  }
  const native = pipeline === 'gcc272' ? gcc272Native() : pipeline === 'mwcc' ? mwccNative('mwcc_242_81') : kmcNative();
  const p = native ? path : hostTmp(path)!;
  return pipeline === 'mwcc' ? `Z:${p}` : p;
};

/** A TU whose `x` lives in a section named `name` (C source): the compiler writes the name into its
 *  assembly unquoted, so a newline in it starts a directive of its own. */
const inSection = (name: string): string =>
  `int x __attribute__((section(${name}))) = 1;\nint f(int i) { return x + i; }\n`;
/** A section name holding `.include "<path>"`, its directive split across adjacent literals. */
const splitInclude = (path: string, dot = '"."'): string =>
  `".data\\n" ${dot} "inc" "lude \\"${path}\\"\\n.section .data.x"`;

const HEADER = ['#define K 3\n', '#define K 5\n'];
const WORD = ['.word 0x11111111\n', '.word 0x22222222\n'];
const BYTES = ['AB', 'CD'];

/** [what, pipeline, the TU naming the file at a path, the file's two contents (null: removed)] */
const CASES: [string, Pipeline, (p: string) => string, (string | null)[]][] = [
  ['#include', 'gcc272', (p) => `#include "${p}"\nint f(void) { return K; }\n`, HEADER],
  ['the digraph %:include', 'gcc272', (p) => `%:include "${p}"\nint f(void) { return K; }\n`, HEADER],
  [
    '__has_include',
    'gcc272',
    (p) => `#if __has_include("${p}")\nint f(void) { return 3; }\n#else\nint f(void) { return 5; }\n#endif\n`,
    [HEADER[0], null],
  ],
  [
    'a // comment holding /*',
    'gcc272',
    (p) => `// matches data/*.bin\n#include "${p}"\n// */\nint f(int x) { return x * K; }\n`,
    HEADER,
  ],
  [
    'a string holding /*',
    'gcc272',
    (p) => `char *s = "/*";\n#include "${p}"\nchar *t = "*/";\nint f(int x) { return x * K; }\n`,
    HEADER,
  ],
  [
    'a backslash, a form feed, a newline',
    'gcc272',
    (p) => `#inc\\\f\nlude "${p}"\nint f(int x) { return x * K; }\n`,
    HEADER,
  ],
  ['a backslash and a lone CR', 'gcc272', (p) => `#inc\\\rlude "${p}"\nint f(int x) { return x * K; }\n`, HEADER],
  [
    "the assembler's .include",
    'gcc272',
    (p) => `asm(".include \\"${inside('gcc272', p)}\\"");\nint f(int x) { return x; }\n`,
    WORD,
  ],
  [
    "the assembler's .include",
    'kmc',
    (p) => `__asm__(".include \\"${inside('kmc', p)}\\"");\nint f(int x) { return x; }\n`,
    WORD,
  ],
  [
    'a // comment holding /*',
    'mwcc',
    (p) => `// matches data/*.bin\n#include "${inside('mwcc', p)}"\n// */\nint f(int x) { return x * K; }\n`,
    HEADER,
  ],
  ['#embed', 'agbcc', (p) => `int t[] = {\n#embed "${p}"\n};\nint f(int i) { return t[i]; }\n`, BYTES],
  [
    '__has_embed',
    'agbcc',
    (p) => `#if __has_embed("${p}")\nint f(int x) { return x * 3; }\n#else\nint f(int x) { return x * 5; }\n#endif\n`,
    [BYTES[0], null],
  ],
  ["the assembler's .include", 'agbcc', (p) => `asm(".include \\"${p}\\"");\nint f(int x) { return x; }\n`, WORD],
  ["the assembler's .incbin", 'agbcc', (p) => `asm(".incbin \\"${p}\\"");\nint f(int x) { return x; }\n`, BYTES],
  [
    'an .incbin in a section name',
    'agbcc',
    (p) =>
      `int x __attribute__((section(".data\\n.incbin \\"${p}\\"\\n.section .data.x"))) = 1;\nint f(int i) { return x + i; }\n`,
    BYTES,
  ],
  [
    'a missing header, through a // comment holding /*',
    'agbcc',
    (p) => `// see data/*.bin\n#include "${p}"\n// */\nint f(int x) { return x * K; }\n`,
    [null, HEADER[1]],
  ],
  ['#include', 'pooled-kmc', (p) => `#include "${inside('pooled-kmc', p)}"\nint f(void) { return K; }\n`, HEADER],
  [
    "the assembler's .include, split in adjacent literals of a section name",
    'pooled-kmc',
    (p) => inSection(splitInclude(inside('pooled-kmc', p))),
    WORD,
  ],
  [
    "the assembler's .include, its dot from a macro",
    'pooled-kmc',
    (p) => `#define D "."\n${inSection(splitInclude(inside('pooled-kmc', p), 'D'))}`,
    WORD,
  ],
  [
    "the assembler's .include, under a macro only KMC GCC defines",
    'pooled-kmc',
    (p) =>
      `#ifdef __mips__\n#define S ${splitInclude(inside('pooled-kmc', p))}\n#else\n#define S ".data"\n#endif\n${inSection('S')}`,
    WORD,
  ],
  [
    "the assembler's .include, split in adjacent literals of a section name",
    'command-agbcc',
    (p) => inSection(splitInclude(p)),
    WORD,
  ],
];

describe.each(['agbcc', 'gcc272', 'kmc', 'mwcc', 'pooled-kmc', 'command-agbcc'] as const)('%s', (pipeline) => {
  const cases = CASES.filter(([, p]) => p === pipeline);
  test.runIf(HAVE[pipeline]).each(cases.map(([what, , tuFor, contents]) => [what, tuFor, contents] as const))(
    'compiles a TU that reads a file afresh on every run: %s',
    async (_what, tuFor, contents) => {
      const store = scratch('candcache-reads-store-');
      const file = join(scratch('candcache-reads-file-', '/tmp'), 'f.in');
      const put = (c: string | null): void => (c === null ? rmSync(file, { force: true }) : writeFileSync(file, c));
      const tu = tuFor(file);
      put(contents[0]);
      const before = await compileIn(store, pipeline, tu);
      put(contents[1]);
      const after = await compileIn(store, pipeline, tu);
      expect(before.stats.stored, 'the first run kept an object').toBeUndefined();
      expect(before.stats.failStored, 'the first run kept a rejection').toBeUndefined();
      expect(after.stats.hit ?? after.stats.failHit).toBeUndefined();
      expect(after.stats).toMatchObject({ refusedKeys: 1 });
      expect(after.out, 'the edited file reached the compile').not.toBe(before.out);
      expect(after.out).not.toMatch(/^threw /);
    },
    BUDGET,
  );
});

// CodeWarrior preprocesses inside its own compile and a command's preprocessor reports nothing, so
// their TU's text is read instead.
describe.each(['agbcc', 'gcc272', 'kmc', 'pooled-kmc'] as const)('%s', (pipeline) => {
  test.runIf(HAVE[pipeline])(
    'keeps a TU whose prose names a header: the compile says it read none',
    async () => {
      const store = scratch('candcache-reads-store-');
      const tu = '/* built with\n#include "k.h"\nonce */\nint f(int x) { return x * 7; }\n';
      const cold = await compileIn(store, pipeline, tu);
      expect(cold.stats).toMatchObject({ stored: 1 });
      const warm = await compileIn(store, pipeline, tu);
      expect(warm.stats).toMatchObject({ hit: 1 });
      expect(warm.out).toBe(cold.out);
    },
    BUDGET,
  );
});

// A stored rejection carries the compiler's whole diagnostic, which the stillborn rule reads. A GCC
// that quotes the source line an error is on reads that line from the file the line is NAMED after:
// agbcc's cpp reads the TU on stdin under the name `c.c`, so with no `-fno-diagnostics-show-caret`
// it quoted whatever `./c.c` held in the process's working directory, a file no key holds.
describe('agbcc', () => {
  test.runIf(HAVE.agbcc)(
    "serves a cpp rejection as a fresh compile words it, whatever the working directory's c.c holds",
    async () => {
      const store = scratch('candcache-reads-store-');
      const cwd = scratch('candcache-reads-cwd-');
      const tu = 'int f(int x) { return x; }\n#error boom\n';
      const home = process.cwd();
      process.chdir(cwd);
      try {
        const cold = await compileIn(store, 'agbcc', tu);
        expect(cold.stats).toMatchObject({ failStored: 1 });
        writeFileSync(join(cwd, 'c.c'), 'int f(int x) { return x; }\nTHIS LINE IS FROM ./c.c\n');
        const warm = await compileIn(store, 'agbcc', tu);
        expect(warm.stats).toMatchObject({ failHit: 1 });
        const off = await compileIn(store, 'agbcc', tu, 'off');
        expect(off.out).toMatch(/^threw cpp failed: .*#error boom/);
        expect(warm.out).toBe(off.out);
      } finally {
        process.chdir(home);
      }
    },
    BUDGET,
  );

  test.runIf(HAVE.agbcc)(
    'compiles a cpp rejection under a #line naming a file afresh on every run',
    async () => {
      const store = scratch('candcache-reads-store-');
      const file = join(scratch('candcache-reads-file-', '/tmp'), 'x.c');
      const tu = `#line 1 "${file}"\nint f(int x) { return x; }\n#error boom\n`;
      writeFileSync(file, 'line one\nOLD LINE TWO\n');
      const cold = await compileIn(store, 'agbcc', tu);
      expect(cold.stats.failStored, 'the first run kept a rejection').toBeUndefined();
      writeFileSync(file, 'line one\nToo many errors... goodbye\n');
      const warm = await compileIn(store, 'agbcc', tu);
      expect(warm.stats).toMatchObject({ refusedKeys: 1 });
      expect(warm.out).toBe((await compileIn(store, 'agbcc', tu, 'off')).out);
    },
    BUDGET,
  );
});
