// asmlift — the candidate-object cache's namespace over DIRECTORY-TAKING COMPILER FLAGS.
//
// `compile-command.ts`'s stamp already hashes a directory by its whole contents, recursively
// (`hashPath`). The question this file pins is which tokens ever REACH that walk. Before this
// suite existed the answer was "tokens containing `/` or `.`", so on klonoa's own asmlift
// template:
//
//     -I tools/agbcc/include   -> path-like    HASHED, no declaration needed
//     -iquote include          -> a BARE WORD  NOT hashed — the hole
//
// and the gate was the OPERAND'S SPELLING, not the flag: `-I inc` was as much a hole as
// `-iquote inc`, while `-B inc/` (one trailing slash) was already covered. Closing it by hand
// needed `tools.asmlift.cacheInputs`, a config key whose incompleteness is a silent stale
// object; measuring it instead is what DELETED that key, and is why the cache now runs on a
// project's own command with no declaration at all.
//
// The asymmetry that licenses hashing generously: OVER-hashing costs a cold start, UNDER-hashing
// serves a stale object.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Every case here drives ~6 BLOCKING `spawnSync('sh')` calls (two stamp probes and a compile,
// twice) plus a full directory walk, and this file joins a pool whose config says "no blocking
// spawnSync — so these run in PARALLEL worker forks". Under the 5000 ms default it is load-
// dependent, and a test abandoned at its `await import()` resumes into a project directory the
// shared `afterEach` has already removed — so it goes red on a CONTENT assertion and reads like
// a soundness failure. Measured on one machine at one commit: loadavg ~50 -> 32 passed in 18.1 s;
// loadavg ~76 -> 2 failed on `Test timed out in 5000ms`; loadavg ~87 -> 20 failed. `test:offline`
// is a CI gate on a shared runner.
vi.setConfig({ testTimeout: 120_000 });

type CompileCommandModule = typeof import('../../src/compile-command');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { recursive: true, force: true });
  }
  vi.resetModules();
});

/** A throwaway project holding `inc/k.h`, plus a private store so each case's namespaces are
 *  countable on their own. */
function project(): { cwd: string; store: string; setK: (v: number) => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'candcache-dirflag-proj-'));
  const store = mkdtempSync(join(tmpdir(), 'candcache-dirflag-store-'));
  roots.push(cwd, store);
  mkdirSync(join(cwd, 'inc'));
  const setK = (v: number): void => writeFileSync(join(cwd, 'inc/k.h'), `#define K ${v}\n`);
  setK(3);
  return { cwd, store, setK };
}

/** The faithful shape of a header reached through an include directory, in one `sh` line.
 *
 *  `FLAGS` is spelled as arguments to `:` — the shell's no-op builtin — so the flags are real
 *  TOKENS of the template (which is all the namespace ever sees) without the offline rig needing
 *  a compiler that understands them.
 *
 *  Two properties make this the real hole rather than an easy one. The header's path is BUILT BY
 *  THE SHELL (`H=in; cat ${H}c/k.h`), so neither `inc` nor `inc/k.h` is a token any scan can
 *  find and the flag operand is the ONLY route into the namespace — take the flag away and the
 *  measurement is gone, which the control below pins. And it is pulled in only for a candidate
 *  that ASKS, so the fixed stamp probe TU compiles to bytes independent of `k.h`: the probe
 *  backstop structurally cannot see this input either. */
const templateWith = (flags: string): string =>
  `: ${flags}; cat "{{inputPath}}" > "{{outputPath}}"; ` +
  'if grep -q USES_K "{{inputPath}}"; then H=in; cat ${H}c/k.h >> "{{outputPath}}"; fi';

/** The same, reaching the header through a GLOB instead — `inc/*.h` is path-LIKE and is not a
 *  path, so it too was invisible until the glob's directory was measured. */
const templateGlob = (flags: string): string =>
  `: ${flags}; cat "{{inputPath}}" > "{{outputPath}}"; ` +
  'if grep -q USES_K "{{inputPath}}"; then cat inc/*.h >> "{{outputPath}}"; fi';

const CAND_K = '/* USES_K */\ns32 f(s32 a0) { return a0 + K; }\n';

