// What a candidate TU reads besides its own bytes (src/candcache-reads.ts), read off its text: the
// half a preprocessor's dependency list cannot show, and the whole answer where there is no list.
// The real compiles that pin the list half are apps/benchmark/test/candcache-reads.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import {
  type PreprocessorReport,
  candidateCacheRefusal,
  candidateReadsRefusal,
  cppReport,
} from '../../src/candcache-reads';

const H = '/tmp/h/k.h';
/** A command that hands the TU nothing: no macro, no file of flags, no other charset. */
const PLAIN = '"/opt/gcc/bin/gcc" -O2 -c -o {{outputPath}} {{inputPath}}';
const unreported = (tu: string, command = PLAIN): string | undefined =>
  candidateReadsRefusal(tu, { gnuAs: true, command });
const reported = (tu: string, report: PreprocessorReport): string | undefined =>
  candidateReadsRefusal(tu, { report, gnuAs: true, command: PLAIN });
const NOTHING_READ = (text: string): PreprocessorReport => ({ files: [], text });

describe('a TU with no preprocessor report', () => {
  test.each([
    ['plain', `#include "${H}"\n`],
    ['a backslash-newline inside the word', `#in\\\nclude "${H}"\n`],
    ['a backslash-newline after the #', `#\\\ninclude "${H}"\n`],
    ['a form feed before the #', `\f#include "${H}"\n`],
    ['a comment between the # and the directive', `#/*c*/include "${H}"\n`],
    ['a comment spanning the newline', `#/*\n*/include "${H}"\n`],
    ['#import', `#import "${H}"\n`],
    ['#include_next', `#include_next "${H}"\n`],
    ['#embed', `int t[] = {\n#embed "${H}"\n};\n`],
    ['the trigraph for #', `??=include "${H}"\n`],
    ['the digraph for #', `%:include "${H}"\n`],
    // The breaker's spellings: each one included the header through GCC 2.7.2's real-tier pipeline
    // and was served the old header's object after an edit.
    ['a // comment holding /*', `// matches data/*.bin\n#include "${H}"\n// */\nint f(int x){return x*K;}\n`],
    ['a string holding /*', `char *a = "/*";\n#include "${H}"\nchar *b = "*/";\n`],
    ['a backslash, a form feed, a newline', `#inc\\\f\nlude "${H}"\n`],
    ['a backslash, a vertical tab, a newline', `#inc\\\v\nlude "${H}"\n`],
    ['a backslash and a lone CR', `#inc\\\rlude "${H}"\n`],
    ['a backslash and a CRLF', `#inc\\\r\nlude "${H}"\n`],
    ['the trigraph for a backslash', `#inc??/\nlude "${H}"\n`],
    // arm-none-eabi-cpp reports `universal character \u0069 is not valid in an identifier` and
    // includes the file anyway.
    ['a UCN in the directive name', `#\\u0069nclude "${H}"\n`],
    ['#pragma GCC dependency', `#pragma GCC dependency "${H}"\n`],
  ])('is refused when it may include a file: %s', (_name, tu) => {
    expect(unreported(tu)).toBe('the-TU-may-read-a-file');
  });

  test.each([
    ['an identifier that starts with a directive name', 'int includeBlockedPaths; int importTxe(void);\n'],
    ['an identifier that ends with one', 'int doinclude, reimport, unembed;\n'],
    ['prose without the word', 's32 f(s32 a0) { /* a header, not read */ return a0 + 1; }\n'],
  ])('is kept when it names no file: %s', (_name, tu) => {
    expect(unreported(tu)).toBeUndefined();
  });

  test.each([
    ['#line', `#line 1 "${H}"\n#error boom\n`],
    ['a linemarker', `# 1 "${H}"\n#error boom\n`],
    ['a linemarker with no space', `#12 "${H}"\n`],
    ['a comment before line', `#/* c */line 3 "${H}"\n`],
    ['a backslash-newline after the #', `#\\\nline 3 "${H}"\n`],
    ['the digraph for #', `%:line 3 "${H}"\n`],
    ['the trigraph for #', `??=line 3 "${H}"\n`],
  ])('is refused when it names its lines after a file a diagnostic may quote: %s', (_name, tu) => {
    expect(unreported(tu)).toBe('the-TU-may-read-a-file');
  });

  test('is kept when `line` is only an identifier', () => {
    expect(unreported('int line, lines; int f(int line) { return line; }\n#if 1\n#endif\n')).toBeUndefined();
  });

  test('refuses a directive name written in prose, which costs that key only', () => {
    expect(unreported('/* a comment mentioning\n#include "k.h"\nspanning lines */\nint f(void);\n')).toBe(
      'the-TU-may-read-a-file',
    );
  });
});

