// The committed artifact is split by project (bench-schema ./artifact): `index.json` + one
// `projects/<project>.json` each. These pin the two promises every reader leans on — the merged
// view is exactly the `{ meta, results }` one file used to hold, row order included, and an
// incomplete artifact throws rather than reading as a smaller one — plus the reason for the
// split: no committed file may reach GitHub's 100 MiB file limit.
import { type BenchOutput, readArtifact } from '@asmlift/bench-schema';
import {
  GITHUB_FILE_LIMIT_BYTES,
  artifactSizesIn,
  readArtifactDir,
  readArtifactProject,
  writeArtifactDir,
} from '@asmlift/bench-schema/artifact-fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, RESULTS_DIR } from '../src/config';
import { WEB_ARTIFACT_DIR } from '../src/report/publish';

const row = (project: string, sym: string) => ({ id: `${project}:${sym}:agbcc`, sym, project, tier: 'synthetic' });
/** Rows whose ids do NOT sort by project, so the interleaving is the index's to record. */
const sample = (): BenchOutput =>
  ({
    meta: { generatedAt: 'g', toolchains: ['agbcc'], counts: { total: 5, synthetic: 5, real: 0 } },
    results: [row('b', 'x'), row('a', 'y'), row('a', 'z'), row('b', 'w'), row('c', 'v')],
  }) as unknown as BenchOutput;
const tmp = (): string => mkdtempSync(join(tmpdir(), 'asmlift-artifact-'));

describe('the split artifact', () => {
  it('reads back exactly what was written, row order included, pretty and compact', () => {
    for (const indent of [2, undefined]) {
      const dir = tmp();
      const out = sample();
      writeArtifactDir(dir, out, indent);
      expect(readdirSync(join(dir, 'projects')).sort()).toEqual(['a.json', 'b.json', 'c.json']);
      expect(JSON.stringify(readArtifactDir(dir), null, indent)).toBe(JSON.stringify(out, null, indent));
    }
  });

  it('reads one project under the same meta, and no rows for a project it does not carry', () => {
    const dir = tmp();
    writeArtifactDir(dir, sample(), 2);
    expect(readArtifactProject(dir, 'a').results.map((r) => r.sym)).toEqual(['y', 'z']);
    expect(readArtifactProject(dir, 'a').meta.generatedAt).toBe('g');
    expect(readArtifactProject(dir, 'nope').results).toEqual([]);
  });

  it('throws on a listed project with no file, never reading it as empty', () => {
    const dir = tmp();
    writeArtifactDir(dir, sample(), 2);
    rmSync(join(dir, 'projects', 'b.json'));
    expect(() => readArtifactDir(dir)).toThrow(/lists project\(s\) with no file: projects\/b\.json/);
    // a one-project read of ANOTHER project still refuses the incomplete artifact
    expect(() => readArtifactProject(dir, 'a')).toThrow(/no file/);
  });

  it('throws on a project file the index does not list, and on both layouts at once', () => {
    const stale = tmp();
    writeArtifactDir(stale, sample(), 2);
    writeFileSync(join(stale, 'projects', 'old.json'), JSON.stringify({ project: 'old', results: [] }));
    expect(() => readArtifactDir(stale)).toThrow(/does not list: projects\/old\.json/);
    const both = tmp();
    writeArtifactDir(both, sample(), 2);
    writeFileSync(join(both, 'results.json'), JSON.stringify(sample()));
    expect(() => readArtifactDir(both)).toThrow(/both index\.json and the old single-file results\.json/);
  });

  it('throws when the files and the index disagree on rows', () => {
    const dir = tmp();
    writeArtifactDir(dir, sample(), 2);
    const a = join(dir, 'projects', 'a.json');
    const file = JSON.parse(readFileSync(a, 'utf8'));
    writeFileSync(a, JSON.stringify({ ...file, results: file.results.slice(1) }));
    expect(() => readArtifactDir(dir)).toThrow(/runs take more rows of 'a'/);
    writeFileSync(a, JSON.stringify({ ...file, results: [...file.results, row('a', 'extra')] }));
    expect(() => readArtifactDir(dir)).toThrow(/holds 3 rows but index\.json runs place 2/);
    writeFileSync(a, JSON.stringify({ ...file, results: [row('b', 'q'), file.results[1]] }));
    expect(() => readArtifactDir(dir)).toThrow(/carries row b:q:agbcc of project 'b'/);
  });

  it('writing removes the pre-split single file and a project that left', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'results.json'), JSON.stringify(sample()));
    writeArtifactDir(dir, sample(), 2);
    const fewer = sample();
    fewer.results = fewer.results.filter((r) => r.project !== 'c');
    fewer.meta.counts.total = 4;
    writeArtifactDir(dir, fewer, 2);
    expect(readdirSync(dir).sort()).toEqual(['index.json', 'projects']);
    expect(readdirSync(join(dir, 'projects')).sort()).toEqual(['a.json', 'b.json']);
    expect(readArtifactDir(dir).results).toHaveLength(4);
  });

  it('still reads a pre-split single results.json, whole or by project', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'results.json'), JSON.stringify(sample(), null, 2));
    expect(readArtifactDir(dir)).toEqual(sample());
    expect(readArtifactProject(dir, 'b').results.map((r) => r.sym)).toEqual(['x', 'w']);
  });

  it('refuses a source with no artifact at all', () => {
    expect(() => readArtifact({ where: 'nowhere', files: () => [], read: () => undefined })).toThrow(
      /no benchmark artifact in nowhere/,
    );
  });
});

describe('the committed artifact', () => {
  it('keeps every file under GitHub’s file limit, and the web copy holds the same rows', () => {
    for (const dir of [RESULTS_DIR, WEB_ARTIFACT_DIR]) {
      const sizes = artifactSizesIn(dir);
      expect(sizes.length, `${dir.slice(REPO_ROOT.length + 1)} holds no artifact`).toBeGreaterThan(0);
      for (const s of sizes) {
        expect(s.bytes, `${dir.slice(REPO_ROOT.length + 1)}/${s.file}`).toBeLessThan(GITHUB_FILE_LIMIT_BYTES);
      }
    }
    // ids and meta, not the rows whole: each side is ~100 MB parsed, and `publish` copies rows
    // verbatim (the web suites read the copy's row fields themselves)
    const shape = (o: BenchOutput) => ({ meta: o.meta, ids: o.results.map((r) => r.id) });
    expect(shape(readArtifactDir(WEB_ARTIFACT_DIR))).toEqual(shape(readArtifactDir(RESULTS_DIR)));
  });
});
