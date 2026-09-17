// A GameCube project's include tree, read by the front end it was written for.
//
// The real tier vendors each row's PREPROCESSED translation unit. For the GBA and N64 projects a
// host `cpp` produces it; for a CodeWarrior project it cannot, because the headers branch on the
// macros only mwcceppc declares. `ppcPreprocess` is that step, and the two things it must get right
// are the DIALECT (the compiler's own front end, not the host's) and the WRAPPER (the words the
// unit's own build rule runs the compiler under — `sjiswrap.exe` on a dtk project).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  asciiLiterals,
  markPragmas,
  ppcCompile,
  ppcDockerAvailable,
  ppcPreprocess,
  restorePragmas,
} from '../src/compile';

/** A throwaway "checkout": an `include/` the unit's `-i` resolves against, under /tmp so the
 *  container reaches it the same way a real checkout mounted read-only is reached. */
function fakeProject(): { root: string; scratch: string } {
  const root = mkdtempSync('/tmp/asmlift-ppcpp-proj-');
  mkdirSync(join(root, 'include'));
  writeFileSync(
    join(root, 'include', 'dialect.h'),
    [
      '#ifdef __MWERKS__',
      'typedef int CODEWARRIOR_SAW_THIS;',
      '#else',
      'typedef int SOME_OTHER_FRONT_END;',
      '#endif',
    ].join('\n') + '\n',
  );
  return { root, scratch: mkdtempSync('/tmp/asmlift-ppcpp-scratch-') };
}

describe('a preprocessed unit as vendorable text', () => {
  const bytes = (...parts: (string | number[])[]): Buffer =>
    Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))));

  test('leaves an ASCII unit exactly as it is', () => {
    const unit = 'char *s = "a\\"b"; char c = \'"\';\n';
    expect(asciiLiterals(Buffer.from(unit))).toBe(unit);
  });

  test("escapes a narrow literal's non-ASCII bytes one byte at a time", () => {
    // a byte-wise reader: the 0x5c after a lead byte is its own escape, not the lead byte's trail
    expect(asciiLiterals(bytes('s = "', [0x83, 0x5c, 0x5c, 0xb1], '";'))).toBe('s = "\\203\\\\\\261";');
  });

  test('refuses a non-ASCII byte no escape can spell', () => {
    expect(() => asciiLiterals(bytes('int ', [0x83, 0x4a], ';'))).toThrow(/outside any literal at \+0x4/);
    expect(() => asciiLiterals(bytes("c = '", [0xb1], "';"))).toThrow(/in a character constant at \+0x5/);
    expect(() => asciiLiterals(bytes('w = L"', [0x83, 0x4a], '";'))).toThrow(/in a wide string at \+0x6/);
    expect(() => asciiLiterals(bytes('s = "\\', [0x83], '";'))).toThrow(/backslash before a non-ASCII byte at \+0x5/);
  });
});