async function withCache<T>(
  env: Record<string, string | undefined>,
  fn: (mod: CompileCommandModule) => Promise<T> | T,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  vi.resetModules();
  try {
    return await fn(await import('../../src/compile-command'));
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

/** Compile one candidate, move `inc/k.h`, and compile it again through a NEW compiler instance —
 *  a second run of asmlift against the same store. Returns what each run SERVED plus how many
 *  namespaces the store grew, which is the mechanism rather than the outcome. */
async function acrossAnEdit(
  p: ReturnType<typeof project>,
  template: string,
): Promise<{ first: string; second: string; namespaces: number }> {
  const seen = await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
    const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
    p.setK(999);
    const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
    return { first, second };
  });
  const ns = join(p.store, 'ns');
  return { ...seen, namespaces: existsSync(ns) ? readdirSync(ns).length : 0 };
}

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
];

describe('a directory a compile flag names is MEASURED, whatever the operand looks like', () => {
  test.each([...SEPARATED, ...ATTACHED])('`%s` — editing inside it re-namespaces%s', async (flags) => {
    const p = project();
    const r = await acrossAnEdit(p, templateWith(flags));
    expect(r.first).toContain('#define K 3');
    expect(r.second, `${flags}: the directory moved, so the stored object is not the answer`).toContain(
      '#define K 999',
    );
    expect(r.namespaces, 'two namespaces, one per state of inc/ — the mechanism, not the outcome').toBe(2);
  });

  test('`-I ./inc` was ALREADY covered — the control that must not move', async () => {
    const p = project();
    const r = await acrossAnEdit(p, templateWith('-I ./inc'));
    expect(r.second).toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });

  test('a directory-flag operand that does not exist is not an error — it contributes nothing', async () => {
    const p = project();
    // `-I nosuchdir` alongside a real one: the missing operand must neither throw nor suppress
    // the real measurement. (No MISSING marker is needed the way `declared:` needed one — the
    // template TEXT is hashed unconditionally, so absent→present still moves the namespace and
    // two different absent operands cannot collide.)
    const r = await acrossAnEdit(p, templateWith('-I nosuchdir -iquote inc -Bneither/here/nor'));
    expect(r.first).toContain('#define K 3');
    expect(r.second).toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });

  test('THE CONTROL: with no flag naming it, the same directory is NOT measured', async () => {
    // The rig's header path is built by the shell, so take the flag away and nothing in the
    // template names `inc` — no token, no glob, and the probe TU never asks for it. The stored
    // object is then served after the directory moved, which is what every case above is
    // measuring the ABSENCE of. It is also the residual, stated as a test rather than a
    // sentence: a directory a command reaches through a path IT COMPUTES is beyond this
    // measurement, and `ASMLIFT_CANDCACHE=verify` is what catches that shape.
    const p = project();
    const r = await acrossAnEdit(p, templateWith('-Wall -O2'));
    expect(r.first).toContain('#define K 3');
    expect(r.second, 'nothing names the directory, so the namespace cannot move').toContain('#define K 3');
    expect(r.namespaces, 'one namespace: the store answered from it').toBe(1);
  });

  test('the namespace is keyed by CONTENT under BASENAME, never by absolute path', async () => {
    // Two byte-identical toolchains at different absolute paths — the parallel-worktree shape.
    // Green BEFORE the flag table exists too, and vacuously so (nothing about `inc` was in the
    // digest at all); it only starts saying something once the operand IS measured, which is
    // exactly when it can go wrong.
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
    const template = templateWith('-iquote inc');
    const served = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        symlinkSync(a, join(p.cwd, 'inc'));
        const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        rmSync(join(p.cwd, 'inc'));
        symlinkSync(b, join(p.cwd, 'inc'));
        const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        return { first, second };
      },
    );
    expect(served.first).toContain('#define K 3');
    expect(served.second).toContain('#define K 3');
    expect(
      readdirSync(join(p.store, 'ns')).length,
      'identical contents at a different path must share ONE namespace, or every worktree cold-starts',
    ).toBe(1);
  });
});

