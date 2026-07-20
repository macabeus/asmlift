// Shared helpers for the per-toolchain compile modules.
import { spawnFailure } from '@asmlift/toolchains';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
    .map((l) => l.slice(0, 240))
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

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
