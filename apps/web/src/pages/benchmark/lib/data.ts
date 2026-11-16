// Static, build-time import of the merged benchmark output. No fetch, no server.
//
// `bench publish` writes it split by project (`../data/index.json` + `../data/projects/*.json`,
// bench-schema ./artifact); every file is bundled here and merged back by the same reader the
// harness uses, so a project the index lists with no file fails the page loudly instead of
// rendering a benchmark without it.
import { type BenchOutput, readArtifact } from '@asmlift/bench-schema';

const DATA = '../data/';
const files = import.meta.glob<unknown>(['../data/index.json', '../data/projects/*.json'], {
  eager: true,
  import: 'default',
});

export const bench: BenchOutput = readArtifact({
  where: 'apps/web/src/pages/benchmark/data',
  files: () => Object.keys(files).map((k) => k.slice(DATA.length)),
  read: (rel) => files[DATA + rel],
});
export const results = bench.results;
export const meta = bench.meta;
