// Shared helpers for the per-toolchain compile modules.
import { C_TYPEDEFS } from '@asmlift/core/target';
import { spawnFailure } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Throws the named setup error when the binary itself couldn't spawn (ENOENT/timeout) —
 *  otherwise `status: null` reaches callers as e.g. "agbcc failed: null". Compile failures
 *  (nonzero status, real stderr) still return for the caller to diagnose. */
export function run(cmd: string, args: string[], cwd?: string, env?: Record<string, string>) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
    timeout: 120_000,
  });
  if (r.error) {
    throw new Error(spawnFailure(cmd, r.error));
  }
  return r;
}

/** Select the diagnostic lines of a compiler's output. `file:line:` prefixes count — pre-3.0 gcc
 *  writes errors without the word "error" (`` c.i:12: `x' undeclared ``), and keyword matching
 *  alone would surface only the `In function` banner. The word "failed" deliberately does NOT
 *  count: it selects harness wrapper banners (`agbcc failed:`), not compiler output. An mwcc
 *  caret line (`#   Error:    ^`) carries no message itself — the explanation is the NEXT line,
 *  so that line is kept too. Returns [] when nothing looks like a diagnostic. */
export function pickDiagnostics(lines: string[]): string[] {
  const picked = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!(/:\d+:/.test(l) || /\berror\b/i.test(l))) {
      continue;
    }
    picked.add(l);
    if (/^#\s*Error:[\s^~]*$/i.test(l) && lines[i + 1]) {
      picked.add(lines[i + 1]);
    }
  }
  return [...picked];
}

/** An ABSOLUTE path in a diagnostic, collapsed to its basename. Every file a compile module names
 *  is an mkdtemp scratch file, so the directory is a machine- AND run-local accident: two runs of
 *  the identical failure print different text, which lands verbatim in results.json and churns the
 *  committed artifact on every regeneration (and across machines). The basename is the part that
 *  carries information — `c.c:1076:` says which candidate file and line. Stops at `:` so the
 *  line/column suffix survives, and the leading `/` must open a TOKEN so that prose like
 *  `struct/union/class` is not mistaken for one. A relative path has no leading `/` and is
 *  untouched. */
const ABSOLUTE_PATH = /(^|[\s("'`<])\/(?:[^\s:]+\/)+([^\s:/]+)/g;

/** The diagnostic lines of a compiler's output as one string (capped at 5×240 chars,
 *  newline-joined), falling back to the first non-empty lines. Embedded in the compile modules'
 *  thrown Error messages, which the evaluator turns into row error markers. */
export function compilerDiagnostics(s: string): string {
  const lines = (s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const diags = pickDiagnostics(lines);
  return (diags.length > 0 ? diags : lines)
    .slice(0, 5)
    .map((l) => l.replace(ABSOLUTE_PATH, '$1$2').slice(0, 240))
    .join('\n');
}

/** A content-keyed scratch dir for a reference build: same TU ⇒ same path, every run. The scratch
 *  path leaks into the object (preprocessor linemarkers / file symbols), so a random mkdtemp path
 *  would make the object bytes differ run-to-run and churn the m2c cache key (object sha,
 *  cache.ts). Under /tmp so the docker pool can reach it; distinct TUs never collide
 *  (sha-keyed), and cases that share a TU rebuild byte-identical content, so a cross-shard
 *  rebuild race is benign. */
export function contentDir(tag: string, tu: string): string {
  const d = join('/tmp', `bench-real-${tag}-${createHash('sha256').update(tu).digest('hex').slice(0, 16)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** A scratch directory REUSED across calls: made once, EMPTIED before each use. mkdtemp removes
 *  nothing, so the natural per-compile spelling leaks one directory per candidate — a full bench
 *  run leaves one behind per candidate compile, and they had accumulated into the millions.
 *  Emptied rather than reused in place, so a step that exits 0 without writing its output still
 *  fails LOUD on the missing file instead of silently reading the previous candidate's.
 *
 *  NOT for a directory the DOCKERIZED toolchains compile in. Those reach their scratch through a
 *  bind mount of the host `/tmp`, and reusing one path there fails ~30% of compiles with
 *  `c.o: No such file or directory` — measured, 4 concurrent workers × 40 compiles: 50/160
 *  failures reusing the path, 0/160 with a fresh mkdtemp each time (emptying the CONTENTS and
 *  keeping the inode fails identically, so it is the shared mount's view of the path, not the
 *  inode). gcc272.ts and kmc.ts therefore keep mkdtemp-per-candidate and keep the leak. */
export function scratchSlot(prefix: string, root: string = tmpdir()): () => string {
  let dir: string | undefined;
  return () => {
    if (dir === undefined) {
      dir = mkdtempSync(join(root, prefix));
      return dir;
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    return dir;
  };
}

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** asmlift's typedef prelude, reduced to the names a VENDORED context does not already define.
 *
 *  Per-NAME, not all-or-nothing: a context can own SOME of the family (af's header-less
 *  manifests vendor just `typedef short s16;`). Adding the whole prelude then re-typedefs that
 *  name — a C89 hard error that makes every candidate noncompile — while adding none leaves
 *  the rest of the family (u8/u32/…) undeclared, which is the same noncompile from the other
 *  side. So keep exactly the ones the context lacks.
 *
 *  ONE definition, deliberately: both the scoring path (compile/real.ts's richest strategy) and
 *  the reproduction path (decomp-config.ts's materialized ctx.i) build the same prelude, and a
 *  drift between them means the published script grades in a different world than the harness
 *  did. Returns '' when the context already owns the whole family. */
export function ctxTypedefPrelude(ctxI: string): string {
  const kept = C_TYPEDEFS.trim()
    .split(';')
    .filter((d) => d.trim())
    .map((d) => `${d.trim()};`)
    .filter((d) => {
      const name = d.match(/(\w+);$/)?.[1];
      return name ? !new RegExp(`typedef\\s+[^;]*\\b${name}\\s*;`).test(ctxI) : false;
    });
  return kept.length > 0 ? `${kept.join('')}\n` : '';
}