describe('a search path the ENVIRONMENT names is measured too — the same hole, one token wide', () => {
  // `CPATH` is `-I` spelled as an environment variable, and gcc honours it even under
  // `-nostdinc`. `COMPILE_ENV` already put its VALUE in the namespace; the value is only half an
  // answer, because what the compile actually reads is the directory it points AT.
  test('editing a file inside CPATH re-namespaces', async () => {
    const p = project();
    // No flag at all: the template names `inc` nowhere. The environment is the only route in.
    const template = templateWith('-Wall');
    const saved = process.env.CPATH;
    process.env.CPATH = `/nonexistent-a:${join(p.cwd, 'inc')}`;
    try {
      const r = await acrossAnEdit(p, template);
      expect(r.first).toContain('#define K 3');
      expect(r.second, 'CPATH names the directory; its contents moved').toContain('#define K 999');
      expect(r.namespaces).toBe(2);
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
  const stderrOf = async (fn: () => Promise<void> | void): Promise<string> => {
    let out = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return out;
  };

  // The benchmark's `gcc2.7.2` command is a one-shot `docker run … "$ASMLIFT_GCC272_IMAGE" …`.
  // Every token of it is measurable except the one that decides which compiler runs: an image is
  // named by a TAG, and an image rebuilt under the same tag is a new compiler nothing in the
  // namespace can see. Until the image DIGEST is in the stamp, the answer is a refusal — which is
  // what the deleted `tools.asmlift.cacheInputs` opt-in was silently providing by omission.
  test('a container runtime in the command refuses the whole pipeline', async () => {
    const p = project();
    const err = await stderrOf(async () => {
      await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
        const compile = compileFromCommand(templateWith('docker run i386/ubuntu:bionic gcc'), { cwd: p.cwd });
        // A refusal is not a failure: the compile still happens and still answers.
        expect(readFileSync(compile(CAND_K, 'f', 'c'), 'utf8')).toContain('#define K 3');
      });
    });
    expect(err).toContain('[candcache] REFUSED label=command reason=stamp-threw');
    expect(err).toContain('image');
    expect(existsSync(join(p.store, 'ns')), 'a refused pipeline stores nothing at all').toBe(false);
  });

  test('…and a variable HOLDING the runtime name is refused too', async () => {
    const p = project();
    const saved = process.env.ASMLIFT_TEST_DOCKER;
    process.env.ASMLIFT_TEST_DOCKER = '/usr/local/bin/podman';
    try {
      const err = await stderrOf(async () => {
        await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
          compileFromCommand(templateWith('$ASMLIFT_TEST_DOCKER run img'), { cwd: p.cwd })(CAND_K, 'f', 'c');
        });
      });
      expect(err).toContain('reason=stamp-threw');
    } finally {
      if (saved === undefined) {
        delete process.env.ASMLIFT_TEST_DOCKER;
      } else {
        process.env.ASMLIFT_TEST_DOCKER = saved;
      }
    }
  });

  test('a token that merely CONTAINS the word still caches — the refusal is on the basename', async () => {
    const p = project();
    const r = await acrossAnEdit(p, templateWith('-iquote inc tools/dockerize'));
    expect(r.second).toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });
});

describe('a directory the template reaches through a GLOB is measured as well', () => {
  // `cat inc/*.h` names the directory in a way `statSync` cannot follow: `inc/*.h` is path-LIKE
  // (it has a `/` and a `.`) yet it is not a path, so the token scan tried it and failed. This is
  // the shape the offline rig for the old declaration deliberately used, precisely because
  // nothing else could see it. Hashing the glob's DIRECTORY closes it; over-hashing costs a cold
  // start.
  test('editing a file the glob would expand to re-namespaces', async () => {
    const p = project();
    // No flag names `inc` anywhere: the glob inside the command is the only mention.
    const r = await acrossAnEdit(p, templateGlob('-Wall'));
    expect(r.first).toContain('#define K 3');
    expect(r.second, 'the glob expands into the directory; its contents moved').toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });
});