describe("a GNU cpp's report", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots.splice(0)) {
      rmSync(r, { recursive: true, force: true });
    }
  });
  /** A directory holding a preprocessor's output `c.i` and, unless null, its dependency list `c.d`. */
  const written = (list: string | null): { d: string; i: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'candcache-report-'));
    roots.push(dir);
    const out = { d: join(dir, 'c.d'), i: join(dir, 'c.i') };
    writeFileSync(out.i, 'int f(int x) { return x; }\n');
    if (list !== null) {
      writeFileSync(out.d, list);
    }
    return out;
  };
  const refusalOf = (report: PreprocessorReport): string | undefined =>
    candidateReadsRefusal('int f(int x) { return x; }\n', { report, gnuAs: true, command: PLAIN });

  test('names no file when the list holds only the TU, given as the compiler named it', () => {
    const { d, i } = written('cand.o: /host-tmp/x/cand.c\n');
    expect(cppReport(d, i, '/host-tmp/x/cand.c', 'cand.o').files).toEqual([]);
    expect(refusalOf(cppReport(d, i, '/host-tmp/x/cand.c', 'cand.o'))).toBeUndefined();
  });

  test('names no file for an empty list, which a cpp reading stdin writes', () => {
    const { d, i } = written('');
    expect(refusalOf(cppReport(d, i))).toBeUndefined();
  });

  test.each([
    ['a missing list', null],
    ['a list for another target', 'c.o: /tmp/h/k.h\n'],
    ['a list naming a header', 'tu: /tmp/h/k.h\n'],
    ['a list naming a file split by a backslash-newline', 'tu: \\\n /tmp/h/k.h\n'],
  ])('keeps %s as a file read', (_name, list) => {
    const { d, i } = written(list);
    expect(refusalOf(cppReport(d, i))).toBe('the-TU-reads-a-file');
  });

  test('keeps a missing output as a file read', () => {
    const { d, i } = written('tu:\n');
    rmSync(i);
    expect(refusalOf(cppReport(d, i))).toBe('the-TU-reads-a-file');
  });

  test('names the TU itself only by the path the compiler was handed', () => {
    const { d, i } = written('cand.o: /host-tmp/x/cand.c /host-tmp/y/cand.c\n');
    expect(cppReport(d, i, '/host-tmp/x/cand.c', 'cand.o').files).toEqual(['/host-tmp/y/cand.c']);
  });
});

describe('a TU whose preprocessor reported what it read', () => {
  test('is kept when the report names no file, whatever its prose says', () => {
    const tu = '/* see #include "k.h" */\nint f(int x){return x;}\n';
    expect(reported(tu, NOTHING_READ('int f(int x){return x;}\n'))).toBeUndefined();
  });

  test('is refused when the report names a file', () => {
    expect(reported(`#include "${H}"\n`, { files: [H], text: '' })).toBe('the-TU-reads-a-file');
  });
});

