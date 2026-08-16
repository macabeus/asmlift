// Comments in `@asmlift/core` state which benchmark row guards a mechanism — "removing this gate
// costs kleod:UpdateFadeEffect its match". Since `benchmark.yml` runs `bench regression`, that is an
// operational claim and not a note: the named row is what makes CI fail if the mechanism breaks. Its
// precondition is that the row still exists, and a row's symbol changes whenever a manifest does.
// This asserts the precondition.
//
// THE RULE: the `project:sym` spelling is reserved for BENCHMARK ROWS, because it promises the
// reader can reach the evidence with `pnpm bench run --tier real --only <sym>`. A function in a
// project checkout or a dogfooding find is real evidence too but is NOT reachable that way, so it is
// written in prose naming where to look — "`sub_80B6B3C` in sa3's `asm/code_x.s`".
//
// What this CANNOT check is whether the row still EXERCISES the mechanism: results.json records a
// row's final outcome, not what it would score with the mechanism disabled. A row can keep matching
// while ceasing to depend on the code that cites it. Ablation is the only way to see that, and it is
// too slow to gate per-PR.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const RESULTS = join(import.meta.dirname, '..', 'results', 'results.json');

/** Trees whose prose may cite rows. The benchmark's own sources are excluded: they MANIPULATE row
 *  ids as data, so a bare `project:sym` there is code, not a citation.
 *
 *  Everything else that could carry a citation is in — a tree left out is a tree where a citation
 *  rots unwatched, which is the defect this file exists for, and `packages/cli/test` had one. */
const SCANNED = [
  'packages/core/src',
  'packages/core/test',
  'packages/cli/src',
  'packages/cli/test',
  'apps/web/src',
  'docs',
];

const rows = JSON.parse(readFileSync(RESULTS, 'utf8')).results as { id: string; project: string; sym: string }[];

/** Every spelling a citation may resolve to: `project:sym` and the full `project:sym:toolchain`. */
const CITABLE = new Set(rows.flatMap((r) => [`${r.project}:${r.sym}`, r.id]));
const PROJECTS = [...new Set(rows.map((r) => r.project))].sort();

/** Every source and doc file under `dir`. Markdown counts: `docs/` argues for the architecture and
 *  can cite a row exactly as a comment does. A `.md` file is all prose, so it is scanned whole. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      sourceFiles(p, out);
    } else if (/\.(ts|tsx|md)$/.test(p)) {
      out.push(p);
    }
  }
  return out;
}

/** The comment text of one file, line by line, with code stripped.
 *
 *  Comments only, because `{ synthetic: x }` is a perfectly good object literal and a citation
 *  checker that fails on one would be a checker people delete.
 *
 *  NOT string-aware: a `//` inside a string literal opens a comment here. That costs nothing in
 *  practice — the rest of such a line would have to also spell `project:sym` to matter — and a real
 *  lexer is a lot of machinery to buy a case with no inhabitant. */
export function commentLines(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let inBlock = false;
  src.split('\n').forEach((raw, i) => {
    let text = '';
    let rest = raw;
    while (rest.length > 0) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end === -1) {
          text += rest;
          break;
        }
        text += rest.slice(0, end);
        rest = rest.slice(end + 2);
        inBlock = false;
        continue;
      }
      const lineAt = rest.indexOf('//');
      const blockAt = rest.indexOf('/*');
      if (lineAt !== -1 && (blockAt === -1 || lineAt < blockAt)) {
        text += rest.slice(lineAt + 2);
        break;
      }
      if (blockAt !== -1) {
        rest = rest.slice(blockAt + 2);
        inBlock = true;
        continue;
      }
      break;
    }
    if (text.trim()) {
      out.push({ line: i + 1, text });
    }
  });
  return out;
}