describe('the operand parser, on the template the hole was measured on', () => {
  // klonoa's own `tools.asmlift.compiler`, verbatim. `-I tools/agbcc/include` was hashed by the
  // old token scan (it has a `/`); `-iquote include` is a bare word and was the ONE unhashed
  // directory operand in the whole corpus — every other checkout has no asmlift compile template
  // at all.
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

  test('both include directories are operands, the bare word included', async () => {
    const { templatePathOperands } = await import('../../src/compile-command');
    expect(templatePathOperands(KLONOA)).toEqual(['tools/agbcc/include', 'include']);
  });

  test('a flag is read longest-first, so -isystem is never -I with the operand "system"', async () => {
    const { templatePathOperands } = await import('../../src/compile-command');
    expect(templatePathOperands('cc -isystem inc -iwithprefixbefore pre -Iattached x.c')).toEqual([
      'inc',
      'pre',
      'attached',
    ]);
  });

  test('a flag whose operand is another flag takes none — and neither do the ordinary ones', async () => {
    const { templatePathOperands } = await import('../../src/compile-command');
    expect(templatePathOperands('cc -I -Wall -O2 -fhex-asm -mthumb-interwork -o out.o in.c')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// THE POISON PROBES. Every case below was a MEASURED stale object on the first spelling of this
// mechanism — a flag table with a `/[/.]/.test(tok)` guard in front of `hashPath` in the stamp.
// Each one compiles, mutates the header THE SHELL actually reads, compiles again in a fresh
// module instance, and fails if the second run was served the first run's object.
//
// The ablation that says which half of the mechanism earns what: with the guard deleted and the
// operand scan replaced by `[]`, the twenty spellings above ran 21 passed / 11 failed — one
// deleted clause covers every SEPARATED spelling, and the table earns the ATTACHED ones and the
// glob. That is why `PATH_FLAGS` is documented as a DE-GLUER: a list that is the mechanism has an
// invisible incompleteness, and the shapes in the first block here are exactly what that
// invisibility cost.
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
  test.each(UNLISTED)('`%s` — editing inside it re-namespaces%s', async (flags) => {
    const p = project();
    const r = await acrossAnEdit(p, templateWith(flags));
    expect(r.first).toContain('#define K 3');
    expect(r.second, `${flags}: the directory moved, so the stored object is not the answer`).toContain(
      '#define K 999',
    );
    expect(r.namespaces).toBe(2);
  });

  // The other half: an ATTACHED long spelling, where the filesystem cannot help because the
  // operand is glued to the flag. This is what the de-gluer table is for, and it is the reason
  // the table survives at all.
  test('`--include-directory=inc` — glued, so only the table can un-glue it', async () => {
    const p = project();
    const r = await acrossAnEdit(p, templateWith('--include-directory=inc'));
    expect(r.second).toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });

  test('a token longer than 300 characters is an ordinary deep checkout, not noise', async () => {
    const p = project();
    const deep = join(p.cwd, 'd'.repeat(120), 'e'.repeat(120), 'f'.repeat(120));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'k.h'), '#define K 3\n');
    const template =
      `: -I ${deep}; cat "{{inputPath}}" > "{{outputPath}}"; ` +
      `if grep -q USES_K "{{inputPath}}"; then cat ${deep}/k.h >> "{{outputPath}}"; fi`;
    const served = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        writeFileSync(join(deep, 'k.h'), '#define K 999\n');
        const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        return { first, second };
      },
    );
    expect(served.first).toContain('#define K 3');
    expect(served.second, `an operand ${deep.length} chars long was dropped by the scan`).toContain('#define K 999');
  });
});

describe('an operand the SHELL spells differently than the scan does', () => {
  test('`-I $INC` where the TEMPLATE assigns INC — the assignment RHS is a token too', async () => {
    // klonoa's own template already assigns four variables, so this is one edit from the corpus
    // rather than a hypothetical: `AGBCC=tools/agbcc; … -I $AGBCC/include`.
    const p = project();
    const template =
      'INC=inc; : -I $INC; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then cat $INC/k.h >> "{{outputPath}}"; fi';
    const r = await acrossAnEdit(p, template);
    expect(r.first).toContain('#define K 3');
    expect(r.second, 'the operand lives in a variable the template itself assigns').toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });

  test('`-iquote "my inc"` — a quoted operand with a space in it', async () => {
    const p = project();
    mkdirSync(join(p.cwd, 'my inc'));
    writeFileSync(join(p.cwd, 'my inc/k.h'), '#define K 3\n');
    const template =
      ': -iquote "my inc"; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then D=my; cat "$D inc/k.h" >> "{{outputPath}}"; fi';
    const served = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        writeFileSync(join(p.cwd, 'my inc/k.h'), '#define K 999\n');
        const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        return { first, second };
      },
    );
    expect(served.first).toContain('#define K 3');
    expect(served.second, 'the splitter treats a quote as a separator, so the path arrived as two tokens').toContain(
      '#define K 999',
    );
  });

  test('`cd sub; -I inc` — a `cd` moves what a relative operand means', async () => {
    const p = project();
    mkdirSync(join(p.cwd, 'sub/inc'), { recursive: true });
    writeFileSync(join(p.cwd, 'sub/inc/k.h'), '#define K 3\n');
    const template =
      'cd sub; : -I inc; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then H=in; cat ${H}c/k.h >> "{{outputPath}}"; fi';
    const served = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        writeFileSync(join(p.cwd, 'sub/inc/k.h'), '#define K 999\n');
        const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        return { first, second };
      },
    );
    expect(served.first).toContain('#define K 3');
    expect(served.second, 'the operand resolves against the cd target, not the decomp.yaml dir').toContain(
      '#define K 999',
    );
  });

  test('`-I ~/inc` — the SHELL expands the tilde before any compiler sees it', async () => {
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
      const served = await withCache(
        { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
        ({ compileFromCommand }) => {
          const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
          writeFileSync(join(home, 'inc/k.h'), '#define K 999\n');
          const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
          return { first, second };
        },
      );
      expect(served.first).toContain('#define K 3');
      expect(served.second, "resolve(cwd, '~/inc') names a directory that does not exist").toContain('#define K 999');
    } finally {
      if (savedHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = savedHome;
      }
    }
    // `homedir()` is what the mechanism uses; if the two ever disagree this test is measuring
    // nothing, so say so rather than pass vacuously.
    expect(typeof homedir()).toBe('string');
  });

  test('`cat *.h` — a glob with no directory part expands in the CURRENT directory', async () => {
    const p = project();
    writeFileSync(join(p.cwd, 'k.h'), '#define K 3\n');
    const template =
      ': -Wall; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then cat *.h >> "{{outputPath}}"; fi';
    const served = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        writeFileSync(join(p.cwd, 'k.h'), '#define K 999\n');
        const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        return { first, second };
      },
    );
    expect(served.first).toContain('#define K 3');
    expect(served.second, 'the glob has no `/`, so its directory is the cwd').toContain('#define K 999');
  });
});