describe('what no report shows', () => {
  test.each([
    ['__has_include', `#if __has_include("${H}")\n#endif\n`],
    ['__has_include_next', `#if __has_include_next(<k.h>)\n#endif\n`],
    ['__has_embed', `#if __has_embed("${H}")\n#endif\n`],
    ['__has_include split by a splice', `#if __has_inc\\\nlude("${H}")\n#endif\n`],
  ])('refuses a lookup whose miss leaves no entry: %s', (_name, tu) => {
    expect(candidateCacheRefusal(tu)).toBe('the-TU-asks-whether-a-file-exists');
    expect(reported(tu, NOTHING_READ(''))).toBe('the-TU-asks-whether-a-file-exists');
  });

  test.each([
    ['##', `#define C(a, b) a##b\n#if C(__has_, include)("${H}")\n#endif\n`],
    ['%:%:', `#define C(a, b) a%:%:b\n#if C(__has_, include)("${H}")\n#endif\n`],
    ['# and a splice and #', `#define C(a, b) a#\\\n#b\n`],
  ])('refuses token pasting, which builds those names out of pieces: %s', (_name, tu) => {
    expect(candidateCacheRefusal(tu)).toBe('the-TU-pastes-tokens');
  });

  test.each([['__FILE__'], ['__BASE_FILE__'], ['__FILE_NAME__'], ['__DATE__'], ['__TIME__'], ['__TIMESTAMP__']])(
    'refuses a TU that bakes its path or the clock in: %s',
    (macro) => {
      // MEASURED before this existed: three uncached compiles of a `__FILE__` TU produced three
      // different 836-byte objects through the production namespace.
      expect(candidateCacheRefusal(`const char *s = ${macro};\n`)).toBe(
        'the-TU-bakes-its-path-or-the-clock-into-the-object',
      );
    },
  );

  test('refuses a path macro split by a splice the compiler may not take', () => {
    expect(candidateCacheRefusal('const char *s = __FI\\\nLE__\\ \nx;\n')).toBe(
      'the-TU-bakes-its-path-or-the-clock-into-the-object',
    );
  });

  test('keeps an ordinary candidate: the refusal is per key, not a switch', () => {
    expect(candidateCacheRefusal('s32 f(s32 a0) { return a0 + 1; }\n')).toBeUndefined();
  });
});

