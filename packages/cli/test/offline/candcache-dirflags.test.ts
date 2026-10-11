// asmlift — the candidate-object cache's namespace over DIRECTORY-TAKING COMPILER FLAGS.
//
// `compile-command.ts`'s namespace (`commandStaticStamp`) hashes a directory by its whole contents,
// recursively (`hashPath`). The question this file pins is which tokens ever REACH that walk, on
// templates whose header is reached through the shapes below. Before this suite existed the answer
// was "tokens containing `/` or `.`", so on klonoa's own asmlift template:
//
//     -I tools/agbcc/include   -> path-like    HASHED
//     -iquote include          -> a BARE WORD  NOT hashed — the hole
//
// and the gate was the OPERAND'S SPELLING, not the flag: `-I inc` was as much a hole as
// `-iquote inc`, while `-B inc/` (one trailing slash) was already covered. The store keys only the
// benchmark's own commands (candcache-bench.ts), which reach this measurement through the words
// they are rendered with; every case here measures the namespace before and after an edit.
//
// The asymmetry that licenses hashing generously: OVER-hashing costs a cold start, UNDER-hashing
// serves a stale object.
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { commandStaticStamp, containerRuntimeNamedBy, templatePathOperands } from '../../src/compile-command';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
});

/** A throwaway project holding `inc/k.h`. */
function project(): { cwd: string; setK: (v: number) => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'candcache-dirflag-proj-'));
  roots.push(cwd);
  mkdirSync(join(cwd, 'inc'));
  const setK = (v: number): void => writeFileSync(join(cwd, 'inc/k.h'), `#define K ${v}\n`);
  setK(3);
  return { cwd, setK };
}

/** The faithful shape of a header reached through an include directory, in one `sh` line.
 *
 *  `FLAGS` is spelled as arguments to `:` — the shell's no-op builtin — so the flags are real
 *  TOKENS of the template (which is all the namespace ever sees) without a compiler that
 *  understands them.
 *
 *  The header's path is BUILT BY THE SHELL (`H=in; cat ${H}c/k.h`), so neither `inc` nor
 *  `inc/k.h` is a token any scan can find and the flag operand is the ONLY route into the
 *  namespace — take the flag away and the measurement is gone, which the control below pins. */
const templateWith = (flags: string): string =>
  `: ${flags}; cat "{{inputPath}}" > "{{outputPath}}"; ` +
  'if grep -q USES_K "{{inputPath}}"; then H=in; cat ${H}c/k.h >> "{{outputPath}}"; fi';

/** The same, reaching the header through a GLOB instead — `inc/*.h` is path-LIKE and is not a
 *  path, so it too was invisible until the glob's directory was measured. */
const templateGlob = (flags: string): string =>
  `: ${flags}; cat "{{inputPath}}" > "{{outputPath}}"; ` +
  'if grep -q USES_K "{{inputPath}}"; then cat inc/*.h >> "{{outputPath}}"; fi';

/** Whether `template`'s namespace moves when `edit` changes what the compile would read. */
function movesAcross(cwd: string, template: string, edit: () => void): boolean {
  const before = commandStaticStamp(template, cwd);
  edit();
  return commandStaticStamp(template, cwd) !== before;
}
/** …when `inc/k.h` moves. */
const acrossAnEdit = (p: ReturnType<typeof project>, template: string): boolean =>
  movesAcross(p.cwd, template, () => p.setK(999));

// Every spelling the flag table must reach. The operand is a BARE WORD wherever the flag allows
// one, because that is the shape `/[/.]/` refused.
const SEPARATED: [string, string][] = [
  ['-iquote inc', 'the klonoa hole itself'],
  ['-I inc', 'a bare word under the commonest flag of all'],
  ['-isystem inc', ''],
  ['-idirafter inc', ''],
  ['-iwithprefix inc', ''],
  ['-isysroot inc', ''],
  ['-B inc', ''],
  ['-L inc', ''],
  ['-F inc', ''],
  ['--sysroot inc', ''],
];
const ATTACHED: [string, string][] = [
  ['-Iinc', ''],
  ['-iquoteinc', ''],
  ['-isysteminc', ''],
  ['-idirafterinc', ''],
  ['-Binc', ''],
  ['-Linc', ''],
  ['-Finc', ''],
  ['--sysroot=inc', ''],
  ['-Wa,-Iinc', 'a comma list handed to the assembler'],
  ['-specs=inc/k.h', 'a FILE operand, path-like yet unreachable as a whole token'],
  ['-fprofile-use=inc', 'a profile directory'],
  ['-fauto-profile=inc/k.h', 'a profile file'],
  ['-fprofile-sample-use=inc/k.h', ''],
  ['-fplugin=inc/k.h', 'a plugin'],
  ['-iplugindir=inc', ''],
];

