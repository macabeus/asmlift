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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Trees whose prose may cite rows. The benchmark's own sources are excluded — they manipulate row
 *  ids as data, so a `project:sym` there is code. */
const SCANNED = ['packages/core/src', 'packages/core/test', 'packages/cli/src', 'packages/cli/test', 'docs'];

const rows = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'results', 'results.json'), 'utf8')).results as {
  id: string;
  project: string;
  sym: string;
}[];

const CITABLE = new Set(rows.flatMap((r) => [`${r.project}:${r.sym}`, r.id]));
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
      CITABLE.has(cited),
      `${file}:${line} cites '${cited}', which is not a row in the committed results.json.\n` +
        `  Renamed? Update the citation. Not a benchmark row (a checkout function, a dogfooding\n` +
        `  find)? Write it in prose naming where to look, so the spelling stops promising a row.`,
    ).toBe(true);
  });
});