describe('what a GNU assembler reads', () => {
  test.each([
    ['asm .include', 'asm(".include \\"/tmp/h/a.s\\"");\n'],
    ['__asm__ .incbin', '__asm__(".incbin \\"/tmp/h/e.bin\\"");\n'],
    ['an escaped directive', '__asm__(".\\x69nclude \\"/tmp/h/a.s\\"");\n'],
    ['a joined directive', '__asm__(".inc" "lude \\"/tmp/h/a.s\\"");\n'],
    ['an asm operand', '__asm__(".%c0 \\"/tmp/h/a.s\\"" :: "i"(0));\n'],
    ['a template with no directive at all', '__asm__ volatile("nop");\n'],
  ])('refuses inline asm with a template: %s', (_name, text) => {
    expect(reported(text, NOTHING_READ(text))).toBe('the-TU-hands-its-assembler-text');
  });

  test.each([
    ['an .incbin', 'int x __attribute__((section(".data\\n.incbin \\"/tmp/h/e.bin\\"\\n"))) = 1;\n'],
    ['an escaped .include', 'int x __attribute__((section(".data\\n\\56include \\"/tmp/h/a.s\\"\\n"))) = 1;\n'],
    ['a joined .include', 'int x __attribute__((section(".data\\n.in" "clude \\"/tmp/h/a.s\\"\\n"))) = 1;\n'],
    ['a macro', 'int x __attribute__((section(".data\\n.macro m a\\n.endm\\n"))) = 1;\n'],
    ['an .irpc', 'int x __attribute__((section(".data\\n.irpc c,ab\\n.endr\\n"))) = 1;\n'],
    ['MRI mode', 'int x __attribute__((section(".data\\n.mri 1\\n"))) = 1;\n'],
    // GAS takes a directive in either case.
    ['an upper-case .INCBIN', 'int x __attribute__((section(".data\\n.INCBIN \\"/tmp/h/e.bin\\"\\n"))) = 1;\n'],
    ['a hex-escaped dot', 'int x __attribute__((section(".data\\n\\x2eincbin \\"/tmp/h/e.bin\\"\\n"))) = 1;\n'],
    [
      'a dot in a literal of its own',
      'int x __attribute__((section(".data\\n." "inc" "lude \\"/tmp/h/a.s\\""))) = 1;\n',
    ],
  ])('refuses a string that names a file directive, as a section name copies it out: %s', (_name, text) => {
    expect(reported(text, NOTHING_READ(text))).toBe('the-TU-hands-its-assembler-text');
  });

  // With no preprocessor output, the pieces of a string can sit apart in the text, and what copies
  // one into the assembly can be built with no keyword in the TU at all.
  test.each([
    ['adjacent literals', 'int x __attribute__((section(".data\\n." "inc" "lude \\"/tmp/h/a.s\\""))) = 1;\n'],
    [
      'a macro holding the dot',
      '#define D "."\nint x __attribute__((section(".data\\n" D "inc" "lude \\"/tmp/h/a.s\\""))) = 1;\n',
    ],
    [
      'a stringized section name',
      '#define S(t) #t\n#define N(t) S(t)\nint x __attribute__((section(N(.data)))) = 1;\n',
    ],
    ['a C23 attribute', 'int x [[gnu::section(".data.x")]] = 1;\n'],
    ['a C23 attribute in digraphs', 'int x <:<:gnu::section(".data.x"):>:> = 1;\n'],
    ['_Pragma', '_Pragma("GCC visibility push(default)")\n'],
    ['#ident', '#ident "x"\n'],
    ['#sccs', '#sccs "x"\n'],
    ['the short attribute spelling', 'int x __attribute((section(".data.x"))) = 1;\n'],
    ['__declspec', '__declspec(allocate(".data.x")) int x = 1;\n'],
    ['a C23 opener with a gap', 'int x [ [gnu::section(".data.x")]] = 1;\n'],
    // R310-10: through arm-none-eabi-gcc 15.3, each was served the old file's object.
    [
      'a C23 opener a macro builds',
      '#define LB [\nLB LB gnu::section(".data\\n.in" "cbin \\"f.bin\\"")]] int x = 1;\n',
    ],
    ['a C23 opener in trigraphs', '??(??(gnu::section(".data\\n.in" "cbin \\"f.bin\\"")??)??) int x = 1;\n'],
    ['an attribute the command defines', 'int x SEC(".data\\n.in" "cbin \\"f.bin\\"") = 1;\n'],
    ['string text alone', 'const char *s = "a.out\\n";\n'],
    ['a quote in a character constant', "char c = '\"';\n"],
    ['a stringize', '#define S(t) #t\nint x = sizeof(S(.data));\n'],
    ['a stringize in a digraph', '#define S(t) %:t\nint x = sizeof(S(.data));\n'],
    ['a stringize in a trigraph', '#define S(t) ??=t\nint x = sizeof(S(.data));\n'],
    ['a stringize after a splice', '#define S(t) \\\n  #t\n'],
    ['a trigraph alone', 'int a??(2??);\n'],
  ])('refuses a TU with no report that may make string text: %s', (_name, tu) => {
    expect(unreported(tu)).toBe('the-TU-hands-its-assembler-text');
  });

  test.each([
    ['an attribute and no string text', 'int x __attribute__((aligned(4))) = 1;\n#define T 3\n'],
    ['directives and a C23 attribute', '#define T 3\n  #if T\nint x [[gnu::unused]] = T;\n%:endif\n'],
  ])('keeps a TU with no report: %s', (_name, tu) => {
    expect(unreported(tu)).toBeUndefined();
  });

  test.each([
    ['an empty barrier', 'void f(void) { asm(""); }\n'],
    ['an empty barrier with operands', 'void f(int r3) { asm("" ::"r"(r3)); }\n'],
    ['an empty volatile barrier with clobbers', 'void f(void) { __asm__ __volatile__("" ::: "memory"); }\n'],
    ['a string that names no directive', 'const char *s = "a.out\\n";\nchar c = \'"\';\n'],
  ])('keeps %s', (_name, text) => {
    expect(reported(text, NOTHING_READ(text))).toBeUndefined();
  });

  test('reads a string the preprocessor produced, so a macro cannot hide it', () => {
    const tu = '#define D ".incbin \\"/tmp/h/e.bin\\""\n__asm__(D);\n';
    expect(reported(tu, NOTHING_READ('__asm__(".incbin \\"/tmp/h/e.bin\\"");\n'))).toBe(
      'the-TU-hands-its-assembler-text',
    );
  });

  test('keeps inline asm where no GNU assembler reads it', () => {
    const text = 'asm void f(void) { nofralloc; blr }\n';
    expect(candidateReadsRefusal(text, { gnuAs: false, command: PLAIN })).toBeUndefined();
  });

  test('reads text with no report whole: a directive in a comment refuses too', () => {
    expect(unreported('// built from x.incbin\nint f(void);\n')).toBe('the-TU-hands-its-assembler-text');
  });
});