describe('a directory a compile flag names is MEASURED, whatever the operand looks like', () => {
  test.each([...SEPARATED, ...ATTACHED])('`%s` — editing inside it re-namespaces%s', (flags) => {
    expect(acrossAnEdit(project(), templateWith(flags)), `${flags}: the directory moved`).toBe(true);
  });

  test('`-I ./inc` was ALREADY covered — the control that must not move', () => {
    expect(acrossAnEdit(project(), templateWith('-I ./inc'))).toBe(true);
  });

  test('a directory-flag operand that does not exist is not an error — it contributes nothing', () => {
    // `-I nosuchdir` alongside a real one: the missing operand must neither throw nor suppress
    // the real measurement. (No MISSING marker is needed — the template TEXT is hashed
    // unconditionally, so absent→present still moves the namespace and two different absent
    // operands cannot collide.)
    expect(acrossAnEdit(project(), templateWith('-I nosuchdir -iquote inc -Bneither/here/nor'))).toBe(true);
  });

  test('THE CONTROL: with no flag naming it, the same directory is NOT measured', () => {
    // The rig's header path is built by the shell, so take the flag away and nothing in the
    // template names `inc` — no token, no glob, and the probe TU never asks for it: one namespace
    // across the edit, which is what every case above is measuring the ABSENCE of.
    expect(acrossAnEdit(project(), templateWith('-Wall -O2')), 'nothing names the directory').toBe(false);
  });

  test('the namespace is keyed by CONTENT under BASENAME, never by absolute path', () => {
    // Two byte-identical toolchains at different absolute paths — the parallel-worktree shape.
    // The operand (`inc`) and the cwd are held FIXED and only the location `inc` resolves to
    // moves, so anything the digest picks up from the real path shows as a second namespace and
    // cold-starts every round.
    const p = project();
    const a = mkdtempSync(join(tmpdir(), 'candcache-dirflag-a-'));
    const b = mkdtempSync(join(tmpdir(), 'candcache-dirflag-bb-'));
    roots.push(a, b);
    for (const d of [a, b]) {
      writeFileSync(join(d, 'k.h'), '#define K 3\n');
    }
    rmSync(join(p.cwd, 'inc'), { recursive: true, force: true });
    symlinkSync(a, join(p.cwd, 'inc'));
    const moved = movesAcross(p.cwd, templateWith('-iquote inc'), () => {
      rmSync(join(p.cwd, 'inc'));
      symlinkSync(b, join(p.cwd, 'inc'));
    });
    expect(moved, 'identical contents at a different path must share ONE namespace').toBe(false);
  });
});

describe('a search path the ENVIRONMENT names refuses the namespace', () => {
  // `CPATH` is `-I` spelled as an environment variable, and gcc honours it even under `-nostdinc`.
  test('CPATH set refuses', () => {
    const p = project();
    const saved = process.env.CPATH;
    process.env.CPATH = join(p.cwd, 'inc');
    try {
      expect(() => commandStaticStamp(templateWith('-Wall'), p.cwd)).toThrow(/CPATH is set/);
    } finally {
      if (saved === undefined) {
        delete process.env.CPATH;
      } else {
        process.env.CPATH = saved;
      }
    }
  });
});