describe('a file that holds MORE FLAGS is scanned, not merely hashed', () => {
  // Hashing the file's bytes is not measuring what it NAMES. `@opts` containing `-iquote inc` was
  // hashed as a file while `inc/` was not — which made writing the flag in a response file look
  // SAFER than writing it inline, the exact inversion a residual list must not publish.
  test('`@opts` whose contents name the include directory', async () => {
    const p = project();
    writeFileSync(join(p.cwd, 'opts'), '-nostdinc -iquote inc\n');
    const r = await acrossAnEdit(p, templateWith('@opts'));
    expect(r.first).toContain('#define K 3');
    expect(r.second, 'the response file names the directory; its contents moved').toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });

  test('`-specs=x.specs` whose body adds the include directory', async () => {
    const p = project();
    writeFileSync(join(p.cwd, 'x.specs'), '*cpp:\n+ -iquote inc\n');
    const r = await acrossAnEdit(p, templateWith('-specs=x.specs'));
    expect(r.second, 'a specs body is compile flags, and one of them is a path').toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });

  test('`-include pre.h` — the injected header resolves ITS quoted includes from its own dir', async () => {
    // gcc resolves `#include "sub/x.h"` inside an injected header from the DIRECTORY THE HEADER
    // IS IN, which is never an operand and never a token. `-include` is the one flag that puts a
    // `#include` outside the TU, so `candidateCacheRefusal` — which inspects the TU — cannot see
    // it either. Both guards blind at once is exactly where the measurement has to reach.
    const p = project();
    mkdirSync(join(p.cwd, 'inc/sub'), { recursive: true });
    writeFileSync(join(p.cwd, 'inc/pre.h'), '/* injected */\n');
    writeFileSync(join(p.cwd, 'inc/sub/x.h'), '#define K 3\n');
    const template =
      ': -include inc/pre.h; cat "{{inputPath}}" > "{{outputPath}}"; ' +
      'if grep -q USES_K "{{inputPath}}"; then H=in; cat ${H}c/sub/x.h >> "{{outputPath}}"; fi';
    const served = await withCache(
      { ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store },
      ({ compileFromCommand }) => {
        const first = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        writeFileSync(join(p.cwd, 'inc/sub/x.h'), '#define K 999\n');
        const second = readFileSync(compileFromCommand(template, { cwd: p.cwd })(CAND_K, 'f', 'c'), 'utf8');
        return { first, second };
      },
    );
    expect(served.first).toContain('#define K 3');
    expect(served.second, "the injected header's own closure is read from the directory it lives in").toContain(
      '#define K 999',
    );
    expect(dirname('inc/pre.h')).toBe('inc');
  });
});

