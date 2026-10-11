// Which compiled answers the candidate store keeps, through the bench's own pipelines: the real
// tier's agbcc on the host, GCC 2.7.2 and KMC GCC behind the host cpp in their containers,
// CodeWarrior with its own preprocessor; the synthetic tier's pooled KMC GCC, whose own preprocessor
// reports, and its agbcc `decomp.yaml` command, which reports nothing. A TU that reads a file is
// compiled afresh on every run; each case compiles it, edits the file, and compiles it again in a
// new process over the same store, and the edit must reach the object. Every spelling here was
// served the old file's object before the store read the compile's own dependency list, or, where
// there is none, before it refused the TU's text.
import {
  TOOLCHAIN,
  agbccAvailable,
  gcc272Available,
  gcc272Native,
  hostTmp,
  kmcAvailable,
  kmcNative,
  mwccNative,
  ppcDockerAvailable,
} from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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
 *  through `pipeline`, or through a GNU compile `command` the CLI runs, as the object's bytes
 *  (scratch suffix aside) or the rejection's message and whole diagnostic. */
async function compileIn(
  store: string,
  pipeline: Pipeline | { command: string; cwd: string },
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
      if (typeof pipeline !== 'string') {
        const { compileFromCommand } = await import('@asmlift/cli/compile-command');
        return (await compileFromCommand(pipeline.command, { cwd: pipeline.cwd })(tu, 'f', 'c')) as string;
      }
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

// The synthetic tier's agbcc `decomp.yaml` command is `cpp …; agbcc … && as …`: steps joined by `;`
// and `&&`, output redirected into the scratch directory, every program native or an `exec` shim.
describe('command-agbcc', () => {
  test.runIf(HAVE['command-agbcc'])(
    'keeps a TU the command compiles: the store keys the command',
    async () => {
      const store = scratch('candcache-reads-store-');
      const tu = 'int f(int x) { return x * 7; }\n';
      const cold = await compileIn(store, 'command-agbcc', tu);
      expect(cold.stats).toMatchObject({ stored: 1 });
      expect(cold.stats.refusedKeys).toBeUndefined();
      const warm = await compileIn(store, 'command-agbcc', tu);
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

// A project's command is not keyed at all (@asmlift/cli/candcache-bench): its compiler is unknown
// and reports nothing, and a GNU assembler names a file only in a string that a macro, a trigraph or
// a flag of the command builds with no keyword in the TU. Each spelling below was served the old
// file's object through arm-none-eabi-gcc.
const GCC = isAbsolute(TOOLCHAIN.as) ? join(dirname(TOOLCHAIN.as), 'arm-none-eabi-gcc') : 'arm-none-eabi-gcc';
const HAVE_GCC = spawnSync(GCC, ['-std=c2x', '-trigraphs', '-E', '-x', 'c', '-'], { input: '' }).status === 0;
const command = (flags: string): string => `"${GCC}" ${flags} -O2 -c -o {{outputPath}} {{inputPath}}`;
/** A section name holding `.incbin "<path>"`, its directive split across adjacent literals. */
const splitIncbin = (path: string): string => `".data\\n.in" "cbin \\"${path}\\"\\n.section .data.x"`;

describe('a GNU compile command', () => {
  /** [what, the flags and the TU for an assembly that reads the file at a path] */
  const READS: [string, (p: string) => [string, string]][] = [
    [
      'a C23 opener a macro builds',
      (p) => ['-std=c2x', `#define LB [\nLB LB gnu::section(${splitIncbin(p)})]] int x = 1;\n`],
    ],
    [
      'a C23 opener in trigraphs',
      (p) => ['-std=c2x -trigraphs', `??(??(gnu::section(${splitIncbin(p)})??)??) int x = 1;\n`],
    ],
    [
      'an attribute the command defines',
      (p) => [`'-DSEC(s)=__attribute__((section(s)))'`, `int x SEC(${splitIncbin(p)}) = 1;\n`],
    ],
    ['a string the command defines', (p) => [`'-DS=${splitIncbin(p)}'`, 'int x __attribute__((section(S))) = 1;\n']],
  ];
  test.runIf(HAVE_GCC).each(READS)(
    'compiles a TU whose assembly reads a file afresh on every run: %s',
    async (_what, shape) => {
      const store = scratch('candcache-reads-store-');
      const file = join(scratch('candcache-reads-file-', '/tmp'), 'f.bin');
      const [flags, tu] = shape(file);
      const cmd = { command: command(flags), cwd: scratch('candcache-reads-cwd-') };
      writeFileSync(file, 'AB');
      const cold = await compileIn(store, cmd, tu);
      expect(cold.stats.stored, 'the first run kept an object').toBeUndefined();
      writeFileSync(file, 'CD');
      const warm = await compileIn(store, cmd, tu);
      expect(warm.stats.hit).toBeUndefined();
      expect(warm.stats, 'a project command never reaches the store').toEqual({});
      expect(warm.out, 'the edited file reached the compile').not.toBe(cold.out);
      expect(warm.out).not.toMatch(/^threw /);
      expect(warm.out).toBe((await compileIn(store, cmd, tu, 'off')).out);
    },
    BUDGET,
  );

  test.runIf(HAVE_GCC)(
    'compiles a TU afresh on every run when a variable the command reads defines its section name',
    async () => {
      const store = scratch('candcache-reads-store-');
      const file = join(scratch('candcache-reads-file-', '/tmp'), 'f.bin');
      const cmd = { command: command('$CANDCACHE_READS_FLAGS'), cwd: scratch('candcache-reads-cwd-') };
      const tu = 'int x __attribute__((section(S))) = 1;\n';
      const had = process.env.CANDCACHE_READS_FLAGS;
      // One word, as the shell splits an unquoted expansion: tabs, not spaces, in the string.
      process.env.CANDCACHE_READS_FLAGS = `-DS=".data\\n.incbin\\t\\"${file}\\"\\n.section\\t.data.x"`;
      try {
        writeFileSync(file, 'AB');
        const cold = await compileIn(store, cmd, tu);
        expect(cold.stats.stored, 'the first run kept an object').toBeUndefined();
        writeFileSync(file, 'CD');
        const warm = await compileIn(store, cmd, tu);
        expect(warm.stats, 'a project command never reaches the store').toEqual({});
        expect(warm.out, 'the edited file reached the compile').not.toBe(cold.out);
        expect(warm.out).not.toMatch(/^threw /);
        expect(warm.out).toBe((await compileIn(store, cmd, tu, 'off')).out);
      } finally {
        if (had === undefined) {
          delete process.env.CANDCACHE_READS_FLAGS;
        } else {
          process.env.CANDCACHE_READS_FLAGS = had;
        }
      }
    },
    BUDGET,
  );

  test.runIf(HAVE['command-agbcc'])(
    "keeps a TU with no string text under the benchmark's own command",
    async () => {
      const store = scratch('candcache-reads-store-');
      const tu = '#define T 3\nint x = T;\nint f(int i) { return x + i; }\n';
      const cold = await compileIn(store, 'command-agbcc', tu);
      expect(cold.stats).toMatchObject({ stored: 1 });
      const warm = await compileIn(store, 'command-agbcc', tu);
      expect(warm.stats).toMatchObject({ hit: 1 });
      expect(warm.out).toBe(cold.out);
    },
    BUDGET,
  );
});

/** `env` set over `fn`, and put back. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// A program the command runs can read more than the command's words show, and each spelling below
// was served the old file's object through arm-none-eabi-gcc: a project's command never reaches the
// store.
describe('a command whose program reads what its words do not show', () => {
  const SECTION = `'-DS=".data\\n.incbin \\"f.bin\\"\\n.section .data.x"'`;
  /** [what, the command, the TU, the file it reads and that file's two contents, extra env] */
  const READS: [string, string, string, Record<string, string>, string, [string, string], Record<string, string>][] = [
    [
      'a wrapper script that adds -include',
      './cc.sh -O2 -c -o {{outputPath}} {{inputPath}}',
      'int f(void) { return K; }\n',
      { 'cc.sh': `#!/bin/sh\nexec "${GCC}" -include pre.h "$@"\n` },
      'pre.h',
      ['#define K 1\n', '#define K 2\n'],
      {},
    ],
    [
      'a wrapper script that defines a section name reading a file',
      './cc.sh -O2 -c -o {{outputPath}} {{inputPath}}',
      'int x __attribute__((section(S))) = 1;\n',
      { 'cc.sh': `#!/bin/sh\nexec "${GCC}" ${SECTION} "$@"\n` },
      'f.bin',
      ['11111111', '22222222'],
      {},
    ],
    [
      'flags piped from a file through xargs',
      `cat flags.txt | xargs "${GCC}" -O2 -c -o {{outputPath}} {{inputPath}}`,
      'int f(void) { return K; }\n',
      { 'flags.txt': '-include pre.h\n' },
      'pre.h',
      ['#define K 1\n', '#define K 2\n'],
      {},
    ],
    [
      'a variable named through another',
      `"${GCC}" \${!CANDCACHE_READS_P} -O2 -c -o {{outputPath}} {{inputPath}}`,
      'int f(void) { return K; }\n',
      {},
      'pre.h',
      ['#define K 1\n', '#define K 2\n'],
      { CANDCACHE_READS_P: 'CANDCACHE_READS_EXTRA', CANDCACHE_READS_EXTRA: '-include pre.h' },
    ],
  ];
  test.runIf(HAVE_GCC).each(READS)(
    'compiles afresh on every run: %s',
    async (_what, command, tu, files, read, [before, after], env) => {
      const cwd = scratch('candcache-reads-cwd-');
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(cwd, name), body);
        chmodSync(join(cwd, name), 0o755);
      }
      const store = scratch('candcache-reads-store-');
      const cmd = { command, cwd };
      await withEnv(env, async () => {
        writeFileSync(join(cwd, read), before);
        const cold = await compileIn(store, cmd, tu);
        expect(cold.stats.stored, 'the first run kept an object').toBeUndefined();
        expect(cold.stats, 'a project command never reaches the store').toEqual({});
        writeFileSync(join(cwd, read), after);
        const warm = await compileIn(store, cmd, tu);
        expect(warm.stats.hit).toBeUndefined();
        expect(warm.out, 'the edited file reached the compile').not.toBe(cold.out);
        expect(warm.out).not.toMatch(/^threw /);
        expect(warm.out).toBe((await compileIn(store, cmd, tu, 'off')).out);
      });
    },
    BUDGET,
  );
});

// `GCC_EXEC_PREFIX` moves where a GCC driver finds its `cc1` and its `specs` file, and a `*cpp:`
// line in that specs file reaches the object; its value names neither file. The store keys nothing
// while it is set.
describe('a GCC driver relocated by GCC_EXEC_PREFIX', () => {
  const dumped = (flag: string): string => spawnSync(GCC, [flag], { encoding: 'utf8' }).stdout.trim();
  /** A `GCC_EXEC_PREFIX` tree holding the install's `cc1` and a specs file defining `K`. */
  const tree = (): { prefix: string; setK: (k: number) => void } => {
    const root = scratch('candcache-reads-gep-');
    const [machine, version] = [dumped('-dumpmachine'), dumped('-dumpversion')];
    const lib = join(root, 'lib/gcc', machine, version);
    const libexec = join(root, 'libexec/gcc', machine, version);
    mkdirSync(lib, { recursive: true });
    mkdirSync(libexec, { recursive: true });
    symlinkSync(dumped('-print-prog-name=cc1'), join(libexec, 'cc1'));
    return {
      prefix: `${join(root, 'lib/gcc')}/`,
      setK: (k) => writeFileSync(join(lib, 'specs'), `*cpp:\n-DK=${k}\n\n`),
    };
  };
  const TU = 'int f(void) { return K; }\n';

  test.runIf(HAVE_GCC && HAVE.agbcc)(
    'compiles afresh on every run through agbcc while it is set',
    async () => {
      const t = tree();
      const store = scratch('candcache-reads-store-');
      await withEnv({ GCC_EXEC_PREFIX: t.prefix }, async () => {
        t.setK(7);
        const cold = await compileIn(store, 'agbcc', TU);
        expect(cold.stats).toMatchObject({ refused: 1 });
        expect(cold.stats.stored).toBeUndefined();
        t.setK(8);
        const warm = await compileIn(store, 'agbcc', TU);
        expect(warm.out, 'the edited specs file reached the compile').not.toBe(cold.out);
        expect(warm.out).toBe((await compileIn(store, 'agbcc', TU, 'off')).out);
      });
    },
    BUDGET,
  );

  test.runIf(HAVE_GCC)(
    'names the cc1 a driver finds on PATH when it finds none of its own, or that it found none',
    async () => {
      const { toolchainFileChain } = await import('@asmlift/cli/candcache');
      const empty = scratch('candcache-reads-gep-');
      const bin = scratch('candcache-reads-path-');
      const fake = join(bin, 'cc1');
      writeFileSync(fake, '#!/bin/sh\nexit 1\n');
      chmodSync(fake, 0o755);
      await withEnv({ GCC_EXEC_PREFIX: `${empty}/` }, async () => {
        expect(dumped('-print-prog-name=cc1'), 'the driver answers a bare name').toBe('cc1');
        expect(toolchainFileChain(GCC)).toContain('UNRESOLVED:cc1');
        await withEnv({ PATH: `${bin}:${process.env.PATH}` }, async () => {
          expect(toolchainFileChain(GCC)).toContain(realpathSync(fake));
        });
      });
    },
    BUDGET,
  );
});