describe('an input that CANNOT be named is refused out loud, not hashed as a stand-in', () => {
  // The benchmark's `gcc2.7.2` command is a one-shot `docker run … "$ASMLIFT_GCC272_IMAGE" …`.
  // Every token of it is measurable except the one that decides which compiler runs: an image is
  // named by a TAG, and an image rebuilt under the same tag is a new compiler nothing in the
  // namespace can see. Until the image DIGEST is in the stamp, the answer is a refusal.
  test('a container runtime in the command refuses the whole pipeline', () => {
    const p = project();
    expect(() => commandStaticStamp(templateWith('docker run i386/ubuntu:bionic gcc'), p.cwd)).toThrow(/image/);
  });

  test('…and a variable HOLDING the runtime name is refused too', () => {
    const p = project();
    const saved = process.env.ASMLIFT_TEST_DOCKER;
    process.env.ASMLIFT_TEST_DOCKER = '/usr/local/bin/podman';
    try {
      expect(() => commandStaticStamp(templateWith('$ASMLIFT_TEST_DOCKER run img'), p.cwd)).toThrow(/podman/);
    } finally {
      if (saved === undefined) {
        delete process.env.ASMLIFT_TEST_DOCKER;
      } else {
        process.env.ASMLIFT_TEST_DOCKER = saved;
      }
    }
  });

  test('a token that merely CONTAINS the word is measured — the refusal is on the basename', () => {
    expect(acrossAnEdit(project(), templateWith('-iquote inc tools/dockerize'))).toBe(true);
  });
});

describe('a directory the template reaches through a GLOB is measured as well', () => {
  // `cat inc/*.h` names the directory in a way `statSync` cannot follow: `inc/*.h` is path-LIKE
  // (it has a `/` and a `.`) yet it is not a path, so the token scan tries it and fails, and no
  // probe TU reaches it either. Hashing the glob's DIRECTORY closes it; over-hashing costs a cold
  // start.
  test('editing a file the glob would expand to re-namespaces', () => {
    // No flag names `inc` anywhere: the glob inside the command is the only mention.
    expect(acrossAnEdit(project(), templateGlob('-Wall'))).toBe(true);
  });
});