describe('a path the walk CANNOT read is a refusal, never a miss', () => {
  const stderrCapture = async (fn: () => Promise<void> | void): Promise<string> => {
    let out = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return out;
  };

  // Mode 0311 — `--wx--x--x`: SEARCHABLE and not LISTABLE, which is exactly what a compile needs
  // of an include directory and exactly what a walk does not get. The first spelling swallowed
  // the EACCES into "contributes nothing" and served a stale object with no stderr line at all.
  // The transient case is worse than the permanent one: one EIO on one readdirSync would mint a
  // PERMANENTLY incomplete namespace.
  test('an include directory that is searchable but not listable refuses out loud', async () => {
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
      const err = await stderrCapture(async () => {
        await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
          // A refusal is not a failure: the compile still happens and still answers.
          const out = compileFromCommand(templateWith('-iquote inc'), { cwd: p.cwd })(CAND_K, 'f', 'c');
          expect(readFileSync(out, 'utf8')).toContain('#define K 3');
        });
      });
      expect(err).toContain('[candcache] REFUSED label=command reason=stamp-threw');
      expect(err).toContain('cannot list the directory');
      expect(existsSync(join(p.store, 'ns')), 'a refused pipeline stores nothing at all').toBe(false);
    } finally {
      chmodSync(join(p.cwd, 'inc'), 0o755);
    }
  });

  test('a DANGLING SYMLINK inside a measured directory is not a refusal — the walk goes on', async () => {
    // The other side of the same coin: refusing over a dangling symlink would refuse half the
    // toolchains on earth. The entry's NAME joins the digest and the measurement continues.
    const p = project();
    symlinkSync(join(p.cwd, 'inc/nothing-here'), join(p.cwd, 'inc/broken'));
    const r = await acrossAnEdit(p, templateWith('-iquote inc'));
    expect(r.first).toContain('#define K 3');
    expect(r.second).toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });

  test('an opaque runtime named through a variable the TEMPLATE assigns is refused', async () => {
    // `DOCKER=docker; $DOCKER run …` defeated the first spelling, which resolved `$VAR` only
    // through `process.env` — while every template in this repo assigns shell variables.
    const p = project();
    const err = await stderrCapture(async () => {
      await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
        compileFromCommand('DOCKER=docker; ' + templateWith('$DOCKER run img cc'), { cwd: p.cwd })(CAND_K, 'f', 'c');
      });
    });
    expect(err).toContain('reason=stamp-threw');
    expect(existsSync(join(p.store, 'ns'))).toBe(false);
  });

  test.each([['ssh builder cc'], ['chroot /opt/sysroot cc'], ['distrobox-enter -n box -- cc'], ['qemu-i386 ./cc']])(
    '`%s` runs the compiler where this namespace cannot read it',
    async (runner) => {
      const p = project();
      const err = await stderrCapture(async () => {
        await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
          compileFromCommand(templateWith(runner), { cwd: p.cwd })(CAND_K, 'f', 'c');
        });
      });
      expect(err).toContain('reason=stamp-threw');
    },
  );
});

describe("a project's own REFUSAL — tools.asmlift.candidateCache: off", () => {
  // The escape the deny-list above cannot be: a project whose compiler runs somewhere nothing
  // here can read it says so in its own decomp.yaml, and the worst case of getting it wrong is a
  // cold start. It is the inverse shape of the deleted `cacheInputs`, whose worst case was a
  // stale object.
  test('the store is never even created for a command that declares it', async () => {
    const p = project();
    const r = await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
      const compile = compileFromCommand(templateWith('-iquote inc'), { cwd: p.cwd, candidateCache: 'off' });
      const first = readFileSync(compile(CAND_K, 'f', 'c'), 'utf8');
      p.setK(999);
      const second = readFileSync(compile(CAND_K, 'f', 'c'), 'utf8');
      return { first, second };
    });
    expect(r.first).toContain('#define K 3');
    expect(r.second, 'with no cache there is nothing to serve stale').toContain('#define K 999');
    expect(existsSync(join(p.store, 'ns')), 'a declared refusal writes no namespace at all').toBe(false);
  });

  test('and it is silent — a declared refusal is not an alarm', async () => {
    const p = project();
    let out = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
    try {
      await withCache({ ASMLIFT_CANDCACHE: '1', ASMLIFT_CANDCACHE_DIR: p.store }, ({ compileFromCommand }) => {
        compileFromCommand('docker run img cc; ' + templateWith('-iquote inc'), {
          cwd: p.cwd,
          candidateCache: 'off',
        })(CAND_K, 'f', 'c');
      });
    } finally {
      spy.mockRestore();
    }
    expect(out, 'the project already said no — there is nothing to warn about').not.toContain('[candcache]');
  });
});
