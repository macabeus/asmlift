// What a candidate TU reads besides its own bytes (src/candcache-reads.ts), read off its text: the
// half a preprocessor's dependency list cannot show, and the whole answer where there is no list.
// The real compiles that pin the list half are apps/benchmark/test/candcache-reads.test.ts.
import { describe, expect, test } from 'vitest';

import { type PreprocessorReport, candidateCacheRefusal, candidateReadsRefusal } from '../../src/candcache-reads';

const H = '/tmp/h/k.h';
const unreported = (tu: string): string | undefined => candidateReadsRefusal(tu, { gnuAs: true });
const reported = (tu: string, report: PreprocessorReport): string | undefined =>
  candidateReadsRefusal(tu, { report, gnuAs: true });
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

  test('refuses a directive name written in prose, which costs that key only', () => {
    expect(unreported('/* a comment mentioning\n#include "k.h"\nspanning lines */\nint f(void);\n')).toBe(
      'the-TU-may-read-a-file',
    );
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
  ])('refuses a string that names a file directive, as a section name copies it out: %s', (_name, text) => {
    expect(reported(text, NOTHING_READ(text))).toBe('the-TU-hands-its-assembler-text');
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
    expect(candidateReadsRefusal(text, { gnuAs: false })).toBeUndefined();
  });

  test('reads text with no report whole: a directive in a comment refuses too', () => {
    expect(unreported('// built from x.incbin\nint f(void);\n')).toBe('the-TU-hands-its-assembler-text');
  });
});