describe('the operand parser, on the template the hole was measured on', () => {
  // klonoa's own `tools.asmlift.compiler`, verbatim. `-I tools/agbcc/include` was hashed by the
  // old token scan (it has a `/`); `-iquote include` is a bare word and was the ONE unhashed
  // directory operand in the whole corpus.
  const KLONOA = [
    'ASM_DIR="$(dirname "{{outputPath}}")"',
    'PRE_FILE="$ASM_DIR/$BASENAME.i"',
    'arm-none-eabi-cpp \\',
    '  -nostdinc -I tools/agbcc/include -iquote include \\',
    '  "{{inputPath}}" -o "$PRE_FILE"',
    './tools/agbcc/bin/agbcc \\',
    '  "$PRE_FILE" -o "$ASM_FILE" -mthumb-interwork -O2 -fhex-asm -fprologue-bugfix',
    'arm-none-eabi-as -mcpu=arm7tdmi -mthumb-interwork "$ASM_FILE" -o "{{outputPath}}"',
  ].join('\n');

  test('both include directories are operands, the bare word included', () => {
    expect(templatePathOperands(KLONOA)).toEqual(['tools/agbcc/include', 'include']);
  });

  test('a flag is read longest-first, so -isystem is never -I with the operand "system"', () => {
    expect(templatePathOperands('cc -isystem inc -iwithprefixbefore pre -Iattached x.c')).toEqual([
      'inc',
      'pre',
      'attached',
    ]);
  });

  test('a flag whose operand is another flag takes none — and neither do the ordinary ones', () => {
    expect(templatePathOperands('cc -I -Wall -O2 -fhex-asm -mthumb-interwork -o out.o in.c')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// THE POISON PROBES. Every case here is a shape whose namespace stood still across an edit of
// the header the shell actually reads, until the mechanism below measured it.
//
// The two ablations that say which half earns what, both against this file at 62 tests: with the
// operand scan replaced by `[]`, 43 passed / 19 failed — the de-gluer table earns the ATTACHED
// spellings, the flag-file bodies and the glob directory. With a `/[/.]/.test(tok)` path-shape
// guard put back in front of the token scan, 58 passed / 4 failed — an operand two tokens from
// its flag, a flag that does not exist yet, an assignment RHS, and a quoted operand with a space.
// Neither half is the mechanism, and the list's failure mode is the dangerous one because it is
// invisible.
// ------------------------------------------------------------------------------------------

describe('a flag NOBODY listed still measures its operand, because the filesystem answers', () => {
  // The point of dropping the `/[/.]/` guard: these flags are not in `PATH_FLAGS` at all (or, for
  // the last one, are separated from their operand by two other tokens), and the operand is
  // measured anyway because every token is tried as a path.
  const UNLISTED: [string, string][] = [
    ['--include-directory inc', 'the GNU long spelling of -I'],
    ['-iframework inc', 'a clang/darwin framework dir'],
    ['-imultilib inc', ''],
    ['-Xpreprocessor -I -Xpreprocessor inc', 'the operand two tokens away from its flag'],
    ['-fsome-future-flag inc', 'a flag that does not exist yet'],
  ];
  test.each(UNLISTED)('`%s` — editing inside it re-namespaces%s', (flags) => {
    expect(acrossAnEdit(project(), templateWith(flags)), `${flags}: the directory moved`).toBe(true);
  });

  // The other half: an ATTACHED long spelling, where the filesystem cannot help because the
  // operand is glued to the flag. This is what the de-gluer table is for, and it is the reason
  // the table survives at all.
  test('`--include-directory=inc` — glued, so only the table can un-glue it', () => {
    expect(acrossAnEdit(project(), templateWith('--include-directory=inc'))).toBe(true);
  });

  test('a token longer than 300 characters is an ordinary deep checkout, not noise', () => {
    const p = project();
    const deep = join(p.cwd, 'd'.repeat(120), 'e'.repeat(120), 'f'.repeat(120));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'k.h'), '#define K 3\n');
    const template =
      `: -I ${deep}; cat "{{inputPath}}" > "{{outputPath}}"; ` +
      `if grep -q USES_K "{{inputPath}}"; then cat ${deep}/k.h >> "{{outputPath}}"; fi`;
    expect(
      movesAcross(p.cwd, template, () => writeFileSync(join(deep, 'k.h'), '#define K 999\n')),
      `an operand ${deep.length} chars long was dropped by the scan`,
    ).toBe(true);
  });
});

describe('an operand the SHELL spells differently than the scan does', () => {
  test('`-I $INC` where the TEMPLATE assigns INC — the assignment RHS is a token too', () => {
    // klonoa's own template already assigns four variables, so this is one edit from the corpus
    // rather than a hypothetical: `AGBCC=tools/agbcc; … -I $AGBCC/include`.
    const template =
      'INC=inc; : -I $INC; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then cat $INC/k.h >> "{{outputPath}}"; fi';
    expect(acrossAnEdit(project(), template), 'the operand lives in a variable the template assigns').toBe(true);
  });

  test('`-iquote "my inc"` — a quoted operand with a space in it', () => {
    const p = project();
    mkdirSync(join(p.cwd, 'my inc'));
    writeFileSync(join(p.cwd, 'my inc/k.h'), '#define K 3\n');
    const template =
      ': -iquote "my inc"; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then D=my; cat "$D inc/k.h" >> "{{outputPath}}"; fi';
    expect(
      movesAcross(p.cwd, template, () => writeFileSync(join(p.cwd, 'my inc/k.h'), '#define K 999\n')),
      'the splitter treats a quote as a separator, so the path arrived as two tokens',
    ).toBe(true);
  });

  test('`cd sub; -I inc` — a `cd` moves what a relative operand means', () => {
    const p = project();
    mkdirSync(join(p.cwd, 'sub/inc'), { recursive: true });
    writeFileSync(join(p.cwd, 'sub/inc/k.h'), '#define K 3\n');
    const template =
      'cd sub; : -I inc; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then H=in; cat ${H}c/k.h >> "{{outputPath}}"; fi';
    expect(
      movesAcross(p.cwd, template, () => writeFileSync(join(p.cwd, 'sub/inc/k.h'), '#define K 999\n')),
      'the operand resolves against the cd target, not the decomp.yaml dir',
    ).toBe(true);
  });

  test('`-I ~/inc` — the SHELL expands the tilde before any compiler sees it', () => {
    const p = project();
    const home = mkdtempSync(join(tmpdir(), 'candcache-dirflag-home-'));
    roots.push(home);
    mkdirSync(join(home, 'inc'));
    writeFileSync(join(home, 'inc/k.h'), '#define K 3\n');
    const template =
      ': -I ~/inc; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then cat ~/inc/k.h >> "{{outputPath}}"; fi';
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // `homedir()` is what the mechanism uses; if the two disagree this case measures nothing.
      expect(homedir()).toBe(home);
      expect(
        movesAcross(p.cwd, template, () => writeFileSync(join(home, 'inc/k.h'), '#define K 999\n')),
        "resolve(cwd, '~/inc') names a directory that does not exist",
      ).toBe(true);
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
    }
  });

  // A glob with no directory part (`cat *.h`) expands in the PROJECT ROOT, and the project root is
  // not a directory anyone named: measured on this box, walking it is 29 126 entries at
  // pokeemerald and 47 211 at a real klonoa dev checkout, both over the 20 000-entry stamp budget,
  // so minting `.` as an operand refused those projects outright; where it fit, the namespace then
  // tracked `build/` and `.git/` and no run was ever warm.
  test('`cat *.h` — a glob naming the PROJECT ROOT is not measured', () => {
    const template =
      ': -Wall; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then cat *.h >> "{{outputPath}}"; fi';
    expect(templatePathOperands(template), 'no `.` operand is synthesized').toEqual([]);
    expect(templatePathOperands(': -include global.h; cc'), 'nor from an injected header at the root').toEqual([
      'global.h',
    ]);
  });

  // A SHELL COMMENT IS NOT ARGV. `#` to end of line is dropped by `sh`, so nothing in it is read
  // — and a decomp `compiler:` template is multi-line shell where a `#` line is ordinary. Left
  // scanned, one English word in a comment put the project's own OUTPUT TREE in the namespace and
  // every rebuild was cold.
  test('a directory named only in a COMMENT is not measured, and the comment still moves the namespace', () => {
    const p = project();
    mkdirSync(join(p.cwd, 'build'));
    writeFileSync(join(p.cwd, 'build/out.o'), 'first\n');
    const template = ': -nostdinc; cat "{{inputPath}}" > "{{outputPath}}" # remember to clean build';
    expect(
      movesAcross(p.cwd, template, () => writeFileSync(join(p.cwd, 'build/out.o'), 'second\n')),
      'rewriting the build tree must not move the namespace',
    ).toBe(false);
    expect(
      commandStaticStamp(`${template} now`, p.cwd),
      'the raw template text is still hashed, so editing the comment does move it',
    ).not.toBe(commandStaticStamp(template, p.cwd));
  });

  // The same property on the refusal side: `containerRuntimeNamedBy` reads every token, so a
  // comment word disabled the cache for a whole project with a message asserting the compile runs
  // through a container it does not run through.
  test('a runtime word in a COMMENT does not refuse the project', () => {
    expect(containerRuntimeNamedBy('cc a -o b # our CI also builds this in docker', {})).toBeUndefined();
    expect(containerRuntimeNamedBy('cc a -o b # copy from the server with scp/ssh', {})).toBeUndefined();
    // …and the comment is the only thing that changed: the same word outside one still refuses.
    expect(containerRuntimeNamedBy('docker run img cc a -o b', {})).toBe('docker');
    // …and a `#` inside a QUOTED span does not begin a comment, which is why the strip tracks
    // quotes rather than cutting at the first `#`.
    expect(containerRuntimeNamedBy('cc -o b "runs under # docker"', {})).toBe('docker');
  });
});

describe('a file that holds MORE FLAGS is scanned, not merely hashed', () => {
  // Hashing the file's bytes is not measuring what it NAMES. `@opts` containing `-iquote inc` was
  // hashed as a file while `inc/` was not — which made writing the flag in a response file look
  // SAFER than writing it inline.
  test('`@opts` whose contents name the include directory', () => {
    const p = project();
    writeFileSync(join(p.cwd, 'opts'), '-nostdinc -iquote inc\n');
    expect(acrossAnEdit(p, templateWith('@opts')), 'the response file names the directory').toBe(true);
  });

  // AND with the half the flag table cannot reach. Scanning a response body with the de-gluer
  // ALONE re-imported "the list is the mechanism" one level down, on the stale-object side. Each
  // case below is a flag the table does not name, or no flag.
  test.each([
    ['--fake-include-dir inc', 'a flag nobody listed'],
    ['-Xpreprocessor -I -Xpreprocessor inc', 'an operand two tokens from its flag'],
    ['inc', 'no flag at all — a bare word'],
  ])('`@opts` holding `%s` — %s', (body) => {
    const p = project();
    writeFileSync(join(p.cwd, 'opts'), `-nostdinc ${body}\n`);
    expect(acrossAnEdit(p, templateWith('@opts')), 'a response body gets the token scan').toBe(true);
  });

  test('`-specs=x.specs` whose body names the directory with a flag nobody listed', () => {
    const p = project();
    writeFileSync(join(p.cwd, 'x.specs'), '*cpp:\n+ --fake-include-dir inc\n');
    expect(acrossAnEdit(p, templateWith('-specs=x.specs')), 'the same token scan reaches into a specs body').toBe(true);
  });

  test('`-specs=x.specs` whose body adds the include directory', () => {
    const p = project();
    writeFileSync(join(p.cwd, 'x.specs'), '*cpp:\n+ -iquote inc\n');
    expect(acrossAnEdit(p, templateWith('-specs=x.specs')), 'a specs body is compile flags').toBe(true);
  });

  test('`-include pre.h` — the injected header resolves ITS quoted includes from its own dir', () => {
    // gcc resolves `#include "sub/x.h"` inside an injected header from the DIRECTORY THE HEADER
    // IS IN, which is never an operand and never a token.
    const p = project();
    mkdirSync(join(p.cwd, 'inc/sub'), { recursive: true });
    writeFileSync(join(p.cwd, 'inc/pre.h'), '/* injected */\n');
    writeFileSync(join(p.cwd, 'inc/sub/x.h'), '#define K 3\n');
    const template =
      ': -include inc/pre.h; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then H=in; cat ${H}c/sub/x.h >> "{{outputPath}}"; fi';
    expect(
      movesAcross(p.cwd, template, () => writeFileSync(join(p.cwd, 'inc/sub/x.h'), '#define K 999\n')),
      "the injected header's own closure is read from the directory it lives in",
    ).toBe(true);
    expect(dirname('inc/pre.h')).toBe('inc');
  });
});

describe('a path the walk CANNOT read is a refusal, never a miss', () => {
  // Mode 0311 — `--wx--x--x`: SEARCHABLE and not LISTABLE, which is exactly what a compile needs
  // of an include directory and exactly what a walk does not get.
  test('an include directory that is searchable but not listable refuses out loud', () => {
    const p = project();
    chmodSync(join(p.cwd, 'inc'), 0o311);
    try {
      // Skip rather than pass vacuously where the filesystem (or root) makes it listable anyway.
      let listable = false;
      try {
        readdirSync(join(p.cwd, 'inc'));
        listable = true;
      } catch {
        listable = false;
      }
      if (listable) {
        return;
      }
      expect(() => commandStaticStamp(templateWith('-iquote inc'), p.cwd)).toThrow(/cannot list the directory/);
    } finally {
      chmodSync(join(p.cwd, 'inc'), 0o755);
    }
  });

  test('a DANGLING SYMLINK inside a measured directory is not a refusal — the walk goes on', () => {
    // Refusing over a dangling symlink would refuse half the toolchains on earth. The entry's NAME
    // joins the digest and the measurement continues.
    const p = project();
    symlinkSync(join(p.cwd, 'inc/nothing-here'), join(p.cwd, 'inc/broken'));
    expect(acrossAnEdit(p, templateWith('-iquote inc'))).toBe(true);
  });

  test('an opaque runtime named through a variable the TEMPLATE assigns is refused', () => {
    // `DOCKER=docker; $DOCKER run …` is invisible to a check that resolves `$VAR` only through
    // `process.env`.
    expect(() => commandStaticStamp('DOCKER=docker; ' + templateWith('$DOCKER run img cc'), project().cwd)).toThrow(
      /docker/,
    );
  });

  test.each([['ssh builder cc'], ['chroot /opt/sysroot cc'], ['distrobox-enter -n box -- cc'], ['qemu-i386 ./cc']])(
    '`%s` runs the compiler where this namespace cannot read it',
    (runner) => {
      expect(() => commandStaticStamp(templateWith(runner), project().cwd)).toThrow(/runs the compiler through/);
    },
  );
});
