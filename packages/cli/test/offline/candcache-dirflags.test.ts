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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
 *  a compiler that understands them. The header itself is reached through a GLOB, deliberately:
 *  `inc/k.h` is not a token any scan can find, so the ONLY way into the namespace is the
 *  directory operand. And it is pulled in only for a candidate that ASKS, so the fixed stamp
 *  probe TU compiles to bytes independent of `k.h` — the probe backstop structurally cannot see
 *  this input. */
const templateWith = (flags: string): string =>
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
    const r = await acrossAnEdit(p, templateWith('-Wall'));
    expect(r.first).toContain('#define K 3');
    expect(r.second, 'the glob expands into the directory; its contents moved').toContain('#define K 999');
    expect(r.namespaces).toBe(2);
  });
});
