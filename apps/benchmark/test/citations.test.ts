// Comments in `@asmlift/core` justify mechanisms by citing a benchmark row — "measured on
// kleod:UpdateHUDCounterDisplay". The citation is the reader's only route from a claim back to the
// evidence, and nothing checked that the route still led anywhere: one cited symbol had been
// truncated to a name no row carries, and another named a function that is not a row at all.
//
// THE RULE this enforces: the `project:sym` spelling is reserved for BENCHMARK ROWS. A row can be
// re-run (`pnpm bench run --tier real --only <sym>`), so the spelling is a promise that the reader
// can reach the evidence by a documented command. Anything else — a function in a project checkout,
// a symbol from a dogfooding round — is real evidence too, but it is NOT reachable that way, so it
// is written in prose ("`sub_80B6B3C` in sa3's `asm/code_x.s`") and names where to look instead.
//
// What this CANNOT check is the number attached to the citation: results.json records each row's
// final outcome, not what it scored under an ablation. That gap is real — it is how
// `l3/tailmerge.ts` came to cite "60 → 33 (visible in the committed results.json)" for a row that
// had since reached MATCH. Existence is the part a test can hold, and it is the part that rots
// first, because a row's symbol changes when a manifest does.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const RESULTS = join(import.meta.dirname, '..', 'results', 'results.json');

/** Source trees whose comments may cite rows. The benchmark's own sources are excluded: they
 *  MANIPULATE row ids as data, so a bare `project:sym` there is code, not a citation. */
const SCANNED = ['packages/core/src', 'packages/core/test', 'packages/cli/src'];

const rows = JSON.parse(readFileSync(RESULTS, 'utf8')).results as { id: string; project: string; sym: string }[];

/** Every spelling a citation may resolve to: `project:sym` and the full `project:sym:toolchain`. */
const CITABLE = new Set(rows.flatMap((r) => [`${r.project}:${r.sym}`, r.id]));
const PROJECTS = [...new Set(rows.map((r) => r.project))].sort();

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      tsFiles(p, out);
    } else if (p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** The comment text of one file, line by line, with code stripped.
 *
 *  Comments only, because `{ synthetic: x }` is a perfectly good object literal and a citation
 *  checker that fails on one would be a checker people delete. */
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

/** Every `project:sym[:toolchain]` citation in a comment, for the known benchmark projects. */
export function citationsIn(src: string, projects: string[]): { line: number; cited: string }[] {
  const re = new RegExp(`\\b(${projects.join('|')}):([A-Za-z_]\\w*)(?::([\\w.]+))?`, 'g');
  return commentLines(src).flatMap(({ line, text }) =>
    [...text.matchAll(re)].map((m) => ({ line, cited: m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}` })),
  );
}

const found = SCANNED.flatMap((dir) =>
  tsFiles(join(ROOT, dir)).flatMap((file) =>
    citationsIn(readFileSync(file, 'utf8'), PROJECTS).map((c) => ({ ...c, file: file.slice(ROOT.length + 1) })),
  ),
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
        "  e.g. \"`sub_80B6B3C` in sa3's `asm/code_x.s`\" — so the spelling stops promising a row.",
    ).toBe(true);
  });
});

describe('the checker itself', () => {
  it('reads citations out of both comment styles, and ignores code', () => {
    const src = [
      "const m = { synthetic: countpos };  // not a citation: it is code",
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

  it('does not read a citation out of a string that merely looks like one', () => {
    expect(citationsIn('const id = "kleod:UpdateFadeEffect";', PROJECTS)).toEqual([]);
  });

  it('rejects a symbol no row carries — the truncation this test exists for', () => {
    // `pokeemerald:GetGender` was the real defect: the row is GetGenderFromSpeciesAndPersonality.
    expect(CITABLE.has('pokeemerald:GetGender')).toBe(false);
    expect(CITABLE.has('pokeemerald:GetGenderFromSpeciesAndPersonality')).toBe(true);
  });

  it('derives its project list from the results, not a hardcoded copy', () => {
    // A hardcoded list silently stops checking a project the day one is added.
    expect(PROJECTS).toEqual([...new Set(rows.map((r) => r.project))].sort());
    expect(PROJECTS.length).toBeGreaterThan(1);
  });
});
