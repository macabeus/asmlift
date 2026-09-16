// A GameCube project's include tree, read by the front end it was written for.
//
// The real tier vendors each row's PREPROCESSED translation unit. For the GBA and N64 projects a
// host `cpp` produces it; for a CodeWarrior project it cannot, because the headers branch on the
// macros only mwcceppc declares. `ppcPreprocess` is that step, and the two things it must get right
// are the DIALECT (the compiler's own front end, not the host's) and the WRAPPER (the words the
// unit's own build rule runs the compiler under — `sjiswrap.exe` on a dtk project).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { markPragmas, ppcDockerAvailable, ppcPreprocess, restorePragmas } from '../src/compile';

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
      'refuses a unit whose expansion is not ASCII, rather than vendoring mojibake',
      () => {
        // The result is carried as a JS STRING — vendored, gzipped, and compiled back from it — and
        // a dtk wrapper's whole job is to hand the compiler bytes that are NOT UTF-8 (`sjiswrap`
        // rewrites every multibyte literal into Shift-JIS, which no string decoding round-trips).
        // Returning one would compile to the wrong constants silently, so this is the loud form of
        // the dataset's "benchmark a function whose unit is ASCII" decision.
        const { root, scratch } = fakeProject();
        const srcPath = join(scratch, 'wide.c');
        writeFileSync(srcPath, 'const char *greeting = "こんにちは";\n');
        expect(() =>
          ppcPreprocess({
            mwcc: 'mwcc_242_81',
            root,
            srcPath,
            outPath: join(scratch, 'wide.i'),
            argv: ['-nosyspath', '-i', 'include'],
          }),
        ).toThrow(/non-ASCII byte at \+0x[0-9a-f]+/);
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
