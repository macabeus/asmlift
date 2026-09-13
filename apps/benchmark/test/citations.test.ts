// Comments state which benchmark row guards a mechanism — "removing this gate costs
// kleod:UpdateFadeEffect its match". Since `benchmark.yml` runs `bench regression`, the named row is
// what makes CI fail if the mechanism breaks, so the claim's precondition is that the row still
// exists — and a row's symbol changes whenever a manifest does. This asserts the precondition.
//
// It cannot check that the row still EXERCISES the mechanism: results.json holds a row's outcome,
// not what it would score with the mechanism disabled. Only ablation shows that.
//
// `project:sym` is therefore reserved for rows. A checkout function or a dogfooding find is real
// evidence but cannot be re-run that way, so it goes in prose naming where to look.
import { type Identifiable, rowNames } from '@asmlift/bench-schema';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Trees whose prose may cite rows. The benchmark's own sources are excluded — they manipulate row
 *  ids as data, so a `project:sym` there is code.
 *
 *  EXCLUDED IS NOT UNGUARDED. `apps/benchmark/dataset` — the attribution blocks, where a `/unmerge`
 *  blast-radius list names twelve rows an ablation flips — is pinned by `dataset-symmetry.test.ts`'s
 *  "the dataset cites only benchmark rows that exist": same regex, same `results.json`, same CI step
 *  (`vitest run apps/benchmark/test`), over a WIDER file set than this one (`.ts` + `.json`, minus
 *  vendored `tu/`), and checked by renaming a citation there and watching that suite go red. So do
 *  not add `dataset` here: it would be a second assertion of one convention. */
const SCANNED = ['packages/core/src', 'packages/core/test', 'packages/cli/src', 'packages/cli/test', 'docs'];

const rows = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'results', 'results.json'), 'utf8'))
  .results as Identifiable[];

/** Every name a row answers to, with and without its toolchain — its id AND its former names
 *  (`aliases`), so an upstream rename leaves every citation of the old spelling resolving. */
const CITABLE = new Set(rows.flatMap((r) => rowNames(r).flatMap((n) => [n, n.slice(0, n.lastIndexOf(':'))])));
/** Rows that no longer exist, cited by the name they were MEASURED under (dataset/retired-rows.json).
 *  A dated number keeps its row's old name rather than moving to whatever row now sits at that
 *  address: another decompilation's source at the same address is a different row, and moving the
 *  name would attach the number to a row nobody measured. Such a citation guards nothing. */
const RETIRED = new Set(
  (
    JSON.parse(readFileSync(join(import.meta.dirname, '..', 'dataset', 'retired-rows.json'), 'utf8')) as {
      retirements: { rows: { id: string }[] }[];
    }
  ).retirements.flatMap((t) => t.rows.flatMap((r) => [r.id, r.id.slice(0, r.id.lastIndexOf(':'))])),
);
const PROJECTS = [...new Set(rows.map((r) => r.project))].sort();
/** `project:sym`, optionally `:toolchain`. Matched on every line rather than comments only: a
 *  citation-shaped identifier in code is possible but has no inhabitant in these trees. */
const CITATION = new RegExp(`\\b(${PROJECTS.join('|')}):[A-Za-z_]\\w*(?::[\\w.]+)?`, 'g');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      sourceFiles(p, out);
    } else if (/\.(ts|md)$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

const found = SCANNED.flatMap((dir) =>
  sourceFiles(join(ROOT, dir)).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, i) =>
        [...text.matchAll(CITATION)].map((m) => ({ file: file.slice(ROOT.length + 1), line: i + 1, cited: m[0] })),
      ),
  ),
);

/** Prose also cites a place in the SOURCE, and `docs/level-tower.md`'s convention is a findable
 *  phrase rather than a line number, because a line number rots on the next edit above it and
 *  nothing notices. This asserts the phrase is still there. A `file.ts:N` is deliberately NOT
 *  checked: the dated attribution docs are full of them and they describe a snapshot, not a rule. */
const ANCHORED = ['docs', '.claude/commands'];
const ANCHOR = /grep -n "([^"]+)" ([\w./-]+)/g;

const anchors = ANCHORED.flatMap((dir) =>
  sourceFiles(join(ROOT, dir)).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, i) =>
        [...text.matchAll(ANCHOR)].map((m) => ({
          file: file.slice(ROOT.length + 1),
          line: i + 1,
          phrase: m[1],
          target: m[2],
        })),
      ),
  ),
);

describe('every cited source anchor still hits', () => {
  it('finds anchors at all', () => {
    expect(anchors.length).toBeGreaterThan(0);
  });

  it.each(anchors)('$file:$line anchors on $target', ({ file, line, phrase, target }) => {
    // The phrase is quoted for a literal `grep`, so a substring test is what the reader will run.
    expect(
      readFileSync(join(ROOT, target), 'utf8').includes(phrase),
      `${file}:${line} tells the reader to find '${phrase}' in ${target}, and it is not there.\n` +
        `  Reworded? Re-quote the new phrasing here. Moved? Re-point the anchor. Do not replace it\n` +
        `  with a line number — that is the failure this convention exists to avoid.`,
    ).toBe(true);
  });
});

describe('every cited benchmark row exists', () => {
  it('finds citations at all', () => {
    // Or the suite passes loudest when the scan is broken.
    expect(found.length).toBeGreaterThan(5);
  });

  it.each(found)('$file:$line cites $cited', ({ cited, file, line }) => {
    expect(
      CITABLE.has(cited) || RETIRED.has(cited),
      `${file}:${line} cites '${cited}', which is not a row in the committed results.json nor a retired row.\n` +
        `  Renamed upstream? Add the old name to the row's aliases. Not a benchmark row (a checkout\n` +
        `  function, a dogfooding find)? Write it in prose naming where to look, so the spelling stops\n` +
        `  promising a row.`,
    ).toBe(true);
  });
});

describe('the retired-row register', () => {
  it('names no row the committed artifact still carries', () => {
    // Or a citation of a live row would pass as "retired" and a genuinely retired one could be
    // re-added under its old id with every dated number silently re-attached to it.
    const live = [...RETIRED].filter((id) => CITABLE.has(id));
    expect(live, `dataset/retired-rows.json lists rows results.json still carries: ${live.join(', ')}`).toEqual([]);
  });
});
