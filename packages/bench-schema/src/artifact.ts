// The benchmark artifact's on-disk LAYOUT: one small index file holding everything run-wide
// (`meta`, and which projects there are), and one file per project holding that project's rows.
// One merged artifact is too large for a single committed file (GitHub refuses any file over
// 100 MiB, and the merged one passed 97 MiB), so it is committed split and every reader merges it
// back through `readArtifact` here. The merged view is exactly the `{ meta, results }` a single
// file used to hold: same `meta` object, same rows, same row order.
//
// Pure and browser-safe like the rest of this package: the reader takes a `ArtifactSource` that
// lists and parses files, so the same join serves a directory on disk (./artifact-fs), a tree at
// a git ref (apps/benchmark/src/report/committed.ts) and the web app's bundled JSON
// (apps/web/src/pages/benchmark/lib/data.ts).
//
// A ref before the split carries ONE file, `results.json`; `readArtifact` still reads it, so a
// gate comparing against a base that predates the split keeps working.
import type { BenchMeta, BenchOutput, FunctionResult } from './index';

/** The run-wide file: `{ meta, projects }`. */
export const ARTIFACT_INDEX = 'index.json';
/** The directory holding one `<project>.json` per project. */
export const ARTIFACT_PROJECTS_DIR = 'projects';
/** The single-file artifact every commit before the split carries. Read, never written. */
export const LEGACY_ARTIFACT = 'results.json';

export const projectFile = (project: string): string => `${ARTIFACT_PROJECTS_DIR}/${project}.json`;

export interface ArtifactIndex {
  meta: BenchMeta;
  /** Every project the artifact holds rows of, sorted. A listed project with no file is an error,
   *  never an empty project. */
  projects: string[];
  /** The merged row order, as runs of consecutive rows from one project: `[project, count]`.
   *  Each project file holds its rows in merged order, so these runs interleave them back into
   *  exactly the order the merge wrote — recorded rather than re-derived by sorting, because the
   *  merge sorts with `localeCompare`, whose order is the host's locale and a browser's may differ.
   *  Today one run per project (the ids sort by their project prefix). */
  runs: [string, number][];
}

export interface ProjectRows {
  project: string;
  /** This project's rows, in artifact order. */
  results: FunctionResult[];
}

/** A project name that is safe as a file name on every host, and the only kind the writer takes. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The merged artifact split into its files' contents. Projects sorted; each project's rows keep
 *  the merged order, and the index's `runs` record how they interleave. Throws on a row with no usable `project`, which no file could hold. */
export function splitArtifact(out: BenchOutput): { index: ArtifactIndex; projects: ProjectRows[] } {
  const by = new Map<string, FunctionResult[]>();
  const runs: [string, number][] = [];
  for (const r of out.results) {
    if (typeof r.project !== 'string' || !PROJECT_NAME.test(r.project)) {
      throw new Error(`row ${r.id} has project ${JSON.stringify(r.project)}, which cannot name an artifact file`);
    }
    let rows = by.get(r.project);
    if (rows === undefined) {
      by.set(r.project, (rows = []));
    }
    rows.push(r);
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === r.project) {
      last[1]++;
    } else {
      runs.push([r.project, 1]);
    }
  }
  const names = [...by.keys()].sort();
  return {
    index: { meta: out.meta, projects: names, runs },
    projects: names.map((project) => ({ project, results: by.get(project)! })),
  };
}

/** Where an artifact's files come from. `files` lists every file under the artifact directory, as
 *  paths relative to it (`index.json`, `projects/kleod.json`, `results.json`, and anything else —
 *  only these three shapes are looked at); `read` returns one file PARSED. */
export interface ArtifactSource {
  /** Names the source in an error: a directory, `<ref>:<dir>`, the web bundle. */
  where: string;
  files(): readonly string[];
  read(rel: string): unknown;
}

export type ArtifactLayout = 'split' | 'legacy' | 'none';

/** Which layout a file listing holds. Both at once is refused by `readArtifact`: a reader cannot
 *  know which one the writer meant, and one of them is stale. */
export function artifactLayout(files: readonly string[]): ArtifactLayout {
  return files.includes(ARTIFACT_INDEX) ? 'split' : files.includes(LEGACY_ARTIFACT) ? 'legacy' : 'none';
}

const projectFilesIn = (files: readonly string[]): string[] =>
  files
    .filter((f) => f.startsWith(`${ARTIFACT_PROJECTS_DIR}/`) && f.endsWith('.json'))
    .map((f) => f.slice(ARTIFACT_PROJECTS_DIR.length + 1, -'.json'.length));

/** The merged artifact, or — with `project` — the artifact narrowed to that one project's rows
 *  (same `meta`; no rows for a project the artifact does not carry). Throws, naming `src.where`, on: no artifact at all; both layouts at once; an
 *  index listing a project with no file, or a project file the index does not list; a file whose
 *  project or rows belong to another project; a duplicate row id; and (whole reads) a row count
 *  that disagrees with `meta.counts.total`. */
