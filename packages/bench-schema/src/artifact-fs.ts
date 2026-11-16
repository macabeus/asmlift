// The split benchmark artifact (./artifact) on DISK: read a directory whole or one project of it,
// and write one. Node-only, so it is its own entry point (`@asmlift/bench-schema/artifact-fs`) and
// the browser-safe package index never reaches it.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARTIFACT_INDEX,
  ARTIFACT_PROJECTS_DIR,
  type ArtifactLayout,
  type ArtifactSource,
  LEGACY_ARTIFACT,
  artifactLayout,
  projectFile,
  readArtifact,
  splitArtifact,
} from './artifact';
import type { BenchOutput } from './index';

/** GitHub refuses a pushed file larger than this. The writer refuses to leave one behind silently. */
export const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

/** The artifact files in `dir`, relative to it — the three shapes `readArtifact` looks at, and
 *  nothing else that shares the directory (tier intermediates, run logs). */
export function artifactFilesIn(dir: string): string[] {
  const files: string[] = [];
  for (const f of [ARTIFACT_INDEX, LEGACY_ARTIFACT]) {
    if (existsSync(join(dir, f))) {
      files.push(f);
    }
  }
  const projects = join(dir, ARTIFACT_PROJECTS_DIR);
  if (existsSync(projects)) {
    for (const f of readdirSync(projects).sort()) {
      if (f.endsWith('.json')) {
        files.push(`${ARTIFACT_PROJECTS_DIR}/${f}`);
      }
    }
  }
  return files;
}

export const artifactLayoutIn = (dir: string): ArtifactLayout => artifactLayout(artifactFilesIn(dir));

export function dirSource(dir: string): ArtifactSource {
  return {
    where: dir,
    files: () => artifactFilesIn(dir),
    read: (rel) => {
      const path = join(dir, rel);
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
      } catch (e) {
        throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      }
    },
  };
}

/** The merged artifact in `dir`. Throws when there is none, or when it is incomplete (./artifact). */
export const readArtifactDir = (dir: string): BenchOutput => readArtifact(dirSource(dir));

/** One project's rows of the artifact in `dir`, under the artifact's `meta`. */
export const readArtifactProject = (dir: string, project: string): BenchOutput => readArtifact(dirSource(dir), project);

/** Write `out` into `dir` split by project: `index.json` plus `projects/<project>.json`, each
 *  `JSON.stringify(…, null, indent)` (2 for the committed, line-diffable artifact; undefined for
 *  the web app's compact copy). Removes what would otherwise make the directory ambiguous or
 *  stale: a project file of a project `out` no longer has, and the old single `results.json`.
 *  Returns every file written with its size, and throws AFTER writing if one is over GitHub's
 *  file limit — the run's output is kept, and the push that would be refused is not left as the
 *  first place anyone finds out. */
export function writeArtifactDir(dir: string, out: BenchOutput, indent?: number): { file: string; bytes: number }[] {
  const { index, projects } = splitArtifact(out);
  mkdirSync(join(dir, ARTIFACT_PROJECTS_DIR), { recursive: true });
  const written: { file: string; bytes: number }[] = [];
  const put = (rel: string, value: unknown): void => {
    const text = JSON.stringify(value, null, indent);
    writeFileSync(join(dir, rel), text);
    written.push({ file: rel, bytes: Buffer.byteLength(text) });
  };
  for (const p of projects) {
    put(projectFile(p.project), p);
  }
  const keep = new Set(projects.map((p) => projectFile(p.project)));
  for (const f of artifactFilesIn(dir)) {
    if (f === LEGACY_ARTIFACT || (f.startsWith(`${ARTIFACT_PROJECTS_DIR}/`) && !keep.has(f))) {
      rmSync(join(dir, f));
    }
  }
  put(ARTIFACT_INDEX, index);
  const over = written.filter((w) => w.bytes > GITHUB_FILE_LIMIT_BYTES);
  if (over.length > 0) {
    throw new Error(
      `written, but GitHub refuses a file over ${GITHUB_FILE_LIMIT_BYTES} bytes: ` +
        over.map((w) => `${join(dir, w.file)} (${w.bytes})`).join(', '),
    );
  }
  return written;
}

/** Each artifact file's size in `dir`, for a report. */
export const artifactSizesIn = (dir: string): { file: string; bytes: number }[] =>
  artifactFilesIn(dir).map((file) => ({ file, bytes: statSync(join(dir, file)).size }));