describe('a command with no preprocessor report', () => {
  const TU = 'int x __attribute__((section(S))) = 1;\n';
  test.each([
    ['-D with a string', `'-DS=".data\\n.incbin \\"f.bin\\""' -O2`],
    ['-D with an attribute', `'-DSEC(s)=__attribute__((section(s)))' -O2`],
    ['-D naming a macro', '-DS=__FILE__ -O2'],
    ['-D as its own word', '-D S=1 -O2'],
    ['--define-macro', '--define-macro S=1'],
    ['-U as its own word', '-U S'],
    ['--undefine-macro', '--undefine-macro S'],
    ["CodeWarrior's -d", '-d S'],
    ["CodeWarrior's -define", '-define S'],
    ['-include', '-include sec.h -O2'],
    ['--include', '--include=sec.h -O2'],
    ['-imacros', '-imacros sec.h'],
    ["CodeWarrior's -prefix", '-prefix sec.h'],
    ['a response file', '@opts -O2'],
    ['-specs', '-specs=x.specs'],
    ['-Wp,-D', "'-Wp,-DS=1'"],
    ['-Xpreprocessor', '-Xpreprocessor -DS=1'],
    ['-traditional-cpp', '-traditional-cpp'],
    ['-finput-charset', '-finput-charset=IBM1047'],
    ['a command substitution', '$(cat flags)'],
    ['a backquote', '`cat flags`'],
  ])('refuses a TU when the command may hand it text: %s', (_name, flags) => {
    expect(unreported(TU, `"/opt/gcc/bin/gcc" ${flags} -c -o {{outputPath}} {{inputPath}}`)).toBe(
      'the-command-hands-the-TU-text',
    );
  });

  test.each([
    ['macros defined as 1, as a number, and undefined', '-DNDEBUG -DVERSION=2 -DMASK=0x1Fu -UFOO'],
    ['the directory of the scratch file', 'cd "$(dirname {{outputPath}})" &&'],
    ['a C standard with trigraphs', '-std=c2x -trigraphs -ansi'],
  ])('keeps a TU when the command words make no text: %s', (_name, flags) => {
    expect(unreported(TU, `${flags} "/opt/gcc/bin/gcc" -O2 -c -o {{outputPath}} {{inputPath}}`)).toBeUndefined();
  });

  test('reads no command when the preprocessor reported what it read', () => {
    expect(
      candidateReadsRefusal(TU, {
        report: NOTHING_READ('int x __attribute__((section(".data.x"))) = 1;\n'),
        gnuAs: true,
        command: '-include sec.h',
      }),
    ).toBeUndefined();
  });
});
