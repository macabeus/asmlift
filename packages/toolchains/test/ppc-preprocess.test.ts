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

import { ppcDockerAvailable, ppcPreprocess } from '../src/compile';

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
  test('refuses a source or destination the container cannot see', () => {
    // The container reaches host files through ONE mount, /tmp. A path outside it would be
    // "not found" from inside, and mwcc's usage error names a path the caller never chose — so the
    // refusal is stated here, where the reason is known.
    expect(() => ppcPreprocess({ root: '/nowhere', srcPath: '/etc/u.c', outPath: '/tmp/u.i', argv: [] })).toThrow(
      /reads and writes under \/tmp/,
    );
    expect(() => ppcPreprocess({ root: '/nowhere', srcPath: '/tmp/u.c', outPath: '/etc/u.i', argv: [] })).toThrow(
      /reads and writes under \/tmp/,
    );
  });

  // A ONE-SHOT CONTAINER COSTS SECONDS, not milliseconds: ~1.2 s of `docker run` launch on an idle
  // machine and several times that on a loaded one, and preprocessing a header tree is real work on
  // top. Vitest's 5 s default fails these for the machine's mood rather than for the code, so each
  // states its own budget.
  const CONTAINER_BUDGET = 120_000;

  describe.runIf(ppcDockerAvailable())('with the CodeWarrior container', () => {
    test(
      "expands the project's headers in CodeWarrior's dialect, with #line comments stripped",
      () => {
        const { root, scratch } = fakeProject();
        const srcPath = join(scratch, 'u.c');
        writeFileSync(srcPath, '#include "dialect.h"\n');
        const text = ppcPreprocess({
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
            root,
            srcPath,
            outPath: join(scratch, 'wrapped.i'),
            argv: ['-nosyspath', '-i', 'include'],
            wrapper: ['build/tools/no-such-wrapper.exe'],
          }),
        ).toThrow(/no-such-wrapper\.exe/);
        expect(
          ppcPreprocess({ root, srcPath, outPath: join(scratch, 'plain.i'), argv: ['-nosyspath', '-i', 'include'] }),
        ).toContain('plain');
      },
      CONTAINER_BUDGET,
    );
  });
});