/** Every `project:sym[:toolchain]` citation in already-extracted prose. */
function citationsInProse(lines: { line: number; text: string }[], projects: string[]): Citation[] {
  const re = new RegExp(`\\b(${projects.join('|')}):([A-Za-z_]\\w*)(?::([\\w.]+))?`, 'g');
  return lines.flatMap(({ line, text }) =>
    [...text.matchAll(re)].map((m) => ({ line, cited: m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}` })),
  );
}

interface Citation {
  line: number;
  cited: string;
}

/** Citations in a TypeScript source — comments only. */
export function citationsIn(src: string, projects: string[]): Citation[] {
  return citationsInProse(commentLines(src), projects);
}

/** Citations in a Markdown source — the whole file is prose. */
export function citationsInMarkdown(src: string, projects: string[]): Citation[] {
  return citationsInProse(
    src.split('\n').map((text, i) => ({ line: i + 1, text })),
    projects,
  );
}

const found = SCANNED.flatMap((dir) =>
  sourceFiles(join(ROOT, dir)).flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    const cited = file.endsWith('.md') ? citationsInMarkdown(src, PROJECTS) : citationsIn(src, PROJECTS);
    return cited.map((c) => ({ ...c, file: file.slice(ROOT.length + 1) }));
  }),
);

describe('every cited benchmark row exists', () => {
  it('finds citations at all', () => {
    // Without this the suite passes loudest when the scanner is broken — the failure mode of every
    // convention check that greps for its own subject.
    expect(found.length).toBeGreaterThan(5);
  });

  it.each(found)('$file:$line cites $cited', ({ cited, file, line }) => {
    expect(
      CITABLE.has(cited),
      `${file}:${line} cites '${cited}', which is not a row in the committed results.json.\n` +
        `  The 'project:sym' spelling promises the reader can re-run the evidence with\n` +
        `    pnpm bench run --tier real --only ${cited.split(':')[1]}\n` +
        `  If the symbol was renamed, update the citation. If it is NOT a benchmark row (a function\n` +
        `  in a project checkout, a dogfooding find), write it in prose and say where to look —\n` +
        '  e.g. "`sub_80B6B3C` in sa3\'s `asm/code_x.s`" — so the spelling stops promising a row.',
    ).toBe(true);
  });
});

describe('the checker itself', () => {
  it('reads citations out of both comment styles, and ignores code', () => {
    const src = [
      'const m = { synthetic: countpos };  // not a citation: it is code',
      '// measured on kleod:UpdateHUDCounterDisplay',
      '/** and on af:_MtxF_to_Mtx:ido7.1 */',
    ].join('\n');
    expect(citationsIn(src, PROJECTS).map((c) => c.cited)).toEqual([
      'kleod:UpdateHUDCounterDisplay',
      'af:_MtxF_to_Mtx:ido7.1',
    ]);
  });

  it('sees a citation inside a multi-line block comment', () => {
    const src = ['/*', ' * measured on kleod:UpdateFadeEffect', ' */', 'const x = 1;'].join('\n');
    expect(citationsIn(src, PROJECTS).map((c) => c.cited)).toEqual(['kleod:UpdateFadeEffect']);
  });

  it('does not read a citation out of a row id used as code', () => {
    // The case that actually occurs: a row id in a string or an object key. A `//` inside a string
    // still opens a comment here — see commentLines.
    expect(citationsIn('const id = "kleod:UpdateFadeEffect";', PROJECTS)).toEqual([]);
    expect(citationsIn('const m = { synthetic: countpos };', PROJECTS)).toEqual([]);
  });

  it('rejects a truncated symbol, not just an unknown one', () => {
    // A prefix of a real row's symbol is the near-miss worth pinning: `bench run --only` takes a
    // SUBSTRING, so a truncated citation still runs something and reads as though it resolved.
    expect(CITABLE.has('pokeemerald:GetGender')).toBe(false);
    expect(CITABLE.has('pokeemerald:GetGenderFromSpeciesAndPersonality')).toBe(true);
  });

  it('reads a citation out of markdown prose, where there are no comment markers', () => {
    expect(citationsInMarkdown('See kleod:UpdateFadeEffect for the shape.', PROJECTS).map((c) => c.cited)).toEqual([
      'kleod:UpdateFadeEffect',
    ]);
    // and the TS scanner must NOT, or every string in the repo becomes prose
    expect(citationsIn('See kleod:UpdateFadeEffect for the shape.', PROJECTS)).toEqual([]);
  });

  it('derives its project list from the results, not a hardcoded copy', () => {
    // A hardcoded list silently stops checking a project the day one is added.
    expect(PROJECTS).toEqual([...new Set(rows.map((r) => r.project))].sort());
    expect(PROJECTS.length).toBeGreaterThan(1);
  });
});