describe('mwcceppc preprocessing of a project include tree', () => {
  test('marks every #pragma directive, continued ones whole, and restores each where its marker stands', () => {
    const pragmas: string[] = [];
    const marked = markPragmas(
      ['#pragma section RX "forcestrip"', 'int a;', '  # pragma cplusplus \\', 'on', '#define P "#pragma no"'].join(
        '\n',
      ),
      pragmas,
    );
    expect(pragmas).toEqual(['#pragma section RX "forcestrip"', '  # pragma cplusplus \\\non']);
    expect(marked.split('\n')).toEqual([
      '#pragma section RX "forcestrip"',
      '__asmlift_pragma_0__',
      'int a;',
      '  # pragma cplusplus \\',
      'on',
      '__asmlift_pragma_1__',
      '#define P "#pragma no"',
    ]);
    // what the preprocessor hands back: the directives gone, the markers left where they were live
    expect(restorePragmas('\n__asmlift_pragma_1__\nint a;\n', pragmas)).toBe('\n  # pragma cplusplus \\\non\nint a;\n');
  });

  test('refuses a marker the preprocessor joined into a line of code', () => {
    expect(() => restorePragmas('int a; __asmlift_pragma_0__\n', ['#pragma once'])).toThrow(
      /moved the #pragma marker __asmlift_pragma_0__/,
    );
  });

  test('refuses a source or destination the container cannot see', () => {
    // The container reaches host files through ONE mount, /tmp. A path outside it would be
    // "not found" from inside, and mwcc's usage error names a path the caller never chose — so the
    // refusal is stated here, where the reason is known.
    expect(() =>
      ppcPreprocess({ mwcc: 'mwcc_242_81', root: '/nowhere', srcPath: '/etc/u.c', outPath: '/tmp/u.i', argv: [] }),
    ).toThrow(/reads and writes under \/tmp/);
    expect(() =>
      ppcPreprocess({ mwcc: 'mwcc_242_81', root: '/nowhere', srcPath: '/tmp/u.c', outPath: '/etc/u.i', argv: [] }),
    ).toThrow(/reads and writes under \/tmp/);
  });

  // A ONE-SHOT CONTAINER COSTS SECONDS, not milliseconds: ~1.2 s of `docker run` launch on an idle
  // machine and several times that on a loaded one, and preprocessing a header tree is real work on
  // top. Vitest's 5 s default fails these for the machine's mood rather than for the code, so each
  // states its own budget.
  const CONTAINER_BUDGET = 120_000;

  describe.runIf(ppcDockerAvailable('mwcc_242_81'))('with the CodeWarrior container', () => {
    test(
      "expands the project's headers in CodeWarrior's dialect, with #line comments stripped",
      () => {
        const { root, scratch } = fakeProject();
        const srcPath = join(scratch, 'u.c');
        writeFileSync(srcPath, '#include "dialect.h"\n');
        const text = ppcPreprocess({
          mwcc: 'mwcc_242_81',
          root,
          srcPath,
          outPath: join(scratch, 'u.i'),
          argv: ['-nosyspath', '-i', 'include'],
        });
        // __MWERKS__ is declared by this front end and by no host cpp: the branch it took IS the
        // dialect claim.
        expect(text).toContain('CODEWARRIOR_SAW_THIS');
        expect(text).not.toContain('SOME_OTHER_FRONT_END');
        // -EP, not -E: a vendored blob carries no `#line` bookkeeping.
        expect(text).not.toContain('#line');
      },
      CONTAINER_BUDGET,
    );

    test(
      'keeps every live #pragma of the unit and of the project headers it reads, and no dead one',
      () => {
        // mwcceppc executes a #pragma while preprocessing and writes none of them out, in every
        // mode it has. Animal Crossing's `types.h` declares a section this way that its headers'
        // declarations then name, and `libc/math.h` switches C++ linkage on around `floor` — so a
        // blob without them either does not compile or silently links other symbols.
        const { root, scratch } = fakeProject();
        writeFileSync(
          join(root, 'include', 'pragmas.h'),
          [
            '#pragma section RX "forcestrip"',
            'extern __declspec(section "forcestrip") void g(void);',
            '#if 0',
            '#pragma dead_branch',
            '#endif',
          ].join('\n') + '\n',
        );
        const srcPath = join(scratch, 'u.c');
        writeFileSync(srcPath, '#include "pragmas.h"\n#pragma cplusplus on\ndouble floor(double);\n');
        const text = ppcPreprocess({
          mwcc: 'mwcc_242_81',
          root,
          srcPath,
          outPath: join(scratch, 'u.i'),
          argv: ['-nosyspath', '-i', 'include'],
        });
        const lines = text.split(/\r?\n/);
        expect(lines.indexOf('#pragma section RX "forcestrip"')).toBeGreaterThanOrEqual(0);
        expect(lines.indexOf('#pragma section RX "forcestrip"')).toBeLessThan(
          lines.findIndex((l) => l.includes('__declspec(section "forcestrip")')),
        );
        expect(lines).toContain('#pragma cplusplus on');
        expect(text).not.toContain('dead_branch');
        expect(text).not.toContain('__asmlift_pragma_');
      },
      CONTAINER_BUDGET,
    );

    test(
      'vendors a Shift-JIS literal as escapes that compile to the object its raw bytes do',
      () => {
        // What `sjiswrap` hands the compiler for `"カーソル"`: カ ー ソ ル in Shift-JIS, with the trail
        // byte of ソ (0x5c, a backslash) doubled so a byte-wise reader keeps it.
        const literal = [0x83, 0x4a, 0x81, 0x5b, 0x83, 0x5c, 0x5c, 0x83, 0x8b];
        const raw = Buffer.concat([
          Buffer.from('const char label[] = "'),
          Buffer.from(literal),
          Buffer.from('";\nint len(void) { return sizeof(label); }\n'),
        ]);
        const { root, scratch } = fakeProject();
        writeFileSync(join(scratch, 'raw.c'), raw);
        const text = ppcPreprocess({
          mwcc: 'mwcc_242_81',
          root,
          srcPath: join(scratch, 'raw.c'),
          outPath: join(scratch, 'raw.i'),
          argv: ['-nosyspath'],
        });
        expect(text).toContain('"\\203J\\201[\\203\\\\\\203\\213"');
        // one file name for both compiles, since the object records it
        const [fromRaw, fromText] = [mkdtempSync('/tmp/asmlift-ppcpp-raw-'), mkdtempSync('/tmp/asmlift-ppcpp-text-')];
        writeFileSync(join(fromRaw, 'u.c'), raw);
        writeFileSync(join(fromText, 'u.c'), text);
        const flags = ['-O4,p', '-lang=c'];
        ppcCompile('mwcc_242_81', fromRaw, 'u.c', 'u.o', flags);
        ppcCompile('mwcc_242_81', fromText, 'u.c', 'u.o', flags);
        const object = readFileSync(join(fromText, 'u.o'));
        expect(object.equals(readFileSync(join(fromRaw, 'u.o')))).toBe(true);
        // …and the bytes that object holds are the game's: the doubled backslash reads back as one
        expect(object.includes(Buffer.from([0x83, 0x4a, 0x81, 0x5b, 0x83, 0x5c, 0x83, 0x8b, 0x00]))).toBe(true);
      },
      CONTAINER_BUDGET,
    );

    test(
      'runs the compiler under the wrapper words the unit names',
      () => {
        const { root, scratch } = fakeProject();
        const srcPath = join(scratch, 'u.c');
        writeFileSync(srcPath, 'typedef int plain;\n');
        // A wrapper that is not there is the only wrapper this test can build — a real one is a
        // Win32 PE the project downloads. What it pins is that the words REACH the command line
        // resolved against the checkout: without them the same call preprocesses fine.
        expect(() =>
          ppcPreprocess({
            mwcc: 'mwcc_242_81',
            root,
            srcPath,
            outPath: join(scratch, 'wrapped.i'),
            argv: ['-nosyspath', '-i', 'include'],
            wrapper: ['build/tools/no-such-wrapper.exe'],
          }),
        ).toThrow(/no-such-wrapper\.exe/);
        expect(
          ppcPreprocess({
            mwcc: 'mwcc_242_81',
            root,
            srcPath,
            outPath: join(scratch, 'plain.i'),
            argv: ['-nosyspath', '-i', 'include'],
          }),
        ).toContain('plain');
      },
      CONTAINER_BUDGET,
    );
  });
});