export function readArtifact(src: ArtifactSource, project?: string): BenchOutput {
  const files = src.files();
  const layout = artifactLayout(files);
  if (layout === 'none') {
    throw new Error(`no benchmark artifact in ${src.where} (neither ${ARTIFACT_INDEX} nor ${LEGACY_ARTIFACT})`);
  }
  if (layout === 'legacy') {
    const out = src.read(LEGACY_ARTIFACT) as BenchOutput;
    if (out === null || typeof out !== 'object' || !Array.isArray(out.results)) {
      throw new Error(`${src.where}/${LEGACY_ARTIFACT} has no top-level \`results\` array`);
    }
    return project === undefined ? out : { meta: out.meta, results: out.results.filter((r) => r.project === project) };
  }
  if (files.includes(LEGACY_ARTIFACT)) {
    throw new Error(
      `${src.where} holds both ${ARTIFACT_INDEX} and the old single-file ${LEGACY_ARTIFACT}; one of them is stale — ` +
        `remove ${LEGACY_ARTIFACT} (\`bench merge\` writes the split layout only)`,
    );
  }
  const index = src.read(ARTIFACT_INDEX) as ArtifactIndex;
  if (
    index === null ||
    typeof index !== 'object' ||
    index.meta === undefined ||
    !Array.isArray(index.projects) ||
    !Array.isArray(index.runs)
  ) {
    throw new Error(`${src.where}/${ARTIFACT_INDEX} has no \`meta\`, \`projects\` and \`runs\``);
  }
  const listed = new Set(index.projects);
  const present = new Set(projectFilesIn(files));
  const missing = index.projects.filter((p) => !present.has(p));
  if (missing.length > 0) {
    throw new Error(
      `${src.where}/${ARTIFACT_INDEX} lists project(s) with no file: ${missing.map(projectFile).join(', ')} — ` +
        `a missing project file is an incomplete artifact, never an empty project`,
    );
  }
  const extra = [...present].filter((p) => !listed.has(p));
  if (extra.length > 0) {
    throw new Error(
      `${src.where} carries project file(s) ${ARTIFACT_INDEX} does not list: ${extra.map(projectFile).join(', ')} — ` +
        `a stale file from another run; regenerate with \`bench merge\``,
    );
  }
  if (project !== undefined && !listed.has(project)) {
    // a project the INDEX does not list has no rows — the same answer the single file gives a
    // filter by a project it does not carry. (A listed project whose file is missing threw above.)
    return { meta: index.meta, results: [] };
  }
  const rowsOf = new Map<string, FunctionResult[]>();
  for (const p of project === undefined ? index.projects : [project]) {
    const file = src.read(projectFile(p)) as ProjectRows;
    if (file === null || typeof file !== 'object' || !Array.isArray(file.results)) {
      throw new Error(`${src.where}/${projectFile(p)} has no top-level \`results\` array`);
    }
    if (file.project !== p) {
      throw new Error(`${src.where}/${projectFile(p)} says it holds project '${file.project}'`);
    }
    for (const r of file.results) {
      if (r.project !== p) {
        throw new Error(`${src.where}/${projectFile(p)} carries row ${r.id} of project '${r.project}'`);
      }
    }
    rowsOf.set(p, file.results);
  }
  // interleave the project files back into the merged order the runs record; every row of every
  // read file must be taken exactly once
  const taken = new Map<string, number>();
  const results: FunctionResult[] = [];
  for (const [p, count] of index.runs) {
    if (!listed.has(p)) {
      throw new Error(`${src.where}/${ARTIFACT_INDEX} runs name project '${p}', which it does not list`);
    }
    const rows = rowsOf.get(p);
    const at = taken.get(p) ?? 0;
    taken.set(p, at + count);
    if (rows === undefined) {
      continue; // a one-project read skips the other projects' runs
    }
    if (at + count > rows.length) {
      throw new Error(
        `${src.where}/${ARTIFACT_INDEX} runs take more rows of '${p}' than ${projectFile(p)} holds (${rows.length})`,
      );
    }
    results.push(...rows.slice(at, at + count));
  }
  for (const [p, rows] of rowsOf) {
    if ((taken.get(p) ?? 0) !== rows.length) {
      throw new Error(
        `${src.where}: ${projectFile(p)} holds ${rows.length} rows but ${ARTIFACT_INDEX} runs place ${taken.get(p) ?? 0}`,
      );
    }
  }
  const seen = new Set<string>();
  for (const r of results) {
    if (seen.has(r.id)) {
      throw new Error(`${src.where} carries row ${r.id} twice`);
    }
    seen.add(r.id);
  }
  const total = index.meta.counts?.total;
  if (project === undefined && typeof total === 'number' && total !== results.length) {
    throw new Error(
      `${src.where}: meta.counts.total is ${total} but the project files hold ${results.length} rows — an incomplete artifact`,
    );
  }
  return { meta: index.meta, results };
}
